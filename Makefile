PY ?= python3
VENV := backend/.venv
BIN := $(VENV)/bin

.PHONY: setup build serve dev-api dev-web test test-backend test-e2e reset mcp

setup:            ## install backend + frontend dependencies
	$(PY) -m venv $(VENV)
	$(BIN)/pip install -q -e "backend[dev]"
	cd frontend && npm install

build:            ## build the web UI (served by the API at :8000)
	cd frontend && npm run build

serve: build      ## run MCP server (:8765/mcp) + API/web (:8000)
	cd backend && .venv/bin/python -m aura.main serve

dev-api:          ## backend only (use with dev-web for hot reload)
	cd backend && .venv/bin/python -m aura.main serve

dev-web:          ## Vite dev server on :5173, proxying /api to :8000
	cd frontend && npm run dev

mcp:              ## standalone MCP server only
	cd backend && .venv/bin/python -m aura.main mcp

test: test-backend test-e2e

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-e2e: build   ## Playwright; set PW_CHROMIUM_PATH to use an existing Chromium
	cd frontend && npx playwright test

reset:            ## restore demo household and memory, clear history
	cd backend && .venv/bin/python -m aura.main reset
