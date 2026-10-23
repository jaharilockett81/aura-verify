"""Conversation features: multi-action requests, timers, corrections, follow-ups and wake words.

Everything runs through the real engine and MCP tools (in-process transport); nothing here is scripted output.
"""

import pytest
from test_engine import approve_all, command_count, plan

from aura.models import Risk, RunStatus, StepStatus

MULTI = "Turn off the bedroom lights, set the thermostat to 75 degrees, and lock the front door."


# ----- multi-action ------------------------------------------------------------------------------------
async def test_multi_action_request_is_one_plan_with_existing_approvals(engine, services, session_id):
    run = services.ledger.get_run(await plan(engine, session_id, MULTI))
    assert run.status == RunStatus.AWAITING_APPROVAL and command_count(services) == 0
    assert [s.title for s in run.steps] == ["Turn off the bedroom lights", "Set the thermostat to 75°F",
                                            "Lock the front door"]
    assert [s.risk for s in run.steps] == [Risk.ROUTINE, Risk.ROUTINE, Risk.SENSITIVE]


async def test_multi_action_executes_and_verifies_each_step(engine, services, session_id):
    run = await approve_all(engine, await plan(engine, session_id, MULTI))
    assert run.status == RunStatus.COMPLETED
    assert all(s.status == StepStatus.VERIFIED for s in run.steps)
    for s in run.steps:  # each step has its own independent verification evidence
        assert any(e.kind == "verification" for e in s.evidence)
    state = {d: services.sim.read_state(d)["state"] for d in ("bedroom_lights", "thermostat", "front_door")}
    assert state["bedroom_lights"]["power"] == "off"
    assert state["thermostat"]["setpoint_f"] == 75
    assert state["front_door"]["locked"] is True


async def test_multi_action_with_unclear_part_asks_instead_of_dropping(engine, session_id):
    out = await engine.handle_utterance(session_id, "Turn off the porch light, set the thermostat, and lock the door")
    assert out["run"] is None
    assert "What temperature" in out["message"]["text"]


async def test_verbless_list_continues_previous_verb(engine, services, session_id):
    run = services.ledger.get_run(await plan(
        engine, session_id, "Turn off the bedroom lights, the porch light and the white noise machine"))
    assert [s.params["device_id"] for s in run.steps] == ["bedroom_lights", "porch_light", "white_noise"]
    assert all(s.params["attributes"] == {"power": "off"} for s in run.steps)


# ----- timers --------------------------------------------------------------------------------------------
async def test_timer_lifecycle_through_mcp_with_read_back(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "Set a pasta timer for 8 minutes")
    run = await engine.wait_idle(out["run"]["id"])
    assert run.status == RunStatus.COMPLETED  # timers run without approval; still verified by read-back
    step = run.steps[0]
    assert step.target.startswith("timer:") and step.status == StepStatus.VERIFIED
    assert "running" in [e for e in step.evidence if e.kind == "verification"][0].summary
    timer_id = step.target.split(":")[1]
    assert services.timers.get(timer_id)["status"] == "running"

    for text, status in [("Pause the pasta timer", "paused"), ("Resume the timer", "running"),
                         ("Cancel the pasta timer", "cancelled")]:
        out = await engine.handle_utterance(session_id, text)
        run = await engine.wait_idle(out["run"]["id"])
        assert run.status == RunStatus.COMPLETED, text
        assert services.timers.get(timer_id)["status"] == status, text


async def test_create_then_start_and_check_time_left(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "Create a timer for 20 minutes called laundry")
    await engine.wait_idle(out["run"]["id"])
    timer = services.timers.list()[0]
    assert timer["status"] == "created" and timer["label"] == "Laundry"
    out = await engine.handle_utterance(session_id, "Start the laundry timer")
    await engine.wait_idle(out["run"]["id"])
    assert services.timers.get(timer["timer_id"])["status"] == "running"
    out = await engine.handle_utterance(session_id, "How much time is left on the laundry timer?")
    run = await engine.wait_idle(out["run"]["id"])
    assert run.steps[0].risk == Risk.READ_ONLY
    final = services.ledger.messages(session_id)[-1]["text"]
    assert final.startswith("Laundry: 19 minutes") or final.startswith("Laundry: 20 minutes")


async def test_timer_ambiguity_and_missing_length_ask(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "Set a timer")
    assert out["run"] is None and "How long" in out["message"]["text"]
    out = await engine.handle_utterance(session_id, "5 minutes")
    await engine.wait_idle(out["run"]["id"])
    out = await engine.handle_utterance(session_id, "Start a 10 minute tea timer")
    await engine.wait_idle(out["run"]["id"])
    out = await engine.handle_utterance(session_id, "Pause the timer")
    assert out["run"] is None and "Which timer" in out["message"]["text"]
    out = await engine.handle_utterance(session_id, "tea")
    await engine.wait_idle(out["run"]["id"])
    assert [t["status"] for t in services.timers.list() if t["label"] == "Tea"] == ["paused"]


async def test_pausing_when_nothing_runs_is_answered_honestly(engine, session_id):
    out = await engine.handle_utterance(session_id, "Pause the timer")
    assert out["run"] is None and "no running timer" in out["message"]["text"]


# ----- corrections and follow-ups ----------------------------------------------------------------------
async def test_correction_replaces_unapproved_plan(engine, services, session_id):
    first = await plan(engine, session_id, "Set the thermostat to 75")
    out = await engine.handle_utterance(session_id, "Actually, make it 74")
    assert out["run"]["steps"][0]["params"]["attributes"] == {"setpoint_f": 74}
    old = services.ledger.get_run(first)
    assert old.status == RunStatus.CANCELLED and "nothing was sent" in old.final_report.lower()
    assert command_count(services) == 0


async def test_correction_after_execution_plans_only_the_change(engine, services, session_id):
    await approve_all(engine, await plan(engine, session_id, MULTI))
    out = await engine.handle_utterance(session_id, "No, 73 degrees")
    steps = out["run"]["steps"]
    assert [s["title"] for s in steps] == ["Set the thermostat to 73°F"]
    assert out["run"]["status"] == "AWAITING_APPROVAL"


async def test_correction_does_not_swallow_preference_statements(engine, session_id):
    await plan(engine, session_id, "Set the thermostat to 75")
    out = await engine.handle_utterance(session_id, "Actually, I prefer my bedtime temperature at 70 degrees.")
    assert out["run"]["intent"] == "preference_update"


async def test_follow_up_status_question_reports_truthfully(engine, session_id):
    out = await engine.handle_utterance(session_id, "Did it work?")
    assert "haven't run anything" in out["message"]["text"]
    run_id = await plan(engine, session_id, "Turn on the porch light")
    out = await engine.handle_utterance(session_id, "Did it work?")
    assert "waiting for your approval" in out["message"]["text"]
    await approve_all(engine, run_id)
    out = await engine.handle_utterance(session_id, "Did it work?")
    assert out["message"]["text"].startswith("Yes.") and "1 of 1 steps verified" in out["message"]["text"]


async def test_follow_up_what_about_and_pronouns(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "Is the porch light on?")
    await engine.wait_idle(out["run"]["id"])
    out = await engine.handle_utterance(session_id, "What about the bedroom?")
    assert out["run"]["steps"][0]["params"]["device_id"] == "bedroom_lights"
    await engine.wait_idle(out["run"]["id"])
    out = await engine.handle_utterance(session_id, "Turn it on")
    assert out["run"]["steps"][0]["params"] == {"device_id": "bedroom_lights", "attributes": {"power": "on"}}


@pytest.mark.parametrize("text", ["Hey Aura, lock the front door", "OK Alexa lock the front door",
                                  "Aura: lock the front door", "Alexa, lock the front door"])
async def test_wake_word_variations(engine, session_id, text):
    out = await engine.handle_utterance(session_id, text)
    assert out["run"]["steps"][0]["params"]["attributes"] == {"locked": True}


async def test_spoken_plan_replies_never_claim_success_before_approval(engine, session_id):
    for text in ("Turn on the porch light", "Set the thermostat to 70", "Lock the front door", MULTI):
        out = await engine.handle_utterance(session_id, text)
        reply = out["message"]["text"].lower()
        assert "approve" in reply or "confirm" in reply, reply
        assert not reply.startswith(("turning", "setting", "locking", "done"))
