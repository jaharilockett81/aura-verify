"""Runtime configuration, read from environment variables (see .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader so judges don't need python-dotenv. Never overrides real env vars."""
    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if candidate.is_file():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
            return


@dataclass(frozen=True)
class Settings:
    db_path: Path
    api_host: str
    api_port: int
    mcp_host: str
    mcp_port: int
    mcp_url: str
    sim_settle_ms: int
    verify_timeout_s: float
    verify_poll_s: float
    tool_timeout_s: float
    max_attempts: int
    auto_retry_limit: int
    frontend_dist: Path
    timezone: str = ""  # IANA name for reminder due times; empty = this machine's local time zone
    delivery_ack_s: float = 20.0  # how long an open tab has to confirm it showed an alert
    cors_origins: list[str] = field(default_factory=list)


def load_settings() -> Settings:
    _load_dotenv()
    root = Path(__file__).resolve().parents[2]
    mcp_host = os.getenv("AURA_MCP_HOST", "127.0.0.1")
    mcp_port = int(os.getenv("AURA_MCP_PORT", "8765"))
    return Settings(
        db_path=Path(os.getenv("AURA_DB_PATH", str(root / "data" / "aura.db"))),
        api_host=os.getenv("AURA_API_HOST", "127.0.0.1"),
        api_port=int(os.getenv("AURA_API_PORT", "8000")),
        mcp_host=mcp_host,
        mcp_port=mcp_port,
        mcp_url=os.getenv("AURA_MCP_URL", f"http://{mcp_host}:{mcp_port}/mcp"),
        sim_settle_ms=int(os.getenv("AURA_SIM_SETTLE_MS", "600")),
        verify_timeout_s=float(os.getenv("AURA_VERIFY_TIMEOUT_S", "3.0")),
        verify_poll_s=float(os.getenv("AURA_VERIFY_POLL_S", "0.5")),
        tool_timeout_s=float(os.getenv("AURA_TOOL_TIMEOUT_S", "5.0")),
        max_attempts=int(os.getenv("AURA_MAX_ATTEMPTS", "3")),
        auto_retry_limit=int(os.getenv("AURA_AUTO_RETRY_LIMIT", "1")),
        frontend_dist=Path(os.getenv("AURA_FRONTEND_DIST", str(root / "frontend" / "dist"))),
        timezone=os.getenv("AURA_TZ", ""),
        delivery_ack_s=float(os.getenv("AURA_DELIVERY_ACK_S", "20")),
        cors_origins=[o for o in os.getenv("AURA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o],
    )
