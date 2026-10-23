import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Starts an isolated AURA backend (fresh SQLite file, separate ports) serving the built UI.
// Run `npm run build` first. Uses a pre-installed Chromium if PW_CHROMIUM_PATH is set.
const PORT = 8100
const db = join(tmpdir(), `aura-e2e-${Date.now()}.db`)
const python = process.env.AURA_PYTHON ?? '../backend/.venv/bin/python'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /(mobile|chat)\.spec\.ts/ },
  ],
  webServer: {
    command: `${python} -m aura.main serve`,
    cwd: '../backend',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      AURA_DB_PATH: db,
      AURA_API_PORT: String(PORT),
      AURA_MCP_PORT: String(PORT + 1),
      AURA_SIM_SETTLE_MS: '300',
      AURA_VERIFY_TIMEOUT_S: '1.5',
      AURA_VERIFY_POLL_S: '0.3',
    },
  },
})
