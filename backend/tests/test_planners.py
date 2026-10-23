"""Planner tests: the local rule-based planner, and how the engine treats whatever a planner returns."""

import pytest

from aura.engine import WorkflowEngine
from aura.models import PlanDraft, PlannedAction
from aura.planner.local import LocalPlanner


class ScriptedPlanner:
    """Stands in for any pluggable planner: returns a fixed draft, or raises."""

    name = "scripted"

    def __init__(self, draft=None, error=None):
        self.draft, self.error = draft, error

    async def plan(self, utterance, context, pending):
        if self.error:
            raise self.error
        return self.draft


@pytest.fixture
async def context(gateway):
    return (await gateway.call("get_household_context", {})).data


@pytest.mark.parametrize("text,routine", [
    ("Start my overnight work routine.", "overnight_shift"),
    ("Alexa, prepare the house before my overnight shift.", "overnight_shift"),
    ("Make sure the apartment is ready before I leave.", "leaving_home"),
    ("Get everything prepared for bedtime.", "bedtime"),
])
async def test_local_planner_matches_prompt_examples(context, text, routine):
    draft = await LocalPlanner().plan(text, context, None)
    assert draft.intent == "routine" and draft.routine_id == routine
    assert draft.planner == "local"


async def test_local_planner_preference_vs_command(context):
    pref = await LocalPlanner().plan("Actually, I prefer my bedtime temperature at 70 degrees.", context, None)
    assert pref.intent == "preference_update"
    assert (pref.actions[0].preference_key, pref.actions[0].preference_value) == ("bedtime_temperature_f", 70)
    cmd = await LocalPlanner().plan("set the thermostat to 70", context, None)
    assert cmd.intent == "device_control" and cmd.actions[0].attributes == {"setpoint_f": 70}


async def test_engine_falls_back_to_local_and_discloses_it(settings, services, gateway, session_id):
    failing = ScriptedPlanner(error=RuntimeError("AccessDenied"))
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=failing)
    out = await eng.handle_utterance(session_id, "Get everything prepared for bedtime")
    run = out["run"]
    assert run["planner"] == "local"
    assert "primary planner failed" in run["planner_detail"] and "AccessDenied" in run["planner_detail"]


async def test_engine_rejects_unknown_device_from_a_planner(settings, services, gateway, session_id):
    stub = ScriptedPlanner(PlanDraft(intent="device_control", summary="Garage", spoken_response="Opening.",
                                     actions=[PlannedAction(action="set_device", title="Open garage",
                                                            device_id="garage_door", attributes={"open": True})]))
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=stub)
    out = await eng.handle_utterance(session_id, "open the garage")
    assert out["run"] is None
    assert "Unknown device 'garage_door'" in out["message"]["text"]


async def test_string_preference_value_from_a_planner_is_coerced(settings, services, gateway, session_id):
    stub = ScriptedPlanner(PlanDraft(intent="preference_update", summary="Pref", spoken_response="Saving.",
                                     actions=[PlannedAction(action="update_preference", title="Bedtime 70",
                                                            preference_key="bedtime_temperature_f",
                                                            preference_value="70")]))
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=stub)
    out = await eng.handle_utterance(session_id, "I prefer 70 at bedtime")
    run = await eng.wait_idle(out["run"]["id"])
    assert run.status == "COMPLETED"
    assert services.memory.get_preference("bedtime_temperature_f")["value"] == 70
