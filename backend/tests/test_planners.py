"""Planner tests. The Bedrock planner is exercised with a stub client: these tests do NOT call AWS."""

import pytest

from aura.engine import WorkflowEngine
from aura.planner.bedrock import BedrockPlanner
from aura.planner.local import LocalPlanner


class StubBedrock:
    def __init__(self, tool_input=None, error=None):
        self.tool_input, self.error, self.requests = tool_input, error, []

    def converse(self, **request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return {"output": {"message": {"content": [{"toolUse": {"name": "submit_plan", "input": self.tool_input,
                                                                "toolUseId": "t1"}}]}},
                "usage": {"inputTokens": 900, "outputTokens": 120}}


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


async def test_bedrock_planner_parses_forced_tool_call(context):
    stub = StubBedrock({"intent": "device_control", "summary": "Porch light on",
                        "spoken_response": "I'll turn on the porch light once you approve.",
                        "actions": [{"action": "set_device", "title": "Turn on the porch light",
                                     "device_id": "porch_light", "attributes": {"power": "on"}}]})
    draft = await BedrockPlanner("test-model", "us-east-1", client=stub).plan("porch light on", context, None)
    assert draft.planner == "bedrock"
    assert "test-model" in draft.planner_detail and "900 in" in draft.planner_detail
    assert draft.actions[0].device_id == "porch_light"
    req = stub.requests[0]
    assert req["toolConfig"]["toolChoice"] == {"any": {}}
    assert req["inferenceConfig"]["temperature"] == 0


async def test_bedrock_routine_actions_come_from_memory_not_model(context):
    stub = StubBedrock({"intent": "routine", "routine_id": "bedtime", "summary": "Bedtime",
                        "spoken_response": "Here's your bedtime plan.",
                        "actions": [{"action": "set_device", "title": "evil", "device_id": "front_door",
                                     "attributes": {"locked": False}}]})
    draft = await BedrockPlanner("m", "us-east-1", client=stub).plan("bedtime", context, None)
    assert draft.actions == []  # routine steps are expanded from stored memory by the engine


async def test_engine_falls_back_to_local_and_discloses_it(settings, services, gateway, session_id):
    failing = BedrockPlanner("m", "us-east-1", client=StubBedrock(error=RuntimeError("AccessDenied")))
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=failing)
    out = await eng.handle_utterance(session_id, "Get everything prepared for bedtime")
    run = out["run"]
    assert run["planner"] == "local"
    assert "Bedrock call failed" in run["planner_detail"] and "AccessDenied" in run["planner_detail"]


async def test_engine_rejects_hallucinated_device_from_llm(settings, services, gateway, session_id):
    stub = StubBedrock({"intent": "device_control", "summary": "Garage", "spoken_response": "Opening.",
                        "actions": [{"action": "set_device", "title": "Open garage", "device_id": "garage_door",
                                     "attributes": {"open": True}}]})
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=BedrockPlanner("m", "r", client=stub))
    out = await eng.handle_utterance(session_id, "open the garage")
    assert out["run"] is None
    assert "Unknown device 'garage_door'" in out["message"]["text"]


async def test_bedrock_retries_without_forced_tool_choice(context):
    class Picky(StubBedrock):
        def converse(self, **request):
            if "toolChoice" in request["toolConfig"]:
                self.requests.append(request)
                raise RuntimeError("ValidationException: toolChoice is not supported by this model")
            return super().converse(**request)

    stub = Picky({"intent": "routine", "routine_id": "bedtime", "summary": "Bedtime", "spoken_response": "Plan."})
    draft = await BedrockPlanner("m", "us-east-1", client=stub).plan("bedtime", context, None)
    assert draft.routine_id == "bedtime"
    assert "toolChoice=any unsupported" in draft.planner_detail
    assert len(stub.requests) == 2


async def test_string_preference_value_from_llm_is_coerced(settings, services, gateway, session_id):
    stub = StubBedrock({"intent": "preference_update", "summary": "Pref", "spoken_response": "Saving.",
                        "actions": [{"action": "update_preference", "title": "Bedtime 70",
                                     "preference_key": "bedtime_temperature_f", "preference_value": "70"}]})
    eng = WorkflowEngine(settings, services.ledger, gateway, planner=BedrockPlanner("m", "r", client=stub))
    out = await eng.handle_utterance(session_id, "I prefer 70 at bedtime")
    run = await eng.wait_idle(out["run"]["id"])
    assert run.status == "COMPLETED"
    assert services.memory.get_preference("bedtime_temperature_f")["value"] == 70
