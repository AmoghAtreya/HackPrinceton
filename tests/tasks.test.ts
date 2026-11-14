import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiskTier } from '../src/shared/simplifier-contracts.ts'
import { MemoryService, parseRememberCommand } from '../src/main/memory/service.ts'
import { SqliteCheckpointer } from '../src/main/tasks/checkpointer.ts'
import { bestOption, type RefillDriver, type RefillForm } from '../src/main/tasks/pharmacy-driver.ts'
import { medicationFromRequest } from '../src/main/tasks/refill-graph.ts'
import { parseRefillCommand, TaskRunner, WHERE_WAS_I } from '../src/main/tasks/runner.ts'

class FakeDriver implements RefillDriver {
  readonly site = 'pharmacy.triage-demo.invalid'
  calls: string[] = []
  form?: RefillForm
  tier: RiskTier = RiskTier.Commit
  async open() { this.calls.push('open') }
  async fill(form: RefillForm) { this.calls.push('fill'); this.form = form; return [{ label: 'Prescription number', value: form.rx }, { label: 'Pickup store', value: form.store }] }
  async submitTier() { return this.tier }
  async submit() { this.calls.push('submit'); return { confirmation: 'RF-123456' } }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'triage-tasks-'))
  const memory = new MemoryService(join(directory, 'memory.sqlite'))
  const file = join(directory, 'tasks.sqlite')
  const driver = new FakeDriver()
  const checkpointer = new SqliteCheckpointer(file)
  const runner = new TaskRunner({ file, memory, driver, checkpointer, now: () => Date.UTC(2026, 10, 14) })
  const cleanup = () => { runner.close(); checkpointer.close(); memory.close(); rmSync(directory, { recursive: true, force: true }) }
  return { directory, memory, file, driver, checkpointer, runner, cleanup }
}

async function rememberAll(memory: MemoryService, withRx = true) {
  for (const text of ['my name is Margaret Lee', 'my date of birth is 04/12/1951', 'my pharmacy is CareWell on Main Street', 'I prefer to pick up in the morning',
    ...(withRx ? ['my blood pressure medication is RX-48213'] : [])]) {
    const statement = parseRememberCommand('remember that ' + text)!
    await memory.remember(statement.kind, statement.text, { ...(statement.key ? { key: statement.key } : {}), ...(statement.extra ?? {}) })
  }
}

test('remember statements become keyed preferences and LangChain retrieval finds them', async () => {
  assert.deepEqual(parseRememberCommand('remember that my pharmacy is CareWell on Main Street'), { kind: 'preference', key: 'pharmacy', text: 'my pharmacy is CareWell on Main Street' })
  assert.equal(parseRememberCommand('remember my blood pressure medication is RX-48213')?.extra?.rx, 'RX-48213')
  assert.equal(parseRememberCommand('what is my pharmacy?'), null)
  const { memory, cleanup } = setup()
  try {
    await rememberAll(memory)
    await memory.remember('preference', 'my pharmacy is CareWell on Oak Avenue', { key: 'pharmacy' })
    assert.equal(memory.preference('pharmacy')?.text, 'my pharmacy is CareWell on Oak Avenue', 'restating a preference replaces it')
    const docs = await memory.retriever('preference', 3).invoke('refill my blood pressure pills')
    assert.equal(docs[0].metadata.rx, 'RX-48213', 'synonyms (pills ≈ medication) reach the right memory')
  } finally { cleanup() }
})

test('refill commands and Where was I? are recognised by rules', () => {
  assert.equal(parseRefillCommand('Refill my blood pressure medicine'), 'refill my blood pressure medicine')
  assert.equal(parseRefillCommand('how do I refill my prescription?'), null)
  assert.equal(medicationFromRequest('refill my blood pressure medicine'), 'blood pressure')
  assert.equal(medicationFromRequest('refill my prescription'), null)
  assert.ok(WHERE_WAS_I.test('Where was I?'))
  assert.equal(bestOption(['Choose a store', 'CareWell – Main Street', 'CareWell – Oak Avenue'], 'CareWell on Main St'), 'CareWell – Main Street')
})

test('a fully remembered refill pauses for yes, then submits and saves a recipe', async () => {
  const { memory, driver, runner, cleanup } = setup()
  try {
    await rememberAll(memory)
    const steps: string[] = []
    const first = await runner.start('conv-1', 'refill my blood pressure medicine', (step) => steps.push(step))
    assert.equal(first.status, 'waiting')
    assert.match(first.reply, /Shall I send the refill request/)
    assert.equal(driver.form?.rx, 'RX-48213')
    assert.equal(driver.form?.pickupTime, 'Morning')
    assert.deepEqual(driver.calls, ['open', 'fill'], 'nothing is submitted before the person says yes')
    assert.equal(runner.waiting('conv-1')?.status, 'waiting')
    const done = await runner.resume('conv-1', 'yes please', (step) => steps.push(step))
    assert.equal(done.status, 'submitted')
    assert.match(done.reply, /RF-123456/)
    assert.deepEqual(driver.calls, ['open', 'fill', 'submit'])
    assert.ok(memory.recipe('pharmacy.triage-demo.invalid', 'refill'), 'the steps are saved for next time')
    assert.ok(steps.some((step) => /Sent the refill request/.test(step)))
    assert.match(runner.whereWasI('conv-1'), /finished/)
  } finally { cleanup() }
})

test('a missing detail is asked once, saved to memory, and "no" sends nothing', async () => {
  const { memory, driver, runner, cleanup } = setup()
  try {
    await rememberAll(memory, false)
    const question = await runner.start('conv-2', 'refill my blood pressure medicine', () => {})
    assert.match(question.reply, /prescription number/)
    const confirm = await runner.resume('conv-2', 'it says RX-55555', () => {})
    assert.match(confirm.reply, /Shall I send/)
    assert.equal(memory.preference('medication:blood pressure')?.metadata.rx, 'RX-55555')
    const cancelled = await runner.resume('conv-2', 'no', () => {})
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(!driver.calls.includes('submit'))
  } finally { cleanup() }
})

test('a paused task survives a restart and resumes from its saved checkpoint', async () => {
  const first = setup()
  try {
    await rememberAll(first.memory)
    const paused = await first.runner.start('conv-3', 'refill my blood pressure medicine', () => {})
    assert.equal(paused.status, 'waiting')
    // "Restart": new checkpointer and runner instances over the same SQLite file.
    const checkpointer = new SqliteCheckpointer(first.file)
    const runner = new TaskRunner({ file: first.file, memory: first.memory, driver: first.driver, checkpointer })
    assert.match(runner.whereWasI('conv-3'), /steps are done/)
    const done = await runner.resume('conv-3', 'yes', () => {})
    assert.equal(done.status, 'submitted')
    runner.close(); checkpointer.close()
  } finally { first.cleanup() }
})

test('money or password tier is refused without asking', async () => {
  const { memory, driver, runner, cleanup } = setup()
  try {
    await rememberAll(memory)
    driver.tier = RiskTier.MoneyOrCredentials
    const result = await runner.start('conv-4', 'refill my blood pressure medicine', () => {})
    assert.equal(result.status, 'blocked')
    assert.ok(!driver.calls.includes('submit'))
  } finally { cleanup() }
})
