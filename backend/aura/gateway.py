"""Tool gateway: how the agent reaches household capabilities.

The production path is `MCPToolGateway`, a real MCP client talking Streamable HTTP to the AURA MCP server.
Tests may pass an in-process MCPServer instance instead of a URL; the calls still go through the MCP
client/server protocol layer (no HTTP).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from mcp import Client
from mcp.types import Implementation

log = logging.getLogger("aura.gateway")


@dataclass
class ToolResult:
    tool: str
    arguments: dict[str, Any]
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    timed_out: bool = False
    duration_ms: int = 0

    def summary(self) -> dict[str, Any]:
        return {"tool": self.tool, "arguments": self.arguments, "ok": self.ok, "error": self.error,
                "timed_out": self.timed_out, "duration_ms": self.duration_ms, "result": self.data}


class MCPToolGateway:
    def __init__(self, server: Any, timeout_s: float = 5.0):
        self.server = server  # URL string (Streamable HTTP) or in-process MCPServer
        self.timeout_s = timeout_s
        self._client: Client | None = None
        self._owner: asyncio.Task | None = None
        self._stop: asyncio.Event | None = None
        self._ready: asyncio.Event | None = None
        self._connect_error: BaseException | None = None
        self._lock = asyncio.Lock()
        self.protocol_version: str | None = None
        self.server_name: str | None = None

    @property
    def transport(self) -> str:
        return "streamable-http" if isinstance(self.server, str) else "in-process"

    async def _own(self) -> None:
        """Owns the client's lifetime in one task (the SDK's async context must enter/exit in the same task)."""
        assert self._stop is not None and self._ready is not None
        try:
            async with Client(
                self.server,
                read_timeout_seconds=self.timeout_s,
                client_info=Implementation(name="aura-verify-agent", version="0.1.0"),
            ) as client:
                self._client = client
                self.protocol_version = client.protocol_version
                self.server_name = client.server_info.name if client.server_info else None
                self._ready.set()
                await self._stop.wait()
        except BaseException as exc:  # noqa: BLE001 - surfaced to callers through _connect_error
            self._connect_error = exc
            self._ready.set()
        finally:
            self._client = None

    async def connect(self) -> None:
        async with self._lock:
            if self._client is not None and self._owner and not self._owner.done():
                return
            self._stop, self._ready, self._connect_error = asyncio.Event(), asyncio.Event(), None
            self._owner = asyncio.create_task(self._own(), name="mcp-client")
            await asyncio.wait_for(self._ready.wait(), timeout=self.timeout_s + 5)
            if self._connect_error is not None:
                err = self._connect_error
                raise ConnectionError(f"Could not connect to MCP server: {err!r}") from err

    async def close(self) -> None:
        if self._stop is not None:
            self._stop.set()
        if self._owner is not None:
            try:
                await asyncio.wait_for(self._owner, timeout=5)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                self._owner.cancel()
        self._client = None

    async def list_tools(self) -> list[dict[str, Any]]:
        await self.connect()
        assert self._client is not None
        result = await self._client.list_tools()
        return [{"name": t.name, "description": t.description,
                 "read_only": bool(t.annotations and t.annotations.read_only_hint)} for t in result.tools]

    async def call(self, tool: str, arguments: dict[str, Any]) -> ToolResult:
        started = time.perf_counter()
        try:
            await self.connect()
            assert self._client is not None
            result = await asyncio.wait_for(self._client.call_tool(tool, arguments), timeout=self.timeout_s)
        except asyncio.TimeoutError:
            await self._reset()
            return ToolResult(tool, arguments, ok=False, error=f"Timed out after {self.timeout_s:.1f}s",
                              timed_out=True, duration_ms=int((time.perf_counter() - started) * 1000))
        except Exception as exc:  # noqa: BLE001 - transport failures become explainable step errors
            log.warning("MCP call %s failed: %r", tool, exc)
            await self._reset()
            return ToolResult(tool, arguments, ok=False, error=f"MCP transport error: {exc}",
                              duration_ms=int((time.perf_counter() - started) * 1000))
        duration = int((time.perf_counter() - started) * 1000)
        if result.is_error:
            text = " ".join(getattr(c, "text", "") for c in result.content).strip()
            text = text.removeprefix(f"Error executing tool {tool}: ")
            return ToolResult(tool, arguments, ok=False, error=text or "Tool error", duration_ms=duration)
        data = result.structured_content
        if data is None:
            text = " ".join(getattr(c, "text", "") for c in result.content)
            try:
                data = json.loads(text)
            except ValueError:
                data = {"text": text}
        if isinstance(data, dict) and set(data) == {"result"}:
            data = data["result"] if isinstance(data["result"], dict) else {"value": data["result"]}
        return ToolResult(tool, arguments, ok=True, data=data, duration_ms=duration)

    async def _reset(self) -> None:
        try:
            await self.close()
        except Exception:  # noqa: BLE001
            pass
