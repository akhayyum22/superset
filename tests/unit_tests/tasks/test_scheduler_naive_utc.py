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
"""Unit tests for the naive-UTC ``reports.execute`` fallback."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch


def test_execute_uses_naive_utc_when_schedule_and_eta_are_missing() -> None:
    """The fallback matches the naive-UTC report execution log convention."""
    from superset.tasks.scheduler import execute

    command = MagicMock()
    stats_logger = MagicMock()

    with (
        patch("superset.tasks.scheduler.current_app") as current_app_mock,
        patch(
            "superset.tasks.scheduler.AsyncExecuteReportScheduleCommand",
            return_value=command,
        ) as command_mock,
    ):
        current_app_mock.config = {"STATS_LOGGER": stats_logger}
        execute(1234)

    scheduled_dttm = command_mock.call_args.args[2]
    assert scheduled_dttm.tzinfo is None
    expected_dttm = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs(scheduled_dttm - expected_dttm) < timedelta(seconds=1)
