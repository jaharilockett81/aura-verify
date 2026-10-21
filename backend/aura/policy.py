"""Permission policy and plan validation. Risk is decided here, never by a planner (LLM or local)."""

from __future__ import annotations

from typing import Any

from .models import PlannedAction, Risk


class PlanValidationError(Exception):
    pass


def assess_risk(action: PlannedAction, device_type: str | None) -> tuple[Risk, str]:
    """Return (risk, reason). SENSITIVE steps need their own confirmation even after plan approval."""
    if action.action == "read_device":
        return Risk.READ_ONLY, "Read-only: observes state, changes nothing."
    if action.action == "set_device":
        if device_type == "lock":
            if action.attributes.get("locked") is False:
                return Risk.SENSITIVE, "Unlocking a door affects home security."
            return Risk.SENSITIVE, "Door locks are physical-security actions: someone could be locked out."
        if device_type == "thermostat" and "hold" in action.attributes:
            return Risk.SENSITIVE, "Overrides the thermostat's energy-saver program (may affect energy cost)."
        return Risk.ROUTINE, "Low-risk comfort change, covered by plan approval."
    if action.action == "create_reminder":
        return Risk.ROUTINE, "Adds a reminder to AURA's list (simulated delivery)."
    if action.action == "update_preference":
        return Risk.ROUTINE, "Updates your saved preferences; editable or reversible in Memory."
    return Risk.SENSITIVE, "Unrecognised action type."


def _check_attributes(device: dict[str, Any], attributes: dict[str, Any]) -> None:
    allowed = device["settable_attributes"]
    if not attributes:
        raise PlanValidationError(f"No attributes given for {device['name']}.")
    for key, value in attributes.items():
        rule = allowed.get(key)
        if rule is None:
            raise PlanValidationError(f"{device['name']} has no attribute '{key}'.")
        if "enum" in rule and value not in rule["enum"]:
            raise PlanValidationError(f"{device['name']}: '{key}' must be one of {rule['enum']}.")
        if "int" in rule:
            lo, hi = rule["int"]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
                raise PlanValidationError(f"{device['name']}: '{key}' must be between {lo} and {hi} (got {value}).")
        if "bool" in rule and not isinstance(value, bool):
            raise PlanValidationError(f"{device['name']}: '{key}' must be true or false.")


def validate_actions(actions: list[PlannedAction], devices: list[dict[str, Any]],
                     preference_keys: set[str]) -> dict[str, dict[str, Any]]:
    """Validate planner output against the live device catalogue. Returns devices by id."""
    by_id = {d["device_id"]: d for d in devices}
    if len(actions) > 15:
        raise PlanValidationError("Plans are limited to 15 steps.")
    for a in actions:
        if a.action in ("read_device", "set_device"):
            if a.device_id not in by_id:
                raise PlanValidationError(f"Unknown device '{a.device_id}'.")
            if a.action == "set_device":
                _check_attributes(by_id[a.device_id], a.attributes)
        elif a.action == "create_reminder":
            if not a.reminder or not a.reminder.get("title"):
                raise PlanValidationError("A reminder needs a title.")
        elif a.action == "update_preference":
            if a.preference_key not in preference_keys:
                raise PlanValidationError(f"Unknown preference '{a.preference_key}'.")
    return by_id
