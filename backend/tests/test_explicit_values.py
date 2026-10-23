"""Regression tests: an explicit value in a routine request must not be silently replaced by a saved preference.

Bug (2026-10-23): "…before my overnight shift … 75 degrees" planned and executed the thermostat at the saved 72°F.
"""

import pytest

from aura.models import RunStatus, StepStatus
from aura.planner.local import LocalPlanner

from test_engine import approve_all, plan, step


@pytest.mark.parametrize("text", [
    "Alexa, prepare the house before my overnight shift and set the temperature to 75.",
    "Prepare the house before my overnight shift, set the thermostat to 75 degrees.",
    "Get the house ready for my overnight shift at 75°F.",
    "Run my overnight shift routine but keep it at 75 degrees.",
])
async def test_explicit_temperature_overrides_routine_default(engine, services, session_id, text):
    run_id = await plan(engine, session_id, text)
    run = services.ledger.get_run(run_id)
    assert run.routine_id == "overnight_shift"
    assert len(run.steps) == 5  # the rest of the routine is kept
    thermo = step(run, "Set the thermostat")
    assert thermo.title == "Set the thermostat to 75°F"
    assert thermo.params["attributes"] == {"setpoint_f": 75}
    assert thermo.expected == {"setpoint_f": 75}
    assert "From your request: 75°F" in thermo.provenance and "72°F" in thermo.provenance
    assert "75°F" in services.ledger.messages(session_id)[-1]["text"]


async def test_explicit_temperature_is_executed_and_verified_without_changing_preference(engine, services, session_id):
    run_id = await plan(engine, session_id, "Prepare the house before my overnight shift at 75 degrees.")
    run = await approve_all(engine, run_id)
    assert run.status == RunStatus.COMPLETED
    assert step(run, "Set the thermostat").status == StepStatus.VERIFIED
    assert services.sim.read_state("thermostat")["state"]["setpoint_f"] == 75
    prefs = {p["key"]: p["value"] for p in services.memory.preferences()}
    assert prefs["away_temperature_f"] == 72  # a one-off request is not a saved preference


async def test_routine_without_value_still_uses_saved_preference(engine, services, session_id):
    run = services.ledger.get_run(await plan(engine, session_id, "Alexa, prepare the house before my overnight shift."))
    assert step(run, "Set the thermostat").params["attributes"] == {"setpoint_f": 72}


async def test_unsupported_temperature_asks_instead_of_overriding(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "Prepare the house before my overnight shift at 95 degrees.")
    assert out["run"] is None
    assert "60–80°F" in out["message"]["text"] and "95°F" in out["message"]["text"]
    out = await engine.handle_utterance(session_id, "75")
    run = services.ledger.get_run(out["run"]["id"])
    assert run.routine_id == "overnight_shift"
    assert step(run, "Set the thermostat").params["attributes"] == {"setpoint_f": 75}


async def test_two_temperatures_ask_which_one(engine, session_id):
    out = await engine.handle_utterance(session_id, "Overnight shift please, 74 or 75 degrees.")
    assert out["run"] is None
    assert "74°F" in out["message"]["text"] and "75°F" in out["message"]["text"]


async def test_explicit_temperature_added_when_routine_has_no_thermostat_step(engine, services, session_id):
    from aura.engine import apply_overrides
    from aura.models import PlannedAction

    actions = [PlannedAction(action="set_device", device_id="porch_light", attributes={"power": "on"}, title="Porch")]
    out = apply_overrides(actions, {"thermostat": {"setpoint_f": 70}})
    assert [a.device_id for a in out] == ["porch_light", "thermostat"]
    assert out[1].attributes == {"setpoint_f": 70} and out[1].title == "Set the thermostat to 70°F"


# ----- greetings -----------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", ["Hi Aura", "hello aura!", "Hi", "Hello there, Aura. How are you?", "Good morning, Alexa"])
async def test_greeting_gets_honest_reply_and_no_run(engine, session_id, text):
    out = await engine.handle_utterance(session_id, text)
    assert out["run"] is None
    reply = out["message"]["text"]
    assert reply.startswith("Hi") and "local rule-based planner" in reply and "can't chat freely" in reply


@pytest.mark.parametrize("text", ["Aura", "Aura?", "Hey Aura", "hey aura!", "OK Aura."])
async def test_wake_word_alone_answers_by_name_and_listens(engine, session_id, text):
    out = await engine.handle_utterance(session_id, text)
    assert out["run"] is None
    assert out["message"]["text"] == "Yes, Jahari?"  # name comes from the saved user_name preference
    assert out["message"]["meta"]["listen"] is True


async def test_wake_word_answer_uses_the_saved_name(engine, services, session_id):
    services.memory.set_preference("user_name", "Sam", source="user")
    out = await engine.handle_utterance(session_id, "Aura")
    assert out["message"]["text"] == "Yes, Sam?"


async def test_greeting_followed_by_request_still_plans(gateway):
    context = (await gateway.call("get_household_context", {})).data
    draft = await LocalPlanner().plan("Hey Aura, get everything prepared for bedtime.", context, None)
    assert draft.intent == "routine" and draft.routine_id == "bedtime"
