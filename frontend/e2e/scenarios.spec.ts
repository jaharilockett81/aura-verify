import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const SHOTS = process.env.AURA_SHOTS_DIR

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

test.beforeEach(async ({ request, page }) => {
  // Fresh household + memory for every scenario (uses the app's own privacy/demo controls).
  expect((await request.post('/api/memory/forget')).ok()).toBeTruthy()
  expect((await request.post('/api/demo/reset')).ok()).toBeTruthy()
  expect((await request.delete('/api/demo/faults')).ok()).toBeTruthy()
  await page.addInitScript(() => localStorage.clear())
})

async function approvePlan(page: Page) {
  await page.getByRole('button', { name: 'Approve & run' }).first().click()
  await expect(page).toHaveURL(/\/runs\/run_/)
}

async function confirmLock(page: Page) {
  const confirm = page.getByRole('button', { name: /Confirm: lock the front door/i })
  await expect(confirm).toBeVisible({ timeout: 20_000 })
  await confirm.click()
}

test('Scenario 1: overnight shift routine runs, pauses for the lock, and verifies every step', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/MCP · Streamable HTTP/).first()).toBeVisible()
  await page.getByRole('button', { name: /prepare the house before my overnight shift/ }).click()

  await expect(page.getByText('Run routine: Overnight shift').first()).toBeVisible()
  await expect(page.getByText('Set the thermostat to 72°F')).toBeVisible()
  await expect(page.getByText(/Plan preview: nothing has run yet/)).toBeVisible()
  await shot(page, '01-plan-preview')

  await approvePlan(page)
  await confirmLock(page)
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('5/5 verified')).toBeVisible()
  await expect(page.getByText('set_device_state').first()).toBeVisible()
  await shot(page, '02-overnight-verified')

  await page.getByRole('link', { name: 'Home' }).first().click()
  const status = page.getByRole('region', { name: 'Household status' })
  await expect(status.getByText('Locked', { exact: true })).toBeVisible()
  await expect(status.getByText('72°F', { exact: true })).toBeVisible()
})

test('Scenario 2: thermostat acknowledges but does not change; AURA detects, explains, recovers with approval', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run the thermostat failure demo' }).click()
  await expect(page.getByText('Run routine: Overnight shift').first()).toBeVisible()
  await approvePlan(page)

  const recovery = page.getByRole('region', { name: 'Recovery options' })
  await expect(recovery).toBeVisible({ timeout: 20_000 })
  await expect(recovery.getByText('Verification failed')).toBeVisible()
  await expect(recovery.getByText(/still reports 76°F/)).toBeVisible()
  await expect(recovery.getByText(/energy-saver hold/).first()).toBeVisible()
  await expect(page.getByText('MISMATCH').first()).toBeVisible()
  await shot(page, '03-thermostat-mismatch')

  await recovery.getByRole('button', { name: /Release the hold and set 72°F/ }).click()
  await confirmLock(page)
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Recovered: Set the thermostat to 72°F/)).toBeVisible()
  await expect(page.getByText('Attempt 2/3')).toBeVisible()
  await shot(page, '04-thermostat-recovered')
})

test('Scenario 3: a preference change persists and is applied in a new session', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Ask AURA').fill('Actually, I prefer my bedtime temperature at 70 degrees.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/I'll remember bedtime temperature as 70°F \(it was 68°F\)/)).toBeVisible()
  await expect(page.getByText(/Done, and verified/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Memory' }).first().click()
  const row = page.getByRole('listitem').filter({ hasText: 'Bedtime temperature' })
  await expect(row.getByText('70°F', { exact: true })).toBeVisible()
  await expect(row.getByText(/by assistant/)).toBeVisible()
  await shot(page, '05-memory-updated')

  await page.getByRole('link', { name: 'Home' }).first().click()
  await page.getByRole('button', { name: /New session/ }).click()
  await expect(page.getByText('Try one of these:')).toBeVisible()
  await page.reload() // a full page reload: nothing but the server's stored memory carries over
  await page.getByLabel('Ask AURA').fill('Get everything prepared for bedtime.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Set the thermostat to 70°F')).toBeVisible()
  await expect(page.getByText(/Bedtime temperature = 70°F/)).toBeVisible()
  await shot(page, '06-bedtime-uses-70')

  await approvePlan(page)
  await confirmLock(page)
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
})

test('Read-only questions run without approval and report observed state', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Ask AURA').fill("What's the thermostat at?")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Thermostat reports 76°F/)).toBeVisible({ timeout: 10_000 })
})

test('History and memory screens are navigable with working controls', async ({ page }) => {
  await page.goto('/history')
  await expect(page.getByText('Every action, with its evidence.')).toBeVisible()
  await page.getByRole('tab', { name: 'Failed' }).click()
  await expect(page.getByText('No runs match this filter.')).toBeVisible()
  await page.goto('/memory')
  await page.getByRole('button', { name: 'Forget everything' }).click()
  await expect(page.getByText(/Delete preferences, routines, reminders and history\?/)).toBeVisible()
  await page.getByRole('button', { name: 'Keep' }).click()
  await page.getByRole('button', { name: /Demo controls/ }).click()
  await expect(page.getByRole('dialog', { name: 'Demo controls' })).toBeVisible()
  await page.keyboard.press('Escape')
})
