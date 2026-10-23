"""Verified Reminders: due-time alerts, honest delivery status, user-confirmed vs independently verified outcomes,
and recovery that only happens through an approved plan."""

import dataclasses

import pytest
from test_engine import approve_all, plan

from aura.alerts import AlertError, AlertWorkflow
from aura.models import RunStatus


@pytest.fixture
def alerts(settings, services, gateway, engine):
    return AlertWorkflow(dataclasses.replace(settings, delivery_ack_s=0.2), services, gateway, engine)


async def create(engine, session_id, text):
    """Plan and approve a reminder request; return the stored reminder."""
    run = await approve_all(engine, await plan(engine, session_id, text))
    assert run.status == RunStatus.COMPLETED, run.final_report
    rid = run.steps[0].target.split(":")[1]
    return rid


async def test_reminder_with_device_check_is_parsed_and_stored(engine, services, session_id):
    rid = await create(engine, session_id, "Remind me to lock the front door at 10 pm")
    rem = services.memory.get_reminder(rid)
    assert rem["due"] == "22:00" and rem["status"] == "scheduled" and rem["due_at"]
    assert rem["check"] == {"device_id": "front_door", "expected": {"locked": True}}
    assert rem["delivery"]["status"] == "NOT_DUE" and rem["outcome"] == "OPEN"


async def test_due_with_no_tab_open_is_recorded_as_not_delivered(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    rem = await alerts.fire_now(rid)
    assert rem["status"] == "due"
    assert rem["delivery"]["status"] == "NOT_DELIVERED"
    assert "not shown or spoken" in rem["delivery"]["detail"]
    assert any(h["kind"] == "demo" for h in rem["history"])  # demo trigger is labeled in the evidence


async def test_delivery_needs_a_tab_to_confirm(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    tab = services.ledger.bus.subscribe()
    try:
        rem = await alerts.fire_now(rid)
        assert rem["delivery"]["status"] == "PENDING"
        assert (await tab.get())["type"] == "reminder.due"
        rem = alerts.delivered(rid, spoken=True)
        assert rem["delivery"]["status"] == "DELIVERED_IN_APP" and rem["delivery"]["spoken"] is True
    finally:
        services.ledger.bus.unsubscribe(tab)


async def test_unacknowledged_alert_becomes_unconfirmed(engine, services, alerts, session_id):
    import asyncio
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    tab = services.ledger.bus.subscribe()
    try:
        await alerts.fire_now(rid)
        await asyncio.sleep(0.3)
        await alerts.tick()
        assert services.memory.get_reminder(rid)["delivery"]["status"] == "UNCONFIRMED"
    finally:
        services.ledger.bus.unsubscribe(tab)


async def test_unobservable_task_is_user_confirmed_not_verified(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    await alerts.fire_now(rid)
    rem = await alerts.done(rid)
    assert rem["outcome"] == "USER_CONFIRMED" and rem["status"] == "closed"
    assert "not verified" in rem["history"][-1]["summary"]


async def test_check_verifies_independently_when_due(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to turn off the porch light in 30 minutes")
    services.sim.seed(force=True)  # porch light starts off in the demo household
    rem = await alerts.fire_now(rid)
    assert services.sim.read_state("porch_light")["state"]["power"] == "off"
    assert rem["outcome"] == "VERIFIED" and rem["status"] == "closed"
    ver = [h for h in rem["history"] if h["kind"] == "verification"][-1]
    assert ver["source"] == "verify_action" and ver["data"]["verdict"] == "VERIFIED"


async def test_marked_done_but_device_disagrees_is_a_mismatch(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to lock the front door in 30 minutes")
    rem = await alerts.fire_now(rid)
    assert rem["outcome"] == "MISMATCH"  # the demo door starts unlocked
    rem = await alerts.done(rid)
    assert rem["outcome"] == "MISMATCH" and rem["status"] == "due"
    assert "You marked this done, but an independent read shows locked = False" in rem["history"][-1]["summary"]


async def test_fix_goes_through_an_approved_plan_then_rechecks(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to lock the front door in 30 minutes")
    await alerts.fire_now(rid)
    out = await alerts.fix(rid, session_id)
    run = out["run"]
    assert run["status"] == "AWAITING_APPROVAL" and run["steps"][0]["title"] == "Lock the front door"
    assert services.sim.read_state("front_door")["state"]["locked"] is False  # nothing sent without approval
    assert out["reminder"]["outcome"] == "RECOVERING"
    await alerts.tick()  # run not finished yet: no re-check
    assert services.memory.get_reminder(rid)["outcome"] == "RECOVERING"
    finished = await approve_all(engine, run["id"])
    assert finished.status == RunStatus.COMPLETED
    await alerts.tick()
    rem = services.memory.get_reminder(rid)
    assert rem["outcome"] == "VERIFIED" and rem["status"] == "closed"
    assert "After the approved fix" in rem["history"][-1]["summary"]


async def test_declined_fix_leaves_reminder_unverified(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to lock the front door in 30 minutes")
    await alerts.fire_now(rid)
    out = await alerts.fix(rid, session_id)
    await engine.cancel_run(out["run"]["id"])
    await alerts.tick()
    rem = services.memory.get_reminder(rid)
    assert rem["outcome"] == "MISMATCH"
    assert "cancelled" in rem["history"][-1]["summary"]


async def test_cannot_fix_unobservable_or_passing_reminders(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    with pytest.raises(AlertError):
        await alerts.fix(rid, session_id)


async def test_snooze_and_dismiss(engine, services, alerts, session_id):
    rid = await create(engine, session_id, "Remind me to feed Luna in 30 minutes")
    await alerts.fire_now(rid)
    rem = alerts.snooze(rid, 10)
    assert rem["status"] == "scheduled" and rem["delivery"]["status"] == "NOT_DUE"
    rem = alerts.dismiss(rid)
    assert rem["outcome"] == "DISMISSED" and "Not recorded as done" in rem["history"][-1]["summary"]


async def test_finished_timer_delivery_is_tracked(engine, services, alerts, session_id):
    import asyncio
    out = await engine.handle_utterance(session_id, "Start a 1 second timer")
    await engine.wait_idle(out["run"]["id"])
    await asyncio.sleep(1.1)
    await alerts.tick()
    timer = services.timers.list()[0]
    assert timer["status"] == "finished" and timer["delivery"]["status"] == "NOT_DELIVERED"


async def test_timer_survives_restart_from_storage(settings, services, engine, session_id):
    from aura.services import HouseholdServices
    out = await engine.handle_utterance(session_id, "Start a 10 minute timer for bread")
    await engine.wait_idle(out["run"]["id"])
    fresh = HouseholdServices(settings)  # a new process reading the same database
    timer = fresh.timers.list()[0]
    assert timer["label"] == "Bread" and timer["status"] == "running" and 590 < timer["remaining_s"] <= 600


async def test_set_a_reminder_asks_what_and_uses_the_answer(engine, services, session_id):
    first = await engine.handle_utterance(session_id, "Aura, set a reminder")
    assert first["run"] is None and first["message"]["text"] == "What should I remind you about?"
    second = await engine.handle_utterance(session_id, "to take out the trash at 9 pm")
    run = second["run"]
    assert run is not None and run["status"] == RunStatus.AWAITING_APPROVAL
    assert run["steps"][0]["params"]["reminder"]["title"] == "Take out the trash"
    assert run["steps"][0]["params"]["reminder"]["due"] == "21:00"


async def test_time_given_before_the_task_is_kept_out_of_the_title(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "set a reminder for 9 pm to call mom")
    reminder = out["run"]["steps"][0]["params"]["reminder"]
    assert reminder["title"] == "Call mom" and reminder["due"] == "21:00"
    assert "at 9:00 PM" in out["message"]["text"]


@pytest.mark.parametrize("text", ["set a reminder to call mom at 7:50 p.m.", "remind me to call mom at 7:50 pm",
                                  "Aura, set a reminder at 7:50pm to call mom", "remind me to call mom at 7:50 PM."])
async def test_minutes_and_dotted_pm_are_parsed(engine, services, session_id, text):
    out = await engine.handle_utterance(session_id, text)
    reminder = out["run"]["steps"][0]["params"]["reminder"]
    assert reminder["title"] == "Call mom" and reminder["due"] == "19:50"
    assert "at 7:50 PM" in out["message"]["text"]


async def test_time_first_then_task_in_the_answer(engine, services, session_id):
    first = await engine.handle_utterance(session_id, "Aura set a reminder for 7:50 pm")
    assert first["message"]["text"] == "What should I remind you about?"
    out = await engine.handle_utterance(session_id, "feed Luna")
    reminder = out["run"]["steps"][0]["params"]["reminder"]
    assert reminder["title"] == "Feed Luna" and reminder["due"] == "19:50"
