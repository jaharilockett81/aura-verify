"""HTTP API tests (FastAPI app with an in-process MCP gateway)."""

import asyncio

import httpx
import pytest

from aura.api import create_app
from aura.gateway import MCPToolGateway
from aura.planner.local import LocalPlanner


@pytest.fixture
async def client(settings, services, mcp_server):
    gw = MCPToolGateway(mcp_server)
    app = create_app(settings, services=services, gateway=gw, planner=LocalPlanner())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        c.engine = app.state.engine
        yield c
    await app.state.engine.shutdown()
    await gw.close()


async def wait_status(client, run_id, statuses, timeout=10):
    for _ in range(int(timeout / 0.05)):
        run = (await client.get(f"/api/runs/{run_id}")).json()
        if run["status"] in statuses:
            return run
        await asyncio.sleep(0.05)
    raise AssertionError(f"run stuck in {run['status']}")


async def test_health_reports_mcp_and_simulation(client):
    data = (await client.get("/api/health")).json()
    assert data["simulation"] is True
    assert data["mcp"]["connected"] is True
    assert data["mcp"]["tools"] >= 12


async def test_chat_approve_and_complete(client):
    sid = (await client.post("/api/sessions")).json()["session_id"]
    res = (await client.post("/api/chat", json={"session_id": sid, "text": "Get everything prepared for bedtime"})).json()
    run_id = res["run"]["id"]
    assert res["run"]["status"] == "AWAITING_APPROVAL"
    assert (await client.post(f"/api/runs/{run_id}/approve")).status_code == 200
    assert (await client.post(f"/api/runs/{run_id}/approve")).status_code == 409  # can't approve twice
    run = await wait_status(client, run_id, {"PAUSED"})
    lock = next(s for s in run["steps"] if s["status"] == "AWAITING_APPROVAL")
    r = await client.post(f"/api/runs/{run_id}/steps/{lock['id']}/decision", json={"approve": True})
    assert r.status_code == 200
    run = await wait_status(client, run_id, {"COMPLETED"})
    assert all(s["status"] == "VERIFIED" for s in run["steps"])
    msgs = (await client.get(f"/api/sessions/{sid}/messages")).json()["messages"]
    assert msgs[-1]["text"].startswith("Done, and verified.")
    events = (await client.get(f"/api/runs/{run_id}/events")).json()["events"]
    assert any(e["type"] == "tool.call" for e in events)


async def test_recovery_via_api(client):
    await client.post("/api/demo/faults", json={"device_id": "thermostat", "kind": "energy_saver_hold"})
    res = (await client.post("/api/chat", json={"text": "set the thermostat to 72"})).json()
    run_id = res["run"]["id"]
    await client.post(f"/api/runs/{run_id}/approve")
    run = await wait_status(client, run_id, {"PAUSED"})
    step = run["steps"][0]
    assert step["status"] == "FAILED"
    r = await client.post(f"/api/runs/{run_id}/steps/{step['id']}/recovery", json={"option_id": "release_hold"})
    assert r.status_code == 200
    run = await wait_status(client, run_id, {"COMPLETED"})
    assert run["steps"][0]["attempts"] == 2


async def test_memory_edit_and_validation(client):
    r = await client.put("/api/memory/preferences/bedtime_temperature_f", json={"value": 69})
    assert r.status_code == 200 and r.json()["value"] == 69
    r = await client.put("/api/memory/preferences/bedtime_temperature_f", json={"value": 120})
    assert r.status_code == 400
    r = await client.post("/api/memory/preferences/bedtime_temperature_f/reset")
    assert r.json()["value"] == 68
    mem = (await client.get("/api/memory")).json()
    assert {r["id"] for r in mem["routines"]} == {"overnight_shift", "bedtime", "leaving_home"}


async def test_forget_everything_restores_defaults(client):
    await client.put("/api/memory/preferences/pet_name", json={"value": "Milo"})
    await client.post("/api/chat", json={"text": "remind me to water the plants at 6pm"})
    assert (await client.post("/api/memory/forget")).status_code == 200
    mem = (await client.get("/api/memory")).json()
    assert next(p for p in mem["preferences"] if p["key"] == "pet_name")["value"] == "Luna"
    assert (await client.get("/api/runs")).json()["runs"] == []


async def test_demo_controls(client):
    r = await client.post("/api/demo/faults", json={"device_id": "porch_light", "kind": "bogus"})
    assert r.status_code == 400
    await client.post("/api/demo/faults", json={"device_id": "front_door", "kind": "unreachable"})
    devices = (await client.get("/api/devices")).json()
    door = next(d for d in devices["devices"] if d["device_id"] == "front_door")
    assert door["reachable"] is False
    await client.delete("/api/demo/faults")
    devices = (await client.get("/api/devices")).json()
    assert all(d["reachable"] for d in devices["devices"])
