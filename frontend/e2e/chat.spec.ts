import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Regression: the sticky input bar used to cover the newest message and its plan card.
// Runs in both the desktop (1440×900) and mobile (Pixel 7) projects.

test.beforeEach(async ({ request, page }) => {
  expect((await request.post('/api/memory/forget')).ok()).toBeTruthy()
  expect((await request.post('/api/demo/reset')).ok()).toBeTruthy()
  await page.addInitScript(() => localStorage.clear())
})

async function inputTop(page: Page) {
  const box = await page.getByLabel('Ask AURA').locator('xpath=ancestor::form[1]').boundingBox()
  return box!.y
}

/** Bottom edge (in viewport coordinates) of the newest assistant reply, including its plan card if any. */
async function newestBottom(page: Page) {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll('[data-role="assistant"]')
    const last = bubbles[bubbles.length - 1]
    const row = last?.closest('.flex') ?? last
    return row ? row.getBoundingClientRect().bottom : 0
  })
}

async function say(page: Page, text: string) {
  const before = await page.locator('[data-role="assistant"]').count()
  await page.getByLabel('Ask AURA').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('[data-role="user"]').last()).toHaveText(text)
  await expect.poll(() => page.locator('[data-role="assistant"]').count(), { timeout: 15_000 }).toBeGreaterThan(before)
  // The newest reply (and any plan card that loads under it) must end above the input bar.
  await expect.poll(async () => (await inputTop(page)) - (await newestBottom(page)), { timeout: 5_000 }).toBeGreaterThanOrEqual(0)
}

test('newest message and plan card stay visible above the input bar', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Hi Aura')
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('local rule-based planner')
  await say(page, "What's the thermostat at?")
  // The read-only check reports back in a second message once the state read finishes.
  await expect(page.locator('[data-role="assistant"]', { hasText: '76°F' })).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => (await inputTop(page)) - (await newestBottom(page))).toBeGreaterThanOrEqual(0)
  await say(page, 'thanks')
  await say(page, 'Prepare the house before my overnight shift at 75 degrees.')
  // The explicit temperature reaches the plan instead of the saved 72°F preference.
  await expect(page.getByText('Set the thermostat to 75°F').last()).toBeVisible()
  await expect(page.getByText('Set the thermostat to 72°F')).toHaveCount(0)
  await say(page, 'Hi')
  if (process.env.AURA_SHOTS_DIR) await page.screenshot({ path: `${process.env.AURA_SHOTS_DIR}/chat-scroll-${page.viewportSize()!.width}.png` })
})
