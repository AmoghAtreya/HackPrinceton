// Before/after demo of the web simplifier in two Chrome windows.
//
//   node --experimental-strip-types scripts/demo-simplifier.ts [--site cluttered-news] [--url https://...] [--voice] [--policy rules|thompson]
//
// Left window: the original page. Right window: the simplified page, produced by
// the real distiller → policy → (Claude or rules) → validated view pipeline.
// Uses Claude when ANTHROPIC_API_KEY is set (model: TRIAGE_DEMO_MODEL, default
// claude-sonnet-5-5); otherwise the rules-only simplifier. Close both windows or
// press Ctrl+C to exit. Decisions go to an in-memory log; nothing is saved.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import { browserChannelFrom, browserMissingMessage, channelLaunchOptions } from '../src/shared/browser-config.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { distillPage } from '../src/main/simplifier/distill.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { ClaudeSimplifier } from '../src/main/simplifier/llm.ts'
import { RulesPolicy } from '../src/main/simplifier/policy.ts'
import { renderSimplifiedView } from '../src/main/simplifier/render.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { values: args } = parseArgs({ options: {
  site: { type: 'string', default: 'cluttered-news' }, url: { type: 'string' },
  voice: { type: 'boolean', default: false }, policy: { type: 'string', default: 'thompson' }
} })
if (!/^[a-z0-9-]+$/.test(args.site!)) throw new Error('--site must be a file name in demo/sites without .html')

let afterHtml = '<p>Simplifying…</p>'
const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/before') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(readFileSync(join(root, 'demo/sites', args.site + '.html')))
  } else if (request.url === '/after') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(afterHtml)
  } else { response.writeHead(404); response.end() }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const beforeUrl = args.url ?? `http://127.0.0.1:${port}/before`

const channel = browserChannelFrom(process.env)
const browser = await chromium.launch({ ...channelLaunchOptions(channel), headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
  .catch((error) => { throw new Error(browserMissingMessage(channel), { cause: error }) })

async function place(page: Page, left: number): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget') as { windowId: number }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top: 40, width: 760, height: 900, windowState: 'normal' } })
  } catch { /* Window placement is cosmetic. */ }
}

const before = await (await browser.newContext({ viewport: null })).newPage()
await place(before, 0)
await before.goto(beforeUrl, { waitUntil: 'load' })

const distilled = await distillPage(before)
const log = new DecisionLog(':memory:')
const key = process.env.ANTHROPIC_API_KEY
const engine = new SimplificationEngine({
  log, policy: args.policy === 'rules' ? new RulesPolicy() : new ThompsonPolicy(),
  model: new ClaudeSimplifier(), llmTimeoutMs: 45000
})
const started = Date.now()
const result = await engine.simplify({
  page: distilled, userId: 'demo-user', voiceEnabled: Boolean(args.voice),
  ...(key ? { credentials: { key, model: process.env.TRIAGE_DEMO_MODEL ?? 'claude-sonnet-5-5' } } : {})
})
afterHtml = renderSimplifiedView(result.view, result.arm, distilled, {
  pageType: result.pageType, policyMode: result.mode, hiddenRemoved: distilled.stats.hiddenRemoved,
  originalElements: distilled.stats.interactiveElements, originalUrl: beforeUrl
})

const after = await (await browser.newContext({ viewport: null })).newPage()
await place(after, 770)
await after.goto(`http://127.0.0.1:${port}/after`)

console.log(`\nBEFORE  ${beforeUrl}`)
console.log(`  ${distilled.stats.totalElements} DOM elements, ${distilled.stats.interactiveElements} visible interactive, ${distilled.stats.hiddenRemoved} hidden/off-screen dropped`)
console.log(`AFTER   http://127.0.0.1:${port}/after   (${Date.now() - started} ms)`)
console.log(`  written by: ${result.view.source === 'llm' ? 'Claude' : 'rules (no ANTHROPIC_API_KEY, or the model call failed)'}`)
console.log(`  page type: ${result.pageType} · layout ${result.arm.id} (${result.arm.fontScale}× text, ${result.arm.maxActions} buttons, plain ${result.arm.plainLanguage}, voice ${result.arm.voiceNarration}) · policy mode: ${result.mode}`)
console.log(`  title: ${result.view.title}`)
for (const action of result.view.actions) console.log(`  [tier ${action.tier}] ${action.label}  ← "${action.originalLabel}"`)
const leaked = /1-800-555-0199|verified safe/i.test(JSON.stringify(result.view)) || /1-800-555-0199|verified safe/i.test(distilled.mainText)
console.log(`  hidden injection text reached the simplifier: ${leaked ? 'YES (bug)' : 'no'}`)
console.log('\nClose both windows or press Ctrl+C to exit.')

let open = 2
const finish = async () => { log.close(); server.close(); await browser.close().catch(() => {}); process.exit(0) }
for (const page of [before, after]) page.on('close', () => { if (--open === 0) void finish() })
process.on('SIGINT', () => { void finish() })
