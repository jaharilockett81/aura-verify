# Product feedback

Structured per the hackathon's Product Feedback questions. Based only on what we used while building
AURA Verify. Where we haven't used something live, we say so.

---

## Model Context Protocol: official Python SDK (`mcp` 2.3.0)

**What we used it for:** The AURA MCP server (`MCPServer`, 12 tools, Streamable HTTP via
`streamable_http_app()`), and the agent's MCP client (`mcp.Client`) that calls those tools. Also the
in-process client transport (`Client(server_instance)`) for fast tests that still go through the protocol
layer.

**What worked well**
- Type hints become tool schemas; returning a Pydantic model or dict gives `structured_content`.
- One `Client` class covers HTTP URLs, stdio and in-process servers, so the same engine code runs in tests
  and production.
- Version negotiation just worked: modern clients got 2026-07-28, `mode="legacy"` got 2025-11-25, same
  server.
- `ToolAnnotations` (`readOnlyHint`, `idempotentHint`) map neatly onto our permission tiers.
- The removed-`FastMCP` stub raises an error that points straight at the migration guide.

**What needs work**
- Ordinary exceptions in tools are redacted to "Error executing tool X"; only `ToolError` text reaches the
  client. Sensible for production, surprising in development and not obvious from the decorator docs.
- Choosing a handshake-era protocol version for testing isn't discoverable until you hit the `ValueError`.
- HTTP request logging comes from an `httpx2` logger that isn't silenced with the usual `httpx` setting.

**Onboarding (zero to hello world):** About 15 minutes, mostly spent confirming which major version was
installed and reading the package README, because many examples online still use v1's `FastMCP`.

**Would we build with it again?** **Yes.** The server/client symmetry and in-process testing made a
verifiable agent easy to test honestly. Details in FRICTION_LOG.md entries 1–4.

---

## Amazon Bedrock (Runtime, Converse API) via boto3

**What we used it for:** The planner (`backend/aura/planner/bedrock.py`): Converse with a system prompt,
household context as JSON, a single `submit_plan` tool with a JSON schema, `toolChoice: {"any": {}}`,
`temperature: 0`. The tool input is validated with Pydantic, unknown devices are rejected, and on any error
AURA falls back to the local planner and records the reason. Default model id is configurable
(`AURA_BEDROCK_MODEL_ID`).

**Status:** Implemented and tested against a stub client only. **Not yet run against live Bedrock** because
our build environment has no AWS credentials. We'll update this section after a live test; until then we
make no claims about latency, quality or cost.

**What worked well (from building against the API):** Converse's uniform request shape across models and
the tool-use mechanism for forcing structured output fit an agent planner well. Usage token counts in the
response let us show real numbers in the plan details instead of estimates.

**What needs work:** To be filled in after live testing.

**Onboarding:** Not measured yet (no live call made).

**Would we build with it again?** Pending a live run.

**AWS services used (for the AWS Builder mini challenge):** Amazon Bedrock Runtime (Converse API) for
intent-to-plan generation with forced tool-use structured output. Eligibility should only be declared after
the live test passes.

---

## FastAPI 0.157 / Uvicorn 0.54

**Used for:** REST API, Server-Sent Events stream, serving the built UI; running the MCP Starlette app and
the API in one process with two `uvicorn.Server`s under `asyncio.gather`.
**Worked well:** `httpx.ASGITransport` made API tests run in the same event loop as the engine's background
tasks.
**Needs work:** Nothing significant for our use.
**Onboarding:** Minutes. **Again?** Yes.

---

## Vite 8 + React 19 + TypeScript 6 + Tailwind CSS 4

**Used for:** The web companion UI.
**Worked well:** `npm create vite -- --template react-ts --no-interactive` scaffolded cleanly; Tailwind 4's
`@theme` tokens kept the "Calm Intelligence" palette in one place; builds take about a second.
**Needs work:** Nothing blocking.
**Onboarding:** Minutes. **Again?** Yes.

---

## Playwright Test 1.64

**Used for:** End-to-end tests of the three demo scenarios against an isolated backend started by
`webServer`, plus a mobile-viewport layout check. Also screenshots for design review.
**Worked well:** `webServer` with `env` made per-run isolation (fresh SQLite, faster simulator timings)
trivial; failure messages show the exact locator and DOM.
**Needs work:** Strict-mode matches include elements hidden by responsive CSS (FRICTION_LOG.md #6).
**Onboarding:** Minutes. **Again?** Yes.

---

## Feature requests

| Request | Why it matters | Priority |
|---|---|---|
| MCP SDK: development flag to forward tool exception text to clients | Faster debugging of agent/tool integration | Important |
| MCP SDK: accept handshake-era versions in `Client(mode=...)` | Easy compatibility testing against the hackathon's minimum spec | Nice-to-have |
| Alexa+ / MCP: a standard "verification" convention (e.g. a tool annotation marking a read that confirms another tool's effect) | Lets any agent distinguish "accepted" from "verified" without custom logic | Important |
