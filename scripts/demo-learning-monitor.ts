// Scripted run of Triage's learning stack with the Learning Monitor open.
//
//   node --experimental-strip-types scripts/demo-learning-monitor.ts [--share] [--fast] [--simplifier-only]
//
// --simplifier-only skips the memory and refill parts and starts the
// simplifier's layout learning right away, at normal pace.
//
// Uses the real code paths: LangChain memory (vector store + retriever), the
// LangGraph refill graph driving the mock CareWell pharmacy in a visible Chrome
// window, and the LangChain simplifier pipeline with the Thompson-sampling
// layout model. No API key is needed: the rewrite falls back to rules. Ratings
// come from a simulated person who prefers large text and few buttons, so the
// layout odds visibly shift. All data lives in a temporary folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import { browserChannelFrom, channelLaunchOptions } from '../src/shared/browser-config.ts'
import { LearningMonitor } from '../src/main/monitor/bus.ts'
import { MonitorCallbackHandler } from '../src/main/monitor/callbacks.ts'
import { MonitorServer } from '../src/main/monitor/server.ts'
import { MemoryService, parseRememberCommand } from '../src/main/memory/service.ts'
import { SqliteCheckpointer } from '../src/main/tasks/checkpointer.ts'
import { DemoPharmacyDriver } from '../src/main/tasks/pharmacy-driver.ts'
import { TaskRunner } from '../src/main/tasks/runner.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { distillPage } from '../src/main/simplifier/distill.ts'
import { armById, describeLayout } from '../src/main/simplifier/arms.ts'
import { classifyPage, rankElements } from '../src/main/simplifier/classify.ts'
import { rulesView } from '../src/main/simplifier/view.ts'
import { renderSimplifiedView } from '../src/main/simplifier/render.ts'

const { values: args } = parseArgs({ options: {
  share: { type: 'boolean', default: false },
  fast: { type: 'boolean', default: false },
  'simplifier-only': { type: 'boolean', default: false }
} })
const root = new URL('..', import.meta.url).pathname
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, args.fast ? ms / 4 : ms))
const say = (text: string) => console.log('\n▶ ' + text)

const directory = mkdtempSync(join(tmpdir(), 'triage-monitor-demo-'))
const monitor = new LearningMonitor()
const callbacks = [new MonitorCallbackHandler(monitor)]
const server = new MonitorServer(monitor, { share: Boolean(args.share) })
const address = await server.start()

const browser = await chromium.launch({ ...channelLaunchOptions(browserChannelFrom(process.env)), headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
async function place(page: Page, left: number, width: number): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget') as { windowId: number }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top: 30, width, height: 880, windowState: 'normal' } })
  } catch { /* Placement is cosmetic. */ }
}
const monitorPage = await (await browser.newContext({ viewport: null })).newPage()
await place(monitorPage, 700, 740)
await monitorPage.goto(address.localUrl)
const taskPage = await (await browser.newContext({ viewport: null })).newPage()
await place(taskPage, 0, 700)
await taskPage.setContent('<body style="font:20px system-ui;padding:40px;color:#555">Triage’s browser. The pharmacy and news pages will appear here.</body>')

console.log('Learning Monitor: ' + address.localUrl + (address.lanUrl ? '\nOn another device:  ' + address.lanUrl : ''))
await pause(2500)

const memory = new MemoryService(join(directory, 'memory.sqlite'), monitor)
let checkpointer: SqliteCheckpointer | undefined
let runner: TaskRunner | undefined

if (!args['simplifier-only']) {
  // 1. Memory: LangChain vector store writes.
  say('Teaching Triage about the person (LangChain vector store)')
  for (const text of ['my name is Margaret Lee', 'my date of birth is 04/12/1951', 'my pharmacy is CareWell on Main Street',
    'I prefer to pick up in the morning', 'my blood pressure medication is RX-48213']) {
    const statement = parseRememberCommand('remember that ' + text)!
    await memory.remember(statement.kind, statement.text, { ...(statement.key ? { key: statement.key } : {}), ...(statement.extra ?? {}) })
    console.log('  remembered: ' + text)
    await pause(900)
  }

  // 2. LangGraph refill driving the mock pharmacy in Chrome.
  say('“Refill my blood pressure medicine” (LangGraph)')
  const file = join(directory, 'tasks.sqlite')
  checkpointer = new SqliteCheckpointer(file)
  const driver = new DemoPharmacyDriver(async () => taskPage, readFileSync(join(root, 'demo/sites/pharmacy-refill.html'), 'utf8'))
  runner = new TaskRunner({ file, memory, driver, checkpointer, monitor, callbacks })
  const first = await runner.start('demo', 'refill my blood pressure medicine', (step) => console.log('  step: ' + step))
  console.log('  Triage asks: ' + first.reply.split('\n').at(-1))
  await pause(5000)
  say('The person replies “yes”')
  const done = await runner.resume('demo', 'yes', (step) => console.log('  step: ' + step))
  console.log('  ' + done.reply)
  await pause(4000)
}

// 3. Simplifier pipeline + layout learning with simulated ratings.
say('Simplifying the cluttered news page, rated by a person who likes big text and few buttons')
const log = new DecisionLog(join(directory, 'simplifier.sqlite'))
const engine = new SimplificationEngine({ log, policy: new ThompsonPolicy({ warmup: 1, propensitySamples: 120, freezeAfter: 1e9 }), monitor, callbacks })
await taskPage.goto('data:text/html,' + encodeURIComponent(readFileSync(join(root, 'demo/sites/cluttered-news.html'), 'utf8')))
const distilled = await distillPage(taskPage)
const likes = (armId: string) => {
  const arm = armById(armId)
  return (arm.fontScale === 2 ? 0.45 : arm.fontScale === 1.5 ? 0.2 : 0) + (arm.maxActions === 3 ? 0.3 : 0) + (arm.plainLanguage ? 0.1 : 0)
}
let latestShares: Record<string, number> = {}
const stopWatching = monitor.subscribe((event) => { if (event.type === 'bandit') latestShares = event.shares })
for (let round = 1; round <= 12; round++) {
  const result = await engine.simplify({ page: distilled, userId: 'margaret', voiceEnabled: false })
  const helpful = Math.random() < 0.15 + likes(result.arm.id)
  const reward = engine.reportOutcome(result.decisionId, {
    taskCompleted: helpful, durationMs: helpful ? 40000 : 150000, backtracks: helpful ? 0 : 2,
    thumbsUp: helpful, showedOriginal: !helpful && Math.random() < 0.5, repeatRequests: 0
  })
  console.log(`  round ${String(round).padStart(2)}: layout ${result.arm.id} (${result.mode}) → ${helpful ? 'helpful' : 'not helpful'}, reward ${Math.round((reward ?? 0) * 100)}%`)
  await pause(2200)
}

// 4. Show the news page in the layout the learner now favours: the arm with
// the largest share of posterior draws, the same odds the monitor's bars show.
const odds = Object.entries(latestShares).sort((a, b) => b[1] - a[1])
const favourite = armById(odds[0]?.[0] ?? 'a01')
say(`Showing the news page as Margaret will now see it: ${favourite.id} (${describeLayout(favourite.id)}), ${Math.round((odds[0]?.[1] ?? 0) * 100)}% of the learner's odds`)
await taskPage.setContent(renderSimplifiedView(rulesView(distilled, rankElements(distilled), favourite), favourite, distilled, {
  pageType: classifyPage(distilled), policyMode: 'exploit', hiddenRemoved: distilled.stats.hiddenRemoved,
  originalElements: distilled.stats.interactiveElements
}))
stopWatching()

say('Done. The monitor stays open; press Ctrl+C or close the windows to finish.')
const finish = async () => {
  runner?.close(); checkpointer?.close(); memory.close(); log.close()
  await server.close(); await browser.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => { void finish() })
browser.on('disconnected', () => { void finish() })
