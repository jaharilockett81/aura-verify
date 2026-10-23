import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Conversational features end to end, against the real backend: multi-action plans, timers with working
// controls, verified reminders with honest delivery status, corrections, and spoken replies.

test.beforeEach(async ({ request, page }) => {
  expect((await request.post('/api/memory/forget')).ok()).toBeTruthy()
  expect((await request.post('/api/demo/reset')).ok()).toBeTruthy()
  expect((await request.delete('/api/demo/faults')).ok()).toBeTruthy()
  await page.addInitScript(() => localStorage.clear())
})

async function say(page: Page, text: string) {
  const before = await page.locator('[data-role="assistant"]').count()
  await page.getByLabel('Ask AURA').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => page.locator('[data-role="assistant"]').count(), { timeout: 15_000 }).toBeGreaterThan(before)
}

test('multi-action command becomes one approved, individually verified workflow', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Turn off the bedroom lights, set the thermostat to 75 degrees, and lock the front door.')
  await expect(page.getByText('Set the thermostat to 75°F').last()).toBeVisible()
  await page.getByRole('button', { name: 'Approve & run' }).first().click()
  await expect(page).toHaveURL(/\/runs\/run_/)
  await page.getByRole('button', { name: /Confirm: lock the front door/i }).click({ timeout: 20_000 })
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('3/3 verified')).toBeVisible()
})

test('timer controls work from voice requests and from the Home buttons', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Set a pasta timer for 8 minutes')
  const timers = page.getByRole('list', { name: 'Timers' })
  await expect(timers.getByText('Pasta')).toBeVisible({ timeout: 10_000 })
  await expect(timers.getByText('Running')).toBeVisible()
  await page.getByRole('button', { name: 'Pause Pasta timer' }).click()
  await expect(timers.getByText('Paused')).toBeVisible()
  await say(page, 'Resume the pasta timer')
  await expect(timers.getByText('Running')).toBeVisible({ timeout: 10_000 })
  await say(page, 'How much time is left?')
  await expect(page.locator('[data-role="assistant"]', { hasText: /Pasta: \d+ minutes?/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Cancel Pasta timer' }).click()
  await expect(timers).toHaveCount(0)
  await expect(page.getByText('No timers.')).toBeVisible()
})

test('verified reminder: alert is shown, checked against the device, and fixed only with approval', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Remind me to lock the front door in 30 minutes')
  await page.getByRole('button', { name: 'Approve & run' }).first().click()
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('link', { name: 'Memory' }).first().click()
  await page.getByRole('button', { name: 'Reminder Lock the front door' }).click()
  await page.getByRole('button', { name: 'Make due now (demo)' }).click()

  const alert = page.getByRole('alert', { name: 'Reminder: Lock the front door' })
  await expect(alert).toBeVisible()
  // The demo door starts unlocked: an independent read says it isn't done.
  await expect(alert.getByText('Not done')).toBeVisible({ timeout: 10_000 })
  await expect(alert.getByText(/shows locked = False/)).toBeVisible()
  await expect(alert.getByText('Shown in app')).toBeVisible({ timeout: 10_000 })

  await alert.getByRole('button', { name: 'Plan a fix' }).click()
  await expect(page).toHaveURL(/\/runs\/run_/)
  await page.getByRole('button', { name: 'Approve & run' }).click()
  await page.getByRole('button', { name: /Confirm: lock the front door/i }).click({ timeout: 20_000 })
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('link', { name: 'Memory' }).first().click()
  const row = page.getByRole('button', { name: 'Reminder Lock the front door' })
  await expect(row.getByText('Verified')).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(page.getByText(/After the approved fix, an independent read confirms the front door locked/)).toBeVisible()
})

test('reminder for an unobservable task is recorded as confirmed by the user, not verified', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Remind me to feed Luna in 30 minutes')
  await page.getByRole('button', { name: 'Approve & run' }).first().click()
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('link', { name: 'Memory' }).first().click()
  await page.getByRole('button', { name: 'Reminder Feed Luna' }).click()
  await page.getByRole('button', { name: 'Make due now (demo)' }).click()
  const alert = page.getByRole('alert', { name: 'Reminder: Feed Luna' })
  await alert.getByRole('button', { name: 'Done' }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reminder Feed Luna' }).getByText('Confirmed by you')).toBeVisible()
})

test('greeting, correction and follow-up keep the conversation going without repeating the command', async ({ page }) => {
  await page.goto('/')
  await say(page, 'Hey Aura')
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("can't chat freely")
  await say(page, 'Set the thermostat to 75')
  await say(page, 'Actually, make it 74')
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('75°F → 74°F')
  await expect(page.getByText('Set the thermostat to 74°F').last()).toBeVisible()
  await say(page, 'Did it work?')
  await expect(page.locator('[data-role="assistant"]').last()).toContainText('still waiting for your approval')
})

test('voice replies speak the real confirmation, question and verified result', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).__spoken = []
    class FakeUtterance {
      text: string
      onstart: (() => void) | null = null
      onerror: (() => void) | null = null
      rate = 1
      pitch = 1
      constructor(t: string) {
        this.text = t
      }
    }
    ;(window as any).SpeechSynthesisUtterance = FakeUtterance
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        speak: (u: any) => {
          ;(window as any).__spoken.push(u.text)
          setTimeout(() => u.onstart?.(), 5)
        },
        cancel: () => {},
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('switch', { name: 'Voice replies' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await say(page, 'Set the thermostat')
  await say(page, '71')
  await page.getByRole('button', { name: 'Approve & run' }).first().click()
  await expect(page.getByText('Everything verified')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => (window as any).__spoken as string[]), { timeout: 10_000 }).toEqual(
    expect.arrayContaining([
      'What temperature would you like the thermostat set to?',
      expect.stringContaining("I'll set the thermostat to 71°F once you approve"),
      expect.stringMatching(/^Done, and verified\. 1 of 1 steps verified\./),
    ]),
  )
  const spoken = await page.evaluate(() => (window as any).__spoken as string[])
  // Nothing was spoken as done before the independent read confirmed it.
  const doneIdx = spoken.findIndex((t) => t.startsWith('Done, and verified'))
  expect(spoken.slice(0, doneIdx).some((t) => /^(done|set|setting)\b/i.test(t))).toBeFalsy()
})
