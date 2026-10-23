import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Wake word ("Aura" → "Yes, Jahari?" → AURA listens for the request), against the real backend. The browser's
// SpeechRecognition and speechSynthesis are replaced with controllable fakes, so these tests check AURA's wiring,
// not real speech recognition or audio, which need a microphone and a manual check in Chrome.

test.beforeEach(async ({ request, page }) => {
  expect((await request.post('/api/memory/forget')).ok()).toBeTruthy()
  expect((await request.post('/api/demo/reset')).ok()).toBeTruthy()
  await page.addInitScript(() => {
    localStorage.clear()
    const w = window as any
    w.__recs = []
    w.__spoken = []
    class FakeRecognition {
      lang = ''
      interimResults = false
      continuous = false
      running = false
      onresult: ((e: any) => void) | null = null
      onerror: ((e: any) => void) | null = null
      onend: (() => void) | null = null
      start() {
        this.running = true
        w.__recs.push(this)
      }
      stop() {
        if (!this.running) return
        this.running = false
        this.onend?.()
      }
      abort() {
        this.stop()
      }
    }
    w.webkitSpeechRecognition = FakeRecognition
    w.SpeechRecognition = FakeRecognition
    // Deliver a final transcript to the recogniser that is listening now (as the microphone would).
    w.__hear = (text: string) => {
      const r = [...w.__recs].reverse().find((x: any) => x.running)
      if (!r) return false
      const result = Object.assign([{ transcript: text }], { isFinal: true })
      r.onresult?.({ resultIndex: 0, results: [result] })
      if (!r.continuous) r.stop()
      return true
    }
    w.__listening = () => [...w.__recs].filter((x: any) => x.running).map((x: any) => (x.continuous ? 'wake' : 'request'))
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
    w.SpeechSynthesisUtterance = FakeUtterance
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        speaking: false,
        speak: (u: any) => {
          w.__spoken.push(u.text)
          setTimeout(() => u.onstart?.(), 5)
        },
        cancel: () => {},
      },
    })
  })
})

const listening = (page: Page) => page.evaluate(() => (window as any).__listening() as string[])
const hear = (page: Page, text: string) => page.evaluate((t) => (window as any).__hear(t) as boolean, text)

async function enableHandsFree(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('switch', { name: 'Hands-free Aura' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
}

test('hands-free: "Aura" gets "Yes, Jahari?", then AURA listens and plans the request', async ({ page }) => {
  await page.goto('/')
  await enableHandsFree(page)
  await expect(page.getByText('Hands-free: say "Aura" to start')).toBeVisible()
  await expect.poll(() => listening(page)).toEqual(['wake'])

  // Speech that doesn't start with the wake word is ignored.
  expect(await hear(page, 'what a nice day')).toBeTruthy()
  await expect(page.locator('[data-role="user"]')).toHaveCount(0)

  expect(await hear(page, 'Aura')).toBeTruthy()
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText('Yes, Jahari?')
  // Voice replies are off, so the wake answer is spoken by the hands-free flow itself, then the mic reopens.
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual(['Yes, Jahari?'])
  await expect.poll(() => listening(page)).toEqual(['request'])

  expect(await hear(page, 'set a reminder to call mom at 9 pm')).toBeTruthy()
  await expect(page.locator('[data-role="user"]').last()).toHaveText('set a reminder to call mom at 9 pm')
  await expect(page.getByText('Add reminder: Call mom at 9:00 PM').first()).toBeVisible({ timeout: 15_000 })
  // Back to waiting for the wake word, and nothing ran without approval.
  await expect.poll(() => listening(page)).toEqual(['wake'])
  await expect(page.getByRole('button', { name: 'Approve & run' }).first()).toBeVisible()
})

test('hands-free: wake word and request in one breath go straight to the planner', async ({ page }) => {
  await page.goto('/')
  await enableHandsFree(page)
  await expect.poll(() => listening(page)).toEqual(['wake'])
  // Recognisers often hear "Aura" as "Ora".
  expect(await hear(page, 'Ora set a reminder')).toBeTruthy()
  await expect(page.locator('[data-role="user"]').last()).toHaveText('Aura, set a reminder')
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText('What should I remind you about?')
  // The question is spoken and AURA listens for the answer, which completes the reminder.
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual(['What should I remind you about?'])
  await expect.poll(() => listening(page)).toEqual(['request'])
  expect(await hear(page, 'take out the trash')).toBeTruthy()
  await expect(page.getByText('Add reminder: Take out the trash').first()).toBeVisible({ timeout: 15_000 })
})

test('mic button: saying just "Aura" answers by name and reopens the mic; typing "Aura" does not', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Speak a request' }).click()
  await expect.poll(() => listening(page)).toEqual(['request'])
  expect(await hear(page, 'Aura')).toBeTruthy()
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText('Yes, Jahari?')
  await expect.poll(() => listening(page)).toEqual(['request'])
  expect(await hear(page, 'lock the front door')).toBeTruthy()
  await expect(page.getByText('Lock the front door').first()).toBeVisible({ timeout: 15_000 })

  await page.getByLabel('Ask AURA').fill('Aura')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText('Yes, Jahari?')
  await page.waitForTimeout(500)
  expect(await listening(page)).toEqual([])
})
