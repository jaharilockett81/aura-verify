"""Household memory: preferences, routines and reminders, persisted in SQLite.

Routines are stored as templates. Values like "{pref:bedtime_temperature_f}" are resolved against the
*current* preferences at planning time, which is what makes Scenario 3 (memory across sessions) real.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .clock import household_tz, iso, local_hhmm, next_occurrence, parse_iso
from .db import Database, dumps, now_iso
from .models import PlannedAction


class MemoryError(Exception):
    pass


SEED_PREFERENCES: list[dict[str, Any]] = [
    {"key": "user_name", "value": "Jahari", "label": "What AURA calls you", "category": "Profile", "unit": None},
    {"key": "overnight_shift_start", "value": "22:30", "label": "Overnight shift starts", "category": "Schedule",
     "unit": "time"},
    {"key": "overnight_shift_end", "value": "07:00", "label": "Overnight shift ends", "category": "Schedule",
     "unit": "time"},
    {"key": "away_temperature_f", "value": 72, "label": "Temperature while you're at work", "category": "Comfort",
     "unit": "°F"},
    {"key": "bedtime_temperature_f", "value": 68, "label": "Bedtime temperature", "category": "Comfort",
     "unit": "°F"},
    {"key": "bedtime_light_level", "value": 20, "label": "Bedtime lamp brightness", "category": "Comfort",
     "unit": "%"},
    {"key": "pet_name", "value": "Luna", "label": "Pet's name", "category": "Pet care", "unit": None},
    {"key": "pet_feeding_time", "value": "21:30", "label": "Pet dinner time", "category": "Pet care",
     "unit": "time"},
    {"key": "quiet_hours", "value": "22:00-07:00", "label": "Quiet hours", "category": "Schedule", "unit": None},
]

PREF_NUMERIC_BOUNDS = {
    "away_temperature_f": (60, 80),
    "bedtime_temperature_f": (60, 80),
    "bedtime_light_level": (0, 100),
}
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SEED_ROUTINES: list[dict[str, Any]] = [
    {
        "id": "overnight_shift",
        "name": "Overnight shift",
        "description": "Get the home ready while you're at work overnight, with Luna looked after.",
        "triggers": ["overnight", "shift", "work routine", "night shift", "before my shift", "heading to work"],
        "steps": [
            {"action": "set_device", "device_id": "living_room_lights", "attributes": {"power": "off"},
             "title": "Turn off the living room lights",
             "rationale": "Nobody will be in the living room during your shift."},
            {"action": "set_device", "device_id": "porch_light", "attributes": {"power": "on"},
             "title": "Turn on the porch light", "rationale": "So you come home to a lit entry in the morning."},
            {"action": "set_device", "device_id": "thermostat",
             "attributes": {"setpoint_f": "{pref:away_temperature_f}"},
             "title": "Set the thermostat to {pref:away_temperature_f}°F",
             "rationale": "Keeps {pref:pet_name} comfortable while you're out (your saved away temperature)."},
            {"action": "create_reminder",
             "reminder": {"title": "Feed {pref:pet_name}", "due": "{pref:pet_feeding_time}",
                          "note": "Dinner while you're on shift. Simulated reminder: no real notification is sent.",
                          "category": "pet_care"},
             "title": "Schedule {pref:pet_name}'s dinner reminder ({pref:pet_feeding_time})",
             "rationale": "Pet-care reminder so dinner isn't missed on shift nights."},
            {"action": "set_device", "device_id": "front_door", "attributes": {"locked": True},
             "title": "Lock the front door", "rationale": "The apartment will be empty overnight."},
        ],
    },
    {
        "id": "bedtime",
        "name": "Bedtime",
        "description": "Wind the home down for sleep using your saved comfort settings.",
        "triggers": ["bedtime", "bed", "sleep", "going to bed", "goodnight", "good night", "wind down"],
        "steps": [
            {"action": "set_device", "device_id": "bedroom_lights",
             "attributes": {"power": "on", "brightness": "{pref:bedtime_light_level}"},
             "title": "Dim the bedroom lights to {pref:bedtime_light_level}%",
             "rationale": "Soft light to wind down (your saved bedtime brightness)."},
            {"action": "set_device", "device_id": "living_room_lights", "attributes": {"power": "off"},
             "title": "Turn off the living room lights", "rationale": "Nobody needs them overnight."},
            {"action": "set_device", "device_id": "thermostat",
             "attributes": {"setpoint_f": "{pref:bedtime_temperature_f}"},
             "title": "Set the thermostat to {pref:bedtime_temperature_f}°F",
             "rationale": "Your saved bedtime temperature."},
            {"action": "set_device", "device_id": "white_noise", "attributes": {"power": "on"},
             "title": "Turn on the white-noise machine", "rationale": "Part of your bedtime routine."},
            {"action": "set_device", "device_id": "front_door", "attributes": {"locked": True},
             "title": "Lock the front door", "rationale": "Secure the home for the night."},
        ],
    },
    {
        "id": "leaving_home",
        "name": "Leaving home",
        "description": "Make sure the apartment is ready before you leave.",
        "triggers": ["leave", "leaving", "ready before i leave", "apartment ready", "heading out", "going out"],
        "steps": [
            {"action": "set_device", "device_id": "living_room_lights", "attributes": {"power": "off"},
             "title": "Turn off the living room lights", "rationale": "Nobody is home."},
            {"action": "set_device", "device_id": "bedroom_lights", "attributes": {"power": "off"},
             "title": "Turn off the bedroom lights", "rationale": "Nobody is home."},
            {"action": "set_device", "device_id": "white_noise", "attributes": {"power": "off"},
             "title": "Turn off the white-noise machine", "rationale": "Saves power while you're out."},
            {"action": "set_device", "device_id": "thermostat",
             "attributes": {"setpoint_f": "{pref:away_temperature_f}"},
             "title": "Set the thermostat to {pref:away_temperature_f}°F",
             "rationale": "Your saved away temperature keeps {pref:pet_name} comfortable."},
            {"action": "set_device", "device_id": "front_door", "attributes": {"locked": True},
             "title": "Lock the front door", "rationale": "The apartment will be empty."},
        ],
    },
]

_PREF_TOKEN = re.compile(r"\{pref:([a-z_]+)\}")


class Memory:
    def __init__(self, db: Database, timezone: str = ""):
        self.db = db
        self.timezone = timezone

    # ----- seed --------------------------------------------------------------------------------
    def seed(self, force: bool = False) -> None:
        with self.db.transaction() as conn:
            if force:
                conn.execute("DELETE FROM preferences")
                conn.execute("DELETE FROM routines")
                conn.execute("DELETE FROM reminders")
            for p in SEED_PREFERENCES:
                conn.execute(
                    "INSERT OR IGNORE INTO preferences (key, value, label, category, unit, updated_at, source)"
                    " VALUES (?, ?, ?, ?, ?, ?, 'seed')",
                    (p["key"], dumps(p["value"]), p["label"], p["category"], p["unit"], now_iso()),
                )
            for r in SEED_ROUTINES:
                conn.execute(
                    "INSERT OR IGNORE INTO routines (id, name, description, triggers, steps, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (r["id"], r["name"], r["description"], dumps(r["triggers"]), dumps(r["steps"]), now_iso()),
                )

    # ----- preferences -------------------------------------------------------------------------
    def preferences(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM preferences ORDER BY category, label")
        return [
            {"key": r["key"], "value": json.loads(r["value"]), "label": r["label"], "category": r["category"],
             "unit": r["unit"], "updated_at": r["updated_at"], "source": r["source"]}
            for r in rows
        ]

    def preference_map(self) -> dict[str, Any]:
        return {p["key"]: p["value"] for p in self.preferences()}

    def get_preference(self, key: str) -> dict[str, Any] | None:
        return next((p for p in self.preferences() if p["key"] == key), None)

    def validate_preference(self, key: str, value: Any) -> Any:
        if key in PREF_NUMERIC_BOUNDS:
            lo, hi = PREF_NUMERIC_BOUNDS[key]
            if isinstance(value, str) and value.strip().lstrip("-").isdigit():
                value = int(value.strip())
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
                raise MemoryError(f"{key} must be a whole number.")
            value = int(value)
            if not lo <= value <= hi:
                raise MemoryError(f"{key} must be between {lo} and {hi}.")
            return value
        if key.endswith("_time") or key in {"overnight_shift_start", "overnight_shift_end"}:
            if not isinstance(value, str) or not TIME_RE.match(value):
                raise MemoryError(f"{key} must be a 24-hour time like 21:30.")
            return value
        if not isinstance(value, (str, int, float, bool)) or (isinstance(value, str) and len(value) > 200):
            raise MemoryError(f"{key} must be a short text, number or boolean.")
        return value

    def set_preference(self, key: str, value: Any, source: str = "user") -> dict[str, Any]:
        existing = self.get_preference(key)
        if existing is None:
            raise MemoryError(f"Unknown preference '{key}'.")
        value = self.validate_preference(key, value)
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE preferences SET value = ?, updated_at = ?, source = ? WHERE key = ?",
                (dumps(value), now_iso(), source, key),
            )
        updated = self.get_preference(key)
        assert updated is not None
        return {**updated, "previous_value": existing["value"]}

    def reset_preference(self, key: str) -> dict[str, Any]:
        seed = next((p for p in SEED_PREFERENCES if p["key"] == key), None)
        if seed is None:
            raise MemoryError(f"Unknown preference '{key}'.")
        return self.set_preference(key, seed["value"], source="reset")

    # ----- routines ----------------------------------------------------------------------------
    def routines(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM routines ORDER BY name")
        return [self._routine(r) for r in rows]

    def get_routine(self, routine_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM routines WHERE id = ?", (routine_id,))
        return self._routine(row) if row else None

    @staticmethod
    def _routine(r) -> dict[str, Any]:
        return {"id": r["id"], "name": r["name"], "description": r["description"],
                "triggers": json.loads(r["triggers"]), "steps": json.loads(r["steps"]), "updated_at": r["updated_at"]}

    def save_routine(self, routine: dict[str, Any], valid_devices: set[str]) -> dict[str, Any]:
        rid = routine.get("id") or ""
        if not re.fullmatch(r"[a-z][a-z0-9_]{2,40}", rid):
            raise MemoryError("Routine id must be 3-41 chars of lowercase letters, digits or underscores.")
        name = str(routine.get("name", "")).strip()
        if not name or len(name) > 60:
            raise MemoryError("Routine name is required (max 60 chars).")
        steps = routine.get("steps")
        if not isinstance(steps, list) or not 1 <= len(steps) <= 12:
            raise MemoryError("A routine needs between 1 and 12 steps.")
        for s in steps:
            if s.get("action") not in {"set_device", "create_reminder"}:
                raise MemoryError("Routine steps must be set_device or create_reminder.")
            if s["action"] == "set_device" and s.get("device_id") not in valid_devices:
                raise MemoryError(f"Unknown device in routine: {s.get('device_id')!r}.")
            if not s.get("title"):
                raise MemoryError("Every routine step needs a title.")
        triggers = [str(t).lower()[:40] for t in routine.get("triggers", [])][:12]
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO routines (id, name, description, triggers, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,"
                " triggers=excluded.triggers, steps=excluded.steps, updated_at=excluded.updated_at",
                (rid, name, str(routine.get("description", ""))[:200], dumps(triggers), dumps(steps), now_iso()),
            )
        saved = self.get_routine(rid)
        assert saved is not None
        return saved

    def resolve_routine(self, routine: dict[str, Any]) -> list[PlannedAction]:
        """Turn a routine template into concrete actions using the *current* preferences."""
        prefs = self.preferences()
        by_key = {p["key"]: p for p in prefs}
        actions: list[PlannedAction] = []
        for template in routine["steps"]:
            used: list[str] = []

            def sub(value: Any) -> Any:
                if isinstance(value, str):
                    whole = _PREF_TOKEN.fullmatch(value)
                    if whole:
                        key = whole.group(1)
                        if key not in by_key:
                            raise MemoryError(f"Routine references missing preference '{key}'.")
                        used.append(key)
                        return by_key[key]["value"]

                    def repl(m: re.Match) -> str:
                        key = m.group(1)
                        if key not in by_key:
                            raise MemoryError(f"Routine references missing preference '{key}'.")
                        used.append(key)
                        return str(by_key[key]["value"])

                    return _PREF_TOKEN.sub(repl, value)
                if isinstance(value, dict):
                    return {k: sub(v) for k, v in value.items()}
                return value

            resolved = sub(template)
            provenance = None
            if used:
                parts = []
                for key in dict.fromkeys(used):
                    p = by_key[key]
                    if key in {"pet_name"}:
                        continue
                    unit = p["unit"] if p["unit"] and p["unit"] != "time" else ""
                    parts.append(f"{p['label']} = {p['value']}{unit} (saved {p['updated_at'][:16].replace('T', ' ')} UTC)")
                provenance = "From memory: " + "; ".join(parts) if parts else None
            actions.append(
                PlannedAction(
                    action=resolved["action"],
                    title=resolved["title"],
                    rationale=resolved.get("rationale", ""),
                    device_id=resolved.get("device_id"),
                    attributes=resolved.get("attributes", {}),
                    reminder=resolved.get("reminder"),
                    provenance=provenance,
                )
            )
        return actions

    # ----- reminders ---------------------------------------------------------------------------
    # A reminder has three independent facts, never collapsed into one "done":
    #   status    unscheduled | scheduled | due | closed        (where it is in its life)
    #   delivery  NOT_DUE | PENDING | DELIVERED_IN_APP | UNCONFIRMED | NOT_DELIVERED   (did anyone see it)
    #   outcome   OPEN | USER_CONFIRMED | VERIFIED | MISMATCH | UNKNOWN | RECOVERING | DISMISSED
    # `check` (optional) is a device state that proves the task was done, e.g. the front door locked.
    def create_reminder(self, title: str, due: str | None, note: str | None, category: str,
                        idempotency_key: str, due_at: str | None = None,
                        check: dict[str, Any] | None = None) -> dict[str, Any]:
        title = (title or "").strip()
        if not title or len(title) > 80:
            raise MemoryError("Reminder title is required (max 80 chars).")
        if due is not None and not TIME_RE.match(due):
            raise MemoryError("Reminder due time must be a 24-hour time like 21:30.")
        if check is not None and (not check.get("device_id") or not isinstance(check.get("expected"), dict)
                                  or not check["expected"]):
            raise MemoryError("A reminder check needs a device_id and the expected state.")
        tz = household_tz(self.timezone)
        if due_at is None and due is not None:
            due_at = iso(next_occurrence(due, tz))
        if due_at is not None and due is None:
            due = local_hhmm(parse_iso(due_at), tz)
        now = now_iso()
        with self.db.transaction() as conn:
            prior = conn.execute("SELECT * FROM reminders WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if prior is not None:
                return {**self._reminder(prior), "duplicate": True}
            rid = f"rem_{uuid.uuid4().hex[:10]}"
            history = [{"kind": "created", "source": "create_reminder", "at": now,
                        "summary": f"Saved “{title}”" + (f" for {due} ({parse_iso(due_at).astimezone(tz).strftime('%a %d %b')})"
                                                         if due_at else " with no due time") + "."}]
            conn.execute(
                "INSERT INTO reminders (id, title, due, note, category, idempotency_key, created_at, status, due_at,"
                " check_spec, outcome, delivery, history, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)",
                (rid, title, due, (note or "")[:200], category[:30], idempotency_key, now,
                 "scheduled" if due_at else "unscheduled", due_at, dumps(check) if check else None,
                 dumps({"status": "NOT_DUE" if due_at else "NO_ALERT"}), dumps(history), now),
            )
            row = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
        return {**self._reminder(row), "duplicate": False}

    def update_reminder(self, reminder_id: str, changes: dict[str, Any],
                        event: dict[str, Any] | None = None) -> dict[str, Any]:
        """Apply field changes and append one history entry, atomically."""
        cols = {"status": "status", "due_at": "due_at", "due": "due", "outcome": "outcome",
                "delivery": "delivery"}
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
            if row is None:
                raise MemoryError(f"Unknown reminder '{reminder_id}'.")
            history = json.loads(row["history"] or "[]")
            now = now_iso()
            if event:
                history.append({"at": now, **event})
            sets, params = ["history = ?", "updated_at = ?"], [dumps(history[-60:]), now]
            for key, value in changes.items():
                sets.append(f"{cols[key]} = ?")
                params.append(dumps(value) if key == "delivery" else value)
            conn.execute(f"UPDATE reminders SET {', '.join(sets)} WHERE id = ?", (*params, reminder_id))
            row = conn.execute("SELECT * FROM reminders WHERE id = ?", (reminder_id,)).fetchone()
        return self._reminder(row)

    def reminders(self) -> list[dict[str, Any]]:
        return [self._reminder(r) for r in self.db.query("SELECT * FROM reminders ORDER BY created_at DESC")]

    def reminders_where(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        return [self._reminder(r) for r in self.db.query(f"SELECT * FROM reminders WHERE {sql}", params)]

    def get_reminder(self, reminder_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM reminders WHERE id = ?", (reminder_id,))
        return self._reminder(row) if row else None

    def delete_reminder(self, reminder_id: str) -> bool:
        with self.db.transaction() as conn:
            return conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,)).rowcount > 0

    @staticmethod
    def _reminder(r) -> dict[str, Any]:
        keys = r.keys()
        get = (lambda k, default=None: r[k] if k in keys and r[k] is not None else default)
        return {"reminder_id": r["id"], "title": r["title"], "due": r["due"], "note": r["note"],
                "category": r["category"], "created_at": r["created_at"], "simulated": True,
                "status": get("status", "unscheduled"), "due_at": get("due_at"),
                "check": json.loads(get("check_spec")) if get("check_spec") else None,
                "outcome": get("outcome", "OPEN"), "delivery": json.loads(get("delivery", "{}")),
                "history": json.loads(get("history", "[]")), "updated_at": get("updated_at", r["created_at"])}

    # ----- privacy controls --------------------------------------------------------------------
    def forget_everything(self) -> None:
        """Delete stored memory and history, then restore the demo defaults."""
        with self.db.transaction() as conn:
            for table in ("preferences", "routines", "reminders", "timers", "runs", "steps", "events", "messages",
                          "sessions"):
                conn.execute(f"DELETE FROM {table}")
        self.seed()
