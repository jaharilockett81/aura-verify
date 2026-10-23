"""Verified Reminders and timer alerts.

Runs inside the API process. Every due reminder and finished timer is tracked through three separate facts:

* delivery: did an open AURA tab actually show (and optionally speak) the alert? A tab must confirm it.
  If no tab is open at the due time, the alert is recorded as NOT_DELIVERED: nothing is pushed anywhere else.
* outcome: was the task done? For tasks AURA can observe (a reminder with a device `check`, e.g. "lock the front
  door"), AURA reads the device through MCP `verify_action` and records VERIFIED / MISMATCH / UNKNOWN. For tasks
  it can't observe ("feed Luna"), the user's "Done" is recorded as USER_CONFIRMED, never as verified.
* recovery: a MISMATCH can be fixed only through a normal AURA plan that the user approves; the reminder is
  re-checked after that run finishes.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from .clock import household_tz, iso, utcnow
from .config import Settings
from .engine import EngineError, WorkflowEngine
from .gateway import MCPToolGateway
from .models import TERMINAL_RUN_STATUSES, PlannedAction
from .services import HouseholdServices

log = logging.getLogger("aura.alerts")


class AlertError(Exception):
    pass


def _expected_text(device: dict[str, Any] | None, expected: dict[str, Any]) -> str:
    name = (device or {}).get("name", "the device")
    if "locked" in expected:
        door = name.removesuffix(" lock").lower()
        return f"the {door} {'locked' if expected['locked'] else 'unlocked'}"
    if "setpoint_f" in expected:
        return f"{name} set to {expected['setpoint_f']}°F"
    if "power" in expected:
        return f"{name} {expected['power']}"
    return f"{name}: " + ", ".join(f"{k} = {v}" for k, v in expected.items())


def _action_title(device: dict[str, Any] | None, expected: dict[str, Any]) -> str:
    name = (device or {}).get("name", "device")
    low = name[0].lower() + name[1:] if name else name
    if "locked" in expected:
        return f"{'Lock' if expected['locked'] else 'Unlock'} the {low.removesuffix(' lock')}"
    if "setpoint_f" in expected:
        return f"Set the {low} to {expected['setpoint_f']}°F"
    if "power" in expected:
        return f"Turn {expected['power']} the {low}"
    return f"Update the {low}"


class AlertWorkflow:
    def __init__(self, settings: Settings, services: HouseholdServices, gateway: MCPToolGateway,
                 engine: WorkflowEngine):
        self.settings = settings
        self.services = services
        self.memory = services.memory
        self.timers = services.timers
        self.ledger = services.ledger
        self.gateway = gateway
        self.engine = engine
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ----- scheduler -------------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="aura-alerts")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep the scheduler alive; the failure is logged
                log.exception("Alert tick failed")
            await asyncio.sleep(1)

    def _device(self, device_id: str) -> dict[str, Any] | None:
        return next((d for d in self.services.sim.list_devices() if d["device_id"] == device_id), None)

    def _delivery_on_due(self, what: str) -> dict[str, Any]:
        tabs = self.ledger.bus.subscriber_count
        now = utcnow()
        local = now.astimezone(household_tz(self.settings.timezone)).strftime("%H:%M")
        if tabs == 0:
            return {"status": "NOT_DELIVERED", "at": iso(now),
                    "detail": f"No AURA tab was open at {local}, so the {what} was not shown or spoken anywhere."}
        return {"status": "PENDING", "at": iso(now), "tabs": tabs,
                "deadline": iso(now + timedelta(seconds=self.settings.delivery_ack_s)),
                "detail": f"Sent to {tabs} open AURA tab{'s' if tabs != 1 else ''}; waiting for one to confirm "
                          "it showed the alert."}

    async def tick(self) -> None:
        async with self._lock:
            now = iso(utcnow())
            for rem in self.memory.reminders_where("status = 'scheduled' AND due_at <= ?", (now,)):
                delivery = self._delivery_on_due("reminder")
                rem = self.memory.update_reminder(rem["reminder_id"], {"status": "due", "delivery": delivery}, {
                    "kind": "due", "source": "scheduler", "summary": "Due now. " + delivery["detail"]})
                self.ledger.emit(None, "reminder.due", rem)
                if rem["check"]:
                    await self._check(rem["reminder_id"], trigger="due")
            for rem in self.memory.reminders_where("status = 'due'"):
                d = rem["delivery"]
                if d.get("status") == "PENDING" and d.get("deadline") and d["deadline"] <= now:
                    self._expire_delivery("reminder", rem["reminder_id"], d)
            for rem in self.memory.reminders_where("outcome = 'RECOVERING'"):
                fix = next((h for h in reversed(rem["history"]) if h.get("kind") == "fix_planned"), None)
                run = self.ledger.get_run(fix["run_id"]) if fix else None
                if run is None or run.status in TERMINAL_RUN_STATUSES:
                    await self._check(rem["reminder_id"], trigger="after_fix", run_status=run.status if run else None)
            for timer in self.timers.finish_due():
                delivery = self._delivery_on_due("timer alert")
                timer = self.timers.set_delivery(timer["timer_id"], delivery, delivery["detail"])
                self.ledger.emit(None, "timer.finished", timer)
            for timer in self.timers.list(limit=50):
                d = timer["delivery"]
                if timer["status"] == "finished" and d.get("status") == "PENDING" and d.get("deadline", now) <= now:
                    self._expire_delivery("timer", timer["timer_id"], d)

    def _expire_delivery(self, kind: str, ident: str, d: dict[str, Any]) -> None:
        delivery = {**d, "status": "UNCONFIRMED",
                    "detail": f"{d.get('tabs', 'An')} AURA tab(s) were open, but none confirmed showing the alert "
                              f"within {self.settings.delivery_ack_s:.0f}s. It may not have been seen."}
        if kind == "reminder":
            rem = self.memory.update_reminder(ident, {"delivery": delivery}, {
                "kind": "delivery", "source": "scheduler", "summary": delivery["detail"]})
            self.ledger.emit(None, "reminder.updated", rem)
        else:
            timer = self.timers.set_delivery(ident, delivery, delivery["detail"])
            self.ledger.emit(None, "timer.updated", timer)

    # ----- verification ----------------------------------------------------------------------------
    async def _check(self, reminder_id: str, trigger: str, run_status: str | None = None) -> dict[str, Any]:
        rem = self.memory.get_reminder(reminder_id)
        if rem is None or not rem["check"]:
            raise AlertError("This reminder has no device check.")
        chk = rem["check"]
        device = self._device(chk["device_id"])
        res = await self.gateway.call("verify_action", {"target": f"device:{chk['device_id']}",
                                                         "expected": chk["expected"]})
        want = _expected_text(device, chk["expected"])
        if res.ok and res.data["verdict"] == "VERIFIED":
            outcome, status = "VERIFIED", "closed"
            summary = f"Independent read (MCP verify_action) confirms {want}."
            if trigger == "after_fix":
                summary = f"After the approved fix, an independent read confirms {want}."
        elif res.ok and res.data["verdict"] == "MISMATCH":
            outcome, status = "MISMATCH", "due"
            seen = ", ".join(f"{m['field']} = {m['observed']}" for m in res.data["mismatches"])
            summary = f"Independent read (MCP verify_action) shows {seen}; expected {want}."
            if trigger == "done":
                summary = f"You marked this done, but an independent read shows {seen} (expected {want})."
            if trigger == "after_fix":
                summary = (f"The fix run ended {str(run_status or 'without a result').lower().replace('_', ' ')}, "
                           f"and an independent read still shows {seen} (expected {want}).")
        else:
            outcome, status = "UNKNOWN", "due"
            reason = res.data.get("reason") if res.ok else res.error
            summary = f"Couldn't check {want}: {reason}"
        rem = self.memory.update_reminder(reminder_id, {"outcome": outcome, "status": status}, {
            "kind": "verification", "source": "verify_action", "verdict": outcome, "summary": summary,
            "data": res.data if res.ok else {"error": res.error}})
        self.ledger.emit(None, "reminder.updated", rem)
        return rem

    # ----- user actions ------------------------------------------------------------------------------
    def _get(self, reminder_id: str) -> dict[str, Any]:
        rem = self.memory.get_reminder(reminder_id)
        if rem is None:
            raise AlertError("Reminder not found.")
        return rem

    def delivered(self, reminder_id: str, spoken: bool) -> dict[str, Any]:
        rem = self._get(reminder_id)
        if rem["status"] not in ("due", "closed") or rem["delivery"].get("status") not in ("PENDING", "UNCONFIRMED"):
            return rem  # only an alert that is actually out for delivery can be confirmed
        delivery = {"status": "DELIVERED_IN_APP", "at": iso(utcnow()), "spoken": spoken,
                    "detail": "Shown in an open AURA tab" + (" and spoken aloud." if spoken else " (not spoken).")}
        rem = self.memory.update_reminder(reminder_id, {"delivery": delivery}, {
            "kind": "delivery", "source": "browser", "summary": delivery["detail"]})
        self.ledger.emit(None, "reminder.updated", rem)
        return rem

    async def done(self, reminder_id: str) -> dict[str, Any]:
        rem = self._get(reminder_id)
        if rem["status"] == "closed":
            return rem
        if rem["check"]:
            self.memory.update_reminder(reminder_id, {}, {
                "kind": "user", "source": "user", "summary": "You marked it done. Checking independently…"})
            return await self._check(reminder_id, trigger="done")
        rem = self.memory.update_reminder(reminder_id, {"status": "closed", "outcome": "USER_CONFIRMED"}, {
            "kind": "user", "source": "user",
            "summary": "You confirmed it's done. AURA can't observe this task, so it's recorded as confirmed by you, "
                       "not verified."})
        self.ledger.emit(None, "reminder.updated", rem)
        return rem

    def snooze(self, reminder_id: str, minutes: int) -> dict[str, Any]:
        if not 1 <= minutes <= 24 * 60:
            raise AlertError("Snooze between 1 minute and 24 hours.")
        rem = self._get(reminder_id)
        if rem["status"] == "closed":
            raise AlertError("This reminder is already closed.")
        due_at = utcnow() + timedelta(minutes=minutes)
        local = due_at.astimezone(household_tz(self.settings.timezone)).strftime("%H:%M")
        rem = self.memory.update_reminder(reminder_id, {
            "status": "scheduled", "due_at": iso(due_at), "due": local, "outcome": "OPEN",
            "delivery": {"status": "NOT_DUE"}}, {
            "kind": "user", "source": "user", "summary": f"Snoozed for {minutes} minutes, until {local}."})
        self.ledger.emit(None, "reminder.updated", rem)
        return rem

    def dismiss(self, reminder_id: str) -> dict[str, Any]:
        rem = self._get(reminder_id)
        rem = self.memory.update_reminder(reminder_id, {"status": "closed", "outcome": "DISMISSED"}, {
            "kind": "user", "source": "user", "summary": "Dismissed. Not recorded as done."})
        self.ledger.emit(None, "reminder.updated", rem)
        return rem

    async def fix(self, reminder_id: str, session_id: str) -> dict[str, Any]:
        """Propose (not perform) the device action that would satisfy the reminder. The user must approve."""
        rem = self._get(reminder_id)
        if not rem["check"]:
            raise AlertError("AURA can't do this task for you; it has no device to act on.")
        if rem["outcome"] not in ("MISMATCH", "UNKNOWN"):
            raise AlertError("There's nothing to fix: the check didn't fail.")
        chk = rem["check"]
        device = self._device(chk["device_id"])
        title = _action_title(device, chk["expected"])
        action = PlannedAction(action="set_device", device_id=chk["device_id"], attributes=chk["expected"],
                               title=title, rationale=f"Your reminder “{rem['title']}” wasn't satisfied.",
                               provenance=f"From reminder “{rem['title']}” ({rem['reminder_id']})")
        try:
            run = await self.engine.create_run_from_actions(
                session_id, f"Fix reminder: {rem['title']}", f"Fix reminder: {rem['title']}", [action],
                f"Here's a plan to {title[0].lower() + title[1:]}. Nothing happens until you approve it.")
        except EngineError as exc:
            raise AlertError(str(exc)) from exc
        rem = self.memory.update_reminder(reminder_id, {"outcome": "RECOVERING"}, {
            "kind": "fix_planned", "source": "aura", "run_id": run.id,
            "summary": f"Planned “{title}” as run {run.id}. It needs your approval; the reminder is re-checked when "
                       "the run finishes."})
        self.ledger.emit(None, "reminder.updated", rem)
        return {"reminder": rem, "run": run.model_dump(mode="json")}

    async def fire_now(self, reminder_id: str) -> dict[str, Any]:
        """Demo control: make a reminder due immediately (labeled as a demo action in its history)."""
        rem = self._get(reminder_id)
        if rem["status"] not in ("scheduled", "unscheduled"):
            raise AlertError("Only a reminder that isn't due yet can be fired.")
        rem = self.memory.update_reminder(reminder_id, {"status": "scheduled", "due_at": iso(utcnow()),
                                                        "delivery": {"status": "NOT_DUE"}}, {
            "kind": "demo", "source": "demo controls", "summary": "Demo control: due time moved to now."})
        await self.tick()
        return self._get(reminder_id)

    # ----- timers ------------------------------------------------------------------------------------
    def timer_delivered(self, timer_id: str, spoken: bool) -> dict[str, Any]:
        timer = self.timers.get(timer_id)
        if timer is None:
            raise AlertError("Timer not found.")
        if timer["status"] != "finished" or timer["delivery"].get("status") not in ("PENDING", "UNCONFIRMED"):
            return timer
        delivery = {"status": "DELIVERED_IN_APP", "at": iso(utcnow()), "spoken": spoken,
                    "detail": "Alert shown in an open AURA tab" + (" and spoken aloud." if spoken else " (not spoken).")}
        timer = self.timers.set_delivery(timer_id, delivery, delivery["detail"])
        self.ledger.emit(None, "timer.updated", timer)
        return timer

    async def timer_op(self, timer_id: str, op: str) -> dict[str, Any]:
        """Timer buttons in the UI go through the same MCP tool and read-back as spoken requests."""
        if op not in ("start", "pause", "resume", "cancel"):
            raise AlertError("Unknown timer operation.")
        key = f"ui:{timer_id}:{op}:{iso(utcnow())}"
        res = await self.gateway.call("manage_timer", {"op": op, "timer_id": timer_id, "idempotency_key": key})
        if not res.ok:
            raise AlertError(res.error or "Timer service error.")
        want = {"start": "running", "resume": "running", "pause": "paused", "cancel": "cancelled"}[op]
        ver = await self.gateway.call("verify_action", {"target": f"timer:{timer_id}", "expected": {"status": want}})
        verdict = ver.data["verdict"] if ver.ok else "UNKNOWN"
        timer = self.timers.get(timer_id)
        self.ledger.emit(None, "timer.updated", timer)
        return {"timer": timer, "verdict": verdict}

