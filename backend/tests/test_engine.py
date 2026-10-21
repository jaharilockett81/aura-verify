"""Workflow engine tests. All tool calls go through a real MCP client/server pair (in-process transport)."""

from aura.models import Assurance, RunStatus, StepStatus

OVERNIGHT = "Alexa, prepare the house before my overnight shift."


async def plan(engine, session_id, text):
    out = await engine.handle_utterance(session_id, text)
    assert out["run"] is not None, out["message"]["text"]
    return out["run"]["id"]


async def approve_all(engine, run_id):
    """Approve the plan and every sensitive step, without touching recovery decisions."""
    await engine.approve_run(run_id)
    run = await engine.wait_idle(run_id)
    while run.status == RunStatus.PAUSED:
        waiting = [s for s in run.steps if s.status == StepStatus.AWAITING_APPROVAL]
        if not waiting:
            break
        await engine.decide_step(run_id, waiting[0].id, True)
        run = await engine.wait_idle(run_id)
    return run


def step(run, prefix):
    return next(s for s in run.steps if s.title.startswith(prefix))


def command_count(services):
    return services.db.query_one("SELECT COUNT(*) AS n FROM device_commands")["n"]


# ----- Scenario 1: overnight shift ------------------------------------------------------------------
async def test_overnight_routine_plans_from_memory_and_waits_for_approval(engine, services, session_id):
    run_id = await plan(engine, session_id, OVERNIGHT)
    run = services.ledger.get_run(run_id)
    assert run.status == RunStatus.AWAITING_APPROVAL
    assert run.routine_id == "overnight_shift"
    assert [s.status for s in run.steps] == [StepStatus.PENDING] * 5
    assert step(run, "Set the thermostat").params["attributes"] == {"setpoint_f": 72}
    assert step(run, "Lock").risk == "SENSITIVE"
    assert command_count(services) == 0  # nothing executed before approval


async def test_overnight_routine_end_to_end_verified(engine, services, session_id):
    run_id = await plan(engine, session_id, OVERNIGHT)
    await engine.approve_run(run_id)
    run = await engine.wait_idle(run_id)
    assert run.status == RunStatus.PAUSED
    lock = step(run, "Lock")
    assert lock.status == StepStatus.AWAITING_APPROVAL
    assert services.sim.read_state("front_door")["state"]["locked"] is False  # not sent before confirmation

    await engine.decide_step(run_id, lock.id, True)
    run = await engine.wait_idle(run_id)
    assert run.status == RunStatus.COMPLETED
    for s in run.steps:
        assert s.status == StepStatus.VERIFIED and s.assurance == Assurance.VERIFIED
        kinds = [e.kind for e in s.evidence]
        assert "verification" in kinds
    thermo = step(run, "Set the thermostat")
    kinds = [e.kind for e in thermo.evidence]
    assert kinds.index("ack") < kinds.index("verification")  # ack recorded separately, before proof
    assert "independent" in thermo.evidence[-1].summary.lower()
    assert services.sim.read_state("thermostat")["state"]["setpoint_f"] == 72
    reminders = services.memory.reminders()
    assert reminders and reminders[0]["title"] == "Feed Luna" and reminders[0]["due"] == "21:30"


async def test_rerun_skips_commands_when_already_in_state(engine, services, session_id):
    await approve_all(engine, await plan(engine, session_id, OVERNIGHT))
    before = command_count(services)
    run = await approve_all(engine, await plan(engine, session_id, OVERNIGHT))
    assert run.status == RunStatus.COMPLETED
    # Only the reminder is (idempotently) re-created; no device commands are re-sent.
    assert command_count(services) == before
    assert any("No command needed" in e.summary for e in step(run, "Set the thermostat").evidence)


async def test_declining_sensitive_step_sends_nothing(engine, services, session_id):
    run_id = await plan(engine, session_id, OVERNIGHT)
    await engine.approve_run(run_id)
    run = await engine.wait_idle(run_id)
    await engine.decide_step(run_id, step(run, "Lock").id, False)
    run = await engine.wait_idle(run_id)
    assert step(run, "Lock").status == StepStatus.CANCELLED
    assert run.status == RunStatus.COMPLETED_WITH_ISSUES
    assert services.sim.read_state("front_door")["state"]["locked"] is False
    assert "Skipped" in run.final_report


async def test_cancel_before_approval(engine, services, session_id):
    run_id = await plan(engine, session_id, OVERNIGHT)
    run = await engine.cancel_run(run_id)
    assert run.status == RunStatus.CANCELLED
    assert all(s.status == StepStatus.CANCELLED for s in run.steps)
    assert command_count(services) == 0


# ----- Scenario 2: thermostat failure and recovery -------------------------------------------------
async def test_thermostat_mismatch_detected_and_recovered_with_approval(engine, services, session_id):
    services.sim.inject_fault("thermostat", "energy_saver_hold")
    run_id = await plan(engine, session_id, OVERNIGHT)
    await engine.approve_run(run_id)
    run = await engine.wait_idle(run_id)

    thermo = step(run, "Set the thermostat")
    assert thermo.status == StepStatus.FAILED
    assert thermo.assurance == Assurance.FAILED
    assert "still reports 76°F" in thermo.error
    assert any(e.kind == "diagnosis" and "energy-saver hold" in e.summary for e in thermo.evidence)
    options = {o.id: o for o in thermo.recovery_options}
    assert set(options) == {"release_hold", "retry", "skip"}
    assert options["release_hold"].recommended and options["release_hold"].risk == "SENSITIVE"
    assert run.status == RunStatus.PAUSED
    assert step(run, "Schedule").status == StepStatus.PENDING  # did not barrel on past the failure
    assert services.sim.read_state("thermostat")["state"]["setpoint_f"] == 76  # no fake success

    await engine.choose_recovery(run_id, thermo.id, "release_hold")
    run = await engine.wait_idle(run_id)
    thermo = step(run, "Set the thermostat")
    assert thermo.status == StepStatus.VERIFIED
    assert thermo.attempts == 2
    assert any(r["event"] == "recovered" for r in thermo.recovery_log)
    state = services.sim.read_state("thermostat")["state"]
    assert (state["setpoint_f"], state["hold"]) == (72, "none")

    lock = step(run, "Lock")
    await engine.decide_step(run_id, lock.id, True)
    run = await engine.wait_idle(run_id)
    assert run.status == RunStatus.COMPLETED
    assert "Recovered: Set the thermostat to 72°F" in run.final_report


async def test_retry_is_bounded(engine, services, session_id):
    services.sim.inject_fault("thermostat", "energy_saver_hold")
    run_id = await plan(engine, session_id, "set the thermostat to 72")
    await engine.approve_run(run_id)
    run = await engine.wait_idle(run_id)
    thermo = run.steps[0]
    for _ in range(5):  # try to retry more often than allowed
        if not any(o.id == "retry" for o in thermo.recovery_options):
            break
        await engine.choose_recovery(run_id, thermo.id, "retry")
        run = await engine.wait_idle(run_id)
        thermo = run.steps[0]
    assert thermo.status == StepStatus.FAILED
    assert thermo.attempts == 3
    assert thermo.recovery_options == []
    assert "Retry budget used (3/3)" in thermo.error
    assert run.status == RunStatus.FAILED
    assert command_count(services) == 3
    # The MCP tool enforces the same budget for any client.
    res = await engine.gateway.call("retry_failed_action", {"step_id": thermo.id, "strategy": "retry"})
    assert not res.ok and "budget exhausted" in res.error


async def test_dropped_command_is_retried_automatically_once(engine, services, session_id):
    services.sim.inject_fault("porch_light", "drop_next_command")
    run_id = await plan(engine, session_id, "turn on the porch light")
    run = await approve_all(engine, run_id)
    s = run.steps[0]
    assert s.status == StepStatus.VERIFIED
    assert s.attempts == 2
    assert any(r["event"] == "auto_retry" for r in s.recovery_log)
    assert run.status == RunStatus.COMPLETED


async def test_unreachable_device_is_unknown_not_success(engine, services, session_id):
    services.sim.inject_fault("front_door", "unreachable")
    run_id = await plan(engine, session_id, "lock the front door")
    run = await approve_all(engine, run_id)
    s = run.steps[0]
    assert s.status == StepStatus.UNKNOWN
    assert s.assurance == Assurance.UNKNOWN
    assert {o.id for o in s.recovery_options} == {"retry", "skip"}
    await engine.choose_recovery(run_id, s.id, "skip")
    run = await engine.wait_idle(run_id)
    assert run.steps[0].status == StepStatus.UNKNOWN
    assert run.status == RunStatus.FAILED
    assert "Couldn't confirm" in run.final_report


# ----- Scenario 3: memory across sessions -----------------------------------------------------------
async def test_preference_change_persists_and_applies_in_new_session(engine, services, settings, session_id):
    out = await engine.handle_utterance(session_id, "Actually, I prefer my bedtime temperature at 70 degrees.")
    run = await engine.wait_idle(out["run"]["id"])
    assert run.intent == "preference_update"
    assert run.status == RunStatus.COMPLETED
    assert any("Read back from the preference store" in e.summary for e in run.steps[0].evidence)

    # Simulate a full restart: brand-new services/engine objects on the same database file.
    from aura.engine import WorkflowEngine
    from aura.gateway import MCPToolGateway
    from aura.mcp_server import build_mcp_server
    from aura.services import HouseholdServices

    fresh = HouseholdServices(settings)
    assert fresh.memory.get_preference("bedtime_temperature_f")["value"] == 70
    gw = MCPToolGateway(build_mcp_server(fresh))
    eng2 = WorkflowEngine(settings, fresh.ledger, gw)
    new_session = fresh.ledger.new_session()
    assert fresh.ledger.messages(new_session) == []
    run_id = await plan(eng2, new_session, "Get everything prepared for bedtime")
    run = fresh.ledger.get_run(run_id)
    thermo = step(run, "Set the thermostat")
    assert thermo.params["attributes"] == {"setpoint_f": 70}
    assert "Bedtime temperature = 70°F" in thermo.provenance
    run = await approve_all(eng2, run_id)
    assert run.status == RunStatus.COMPLETED
    assert fresh.sim.read_state("thermostat")["state"]["setpoint_f"] == 70
    await gw.close()
    await eng2.shutdown()


# ----- planning edge cases ----------------------------------------------------------------------------
async def test_missing_information_triggers_clarification(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "set the thermostat")
    assert out["run"] is None
    assert "What temperature" in out["message"]["text"]
    out = await engine.handle_utterance(session_id, "71 please")
    assert out["run"]["steps"][0]["params"]["attributes"] == {"setpoint_f": 71}


async def test_out_of_range_plan_is_rejected(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "set the thermostat to 95")
    assert out["run"] is None
    assert "failed validation" in out["message"]["text"]


async def test_query_is_read_only_and_runs_without_approval(engine, services, session_id):
    out = await engine.handle_utterance(session_id, "what's the thermostat at?")
    run = await engine.wait_idle(out["run"]["id"])
    assert run.status == RunStatus.COMPLETED
    assert run.steps[0].risk == "READ_ONLY"
    assert command_count(services) == 0
    final = services.ledger.messages(session_id)[-1]
    assert "76°F" in final["text"]


async def test_unknown_request_does_not_create_run(engine, session_id):
    out = await engine.handle_utterance(session_id, "order me a pizza")
    assert out["run"] is None
    assert "not sure" in out["message"]["text"]


async def test_events_are_recorded_for_timeline(engine, services, session_id):
    run_id = await plan(engine, session_id, "turn off the living room lights")
    await approve_all(engine, run_id)
    types = [e["type"] for e in services.ledger.events(run_id)]
    assert types[0] == "run.created"
    assert "tool.call" in types and "evidence" in types and types[-1] == "run.finished"
    tools = [e["data"]["tool"] for e in services.ledger.events(run_id) if e["type"] == "tool.call"]
    assert tools[:3] == ["read_device_state", "set_device_state", "verify_action"]


async def test_runs_interrupted_by_restart_are_not_reported_as_success(engine, services, session_id):
    from aura.models import Assurance as A

    run_id = await plan(engine, session_id, OVERNIGHT)
    run = services.ledger.get_run(run_id)
    # Simulate a crash mid-step: persisted as RUNNING with an in-flight step and no task alive.
    run.status = RunStatus.RUNNING
    run.steps[0].status = StepStatus.VERIFYING
    run.steps[0].assurance = A.ACCEPTED
    services.ledger.save_run(run)
    assert engine.recover_interrupted() == [run_id]
    run = services.ledger.get_run(run_id)
    assert run.steps[0].status == StepStatus.UNKNOWN
    assert run.status == RunStatus.FAILED
    assert run.final_report.startswith("Interrupted by a restart.")
