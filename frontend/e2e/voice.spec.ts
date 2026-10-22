import { expect, test } from '@playwright/test'

// These tests replace the browser's SpeechRecognition with a scripted fake. They check AURA's voice-input
// wiring (mic button → transcript → same chat path as typing) and the no-voice fallback. They do NOT test
// real speech recognition, which needs a microphone and a manual check in Chrome/Edge/Safari.

test('voice input (fake SpeechRecognition) sends the transcript through the normal chat path', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    class FakeRecognition {
      lang = ''
      interimResults = false
      continuous = false
      onresult: ((e: any) => void) | null = null
      onerror: ((e: any) => void) | null = null
      onend: (() => void) | null = null
      start() {
        setTimeout(() => {
          const alt = { transcript: 'Get everything prepared for bedtime.' }
          const result = Object.assign([alt], { isFinal: true })
          this.onresult?.({ resultIndex: 0, results: [result] })
          this.onend?.()
        }, 200)
      }
      stop() { this.onend?.() }
      abort() {}
    }
    ;(window as any).webkitSpeechRecognition = FakeRecognition
    ;(window as any).SpeechRecognition = FakeRecognition
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Speak a request' }).click()
  await expect(page.locator('div.rounded-br-md', { hasText: 'Get everything prepared for bedtime.' })).toBeVisible()
  await expect(page.getByText('Run routine: Bedtime').first()).toBeVisible()
})

test('without speech support the mic is disabled and typing still works', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    delete (window as any).webkitSpeechRecognition
    delete (window as any).SpeechRecognition
  })
  await page.goto('/')
  const mic = page.getByRole('button', { name: 'Speak a request' })
  await expect(mic).toBeDisabled()
  await expect(mic).toHaveAttribute('title', /isn't supported/)
  await page.getByLabel('Ask AURA').fill("What's the thermostat at?")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Thermostat reports/)).toBeVisible({ timeout: 10_000 })
})
