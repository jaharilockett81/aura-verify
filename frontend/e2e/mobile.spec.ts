import { expect, test } from '@playwright/test'

test('mobile layout: bottom navigation and assistant are usable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Ask AURA')).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Main' }).last()
  await nav.getByRole('link', { name: 'Memory' }).click()
  await expect(page.getByText('What AURA remembers about your home.')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  if (process.env.AURA_SHOTS_DIR) await page.screenshot({ path: `${process.env.AURA_SHOTS_DIR}/07-mobile-memory.png`, fullPage: true })
})
