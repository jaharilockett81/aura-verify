# Test report

Last updated: 2026-10-22 (UTC). Every result marked as passed comes from a command that was actually run.
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

## Backend: `make test-backend` (pytest) — 52 passed, 0 failed

| File | Tests | Covers |
|---|---|---|
| `test_simulator.py` | 12 | Ack before settle ≠ state; energy-saver hold acks but ignores setpoint; release-hold applies; idempotency key prevents double apply; 5 invalid-command cases; unreachable device unreadable and command lost; drop-next-command drops exactly one; state persists across instances |
| `test_engine.py` | 16 | Scenario 1 plan from memory, approval gate (no commands before approval), end-to-end verified with ack recorded before verification, re-run skips redundant commands, declining a sensitive step sends nothing, cancel before approval; Scenario 2 mismatch detected, explained and recovered with approval (attempt 2), retries bounded at 3 (also enforced by the MCP tool), dropped command auto-retried once, unreachable device ends UNKNOWN not success; Scenario 3 preference persists across fresh service/engine objects on the same DB and is applied in a new session; clarification for missing temperature; out-of-range plan rejected; read-only query runs without approval; unknown request creates no run; event timeline order; runs interrupted by a restart are not reported as success |
| `test_mcp_http.py` | 7 | Real Streamable HTTP (uvicorn): 12 tools listed with annotations; **2025-11-25 legacy handshake**; ack + independent verification; MISMATCH reported; tool errors explained; gateway reports transport/protocol; full workflow over HTTP incl. `get_execution_status` / `get_execution_history` |
| `test_api.py` | 6 | Health reports MCP connection; chat → approve → confirm → COMPLETED (double approve → 409); recovery via API; preference edit/validation/reset; forget-everything restores defaults; demo fault controls |
| `test_planners.py` | 11 | Local planner maps the four prompt phrasings to the right routines; preference vs device command. **Bedrock planner with a stub client (mocked, no AWS call):** forced tool call parsed, request shape (`toolChoice`, `temperature`); routine actions come from memory, not the model; engine falls back to local and discloses the error; hallucinated device rejected; retry without forced tool choice; string preference values coerced |

## End to end: `make test-e2e` (Playwright, Chromium) — 8 passed, 0 failed

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

## Not tested

- **Real speech recognition and spoken replies** in Chrome/Edge/Safari (needs a microphone; the build
  environment is headless).
- **Safari / WebKit and Firefox.** Playwright's WebKit and Firefox downloads were blocked by this
  environment's network policy (HTTP 403 from the proxy for `cdn.playwright.dev` and
  `playwright.download.prss.microsoft.com`). Only Chromium was tested.
- **Windows and macOS.** Setup, `make`, and the venv paths were only run on Linux. Windows users without
  `make` should follow the manual commands in the README (`backend\.venv\Scripts\python`).
- Live Amazon Bedrock (see above).
- Concurrency: two runs controlling the same device at the same time are not coordinated.
- No automated accessibility audit; semantics checked by hand (labels, roles, focus styles, reduced motion).

### Manual checklist for Jahari's machine (to fill in)

| Check | Chrome (macOS/Win) | Safari (macOS) | Result |
|---|---|---|---|
| `make setup && make serve`, open http://127.0.0.1:8000 | | n/a | |
| Mic button → allow microphone → say "Get everything prepared for bedtime" → plan appears | | Needs Siri/Dictation enabled | |
| Voice replies toggle on → AURA reads replies aloud | | | |
| Three scenarios by clicking (as in DEMO_SCRIPT.md) | | | |
| Bedrock: `scripts/bedrock_check.py` all PASS | n/a | n/a | |
