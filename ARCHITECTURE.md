# AURA Verify architecture

## Overview

```
 Browser (React)                    API process (FastAPI :8000)                 MCP server (:8765/mcp)
 ─────────────────                  ─────────────────────────────               ──────────────────────
 Home / Command Center   REST+SSE   WorkflowEngine (agent)          MCP over    MCPServer (official SDK)
 Memory / History      ◄─────────►  ├─ Planner: Bedrock | local     Streamable  ├─ 12 tools
 Demo controls                      ├─ Policy (risk, validation)    HTTP        └─ HouseholdServices
                                    ├─ MCPToolGateway (client) ─────────────────►   ├─ SmartHomeSimulator
                                    └─ Ledger (runs/steps/events)                   ├─ Memory
                                                │                                   └─ Ledger (read side)
                                                └────────────── SQLite (data/aura.db) ◄──────┘
```

`python -m aura.main serve` starts both servers in one process for convenience, but the agent and the
tools only talk over MCP Streamable HTTP. The MCP server can also run alone (`python -m aura.main mcp`)
and be used by any MCP client.

The one thing the two sides share is a SQLite file (WAL mode, one connection per operation). The
simulator's state lives there, so the MCP server and the dashboard see the same household, and the
ledger lives there, so `get_execution_status` and `retry_failed_action` can serve any MCP client.

## Layers

| Layer | Module | Responsibility |
|---|---|---|
| Transport | `mcp_server.py` | Tool registration, JSON schemas from type hints, annotations (`readOnlyHint`, `idempotentHint`), mapping deliberate failures to `ToolError` so clients get explainable errors |
| Capabilities | `services.py` | Transport-agnostic household operations; verification logic; bounded retry |
| Simulation | `simulator.py` | Device state, settle delays, faults. Separate command channel (`set_state`) and state channel (`read_state`) |
| Memory | `memory.py` | Preferences with validation, routine templates, reminders, "forget everything" |
| Agent | `engine.py`, `gateway.py`, `policy.py`, `planner/` | Intent → plan → authorize → execute → verify → recover → remember |
| Ledger | `ledger.py` | Durable runs/steps/events/messages; in-process event bus for SSE |
| API | `api.py` | REST endpoints, SSE stream, static UI, demo controls |

The engine is the only writer of run and step state. It persists each transition before broadcasting it,
so the UI timeline and the history are the same record the engine acted on.

## The agent loop

1. **Intent.** The user's utterance is stored in the session. The engine calls `get_household_context`
   over MCP (preferences, routines, device catalogue, open issues).
2. **Plan.** A planner returns a `PlanDraft`: intent, spoken response, and proposed actions.
   - *Bedrock planner:* Converse API, `temperature=0`, one tool (`submit_plan`) with a JSON schema and
     `toolChoice: any`, so the model must answer with structured input. The response is validated with
     Pydantic. For routines, the model returns only a `routine_id`; actions come from memory.
   - *Local planner:* deterministic regex/keyword rules, labeled "Local rule-based planner
     (deterministic, no LLM)" in the API, UI and history.
   - Missing information produces a clarifying question and a pending slot on the session
     ("What temperature?" → "71").
   - Routine plans are expanded by calling `get_routine` over MCP, which resolves `{pref:…}` placeholders
     against the **current** preferences and returns provenance ("From memory: Bedtime temperature = 70°F,
     saved …").
3. **Authorize.** `policy.py` assigns risk; planners can't.
   - `READ_ONLY` (reads): run without approval.
   - `ROUTINE` (lights, setpoints, reminders, preference writes): covered by plan approval.
   - `SENSITIVE` (door locks, overriding the thermostat's energy-saver hold): need their own confirmation
     even after plan approval. The run pauses on that step (`AWAITING_APPROVAL`).
   - Plans are validated against the live device catalogue (unknown devices, attributes or out-of-range
     values are rejected before the user sees them).
   - A preference stated directly by the user ("I prefer 70") is treated as authorized by the statement
     itself; it is reversible from the Memory screen.
4. **Execute.** For each device step: pre-check the state (`read_device_state`). If it's already in the
   desired state, the step is verified with that evidence and **no command is sent**. Otherwise call
   `set_device_state` with an idempotency key. The acknowledgement is recorded as `ACCEPTED`, never as
   success.
5. **Verify.** Poll `verify_action(target, expected)` every `AURA_VERIFY_POLL_S` until it returns
   `VERIFIED` or `AURA_VERIFY_TIMEOUT_S` passes. `verify_action` reads the state channel, not the ack.
   - `VERIFIED` → step `VERIFIED`.
   - `MISMATCH` for the whole window → step `FAILED`, with expected vs observed recorded.
   - Device unreadable / tool error → step `UNKNOWN`.
   - Reminders and preferences are verified by reading them back from storage.
6. **Recover.** On `FAILED` or `UNKNOWN`, the engine reads the full device state to diagnose:
   - *Explained cause* (thermostat `hold = energy_saver`): propose "Release the hold and set 72°F"
     (SENSITIVE, recommended), "Retry as-is", or "Leave it". Wait for the user.
   - *Unexplained loss* on a reachable device: one automatic retry (same authorized command, fresh
     idempotency key), limited by `AURA_AUTO_RETRY_LIMIT`. If that fails, ask.
   - *Unreachable device*: offer retry or leave; the step stays `UNKNOWN`, never "success".
   - Recovery goes through the `retry_failed_action` MCP tool, which enforces the attempt budget
     (`AURA_MAX_ATTEMPTS`, default 3) by counting the commands actually issued for that step, so no client
     can retry forever. When the budget is used, the step is final and the user is told to check the device.
7. **Remember.** The run finishes as `COMPLETED` (all verified), `COMPLETED_WITH_ISSUES`, `FAILED`, or
   `CANCELLED`, with a plain-language report ("4 of 5 steps verified. Recovered: …"). Failed and unknown
   steps surface as "unresolved issues" on Home and in `get_household_context`.

## State machines

**Step:** `PENDING → (AWAITING_APPROVAL →) RUNNING → VERIFYING → VERIFIED | FAILED | UNKNOWN`,
`FAILED|UNKNOWN → RECOVERING → VERIFYING → …` (bounded), `PENDING|AWAITING_APPROVAL → CANCELLED`.
Cancelling while a step is in flight marks it `UNKNOWN` ("the command may or may not have taken
effect"), not cancelled.

**Run:** `AWAITING_APPROVAL → RUNNING ⇄ PAUSED → COMPLETED | COMPLETED_WITH_ISSUES | FAILED`, and
`CANCELLED` from any non-final state. `PAUSED` runs are fully persisted and survive a restart. Runs found
`RUNNING` at startup (process died mid-step) are closed with in-flight steps marked `UNKNOWN`.

**Assurance** (per step, shown as a ladder in the UI): `PROPOSED → AUTHORIZED → ACCEPTED → VERIFIED`,
or `FAILED` / `UNKNOWN`.

## Safety properties and where they're enforced

| Property | Enforcement |
|---|---|
| No success without evidence | Only `verify_action` VERIFIED (or an equal pre-check read) sets `VERIFIED`; acks set `ACCEPTED` |
| No silent double-apply | Idempotency keys stored per command; a duplicate returns the original ack and isn't re-applied |
| Bounded retries | Attempt budget counted server-side in `retry_failed_action`; auto-retry limit in the engine |
| No unbounded waits | Per-tool timeout (`AURA_TOOL_TIMEOUT_S`), verification window, Bedrock read timeout |
| Ambiguous outcomes are explicit | Timeouts and unreadable devices become `UNKNOWN`; cancellation in flight becomes `UNKNOWN` |
| No autonomous consequential actions | Policy tiers; sensitive steps and sensitive recovery options need explicit user action |
| LLM can't escalate | Risk from policy; plan validated against the device catalogue; routine steps from memory |
| Honest labeling | Planner identity on every run; simulation notice in UI, API and MCP instructions |

## Data model (SQLite)

`devices`, `device_commands` (idempotency), `preferences`, `routines`, `reminders`, `runs`, `steps`
(JSON documents validated by Pydantic), `events` (ordered ledger used for the timeline and SSE),
`sessions` (pending clarification slots), `messages`.

## Live updates

The ledger publishes each event to an in-process bus; `/api/stream` relays it as Server-Sent Events. The
Command Center appends `tool.call` events to the MCP activity log and refetches the run on step events.

## Testing strategy

- Unit and integration tests run the engine against the real MCP server through the SDK's in-process
  transport (full protocol layer, no network), and separately over real Streamable HTTP (uvicorn on a free
  port), including the 2025-11-25 legacy handshake.
- Playwright drives the built UI against an isolated server for the three scenarios and a mobile layout
  check.
