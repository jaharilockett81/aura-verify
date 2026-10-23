"""Household services: the capability layer exposed through MCP.

This module is transport-agnostic. `mcp_server.py` wraps these methods as MCP tools; tests can call them
directly. The workflow engine never calls this module directly: it goes through a ToolGateway (MCP).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from .clock import iso, utcnow
from .config import Settings
from .db import Database, now_iso
from .ledger import Ledger
from .memory import Memory, MemoryError
from .models import StepStatus
from .simulator import DeviceError, DeviceUnreachable, SmartHomeSimulator
from .timers import TimerError, TimerStore

SIMULATION_NOTICE = (
    "AURA Verify household simulator. Devices, reminders and notifications are simulated; "
    "no real device is controlled and no message is sent."
)


class ServiceError(Exception):
    """A deliberate, user-explainable failure (bad input, policy refusal)."""


class HouseholdServices:
    def __init__(self, settings: Settings, db: Database | None = None, ledger: Ledger | None = None):
        self.settings = settings
        self.db = db or Database(settings.db_path)
        self.sim = SmartHomeSimulator(self.db, settle_ms=settings.sim_settle_ms)
        self.memory = Memory(self.db, settings.timezone)
        self.timers = TimerStore(self.db)
        self.ledger = ledger or Ledger(self.db)

    def seed(self) -> None:
        self.sim.seed()
        self.memory.seed()

    # ----- context -----------------------------------------------------------------------------
    def household_context(self) -> dict[str, Any]:
        prefs = self.memory.preferences()
        return {
            "user_name": next((p["value"] for p in prefs if p["key"] == "user_name"), None),
            "preferences": prefs,
            "routines": [{"id": r["id"], "name": r["name"], "description": r["description"],
                          "triggers": r["triggers"]} for r in self.memory.routines()],
            "devices": self.sim.list_devices(),
            "reminders": [{k: r[k] for k in ("reminder_id", "title", "due", "status", "outcome", "check")}
                          for r in self.memory.reminders()[:10]],
            "timers": [{k: t[k] for k in ("timer_id", "label", "status", "remaining_s", "remaining_text")}
                       for t in self.timers.list(include_done=False)],
            "open_issues": self.open_issues(),
            "notice": SIMULATION_NOTICE,
        }

    def open_issues(self) -> list[dict[str, Any]]:
        """Steps from recent runs that ended FAILED or UNKNOWN: remembered so AURA can follow up."""
        issues = []
        for run in self.ledger.list_runs(limit=15):
            for s in run.steps:
                if s.status in (StepStatus.FAILED, StepStatus.UNKNOWN):
                    issues.append({"run_id": run.id, "step_id": s.id, "title": s.title, "status": s.status,
                                   "error": s.error, "at": s.updated_at})
        return issues[:5]

    # ----- devices -----------------------------------------------------------------------------
    def list_devices(self) -> list[dict[str, Any]]:
        return self.sim.list_devices()

    def read_device_state(self, device_id: str) -> dict[str, Any]:
        try:
            return self.sim.read_state(device_id)
        except DeviceError as exc:
            raise ServiceError(str(exc)) from exc
        except DeviceUnreachable as exc:
            raise ServiceError(f"UNREACHABLE: {exc}") from exc

    def set_device_state(self, device_id: str, attributes: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        try:
            ack = self.sim.set_state(device_id, attributes, idempotency_key)
        except DeviceError as exc:
            raise ServiceError(str(exc)) from exc
        return {**ack, "verification": "NOT_VERIFIED: an acknowledgement is not proof. Call verify_action."}

    # ----- verification ------------------------------------------------------------------------
    def verify_action(self, target: str, expected: dict[str, Any]) -> dict[str, Any]:
        """Compare an independent read of `target` against `expected`.

        verdict: VERIFIED (all expected fields observed), MISMATCH (state readable, differs),
        UNKNOWN (state could not be observed).
        """
        kind, _, ident = target.partition(":")
        checked_at = now_iso()
        if not expected:
            raise ServiceError("verify_action needs at least one expected field.")
        if kind == "device":
            try:
                reading = self.sim.read_state(ident)
            except DeviceError as exc:
                raise ServiceError(str(exc)) from exc
            except DeviceUnreachable as exc:
                return {"target": target, "verdict": "UNKNOWN", "expected": expected, "observed": None,
                        "mismatches": [], "method": "read_device_state (independent state channel)",
                        "reason": str(exc), "checked_at": checked_at}
            observed = reading["state"]
            method = "read_device_state (independent state channel, not the command ack)"
            extra = {"last_changed_at": reading["last_changed_at"]}
        elif kind == "reminder":
            rem = self.memory.get_reminder(ident)
            if rem is None:
                return {"target": target, "verdict": "MISMATCH", "expected": expected, "observed": None,
                        "mismatches": [{"field": "exists", "expected": True, "observed": False}],
                        "method": "reminder store lookup", "checked_at": checked_at}
            observed = rem
            method = "reminder store lookup by id"
            extra = {}
        elif kind == "timer":
            timer = self.timers.get(ident)
            if timer is None:
                return {"target": target, "verdict": "MISMATCH", "expected": expected, "observed": None,
                        "mismatches": [{"field": "exists", "expected": True, "observed": False}],
                        "method": "timer store lookup", "checked_at": checked_at}
            observed = timer
            method = "timer store lookup by id"
            extra = {}
        elif kind == "preference":
            pref = self.memory.get_preference(ident)
            if pref is None:
                raise ServiceError(f"Unknown preference '{ident}'.")
            observed = {"value": pref["value"], "updated_at": pref["updated_at"]}
            method = "read-back from preference store"
            extra = {}
        else:
            raise ServiceError("target must look like device:<id>, reminder:<id>, timer:<id> or preference:<key>.")

        mismatches = [
            {"field": k, "expected": v, "observed": observed.get(k)}
            for k, v in expected.items()
            if observed.get(k) != v
        ]
        return {"target": target, "verdict": "VERIFIED" if not mismatches else "MISMATCH", "expected": expected,
                "observed": observed, "mismatches": mismatches, "method": method, "checked_at": checked_at,
                **extra}

    # ----- recovery ----------------------------------------------------------------------------
    def command_attempts(self, step_key: str) -> int:
        row = self.db.query_one(
            "SELECT COUNT(*) AS n FROM device_commands WHERE idempotency_key = ? OR idempotency_key LIKE ?",
            (step_key, step_key + ":retry%"),
        )
        return int(row["n"]) if row else 0

    def retry_failed_action(self, step_id: str, strategy: str) -> dict[str, Any]:
        """Re-issue a failed device step under a bounded attempt budget, with a fresh idempotency key."""
        step = self.ledger.get_step(step_id)
        if step is None:
            raise ServiceError(f"Unknown step '{step_id}'.")
        if step.action != "set_device":
            raise ServiceError("Only device steps can be retried.")
        if step.status not in (StepStatus.FAILED, StepStatus.UNKNOWN, StepStatus.RECOVERING):
            raise ServiceError(f"Step is {step.status}; only FAILED or UNKNOWN steps can be retried.")
        used = self.command_attempts(step.idempotency_key)
        if used >= step.max_attempts:
            raise ServiceError(f"Retry budget exhausted ({used}/{step.max_attempts} attempts). Not retrying.")
        device_id = step.params["device_id"]
        attributes = dict(step.params["attributes"])
        if strategy == "release_hold_and_reapply":
            if self.sim.device_type(device_id) != "thermostat":
                raise ServiceError("release_hold_and_reapply only applies to the thermostat.")
            attributes = {"hold": "none", **attributes}
        elif strategy != "retry":
            raise ServiceError("strategy must be 'retry' or 'release_hold_and_reapply'.")
        key = f"{step.idempotency_key}:retry{used}"
        ack = self.set_device_state(device_id, attributes, key)
        if step.run_id:
            self.ledger.emit(step.run_id, "mcp.retry_issued",
                             {"step_id": step_id, "strategy": strategy, "attempt": used + 1, "idempotency_key": key})
        return {**ack, "attempt": used + 1, "max_attempts": step.max_attempts, "strategy": strategy,
                "sent_attributes": attributes, "idempotency_key": key}

    # ----- memory ------------------------------------------------------------------------------
    def get_routine(self, routine_id: str) -> dict[str, Any]:
        routine = self.memory.get_routine(routine_id)
        if routine is None:
            raise ServiceError(f"Unknown routine '{routine_id}'. Known: {[r['id'] for r in self.memory.routines()]}")
        try:
            resolved = [a.model_dump() for a in self.memory.resolve_routine(routine)]
        except MemoryError as exc:
            raise ServiceError(str(exc)) from exc
        return {**routine, "resolved_actions": resolved}

    def save_routine(self, routine: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.memory.save_routine(routine, self.sim.device_ids())
        except MemoryError as exc:
            raise ServiceError(str(exc)) from exc

    def update_preference(self, key: str, value: Any) -> dict[str, Any]:
        try:
            return self.memory.set_preference(key, value, source="assistant")
        except MemoryError as exc:
            raise ServiceError(str(exc)) from exc

    def create_reminder(self, title: str, due: str | None, note: str | None, category: str,
                        idempotency_key: str, due_in_minutes: float | None = None,
                        check: dict[str, Any] | None = None) -> dict[str, Any]:
        due_at = None
        if due_in_minutes is not None:
            if not 0 < float(due_in_minutes) <= 7 * 24 * 60:
                raise ServiceError("due_in_minutes must be between 0 and one week.")
            due_at = iso(utcnow() + timedelta(minutes=float(due_in_minutes)))
            due = None
        if check is not None:
            device_id = check.get("device_id")
            if device_id not in self.sim.device_ids():
                raise ServiceError(f"Unknown device '{device_id}' in reminder check.")
        try:
            rem = self.memory.create_reminder(title, due, note, category or "general", idempotency_key,
                                              due_at=due_at, check=check)
        except MemoryError as exc:
            raise ServiceError(str(exc)) from exc
        return {**rem, "delivery_note": "Alerts are shown and spoken only by an open AURA browser tab. Nothing is "
                                        "pushed to a phone; if no tab is open at the due time, AURA records that "
                                        "the alert was not delivered."}

    def list_reminders(self) -> list[dict[str, Any]]:
        return self.memory.reminders()

    # ----- timers ------------------------------------------------------------------------------
    def manage_timer(self, op: str, idempotency_key: str, timer_id: str | None = None, label: str | None = None,
                     duration_s: int | None = None) -> dict[str, Any]:
        try:
            if op == "create" or op == "create_and_start":
                if duration_s is None:
                    raise ServiceError("duration_s is required to create a timer.")
                return self.timers.create(label or "Timer", int(duration_s), op == "create_and_start",
                                          idempotency_key)
            statuses = {"start": ("created",), "resume": ("paused",), "pause": ("running",),
                        "cancel": ("created", "running", "paused")}.get(op)
            if statuses is None:
                raise ServiceError("op must be create, create_and_start, start, pause, resume or cancel.")
            timer = self.timers.resolve(timer_id or label, statuses)
            if op in ("start", "resume"):
                return self.timers.start(timer["timer_id"])
            if op == "pause":
                return self.timers.pause(timer["timer_id"])
            return self.timers.cancel(timer["timer_id"])
        except TimerError as exc:
            raise ServiceError(str(exc)) from exc

    def list_timers(self, include_done: bool = False) -> list[dict[str, Any]]:
        return self.timers.list(include_done=include_done)

    # ----- execution ledger --------------------------------------------------------------------
    def execution_status(self, run_id: str) -> dict[str, Any]:
        run = self.ledger.get_run(run_id)
        if run is None:
            raise ServiceError(f"Unknown run '{run_id}'.")
        return {
            "run_id": run.id, "status": run.status, "utterance": run.utterance, "summary": run.summary,
            "final_report": run.final_report,
            "steps": [{"step_id": s.id, "title": s.title, "status": s.status, "assurance": s.assurance,
                       "attempts": s.attempts, "error": s.error,
                       "evidence": [e.summary for e in s.evidence]} for s in run.steps],
        }

    def execution_history(self, limit: int = 10) -> list[dict[str, Any]]:
        out = []
        for run in self.ledger.list_runs(limit=max(1, min(limit, 50))):
            counts: dict[str, int] = {}
            for s in run.steps:
                counts[s.status] = counts.get(s.status, 0) + 1
            out.append({"run_id": run.id, "utterance": run.utterance, "status": run.status,
                        "created_at": run.created_at, "step_counts": counts, "final_report": run.final_report})
        return out
