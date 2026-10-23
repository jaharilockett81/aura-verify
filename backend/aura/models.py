"""Domain models shared by the engine, the MCP server, and the HTTP API."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class StepStatus(StrEnum):
    PENDING = "PENDING"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    RUNNING = "RUNNING"
    VERIFYING = "VERIFYING"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    UNKNOWN = "UNKNOWN"
    RECOVERING = "RECOVERING"
    CANCELLED = "CANCELLED"


TERMINAL_STEP_STATUSES = {StepStatus.VERIFIED, StepStatus.FAILED, StepStatus.UNKNOWN, StepStatus.CANCELLED}


class RunStatus(StrEnum):
    AWAITING_APPROVAL = "AWAITING_APPROVAL"  # plan preview, nothing has run yet
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"  # waiting for a step- or recovery-level decision
    COMPLETED = "COMPLETED"  # every step verified
    COMPLETED_WITH_ISSUES = "COMPLETED_WITH_ISSUES"  # finished; some steps failed/unknown/skipped
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_RUN_STATUSES = {
    RunStatus.COMPLETED,
    RunStatus.COMPLETED_WITH_ISSUES,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
}


class Risk(StrEnum):
    READ_ONLY = "READ_ONLY"  # runs without approval
    ROUTINE = "ROUTINE"  # covered by plan approval
    SENSITIVE = "SENSITIVE"  # needs its own explicit confirmation


class Assurance(StrEnum):
    """How much we actually know about an action. Never collapse these into "success"."""

    PROPOSED = "PROPOSED"  # the agent suggested it
    AUTHORIZED = "AUTHORIZED"  # the user approved it
    ACCEPTED = "ACCEPTED"  # the service acknowledged the command (NOT proof)
    VERIFIED = "VERIFIED"  # independent state read matches expectation
    UNKNOWN = "UNKNOWN"  # cannot determine outcome
    FAILED = "FAILED"  # evidence shows the outcome did not happen


ActionKind = Literal["read_device", "set_device", "create_reminder", "update_preference", "timer"]
TIMER_OPS = ("create", "create_and_start", "start", "pause", "resume", "cancel", "check")


class PlannedAction(BaseModel):
    """One step as proposed by a planner (LLM or local). Risk is assigned later by policy, never by the planner."""

    action: ActionKind
    title: str = Field(max_length=120)
    rationale: str = Field(default="", max_length=300)
    device_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    reminder: dict[str, Any] | None = None
    preference_key: str | None = None
    preference_value: Any = None
    timer: dict[str, Any] | None = None  # {"op", "label"?, "duration_s"?}
    provenance: str | None = None  # e.g. "from saved preference bedtime_temperature_f"


class PlanDraft(BaseModel):
    intent: Literal["routine", "device_control", "preference_update", "query", "clarify", "unknown", "timer"]
    summary: str
    spoken_response: str
    routine_id: str | None = None
    actions: list[PlannedAction] = Field(default_factory=list)
    clarification_question: str | None = None
    pending_slot: dict[str, Any] | None = None
    # Explicit values the user gave for this run only, applied on top of a routine's saved preferences,
    # e.g. {"thermostat": {"setpoint_f": 75}}. Saved preferences are not changed.
    overrides: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # A correction ("actually, make it 74") replaces a plan that hasn't run yet.
    replaces_run_id: str | None = None
    planner: str = "local"
    planner_detail: str = ""


class Evidence(BaseModel):
    kind: Literal["ack", "state_read", "verification", "diagnosis", "precheck", "approval", "note"]
    source: str  # tool name or actor
    summary: str
    data: dict[str, Any] = Field(default_factory=dict)
    at: str


class RecoveryOption(BaseModel):
    id: str
    strategy: Literal["retry", "release_hold_and_reapply", "skip"]
    label: str
    explanation: str
    risk: Risk
    recommended: bool = False


class Step(BaseModel):
    id: str
    run_id: str
    index: int
    title: str
    rationale: str
    action: ActionKind
    target: str  # e.g. "device:thermostat", "reminder", "preference:bedtime_temperature_f"
    params: dict[str, Any]
    expected: dict[str, Any]
    risk: Risk
    status: StepStatus
    assurance: Assurance
    attempts: int = 0
    max_attempts: int = 3
    idempotency_key: str
    result: dict[str, Any] | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    error: str | None = None
    recovery_options: list[RecoveryOption] = Field(default_factory=list)
    recovery_log: list[dict[str, Any]] = Field(default_factory=list)
    provenance: str | None = None
    created_at: str
    updated_at: str
    finished_at: str | None = None


class Run(BaseModel):
    id: str
    session_id: str
    utterance: str
    intent: str
    summary: str
    routine_id: str | None
    planner: str
    planner_detail: str
    status: RunStatus
    spoken_response: str
    final_report: str | None = None
    created_at: str
    updated_at: str
    approved_at: str | None = None
    finished_at: str | None = None
    steps: list[Step] = Field(default_factory=list)
