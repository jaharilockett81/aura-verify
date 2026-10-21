"""MCP server over real Streamable HTTP (uvicorn on a free port), using the official SDK client."""

import asyncio
import socket

import pytest
import uvicorn
from mcp import Client

from aura.gateway import MCPToolGateway

EXPECTED_TOOLS = {
    "get_household_context", "list_available_devices", "read_device_state", "set_device_state", "verify_action",
    "retry_failed_action", "get_routine", "save_routine", "update_preference", "create_reminder",
    "get_execution_status", "get_execution_history",
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def mcp_url(mcp_server):
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(mcp_server.streamable_http_app(), host="127.0.0.1", port=port,
                                           log_level="warning"))
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/mcp"
    server.should_exit = True
    await task


async def test_tools_listed_with_annotations(mcp_url):
    async with Client(mcp_url) as client:
        assert client.protocol_version >= "2025-11-25"
        tools = {t.name: t for t in (await client.list_tools()).tools}
    assert EXPECTED_TOOLS <= set(tools)
    assert tools["read_device_state"].annotations.read_only_hint is True
    assert tools["set_device_state"].annotations.read_only_hint is False


async def test_legacy_2025_11_25_handshake_supported(mcp_url):
    async with Client(mcp_url, mode="legacy") as client:
        assert client.protocol_version == "2025-11-25"
        res = await client.call_tool("read_device_state", {"device_id": "thermostat"})
        assert res.structured_content["state"]["setpoint_f"] == 76


async def test_ack_then_independent_verification_over_http(mcp_url):
    async with Client(mcp_url) as client:
        ack = await client.call_tool("set_device_state", {
            "device_id": "porch_light", "attributes": {"power": "on"}, "idempotency_key": "http-1"})
        assert ack.structured_content["accepted"] is True
        assert ack.structured_content["verification"].startswith("NOT_VERIFIED")
        await asyncio.sleep(0.1)
        ver = await client.call_tool("verify_action", {"target": "device:porch_light", "expected": {"power": "on"}})
        assert ver.structured_content["verdict"] == "VERIFIED"


async def test_mismatch_reported_over_http(mcp_url, services):
    services.sim.inject_fault("thermostat", "energy_saver_hold")
    async with Client(mcp_url) as client:
        await client.call_tool("set_device_state", {
            "device_id": "thermostat", "attributes": {"setpoint_f": 72}, "idempotency_key": "http-2"})
        await asyncio.sleep(0.1)
        ver = await client.call_tool("verify_action", {"target": "device:thermostat",
                                                       "expected": {"setpoint_f": 72}})
    data = ver.structured_content
    assert data["verdict"] == "MISMATCH"
    assert data["mismatches"] == [{"field": "setpoint_f", "expected": 72, "observed": 76}]


async def test_tool_errors_are_explained(mcp_url):
    async with Client(mcp_url) as client:
        res = await client.call_tool("read_device_state", {"device_id": "garage"})
        assert res.is_error
        assert "Unknown device 'garage'" in res.content[0].text
        res = await client.call_tool("set_device_state", {
            "device_id": "thermostat", "attributes": {"setpoint_f": 99}, "idempotency_key": "x"})
        assert res.is_error and "between 60 and 80" in res.content[0].text


async def test_gateway_over_http_reports_protocol(mcp_url):
    gw = MCPToolGateway(mcp_url)
    try:
        res = await gw.call("get_household_context", {})
        assert res.ok
        assert res.data["user_name"] == "Jahari"
        assert gw.transport == "streamable-http"
        assert gw.protocol_version is not None
    finally:
        await gw.close()


async def test_full_workflow_over_http(settings, services, mcp_url):
    from aura.engine import WorkflowEngine
    from aura.models import RunStatus

    gw = MCPToolGateway(mcp_url)
    eng = WorkflowEngine(settings, services.ledger, gw)
    sid = services.ledger.new_session()
    try:
        out = await eng.handle_utterance(sid, "Make sure the apartment is ready before I leave")
        run_id = out["run"]["id"]
        await eng.approve_run(run_id)
        run = await eng.wait_idle(run_id)
        lock = next(s for s in run.steps if s.status == "AWAITING_APPROVAL")
        await eng.decide_step(run_id, lock.id, True)
        run = await eng.wait_idle(run_id)
        assert run.status == RunStatus.COMPLETED
        status = await gw.call("get_execution_status", {"run_id": run_id})
        assert status.ok and status.data["status"] == "COMPLETED"
        history = await gw.call("get_execution_history", {"limit": 5})
        assert history.data["runs"][0]["run_id"] == run_id
    finally:
        await eng.shutdown()
        await gw.close()
