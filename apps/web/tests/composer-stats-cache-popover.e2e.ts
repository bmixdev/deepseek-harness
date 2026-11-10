// Web e2e scenario: in Compact mode the composer cache-hit reading opens a
// hover popover with the cached prompt tokens and the prompt total they are
// measured against. The seed is generated, not recorded: no line is model output.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const SEED_ID = 'composer-stats-cache-popover-web-e2e'
const COMPACT_READING = 'Cache hit 98%'
const CACHED_TOKENS = '5,680,000 tok'
const PROMPT_TOKENS = '5,780,000 tok'

/**
 * Generate one closed single-step turn whose billed usage totals 5,780,000 prompt
 * tokens at a 98% cache hit, so the Compact reading and its popover are known.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(): string {
  const lines = [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 1784974100000, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
  })]
  let seq = 0
  let time = 1784974100000
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: time++ }))
  }
  at({ type: 'turn/start', data: { turn: 1 } })
  at({ type: 'step/start', data: { turn: 1, step: 1 } })
  at({ type: 'system/message', data: { turn: 1, step: 1, message: createSystemMessage('') }, surfaceOp: 'append' })
  at({
    type: 'user/message',
    data: {
      id: '00000000-0000-4000-9000-000000000001',
      role: 'user',
      content: [{ type: 'text', text: 'm1' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  at({
    type: 'assistant/message',
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: '00000000-0000-4000-8000-000000000001',
        role: 'assistant',
        content: [{ type: 'text', text: 'r1' }],
        source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
      },
      usage: { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 5_680_000 },
    },
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: 1, step: 1 } })
  at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return `${lines.join('\n')}\n`
}

describe('web e2e: compact cache hover popover', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') throw new Error('composer-stats-cache-popover is a keyless assembled scenario')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the cached token counts from the compact reading on hover', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-cache-popover'))
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.locator('[data-composer-stat="usage"]').waitFor({ timeout: 15_000 })

    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const row = dialog.getByText('Performance & usage', { exact: true }).locator('../..')
    await row.getByRole('button', { name: 'Detailed', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Compact', exact: true }).click()
    await expect.poll(() => scaffold.ctx.settings.describe().find(entry => entry.ns === 'ui-chat')?.value)
      .toMatchObject({ performanceUsage: 'compact' })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    const usage = page.locator('[data-composer-stat="usage"]')
    await expect.poll(() => usage.locator('button').count()).toBe(0)
    const reading = usage.getByText(COMPACT_READING, { exact: true })
    await reading.waitFor({ timeout: 10_000 })
    const popover = page.locator('[data-session-stats-cache]')
    expect(await popover.count()).toBe(0)

    await reading.hover()
    await popover.waitFor({ state: 'visible', timeout: 5_000 })
    const rows = await popover.innerText()
    expect(rows).toContain('Cache hit')
    expect(rows).toContain(CACHED_TOKENS)
    expect(rows).toContain(PROMPT_TOKENS)

    await page.mouse.move(0, 0)
    await popover.waitFor({ state: 'hidden', timeout: 5_000 })
  }, 60_000)

  it('stayed clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
