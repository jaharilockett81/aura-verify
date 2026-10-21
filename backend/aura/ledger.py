"""Execution ledger: runs, steps, events and conversation messages.

Every state transition is written here before it is broadcast, so the history the user inspects is the
same record the engine acted on.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from .db import Database, dumps, now_iso
from .models import Run, Step


class EventBus:
    """In-process fan-out of ledger events to SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


class Ledger:
    def __init__(self, db: Database, bus: EventBus | None = None):
        self.db = db
        self.bus = bus or EventBus()

    # ----- runs & steps ------------------------------------------------------------------------
    def save_run(self, run: Run) -> None:
        run.updated_at = now_iso()
        data = run.model_dump(mode="json", exclude={"steps"})
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO runs (id, session_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data,"
                " updated_at=excluded.updated_at",
                (run.id, run.session_id, run.status, dumps(data), run.created_at, run.updated_at),
            )
            for step in run.steps:
                self._save_step(conn, step)

    def save_step(self, step: Step) -> None:
        with self.db.transaction() as conn:
            self._save_step(conn, step)

    @staticmethod
    def _save_step(conn, step: Step) -> None:
        step.updated_at = now_iso()
        conn.execute(
            "INSERT INTO steps (id, run_id, idx, status, data) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data",
            (step.id, step.run_id, step.index, step.status, dumps(step.model_dump(mode="json"))),
        )

    def get_run(self, run_id: str) -> Run | None:
        row = self.db.query_one("SELECT data FROM runs WHERE id = ?", (run_id,))
        if row is None:
            return None
        run = Run.model_validate(json.loads(row["data"]))
        run.steps = self.get_steps(run_id)
        return run

    def get_steps(self, run_id: str) -> list[Step]:
        rows = self.db.query("SELECT data FROM steps WHERE run_id = ? ORDER BY idx", (run_id,))
        return [Step.model_validate(json.loads(r["data"])) for r in rows]

    def get_step(self, step_id: str) -> Step | None:
        row = self.db.query_one("SELECT data FROM steps WHERE id = ?", (step_id,))
        return Step.model_validate(json.loads(row["data"])) if row else None

    def list_runs(self, limit: int = 50, status: str | None = None) -> list[Run]:
        if status:
            rows = self.db.query("SELECT id FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                                 (status, limit))
        else:
            rows = self.db.query("SELECT id FROM runs ORDER BY created_at DESC LIMIT ?", (limit,))
        return [r for r in (self.get_run(row["id"]) for row in rows) if r is not None]

    def active_runs(self) -> list[Run]:
        rows = self.db.query("SELECT id FROM runs WHERE status IN ('RUNNING', 'PAUSED') ORDER BY created_at")
        return [r for r in (self.get_run(row["id"]) for row in rows) if r is not None]

    # ----- events ------------------------------------------------------------------------------
    def emit(self, run_id: str | None, type_: str, data: dict[str, Any]) -> dict[str, Any]:
        at = now_iso()
        with self.db.transaction() as conn:
            cur = conn.execute("INSERT INTO events (run_id, type, data, at) VALUES (?, ?, ?, ?)",
                               (run_id, type_, dumps(data), at))
            seq = cur.lastrowid
        event = {"seq": seq, "run_id": run_id, "type": type_, "data": data, "at": at}
        self.bus.publish(event)
        return event

    def events(self, run_id: str, after: int = 0) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq", (run_id, after))
        return [{"seq": r["seq"], "run_id": r["run_id"], "type": r["type"], "data": json.loads(r["data"]),
                 "at": r["at"]} for r in rows]

    def recent_events(self, limit: int = 30, types: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        if types:
            marks = ",".join("?" for _ in types)
            rows = self.db.query(f"SELECT * FROM events WHERE type IN ({marks}) ORDER BY seq DESC LIMIT ?",
                                 (*types, limit))
        else:
            rows = self.db.query("SELECT * FROM events ORDER BY seq DESC LIMIT ?", (limit,))
        return [{"seq": r["seq"], "run_id": r["run_id"], "type": r["type"], "data": json.loads(r["data"]),
                 "at": r["at"]} for r in rows]

    # ----- sessions & messages -----------------------------------------------------------------
    def new_session(self) -> str:
        sid = f"ses_{uuid.uuid4().hex[:12]}"
        with self.db.transaction() as conn:
            conn.execute("INSERT INTO sessions (id, pending, created_at) VALUES (?, NULL, ?)", (sid, now_iso()))
        return sid

    def ensure_session(self, session_id: str | None) -> str:
        if session_id and self.db.query_one("SELECT id FROM sessions WHERE id = ?", (session_id,)):
            return session_id
        return self.new_session()

    def session_pending(self, session_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT pending FROM sessions WHERE id = ?", (session_id,))
        return json.loads(row["pending"]) if row and row["pending"] else None

    def set_session_pending(self, session_id: str, pending: dict[str, Any] | None) -> None:
        with self.db.transaction() as conn:
            conn.execute("UPDATE sessions SET pending = ? WHERE id = ?",
                         (dumps(pending) if pending else None, session_id))

    def add_message(self, session_id: str, role: str, text: str, run_id: str | None = None,
                    meta: dict[str, Any] | None = None) -> dict[str, Any]:
        at = now_iso()
        with self.db.transaction() as conn:
            cur = conn.execute(
                "INSERT INTO messages (session_id, role, text, run_id, meta, at) VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, role, text, run_id, dumps(meta or {}), at),
            )
        msg = {"id": cur.lastrowid, "session_id": session_id, "role": role, "text": text, "run_id": run_id,
               "meta": meta or {}, "at": at}
        self.bus.publish({"seq": None, "run_id": run_id, "type": "message", "data": msg, "at": at})
        return msg

    def messages(self, session_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY id", (session_id,))
        return [{"id": r["id"], "session_id": r["session_id"], "role": r["role"], "text": r["text"],
                 "run_id": r["run_id"], "meta": json.loads(r["meta"]), "at": r["at"]} for r in rows]
