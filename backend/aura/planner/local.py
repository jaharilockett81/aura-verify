"""Local rule-based planner.

This is NOT an LLM. It is a deterministic intent parser used when Amazon Bedrock is not configured, and it is
labeled as such everywhere it appears (API, UI, history). Its job is narrow: recognise routines, simple device
commands, preference changes and reminders, and ask for missing information instead of guessing.
"""

from __future__ import annotations

import re
from typing import Any

from ..models import PlanDraft, PlannedAction

PLANNER_LABEL = "Local rule-based planner (deterministic, no LLM)"

ROOM_DEVICES = {
    "living room": "living_room_lights",
    "living-room": "living_room_lights",
    "lounge": "living_room_lights",
    "bedroom": "bedroom_lights",
    "porch": "porch_light",
    "front porch": "porch_light",
    "entry": "porch_light",
}
LIGHT_NAMES = {"living_room_lights": "living room lights", "bedroom_lights": "bedroom lights",
               "porch_light": "porch light"}

PREF_CUES = re.compile(r"\b(prefer|preference|from now on|remember|i like|i'd like it|actually|always|"
                       r"change my|update my|my usual|default)\b")
NUMBER = re.compile(r"\b(\d{2,3})\s*(?:°|degrees?|deg|f\b|percent|%)?")
# A temperature the user stated explicitly: "75°F", "75 degrees", or "to/at 75" next to a temperature word.
TEMP_UNIT = re.compile(r"\b(\d{2,3})\s*(?:°\s*f?|degrees?\b|deg\b|f\b)")
TEMP_ALT = re.compile(r"\b(\d{2,3})\s+(?:or|and|to|-)\s+\d{2,3}\s*(?:°|degrees?\b|f\b)")
TEMP_WORD = re.compile(r"\b(thermostat|temperature|temp|heat|warm|cool|degrees?)\b|°")
TEMP_BARE = re.compile(r"\b(?:to|at|on|keep it|around)\s+(\d{2,3})\b(?!\s*(?::|am\b|pm\b|a\.m|p\.m|%|percent))")
GREETING = re.compile(r"^(hey|hi|hello|hiya|howdy|yo|good (morning|afternoon|evening|night))"
                      r"( there)?( aura)?( how are you( doing)?| what'?s up)?$")
THANKS = re.compile(r"^(thanks|thank you|thank you so much|thanks a lot|cheers|great|perfect|ok(ay)?|cool)( aura)?$")
TIME = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?")


def _parse_time(text: str) -> str | None:
    m = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?", text)
    if not m:
        return None
    hour, minute, ampm = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def _explicit_temperatures(text: str) -> list[int]:
    """Every temperature the user stated explicitly, in order, without duplicates."""
    found = sorted(((m.start(), int(m.group(1))) for m in [*TEMP_UNIT.finditer(text), *TEMP_ALT.finditer(text)]))
    found = [n for _, n in found]
    if TEMP_WORD.search(text):
        found += [int(m.group(1)) for m in TEMP_BARE.finditer(text)]
    return list(dict.fromkeys(found))


def _setpoint_range(context: dict[str, Any]) -> tuple[int, int]:
    for d in context.get("devices", []):
        rule = (d.get("settable_attributes") or {}).get("setpoint_f")
        if d.get("device_id") == "thermostat" and rule and "int" in rule:
            return tuple(rule["int"])  # type: ignore[return-value]
    return (60, 80)


def _first_number(text: str) -> int | None:
    for m in NUMBER.finditer(text):
        return int(m.group(1))
    return None


class LocalPlanner:
    name = "local"

    async def plan(self, utterance: str, context: dict[str, Any], pending: dict[str, Any] | None) -> PlanDraft:
        text = " ".join(utterance.lower().strip().split())
        prefs = {p["key"]: p for p in context.get("preferences", [])}
        small_talk = self._small_talk(text.replace("alexa", "aura"), prefs)
        text = text.replace("alexa,", "").replace("alexa", "").replace("aura,", "").strip(" ,.!?")
        if small_talk is not None:
            return small_talk

        if pending:
            filled = self._fill_pending(text, pending, context, prefs)
            if filled:
                return filled

        for handler in (self._preference, self._reminder, self._query, self._routine_with_values, self._device,
                        self._routine):
            draft = handler(text, context, prefs)
            if draft is not None:
                return draft

        routines = ", ".join(f"“{r['name']}”" for r in context.get("routines", []))
        return self._draft(
            intent="unknown",
            summary="Request not understood",
            spoken=f"I'm not sure how to help with that yet. I can run your routines ({routines}), "
                   "control lights, the thermostat and the door lock, set reminders, or update your preferences.",
        )

    # ----- helpers -------------------------------------------------------------------------------
    @staticmethod
    def _draft(**kw: Any) -> PlanDraft:
        return PlanDraft(
            intent=kw["intent"], summary=kw["summary"], spoken_response=kw["spoken"],
            routine_id=kw.get("routine_id"), actions=kw.get("actions", []),
            clarification_question=kw.get("question"), pending_slot=kw.get("pending"),
            planner="local", planner_detail=PLANNER_LABEL,
        )

    def _fill_pending(self, text: str, pending: dict[str, Any], context: dict[str, Any],
                      prefs: dict[str, Any]) -> PlanDraft | None:
        if pending.get("slot") == "routine_setpoint_f":
            routine = next((r for r in context.get("routines", []) if r["id"] == pending.get("routine_id")), None)
            n = _first_number(text)
            lo, hi = _setpoint_range(context)
            if routine is None or n is None or not lo <= n <= hi:
                return None
            return self._routine_draft(routine, prefs, {"thermostat": {"setpoint_f": n}})
        if pending.get("slot") == "setpoint_f":
            n = _first_number(text)
            if n is None:
                return None
            return self._thermostat_plan(n)
        if pending.get("slot") == "light_device":
            device = next((d for room, d in ROOM_DEVICES.items() if room in text), None)
            if "all" in text:
                return self._lights_plan(list(LIGHT_NAMES), pending["power"])
            if device:
                return self._lights_plan([device], pending["power"])
        return None

    # ----- greetings ------------------------------------------------------------------------------
    def _small_talk(self, text: str, prefs: dict[str, Any]) -> PlanDraft | None:
        """Short greetings and thanks get a short, honest reply. Nothing else is treated as conversation."""
        bare = " ".join(re.sub(r"[^a-z' ]", " ", text).split())
        name = prefs.get("user_name", {}).get("value")
        if GREETING.fullmatch(bare) or bare in ("aura", "hey aura", "hi aura", "hello aura"):
            return self._draft(
                intent="unknown", summary="Greeting",
                spoken=(f"Hi{', ' + name if name else ''}. I'm running on AURA's local rule-based planner, so I can't "
                        "chat freely, but I can run a routine like bedtime or overnight shift, set the thermostat, "
                        "lights or lock, add a reminder, or check on the house."),
            )
        if THANKS.fullmatch(bare):
            return self._draft(intent="unknown", summary="Thanks", spoken="You're welcome.")
        return None

    # ----- routines with explicit values ---------------------------------------------------------------
    def _routine_with_values(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        """A routine request that also states a temperature ("…before my overnight shift, at 75°F").

        The explicit value wins over the saved preference for this run only. Unsupported or ambiguous values get a
        clarification instead of being silently replaced by the saved preference.
        """
        temps = _explicit_temperatures(text)
        if not temps:
            return None
        draft = self._routine(text, context, prefs)
        if draft is None:
            return None
        routine = next(r for r in context.get("routines", []) if r["id"] == draft.routine_id)
        lo, hi = _setpoint_range(context)
        if len(temps) > 1:
            return self._draft(
                intent="clarify", summary=f"{routine['name']}: which temperature?",
                spoken=f"I heard {' and '.join(f'{t}°F' for t in temps)}. Which temperature should I use?",
                question=f"I heard {' and '.join(f'{t}°F' for t in temps)}. Which temperature should the "
                         f"{routine['name'].lower()} routine use?",
                pending={"slot": "routine_setpoint_f", "routine_id": routine["id"]})
        n = temps[0]
        if not lo <= n <= hi:
            return self._draft(
                intent="clarify", summary=f"{routine['name']}: temperature out of range",
                spoken=f"The thermostat supports {lo} to {hi}°F, so I can't use {n}°F. What temperature would you like?",
                question=f"The thermostat supports {lo}–{hi}°F, so I can't set {n}°F. Which temperature should the "
                         f"{routine['name'].lower()} routine use?",
                pending={"slot": "routine_setpoint_f", "routine_id": routine["id"]})
        return self._routine_draft(routine, prefs, {"thermostat": {"setpoint_f": n}})

    # ----- preferences ---------------------------------------------------------------------------
    def _preference(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        if not PREF_CUES.search(text):
            return None
        key: str | None = None
        value: Any = None
        n = _first_number(text)
        if re.search(r"\b(bed ?time|bed|sleep|sleeping|night)\b", text) and n is not None:
            if re.search(r"\b(light|lights|lamp|brightness|percent|%)\b", text):
                key, value = "bedtime_light_level", n
            elif re.search(r"\b(temp|temperature|degrees?|thermostat|°|warm|cool)\b", text) or 60 <= n <= 80:
                key, value = "bedtime_temperature_f", n
        elif re.search(r"\b(away|at work|on shift|while i'?m out|while i'?m gone|overnight)\b", text) and n is not None:
            key, value = "away_temperature_f", n
        elif m := re.search(r"\bcall me ([a-z][a-z' -]{0,30})", text):
            key, value = "user_name", m.group(1).strip().title()
        elif re.search(r"\b(feed|dinner|feeding)\b", text) and (t := _parse_time(text)):
            key, value = "pet_feeding_time", t
        if key is None:
            return None
        label = prefs.get(key, {}).get("label", key)
        unit = prefs.get(key, {}).get("unit") or ""
        unit = "" if unit == "time" else unit
        old = prefs.get(key, {}).get("value")
        return self._draft(
            intent="preference_update",
            summary=f"Update preference: {label}",
            spoken=f"Got it. I'll remember {label.lower()} as {value}{unit}" + (f" (it was {old}{unit})." if old is not None else "."),
            actions=[PlannedAction(action="update_preference", title=f"Remember {label.lower()}: {value}{unit}",
                                   rationale="You told me your preference; saving it so future routines use it.",
                                   preference_key=key, preference_value=value)],
        )

    # ----- reminders -----------------------------------------------------------------------------
    def _reminder(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        m = re.search(r"\bremind me to (.+?)(?:\s+at\s+.*)?$", text)
        if not m:
            return None
        title = m.group(1).strip().capitalize()
        due = _parse_time(text)
        return self._draft(
            intent="device_control", summary=f"Create reminder: {title}",
            spoken=f"I'll add a reminder to {m.group(1).strip()}" + (f" at {due}." if due else "."),
            actions=[PlannedAction(action="create_reminder", title=f"Add reminder: {title}",
                                   rationale="You asked for a reminder.",
                                   reminder={"title": title, "due": due, "note": "Created by voice request.",
                                             "category": "general"})],
        )

    # ----- queries -------------------------------------------------------------------------------
    def _query(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        if not re.search(r"^(what|what's|whats|is|are|how|check|status)\b", text):
            return None
        targets: list[str] = []
        if re.search(r"thermostat|temperature|temp\b", text):
            targets.append("thermostat")
        if re.search(r"door|lock", text):
            targets.append("front_door")
        for room, device in ROOM_DEVICES.items():
            if room in text and device not in targets:
                targets.append(device)
        if re.search(r"\b(house|home|everything|status|apartment)\b", text) and not targets:
            targets = [d["device_id"] for d in context.get("devices", [])]
        if not targets:
            return None
        return self._draft(
            intent="query", summary="Check device state",
            spoken="Let me check.",
            actions=[PlannedAction(action="read_device", device_id=d, title=f"Read {d.replace('_', ' ')}",
                                   rationale="You asked for the current state.") for d in targets],
        )

    # ----- direct device control -----------------------------------------------------------------
    def _thermostat_plan(self, n: int) -> PlanDraft:
        return self._draft(
            intent="device_control", summary=f"Set thermostat to {n}°F",
            spoken=f"Setting the thermostat to {n} degrees.",
            actions=[PlannedAction(action="set_device", device_id="thermostat", attributes={"setpoint_f": n},
                                   title=f"Set the thermostat to {n}°F", rationale="You asked for this temperature.")],
        )

    def _lights_plan(self, devices: list[str], power: str, brightness: int | None = None) -> PlanDraft:
        actions = []
        for d in devices:
            attrs: dict[str, Any] = {"power": power}
            title = f"Turn {power} the {LIGHT_NAMES[d]}"
            if brightness is not None and power == "on":
                attrs["brightness"] = brightness
                title = f"Set the {LIGHT_NAMES[d]} to {brightness}%"
            actions.append(PlannedAction(action="set_device", device_id=d, attributes=attrs, title=title,
                                         rationale="You asked for this."))
        names = " and ".join(LIGHT_NAMES[d] for d in devices)
        return self._draft(intent="device_control", summary=f"Lights: {names} {power}",
                           spoken=f"Turning {power} the {names}.", actions=actions)

    def _device(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        if re.search(r"\b(thermostat|temperature|heat|a/?c)\b", text) and re.search(
                r"\b(set|change|make|turn|put|bump|raise|lower)\b", text):
            n = _first_number(text)
            if n is None:
                return self._draft(intent="clarify", summary="Thermostat: temperature needed",
                                   spoken="What temperature would you like?",
                                   question="What temperature would you like the thermostat set to?",
                                   pending={"slot": "setpoint_f"})
            return self._thermostat_plan(n)
        if re.search(r"\bunlock\b", text) and re.search(r"door|lock", text):
            return self._draft(
                intent="device_control", summary="Unlock the front door", spoken="Unlocking needs your confirmation.",
                actions=[PlannedAction(action="set_device", device_id="front_door", attributes={"locked": False},
                                       title="Unlock the front door", rationale="You asked to unlock it.")])
        if re.search(r"\block\b", text) and re.search(r"door", text):
            return self._draft(
                intent="device_control", summary="Lock the front door", spoken="Locking the front door.",
                actions=[PlannedAction(action="set_device", device_id="front_door", attributes={"locked": True},
                                       title="Lock the front door", rationale="You asked to lock it.")])
        if re.search(r"white ?noise|sound machine", text) and (m := re.search(r"\b(on|off)\b", text)):
            return self._draft(
                intent="device_control", summary=f"White noise {m.group(1)}",
                spoken=f"Turning the white-noise machine {m.group(1)}.",
                actions=[PlannedAction(action="set_device", device_id="white_noise", attributes={"power": m.group(1)},
                                       title=f"Turn {m.group(1)} the white-noise machine", rationale="You asked.")])
        if re.search(r"\blights?\b|\blamp\b", text):
            dim = re.search(r"\b(dim|brightness|to)\b.*?(\d{1,3})\s*(%|percent)", text)
            m = re.search(r"\b(on|off)\b", text)
            power = "on" if dim else (m.group(1) if m else None)
            if power is None:
                return None
            if re.search(r"\ball\b|every", text):
                devices = list(LIGHT_NAMES)
            else:
                devices = list(dict.fromkeys(d for room, d in ROOM_DEVICES.items() if room in text))
            if not devices:
                return self._draft(intent="clarify", summary="Lights: which room?",
                                   spoken="Which lights? Living room, bedroom, porch, or all of them?",
                                   question="Which lights: living room, bedroom, porch, or all?",
                                   pending={"slot": "light_device", "power": power})
            return self._lights_plan(devices, power, int(dim.group(2)) if dim else None)
        return None

    # ----- routines --------------------------------------------------------------------------------
    def _routine(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        best, best_score = None, 0.0
        for r in context.get("routines", []):
            score = 0.0
            if r["name"].lower() in text:
                score += 3
            for trig in r.get("triggers", []):
                if re.search(rf"\b{re.escape(trig)}\b", text):
                    score += 1 + 0.2 * len(trig.split())
            if score > best_score:
                best, best_score = r, score
        if best is None:
            return None
        return self._routine_draft(best, prefs)

    def _routine_draft(self, routine: dict[str, Any], prefs: dict[str, Any],
                       overrides: dict[str, dict[str, Any]] | None = None) -> PlanDraft:
        name = prefs.get("user_name", {}).get("value")
        extra = ""
        if overrides and (n := overrides.get("thermostat", {}).get("setpoint_f")) is not None:
            extra = f" The thermostat is set to {n}°F, as you asked, for this run only."
        draft = self._draft(
            intent="routine", routine_id=routine["id"], summary=f"Run routine: {routine['name']}",
            spoken=f"Here's your {routine['name'].lower()} plan" + (f", {name}" if name else "") +
                   "." + extra + " Take a look and approve when ready.",
        )
        draft.overrides = overrides or {}
        return draft
