# Test report

Last updated: 2026-10-23 (UTC). Every result marked as passed comes from a command that was actually run.
Anything not run is listed under "Not tested".

## Environment

- Linux x86_64 cloud container, Node.js 22.22.0, npm 10.9.4
- Python 3.13.16 (development) and **Python 3.11.15** (clean-clone run)
- MCP Python SDK 2.3.0, FastAPI 0.157.0, Uvicorn 0.54.0, Pydantic 2.13.5
- Playwright Test 1.64.1 with a pre-installed Chromium build (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`)
- No valid AWS credentials in this environment (STS returned `InvalidClientTokenId`), so all automated runs
  used the local planner with `AURA_DISABLE_BEDROCK=1`

## Clean-clone check (Python 3.11), 2026-10-22

```bash
git clone <repo> clean && cd clean
make setup PY=python3.11                                   # exit 0
make test-backend                                          # 52 passed in 15.88s
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium make test-e2e   # UI build + 8 passed (23.6s)
```

## Backend: `make test-backend` (pytest) — 99 passed, 0 failed

The 52 original tests are listed first; the three files added on 2026-10-23 are at the end of the table.

| File | Tests | Covers |
|---|---|---|
| `test_simulator.py` | 12 | Ack before settle ≠ state; energy-saver hold acks but ignores setpoint; release-hold applies; idempotency key prevents double apply; 5 invalid-command cases; unreachable device unreadable and command lost; drop-next-command drops exactly one; state persists across instances |
| `test_engine.py` | 16 | Scenario 1 plan from memory, approval gate (no commands before approval), end-to-end verified with ack recorded before verification, re-run skips redundant commands, declining a sensitive step sends nothing, cancel before approval; Scenario 2 mismatch detected, explained and recovered with approval (attempt 2), retries bounded at 3 (also enforced by the MCP tool), dropped command auto-retried once, unreachable device ends UNKNOWN not success; Scenario 3 preference persists across fresh service/engine objects on the same DB and is applied in a new session; clarification for missing temperature; out-of-range plan rejected; read-only query runs without approval; unknown request creates no run; event timeline order; runs interrupted by a restart are not reported as success |
| `test_mcp_http.py` | 7 | Real Streamable HTTP (uvicorn): expected tools listed (15 as of 2026-10-23) with annotations; **2025-11-25 legacy handshake**; ack + independent verification; MISMATCH reported; tool errors explained; gateway reports transport/protocol; full workflow over HTTP incl. `get_execution_status` / `get_execution_history` |
| `test_api.py` | 6 | Health reports MCP connection; chat → approve → confirm → COMPLETED (double approve → 409); recovery via API; preference edit/validation/reset; forget-everything restores defaults; demo fault controls |
| `test_planners.py` | 11 | Local planner maps the four prompt phrasings to the right routines; preference vs device command. **Bedrock planner with a stub client (mocked, no AWS call):** forced tool call parsed, request shape (`toolChoice`, `temperature`); routine actions come from memory, not the model; engine falls back to local and discloses the error; hallucinated device rejected; retry without forced tool choice; string preference values coerced |
| `test_explicit_values.py` | 16 | **Temperature regression:** the overnight-shift routine with an explicit temperature (several phrasings) plans, executes and verifies that value instead of the saved 72°F, without changing the saved preference; the routine without a value still uses the preference; an unsupported value or two different temperatures ask for clarification instead of being replaced; an explicit temperature is added when the routine has no thermostat step; Bedrock `thermostat_setpoint_f` becomes the same override (stub client, mocked). **Greetings:** five greeting forms get an honest "local rule-based planner" reply and create no run; a greeting followed by a request still plans |
| `test_conversation.py` | 18 | Multi-action command is one plan that keeps the lock approval, and executes and verifies each step independently; an unclear part asks instead of being dropped; verb-less lists inherit the previous verb; timer create/start/pause/resume/check/cancel through MCP with an independent read-back; ambiguous timer or missing length asks; pausing with nothing running is answered honestly; corrections replace an unapproved plan, or plan only the change after execution, and do not swallow preference statements; follow-up status questions, "what about …" and pronouns; wake-word variations (parametrized); spoken plan replies never claim success before approval |
| `test_reminders.py` | 13 | Reminder with a device check parsed and stored; due with no tab open → "Not delivered"; delivery needs a tab to confirm; unacknowledged alert → "Unconfirmed"; unobservable task → user-confirmed, never verified; check verifies independently when due; marked done but device disagrees → mismatch; fix goes through an approved plan then re-checks; declined fix leaves the reminder unverified; fix refused for unobservable or passing reminders; snooze and dismiss; finished-timer delivery tracked; timer survives a restart from storage |

## End to end: `make test-e2e` (Playwright, Chromium) — 16 passed, 0 failed

Tests 1 to 8 are the original suite; 9 to 16 were added on 2026-10-23 (`e2e/chat.spec.ts`, `e2e/conversation.spec.ts`).

Runs against an isolated server (ports 8100/8101, temporary SQLite, faster simulator timings).

1. Scenario 1: overnight shift plans, pauses for the lock, verifies 5/5; dashboard shows Locked and 72°F
2. Scenario 2: thermostat acknowledges but doesn't change; UI shows "Verification failed", "still reports
   76°F", MISMATCH in the MCP log; recovery with approval → Verified, "Attempt 2/3", "Recovered" in summary
3. Scenario 3: preference saved and verified, shown in Memory ("by assistant"), New session + full page
   reload, bedtime plan uses 70°F with provenance, runs to "Everything verified"
4. Read-only question answered from an observed state read, no approval needed
5. History filters, Memory forget confirmation (cancelled), Demo controls dialog
6. **Voice input wiring, with a fake SpeechRecognition (mocked):** mic button → transcript appears as the
   user's message → same plan as typing. Tests our code path only, not real speech recognition.
7. No speech support: mic button disabled with an explanatory tooltip; typed requests still work
8. Mobile (Pixel 7 viewport): bottom navigation works, no horizontal overflow
9–10. **Chat scrolling regression, run in both the desktop (1440×900) and mobile (Pixel 7) projects:**
   after each message, the bottom of the newest assistant reply (including its plan card) is above the
   top of the input bar. The same test checks that "…overnight shift at 75 degrees" plans 75°F and never 72°F.
11. Multi-action command: one plan, lock confirmation, "3/3 verified"
12. Timers from chat and from the Home Timers card: create, pause (button), resume (chat), time left
    (chat), cancel (button)
13. Verified reminder: made due with the labelled demo control, alert shows "Not done" from an independent
    read and "Shown in app", "Plan a fix" → approve → verified run → reminder shows "Verified" with the
    "After the approved fix, an independent read confirms…" evidence entry
14. Unobservable reminder ("feed Luna") marked done → "Confirmed by you", not "Verified"
15. Greeting, correction ("Actually, make it 74" → "75°F → 74°F") and follow-up ("Did it work?" →
    still waiting for approval)
16. **Voice replies with a fake `speechSynthesis` (mocked):** the clarification question, the
    "once you approve" confirmation and "Done, and verified" are spoken, and nothing is spoken as done
    before verification. Tests our code path only, not real audio.

### Re-run after the desktop UI polish (branch `ui-desktop-polish`, 2026-10-23)

`pytest -q`: 52 passed. Playwright: 8 passed, three consecutive runs (desktop project at 1440×900, mobile
Pixel 7). One selector conflict appeared while building it: the recovery panel's evidence trail repeated
the diagnosis sentence, so `/still reports 76°F/` matched two elements. The trail now shows the raw
fields of the independent read instead; the test assertion was not changed.

Other checks run in headless Chromium against the live dev server:
- Screenshots of Home (idle, listening), Command Center (running, awaiting the lock confirmation,
  verified), the thermostat failure, recovery in progress, recovery verified, Memory and History at
  1440×900 and 1512×982, all driven through the UI with real backend runs. The "listening" shots and the
  recording use a stub SpeechRecognition that stays open, because the container has no microphone.
- No horizontal overflow on Home, Command Center, Memory or History at 390, 412, 1024, 1280 and 1920 px.
- `reducedMotion: 'reduce'` emulation: orb `data-reduced="true"`, orb animations `none`, page transition
  effectively 0 s. Without it, the orb animations run.
- No console errors or page errors during the screenshot run.

### Re-run after conversation, timers and verified reminders (branch `ui-desktop-polish`, 2026-10-23)

Final state of the branch: `pytest -q` 99 passed (25.9 s); Playwright 16 passed (51.5 s). The last three
full Playwright runs were all green (two after the documentation edits, plus this final one). No test was skipped or loosened. While building the chat-scroll test, its failures
exposed that smooth scrolling and late layout shifts released the "pinned to bottom" state; the code now
releases it only on user input (wheel up, touch, arrow/page keys).

Screenshots of the new features were taken from the running dev server in headless Chromium with real
backend runs; they are in the project files under `aura-verify/screenshots/demo-fixes/`. Reminder alerts in screenshots were made due
with the labelled demo control "Make due now (demo)", which is recorded in the reminder's history.

### Wake word and reminder follow-up (2026-10-23, ~11:00Z)

After Jahari reported that "Aura, set a reminder" got no useful response: the planner asked "What should I
remind you about?" but did not connect the answer to the question, and "for 9 pm" times ended up in the
reminder title. Both fixed. Added the "Aura" → "Yes, Jahari?" wake reply and an optional hands-free mode.

- pytest: **107 passed** (+8: wake word alone × 5 phrasings, saved name used, reminder question → answer
  creates the reminder with its time, time before the task kept out of the title). The greeting test now uses
  "Hi Aura"/"hello aura!" because a bare "Hey Aura" is the wake word by request; the assertions are unchanged.
- Playwright: **19 passed**, two consecutive runs (+3 in `e2e/wake.spec.ts`, with fake SpeechRecognition and
  speechSynthesis: hands-free "Aura" → "Yes, Jahari?" → request → reminder plan awaiting approval;
  "Ora set a reminder" → question spoken → answer heard → reminder plan; mic button "Aura" reopens the mic,
  typed "Aura" does not). `chat.spec.ts` and `conversation.spec.ts` greet with "Hi Aura" for the same reason.
- Not tested: real wake-word listening with a microphone (needs Chrome on a real machine).

### Spoken reminder times (2026-10-23, ~11:40Z)

Reported: spoken “7:40 AM” saved as “Take the dog out 40 a.m.” at 7:00; “5:30 AM” as “Take out the trash
30 a.m.” at 5:00. Reproduced in the planner before changing anything: the transcript form “at 7 40 a.m.”
(hour and minutes separated by a space, as Chrome's recogniser sometimes writes them) gave exactly
`('Take the dog out 40 a.m', '07:00')`, while “7:40 a.m.” and “7:40 AM” parsed correctly. So the hour
*was* in the transcript; AURA's time regex only accepted “H:MM” and read “7” as 7:00. A voice debug log
(`aura.speech`) now records the raw transcript and the parsed time so this can be confirmed on a real mic.

- pytest: **172 passed** (+60 in `tests/test_spoken_times.py`; the dotted “p.m.” fix pushed earlier has its own
  tests in `test_reminders.py`). Covers the two reported cases end to end (plan → approval → MCP `create_reminder` → `verify_action`
  read-back of time *and* date → stored row), 23 transcript shapes, 6 AM/PM-unknown forms, 6 non-times
  (“take 2 pills”, “call room 740”), title cleanup, AM/PM questions and spoken answers (“p.m.”, “in the
  morning”), “I am not sure” not taken as AM, past-time → tomorrow question (yes / no → new time),
  run-together digits and lost-minute transcripts confirmed first, impossible times (“19 pm”, “25:00 pm”)
  asked again, typed times, relative reminders unchanged, and a past `due_date` refused by the MCP tool.
  The services clock is pinned in tests (08:00 UTC tomorrow, `AURA_TZ`=UTC) so results don't depend on the
  hour the suite runs.
- Playwright: **21 passed**, two consecutive runs (+2 in `e2e/wake.spec.ts` with fake SpeechRecognition:
  the “7 40 a.m. tomorrow” transcript → plan shows “7:40 AM tomorrow” and the “· 7:40 AM” date chip, nothing
  with “40” in the title or “7:00 AM”, approval → stored `due` 07:40 with tomorrow's date; and “tomorrow at
  nine thirty” → AM/PM question with no plan → mic reopens → “p.m.” → 9:30 PM plan).
- Live check against the running server (API with `source: voice`): the two reported phrasings, “three
  forty-two p.m.”, “half past five” → question → “p.m.”, “seven forty-five tonight”, “tomorrow at nine
  thirty” → “in the morning” all planned with the right time and date; the `aura.speech` log lines showed
  the raw transcript and parsed time. Screenshots from the running app are in the project files under
  `aura-verify/screenshots/spoken-times/`.
- Not tested: a real microphone. The exact transcript Chrome produces on Jahari's machine is unknown; the
  debug log will show it.

## Timing at default settings (manual, API-driven, 2026-10-22)

Signature scenario with `AURA_SIM_SETTLE_MS=600`, `AURA_VERIFY_TIMEOUT_S=3.0`: plan 0.14 s → approve →
failure detected and recovery offered after 5.3 s ("still reports 76°F … after 3.0s (6 reads)") → recovery
verified in 1.2 s → lock confirmed and verified in 1.2 s → `COMPLETED`, "5 of 5 steps verified. Recovered:
Set the thermostat to 72°F."

## Other manual checks (2026-10-21)

- `python -m aura.main serve`: `/api/health` reported MCP connected, 12 tools, protocol `2026-07-28`,
  transport `streamable-http`.
- Preference survived a real process restart: set bedtime temperature to 70, killed and restarted the
  server, `/api/memory` returned 70 and a new bedtime plan showed "Set the thermostat to 70°F | From memory:
  Bedtime temperature = 70°F".

## Amazon Bedrock

| Check | Status |
|---|---|
| Planner request/response handling | Tested with a **stub client only** (mocked) |
| `scripts/bedrock_check.py` logic (planner + 3 full workflows) | Dry-run with a **stub** client: all steps passed. Proves the script works, not Bedrock. |
| STS / model listing / Converse / live workflows | **Not run yet.** No valid AWS credentials in the build environment. Awaiting a run with Jahari's `aura-verify` profile. |

Do not declare the AWS Builder mini challenge until the live check passes; record its output here.

## Manual checks by Jahari (macOS, Chrome, real microphone), 2026-10-23

- `make setup` and `make serve` on macOS, app opened at http://127.0.0.1:8000 (header showed 15 MCP tools).
- **Real speech recognition with the mic button:** spoken “Hey Aura, set a reminder at 4:32 PM to take out
  trash”. Chrome's transcript was “Hey Aura, set a reminder at 4 32 p.m. to take out trash”; AURA planned
  “Take out trash at 4:32 PM today (Fri, Oct 23)”, and after approval `create_reminder` and `verify_action`
  ran over MCP and the run ended “Everything verified” (1/1). Screenshot from Jahari's run, 10:38 AM local.

## Not tested

- **Spoken replies through real speakers**, and speech recognition in Edge and Safari. Automated tests use
  fake SpeechRecognition and speechSynthesis.
- Reminder and timer alerts with the browser tab closed or the laptop asleep: there is no push channel, so
  these are recorded as "Not delivered" by design, which the tests check, but no phone/OS notification exists.
- A reminder alert actually firing at its due time outside UTC. Jahari's run planned and stored a 4:32 PM
  reminder in the Mac's local time zone correctly, but the alert itself wasn't observed there.
- **Safari / WebKit and Firefox.** Playwright's WebKit and Firefox downloads were blocked by this
  environment's network policy (HTTP 403 from the proxy for `cdn.playwright.dev` and
  `playwright.download.prss.microsoft.com`). Only Chromium was tested.
- **Windows.** Setup, `make` and the venv paths were run on Linux (automated) and macOS (Jahari). Windows
  users without `make` should follow the manual commands in the README (`backend\.venv\Scripts\python`).
- Live Amazon Bedrock (see above).
- Concurrency: two runs controlling the same device at the same time are not coordinated.
- No automated accessibility audit; semantics checked by hand (labels, roles, focus styles, reduced motion).
