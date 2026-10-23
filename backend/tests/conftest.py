from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from aura.config import load_settings
from aura.engine import WorkflowEngine
from aura.gateway import MCPToolGateway
from aura.mcp_server import build_mcp_server
from aura.planner.local import LocalPlanner
from aura.services import HouseholdServices


@pytest.fixture
def settings(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AURA_DISABLE_BEDROCK", "1")
    base = load_settings()
    return dataclasses.replace(
        base,
        db_path=tmp_path / "aura-test.db",
        planner="local",
        sim_settle_ms=50,
        verify_timeout_s=0.6,
        verify_poll_s=0.1,
        tool_timeout_s=5.0,
        frontend_dist=tmp_path / "no-dist",
        timezone="UTC",
    )


# Reminder times are judged against the household clock. Pin it to 08:00 UTC tomorrow so "at 9 pm" is always
# later today and "at 7:40 am" has always just passed, whatever time the suite runs (and still in the real future).
PINNED_NOW = (datetime.now(UTC) + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)


@pytest.fixture
def services(settings):
    svc = HouseholdServices(settings)
    svc.clock = lambda: PINNED_NOW
    svc.seed()
    return svc


@pytest.fixture
def mcp_server(services):
    return build_mcp_server(services)


@pytest.fixture
async def gateway(mcp_server):
    """MCP client connected in-process (full MCP protocol layer, no HTTP)."""
    gw = MCPToolGateway(mcp_server, timeout_s=5.0)
    yield gw
    await gw.close()


@pytest.fixture
async def engine(settings, services, gateway):
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=LocalPlanner())
    yield eng
    await eng.shutdown()


@pytest.fixture
def session_id(services):
    return services.ledger.new_session()
