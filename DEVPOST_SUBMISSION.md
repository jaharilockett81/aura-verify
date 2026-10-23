# AURA Verify: Devpost submission (final text)

**Primary track:** Alexa+ (self-hosted MCP server, spec 2025-11-25+, Streamable HTTP), presented through a
simulated Alexa+ web companion experience.

**Tagline:** The household assistant that doesn't just act. It proves the action happened.

---

## Inspiration

Every smart-home owner has heard "OK" from an assistant while nothing happened: a thermostat in an
eco hold, a lock that dropped off Wi-Fi, a command lost in the cloud. As assistants move from single
commands to multi-step agents, that gap gets dangerous. An agent that runs six steps and reports "Done!"
because six APIs returned 200 is confidently wrong. We wanted an agent whose word you can trust because it
shows its evidence.

## What it does

AURA Verify turns a request like *"Alexa, prepare the house before my overnight shift"* into a structured
plan built from your saved routine and preferences, shows it to you before anything runs, and then works
through a loop: **intent → plan → authorize → execute → verify → recover → remember**.

- **Plans you can preview.** Each step says what it will do, why, and where its values came from
  ("From memory: Temperature while you're at work = 72°F").
- **Permission tiers.** Reads run freely; routine comfort changes are covered by plan approval; door locks
  and overriding an energy-saver program need their own confirmation.
- **Verification as a first-class state.** AURA separates *proposed, authorized, accepted, verified,
  unknown,* and *failed*. A device acknowledgement is only "accepted". "Verified" requires an independent
  state read that matches.
- **Intelligent recovery.** When the thermostat accepts 72°F but stays at 76°F, AURA marks the step failed,
  diagnoses the energy-saver hold from device state, proposes releasing it (and asks, because it overrides
  your energy program), retries within a hard budget of three attempts, and verifies again.
- **Memory across sessions.** "Actually, I prefer my bedtime temperature at 70" is saved to structured
  memory, verified by read-back, and used the next time the bedtime routine is planned, even after a restart.
- **Explainable history.** Every run keeps its timeline, the evidence for each step, every MCP tool call,
  and what recovery did.

## How we built it

- **MCP server:** Python, official MCP Python SDK 2.x (`MCPServer`), Streamable HTTP at `/mcp`. Negotiates
  protocol 2026-07-28 and supports the 2025-11-25 handshake (both covered by tests). Twelve tools with
  read-only/idempotent annotations: device state read and write, `verify_action`, `retry_failed_action`,
  routines, preferences, reminders and the execution ledger.
- **Agent:** a workflow engine that is itself an MCP client. Every household effect is a `tools/call`.
  Explicit step states (PENDING, AWAITING_APPROVAL, RUNNING, VERIFYING, VERIFIED, FAILED, UNKNOWN,
  RECOVERING, CANCELLED), idempotency keys per attempt, per-call timeouts, a bounded verification window,
  and a server-enforced retry budget.
- **Planning:** a deterministic local planner, labeled "local rules (no LLM)" in the UI and history.
  Plans are validated with Pydantic against the live device catalogue; risk is assigned by AURA's policy,
  and routine steps come from stored memory.
- **Simulator:** a deterministic smart-home simulator with a command channel and a separate state channel,
  settle delays, and injectable faults (energy-saver hold, offline device, dropped command).
- **Storage:** SQLite for preferences, routines, reminders, simulator state and the execution ledger.
- **Frontend:** React, TypeScript, Vite and Tailwind. Live updates over Server-Sent Events. Voice input
  with the Web Speech API where available and full text fallback; optional spoken replies.
- **Testing:** 52 pytest tests (engine, simulator, MCP over real HTTP including the 2025-11-25 handshake,
  API, planners) and 8 Playwright end-to-end tests covering all three demo scenarios, voice-input wiring and
  the mobile layout, all passing from a clean clone on Python 3.11. See TEST_REPORT.md for what is mocked
  and what is untested.

## Challenges we ran into

- **Defining "done."** The hard part was refusing to collapse states. We ended up with a ladder
  (proposed → authorized → accepted → verified) and made "unknown" a real outcome rather than an error.
- **Making failure deterministic.** A demo of recovery is only convincing if the failure is real in the
  system, not a scripted message. The simulator's ack is identical whether or not the device will apply the
  change, so AURA has to discover the problem the same way it would in a real home.
- **Bounded recovery without being useless.** We allow one automatic retry only for unexplained losses of an
  already-authorized idempotent command; anything explained or sensitive goes to the user.
- **A brand-new MCP SDK major version.** See FRICTION_LOG.md.

## Accomplishments we're proud of

- The signature moment: the hub says OK, AURA says "not yet", explains why, and fixes it with permission.
- The agent and the tools talk only over MCP, so any MCP client can use the same verified household tools.
- Honest by construction: planner identity, simulation labels and assurance levels are visible everywhere.

## What we learned

Verification changes the product, not just the backend: once "accepted" and "verified" are different
words in the UI, users understand what an assistant actually knows.

## What's next

- Connect a real device platform behind the same tool contract (the state channel is already separate).
- Proactive follow-up on unresolved issues ("the porch light never confirmed last night").
- Routine authoring by conversation via `save_routine`.
- MCP Apps / rich cards for the plan preview and evidence on devices with screens.

## Potential impact

Shift workers, caregivers and anyone who relies on routines when they're away need to know the house is
actually ready, not that a request was sent. The verification pattern generalizes beyond homes to any
agent that acts in the world: say what you know, show the evidence, ask before consequential fixes, and
stop when retrying won't help.

## Limitations

- All devices are simulated; this is not an Amazon product and controls no real hardware.
- The local planner is a pattern matcher for demo phrasings, not a general language model.
- Reminder delivery is simulated; the API has no authentication and is meant to run on localhost.

## Built with

python, fastapi, model-context-protocol, mcp-python-sdk, pydantic, sqlite, react, typescript, vite, tailwindcss, server-sent-events, web-speech-api,
pytest, playwright
