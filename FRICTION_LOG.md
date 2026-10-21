# Friction log

Only issues we actually hit while building AURA Verify (October 21, 2026, Linux, Python 3.13, Node 22) are
listed. Each entry says how we observed it. Nothing here is hypothetical.

---

### 1. Tool exceptions are hidden from the MCP client unless you raise a specific class

- **Tool / version:** MCP Python SDK (`mcp`) 2.3.0, `MCPServer`
- **Task:** Return a readable error ("no such device") from a tool to the calling agent.
- **Steps:** In a prototype tool, `raise ValueError("no such device")`; call it with `Client.call_tool`.
- **Expected:** `is_error=True` with the message, as the v1 SDK did for ordinary exceptions.
- **Actual:** `is_error=True` with only `"Error executing tool read"`. The message stays in server logs.
  Reading `mcpserver/tools/base.py` showed that only `ToolError`/`ResourceError` messages are forwarded;
  everything else is treated as a crash and redacted.
- **Severity:** Medium. Agents can't explain failures to users, and the behaviour change from v1 is easy to
  miss.
- **Workaround:** Catch domain errors and re-raise `mcp.server.mcpserver.exceptions.ToolError`
  (`backend/aura/mcp_server.py::_call`).
- **Suggestion:** Document this prominently in the v2 migration guide and in the `tool()` docstring, and
  consider a debug flag that forwards exception text in development.

### 2. `FastMCP` is gone in SDK 2.x; most tutorials still use it

- **Tool / version:** `mcp` 2.3.0 (installed by default from PyPI with `pip install mcp`)
- **Task:** Create a server following common MCP Python examples (`from mcp.server.fastmcp import FastMCP`).
- **Steps:** Inspected the installed package before writing code: `mcp/server/fastmcp.py` exists only to
  raise `ModuleNotFoundError` with a pointer to the migration guide; the class is now
  `mcp.server.MCPServer`.
- **Expected:** Examples on the MCP getting-started docs and blog posts to match the version pip installs.
- **Actual:** A fresh install gets 2.x, where v1-style examples fail at import. The error message is
  helpful, which made this a quick fix.
- **Severity:** Low (clear error), but it affects every newcomer following older material.
- **Workaround:** Use `MCPServer` and read the installed package's README and source.
- **Suggestion:** Keep the quick-start pages version-tagged, and have hackathon resources state which major
  version they assume.

### 3. Testing the 2025-11-25 handshake needs an explicit client mode

- **Tool / version:** `mcp` 2.3.0 `Client`
- **Task:** Prove our server works with the hackathon's minimum spec version (2025-11-25).
- **Steps:** `async with Client(url) as c: print(c.protocol_version)`
- **Expected:** A way to pick the protocol version to test against.
- **Actual:** Default `mode="auto"` negotiates `2026-07-28` (via `server/discover`). Running
  `Client(url, mode="2025-11-25")` raises `ValueError: mode must be 'legacy', 'auto', or one of
  ['2026-07-28'] ... use mode='legacy'`. The error is clear, but the option isn't discoverable before you
  hit it.
- **Severity:** Low.
- **Workaround:** `Client(url, mode="legacy")` in `backend/tests/test_mcp_http.py`.
- **Suggestion:** Accept handshake-era version strings in `mode` (mapping them to the legacy handshake), or
  include the hint in the docs, not only the error.

### 4. SDK HTTP logging floods the console under a different logger name

- **Tool / version:** `mcp` 2.3.0 Streamable HTTP client
- **Task:** Keep server output readable during the demo.
- **Steps:** Ran the agent with `logging.basicConfig(level=INFO)` and silenced the `httpx` logger as usual.
- **Expected:** Request logs to disappear.
- **Actual:** Every MCP call still printed `INFO httpx2: HTTP Request: POST http://127.0.0.1:8765/mcp ...`.
  The client uses a separate `httpx2` package with its own logger name.
- **Severity:** Low.
- **Workaround:** Also set `logging.getLogger("httpx2")` to WARNING (`backend/aura/main.py`).
- **Suggestion:** Mention the dependency/logger in docs, or default it to WARNING.

### 5. Could not exercise Amazon Bedrock in the build environment

- **Tool:** Amazon Bedrock Runtime (Converse API) via boto3
- **Task:** Run the Bedrock planner end to end.
- **Steps:** The build environment has no AWS credentials, so `boto3.Session().get_credentials()` returns
  `None` and AURA selects the local planner.
- **Expected / Actual:** N/A, not a product defect. Recorded so nobody reads the Bedrock code as live-tested.
- **Severity:** Blocks the AWS Builder mini-challenge claim until resolved.
- **Workaround:** Bedrock planner unit-tested with a stub client (request shape, tool parsing, fallback).
- **Suggestion:** None for AWS yet. Update this entry after a live test.

### 6. Responsive layouts trip Playwright strict mode

- **Tool / version:** Playwright Test 1.64.1
- **Task:** Assert the MCP status pill is visible.
- **Steps:** `expect(page.getByText(/MCP · Streamable HTTP/)).toBeVisible()`
- **Expected:** Pass, since only one pill is visible at 1440 px.
- **Actual:** Strict mode violation: two matches, one inside an `lg:hidden` container (not displayed). Strict
  mode counts hidden elements too.
- **Severity:** Low.
- **Workaround:** Scope locators to a region or use `.first()` on known-visible ordering.
- **Suggestion:** A documented `visible: true` locator option example in the strictness docs would save time.
