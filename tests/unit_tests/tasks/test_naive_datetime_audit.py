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
"""Guard the alerting and scheduling surface against naive local timestamps."""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

SCOPED_DIRECTORIES = (
    Path("superset/tasks"),
    Path("superset/commands/report"),
    Path("superset/reports"),
)

ALLOWED_NAIVE_DATETIME_NOW: dict[str, str] = {
    "superset/tasks/deletion_retention.py": (
        "Matches SoftDeleteMixin.soft_delete()'s naive-local deleted_at."
    ),
}


def _datetime_bindings(tree: ast.AST) -> tuple[set[str], set[str]]:
    """Return names bound to the datetime class and datetime module."""
    class_names: set[str] = set()
    module_names: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "datetime":
                    module_names.add(alias.asname or "datetime")
        elif isinstance(node, ast.ImportFrom) and node.module == "datetime":
            for alias in node.names:
                if alias.name == "datetime":
                    class_names.add(alias.asname or "datetime")

    return class_names, module_names


def _is_datetime_now_call(
    func: ast.expr, class_names: set[str], module_names: set[str]
) -> bool:
    """Return whether a call target resolves to datetime.now."""
    if not isinstance(func, ast.Attribute) or func.attr != "now":
        return False

    if isinstance(func.value, ast.Name):
        return func.value.id in class_names

    return (
        isinstance(func.value, ast.Attribute)
        and func.value.attr == "datetime"
        and isinstance(func.value.value, ast.Name)
        and func.value.value.id in module_names
    )


class _NaiveDatetimeNowVisitor(ast.NodeVisitor):
    """Collect argument-less datetime.now calls and their enclosing functions."""

    def __init__(self, class_names: set[str], module_names: set[str]) -> None:
        self.class_names = class_names
        self.module_names = module_names
        self.function_stack: list[str] = []
        self.calls: list[str] = []

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        if (
            not node.args
            and not node.keywords
            and _is_datetime_now_call(node.func, self.class_names, self.module_names)
        ):
            self.calls.append(".".join(self.function_stack) or "<module>")
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self.function_stack.append(node.name)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self.function_stack.append(node.name)
        self.generic_visit(node)
        self.function_stack.pop()


def _find_naive_now_calls(path: Path, repo_root: Path) -> list[tuple[str, str]]:
    """Return ``(module path, enclosing function)`` for naive datetime.now calls."""
    tree = ast.parse(path.read_text())
    class_names, module_names = _datetime_bindings(tree)
    visitor = _NaiveDatetimeNowVisitor(class_names, module_names)
    visitor.visit(tree)
    module_path = path.relative_to(repo_root).as_posix()
    return [(module_path, function_name) for function_name in visitor.calls]


def test_scoped_modules_allow_only_justified_naive_datetime_now_calls() -> None:
    """Require UTC timestamps unless a local-clock exception is documented."""
    repo_root = Path(__file__).resolve().parents[3]
    calls = [
        call
        for directory in SCOPED_DIRECTORIES
        for path in (repo_root / directory).rglob("*.py")
        for call in _find_naive_now_calls(path, repo_root)
    ]
    found_paths = {path for path, _ in calls}
    expected_paths = set(ALLOWED_NAIVE_DATETIME_NOW)
    call_counts = Counter(path for path, _ in calls)

    assert found_paths == expected_paths, (
        "Naive datetime.now() calls found in the alerting/reporting/scheduling "
        f"surface: {calls}. Use datetime.now(timezone.utc).replace(tzinfo=None) "
        "(naive-UTC, the storage convention), or add the call site to "
        f"ALLOWED_NAIVE_DATETIME_NOW with a justification comment. "
        f"Allowlist reasons: {ALLOWED_NAIVE_DATETIME_NOW}"
    )
    assert call_counts == Counter({path: 1 for path in expected_paths}), (
        "Each allowlisted module must contain exactly one naive datetime.now() "
        f"call; found {dict(call_counts)}. Allowlist reasons: "
        f"{ALLOWED_NAIVE_DATETIME_NOW}"
    )
