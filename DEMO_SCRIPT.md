# AURA Verify demo video script (target 2:45, hard limit under 3:00)

**Setup before recording:** `make reset && make serve`, open http://127.0.0.1:8000 at 1440×900, voice
replies on (Settings gear → Voice replies), Demo controls closed. Rehearse once. Measured at default settings: the
thermostat failure is detected about 5 seconds after approval (3 s verification window by design), recovery
verifies in about 1 second. Narrate over those waits rather than cutting them: the wait *is* the verification.

Do not show trademarks you don't have rights to (no Echo device footage, no Alexa logos). Say
"Alexa+-style" and keep the on-screen "simulation" labels visible.

---

### 0:00–0:20 · The problem
*Screen: Home, greeting.*

> "Voice assistants are great at saying 'OK.' But 'OK' only means a server accepted the command. If your
> thermostat ignores it, you find out at 3 a.m. AURA Verify is an Alexa+-style household agent that doesn't
> just act. It proves the action happened."

### 0:20–0:55 · Scenario 1: overnight shift
*Click the "Overnight shift" chip (it sends "Alexa, prepare the house before my overnight shift.").*

> "I work overnight. AURA pulls my routine from memory and shows the plan before anything runs: lights,
> porch light, 72 degrees for my cat Luna, a feeding reminder, and the door lock."

*Point at the provenance line under the thermostat step. Click Approve & run.*

> "Each step goes through a real MCP server over Streamable HTTP. Watch the ladder: proposed, authorized,
> accepted by the hub, and only then verified by a separate state read."

*Command Center: steps turn teal; MCP tool activity scrolls. The lock pauses.*

> "Locking the door is sensitive, so AURA asks me separately."

*Click Confirm. "Everything verified, 5 of 5."*

### 0:55–1:50 · Scenario 2: the silent failure (signature moment)
*Back to Home. Click the "Run failure demo" card. Approve.*

> "Now the real world fights back. I've put the simulated thermostat into an energy-saver hold, and AURA
> doesn't know. The hub says 'accepted' to 72 degrees, exactly like a real API would."

*Thermostat step: Verifying… then Failed. Amber recovery card.*

> "But the independent read still says 76, for the whole verification window. AURA marks it failed,
> not done. It reads the device again to diagnose: the energy-saver hold is overriding setpoints."

*Point to Expected 72 / Observed 76 ✗, then the MCP log showing ACK followed by MISMATCH.*

> "It offers a fix, releasing the hold and re-applying 72, and because that overrides my energy program,
> it asks first. Retries are capped at three attempts, enforced on the server."

*Click "Allow recovery" (AURA recommends releasing the hold and setting 72°F). Attempt 2/3 → Verified. Confirm the lock.*

> "Recovered, and verified. The summary tells me exactly what went wrong and what it did."

### 1:50–2:25 · Scenario 3: memory across sessions
*Home. Type or say: "Actually, I prefer my bedtime temperature at 70 degrees."*

> "Preferences live in structured memory, not chat history. AURA saves it and verifies by reading it back."

*Open Memory briefly: Bedtime temperature 70°F, "by assistant". Back to Home, click New session (optionally
show restarting the server in a terminal).*

> "Brand-new session. Same household."

*Say: "Get everything prepared for bedtime."*

> "The plan uses 70, and tells me where that number came from."

### 2:25–2:45 · How it's built + close
*History screen, then flash the MCP tool panel.*

> "Under the hood: a self-hosted MCP server on the official Python SDK, protocol 2025-11-25 and newer, a
> verification engine with explicit states, idempotency and bounded recovery, SQLite memory, and a planner
> that uses Amazon Bedrock when configured. Devices here are simulated, and labeled that way. AURA Verify:
> the assistant that proves it."

---

**If Bedrock is configured for the recording**, mention it only if the header shows "Planner · Amazon
Bedrock" during the take. Otherwise keep the line "uses Amazon Bedrock when configured".
