"""The agent bridge logs a refused request as a warning and only its own
failures as errors."""

from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from switch_core.bridges.agent.app import log_http_exceptions


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/agents/a1/ops/list_machines",
            "headers": [],
            "query_string": b"",
        }
    )


@pytest.mark.parametrize(
    ("status", "level"),
    [(400, logging.WARNING), (403, logging.WARNING), (500, logging.ERROR)],
)
async def test_level_follows_whose_fault_it_is(
    caplog: pytest.LogCaptureFixture, status: int, level: int
) -> None:
    with caplog.at_level(logging.DEBUG, logger="switch_core.bridges.agent.app"):
        response = await log_http_exceptions(
            _request(), HTTPException(status_code=status, detail="refused")
        )

    assert response.status_code == status
    [record] = [r for r in caplog.records if r.name == "switch_core.bridges.agent.app"]
    assert record.levelno == level
    assert f"→ {status}" in record.getMessage()
