"""HTTP API for the AURA web experience (FastAPI), with Server-Sent Events for live execution updates.

The agent (WorkflowEngine) reaches household capabilities only through the MCP client. Read-only dashboard
views (device snapshot, memory listing) read the shared store directly and are labeled as such.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .alerts import AlertError, AlertWorkflow
from .config import Settings, bedrock_credentials_present, load_settings
from .engine import EngineError, WorkflowEngine
from .gateway import MCPToolGateway
from .memory import MemoryError
from .planner.bedrock import BedrockPlanner
from .planner.local import PLANNER_LABEL, LocalPlanner
from .services import SIMULATION_NOTICE, HouseholdServices
from .simulator import FAULT_KINDS, DeviceError

log = logging.getLogger("aura.api")


class ChatIn(BaseModel):
    session_id: str | None = None
    text: str = Field(min_length=1, max_length=500)


class DecisionIn(BaseModel):
    approve: bool


class RecoveryIn(BaseModel):
    option_id: str


class PreferenceIn(BaseModel):
    value: Any


class DeliveredIn(BaseModel):
    spoken: bool = False


class SnoozeIn(BaseModel):
    minutes: int = 10


class FixIn(BaseModel):
    session_id: str | None = None


class FaultIn(BaseModel):
    device_id: str
    kind: str


def choose_planner(settings: Settings) -> tuple[Any, str]:
    if settings.planner == "local":
        return LocalPlanner(), "local (forced by AURA_PLANNER=local)"
    if settings.planner in ("bedrock", "auto") and bedrock_credentials_present():
        return BedrockPlanner(settings.bedrock_model_id, settings.aws_region), \
            f"bedrock ({settings.bedrock_model_id}, {settings.aws_region}); local fallback on error"
    if settings.planner == "bedrock":
        log.warning("AURA_PLANNER=bedrock but no AWS credentials were found; using local planner.")
        return LocalPlanner(), "local (Bedrock requested but no AWS credentials found)"
    return LocalPlanner(), "local (no AWS credentials found)"


def create_app(settings: Settings | None = None, services: HouseholdServices | None = None,
               gateway: MCPToolGateway | None = None, planner: Any = None) -> FastAPI:
    settings = settings or load_settings()
    services = services or HouseholdServices(settings)
    services.seed()
    gateway = gateway or MCPToolGateway(settings.mcp_url, timeout_s=settings.tool_timeout_s)
    if planner is None:
        planner, planner_mode = choose_planner(settings)
    else:
        planner_mode = getattr(planner, "name", "custom")
    engine = WorkflowEngine(settings, services.ledger, gateway, planner=planner)
    interrupted = engine.recover_interrupted()
    if interrupted:
        log.warning("Marked %d interrupted run(s) as unverified: %s", len(interrupted), interrupted)

    alerts = AlertWorkflow(settings, services, gateway, engine)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        alerts.start()
        yield
        await alerts.stop()
        await engine.shutdown()
        await gateway.close()

    app = FastAPI(title="AURA Verify API", version="0.1.0", lifespan=lifespan)
    app.state.engine = engine
    app.state.alerts = alerts
    app.state.services = services
    app.state.gateway = gateway
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"],
                       allow_headers=["*"])

    def run_or_404(run_id: str) -> dict[str, Any]:
        run = services.ledger.get_run(run_id)
        if run is None:
            raise HTTPException(404, "Run not found.")
        return run.model_dump(mode="json")

    async def engine_call(coro):
        try:
            run = await coro
        except EngineError as exc:
            raise HTTPException(409, str(exc)) from exc
        return run.model_dump(mode="json")

    # ----- system ------------------------------------------------------------------------------
    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        mcp_ok, tools, error = False, 0, None
        try:
            tools = len(await asyncio.wait_for(gateway.list_tools(), timeout=settings.tool_timeout_s))
            mcp_ok = True
        except Exception as exc:  # noqa: BLE001
            error = str(exc)[:200]
        return {
            "ok": True,
            "simulation": True,
            "notice": SIMULATION_NOTICE,
            "planner": planner_mode,
            "local_planner_label": PLANNER_LABEL,
            "mcp": {"url": settings.mcp_url if gateway.transport == "streamable-http" else "in-process",
                    "transport": gateway.transport, "connected": mcp_ok, "tools": tools,
                    "protocol_version": gateway.protocol_version, "server": gateway.server_name, "error": error},
        }

    @app.get("/api/mcp/tools")
    async def mcp_tools() -> dict[str, Any]:
        try:
            return {"tools": await gateway.list_tools(), "protocol_version": gateway.protocol_version,
                    "transport": gateway.transport}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"MCP server unavailable: {exc}") from exc

    # ----- conversation ------------------------------------------------------------------------
    @app.post("/api/sessions")
    async def new_session() -> dict[str, str]:
        return {"session_id": services.ledger.new_session()}

    @app.get("/api/sessions/{session_id}/messages")
    async def messages(session_id: str) -> dict[str, Any]:
        return {"messages": services.ledger.messages(session_id)}

    @app.post("/api/chat")
    async def chat(body: ChatIn) -> dict[str, Any]:
        session_id = services.ledger.ensure_session(body.session_id)
        try:
            out = await engine.handle_utterance(session_id, body.text)
        except EngineError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"session_id": session_id, **out}

    # ----- runs --------------------------------------------------------------------------------
    @app.get("/api/runs")
    async def runs(limit: int = 30, status: str | None = None) -> dict[str, Any]:
        return {"runs": [r.model_dump(mode="json") for r in services.ledger.list_runs(min(limit, 100), status)]}

    @app.get("/api/runs/{run_id}")
    async def run_detail(run_id: str) -> dict[str, Any]:
        return run_or_404(run_id)

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str, after: int = 0) -> dict[str, Any]:
        run_or_404(run_id)
        return {"events": services.ledger.events(run_id, after)}

    @app.post("/api/runs/{run_id}/approve")
    async def approve(run_id: str) -> dict[str, Any]:
        return await engine_call(engine.approve_run(run_id))

    @app.post("/api/runs/{run_id}/cancel")
    async def cancel(run_id: str) -> dict[str, Any]:
        return await engine_call(engine.cancel_run(run_id))

    @app.post("/api/runs/{run_id}/steps/{step_id}/decision")
    async def decide(run_id: str, step_id: str, body: DecisionIn) -> dict[str, Any]:
        return await engine_call(engine.decide_step(run_id, step_id, body.approve))

    @app.post("/api/runs/{run_id}/steps/{step_id}/recovery")
    async def recover(run_id: str, step_id: str, body: RecoveryIn) -> dict[str, Any]:
        return await engine_call(engine.choose_recovery(run_id, step_id, body.option_id))

    @app.get("/api/stream")
    async def stream(request: Request) -> StreamingResponse:
        queue = services.ledger.bus.subscribe()

        async def gen():
            try:
                yield "retry: 2000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                        yield f"data: {json.dumps(event, default=str)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                services.ledger.bus.unsubscribe(queue)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/activity")
    async def activity(limit: int = 20) -> dict[str, Any]:
        return {"events": services.ledger.recent_events(
            limit=min(limit, 100), types=("run.finished", "recovery.proposed", "run.created"))}

    # ----- reminders & timers ------------------------------------------------------------------
    async def alert_call(fn, *args):
        try:
            result = fn(*args)
            return await result if asyncio.iscoroutine(result) else result
        except AlertError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/reminders")
    async def reminders() -> dict[str, Any]:
        return {"reminders": services.memory.reminders(), "tabs_open": services.ledger.bus.subscriber_count}

    @app.post("/api/reminders/{reminder_id}/delivered")
    async def reminder_delivered(reminder_id: str, body: DeliveredIn) -> dict[str, Any]:
        return await alert_call(alerts.delivered, reminder_id, body.spoken)

    @app.post("/api/reminders/{reminder_id}/done")
    async def reminder_done(reminder_id: str) -> dict[str, Any]:
        return await alert_call(alerts.done, reminder_id)

    @app.post("/api/reminders/{reminder_id}/snooze")
    async def reminder_snooze(reminder_id: str, body: SnoozeIn) -> dict[str, Any]:
        return await alert_call(alerts.snooze, reminder_id, body.minutes)

    @app.post("/api/reminders/{reminder_id}/dismiss")
    async def reminder_dismiss(reminder_id: str) -> dict[str, Any]:
        return await alert_call(alerts.dismiss, reminder_id)

    @app.post("/api/reminders/{reminder_id}/fix")
    async def reminder_fix(reminder_id: str, body: FixIn) -> dict[str, Any]:
        sid = services.ledger.ensure_session(body.session_id)
        return await alert_call(alerts.fix, reminder_id, sid)

    @app.post("/api/demo/reminders/{reminder_id}/fire")
    async def reminder_fire(reminder_id: str) -> dict[str, Any]:
        return await alert_call(alerts.fire_now, reminder_id)

    @app.get("/api/timers")
    async def timers(include_done: bool = True) -> dict[str, Any]:
        return {"timers": services.timers.list(include_done=include_done)}

    @app.post("/api/timers/{timer_id}/delivered")
    async def timer_delivered(timer_id: str, body: DeliveredIn) -> dict[str, Any]:
        return await alert_call(alerts.timer_delivered, timer_id, body.spoken)

    @app.post("/api/timers/{timer_id}/{op}")
    async def timer_op(timer_id: str, op: str) -> dict[str, Any]:
        return await alert_call(alerts.timer_op, timer_id, op)

    # ----- household (read-only dashboard views) -----------------------------------------------
    @app.get("/api/devices")
    async def devices() -> dict[str, Any]:
        return {"devices": services.sim.snapshot(), "faults": services.sim.faults(),
                "source": "direct read of the shared simulator store (dashboard view, not the agent)"}

    @app.get("/api/memory")
    async def memory() -> dict[str, Any]:
        return {"preferences": services.memory.preferences(), "routines": services.memory.routines(),
                "reminders": services.memory.reminders(), "open_issues": services.open_issues()}

    @app.put("/api/memory/preferences/{key}")
    async def put_pref(key: str, body: PreferenceIn) -> dict[str, Any]:
        try:
            return services.memory.set_preference(key, body.value, source="user (Memory screen)")
        except MemoryError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/memory/preferences/{key}/reset")
    async def reset_pref(key: str) -> dict[str, Any]:
        try:
            return services.memory.reset_preference(key)
        except MemoryError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/api/memory/reminders/{reminder_id}")
    async def delete_reminder(reminder_id: str) -> dict[str, Any]:
        if not services.memory.delete_reminder(reminder_id):
            raise HTTPException(404, "Reminder not found.")
        return {"deleted": reminder_id}

    @app.get("/api/memory/export")
    async def export_memory() -> JSONResponse:
        data = {"preferences": services.memory.preferences(), "routines": services.memory.routines(),
                "reminders": services.memory.reminders(),
                "runs": [r.model_dump(mode="json") for r in services.ledger.list_runs(limit=100)]}
        return JSONResponse(data, headers={"Content-Disposition": "attachment; filename=aura-memory.json"})

    @app.post("/api/memory/forget")
    async def forget() -> dict[str, Any]:
        if services.ledger.active_runs():
            raise HTTPException(409, "A routine is still running. Cancel it first.")
        services.memory.forget_everything()
        return {"ok": True, "message": "Deleted saved preferences, routines, reminders and history. Defaults restored."}

    # ----- demo controls (simulation only) -----------------------------------------------------
    @app.get("/api/demo/faults")
    async def faults() -> dict[str, Any]:
        return {"active": services.sim.faults(), "kinds": FAULT_KINDS}

    @app.post("/api/demo/faults")
    async def inject(body: FaultIn) -> dict[str, Any]:
        try:
            return services.sim.inject_fault(body.device_id, body.kind)
        except DeviceError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/api/demo/faults")
    async def clear_faults() -> dict[str, Any]:
        services.sim.clear_faults()
        return {"ok": True}

    @app.post("/api/demo/reset")
    async def reset_devices() -> dict[str, Any]:
        if services.ledger.active_runs():
            raise HTTPException(409, "A routine is still running. Cancel it first.")
        services.sim.seed(force=True)
        return {"ok": True, "devices": services.sim.snapshot()}

    # ----- frontend ----------------------------------------------------------------------------
    dist = settings.frontend_dist
    if (dist / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404)
            candidate = dist / path
            if path and candidate.is_file() and dist in candidate.resolve().parents:
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app
