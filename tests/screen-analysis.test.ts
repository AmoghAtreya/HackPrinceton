import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { analysisSpeech, parseScreenAnalysis } from '../src/shared/screen-analysis-contracts.ts'
import { matchVoiceIntent } from '../src/renderer/src/voice/intents.ts'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import type { FinishedRequest } from '../src/main/logging/request-log.ts'
import type { ScreenAccess, ScreenImage } from '../src/shared/screen-contracts.ts'

const simplified = { summary: 'This is your Amazon orders page.', actions: [
  { label: 'Track my package', instruction: 'Where is the Track package button?', kind: 'show_me_where' },
  { label: 'Return an item', instruction: 'How do I return something?', kind: 'ask' }
] }
const scam = { verdict: 'likely_scam', headline: 'This pop-up is pretending to be Microsoft.', reasons: ['It asks you to call a phone number.'], advice: "Don't call. Close this page." }

test('model answers are validated per kind, including fenced JSON', () => {
  assert.deepEqual(parseScreenAnalysis('simplify', JSON.stringify(simplified)), { kind: 'simplify', view: simplified })
  assert.equal(parseScreenAnalysis('safety', '```json\n' + JSON.stringify(scam) + '\n```')?.kind, 'safety')
  assert.equal(parseScreenAnalysis('safety', JSON.stringify({ ...scam, verdict: 'definitely_safe' })), null)
  assert.equal(parseScreenAnalysis('simplify', JSON.stringify({ ...simplified, actions: [] })), null)
  assert.equal(parseScreenAnalysis('simplify', JSON.stringify({ ...simplified, actions: [{ ...simplified.actions[0], kind: 'click_it' }] })), null)
  assert.equal(parseScreenAnalysis('simplify', 'not json'), null)
})

test('analysis results are spoken briefly', () => {
  assert.equal(analysisSpeech({ kind: 'simplify', view: simplified as never }),
    'This is your Amazon orders page. You can: Track my package or Return an item. Press a button and I\'ll help.')
  assert.equal(analysisSpeech({ kind: 'safety', check: scam as never }), "This pop-up is pretending to be Microsoft. Don't call. Close this page.")
})

test('simplify and safety voice shortcuts', () => {
  for (const text of ['Is this safe?', 'Is this a scam?', 'Should I trust this?']) assert.equal(matchVoiceIntent(text).kind, 'safety_check', text)
  for (const text of ['Simplify this page', 'What can I do here?', 'This is too confusing!', "I'm lost"]) assert.equal(matchVoiceIntent(text).kind, 'simplify', text)
  for (const text of ['Is it safe to eat raw eggs', 'Simplify my taxes for me']) assert.equal(matchVoiceIntent(text).kind, 'chat', text)
})

async function fixture(answer: string) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-analysis-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => { throw new Error() }, decrypt: async () => { throw new Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const captureId = randomUUID()
  const taken: string[] = []
  const image = { metadata: { id: captureId, width: 100, height: 100 }, data: 'AAAA', mediaType: 'image/jpeg' } as unknown as ScreenImage
  const screens = { take: (id: string) => { taken.push(id); if (id !== captureId) throw new Error('unknown'); return image } } as unknown as ScreenAccess
  const recorded: FinishedRequest[] = []
  const kinds: string[] = []
  const coordinator = new AssistantCoordinator({ history, credentials, screens, changed: () => {}, requestLog: { record: (event) => recorded.push(event) },
    gateway: { models: async () => [], reply: async () => '', analyze: async (_key, _model, kind) => { kinds.push(kind); return answer } } })
  return { coordinator, history, captureId, taken, recorded, kinds, cleanup: () => { coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('the coordinator returns a validated analysis, consumes the capture and saves no history', async () => {
  const f = await fixture(JSON.stringify(scam))
  try {
    const result = await f.coordinator.analyzeScreen({ captureId: f.captureId, kind: 'safety', source: 'voice' })
    assert.equal(result.kind, 'safety')
    assert.deepEqual(f.taken, [f.captureId])
    assert.deepEqual(f.kinds, ['safety'])
    assert.deepEqual(f.history.list().items, [])
    assert.equal(f.recorded[0].route, 'safety')
    assert.equal(f.recorded[0].source, 'voice')
    assert.match(f.recorded[0].reply ?? '', /^likely_scam:/)
  } finally { f.cleanup() }
})

test('an unusable model answer is reported, not shown', async () => {
  const f = await fixture('{"summary":"x"}')
  try {
    await assert.rejects(f.coordinator.analyzeScreen({ captureId: f.captureId, kind: 'simplify' }), { code: 'invalid_analysis' })
    await assert.rejects(f.coordinator.analyzeScreen({ captureId: f.captureId, kind: 'explode' }), { code: 'invalid_input' })
  } finally { f.cleanup() }
})
