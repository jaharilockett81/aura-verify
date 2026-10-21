"""AURA Verify MCP server (Model Context Protocol over Streamable HTTP).

Built on the official MCP Python SDK (`mcp` 2.x). It negotiates protocol 2026-07-28 with modern clients and
falls back to the 2025-11-25 initialize handshake for older ones.

Run standalone:  python -m aura.mcp_server      (serves http://127.0.0.1:8765/mcp)
"""

from __future__ import annotations

from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .config import load_settings
from .services import HouseholdServices, ServiceError

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE_IDEMPOTENT = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True,
                                   openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)

INSTRUCTIONS = """AURA Verify household tools (SIMULATED devices; nothing real is controlled).
Rules for agents:
1. set_device_state returns an acknowledgement only. It is NOT evidence the device changed.
2. After any write, call verify_action with the expected state. Only a VERIFIED verdict counts as success.
3. A MISMATCH means the action failed; UNKNOWN means the outcome cannot be determined. Report both honestly.
4. retry_failed_action is bounded per step; do not loop."""


def _call(fn, *args, **kwargs) -> Any:
    try:
        return fn(*args, **kwargs)
    except ServiceError as exc:
        raise ToolError(str(exc)) from exc


def build_mcp_server(services: HouseholdServices) -> MCPServer:
    mcp = MCPServer(
        "aura-verify",
        title="AURA Verify Household Tools",
        description="Simulated smart-home control, household memory and an execution ledger with independent "
                    "verification.",
        instructions=INSTRUCTIONS,
        version="0.1.0",
    )

    @mcp.tool(annotations=READ)
    def get_household_context() -> dict[str, Any]:
        """Return saved preferences, routines, devices, recent reminders and unresolved issues."""
        return _call(services.household_context)

    @mcp.tool(annotations=READ)
    def list_available_devices() -> dict[str, Any]:
        """List simulated devices and the attributes each one accepts."""
        return {"devices": _call(services.list_devices), "simulated": True}

    @mcp.tool(annotations=READ)
    def read_device_state(device_id: str) -> dict[str, Any]:
        """Read a device's reported state through the independent state channel.

        Errors starting with UNREACHABLE mean the device could not be observed.
        """
        return _call(services.read_device_state, device_id)

    @mcp.tool(annotations=WRITE_IDEMPOTENT)
    def set_device_state(device_id: str, attributes: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        """Send a command to a simulated device. Returns the hub's acknowledgement only (not verification).

        Reusing an idempotency_key returns the original acknowledgement without re-applying the command.
        """
        return _call(services.set_device_state, device_id, attributes, idempotency_key)

    @mcp.tool(annotations=READ)
    def verify_action(target: str, expected: dict[str, Any]) -> dict[str, Any]:
        """Independently check that `target` is in the `expected` state.

        target: 'device:<device_id>', 'reminder:<reminder_id>' or 'preference:<key>'.
        Returns verdict VERIFIED, MISMATCH or UNKNOWN with the observed evidence.
        """
        return _call(services.verify_action, target, expected)

    @mcp.tool(annotations=WRITE)
    def retry_failed_action(step_id: str, strategy: str = "retry") -> dict[str, Any]:
        """Re-issue a FAILED/UNKNOWN device step from the execution ledger, within its attempt budget.

        strategy: 'retry' (resend as-is) or 'release_hold_and_reapply' (thermostat only: clear an
        energy-saver hold and re-apply the setpoint in one command). Verify afterwards.
        """
        return _call(services.retry_failed_action, step_id, strategy)

    @mcp.tool(annotations=READ)
    def get_routine(routine_id: str) -> dict[str, Any]:
        """Return a saved routine and its actions resolved against current preferences."""
        return _call(services.get_routine, routine_id)

    @mcp.tool(annotations=WRITE_IDEMPOTENT)
    def save_routine(routine: dict[str, Any]) -> dict[str, Any]:
        """Create or replace a routine: {id, name, description, triggers[], steps[]}."""
        return _call(services.save_routine, routine)

    @mcp.tool(annotations=WRITE_IDEMPOTENT)
    def update_preference(key: str, value: Any) -> dict[str, Any]:
        """Change a saved household preference (validated). Returns the new and previous value."""
        return _call(services.update_preference, key, value)

    @mcp.tool(annotations=WRITE_IDEMPOTENT)
    def create_reminder(title: str, idempotency_key: str, due: str | None = None, note: str | None = None,
                        category: str = "general") -> dict[str, Any]:
        """Store a household reminder (simulated delivery). `due` is a 24-hour time such as 21:30."""
        return _call(services.create_reminder, title, due, note, category, idempotency_key)

    @mcp.tool(annotations=READ)
    def get_execution_status(run_id: str) -> dict[str, Any]:
        """Return the status, per-step assurance level and evidence for one workflow run."""
        return _call(services.execution_status, run_id)

    @mcp.tool(annotations=READ)
    def get_execution_history(limit: int = 10) -> dict[str, Any]:
        """Return recent workflow runs with per-status step counts."""
        return {"runs": _call(services.execution_history, limit)}

    return mcp


def main() -> None:
    import uvicorn

    settings = load_settings()
    services = HouseholdServices(settings)
    services.seed()
    app = build_mcp_server(services).streamable_http_app(host=settings.mcp_host)
    uvicorn.run(app, host=settings.mcp_host, port=settings.mcp_port, log_level="info")


if __name__ == "__main__":
    main()
