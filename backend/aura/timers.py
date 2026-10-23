"""Local kitchen-style timers, persisted in SQLite so they survive a page reload or a server restart.

A timer only lives inside AURA: nothing in the simulated home changes. Alerts are shown and spoken by an open
browser tab; if no tab is open when a timer ends, the timer records that no alert was delivered.
"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from typing import Any

from .clock import iso, parse_iso, utcnow
from .db import Database, dumps, now_iso

ACTIVE = ("created", "running", "paused")
MAX_DURATION_S = 24 * 3600


class TimerError(Exception):
    pass


def fmt_duration(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    parts = []
    if h:
        parts.append(f"{h} hour{'s' if h != 1 else ''}")
    if m:
        parts.append(f"{m} minute{'s' if m != 1 else ''}")
    if sec or not parts:
        parts.append(f"{sec} second{'s' if sec != 1 else ''}")
    return " ".join(parts)


class TimerStore:
    def __init__(self, db: Database):
        self.db = db

    # ----- reads ---------------------------------------------------------------------------------
    def _row(self, r) -> dict[str, Any]:
        remaining = float(r["remaining_s"])
        if r["status"] == "running" and r["ends_at"]:
            remaining = max(0.0, (parse_iso(r["ends_at"]) - utcnow()).total_seconds())
        return {"timer_id": r["id"], "label": r["label"], "duration_s": r["duration_s"], "status": r["status"],
                "ends_at": r["ends_at"] if r["status"] == "running" else None,
                "remaining_s": round(remaining, 1), "remaining_text": fmt_duration(remaining),
                "delivery": json.loads(r["delivery"] or "{}"), "history": json.loads(r["history"] or "[]"),
                "created_at": r["created_at"], "updated_at": r["updated_at"], "local_only": True}

    def get(self, timer_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM timers WHERE id = ?", (timer_id,))
        return self._row(row) if row else None

    def list(self, include_done: bool = True, limit: int = 20) -> list[dict[str, Any]]:
        sql = "SELECT * FROM timers" + ("" if include_done else f" WHERE status IN {ACTIVE}") + \
              " ORDER BY created_at DESC LIMIT ?"
        return [self._row(r) for r in self.db.query(sql, (limit,))]

    def resolve(self, ref: str | None, statuses: tuple[str, ...] = ACTIVE) -> dict[str, Any]:
        """Find the timer a request refers to: by id, by label, or the only one in a matching state."""
        candidates = [t for t in self.list(limit=50) if t["status"] in statuses]
        if ref:
            exact = [t for t in candidates if t["timer_id"] == ref or t["label"].lower() == ref.lower()]
            loose = exact or [t for t in candidates if ref.lower() in t["label"].lower()]
            if len(loose) == 1:
                return loose[0]
            if not loose:
                raise TimerError(f"There's no {' or '.join(statuses)} timer called “{ref}”.")
            candidates = loose
        if not candidates:
            raise TimerError("There's no " + " or ".join(statuses) + " timer right now.")
        if len(candidates) > 1:
            names = ", ".join(f"{t['label']} ({t['remaining_text']} left)" for t in candidates)
            raise TimerError(f"More than one timer matches: {names}. Which one?")
        return candidates[0]

    # ----- writes --------------------------------------------------------------------------------
    def _update(self, timer_id: str, changes: dict[str, Any], event: str) -> dict[str, Any]:
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM timers WHERE id = ?", (timer_id,)).fetchone()
            if row is None:
                raise TimerError(f"Unknown timer '{timer_id}'.")
            history = json.loads(row["history"] or "[]")
            now = now_iso()
            history.append({"at": now, "summary": event})
            sets = ["history = ?", "updated_at = ?"] + [f"{k} = ?" for k in changes]
            values = [dumps(history[-40:]), now] + [dumps(v) if k == "delivery" else v for k, v in changes.items()]
            conn.execute(f"UPDATE timers SET {', '.join(sets)} WHERE id = ?", (*values, timer_id))
            row = conn.execute("SELECT * FROM timers WHERE id = ?", (timer_id,)).fetchone()
        return self._row(row)

    def create(self, label: str, duration_s: int, start: bool, idempotency_key: str) -> dict[str, Any]:
        label = (label or "").strip()[:40] or "Timer"
        if not isinstance(duration_s, int) or not 1 <= duration_s <= MAX_DURATION_S:
            raise TimerError("Timer length must be between 1 second and 24 hours.")
        with self.db.transaction() as conn:
            prior = conn.execute("SELECT * FROM timers WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if prior is not None:
                return {**self._row(prior), "duplicate": True}
            tid = f"tmr_{uuid.uuid4().hex[:8]}"
            now = utcnow()
            status = "running" if start else "created"
            ends_at = iso(now + timedelta(seconds=duration_s)) if start else None
            history = [{"at": iso(now), "summary": f"Created {fmt_duration(duration_s)} timer"
                                                   + (" and started it." if start else " (not started).")}]
            conn.execute(
                "INSERT INTO timers (id, label, duration_s, status, ends_at, remaining_s, delivery, history,"
                " idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tid, label, duration_s, status, ends_at, float(duration_s), dumps({"status": "NOT_DUE"}),
                 dumps(history), idempotency_key, iso(now), iso(now)))
            row = conn.execute("SELECT * FROM timers WHERE id = ?", (tid,)).fetchone()
        return {**self._row(row), "duplicate": False}

    def start(self, timer_id: str) -> dict[str, Any]:
        t = self.get(timer_id)
        if t is None:
            raise TimerError(f"Unknown timer '{timer_id}'.")
        if t["status"] == "running":
            return t  # idempotent
        if t["status"] not in ("created", "paused"):
            raise TimerError(f"The {t['label']} timer is {t['status']}; it can't be started.")
        ends = iso(utcnow() + timedelta(seconds=t["remaining_s"]))
        verb = "Resumed" if t["status"] == "paused" else "Started"
        return self._update(timer_id, {"status": "running", "ends_at": ends},
                            f"{verb} with {t['remaining_text']} left.")

    def pause(self, timer_id: str) -> dict[str, Any]:
        t = self.get(timer_id)
        if t is None:
            raise TimerError(f"Unknown timer '{timer_id}'.")
        if t["status"] == "paused":
            return t
        if t["status"] != "running":
            raise TimerError(f"The {t['label']} timer is {t['status']}; only a running timer can be paused.")
        return self._update(timer_id, {"status": "paused", "ends_at": None, "remaining_s": t["remaining_s"]},
                            f"Paused with {t['remaining_text']} left.")

    def cancel(self, timer_id: str) -> dict[str, Any]:
        t = self.get(timer_id)
        if t is None:
            raise TimerError(f"Unknown timer '{timer_id}'.")
        if t["status"] == "cancelled":
            return t
        if t["status"] not in ACTIVE:
            raise TimerError(f"The {t['label']} timer already {t['status']}.")
        return self._update(timer_id, {"status": "cancelled", "ends_at": None, "remaining_s": t["remaining_s"]},
                            f"Cancelled with {t['remaining_text']} left.")

    def finish_due(self) -> list[dict[str, Any]]:
        now = iso(utcnow())
        rows = self.db.query("SELECT id FROM timers WHERE status = 'running' AND ends_at <= ?", (now,))
        return [self._update(r["id"], {"status": "finished", "remaining_s": 0.0}, "Time's up.") for r in rows]

    def set_delivery(self, timer_id: str, delivery: dict[str, Any], event: str) -> dict[str, Any]:
        return self._update(timer_id, {"delivery": delivery}, event)
