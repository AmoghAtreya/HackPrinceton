/**
 * Routing eval: sends each labelled message in evals/routing-cases.json through
 * the real chatbot router (the same prompt and code Triage uses) and reports how
 * often it picks the right route, especially "guide" for "what do I click?"
 * requests however they are worded.
 *
 * Costs one small API call per case. Not part of `npm test`.
 *
 *   read -s TRIAGE_EVAL_KEY && export TRIAGE_EVAL_KEY && npm run eval:routing
 *
 * TRIAGE_EVAL_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY): the key to use; never printed.
 * TRIAGE_EVAL_MODEL: model id (default: Claude Haiku 4.5, or Gemini Flash for a Gemini key).
 * TRIAGE_EVAL_MIN: lowest passing score, 0–1 (default 0.9). Exits 1 below it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import { GeminiGateway, isGeminiKey } from '../src/main/assistant/gemini.ts'
import { guideGoal } from '../src/shared/guide-contracts.ts'

interface Case { text: string; expect: string; why?: string }
interface Outcome { item: Case; router: string; final: string; pass: boolean; routerPass: boolean; goal?: string }

const key = (process.env.TRIAGE_EVAL_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.GEMINI_API_KEY ?? '').trim()
if (!key) {
  console.error('Set TRIAGE_EVAL_KEY to an Anthropic or Gemini key first, for example:\n  read -s TRIAGE_EVAL_KEY && export TRIAGE_EVAL_KEY && npm run eval:routing')
  process.exit(2)
}
const gemini = isGeminiKey(key)
const model = process.env.TRIAGE_EVAL_MODEL ?? (gemini ? 'gemini-flash-latest' : 'claude-haiku-4-5-20251001')
const minimum = Number(process.env.TRIAGE_EVAL_MIN ?? 0.9)
const gateway = gemini ? new GeminiGateway() : new ClaudeGateway()
const cases = (JSON.parse(readFileSync(join(import.meta.dirname, '../evals/routing-cases.json'), 'utf8')) as { cases: Case[] }).cases

const matches = (expect: string, kind: string) => expect === 'not_guide' ? kind !== 'guide' : kind === expect

async function run(item: Case): Promise<Outcome> {
  let router: string
  let goal: string | undefined
  try {
    const route = await gateway.route!(key, model, [{ role: 'user', content: item.text }], AbortSignal.timeout(30000))
    router = route.kind
    if (route.kind === 'guide') goal = route.goal
  } catch (error) {
    router = 'error:' + ((error as { code?: string }).code ?? 'unknown')
  }
  // In the app, plain "help me …" phrases start a guide before the router is asked.
  const fast = guideGoal(item.text)
  const final = fast ? 'guide' : router
  return { item, router, final, pass: matches(item.expect, final), routerPass: matches(item.expect, router), goal: fast ?? goal }
}

async function main(): Promise<void> {
  console.log(`Routing eval: ${cases.length} cases on ${model}…\n`)
  const outcomes: Outcome[] = new Array(cases.length)
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const index = next++
      outcomes[index] = await run(cases[index])
      process.stdout.write(outcomes[index].pass ? '.' : 'x')
    }
  }))
  console.log('\n')

  const score = (list: Outcome[], field: 'pass' | 'routerPass') => list.length ? list.filter((outcome) => outcome[field]).length / list.length : 1
  const guide = outcomes.filter((outcome) => outcome.item.expect === 'guide')
  const other = outcomes.filter((outcome) => outcome.item.expect !== 'guide')
  const percent = (value: number) => (value * 100).toFixed(0) + '%'
  console.log(`Should guide      ${percent(score(guide, 'pass')).padStart(5)}  (${guide.filter((o) => o.pass).length}/${guide.length})   router alone ${percent(score(guide, 'routerPass'))}`)
  console.log(`Should not guide  ${percent(score(other, 'pass')).padStart(5)}  (${other.filter((o) => o.pass).length}/${other.length})   router alone ${percent(score(other, 'routerPass'))}`)
  const overall = score(outcomes, 'pass')
  console.log(`Overall           ${percent(overall).padStart(5)}  (${outcomes.filter((o) => o.pass).length}/${outcomes.length})\n`)

  const misses = outcomes.filter((outcome) => !outcome.pass)
  if (misses.length) {
    console.log('Misses:')
    for (const miss of misses) console.log(`  expected ${miss.item.expect.padEnd(16)} got ${miss.final.padEnd(16)} “${miss.item.text}”`)
    console.log()
  }
  const goals = outcomes.filter((outcome) => outcome.final === 'guide' && outcome.goal)
  if (goals.length) {
    console.log('Guide goals (check they read as the task):')
    for (const outcome of goals) console.log(`  “${outcome.item.text}” → ${outcome.goal}`)
  }
  if (overall < minimum) {
    console.log(`\nBelow the ${percent(minimum)} bar.`)
    process.exit(1)
  }
}

void main()
