"""Entry point: runs the MCP server and the API/web server side by side.

    python -m aura.main serve        # MCP on :8765/mcp, API + web UI on :8000
    python -m aura.main mcp          # MCP server only
    python -m aura.main reset        # restore demo household + memory (deletes history)

The two servers share one SQLite file but talk to each other only over MCP Streamable HTTP.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

import uvicorn

from .api import create_app
from .config import load_settings
from .mcp_server import build_mcp_server
from .services import HouseholdServices


async def serve() -> None:
    settings = load_settings()
    mcp_services = HouseholdServices(settings)
    mcp_services.seed()
    mcp_app = build_mcp_server(mcp_services).streamable_http_app(host=settings.mcp_host)
    api_app = create_app(settings)

    mcp_server = uvicorn.Server(uvicorn.Config(mcp_app, host=settings.mcp_host, port=settings.mcp_port,
                                               log_level="warning", access_log=False))
    api_server = uvicorn.Server(uvicorn.Config(api_app, host=settings.api_host, port=settings.api_port,
                                               log_level="info"))
    print(f"\n  AURA Verify (simulation)\n  MCP server  → {settings.mcp_url}\n"
          f"  Web + API   → http://{settings.api_host}:{settings.api_port}\n")
    await asyncio.gather(mcp_server.serve(), api_server.serve())


def cli() -> None:
    parser = argparse.ArgumentParser(prog="aura")
    parser.add_argument("command", choices=["serve", "mcp", "reset"], nargs="?", default="serve")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "httpx2", "mcp", "mcp.client", "mcp.server"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if args.command == "serve":
        asyncio.run(serve())
    elif args.command == "mcp":
        from .mcp_server import main as mcp_main

        mcp_main()
    elif args.command == "reset":
        services = HouseholdServices(load_settings())
        services.memory.forget_everything()
        services.sim.seed(force=True)
        print("Demo household, preferences and routines restored; history cleared.")


if __name__ == "__main__":
    cli()
