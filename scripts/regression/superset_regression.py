# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
"""Run the regression suites for an automated remediation and print a report.

The report is a markdown block meant to be posted as a pull request comment, so a
reviewer can see which suites ran, what they returned and how long they took,
without opening CI logs. Suites that cannot execute are reported as ``NOT RUN``
with the reason rather than being silently dropped.

Usage::

    python scripts/regression/superset_regression.py --preset security
    python scripts/regression/superset_regression.py --suites python-lint python-unit
    python scripts/regression/superset_regression.py --preset backend --json report.json
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND = REPO_ROOT / "superset-frontend"
WEBSOCKET = REPO_ROOT / "superset-websocket"


@dataclass(frozen=True)
class Suite:
    """A single regression command and where it runs."""

    name: str
    command: list[str]
    cwd: Path
    description: str
    #: Output fragments meaning "the tool itself could not run here", which must be
    #: reported as NOT RUN rather than as a regression.
    tool_error_markers: tuple[str, ...] = ()


@dataclass
class SuiteResult:
    suite: Suite
    outcome: str  # "pass" | "fail" | "not_run"
    summary: str
    duration_seconds: float
    reason: str = ""
    tail: list[str] = field(default_factory=list)


SUITES: dict[str, Suite] = {
    "python-lint": Suite(
        "python-lint",
        ["ruff", "check", "superset", "tests"],
        REPO_ROOT,
        "ruff lint over the backend",
    ),
    "python-format": Suite(
        "python-format",
        ["ruff", "format", "--check", "superset", "tests"],
        REPO_ROOT,
        "ruff format check over the backend",
    ),
    "python-unit": Suite(
        "python-unit",
        [sys.executable, "-m", "pytest", "tests/unit_tests", "-q", "--no-header"],
        REPO_ROOT,
        "backend unit tests",
    ),
    "python-audit": Suite(
        "python-audit",
        ["pip-audit", "-r", "requirements/base.txt", "--progress-spinner", "off"],
        REPO_ROOT,
        "pip-audit against pinned backend requirements",
        tool_error_markers=("internal pip failure", "Failed to install packages"),
    ),
    "frontend-audit": Suite(
        "frontend-audit",
        ["npm", "audit", "--audit-level", "high"],
        FRONTEND,
        "npm audit for the frontend workspace",
    ),
    "websocket-audit": Suite(
        "websocket-audit",
        ["npm", "audit", "--audit-level", "high"],
        WEBSOCKET,
        "npm audit for the websocket service",
    ),
    "frontend-lint": Suite(
        "frontend-lint",
        ["npm", "run", "lint"],
        FRONTEND,
        "eslint over the frontend",
    ),
    "frontend-types": Suite(
        "frontend-types",
        ["npm", "run", "type"],
        FRONTEND,
        "TypeScript type check",
    ),
    "frontend-jest": Suite(
        "frontend-jest",
        ["npm", "run", "test", "--", "--silent", "--ci"],
        FRONTEND,
        "jest unit/component tests",
    ),
}

PRESETS: dict[str, list[str]] = {
    "security": ["python-audit", "frontend-audit", "websocket-audit"],
    "backend": ["python-lint", "python-format", "python-unit"],
    "frontend": ["frontend-lint", "frontend-types", "frontend-jest"],
    "quick": ["python-lint", "python-format"],
    "all": list(SUITES),
}

#: pytest/jest style tallies, e.g. "12 passed, 1 failed, 3 skipped".
_TALLY = re.compile(
    r"\b(\d+)\s+(passed|failed|skipped|error|errors|xfailed|warnings?)\b"
)
_NPM_AUDIT = re.compile(r"\b(\d+)\s+(critical|high|moderate|low)\b")


def _summarise(stdout: str, stderr: str, returncode: int) -> str:
    """Pull a short, human-readable tally out of suite output."""
    text = f"{stdout}\n{stderr}"
    if tallies := _TALLY.findall(text):
        seen: dict[str, str] = {}
        for count, kind in tallies:
            seen[kind] = count
        return ", ".join(f"{count} {kind}" for kind, count in seen.items())
    if vulns := _NPM_AUDIT.findall(text):
        return ", ".join(f"{count} {sev}" for count, sev in dict.fromkeys(vulns))
    if "found 0 vulnerabilities" in text:
        return "0 vulnerabilities"
    if "No known vulnerabilities found" in text:
        return "0 known vulnerabilities"
    return "exit code 0" if returncode == 0 else f"exit code {returncode}"


def _executable_missing(suite: Suite) -> str:
    if not suite.cwd.exists():
        return f"{suite.cwd.relative_to(REPO_ROOT)}/ not present"
    binary = suite.command[0]
    if binary != sys.executable and shutil.which(binary) is None:
        return f"`{binary}` is not installed"
    if suite.command[0] == "npm" and not (suite.cwd / "node_modules").exists():
        return "node_modules missing (run `npm ci` first)"
    return ""


def run_suite(suite: Suite, timeout: int) -> SuiteResult:
    if reason := _executable_missing(suite):
        return SuiteResult(suite, "not_run", "not run", 0.0, reason=reason)

    started = time.monotonic()
    try:
        completed = subprocess.run(  # noqa: S603 - fixed command table, no shell
            suite.command,
            cwd=suite.cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return SuiteResult(
            suite,
            "not_run",
            "timed out",
            time.monotonic() - started,
            reason=f"exceeded {timeout}s",
        )

    duration = time.monotonic() - started
    combined = f"{completed.stdout}\n{completed.stderr}"
    output = combined.strip().splitlines()
    marker = next((m for m in suite.tool_error_markers if m in combined), "")
    if marker:
        return SuiteResult(
            suite,
            "not_run",
            "tool error",
            duration,
            reason=f"suite could not execute ({marker})",
            tail=output[-20:],
        )
    return SuiteResult(
        suite,
        "pass" if completed.returncode == 0 else "fail",
        _summarise(completed.stdout, completed.stderr, completed.returncode),
        duration,
        tail=output[-20:],
    )


def verdict(results: list[SuiteResult]) -> str:
    if any(r.outcome == "fail" for r in results):
        return "FAIL"
    if all(r.outcome == "not_run" for r in results):
        return "NOT RUN"
    return "PASS"


def render_report(
    results: list[SuiteResult], *, issue: int | None, commit: str, trigger: str
) -> str:
    overall = verdict(results)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    icons = {"pass": "PASS", "fail": "FAIL", "not_run": "NOT RUN"}

    lines = ["## Regression report", ""]
    if issue is not None:
        lines += [f"Issue: #{issue}", ""]
    lines += ["| Suite | Result | Duration |", "| --- | --- | --- |"]
    for result in results:
        detail = result.summary if result.outcome != "not_run" else result.reason
        lines.append(
            f"| `{' '.join(result.suite.command)}` "
            f"| {icons[result.outcome]} — {detail} "
            f"| {result.duration_seconds:.1f}s |"
        )

    failing = [r for r in results if r.outcome == "fail"]
    skipped = [r for r in results if r.outcome == "not_run"]
    if failing:
        note = "failing: " + ", ".join(r.suite.name for r in failing)
    elif skipped and len(skipped) == len(results):
        note = "no suite could be executed in this environment"
    elif skipped:
        note = "not run: " + ", ".join(r.suite.name for r in skipped)
    else:
        note = "all selected suites passed"

    lines += [
        "",
        f"**Verdict:** {overall} — {note}",
        "",
        "### Run history",
        "| Run | When (UTC) | Trigger | Commit | Result |",
        "| --- | --- | --- | --- | --- |",
        f"| 1 | {now} | {trigger} | `{commit[:7]}` | {overall} |",
        "",
        "<sub>Generated by `scripts/regression/superset_regression.py`. Re-run by "
        "commenting `/regression` on this PR; new runs append a row above.</sub>",
    ]

    for result in failing:
        lines += [
            "",
            f"<details><summary>{result.suite.name} output (tail)</summary>",
            "",
            "```",
        ]
        lines += result.tail
        lines += ["```", "", "</details>"]
    return "\n".join(lines)


def _current_commit() -> str:
    git = shutil.which("git")
    if git is None:
        return "unknown"
    try:
        return subprocess.run(  # noqa: S603 - fixed command
            [git, "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--issue", type=int, help="issue number this remediation closes"
    )
    parser.add_argument(
        "--preset", choices=sorted(PRESETS), help="named group of suites"
    )
    parser.add_argument(
        "--suites", nargs="*", choices=sorted(SUITES), help="explicit suites"
    )
    parser.add_argument(
        "--trigger", default="Devin (initial)", help="who asked for this run"
    )
    parser.add_argument(
        "--commit", default="", help="commit sha to record (defaults to HEAD)"
    )
    parser.add_argument(
        "--timeout", type=int, default=2400, help="per-suite timeout in seconds"
    )
    parser.add_argument(
        "--json", dest="json_path", help="also write machine-readable results"
    )
    parser.add_argument(
        "--fail-on-regression",
        action="store_true",
        help="exit non-zero when the verdict is FAIL (for CI gating)",
    )
    args = parser.parse_args()

    names = args.suites or PRESETS[args.preset or "security"]
    results = [run_suite(SUITES[name], args.timeout) for name in names]
    report = render_report(
        results,
        issue=args.issue,
        commit=args.commit or _current_commit(),
        trigger=args.trigger,
    )
    print(report)

    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(
                {
                    "issue": args.issue,
                    "verdict": verdict(results),
                    "suites": [
                        {
                            "name": r.suite.name,
                            "command": r.suite.command,
                            "outcome": r.outcome,
                            "summary": r.summary,
                            "reason": r.reason,
                            "duration_seconds": round(r.duration_seconds, 1),
                        }
                        for r in results
                    ],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    if args.fail_on_regression and verdict(results) == "FAIL":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
