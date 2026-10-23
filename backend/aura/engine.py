"""Workflow engine: INTENT → PLAN → AUTHORIZE → EXECUTE → VERIFY → RECOVER → REMEMBER.

All household effects go through the ToolGateway (MCP). The engine owns the execution ledger and is the only
writer of run/step state. A step is VERIFIED only when an independent check (verify_action) confirms it; an
acknowledgement from set_device_state is recorded as ACCEPTED and nothing more.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from .config import Settings
from .db import now_iso
from .gateway import MCPToolGateway, ToolResult
from .ledger import Ledger
from .models import (
    TERMINAL_RUN_STATUSES,
    TERMINAL_STEP_STATUSES,
    Assurance,
    Evidence,
    PlanDraft,
    PlannedAction,
    RecoveryOption,
    Risk,
    Run,
    RunStatus,
    Step,
    StepStatus,
)
from .planner import Planner
from .planner.local import LocalPlanner, is_wake_only
from .policy import PlanValidationError, assess_risk, validate_actions

log = logging.getLogger("aura.engine")


def apply_overrides(actions: list[PlannedAction], overrides: dict[str, dict[str, Any]]) -> list[PlannedAction]:
    """Apply values the user stated for this run on top of a routine's saved preferences.

    The saved preference itself is untouched; the step says where its value came from. A device the routine
    doesn't touch gets its own step, so an explicit request is never dropped.
    """
    out: list[PlannedAction] = []
    pending = dict(overrides)
    for a in actions:
        new = pending.pop(a.device_id, None) if a.action == "set_device" else None
        if new:
            before = {k: a.attributes.get(k) for k in new}
            a = a.model_copy(update={"attributes": {**a.attributes, **new}})
            if "setpoint_f" in new:
                a.title = f"Set the thermostat to {new['setpoint_f']}°F"
            said = ", ".join(f"{v}°F" if k == "setpoint_f" else f"{k} = {v}" for k, v in new.items())
            was = ", ".join(f"{v}°F" if k == "setpoint_f" else f"{k} = {v}" for k, v in before.items())
            a.rationale = f"You asked for {said} for this run."
            a.provenance = f"From your request: {said} (routine default {was}; saved preference unchanged)"
        out.append(a)
    for device_id, attrs in pending.items():
        said = ", ".join(f"{v}°F" if k == "setpoint_f" else f"{k} = {v}" for k, v in attrs.items())
        title = (f"Set the thermostat to {attrs['setpoint_f']}°F" if device_id == "thermostat" and "setpoint_f" in attrs
                 else f"Set {device_id.replace('_', ' ')}: {said}")
        out.append(PlannedAction(action="set_device", device_id=device_id, attributes=attrs, title=title,
                                 rationale=f"You asked for {said} for this run.",
                                 provenance=f"From your request: {said}"))
    return out


class EngineError(Exception):
    """A request the engine refuses (wrong state, unknown id). Maps to HTTP 4xx."""


def _fmt_state(device_type: str | None, state: dict[str, Any] | None) -> str:
    if not state:
        return "unreadable"
    if device_type == "thermostat":
        hold = state.get("hold")
        return f"{state.get('setpoint_f')}°F" + (" (energy-saver hold active)" if hold and hold != "none" else "")
    if device_type == "lock":
        return "locked" if state.get("locked") else "unlocked"
    if device_type == "light":
        if state.get("power") == "on":
            return f"on at {state.get('brightness')}%"
        return "off"
    if "power" in state:
        return str(state["power"])
    return ", ".join(f"{k}={v}" for k, v in state.items())


def _fmt_expected(device_type: str | None, expected: dict[str, Any]) -> str:
    if device_type == "thermostat" and "setpoint_f" in expected:
        return f"{expected['setpoint_f']}°F"
    if device_type == "lock":
        return "locked" if expected.get("locked") else "unlocked"
    if device_type == "light":
        if expected.get("power") == "off":
            return "off"
        return "on" + (f" at {expected['brightness']}%" if "brightness" in expected else "")
    return ", ".join(f"{k}={v}" for k, v in expected.items())


class WorkflowEngine:
    def __init__(self, settings: Settings, ledger: Ledger, gateway: MCPToolGateway,
                 planner: Planner | None = None, fallback: Planner | None = None):
        self.settings = settings
        self.ledger = ledger
        self.gateway = gateway
        self.planner: Planner = planner or LocalPlanner()
        self.fallback: Planner = fallback or LocalPlanner()
        self._tasks: dict[str, asyncio.Task] = {}
        self._device_types: dict[str, str] = {}

    # =========================================================================================
    # INTENT + PLAN
    # =========================================================================================
    async def handle_utterance(self, session_id: str, utterance: str) -> dict[str, Any]:
        utterance = utterance.strip()
        if not utterance:
            raise EngineError("Say or type something first.")
        if len(utterance) > 500:
            raise EngineError("That request is too long (500 characters max).")
        self.ledger.add_message(session_id, "user", utterance)

        ctx_result = await self.gateway.call("get_household_context", {})
        if not ctx_result.ok:
            msg = ("I can't reach the household tools right now (MCP server unavailable), so I haven't done "
                   f"anything. Details: {ctx_result.error}")
            reply = self.ledger.add_message(session_id, "assistant", msg, meta={"error": True})
            return {"message": reply, "run": None}
        context = ctx_result.data
        self._device_types = {d["device_id"]: d["type"] for d in context.get("devices", [])}

        context["session"] = self._session_summary(session_id)
        pending = self.ledger.session_pending(session_id)
        draft = await self._plan(utterance, context, pending)
        self.ledger.set_session_pending(session_id, None)
        meta = {"planner": draft.planner, "planner_detail": draft.planner_detail, "intent": draft.intent}
        if draft.listen:
            meta["listen"] = True

        if draft.intent == "clarify":
            slot = dict(draft.pending_slot or {})
            slot["original_utterance"] = utterance
            self.ledger.set_session_pending(session_id, slot)
            text = draft.clarification_question or draft.spoken_response
            return {"message": self.ledger.add_message(session_id, "assistant", text, meta=meta), "run": None}
        if draft.intent == "unknown" or (not draft.actions and draft.intent != "routine"):
            return {"message": self.ledger.add_message(session_id, "assistant", draft.spoken_response, meta=meta),
                    "run": None}

        actions = draft.actions
        if draft.intent == "routine":
            routine = await self.gateway.call("get_routine", {"routine_id": draft.routine_id or ""})
            if not routine.ok:
                text = f"I couldn't load that routine from memory: {routine.error}"
                return {"message": self.ledger.add_message(session_id, "assistant", text, meta=meta), "run": None}
            actions = [PlannedAction.model_validate(a) for a in routine.data["resolved_actions"]]
            meta["routine_loaded_from"] = "get_routine (MCP) — resolved with current saved preferences"
            if draft.overrides:
                actions = apply_overrides(actions, draft.overrides)
                meta["overrides"] = draft.overrides

        try:
            validate_actions(actions, context.get("devices", []),
                             {p["key"] for p in context.get("preferences", [])})
        except PlanValidationError as exc:
            text = f"I won't run that plan because it failed validation: {exc}"
            return {"message": self.ledger.add_message(session_id, "assistant", text, meta=meta), "run": None}

        if draft.replaces_run_id:
            self._supersede(draft.replaces_run_id)
        run = self._start_run(session_id, utterance, draft, actions)
        meta["run_id"] = run.id
        reply = self.ledger.add_message(session_id, "assistant", draft.spoken_response, run_id=run.id, meta=meta)
        return {"message": reply, "run": run.model_dump(mode="json")}

    def _start_run(self, session_id: str, utterance: str, draft: PlanDraft, actions: list[PlannedAction]) -> Run:
        run = self._compile(session_id, utterance, draft, actions)
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.created", {"status": run.status, "summary": run.summary,
                                                 "planner": run.planner, "steps": len(run.steps)})
        timers_only = all(s.action == "timer" for s in run.steps)
        auto = all(s.risk == Risk.READ_ONLY for s in run.steps) or draft.intent == "preference_update" or timers_only
        if auto:
            if draft.intent == "preference_update":
                reason = "You stated this preference directly, which authorizes saving it. You can undo it in Memory."
            elif timers_only and not all(s.risk == Risk.READ_ONLY for s in run.steps):
                reason = "Timers only change AURA's own timer list, so they run without approval."
            else:
                reason = "Read-only plan: runs without approval."
            self._authorize(run, actor="policy", reason=reason)
            self.ledger.save_run(run)
            self._spawn(run.id)
        ctx = self.ledger.session_context(session_id)
        devices = [s.target.split(":", 1)[1] for s in run.steps if s.target.startswith("device:")]
        ctx.update({"last_run_id": run.id, "last_intent": draft.intent})
        if devices:
            ctx["last_devices"] = list(dict.fromkeys(devices))
        self.ledger.set_session_context(session_id, ctx)
        return run

    async def create_run_from_actions(self, session_id: str, utterance: str, summary: str,
                                      actions: list[PlannedAction], spoken: str) -> Run:
        """Plan a run from actions AURA itself proposes (e.g. fixing a reminder). Goes through the same validation,
        policy and approval as a spoken request."""
        ctx_result = await self.gateway.call("get_household_context", {})
        if not ctx_result.ok:
            raise EngineError(f"Household tools unavailable: {ctx_result.error}")
        context = ctx_result.data
        self._device_types = {d["device_id"]: d["type"] for d in context.get("devices", [])}
        try:
            validate_actions(actions, context.get("devices", []), {p["key"] for p in context.get("preferences", [])})
        except PlanValidationError as exc:
            raise EngineError(f"Plan failed validation: {exc}") from exc
        draft = PlanDraft(intent="device_control", summary=summary, spoken_response=spoken, planner="aura",
                          planner_detail="Proposed by AURA from a reminder check (not a language model)")
        run = self._start_run(session_id, utterance, draft, actions)
        self.ledger.add_message(session_id, "assistant", spoken, run_id=run.id,
                                meta={"run_id": run.id, "planner": "aura", "intent": "device_control"})
        return run

    def _supersede(self, run_id: str) -> None:
        """A correction replaces a plan that is still only a preview. Nothing of it ran, so nothing is undone."""
        run = self.ledger.get_run(run_id)
        if run is None or run.status != RunStatus.AWAITING_APPROVAL:
            return
        for s in run.steps:
            if s.status not in TERMINAL_STEP_STATUSES:
                s.status = StepStatus.CANCELLED
                s.finished_at = now_iso()
        run.status = RunStatus.CANCELLED
        run.finished_at = now_iso()
        run.final_report = "Replaced by your correction before anything ran. Nothing was sent."
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.finished", {"status": run.status, "report": run.final_report})

    def _session_summary(self, session_id: str) -> dict[str, Any]:
        """What the planner may know about this conversation, for follow-ups and corrections."""
        ctx = self.ledger.session_context(session_id)
        last = self.ledger.get_run(ctx["last_run_id"]) if ctx.get("last_run_id") else None
        out: dict[str, Any] = {"last_devices": ctx.get("last_devices", []), "last_intent": ctx.get("last_intent")}
        if last is not None:
            out["last_run"] = {
                "run_id": last.id, "status": last.status, "summary": last.summary, "intent": last.intent,
                "routine_id": last.routine_id, "final_report": last.final_report, "utterance": last.utterance,
                "steps": [{"title": s.title, "status": s.status, "action": s.action, "target": s.target,
                           "params": s.params} for s in last.steps],
            }
        return out

    async def _plan(self, utterance: str, context: dict[str, Any], pending: dict[str, Any] | None) -> PlanDraft:
        if self.planner is self.fallback or isinstance(self.planner, LocalPlanner):
            return await self.planner.plan(utterance, context, pending)
        if is_wake_only(utterance):  # "Aura?" needs no model call: answer at once and listen
            return await self.fallback.plan(utterance, context, pending)
        try:
            return await self.planner.plan(utterance, context, pending)
        except Exception as exc:  # noqa: BLE001 - any LLM failure falls back, and the fallback is disclosed
            log.warning("Primary planner failed: %r", exc)
            draft = await self.fallback.plan(utterance, context, pending)
            draft.planner_detail = f"{draft.planner_detail} — used because the Bedrock call failed: {str(exc)[:160]}"
            return draft

    def _compile(self, session_id: str, utterance: str, draft: PlanDraft, actions: list[PlannedAction]) -> Run:
        now = now_iso()
        run_id = f"run_{uuid.uuid4().hex[:10]}"
        steps: list[Step] = []
        for i, a in enumerate(actions):
            dtype = self._device_types.get(a.device_id or "")
            risk, risk_reason = assess_risk(a, dtype)
            if a.action in ("read_device", "set_device"):
                target = f"device:{a.device_id}"
                params: dict[str, Any] = {"device_id": a.device_id, "attributes": a.attributes}
                expected = dict(a.attributes) if a.action == "set_device" else {}
            elif a.action == "create_reminder":
                target = "reminder"
                params = {"reminder": a.reminder}
                expected = {"title": (a.reminder or {}).get("title")}
                if (a.reminder or {}).get("due") is not None or not (a.reminder or {}).get("due_in_minutes"):
                    expected["due"] = (a.reminder or {}).get("due")
            elif a.action == "timer":
                t = a.timer or {}
                target = "timer:pending"
                params = {"timer": t}
                expected = {} if t.get("op") == "check" else {"status": {
                    "create": "created", "create_and_start": "running", "start": "running", "resume": "running",
                    "pause": "paused", "cancel": "cancelled"}[t["op"]]}
            else:
                target = f"preference:{a.preference_key}"
                params = {"key": a.preference_key, "value": a.preference_value}
                expected = {"value": a.preference_value}
            step_id = f"stp_{uuid.uuid4().hex[:10]}"
            steps.append(Step(
                id=step_id, run_id=run_id, index=i, title=a.title, rationale=a.rationale, action=a.action,
                target=target, params=params, expected=expected, risk=risk, status=StepStatus.PENDING,
                assurance=Assurance.PROPOSED, max_attempts=self.settings.max_attempts,
                idempotency_key=f"{run_id}:{step_id}", provenance=a.provenance,
                evidence=[Evidence(kind="note", source="policy", summary=f"Risk {risk.value}: {risk_reason}",
                                   at=now)],
                created_at=now, updated_at=now,
            ))
        return Run(id=run_id, session_id=session_id, utterance=utterance, intent=draft.intent,
                   summary=draft.summary, routine_id=draft.routine_id, planner=draft.planner,
                   planner_detail=draft.planner_detail, status=RunStatus.AWAITING_APPROVAL,
                   spoken_response=draft.spoken_response, created_at=now, updated_at=now, steps=steps)

    # =========================================================================================
    # AUTHORIZE
    # =========================================================================================
    def _authorize(self, run: Run, actor: str, reason: str) -> None:
        run.status = RunStatus.RUNNING
        run.approved_at = now_iso()
        for s in run.steps:
            if s.status == StepStatus.PENDING and s.risk != Risk.SENSITIVE:
                s.assurance = Assurance.AUTHORIZED
                s.evidence.append(Evidence(kind="approval", source=actor, summary=reason, at=now_iso()))

    def _load(self, run_id: str) -> Run:
        run = self.ledger.get_run(run_id)
        if run is None:
            raise EngineError(f"Unknown run '{run_id}'.")
        return run

    def _busy(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    async def approve_run(self, run_id: str) -> Run:
        run = self._load(run_id)
        if run.status != RunStatus.AWAITING_APPROVAL:
            raise EngineError(f"Run is {run.status}; only a plan awaiting approval can be approved.")
        self._authorize(run, actor="user", reason="You approved the plan.")
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.status", {"status": run.status, "by": "user"})
        self._spawn(run.id)
        return run

    async def cancel_run(self, run_id: str) -> Run:
        run = self._load(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            raise EngineError(f"Run already finished ({run.status}).")
        task = self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            run = self._load(run_id)
        for s in run.steps:
            if s.status not in TERMINAL_STEP_STATUSES:
                was_in_flight = s.status in (StepStatus.RUNNING, StepStatus.VERIFYING, StepStatus.RECOVERING)
                s.status = StepStatus.UNKNOWN if was_in_flight else StepStatus.CANCELLED
                if was_in_flight:
                    s.assurance = Assurance.UNKNOWN
                    s.error = "Cancelled while in flight; the command may or may not have taken effect."
                s.finished_at = now_iso()
        run.status = RunStatus.CANCELLED
        run.finished_at = now_iso()
        run.final_report = self._report(run)
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.finished", {"status": run.status, "report": run.final_report})
        self.ledger.add_message(run.session_id, "assistant", f"Cancelled. {run.final_report}", run_id=run.id)
        return run

    async def decide_step(self, run_id: str, step_id: str, approve: bool) -> Run:
        run = self._load(run_id)
        if self._busy(run_id):
            raise EngineError("The run is executing; wait for it to pause.")
        step = next((s for s in run.steps if s.id == step_id), None)
        if step is None or step.status != StepStatus.AWAITING_APPROVAL:
            raise EngineError("That step is not waiting for approval.")
        if approve:
            step.status = StepStatus.PENDING
            step.assurance = Assurance.AUTHORIZED
            step.evidence.append(Evidence(kind="approval", source="user", summary="You confirmed this step.",
                                          at=now_iso()))
        else:
            step.status = StepStatus.CANCELLED
            step.finished_at = now_iso()
            step.evidence.append(Evidence(kind="approval", source="user",
                                          summary="You declined this step. Nothing was sent.", at=now_iso()))
        run.status = RunStatus.RUNNING
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "step.status", {"step_id": step.id, "status": step.status, "by": "user"})
        self._spawn(run.id)
        return run

    async def choose_recovery(self, run_id: str, step_id: str, option_id: str) -> Run:
        run = self._load(run_id)
        if self._busy(run_id):
            raise EngineError("The run is executing; wait for it to pause.")
        step = next((s for s in run.steps if s.id == step_id), None)
        if step is None or not step.recovery_options:
            raise EngineError("That step has no pending recovery options.")
        option = next((o for o in step.recovery_options if o.id == option_id), None)
        if option is None:
            raise EngineError("Unknown recovery option.")
        step.recovery_options = []
        step.recovery_log.append({"at": now_iso(), "event": "chosen", "strategy": option.strategy,
                                  "label": option.label, "by": "user"})
        step.evidence.append(Evidence(kind="approval", source="user",
                                      summary=f"You chose: {option.label}.", at=now_iso()))
        run.status = RunStatus.RUNNING
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "recovery.chosen", {"step_id": step.id, "strategy": option.strategy})
        self._spawn(run.id, recovery=(step.id, option.strategy))
        return run

    # =========================================================================================
    # EXECUTE
    # =========================================================================================
    def _spawn(self, run_id: str, recovery: tuple[str, str] | None = None) -> None:
        if self._busy(run_id):
            return
        self._tasks[run_id] = asyncio.create_task(self._advance(run_id, recovery), name=f"run-{run_id}")

    async def wait_idle(self, run_id: str, timeout: float = 30) -> Run:
        """Wait until the run's background task stops (paused or finished). Used by tests and the CLI."""
        task = self._tasks.get(run_id)
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        return self._load(run_id)

    async def _ensure_types(self) -> None:
        if not self._device_types:
            res = await self.gateway.call("list_available_devices", {})
            if res.ok:
                self._device_types = {d["device_id"]: d["type"] for d in res.data["devices"]}

    async def _advance(self, run_id: str, recovery: tuple[str, str] | None) -> None:
        run = self._load(run_id)
        try:
            await self._ensure_types()
            if recovery is not None:
                step = next(s for s in run.steps if s.id == recovery[0])
                await self._recover(run, step, recovery[1])
                if step.recovery_options:
                    return self._pause(run, "recovery")
            for step in run.steps:
                if step.status in TERMINAL_STEP_STATUSES:
                    if step.recovery_options:
                        return self._pause(run, "recovery")
                    continue
                if step.status == StepStatus.AWAITING_APPROVAL:
                    return self._pause(run, "approval")
                if step.risk == Risk.SENSITIVE and step.assurance != Assurance.AUTHORIZED:
                    step.status = StepStatus.AWAITING_APPROVAL
                    self._save(run, step)
                    self.ledger.emit(run.id, "approval.requested", {"step_id": step.id, "title": step.title})
                    return self._pause(run, "approval")
                await self._execute(run, step)
                if step.recovery_options:
                    return self._pause(run, "recovery")
            self._finish(run)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - never leave a run silently stuck
            log.exception("Engine crashed on run %s", run_id)
            run = self._load(run_id)
            for s in run.steps:
                if s.status in (StepStatus.RUNNING, StepStatus.VERIFYING, StepStatus.RECOVERING):
                    s.status, s.assurance = StepStatus.UNKNOWN, Assurance.UNKNOWN
                    s.error = f"Internal error while in flight: {exc}"
            run.status = RunStatus.FAILED
            run.finished_at = now_iso()
            run.final_report = f"AURA hit an internal error and stopped: {exc}. " + self._report(run)
            self.ledger.save_run(run)
            self.ledger.emit(run.id, "run.finished", {"status": run.status, "report": run.final_report})

    def _pause(self, run: Run, why: str) -> None:
        run.status = RunStatus.PAUSED
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.status", {"status": run.status, "waiting_for": why})

    def _save(self, run: Run, step: Step, emit: bool = True) -> None:
        self.ledger.save_step(step)
        if emit:
            self.ledger.emit(run.id, "step.status", {"step_id": step.id, "status": step.status,
                                                     "assurance": step.assurance, "attempts": step.attempts})

    def _set(self, run: Run, step: Step, status: StepStatus, assurance: Assurance | None = None) -> None:
        step.status = status
        if assurance is not None:
            step.assurance = assurance
        if status in TERMINAL_STEP_STATUSES:
            step.finished_at = now_iso()
        self._save(run, step)

    def _evidence(self, run: Run, step: Step, kind: str, source: str, summary: str,
                  data: dict[str, Any] | None = None) -> None:
        ev = Evidence(kind=kind, source=source, summary=summary, data=data or {}, at=now_iso())
        step.evidence.append(ev)
        self.ledger.save_step(step)
        self.ledger.emit(run.id, "evidence", {"step_id": step.id, **ev.model_dump()})

    async def _tool(self, run: Run, step: Step | None, tool: str, args: dict[str, Any]) -> ToolResult:
        result = await self.gateway.call(tool, args)
        self.ledger.emit(run.id, "tool.call", {
            "step_id": step.id if step else None, "tool": tool, "arguments": args, "ok": result.ok,
            "error": result.error, "timed_out": result.timed_out, "duration_ms": result.duration_ms,
            "result": result.data, "transport": self.gateway.transport,
            "protocol_version": self.gateway.protocol_version,
        })
        return result

    async def _execute(self, run: Run, step: Step) -> None:
        if step.action == "read_device":
            await self._exec_read(run, step)
        elif step.action == "set_device":
            await self._exec_set(run, step)
        elif step.action == "create_reminder":
            await self._exec_reminder(run, step)
        elif step.action == "update_preference":
            await self._exec_preference(run, step)
        elif step.action == "timer":
            await self._exec_timer(run, step)

    async def _exec_timer(self, run: Run, step: Step) -> None:
        t = step.params["timer"]
        self._set(run, step, StepStatus.RUNNING)
        step.attempts = 1
        if t["op"] == "check":
            res = await self._tool(run, step, "list_timers", {"include_done": False})
            if not res.ok:
                step.error = res.error
                self._set(run, step, StepStatus.UNKNOWN, Assurance.UNKNOWN)
                return
            timers = res.data["timers"]
            if t.get("label"):
                timers = [x for x in timers if t["label"].lower() in x["label"].lower()]
            if not timers:
                text = "No timers are running." if not t.get("label") else f"There's no {t['label']} timer running."
            else:
                text = " ".join(f"{x['label']}: {x['remaining_text']} left" +
                                (" (paused)." if x["status"] == "paused" else
                                 " (not started)." if x["status"] == "created" else ".") for x in timers)
            step.result = {"timers": timers}
            self._evidence(run, step, "state_read", "list_timers", text, res.data)
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
            return
        args = {"op": t["op"], "idempotency_key": step.idempotency_key}
        for key in ("label", "duration_s", "timer_id"):
            if t.get(key) is not None:
                args[key] = t[key]
        res = await self._tool(run, step, "manage_timer", args)
        if not res.ok:
            step.error = res.error
            self._set(run, step, StepStatus.UNKNOWN if res.timed_out else StepStatus.FAILED,
                      Assurance.UNKNOWN if res.timed_out else Assurance.FAILED)
            return
        step.assurance = Assurance.ACCEPTED
        step.target = f"timer:{res.data['timer_id']}"
        self._evidence(run, step, "ack", "manage_timer",
                       f"Timer service accepted “{t['op'].replace('_', ' ')}” for {res.data['label']} "
                       "(not yet verified).", res.data)
        self._set(run, step, StepStatus.VERIFYING)
        ver = await self._tool(run, step, "verify_action", {"target": step.target, "expected": step.expected})
        if ver.ok and ver.data["verdict"] == "VERIFIED":
            obs = ver.data["observed"]
            self._evidence(run, step, "verification", "verify_action",
                           f"Read back: {obs['label']} is {obs['status']} with {obs['remaining_text']} left.",
                           ver.data)
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
        else:
            step.error = "The timer did not read back in the expected state."
            self._evidence(run, step, "verification", "verify_action", step.error,
                           ver.data if ver.ok else {"error": ver.error})
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)

    async def _exec_read(self, run: Run, step: Step) -> None:
        self._set(run, step, StepStatus.RUNNING)
        device_id = step.params["device_id"]
        res = await self._tool(run, step, "read_device_state", {"device_id": device_id})
        step.attempts = 1
        if res.ok:
            step.result = res.data
            self._evidence(run, step, "state_read", "read_device_state",
                           f"{res.data['name']} reports {_fmt_state(res.data['type'], res.data['state'])}.",
                           res.data)
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
        else:
            step.error = res.error
            self._set(run, step, StepStatus.UNKNOWN, Assurance.UNKNOWN)

    async def _exec_set(self, run: Run, step: Step) -> None:
        device_id = step.params["device_id"]
        dtype = self._device_type(device_id)
        self._set(run, step, StepStatus.RUNNING)

        # Pre-check: observe before acting. Skips redundant commands (idempotent no-op).
        pre = await self._tool(run, step, "read_device_state", {"device_id": device_id})
        if pre.ok:
            current = pre.data["state"]
            self._evidence(run, step, "precheck", "read_device_state",
                           f"Before: {_fmt_state(dtype, current)}.", {"state": current})
            if all(current.get(k) == v for k, v in step.expected.items()):
                step.result = {"skipped_command": True, "observed": current}
                self._evidence(run, step, "verification", "read_device_state",
                               f"Already {_fmt_expected(dtype, step.expected)}. No command needed, none sent.",
                               {"observed": current, "expected": step.expected})
                self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
                return
        else:
            self._evidence(run, step, "precheck", "read_device_state",
                           f"Could not read the device before acting: {pre.error}", {"error": pre.error})

        ack = await self._tool(run, step, "set_device_state", {
            "device_id": device_id, "attributes": step.params["attributes"],
            "idempotency_key": step.idempotency_key})
        step.attempts = 1
        if not ack.ok and not ack.timed_out:
            step.error = f"Command rejected: {ack.error}"
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)
            return  # a rejected (invalid) command is not retryable
        if ack.ok:
            self._evidence(run, step, "ack", "set_device_state",
                           "Hub acknowledged the command (accepted, not yet verified).", ack.data)
            step.assurance = Assurance.ACCEPTED
        else:
            self._evidence(run, step, "ack", "set_device_state",
                           "No acknowledgement before the timeout: outcome ambiguous, checking actual state.",
                           {"error": ack.error})
        await self._verify_device(run, step, dtype)
        if step.status != StepStatus.VERIFIED:
            await self._diagnose_and_recover(run, step, dtype)

    async def _verify_device(self, run: Run, step: Step, dtype: str | None) -> None:
        self._set(run, step, StepStatus.VERIFYING)
        deadline = time.monotonic() + self.settings.verify_timeout_s
        reads = 0
        last: ToolResult | None = None
        while True:
            await asyncio.sleep(self.settings.verify_poll_s)
            last = await self._tool(run, step, "verify_action",
                                    {"target": step.target, "expected": step.expected})
            reads += 1
            if last.ok and last.data.get("verdict") == "VERIFIED":
                break
            if time.monotonic() >= deadline:
                break
        waited = self.settings.verify_timeout_s
        if last.ok and last.data["verdict"] == "VERIFIED":
            observed = last.data["observed"]
            step.result = {"verification": last.data}
            self._evidence(run, step, "verification", "verify_action",
                           f"Independent read confirms {_fmt_state(dtype, observed)} "
                           f"(read {reads}x via the state channel, not the command ack).", last.data)
            step.error = None
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
        elif last.ok and last.data["verdict"] == "MISMATCH":
            observed = last.data["observed"]
            step.result = {"verification": last.data}
            step.error = (f"Expected {_fmt_expected(dtype, step.expected)}, but the device still reports "
                          f"{_fmt_state(dtype, observed)} after {waited:.1f}s ({reads} reads).")
            self._evidence(run, step, "verification", "verify_action", f"Mismatch. {step.error}", last.data)
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)
        else:
            reason = last.data.get("reason") if last.ok else last.error
            step.error = f"Couldn't confirm the outcome: {reason}"
            self._evidence(run, step, "verification", "verify_action",
                           f"Outcome unknown. {step.error}", last.data if last.ok else {"error": last.error})
            self._set(run, step, StepStatus.UNKNOWN, Assurance.UNKNOWN)

    async def _exec_reminder(self, run: Run, step: Step) -> None:
        self._set(run, step, StepStatus.RUNNING)
        rem = step.params["reminder"]
        args = {"title": rem["title"], "due": rem.get("due"), "note": rem.get("note"),
                "category": rem.get("category", "general"), "idempotency_key": step.idempotency_key}
        if rem.get("due_in_minutes"):
            args["due_in_minutes"] = rem["due_in_minutes"]
        if rem.get("check"):
            args["check"] = rem["check"]
        res = await self._tool(run, step, "create_reminder", args)
        step.attempts = 1
        if not res.ok:
            step.error = res.error
            self._set(run, step, StepStatus.UNKNOWN if res.timed_out else StepStatus.FAILED,
                      Assurance.UNKNOWN if res.timed_out else Assurance.FAILED)
            return
        step.assurance = Assurance.ACCEPTED
        self._evidence(run, step, "ack", "create_reminder",
                       f"Reminder stored as {res.data['reminder_id']} (alerts appear only in an open AURA tab).",
                       res.data)
        step.target = f"reminder:{res.data['reminder_id']}"
        self._set(run, step, StepStatus.VERIFYING)
        ver = await self._tool(run, step, "verify_action", {"target": step.target, "expected": step.expected})
        if ver.ok and ver.data["verdict"] == "VERIFIED":
            obs = ver.data["observed"]
            check = " It will be checked against the device when due." if obs.get("check") else ""
            self._evidence(run, step, "verification", "verify_action",
                           f"Read back reminder “{obs['title']}” at {obs['due'] or 'no set time'}.{check}", ver.data)
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
        else:
            step.error = "Reminder could not be read back after saving."
            self._evidence(run, step, "verification", "verify_action", step.error,
                           ver.data if ver.ok else {"error": ver.error})
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)

    async def _exec_preference(self, run: Run, step: Step) -> None:
        self._set(run, step, StepStatus.RUNNING)
        res = await self._tool(run, step, "update_preference",
                               {"key": step.params["key"], "value": step.params["value"]})
        step.attempts = 1
        if not res.ok:
            step.error = res.error
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)
            return
        step.assurance = Assurance.ACCEPTED
        self._evidence(run, step, "ack", "update_preference",
                       f"Saved {res.data['label']}: {res.data['previous_value']} → {res.data['value']}.", res.data)
        step.expected = {"value": res.data["value"]}
        self._set(run, step, StepStatus.VERIFYING)
        ver = await self._tool(run, step, "verify_action", {"target": step.target, "expected": step.expected})
        if ver.ok and ver.data["verdict"] == "VERIFIED":
            self._evidence(run, step, "verification", "verify_action",
                           f"Read back from the preference store: {ver.data['observed']['value']} "
                           "(persisted in SQLite; survives restarts).", ver.data)
            self._set(run, step, StepStatus.VERIFIED, Assurance.VERIFIED)
        else:
            step.error = "Preference did not read back as saved."
            self._evidence(run, step, "verification", "verify_action", step.error,
                           ver.data if ver.ok else {"error": ver.error})
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)

    def _device_type(self, device_id: str) -> str | None:
        return self._device_types.get(device_id)

    # =========================================================================================
    # RECOVER
    # =========================================================================================
    async def _diagnose_and_recover(self, run: Run, step: Step, dtype: str | None) -> None:
        """Explain the failure from evidence, then auto-retry once (if safe and unexplained) or ask the user."""
        diag = await self._tool(run, step, "read_device_state", {"device_id": step.params["device_id"]})
        remaining = step.max_attempts - step.attempts
        options: list[RecoveryOption] = []
        cause: str
        if not diag.ok:
            cause = (f"The {step.params['device_id'].replace('_', ' ')} isn't responding to state reads, so I can't "
                     "tell whether the command took effect. It may be offline.")
            self._evidence(run, step, "diagnosis", "read_device_state", cause, {"error": diag.error})
            if remaining > 0:
                options.append(RecoveryOption(id="retry", strategy="retry", label="Try again",
                                              explanation="Resend the same command and check again.",
                                              risk=Risk.ROUTINE, recommended=False))
        else:
            state = diag.data["state"]
            hold_blocking = (dtype == "thermostat" and state.get("hold") == "energy_saver"
                             and "setpoint_f" in step.expected)
            if hold_blocking:
                cause = ("The thermostat is in an energy-saver hold. The hub accepted the command, but the device "
                         "ignored the new setpoint while the hold is active.")
                self._evidence(run, step, "diagnosis", "read_device_state", cause, diag.data)
                if remaining > 0:
                    options.append(RecoveryOption(
                        id="release_hold", strategy="release_hold_and_reapply",
                        label=f"Release the hold and set {step.expected['setpoint_f']}°F",
                        explanation="Clears the energy-saver hold, re-applies your setpoint in one command, then "
                                    "verifies it. Needs your OK because it overrides the energy-saver program.",
                        risk=Risk.SENSITIVE, recommended=True))
                    options.append(RecoveryOption(
                        id="retry", strategy="retry", label="Retry as-is",
                        explanation="Resend the same command. Unlikely to work while the hold is active.",
                        risk=Risk.ROUTINE))
            else:
                cause = (f"The device is reachable and reports {_fmt_state(dtype, state)}; the command appears to "
                         "have been lost before reaching it.")
                self._evidence(run, step, "diagnosis", "read_device_state", cause, diag.data)
                auto_used = sum(1 for r in step.recovery_log if r.get("by") == "policy")
                if remaining > 0 and auto_used < self.settings.auto_retry_limit:
                    step.recovery_log.append({"at": now_iso(), "event": "auto_retry", "strategy": "retry",
                                              "by": "policy",
                                              "reason": "Unexplained loss of an idempotent, already-authorized "
                                                        "command: one automatic retry is allowed."})
                    self._evidence(run, step, "note", "policy",
                                   "Retrying once automatically: same authorized command, fresh idempotency key.")
                    await self._recover(run, step, "retry")
                    return
                if remaining > 0:
                    options.append(RecoveryOption(id="retry", strategy="retry", label="Try again",
                                                  explanation="Resend the same command and verify again.",
                                                  risk=Risk.ROUTINE, recommended=True))
        if remaining <= 0:
            step.error = f"{step.error} Retry budget used ({step.attempts}/{step.max_attempts}). Please check the device."
            step.recovery_log.append({"at": now_iso(), "event": "budget_exhausted", "by": "policy"})
            self._save(run, step)
            return
        leave = "Leave it as it is" if step.status == StepStatus.FAILED else "Leave it unconfirmed"
        options.append(RecoveryOption(id="skip", strategy="skip", label=leave,
                                      explanation="Don't send anything else; the step stays marked as "
                                                  f"{step.status.value.lower()} in your history.",
                                      risk=Risk.READ_ONLY))
        step.recovery_options = options
        step.recovery_log.append({"at": now_iso(), "event": "proposed", "cause": cause,
                                  "options": [o.strategy for o in options]})
        self._save(run, step)
        self.ledger.emit(run.id, "recovery.proposed", {"step_id": step.id, "cause": cause,
                                                       "options": [o.model_dump() for o in options]})
        self.ledger.add_message(run.session_id, "assistant",
                                f"Heads up: “{step.title}” didn't take. {cause} What would you like me to do?",
                                run_id=run.id, meta={"recovery": True, "step_id": step.id})

    async def _recover(self, run: Run, step: Step, strategy: str) -> None:
        dtype = self._device_type(step.params.get("device_id", ""))
        if strategy == "skip":
            step.recovery_log.append({"at": now_iso(), "event": "skipped", "by": "user"})
            self._evidence(run, step, "note", "user", "Left as-is at your request. Nothing else was sent.")
            self._save(run, step)
            return
        self._set(run, step, StepStatus.RECOVERING)
        res = await self._tool(run, step, "retry_failed_action", {"step_id": step.id, "strategy": strategy})
        if not res.ok:
            step.error = f"Recovery not attempted: {res.error}"
            step.recovery_log.append({"at": now_iso(), "event": "recovery_refused", "error": res.error})
            self._set(run, step, StepStatus.FAILED, Assurance.FAILED)
            return
        step.attempts = res.data["attempt"]
        step.recovery_log.append({"at": now_iso(), "event": "issued", "strategy": strategy,
                                  "attempt": step.attempts, "idempotency_key": res.data["idempotency_key"]})
        self._evidence(run, step, "ack", "retry_failed_action",
                       f"Attempt {step.attempts}/{step.max_attempts} acknowledged by the hub (not yet verified).",
                       res.data)
        step.assurance = Assurance.ACCEPTED
        await self._verify_device(run, step, dtype)
        if step.status == StepStatus.VERIFIED:
            step.recovery_log.append({"at": now_iso(), "event": "recovered", "attempt": step.attempts})
            self._evidence(run, step, "note", "engine",
                           f"Recovered on attempt {step.attempts}: verified by an independent state read.")
        else:
            step.recovery_log.append({"at": now_iso(), "event": "recovery_failed", "attempt": step.attempts})
            await self._diagnose_and_recover(run, step, dtype)

    # =========================================================================================
    # REMEMBER (finish + report)
    # =========================================================================================
    def _report(self, run: Run) -> str:
        total = len(run.steps)
        verified = [s for s in run.steps if s.status == StepStatus.VERIFIED]
        failed = [s for s in run.steps if s.status == StepStatus.FAILED]
        unknown = [s for s in run.steps if s.status == StepStatus.UNKNOWN]
        cancelled = [s for s in run.steps if s.status == StepStatus.CANCELLED]
        recovered = [s for s in verified if any(r.get("event") == "recovered" for r in s.recovery_log)]
        parts = [f"{len(verified)} of {total} steps verified."]
        if recovered:
            parts.append("Recovered: " + "; ".join(s.title for s in recovered) + ".")
        if failed:
            parts.append("Not done: " + "; ".join(f"{s.title} ({s.error})" if s.error else s.title
                                                   for s in failed) + ".")
        if unknown:
            parts.append("Couldn't confirm: " + "; ".join(s.title for s in unknown) + ".")
        if cancelled:
            parts.append("Skipped: " + "; ".join(s.title for s in cancelled) + ".")
        return " ".join(parts)

    def _finish(self, run: Run) -> None:
        statuses = [s.status for s in run.steps]
        if all(s == StepStatus.VERIFIED for s in statuses):
            run.status = RunStatus.COMPLETED
        elif not any(s == StepStatus.VERIFIED for s in statuses) and any(
                s in (StepStatus.FAILED, StepStatus.UNKNOWN) for s in statuses):
            run.status = RunStatus.FAILED
        else:
            run.status = RunStatus.COMPLETED_WITH_ISSUES
        run.finished_at = now_iso()
        run.final_report = self._report(run)
        self.ledger.save_run(run)
        self.ledger.emit(run.id, "run.finished", {"status": run.status, "report": run.final_report})
        if run.intent == "query":
            text = " ".join(e.summary for s in run.steps for e in s.evidence if e.kind == "state_read") or \
                run.final_report
        elif run.status == RunStatus.COMPLETED:
            text = f"Done, and verified. {run.final_report}"
        else:
            text = f"Finished, with issues. {run.final_report}"
        self.ledger.add_message(run.session_id, "assistant", text, run_id=run.id,
                                meta={"final": True, "status": run.status})

    def recover_interrupted(self) -> list[str]:
        """On startup: runs left RUNNING by a crash/restart can't be trusted. Mark in-flight steps UNKNOWN.

        PAUSED runs are left alone: their state is fully persisted and they can be resumed after a restart.
        """
        recovered = []
        for run in self.ledger.active_runs():
            if run.status != RunStatus.RUNNING or self._busy(run.id):
                continue
            for s in run.steps:
                if s.status in (StepStatus.RUNNING, StepStatus.VERIFYING, StepStatus.RECOVERING):
                    s.status, s.assurance = StepStatus.UNKNOWN, Assurance.UNKNOWN
                    s.error = "AURA restarted while this step was in flight; its outcome was not verified."
                    s.finished_at = now_iso()
                elif s.status == StepStatus.PENDING:
                    s.status = StepStatus.CANCELLED
                    s.finished_at = now_iso()
            run.status = RunStatus.FAILED if not any(s.status == StepStatus.VERIFIED for s in run.steps) \
                else RunStatus.COMPLETED_WITH_ISSUES
            run.finished_at = now_iso()
            run.final_report = "Interrupted by a restart. " + self._report(run)
            self.ledger.save_run(run)
            self.ledger.emit(run.id, "run.finished", {"status": run.status, "report": run.final_report})
            recovered.append(run.id)
        return recovered

    async def shutdown(self) -> None:
        for task in self._tasks.values():
            if not task.done():
                task.cancel()
