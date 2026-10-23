# AURA Verify: final readiness report

As of 2026-10-22 20:30 UTC. Deadline: 2026-10-23, 12:00 PM PT / 3:00 PM ET.
Evidence for every "verified" line is in TEST_REPORT.md.

## Verified (executed and passing)

| Area | Evidence |
|---|---|
| Self-hosted MCP server, Streamable HTTP, 12 tools | `test_mcp_http.py` over a real uvicorn server; `/api/health` live check |
| Protocol 2025-11-25 (legacy handshake) and 2026-07-28 | `test_legacy_2025_11_25_handshake_supported`; health shows 2026-07-28 |
| Agent reaches the household only through MCP calls | Engine tests run through the MCP client; UI tool log shows each `tools/call` |
| Explicit step states and assurance levels (accepted ≠ verified) | Engine tests assert ack recorded before verification |
| Independent verification by state read; no fake success | Mismatch test: thermostat stays 76°F, step FAILED, device state unchanged |
| Diagnosis + recovery with approval (energy-saver hold) | Engine, API and Playwright Scenario 2 |
| Bounded retries (3 per step, enforced by the MCP tool too) | `test_retry_is_bounded` |
| Idempotency (no double apply) and redundant-command skipping | Simulator and engine tests |
| Unknown outcomes stay UNKNOWN (offline device, restart mid-step) | Engine tests |
| Permission tiers (read-only / routine / sensitive) | Engine and Playwright tests (lock pauses; declining sends nothing) |
| Persistent memory across sessions and a real process restart | Engine test + manual restart check |
| Clarifying questions for missing information | `test_missing_information_triggers_clarification` |
| Three demo scenarios in the browser (Chromium) | Playwright 1–3 |
| Mobile layout | Playwright Pixel 7 test |
| Clean clone → setup → all tests on Python 3.11 | 52 pytest + 8 Playwright passed |
| No secrets or local data in the repo | `git ls-files` / `git grep` audit |
| MIT license, README, architecture, demo script, Devpost draft, feedback, friction log | In repo root |

## Mocked or simulated (by design, and labeled)

| Item | How it's disclosed |
|---|---|
| All devices, reminders and notifications (simulator) | UI header/footer, MCP server instructions, README, every tool result has `simulated: true` |
| Thermostat failure (fault injected by Demo controls) | Demo controls drawer and toast say so; AURA isn't told |
| Local planner (deterministic rules, no LLM) | Header "Planner · local rules (no LLM)", plan details, History badge |
| Voice input e2e test | Fake SpeechRecognition; tests our wiring, not recognition |

## Untested (needs Jahari's machine or wasn't possible here)

| Item | Why | What to do |
|---|---|---|
| Spoken replies through speakers; speech recognition in Edge/Safari | Headless container, no microphone or speakers | Real mic tested by Jahari in Chrome on macOS (TEST_REPORT); Safari needs Siri/Dictation enabled |
| Safari / WebKit, Firefox | Browser downloads blocked by the container's network policy | Manual check on macOS |
| Windows setup | Linux (automated) and macOS (Jahari) only | Follow README; Windows without `make` uses the manual commands |

## Submission blockers and decisions

1. **Public repo** with the visible MIT license: done (github.com/jaharilockett81/aura-verify).
2. **Demo video under 3 minutes on YouTube or Vimeo**: required. Script in DEMO_SCRIPT.md; needs recording.
3. **Track declaration:** Alexa+ track, self-hosted MCP server path (spec 2025-11-25+, Streamable HTTP) plus
   a simulated Alexa+ web experience. The MCP server is imported and called at runtime, which meets the
   runtime-hook requirement directly; the simulation fallback isn't needed for compliance.

## Known limitations to state in the submission

Simulated devices only; local single-user deployment with no auth; the local planner understands demo
phrasings and close variants, not open conversation; reminder delivery is simulated; concurrent runs on the
same device aren't coordinated.
