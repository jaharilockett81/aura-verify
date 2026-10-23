# AURA Verify

**The household assistant that doesn't just act. It proves the action happened.**

AURA Verify is an Alexa+-style companion experience for multi-step household workflows. It plans a routine
from your saved preferences, asks before doing anything consequential, runs each step through a real
**Model Context Protocol (MCP) server over Streamable HTTP**, and then checks every result through a
separate state channel. When a device says "OK" but didn't actually change, AURA notices, explains why,
offers a fix, and only reports success when it has evidence.

> **Simulation notice.** AURA Verify is an independent hackathon project for the Amazon Build, Ship, Shape
> Developer Hackathon 2026 (Alexa+ track). It is not an Amazon or Alexa product. The web UI simulates an
> Alexa+ companion experience. All devices, reminders and notifications are simulated. No real device is
> controlled, no message is sent, and no money is spent.

```
INTENT → PLAN → AUTHORIZE → EXECUTE → VERIFY → RECOVER → REMEMBER
```

## Why it matters

Voice assistants report success when a cloud API accepts a command. Real homes don't work that way:
thermostats sit in energy-saver holds, locks drop off Wi-Fi, commands get lost. A routine that says
"Done!" while the house stays at 76°F is worse than one that says nothing, because now you trust a wrong
answer. AURA keeps six assurance levels separate and never merges them:

| Level | Meaning |
|---|---|
| **Proposed** | The agent suggested it |
| **Authorized** | You approved it (plan approval, or a per-step confirmation for sensitive actions) |
| **Accepted** | The service acknowledged the command. **Not proof.** |
| **Verified** | An independent state read matches what was intended |
| **Unknown** | The outcome can't be observed (device offline, timeout) |
| **Failed** | Evidence shows it didn't happen |

## What's in the box

- **Real MCP server** (`backend/aura/mcp_server.py`) built on the official MCP Python SDK 2.x, served
  over Streamable HTTP at `http://127.0.0.1:8765/mcp`. It negotiates protocol **2026-07-28** with modern
  clients and still supports the **2025-11-25** initialize handshake (both tested). 15 tools:
  `get_household_context`, `list_available_devices`, `read_device_state`, `set_device_state`,
  `verify_action`, `retry_failed_action`, `get_routine`, `save_routine`, `update_preference`,
  `create_reminder`, `list_reminders`, `manage_timer`, `list_timers`, `get_execution_status`,
  `get_execution_history`.
- **Agent + workflow engine** (`backend/aura/engine.py`): an MCP *client* that plans, asks for approval,
  executes, verifies, diagnoses and recovers. Every household effect is an MCP `tools/call`.
- **Deterministic smart-home simulator** (`backend/aura/simulator.py`) whose acknowledgements are
  deliberately independent of real state: commands settle after a delay, an energy-saver hold silently
  ignores setpoints, offline devices queue commands but can't be read, and a dropped-command fault loses
  exactly one command.
- **Persistent memory** in SQLite: preferences, routines (templates resolved against current
  preferences), reminders, the execution ledger and conversation sessions.
- **Planner**: Amazon Bedrock (Converse API with a forced `submit_plan` tool for structured output) when
  AWS credentials are present, otherwise a **local rule-based planner that is labeled as such** everywhere
  it appears. Planners only propose; risk is assigned by AURA's policy, and LLM output is validated
  against the live device catalogue.
- **Web experience** (React + TypeScript + Vite + Tailwind): Home with conversational assistant (voice
  input via the Web Speech API where supported, text always), Workflow Command Center with live timeline,
  evidence and MCP tool log, Memory & Preferences with edit/reset/export/forget, and Execution History.
  A clearly separated **Demo controls** drawer injects simulated faults.

### Conversation, reminders and timers

- **Multi-action requests.** “Turn off the bedroom lights, set the thermostat to 75 degrees, and lock the
  front door” becomes one plan with one step per action. The normal rules still apply: the plan needs your
  approval, the lock asks separately, and each step is verified by its own independent read. If part of a
  request isn't understood, AURA asks about that part instead of dropping it.
- **Explicit values win.** “Prepare the house before my overnight shift at 75 degrees” runs the routine
  with 75°F for that run only (the step says so; the saved 72°F preference is unchanged). Out-of-range or
  conflicting values get a question instead.
- **Conversation context.** Greetings and wake words (“Hey Aura”, “OK Alexa”) are handled; corrections
  (“actually, make it 74”, “no, the bedroom lights”) replace a plan that hasn't run, or plan only the change
  if it has; follow-ups (“did it work?”, “what about the porch light?”, “turn it on”) use the last request.
  The local planner says plainly that it can't chat freely.
- **Timers** (`backend/aura/timers.py`): create, start, pause, resume, check and cancel, by voice/text or with
  the buttons on Home. They are stored in SQLite (they survive a reload or restart), run through the
  `manage_timer` MCP tool and are read back before AURA reports them.
- **Verified Reminders** (`backend/aura/alerts.py`). Each reminder records three separate things:
  *delivery* (an open AURA tab has to confirm it showed the alert; if no tab is open at the due time it is
  recorded as **not delivered**, because nothing is pushed anywhere else), *outcome* (for a task AURA can
  observe, such as “lock the front door”, it reads the device through `verify_action` when the reminder is
  due and when you say you did it; for a task it can't observe, such as “feed Luna”, your “Done” is recorded
  as **confirmed by you**, never as verified) and an *evidence history*. A failed check can be fixed only
  through a normal plan that you approve; the reminder is re-checked after that run finishes. In Memory,
  “Make due now (demo)” fires a reminder immediately for demos and is labeled as such in its history.
- **Spoken replies.** With Voice replies on, AURA speaks its own transcript messages (plans, questions,
  verified results) and reminder and timer alerts, using the browser's speech synthesis. Plan replies say
  what will happen once you approve; nothing is spoken as done before it has been verified.
- **Reminder times as spoken** (`backend/aura/planner/spoken_time.py`). Chrome's speech recognition writes
  “7:40 AM” as “7:40 a.m.”, “7 40 a.m.”, “740 a.m.” or “seven forty a.m.”; all are read as 7:40 AM, as are
  “three forty-two pm”, “seven forty-five tonight”, “quarter to eight pm”, “seven o'clock in the morning”,
  “noon” and 24-hour “19:40”. The whole time phrase is removed from the reminder's title. AURA never fills in
  what wasn't said: no AM/PM (“at 9:30”, “half past five”) gets “Did you mean 9:30 AM or 9:30 PM?”; a reading
  that needed guessing (“740 a.m.”, “9: a.m.”) gets “Did you mean 9:40 AM?”; a time already past today gets
  “… has already passed today. Do you mean tomorrow …?”. The plan card shows the exact date and time
  (e.g. “Sat, Oct 24 · 7:40 AM”); the reminder is stored with that date through the `create_reminder` MCP tool
  (`due_date`) and read back by `verify_action`, which checks the date as well as the time.
- **Speech debug log.** With `AURA_LOG_SPEECH=1` (the default), the server console logs each voice request's
  raw recogniser transcript and how the reminder time was read (`aura.speech`). Text only, console only; no
  audio is ever recorded. Set `AURA_LOG_SPEECH=0` to turn it off.
- **“Aura” wake word.** Saying just “Aura” (or “Hey Aura”) gets “Yes, Jahari?” (the name comes from the
  saved *What AURA calls you* preference), then the mic reopens for your request. When AURA asks a question
  back (“What should I remind you about?”) after a spoken request, it listens for the answer too. Turn on
  **Hands-free “Aura”** in Settings to have the Home page listen for the wake word without pressing the mic:
  Chrome/Edge only, only while the tab is open, using the browser's speech recognition (Chrome sends that
  audio to Google's speech service). Common mishearings (“Ora”, “Aurora”) count as the wake word.

### UI notes

- Desktop-first layout (designed at 1440×900 and 1512×982, fluid from 390 px phones to 1920 px). The
  Command Center splits roughly 60/40 between the workflow (timeline, step cards, expected vs observed,
  ack evidence vs independent read, authorized recovery) and the MCP tool activity panel, which labels
  each real `tools/call` as ACK, READ, VERIFIED, MISMATCH, UNKNOWN or ERROR and expands to show arguments
  and results. `verify_action` polls while a device settles, so a step can show one or more MISMATCH reads
  before its VERIFIED read; those are real intermediate results, not errors.
- `AuraOrb` (`frontend/src/components/Orb.tsx`) is CSS-only and takes a `state` prop: idle, listening,
  processing, approval, verified, failure, recovering. The state is derived from the live run (SSE
  events plus a refetch) and the speech recognizer; nothing is timed or faked. Approval is amber and
  never implies execution was authorized; verified shows for 6 s after a run completes, then returns to idle.
- Motion uses shared tokens (press 140 ms, content 240 ms, sheets 320 ms, state 360 ms). With
  `prefers-reduced-motion: reduce`, orb animations and page transitions are switched off (checked in
  Chromium by emulation).

## Quick start

Requirements: Python 3.11+, Node.js 20+.

```bash
make setup     # creates backend/.venv, installs Python + npm dependencies
make serve     # builds the UI, then runs MCP (:8765/mcp) + API/web (:8000)
```

Open **http://127.0.0.1:8000**.

Without `make`:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -e "backend[dev]"        # Windows: backend\.venv\Scripts\pip
cd frontend && npm install && npm run build && cd ..
cd backend && .venv/bin/python -m aura.main serve
```

For frontend hot reload, run `make dev-api` and `make dev-web` together, then open http://localhost:5173.

The SQLite database is created at `data/aura.db` with a demo household (user "Jahari", cat "Luna",
overnight-shift schedule). `make reset` restores the defaults and clears history.

### Planner modes and AWS

No AWS account is needed. Without credentials AURA uses the local rule-based planner and the header
says **"Planner · local rules (no LLM)"**. To use Amazon Bedrock, make AWS credentials available to boto3
(e.g. `AWS_PROFILE`), make sure your account has access to the model, and optionally set
`AURA_BEDROCK_MODEL_ID` and `AWS_REGION` (see `.env.example`). If a Bedrock call fails, AURA falls back to
the local planner and records why in the plan's details.

Step-by-step profile setup and a live end-to-end Bedrock check (`backend/scripts/bedrock_check.py`) are in
[docs/SETUP_AWS_AND_GITHUB.md](docs/SETUP_AWS_AND_GITHUB.md).

## Demo walkthrough (the three scenarios)

1. **Overnight shift routine.** On Home, click *"Alexa, prepare the house before my overnight shift."*
   AURA loads the routine from memory, shows a plan preview (nothing has run). Click **Approve & run**.
   Watch each step pre-check the device, send the command (Accepted), then verify by an independent read
   (Verified). The front-door lock is **Sensitive**, so the run pauses for your confirmation. Finish:
   *"5 of 5 steps verified."*
2. **Thermostat failure and recovery (signature demo).** Click the **Run failure demo** card. It
   resets the simulated home and puts the thermostat into an energy-saver hold (AURA isn't told). Approve
   the plan. The hub acknowledges 72°F, but verification reads 76°F for the whole verification window:
   the step turns **Failed**, the diagnosis explains the hold, and AURA offers *Release the hold and set
   72°F* (recommended, needs your OK; the **Allow recovery** button), *Retry as-is*, or *Leave it*. Choose the fix: attempt 2/3 is
   verified, and the summary says it was recovered.
3. **Memory across sessions.** Type *"Actually, I prefer my bedtime temperature at 70 degrees."* AURA
   saves it and verifies by reading it back. Click **New session** (or restart the server), then ask
   *"Get everything prepared for bedtime."* The plan sets 70°F and shows its provenance:
   *"From memory: Bedtime temperature = 70°F (saved …)"*.

More to try: *"set the thermostat"* (AURA asks for the temperature), *"What's the thermostat at?"*
(read-only, runs without approval), or use **Demo controls** to take the door lock offline (result:
**Unknown**, never "success") or drop a command (one automatic retry, then verified).

## Testing

```bash
make test-backend   # pytest: engine, simulator, MCP over real HTTP, API, planners
make test-e2e       # Playwright: scenarios, conversation, reminders, timers, voice, chat scroll, mobile
```

`make test-e2e` builds the UI and starts its own backend on ports 8100/8101 with a temporary database.
If Playwright's browser isn't installed, run `npx playwright install chromium` or point
`PW_CHROMIUM_PATH` at an existing Chromium. Results from the last run are in [TEST_REPORT.md](TEST_REPORT.md).

## Using the MCP server from other clients

The server is a standard MCP server. With the agent running (`make serve`), or standalone via
`make mcp`, point any MCP client at `http://127.0.0.1:8765/mcp`:

```bash
npx @modelcontextprotocol/inspector     # then connect to http://127.0.0.1:8765/mcp (Streamable HTTP)
```

```python
import asyncio
from mcp import Client

async def main():
    async with Client("http://127.0.0.1:8765/mcp") as c:
        print(c.protocol_version)
        ack = await c.call_tool("set_device_state", {"device_id": "porch_light",
                                "attributes": {"power": "on"}, "idempotency_key": "demo-1"})
        print(ack.structured_content)        # accepted, but "NOT_VERIFIED"
        await asyncio.sleep(1)
        ver = await c.call_tool("verify_action", {"target": "device:porch_light",
                                "expected": {"power": "on"}})
        print(ver.structured_content["verdict"])   # VERIFIED / MISMATCH / UNKNOWN

asyncio.run(main())
```

In the web UI, the Command Center's **MCP tool activity** panel shows every call the agent made, with
arguments, results, duration, transport and negotiated protocol version.

## Environment variables

See [.env.example](.env.example). The most useful: `AURA_PLANNER` (`auto`/`local`/`bedrock`),
`AURA_BEDROCK_MODEL_ID`, `AWS_REGION`, `AURA_DB_PATH`, `AURA_API_PORT`, `AURA_MCP_PORT`, and the
verification timing knobs (`AURA_SIM_SETTLE_MS`, `AURA_VERIFY_TIMEOUT_S`, `AURA_MAX_ATTEMPTS`).
`AURA_TZ` (IANA name, e.g. `America/New_York`) sets the time zone for reminder due times;
`AURA_DELIVERY_ACK_S` (default 20) is how long an open tab has to confirm it showed an alert.

## Repository layout

```
backend/aura/
  mcp_server.py   MCP server (tools, annotations, Streamable HTTP)
  services.py     capability layer behind the tools (transport-agnostic)
  simulator.py    deterministic smart-home simulator + fault injection
  memory.py       preferences, routines, reminders
  ledger.py       runs, steps, events, sessions (+ SSE event bus)
  engine.py       workflow engine: plan, authorize, execute, verify, recover
  gateway.py      MCP client used by the engine
  policy.py       risk tiers and plan validation
  planner/        local rule-based planner, Bedrock planner
  api.py          FastAPI REST + Server-Sent Events + static UI
  main.py         runs MCP + API servers
backend/tests/    pytest suite
frontend/src/     React app (pages/, components/, lib/)
frontend/e2e/     Playwright scenarios
```

## Limitations (honest list)

- Devices are simulated. There is no integration with real smart-home hardware or Alexa APIs.
- The Bedrock planner is implemented and unit-tested against a stub client, but has **not yet been run
  against live Bedrock** in our build environment (no AWS credentials there). See TEST_REPORT.md.
- The local planner is a deterministic pattern matcher, not a language model; it understands the demo
  phrasings and common variants, not open-ended conversation.
- Reminder and timer alerts appear only in an open AURA browser tab; nothing is delivered to a phone, and a
  missed alert is recorded as not delivered. Due times use the server's time zone unless `AURA_TZ` is set.
- The local planner handles a fixed set of phrasings for multi-action requests, timers, corrections and
  follow-ups. Unusual phrasings may get a question or "not sure" instead of a plan.
- Single-user, local deployment; no authentication on the API or MCP server (bind to localhost).

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) · [DEMO_SCRIPT.md](DEMO_SCRIPT.md) ·
[DEVPOST_SUBMISSION.md](DEVPOST_SUBMISSION.md) · [PRODUCT_FEEDBACK.md](PRODUCT_FEEDBACK.md) ·
[FRICTION_LOG.md](FRICTION_LOG.md) · [TEST_REPORT.md](TEST_REPORT.md) ·
[READINESS_REPORT.md](READINESS_REPORT.md)

License: [MIT](LICENSE).
