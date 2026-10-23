"""Reminder times as people type them and as Chrome's speech recognition writes them.

Regression for the reported bug: the spoken request "remind me to take the dog out at 7:40 AM" reached AURA as the
transcript "… at 7 40 a.m." and was saved as "Take the dog out 40 a.m." at 7:00. The services clock is pinned to
08:00 UTC (see conftest), so "later today" and "already passed" don't depend on when the suite runs.
"""

from datetime import timedelta

import pytest
from conftest import PINNED_NOW
from test_engine import approve_all

from aura.models import RunStatus
from aura.planner.spoken_time import find_time

TODAY = PINNED_NOW.date().isoformat()
TOMORROW = (PINNED_NOW.date() + timedelta(days=1)).isoformat()


async def say(engine, session_id, text):
    return await engine.handle_utterance(session_id, text)


def planned(out):
    assert out["run"] is not None, out["message"]["text"]
    return out["run"]["steps"][0]["params"]["reminder"]


# ----- the reported failures, end to end ---------------------------------------------------------------
@pytest.mark.parametrize("text,title,due", [
    ("remind me to take the dog out at 7 40 a.m. tomorrow", "Take the dog out", "07:40"),
    ("Remind me to take out the trash tomorrow at 5 30 a.m.", "Take out the trash", "05:30"),
])
async def test_reported_spoken_times_are_saved_with_their_minutes(engine, services, session_id, text, title, due):
    out = await say(engine, session_id, text)
    rem = planned(out)
    assert (rem["title"], rem["due"], rem["due_date"]) == (title, due, TOMORROW)
    # The approval card's step title carries the normalised time and date.
    step_title = out["run"]["steps"][0]["title"]
    assert f"at {int(due[:2])}:{due[3:]} AM tomorrow" in step_title
    run = await approve_all(engine, out["run"]["id"])
    assert run.status == RunStatus.COMPLETED
    stored = services.memory.get_reminder(run.steps[0].target.split(":")[1])
    assert (stored["title"], stored["due"], stored["due_date"]) == (title, due, TOMORROW)
    assert stored["due_at"].startswith(f"{TOMORROW}T{due}")
    # The read-back through verify_action checked the date as well as the time.
    ver = next(e for e in run.steps[0].evidence if e.kind == "verification")
    assert ver.data["verdict"] == "VERIFIED" and ver.data["expected"]["due_date"] == TOMORROW


# ----- transcript shapes -------------------------------------------------------------------------------
@pytest.mark.parametrize("text,hhmm", [
    ("at 7:40 a.m.", "07:40"), ("at 7:40 AM", "07:40"), ("at 7 40 a.m.", "07:40"), ("at 7:40 a.m", "07:40"),
    ("at 7:40am", "07:40"), ("at 7 40 A.M.", "07:40"), ("at 7 40 a m", "07:40"),
    ("seven forty a.m.", "07:40"), ("at five thirty am", "05:30"), ("three forty-two pm", "15:42"),
    ("three forty two p.m.", "15:42"), ("seven forty-five tonight", "19:45"), ("at seven oh five pm", "19:05"),
    ("seven o'clock in the morning", "07:00"), ("7 o clock in the evening", "19:00"), ("quarter to eight pm", "19:45"),
    ("ten past seven pm", "19:10"), ("at noon", "12:00"), ("at midnight", "00:00"), ("at 19:40", "19:40"),
    ("at 07:40", "07:40"), ("at 12 am", "00:00"), ("at 12:30 pm", "12:30"),
])
def test_time_shapes(text, hhmm):
    found = find_time("call mom " + text)
    assert found is not None and found.hhmm() == hhmm
    assert found.text[:found.start].strip() == "call mom"  # the whole phrase is located for removal


@pytest.mark.parametrize("text", ["half past five", "quarter past seven", "at 9:30", "at 3:42", "at nine thirty",
                                  "at seven"])
def test_no_am_pm_is_left_unknown(text):
    found = find_time(text)
    assert found is not None and found.meridiem is None and found.hhmm() is None


@pytest.mark.parametrize("text", ["take 2 pills", "buy 30 eggs", "in 10 minutes", "I am going", "call room 740",
                                  "feed the 3 cats"])
def test_numbers_that_are_not_times(text):
    assert find_time(text) is None


# ----- titles ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text,title", [
    ("remind me to take the dog out at 7 40 a.m. tomorrow", "Take the dog out"),
    ("remind me tomorrow morning at 9 to call the vet", "Call the vet"),
    ("set a reminder for 9 pm tonight to call mom", "Call mom"),
    ("remind me to feed Luna seven forty-five tonight", "Feed Luna"),
    ("remind me at quarter to eight pm to water the plants", "Water the plants"),
])
async def test_time_phrase_is_removed_from_the_title(engine, session_id, text, title):
    rem = planned(await say(engine, session_id, text))
    assert rem["title"] == title


# ----- asking instead of guessing -----------------------------------------------------------------------
async def test_missing_am_pm_is_asked_then_answered(engine, services, session_id):
    out = await say(engine, session_id, "remind me to call mom at 9:30")
    assert out["run"] is None and out["message"]["text"] == "Did you mean 9:30 AM or 9:30 PM?"
    rem = planned(await say(engine, session_id, "PM"))
    assert (rem["title"], rem["due"], rem["due_date"]) == ("Call mom", "21:30", TODAY)


@pytest.mark.parametrize("answer,hhmm", [("p.m.", "21:30"), ("P.M", "21:30"), ("in the evening", "21:30"),
                                         ("a.m.", "09:30"), ("morning please", "09:30")])
async def test_am_pm_answers_as_speech_recognition_writes_them(engine, session_id, answer, hhmm):
    await say(engine, session_id, "remind me to call mom tomorrow at 9:30")
    assert planned(await say(engine, session_id, answer))["due"] == hhmm


async def test_unrelated_answer_to_am_pm_question_is_not_taken_as_am(engine, session_id):
    await say(engine, session_id, "remind me to call mom tomorrow at 9:30")
    out = await say(engine, session_id, "I am not sure")
    assert out["run"] is None


async def test_tomorrow_without_am_pm_still_asks(engine, session_id):
    out = await say(engine, session_id, "remind me to call the bank tomorrow at nine thirty")
    assert out["message"]["text"] == "Did you mean 9:30 AM or 9:30 PM?"
    rem = planned(await say(engine, session_id, "in the morning"))
    assert (rem["due"], rem["due_date"]) == ("09:30", TOMORROW)


async def test_half_past_five_asks_am_or_pm(engine, session_id):
    out = await say(engine, session_id, "remind me to stretch at half past five")
    assert out["message"]["text"] == "Did you mean 5:30 AM or 5:30 PM?"
    rem = planned(await say(engine, session_id, "5:30 p.m."))
    assert (rem["title"], rem["due"]) == ("Stretch", "17:30")


async def test_time_that_already_passed_asks_about_tomorrow(engine, services, session_id):
    out = await say(engine, session_id, "remind me to take the dog out at 7:40 AM")  # clock is 08:00
    assert out["run"] is None
    assert out["message"]["text"].startswith("7:40 AM has already passed today. Do you mean tomorrow,")
    rem = planned(await say(engine, session_id, "yes"))
    assert (rem["due"], rem["due_date"]) == ("07:40", TOMORROW)


async def test_declining_tomorrow_asks_for_a_new_time(engine, session_id):
    await say(engine, session_id, "remind me to take the dog out at 7:40 AM")
    out = await say(engine, session_id, "no")
    assert out["run"] is None and out["message"]["text"] == "Okay, I haven't set it. What time should I set it for?"
    rem = planned(await say(engine, session_id, "8 40 a.m."))
    assert (rem["title"], rem["due"], rem["due_date"]) == ("Take the dog out", "08:40", TODAY)


async def test_run_together_digits_are_confirmed_first(engine, session_id):
    out = await say(engine, session_id, "remind me to take the dog out at 940 a.m.")
    assert out["run"] is None and out["message"]["text"] == "Did you mean 9:40 AM?"
    rem = planned(await say(engine, session_id, "yes"))
    assert (rem["title"], rem["due"]) == ("Take the dog out", "09:40")


async def test_transcript_that_lost_its_minutes_is_confirmed(engine, session_id):
    out = await say(engine, session_id, "remind me to take the dog out at 9: a.m.")
    assert out["message"]["text"] == "Did you mean 9:00 AM?"
    rem = planned(await say(engine, session_id, "no, 9:15 a.m."))
    assert rem["due"] == "09:15"


@pytest.mark.parametrize("text", ["remind me to call mom at 19 pm", "remind me to call mom at 25:00 pm"])
async def test_impossible_times_ask_for_the_time(engine, session_id, text):
    out = await say(engine, session_id, text)
    assert out["run"] is None and out["message"]["text"].endswith("What time should I set it for?")
    rem = planned(await say(engine, session_id, "7 pm"))
    assert (rem["title"], rem["due"]) == ("Call mom", "19:00")


async def test_typed_times_still_work(engine, session_id):
    rem = planned(await say(engine, session_id, "remind me to take my meds at 7:48 PM"))
    assert (rem["title"], rem["due"], rem["due_date"]) == ("Take my meds", "19:48", TODAY)
    rem = planned(await say(engine, session_id, "remind me to stretch at 15:42"))
    assert (rem["due"], rem["due_date"]) == ("15:42", TODAY)


async def test_relative_reminders_are_unchanged(engine, session_id):
    rem = planned(await say(engine, session_id, "remind me to lock the front door in 10 minutes"))
    assert rem["due_in_minutes"] == 10 and rem["due"] is None and "due_date" not in rem


async def test_past_date_is_refused_by_the_mcp_tool(gateway):
    res = await gateway.call("create_reminder", {"title": "Old", "due": "07:00",
                                                 "due_date": (PINNED_NOW.date() - timedelta(days=1)).isoformat(),
                                                 "idempotency_key": "past-1"})
    assert not res.ok and "already passed" in res.error
