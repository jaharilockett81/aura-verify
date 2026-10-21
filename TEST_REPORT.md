# Test report

Last updated: 2026-10-21 (UTC). Every result below comes from a command that was actually run.

## Environment

- Linux x86_64 container, Node.js 22.22.0, npm 10.9.4
- Python 3.13.16 (development) and **Python 3.11.15** (clean-clone run)
- MCP Python SDK 2.3.0, FastAPI 0.157.0, Uvicorn 0.54.0, Pydantic 2.13.5
- Playwright Test 1.64.1 using a pre-installed Chromium (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`)
- No AWS credentials present, so the local planner was active for all runs

## Clean-clone check (Python 3.11)

```bash
git clone <repo> clean && cd clean
make setup PY=python3.11          # venv + pip install -e "backend[dev]" + npm install   (≈52 s)
make test-backend                 # 50 passed in 18.64s
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium make test-e2e   # build + 6 passed (24.3s)
```

## Backend: `make test-backend` (pytest) — 50 passed, 0 failed

| File | Tests | Covers |
|---|---|---|
| `test_simulator.py` | 12 | Ack before settle ≠ state; energy-saver hold acks but ignores setpoint; release-hold applies; idempotency key prevents double apply; 5 invalid-command cases; unreachable device unreadable and command lost; drop-next-command drops exactly one; state persists across instances |
| `test_engine.py` | 16 | Scenario 1 plan from memory, approval gate (no commands before approval), end-to-end verified with ack recorded before verification, re-run skips redundant commands, declining a sensitive step sends nothing, cancel before approval; Scenario 2 mismatch detected/explained/recovered with approval (attempt 2), retries bounded at 3 (also enforced by the MCP tool), dropped command auto-retried once, unreachable device ends UNKNOWN not success; Scenario 3 preference persists across fresh service/engine objects on the same DB and is applied in a new session; clarification for missing temperature; out-of-range plan rejected; read-only query runs without approval; unknown request creates no run; event timeline order; runs interrupted by a restart are not reported as success |
| `test_mcp_http.py` | 7 | Real Streamable HTTP (uvicorn): 12 tools listed with annotations; **2025-11-25 legacy handshake**; ack + independent verification; MISMATCH reported; tool errors explained; gateway reports transport/protocol; full workflow over HTTP incl. `get_execution_status` / `get_execution_history` |
| `test_api.py` | 6 | Health reports MCP connection; chat → approve → confirm → COMPLETED (double-approve → 409); recovery via API; preference edit/validation/reset; forget-everything restores defaults; demo fault controls |
| `test_planners.py` | 9 | Local planner maps the four prompt phrasings to the right routines; preference vs device command; Bedrock planner parses a forced tool call and sets `toolChoice`/`temperature` (stub client); routine actions from memory, not the model; engine falls back to local and discloses the Bedrock error; hallucinated device rejected |

## End to end: `make test-e2e` (Playwright) — 6 passed, 0 failed

Runs against an isolated server (ports 8100/8101, temporary SQLite, faster simulator timings).

1. Scenario 1: overnight shift routine runs, pauses for the lock, verifies every step (5/5), dashboard shows Locked and 72°F
2. Scenario 2: thermostat acknowledges but doesn't change; UI shows Verification failed, "still reports 76°F", MISMATCH in the MCP log; recovery with approval reaches Verified, "Attempt 2/3", "Recovered" in summary
3. Scenario 3: preference saved and verified, visible in Memory ("by assistant"), new session + full page reload, bedtime plan uses 70°F with provenance, then runs to Everything verified
4. Read-only question answered from an observed state read without approval
5. History filters, Memory forget-confirmation (cancelled), Demo controls dialog
6. Mobile (Pixel 7 viewport): bottom navigation works, no horizontal overflow

During development the e2e suite first failed 4/6: three locator strict-mode issues in the tests and one
real layout bug (the Home grid overflowed horizontally on mobile). Both were fixed; the runs above are after
the fixes.

## Manual checks

- `python -m aura.main serve`: `/api/health` reported `connected: true`, 12 tools, protocol `2026-07-28`,
  transport `streamable-http`.
- **Preferences survive a real process restart:** set bedtime temperature to 70 via `/api/chat`, killed the
  server process, started it again; `/api/memory` returned 70 (`source: assistant`) and a new bedtime plan
  showed "Set the thermostat to 70°F | From memory: Bedtime temperature = 70°F".
- Screenshots of Home, plan preview, mismatch/recovery and mobile were reviewed for layout.

## Not tested / remaining limitations

- **Amazon Bedrock has not been called live.** Only stubbed. Needs AWS credentials and model access.
- Voice input (Web Speech API) and spoken replies were not exercised in automated tests (headless Chromium
  has no microphone); the text path they feed is fully tested. Needs a manual check in Chrome/Edge/Safari.
- Not tested on Windows or macOS, or in Firefox/Safari.
- No load or concurrency testing beyond sequential runs; two runs targeting the same device at once are not
  coordinated.
- No accessibility audit tool was run; semantics were checked by hand (labels, roles, focus styles,
  reduced-motion).
