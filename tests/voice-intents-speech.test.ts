import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { matchVoiceIntent, needsConfirmation } from '../src/renderer/src/voice/intents.ts'
import { failureSpeech, prepareSpeech, REST_ON_SCREEN } from '../src/shared/speech-text.ts'
import { buildSsml } from '../src/main/speech/polly.ts'
import { SpeechPreferences } from '../src/main/speech/settings.ts'
import { DEFAULT_SPEECH_SETTINGS } from '../src/shared/speech-contracts.ts'
import { resolveDestination } from '../src/shared/destinations.ts'
import { routeSchema } from '../src/shared/flight-contracts.ts'

test('voice shortcuts match whole commands and leave real requests to the chatbot', () => {
  const cases: Array<[string, string]> = [
    ['Stop.', 'stop'], ['Okay, never mind', 'stop'], ['Stop my Netflix subscription', 'chat'], ['Cancel my order', 'chat'],
    ['Hey Triage, start over please', 'new_conversation'],
    ['What is on my screen?', 'explain_screen'], ['Explain this page.', 'explain_screen'],
    ['Show me where to track my package', 'show_me_where'], ['Where is the search box?', 'show_me_where'],
    ['Can you highlight the checkout button', 'show_me_where'], ['Where is my package?', 'chat'],
    ['Search Alaska flights from SEA to LAX next Friday', 'chat']
  ]
  for (const [text, kind] of cases) assert.equal(matchVoiceIntent(text).kind, kind, text)
})

test('one-word or low-confidence transcripts are held for review', () => {
  const record = (text: string, confidence: number | null) => ({ text, segments: [{ text, confidence }] })
  assert.equal(needsConfirmation(record('Hello', 0.99)), true)
  assert.equal(needsConfirmation(record('track my package', 0.95)), false)
  assert.equal(needsConfirmation(record('track my package', 0.4)), true)
  assert.equal(needsConfirmation(record('track my package', null)), false)
})

test('replies are shortened for speech without links or markdown', () => {
  assert.equal(prepareSpeech('Opening Gmail in your web browser.'), 'Opening Gmail in your web browser.')
  const flight = prepareSpeech('Alaska Airlines search: results.\nFound 12 flights.\nhttps://www.alaskaair.com/x\nThe browser remains open. No ticket was purchased.')
  assert.doesNotMatch(flight, /https?:|alaskaair\.com/)
  assert.ok(flight.endsWith(REST_ON_SCREEN))
  assert.equal(prepareSpeech('## Steps\n1. Click **Your Orders**.'), 'Steps. Click Your Orders.')
  assert.ok(prepareSpeech('x'.repeat(700)).length < 330)
  assert.equal(prepareSpeech('Click Insert. Then choose Photo. Then pick a picture. Then press Send.'), 'Click Insert. Then choose Photo. ' + REST_ON_SCREEN, 'two sentences at most')
  assert.equal(failureSpeech(null), "Sorry, that didn't work.")
  assert.equal(failureSpeech('The reply timed out.'), "Sorry, that didn't work. The reply timed out.")
})

test('SSML escapes reply text and applies the chosen rate', () => {
  assert.equal(buildSsml('Fish & chips <now>', 80), '<speak><prosody rate="80%">Fish &amp; chips &lt;now&gt;</prosody></speak>')
})

test('speech settings default to relaxed Joanna for voice requests and reject unknown values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-speech-settings-'))
  try {
    const settings = new SpeechPreferences(directory)
    assert.deepEqual(settings.snapshot(), DEFAULT_SPEECH_SETTINGS)
    settings.save({ readAloud: 'always', rate: 80, voice: 'Matthew' })
    assert.deepEqual(new SpeechPreferences(directory).snapshot(), { readAloud: 'always', rate: 80, voice: 'Matthew', geminiTranscription: true })
    settings.save({ readAloud: 'always', rate: 80, voice: 'Matthew', geminiTranscription: false })
    settings.save({ readAloud: 'off', rate: 90, voice: 'Joanna' })
    assert.equal(new SpeechPreferences(directory).snapshot().geminiTranscription, false, 'an older window keeps the saved Gemini choice')
    for (const bad of [{ readAloud: 'always', rate: 85, voice: 'Matthew' }, { readAloud: 'loud', rate: 80, voice: 'Matthew' }, { readAloud: 'off', rate: 80, voice: 'Joanna', extra: 1 }])
      assert.throws(() => settings.save(bad), { code: 'invalid_input' })
    assert.equal(new SpeechPreferences(directory).snapshot().voice, 'Joanna')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('page navigation only opens listed destinations over https', () => {
  assert.equal(resolveDestination('amazon_orders').url, 'https://www.amazon.com/gp/css/order-history')
  assert.equal(resolveDestination('web_search', 'pharmacy near me').url, 'https://www.google.com/search?q=pharmacy%20near%20me')
  assert.throws(() => resolveDestination('evil_site'))
  assert.throws(() => resolveDestination('web_search'))
  assert.equal(routeSchema.safeParse({ kind: 'open_page', destination: 'gmail' }).success, true)
  assert.equal(routeSchema.safeParse({ kind: 'open_page', destination: 'https://evil.example' }).success, false)
  assert.equal(routeSchema.safeParse({ kind: 'open_page', destination: 'gmail', url: 'https://evil.example' }).success, false)
})
