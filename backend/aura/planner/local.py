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
# Wake words and how people address the assistant: "Hey Aura,", "OK Alexa", "Aura:".
WAKE = re.compile(r"^(?:(?:hey|ok|okay|hi|hello|yo)[ ,]+)?(?:alexa|aura|echo)\b[\s,.!:;-]*")
NUMBER_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                "eight": 8, "nine": 9, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40,
                "forty-five": 45, "sixty": 60, "ninety": 90}
DURATION = re.compile(r"\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|"
                      r"thirty|forty|forty-five|sixty|ninety)\s*-?\s*(hours?|hrs?|h\b|minutes?|mins?|m\b|"
                      r"seconds?|secs?|s\b)")
HALF_HOUR = re.compile(r"\bhalf an? hour\b")
VERBS = r"(?:turn|switch|set|lock|unlock|dim|make|put|start|pause|resume|cancel|stop|remind|raise|lower|close|open|" \
        r"check|bump|change)"
CLAUSE_SPLIT = re.compile(rf"\s*(?:,|;|\bthen\b)\s*(?:and\s+)?(?:then\s+)?|\s+and\s+(?:then\s+)?(?={VERBS}\b)")
STATUS_Q = re.compile(r"^(did (it|that|this|everything) (work|go through|happen|finish)|is (it|that|everything) done|"
                      r"was (it|that) (verified|done|successful)|how did (it|that) go|what happened|did you do (it|that)|"
                      r"is it finished)\b")
CORRECTION = re.compile(r"^(?:no|nope|sorry|wait|oops|actually|i meant|i mean|make (?:it|that)|change (?:it|that) to|"
                        r"instead|correction)\b")
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


def _duration_s(text: str) -> int | None:
    total = 0.0
    if HALF_HOUR.search(text):
        total += 1800
        text = HALF_HOUR.sub(" ", text)
    for m in DURATION.finditer(text):
        raw, unit = m.group(1), m.group(2)
        n = float(NUMBER_WORDS.get(raw, raw)) if raw in NUMBER_WORDS or raw.replace(".", "", 1).isdigit() else 0
        if unit.startswith("h"):
            total += n * 3600
        elif unit.startswith("m"):
            total += n * 60
        else:
            total += n
    return int(round(total)) or None


def _say_seconds(seconds: int) -> str:
    if seconds % 3600 == 0:
        return f"{seconds // 3600}-hour"
    if seconds % 60 == 0:
        return f"{seconds // 60}-minute"
    return f"{seconds}-second"


def _a(phrase: str) -> str:
    return ("an " if re.match(r"(8|11|18|80)\b|8\d\b|[aeiou]", phrase) else "a ") + phrase


def _say_minutes(minutes: float) -> str:
    if minutes < 1:
        return f"{int(round(minutes * 60))} seconds"
    if minutes == int(minutes):
        return f"{int(minutes)} minute{'s' if minutes != 1 else ''}"
    return f"{minutes:g} minutes"


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
        original = " ".join(utterance.strip().split())
        text = original.lower()
        prefs = {p["key"]: p for p in context.get("preferences", [])}
        small_talk = self._small_talk(text.replace("alexa", "aura"), prefs)
        if small_talk is not None:
            return small_talk
        text = WAKE.sub("", text)
        text = text.replace("alexa,", "").replace("alexa", "").replace("aura,", "").strip(" ,.!?")
        self._original = original
        self._session = context.get("session") or {}

        if pending:
            filled = self._fill_pending(text, pending, context, prefs)
            if filled:
                return filled

        for handler in (self._correction, self._follow_up, self._preference, self._reminder, self._timer,
                        self._query, self._routine_with_values, self._multi, self._device, self._routine):
            draft = handler(text, context, prefs)
            if draft is not None:
                return draft

        routines = ", ".join(f"“{r['name']}”" for r in context.get("routines", []))
        return self._draft(
            intent="unknown",
            summary="Request not understood",
            spoken=f"I'm not sure how to help with that yet. I can run your routines ({routines}), "
                   "control lights, the thermostat and the door lock, set reminders and timers, or update your "
                   "preferences.",
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
        if pending.get("slot") == "timer_duration":
            duration = _duration_s(text) or (_first_number(text) * 60 if _first_number(text) else None)
            if duration is None:
                return None
            return self._timer_create(pending.get("label"), int(duration), pending.get("start", True))
        if pending.get("slot") == "timer_which":
            choice = next((o for o in pending.get("options", []) if o.lower() in text), None)
            if choice is None:
                return None
            return self._timer_control(pending["op"], choice, context.get("timers", []))
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
        m = re.search(r"\b(?:remind me|set (?:a|me a) reminder|add a reminder|create a reminder)\b(.*)$", text)
        if not m:
            return None
        rest = m.group(1).strip()
        due_in = None
        if rel := re.search(r"\bin\s+((?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|"
                            r"half an?)\s*-?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|hour))\b", rest):
            secs = _duration_s(rel.group(1))
            due_in = round(secs / 60, 2) if secs else None
            rest = (rest[:rel.start()] + rest[rel.end():]).strip()
        due = _parse_time(rest)
        if due:
            rest = re.sub(r"\s*\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?", " ", rest).strip()
        rest = re.sub(r"^(?:to|that i (?:need to|should|have to)|about|for)\s+", "", rest).strip(" ,.")
        rest = re.sub(r"\s+(?:tonight|today|later)$", "", rest).strip()
        if not rest:
            return self._draft(intent="clarify", summary="Reminder: what for?", spoken="What should I remind you about?",
                               question="What should I remind you about?")
        title = self._cased(rest)
        title = title[0].upper() + title[1:]
        check = None
        device_draft = self._device(rest, context, prefs)
        if device_draft is not None and len(device_draft.actions) == 1 and device_draft.actions[0].action == "set_device":
            act = device_draft.actions[0]
            check = {"device_id": act.device_id, "expected": act.attributes}
        when = f" in {_say_minutes(due_in)}" if due_in else (f" at {due}" if due else "")
        rest = self._cased(rest)
        how = (" When it's due, I'll check the device myself and tell you whether it's actually done."
               if check else
               " I can't observe this one, so when it's due I'll ask you to confirm it." if (due or due_in) else
               " It has no time set, so I won't alert you; it will stay in your list.")
        reminder: dict[str, Any] = {"title": title[:80], "due": due, "note": "Created by voice request.",
                                    "category": "general"}
        if due_in:
            reminder["due_in_minutes"] = due_in
            reminder["due"] = None
        if check:
            reminder["check"] = check
        return self._draft(
            intent="device_control", summary=f"Create reminder: {title}",
            spoken=f"I'll add a reminder to {rest}{when} once you approve.{how}",
            actions=[PlannedAction(action="create_reminder", title=f"Add reminder: {title}{when}"[:120],
                                   rationale="You asked for a reminder." + (
                                       f" AURA will verify it against the {act.device_id.replace('_', ' ')}."
                                       if check else ""),
                                   reminder=reminder)],
        )

    def _cased(self, fragment: str) -> str:
        """Recover the user's capitalisation (names like Luna) for a fragment of the lower-cased text."""
        original = getattr(self, "_original", "")
        pos = original.lower().find(fragment)
        return original[pos:pos + len(fragment)] if pos >= 0 else fragment

    # ----- timers --------------------------------------------------------------------------------
    def _timer(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        timers = context.get("timers", [])
        about_timer = re.search(r"\btimers?\b", text)
        last_was_timer = self._session.get("last_intent") == "timer"
        time_left = re.search(r"\b(how (much|long)|time left|remaining|left on)\b", text)
        if not about_timer and not (time_left and (timers or last_was_timer)) and not (
                last_was_timer and re.fullmatch(r"(pause|resume|unpause|continue|cancel|stop|start) it", text)):
            return None
        label = self._timer_label(text)
        if time_left or re.search(r"\b(check|status of)\b", text):
            return self._timer_plan("check", label, None, "Let me check.")
        if re.search(r"\b(pause|hold)\b", text):
            return self._timer_control("pause", label, timers)
        if re.search(r"\b(resume|unpause|continue)\b", text):
            return self._timer_control("resume", label, timers)
        if re.search(r"\b(cancel|stop|delete|remove|clear|kill|turn off)\b", text):
            return self._timer_control("cancel", label, timers)
        duration = _duration_s(text)
        if re.search(r"\bstart\b", text) and duration is None:
            return self._timer_control("start", label, timers)
        if duration is None:
            return self._draft(intent="clarify", summary="Timer: how long?", spoken="How long should the timer be?",
                               question="How long should the timer be?",
                               pending={"slot": "timer_duration", "label": label,
                                        "start": not re.search(r"\b(create|set up|prepare)\b", text)})
        start = not (re.search(r"\b(create|set up|prepare)\b", text) and not re.search(r"\bstart\b", text))
        return self._timer_create(label, duration, start)

    def _timer_label(self, text: str) -> str | None:
        m = re.search(r"\b(?:called|named|labell?ed)\s+(?:the\s+)?([a-z][a-z' ]{0,24}?)(?:\s+timer)?$", text) or \
            re.search(r"\bfor (?:the |my )?(?!\d|a\b|an\b|one\b|two\b|half\b)([a-z][a-z']{2,20})(?:\s+timer)?$", text) or \
            re.search(r"\b(?:the |my |a |an )?(?!\d)([a-z][a-z']{2,20}) timer\b", text)
        if not m:
            return None
        word = m.group(1).strip()
        if word in {"the", "my", "this", "that", "kitchen", "new", "minute", "minutes", "second", "seconds", "hour",
                    "hours", "start", "set", "create", "pause", "resume", "cancel", "stop", "check", "timer", "it",
                    "one", "two", "five", "ten", "twenty", "thirty", "sixty", "fifteen", "much", "long", "time"} \
                or re.search(r"\d|minute|second|hour", word):
            return None
        return self._cased(word).capitalize()

    def _timer_create(self, label: str | None, duration: int, start: bool) -> PlanDraft:
        name = label or "Timer"
        length = _say_seconds(duration)
        spoken = (f"Starting {_a(length)} timer" + (f" for {label.lower()}" if label else "") + ". I'll confirm once "
                  "it reads back as running." if start else
                  f"I'll create {_a(length)} timer" + (f" for {label.lower()}" if label else "") +
                  ". Say “start the timer” when you're ready.")
        return self._timer_plan("create_and_start" if start else "create", name, duration, spoken,
                                title=f"{'Start' if start else 'Create'} {_a(length)} timer" +
                                      (f" ({label})" if label else ""))

    def _timer_control(self, op: str, label: str | None, timers: list[dict[str, Any]]) -> PlanDraft:
        allowed = {"start": ("created",), "resume": ("paused",), "pause": ("running",),
                   "cancel": ("created", "running", "paused")}[op]
        eligible = [t for t in timers if t["status"] in allowed and
                    (not label or label.lower() in t["label"].lower())]
        word = {"start": "start", "resume": "resume", "pause": "pause", "cancel": "cancel"}[op]
        if not eligible:
            state = {"start": "unstarted", "resume": "paused", "pause": "running", "cancel": "active"}[op]
            return self._draft(intent="unknown", summary=f"No timer to {word}",
                               spoken=f"There's no {state} timer{' called ' + label if label else ''} to {word}.")
        if len(eligible) > 1:
            names = " or ".join(t["label"] for t in eligible)
            return self._draft(intent="clarify", summary=f"Which timer to {word}?",
                               spoken=f"Which timer should I {word}: {names}?",
                               question=f"Which timer should I {word}: {names}?",
                               pending={"slot": "timer_which", "op": op, "options": [t["label"] for t in eligible]})
        t = eligible[0]
        spoken = {"start": f"Starting the {t['label'].lower()} timer.", "resume": f"Resuming the {t['label'].lower()} timer.",
                  "pause": f"Pausing the {t['label'].lower()} timer.",
                  "cancel": f"Cancelling the {t['label'].lower()} timer."}[op]
        return self._timer_plan(op, t["label"], None, spoken + " I'll confirm when it reads back.",
                                timer_id=t["timer_id"])

    def _timer_plan(self, op: str, label: str | None, duration: int | None, spoken: str, title: str | None = None,
                    timer_id: str | None = None) -> PlanDraft:
        timer: dict[str, Any] = {"op": op}
        if label:
            timer["label"] = label
        if duration:
            timer["duration_s"] = duration
        if timer_id:
            timer["timer_id"] = timer_id
        title = title or {"check": "Check " + (f"the {label} timer" if label else "timers"),
                          "start": f"Start the {label} timer", "pause": f"Pause the {label} timer",
                          "resume": f"Resume the {label} timer", "cancel": f"Cancel the {label} timer"}[op]
        return self._draft(intent="query" if op == "check" else "timer", summary=title, spoken=spoken,
                           actions=[PlannedAction(action="timer", title=title, timer=timer,
                                                  rationale="You asked for this timer.")])

    # ----- multi-action requests -----------------------------------------------------------------
    def _multi(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        """“Turn off the bedroom lights, set the thermostat to 75 and lock the front door” → one plan, one step
        per action, each verified on its own. Anything not understood is asked about, never dropped."""
        clauses = []
        for part in CLAUSE_SPLIT.split(text):
            part = (part or "").strip(" ,.")
            if not part:
                continue
            # "…, the porch light and the white noise machine": a verb-less list continues the previous verb.
            if not re.match(rf"^(?:please\s+)?{VERBS}\b", part) and " and " in part:
                clauses += [p.strip() for p in re.split(r"\s+and\s+", part) if p.strip()]
            else:
                clauses.append(part)
        if len(clauses) < 2:
            return None
        verb = None
        parsed: list[tuple[str, PlanDraft | None]] = []
        for clause in clauses:
            if re.match(rf"^(?:please\s+)?{VERBS}\b", clause):
                verb = re.match(r"^(?:please\s+)?((?:turn|switch) (?:on|off)|\w+)", clause).group(1)
            elif verb:
                clause = f"{verb} {clause}"
            draft = None
            for handler in (self._timer, self._device):
                draft = handler(clause, context, prefs)
                if draft is not None:
                    break
            parsed.append((clause, draft))
        understood = [d for _, d in parsed if d is not None]
        if len(understood) < 2:
            return None
        unknown = [c for c, d in parsed if d is None]
        unclear = [d for _, d in parsed if d is not None and d.intent in ("clarify", "unknown")]
        if unknown or unclear:
            ok = [d.summary for _, d in parsed if d is not None and d.actions]
            issues = [f"“{c}”" for c in unknown] + [d.clarification_question or d.spoken_response for d in unclear]
            q = (f"I understood {', '.join(ok) or 'part of that'}, but not " + "; ".join(issues) +
                 " Could you say the whole request again with that part rephrased?")
            return self._draft(intent="clarify", summary="Part of the request needs clarifying", spoken=q, question=q)
        actions = [a for d in understood for a in d.actions]
        names = "; ".join(a.title[0].lower() + a.title[1:] for a in actions)
        return self._draft(intent="device_control", summary=f"{len(actions)} actions",
                           spoken=f"Here's the plan: {names}. I'll do it once you approve, and check each one.",
                           actions=actions)

    # ----- conversation: follow-ups and corrections ----------------------------------------------
    def _follow_up(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        last = self._session.get("last_run")
        if STATUS_Q.search(text):
            if not last:
                return self._draft(intent="unknown", summary="Nothing to report",
                                   spoken="We haven't run anything in this conversation yet.")
            status = last["status"]
            name = last["summary"]
            if status == "AWAITING_APPROVAL":
                spoken = f"Not yet. “{name}” is still waiting for your approval; nothing has run."
            elif status in ("RUNNING", "PAUSED"):
                waiting = [s["title"] for s in last["steps"] if s["status"] == "AWAITING_APPROVAL"]
                spoken = (f"It's still in progress. “{waiting[0]}” is waiting for your confirmation."
                          if waiting else f"“{name}” is still in progress; I'll report once each step is checked.")
            elif status == "COMPLETED":
                spoken = f"Yes. {last['final_report']} Each step was confirmed by an independent state read."
            elif status == "CANCELLED":
                spoken = f"It was cancelled. {last['final_report'] or ''}".strip()
            else:
                spoken = f"Not completely. {last['final_report']}"
            return self._draft(intent="unknown", summary="Status of the last request", spoken=spoken)
        devices = self._session.get("last_devices") or []
        m = re.match(r"^(?:what about|how about|and|also|same for|same with|now)\s+(?:the\s+)?(.+)$", text)
        if m and last:
            target = m.group(1)
            device = next((d for room, d in ROOM_DEVICES.items() if room in target), None)
            if device is None and re.search(r"door|lock", target):
                device = "front_door"
            if device is None and re.search(r"thermostat|temperature", target):
                device = "thermostat"
            if device is None:
                return None
            if last["intent"] == "query":
                return self._draft(intent="query", summary="Check device state", spoken="Let me check.",
                                   actions=[PlannedAction(action="read_device", device_id=device,
                                                          title=f"Read {device.replace('_', ' ')}",
                                                          rationale="Follow-up to your last question.")])
            prev = next((s for s in last["steps"] if s["action"] == "set_device"), None)
            if prev and device in LIGHT_NAMES and prev["params"]["device_id"] in LIGHT_NAMES:
                attrs = prev["params"]["attributes"]
                draft = self._lights_plan([device], attrs.get("power", "on"), attrs.get("brightness"))
                draft.spoken_response = f"Same for the {LIGHT_NAMES[device]}: " + draft.spoken_response
                return draft
        if re.search(r"\b(it|them|that)\b", text) and len(devices) == 1 and not re.search(r"timer", text):
            name = {**LIGHT_NAMES, "front_door": "front door", "thermostat": "thermostat",
                    "white_noise": "white noise machine"}.get(devices[0])
            wants = ("front_door" if re.search(r"\block|unlock|locked", text) else
                     "thermostat" if re.search(r"temp|degrees|warm|cool|\d", text) else
                     "power" if re.search(r"\b(on|off)\b", text) else None)
            compatible = (wants is None or wants == devices[0] or
                          (wants == "power" and devices[0] in (*LIGHT_NAMES, "white_noise")))
            if name and compatible and re.search(rf"\b{VERBS}\b|^(is|are|what)", text):
                resolved = re.sub(r"\b(it|them|that)\b", f"the {name}", text, count=1)
                if resolved != text:
                    for handler in (self._query, self._device):
                        draft = handler(resolved, context, prefs)
                        if draft is not None:
                            draft.spoken_response = draft.spoken_response
                            return draft
        return None

    def _correction(self, text: str, context: dict[str, Any], prefs: dict[str, Any]) -> PlanDraft | None:
        """“Actually, make it 74” / “No, the bedroom lights”: change the last plan instead of starting over."""
        last = self._session.get("last_run")
        if not last or not CORRECTION.search(text) or re.search(
                r"\b(prefer|preference|from now on|remember|always|by default|my usual|bed ?time|at work|away)\b", text):
            return None
        steps = last["steps"]
        n = _first_number(text)
        temps = _explicit_temperatures(text) or ([n] if n is not None else [])
        changed: list[dict[str, Any]] = []
        new_steps = []
        room = next((d for r, d in ROOM_DEVICES.items() if r in text), None)
        for st in steps:
            st = {**st, "params": {**st["params"], "attributes": dict(st["params"].get("attributes") or {})}}
            attrs = st["params"]["attributes"]
            if st["action"] == "set_device" and "setpoint_f" in attrs and temps and not room:
                lo, hi = _setpoint_range(context)
                if not lo <= temps[0] <= hi:
                    return self._draft(intent="clarify", summary="Temperature out of range",
                                       spoken=f"The thermostat supports {lo} to {hi}°F. What temperature would you like?",
                                       question=f"The thermostat supports {lo}–{hi}°F. What temperature would you like?")
                changed.append({"from": f"{attrs['setpoint_f']}°F", "to": f"{temps[0]}°F"})
                attrs["setpoint_f"] = temps[0]
                st["title"] = f"Set the thermostat to {temps[0]}°F"
            elif st["action"] == "set_device" and "brightness" in attrs and n is not None and "%" in text or \
                    (st["action"] == "set_device" and "brightness" in attrs and re.search(r"percent", text)):
                changed.append({"from": f"{attrs['brightness']}%", "to": f"{n}%"})
                attrs["brightness"] = n
                st["title"] = f"Set the {LIGHT_NAMES.get(st['params']['device_id'], 'lights')} to {n}%"
            elif st["action"] == "set_device" and room and st["params"]["device_id"] in LIGHT_NAMES \
                    and st["params"]["device_id"] != room:
                changed.append({"from": LIGHT_NAMES[st["params"]["device_id"]], "to": LIGHT_NAMES[room]})
                st["params"]["device_id"] = room
                power = attrs.get("power", "on")
                st["title"] = (f"Set the {LIGHT_NAMES[room]} to {attrs['brightness']}%" if "brightness" in attrs
                               else f"Turn {power} the {LIGHT_NAMES[room]}")
            new_steps.append(st)
        if not changed:
            return None
        change_text = ", ".join(f"{c['from']} → {c['to']}" for c in changed)
        preview = last["status"] == "AWAITING_APPROVAL"
        keep = new_steps if preview else [st for st in new_steps if any(
            st["title"] != old["title"] for old in steps if old is not None) and st["title"] not in
            [o["title"] for o in steps]]
        actions = []
        for st in keep:
            if st["action"] == "set_device":
                actions.append(PlannedAction(action="set_device", device_id=st["params"]["device_id"],
                                             attributes=st["params"]["attributes"], title=st["title"],
                                             rationale="Corrected at your request.",
                                             provenance=f"Your correction: {change_text}"))
            elif st["action"] == "create_reminder":
                actions.append(PlannedAction(action="create_reminder", title=st["title"],
                                             reminder=st["params"]["reminder"], rationale="Kept from your plan."))
            elif st["action"] == "read_device":
                actions.append(PlannedAction(action="read_device", device_id=st["params"]["device_id"],
                                             title=st["title"], rationale="Kept from your plan."))
            elif st["action"] == "update_preference":
                actions.append(PlannedAction(action="update_preference", title=st["title"],
                                             preference_key=st["params"]["key"],
                                             preference_value=st["params"]["value"], rationale="Kept from your plan."))
        draft = self._draft(
            intent="device_control", summary=f"{actions[0].title if len(actions) == 1 else last['summary']} (corrected)",
            spoken=(f"Got it: {change_text}. I replaced the plan; nothing from the old one ran. Approve when ready."
                    if preview else f"Got it: {change_text}. Here's a new plan for just that change; approve when ready."),
            actions=actions)
        if preview:
            draft.replaces_run_id = last["run_id"]
            draft.routine_id = last.get("routine_id")
        return draft

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
            spoken=f"I'll set the thermostat to {n}°F once you approve, then check that it actually changed.",
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
        what = (f"set the {names} to {brightness}%" if brightness is not None and power == "on"
                else f"turn {power} the {names}")
        return self._draft(intent="device_control", summary=f"Lights: {names} {power}",
                           spoken=f"I'll {what} once you approve.", actions=actions)

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
                intent="device_control", summary="Unlock the front door",
                spoken="Unlocking the front door needs your confirmation first.",
                actions=[PlannedAction(action="set_device", device_id="front_door", attributes={"locked": False},
                                       title="Unlock the front door", rationale="You asked to unlock it.")])
        if re.search(r"\block\b", text) and re.search(r"door", text):
            return self._draft(
                intent="device_control", summary="Lock the front door",
                spoken="I'll lock the front door after you confirm, then check that it's locked.",
                actions=[PlannedAction(action="set_device", device_id="front_door", attributes={"locked": True},
                                       title="Lock the front door", rationale="You asked to lock it.")])
        if re.search(r"white ?noise|sound machine", text) and (m := re.search(r"\b(on|off)\b", text)):
            return self._draft(
                intent="device_control", summary=f"White noise {m.group(1)}",
                spoken=f"I'll turn the white-noise machine {m.group(1)} once you approve.",
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
