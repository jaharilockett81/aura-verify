# Implementation report: demo fixes, conversation, timers and verified reminders

Branch `ui-desktop-polish`, 2026-10-23. Test results are in [TEST_REPORT.md](TEST_REPORT.md); every
"tested" item below was run. Note: the original "conversational capabilities" prompt was never received in
this workspace, so the scope used is the seven-point list in the 2026-10-23 clarification plus the demo-fix
list.

## Implemented and tested

| Area | What changed | Tests |
|---|---|---|
| **75°F ran as 72°F** | Root cause: routine steps always took the saved preference and ignored a temperature in the same sentence. The planner now extracts explicit temperatures and applies them as one-off overrides (the plan says the value came from your request). Out-of-range or conflicting values ask a clarifying question instead of being replaced. The saved preference is not changed. Bedrock's planner maps its value the same way. | pytest `test_explicit_values.py`; e2e `chat.spec.ts` |
| **Input bar covering messages** | Scroll margin under the newest message matches the input bar height; the view stays pinned to the bottom while replies and plan cards grow, and is released only when you scroll up. No visual redesign. | e2e `chat.spec.ts` (desktop and mobile) |
| **Greetings / wake words** | "Hey Aura", "Hi", "Good morning, Alexa" etc. get a short reply that says AURA uses a local rule-based planner and lists what it can do. Wake words ("Alexa,", "OK Alexa", "Hey Aura") are stripped before planning. No run is created for a greeting. | pytest, e2e |
| **Multi-action commands** | "Turn off the bedroom lights, set the thermostat to 75 degrees, and lock the front door" → one plan with one step per action; the lock still needs confirmation; every step runs through MCP and is verified by its own independent read. An unclear part triggers a question instead of being dropped. | pytest, e2e |
| **Timers** | Create, start, pause, resume, check time left, cancel, by chat or the new Timers card on Home. Stored in SQLite (survive restarts), executed through three new MCP tools and verified by reading back. When a timer finishes with no tab open it is recorded as "Not delivered", never as alerted. | pytest, e2e |
| **Verified reminders** | Reminders can carry a device check ("remind me to lock the front door in 30 minutes"). When due: alert in the open tab; delivery status is NOT_DELIVERED (no tab open), PENDING, DELIVERED_IN_APP (only when the page confirms it showed/spoke it) or UNCONFIRMED. Outcome is VERIFIED only after an independent device read; "I did it" on a reminder without a check is "Confirmed by you". A mismatch offers "Plan a fix", which creates a normal approval-required run and re-checks afterwards. Snooze and dismiss (dismiss is not "done"). Every step is added to an evidence history shown in Memory. | pytest `test_reminders.py`; e2e |
| **Corrections and follow-ups** | "Actually, make it 74" replaces an unapproved plan (the old one is cancelled, nothing was sent) or plans only the changed step after it ran. "Did it work?", "Is it locked?", "What about the porch light?" and pronouns use the session's last run and devices. | pytest, e2e |
| **Spoken replies** | With Voice replies on, AURA speaks confirmations, clarifying questions, reminder/timer alerts and verification results. Plan replies say "once you approve"; "Done, and verified" is spoken only after verification. A reminder is marked "spoken" only if the browser actually started speaking. | e2e with a fake speechSynthesis |
| **Preserved** | Pastel desktop layout, orb, MCP gateway (now 15 tools), approvals, verification, recovery, memory. All 52 original pytest and 8 original Playwright tests still pass unchanged. | full suites |

Config added: `AURA_TZ` (household timezone for "at 9 pm", default UTC) and `AURA_DELIVERY_ACK_S`
(seconds before an unacknowledged alert becomes Unconfirmed, default 20). Both in `.env.example`.

## Demo-only controls (labelled)

"Make due now (demo)" in Memory fires a reminder immediately so the flow can be shown without waiting. It
is recorded in the reminder's history as a demo action. The alert, check, fix and verification after that
are the real code paths.

## Deferred / not done

- **Live Bedrock.** Bedrock planner changes are tested with a stub client only. The live model has not
  been asked to produce timers or corrections; those work in the local planner.
- **Real microphone and speakers.** Not available in the build environment; tests use fakes.
- **Alerts when the app is closed.** No push or OS notifications. Such alerts are honestly recorded as
  "Not delivered".
- **Browsers other than Chromium**, and Windows/macOS setup.
- **Free-form conversation.** The local planner understands a fixed set of phrasings. Known gap: a
  verb-less trailing clause such as "turn on the porch light and dance" can still drop "dance" silently.
- Timezones other than UTC were not exercised.
