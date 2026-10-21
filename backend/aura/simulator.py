"""Deterministic smart-home simulator.

Clearly a simulation: no real devices are touched. It deliberately models the gap between
"the hub accepted the command" and "the device is actually in that state":

* Commands are acknowledged immediately but only take effect after a settle delay.
* A thermostat in an energy-saver hold acknowledges setpoint changes and then ignores them.
* An unreachable device acknowledges (queues) commands but can't be read.
* A "dropped command" fault acknowledges exactly one command and silently discards it.

State is persisted in SQLite so the API server and the MCP server observe the same household.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from .db import Database, dumps, now_iso


class DeviceError(Exception):
    """Raised for invalid requests (unknown device, bad attribute)."""


class DeviceUnreachable(Exception):
    """Raised when a device cannot be read. The outcome of earlier commands is unknowable."""


DEVICE_TYPES: dict[str, dict[str, Any]] = {
    "light": {
        "power": {"enum": ["on", "off"]},
        "brightness": {"int": (0, 100)},
    },
    "thermostat": {
        "setpoint_f": {"int": (60, 80)},
        "hold": {"enum": ["none", "energy_saver"]},
        "mode": {"enum": ["heat", "cool", "auto", "off"]},
    },
    "lock": {"locked": {"bool": True}},
    "plug": {"power": {"enum": ["on", "off"]}},
}

SEED_DEVICES: list[dict[str, Any]] = [
    {"id": "living_room_lights", "name": "Living room lights", "room": "Living room", "type": "light",
     "state": {"power": "on", "brightness": 80}},
    {"id": "bedroom_lights", "name": "Bedroom lights", "room": "Bedroom", "type": "light",
     "state": {"power": "off", "brightness": 0}},
    {"id": "porch_light", "name": "Porch light", "room": "Entry", "type": "light",
     "state": {"power": "off", "brightness": 0}},
    {"id": "thermostat", "name": "Thermostat", "room": "Hallway", "type": "thermostat",
     "state": {"setpoint_f": 76, "hold": "none", "mode": "auto", "ambient_f": 76}},
    {"id": "front_door", "name": "Front door lock", "room": "Entry", "type": "lock",
     "state": {"locked": False}},
    {"id": "white_noise", "name": "White-noise machine", "room": "Bedroom", "type": "plug",
     "state": {"power": "off"}},
]

FAULT_KINDS = {
    "energy_saver_hold": "Thermostat enters an energy-saver hold: it acknowledges setpoint commands but ignores them.",
    "unreachable": "Device goes offline: commands are queued by the hub but the device cannot be read.",
    "drop_next_command": "The next command is acknowledged by the hub and then silently lost.",
}


def _validate(device_type: str, attributes: dict[str, Any]) -> dict[str, Any]:
    schema = DEVICE_TYPES[device_type]
    if not attributes:
        raise DeviceError("No attributes given.")
    clean: dict[str, Any] = {}
    for key, value in attributes.items():
        if key not in schema:
            raise DeviceError(f"Attribute '{key}' is not supported by {device_type} devices.")
        rule = schema[key]
        if "enum" in rule:
            if value not in rule["enum"]:
                raise DeviceError(f"'{key}' must be one of {rule['enum']}, got {value!r}.")
        elif "int" in rule:
            lo, hi = rule["int"]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
                raise DeviceError(f"'{key}' must be a whole number, got {value!r}.")
            value = int(value)
            if not lo <= value <= hi:
                raise DeviceError(f"'{key}' must be between {lo} and {hi}, got {value}.")
        elif "bool" in rule:
            if not isinstance(value, bool):
                raise DeviceError(f"'{key}' must be true or false, got {value!r}.")
        clean[key] = value
    return clean


class SmartHomeSimulator:
    def __init__(self, db: Database, settle_ms: int = 600):
        self.db = db
        self.settle_ms = settle_ms

    # ----- setup -------------------------------------------------------------------------------
    def seed(self, force: bool = False) -> None:
        with self.db.transaction() as conn:
            existing = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            if existing and not force:
                return
            conn.execute("DELETE FROM devices")
            conn.execute("DELETE FROM device_commands")
            for dev in SEED_DEVICES:
                conn.execute(
                    "INSERT INTO devices (id, name, room, type, state, pending, faults, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, NULL, '{}', ?)",
                    (dev["id"], dev["name"], dev["room"], dev["type"], dumps(dev["state"]), now_iso()),
                )

    # ----- internal ----------------------------------------------------------------------------
    def _row(self, conn, device_id: str):
        row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if row is None:
            raise DeviceError(f"Unknown device '{device_id}'.")
        return row

    def _materialize(self, conn, row) -> dict[str, Any]:
        """Apply a pending change whose settle time has passed. Returns current state."""
        state = json.loads(row["state"])
        pending = json.loads(row["pending"]) if row["pending"] else None
        if pending and pending["apply_at"] <= time.time():
            state.update(pending["attributes"])
            applied_at = datetime.fromtimestamp(pending["apply_at"], UTC).isoformat(timespec="milliseconds")
            conn.execute(
                "UPDATE devices SET state = ?, pending = NULL, updated_at = ? WHERE id = ?",
                (dumps(state), applied_at.replace("+00:00", "Z"), row["id"]),
            )
        return state

    # ----- public API (used by MCP tools) ------------------------------------------------------
    def list_devices(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT id, name, room, type, faults FROM devices ORDER BY room, name")
        return [
            {
                "device_id": r["id"],
                "name": r["name"],
                "room": r["room"],
                "type": r["type"],
                "settable_attributes": {
                    k: v for k, v in DEVICE_TYPES[r["type"]].items()
                },
            }
            for r in rows
        ]

    def device_ids(self) -> set[str]:
        return {r["id"] for r in self.db.query("SELECT id FROM devices")}

    def device_type(self, device_id: str) -> str:
        row = self.db.query_one("SELECT type FROM devices WHERE id = ?", (device_id,))
        if row is None:
            raise DeviceError(f"Unknown device '{device_id}'.")
        return row["type"]

    def read_state(self, device_id: str) -> dict[str, Any]:
        """Independent state channel: what the device reports, not what we asked for."""
        with self.db.transaction() as conn:
            row = self._row(conn, device_id)
            faults = json.loads(row["faults"])
            if faults.get("unreachable"):
                raise DeviceUnreachable(f"{row['name']} did not respond to a state read (device offline).")
            state = self._materialize(conn, row)
            updated = conn.execute("SELECT updated_at FROM devices WHERE id = ?", (device_id,)).fetchone()[0]
        return {
            "device_id": device_id,
            "name": row["name"],
            "room": row["room"],
            "type": row["type"],
            "state": state,
            "reported_at": now_iso(),
            "last_changed_at": updated,
            "simulated": True,
        }

    def snapshot(self) -> list[dict[str, Any]]:
        """State of every device for the dashboard. Unreachable devices are reported as such."""
        out = []
        for dev in self.list_devices():
            try:
                reading = self.read_state(dev["device_id"])
                out.append({**reading, "reachable": True})
            except DeviceUnreachable as exc:
                out.append({**dev, "reachable": False, "state": None, "error": str(exc), "simulated": True})
        return out

    def set_state(self, device_id: str, attributes: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        """Send a command. The returned ack only means the (simulated) hub accepted it."""
        if not idempotency_key or len(idempotency_key) > 200:
            raise DeviceError("A non-empty idempotency_key (max 200 chars) is required.")
        with self.db.transaction() as conn:
            prior = conn.execute(
                "SELECT ack FROM device_commands WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if prior is not None:
                ack = json.loads(prior["ack"])
                ack["duplicate"] = True
                ack["message"] = "Duplicate idempotency key: original command was not re-applied."
                return ack

            row = self._row(conn, device_id)
            clean = _validate(row["type"], attributes)
            faults = json.loads(row["faults"])
            state = self._materialize(conn, row)

            dropped_reason: str | None = None
            if faults.get("unreachable"):
                dropped_reason = "device_offline"
            elif faults.get("drop_next_command", 0) > 0:
                faults["drop_next_command"] -= 1
                if faults["drop_next_command"] <= 0:
                    faults.pop("drop_next_command")
                dropped_reason = "dropped_in_transit"
            elif row["type"] == "thermostat" and state.get("hold") == "energy_saver" and clean.get("hold") != "none":
                # Device-side behaviour: setpoint changes are ignored while the hold is active.
                clean.pop("setpoint_f", None)
                if not clean:
                    dropped_reason = "ignored_by_device_hold"

            command_id = f"cmd_{uuid.uuid4().hex[:10]}"
            if dropped_reason is None:
                pending = {"attributes": clean, "apply_at": time.time() + self.settle_ms / 1000}
                conn.execute(
                    "UPDATE devices SET pending = ?, faults = ? WHERE id = ?",
                    (dumps(pending), dumps(faults), device_id),
                )
            else:
                conn.execute("UPDATE devices SET faults = ? WHERE id = ?", (dumps(faults), device_id))

            # The ack is identical whether or not the device will apply the change. That's the point.
            ack = {
                "accepted": True,
                "status": "ACCEPTED",
                "command_id": command_id,
                "device_id": device_id,
                "requested": attributes,
                "received_at": now_iso(),
                "message": "Command accepted by the simulated home hub.",
                "simulated": True,
                "duplicate": False,
            }
            conn.execute(
                "INSERT INTO device_commands (idempotency_key, device_id, attributes, ack, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (idempotency_key, device_id, dumps(attributes), dumps(ack), now_iso()),
            )
            # Internal record (not returned to the caller) for the demo-controls inspector and tests.
            conn.execute(
                "INSERT INTO events (run_id, type, data, at) VALUES (NULL, 'sim.command', ?, ?)",
                (dumps({"device_id": device_id, "command_id": command_id, "requested": attributes,
                        "hidden_outcome": dropped_reason or "will_apply"}), now_iso()),
            )
        return ack

    # ----- demo controls (fault injection), clearly labeled in the UI --------------------------
    def inject_fault(self, device_id: str, kind: str) -> dict[str, Any]:
        if kind not in FAULT_KINDS:
            raise DeviceError(f"Unknown fault '{kind}'. Options: {sorted(FAULT_KINDS)}")
        with self.db.transaction() as conn:
            row = self._row(conn, device_id)
            faults = json.loads(row["faults"])
            if kind == "energy_saver_hold":
                if row["type"] != "thermostat":
                    raise DeviceError("energy_saver_hold only applies to the thermostat.")
                state = self._materialize(conn, row)
                state["hold"] = "energy_saver"
                conn.execute("UPDATE devices SET state = ?, pending = NULL, updated_at = ? WHERE id = ?",
                             (dumps(state), now_iso(), device_id))
            elif kind == "unreachable":
                faults["unreachable"] = True
            elif kind == "drop_next_command":
                faults["drop_next_command"] = faults.get("drop_next_command", 0) + 1
            conn.execute("UPDATE devices SET faults = ? WHERE id = ?", (dumps(faults), device_id))
        return {"device_id": device_id, "fault": kind, "description": FAULT_KINDS[kind]}

    def clear_faults(self, device_id: str | None = None) -> None:
        with self.db.transaction() as conn:
            rows = conn.execute("SELECT * FROM devices" + (" WHERE id = ?" if device_id else ""),
                                (device_id,) if device_id else ()).fetchall()
            for row in rows:
                state = self._materialize(conn, row)
                if row["type"] == "thermostat" and state.get("hold") == "energy_saver":
                    state["hold"] = "none"
                    conn.execute("UPDATE devices SET state = ?, updated_at = ? WHERE id = ?",
                                 (dumps(state), now_iso(), row["id"]))
                conn.execute("UPDATE devices SET faults = '{}' WHERE id = ?", (row["id"],))

    def faults(self) -> dict[str, dict[str, Any]]:
        out = {}
        for r in self.db.query("SELECT id, type, state, faults FROM devices"):
            f = json.loads(r["faults"])
            if r["type"] == "thermostat" and json.loads(r["state"]).get("hold") == "energy_saver":
                f["energy_saver_hold"] = True
            if f:
                out[r["id"]] = f
        return out
