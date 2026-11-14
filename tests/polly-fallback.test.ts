import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PollyService } from '../src/main/speech/polly.ts'

type Sent = { Engine?: string; VoiceId?: string; SampleRate?: string }

function fakeClient(reject: (input: Sent) => Error | undefined) {
  const sent: Sent[] = []
  const client = {
    destroy() {},
    async send(command: { input: Sent }) {
      sent.push(command.input)
      const error = reject(command.input)
      if (error) throw error
      return { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
    }
  }
  return { client: client as never, sent }
}

const unsupported = () => Object.assign(new Error('The selected engine is not supported in this region'), { name: 'ValidationException' })

test('neural voices are used where available', async () => {
  const { client, sent } = fakeClient(() => undefined)
  const polly = new PollyService('us-east-1', { client, engine: 'neural' })
  assert.equal((await polly.synthesize('Hello there.', 'Ruth', 90)).byteLength, 3)
  assert.deepEqual(sent, [{ ...sent[0], Engine: 'neural', VoiceId: 'Ruth', SampleRate: '24000' }])
})

test('an unsupported neural engine switches to standard voices once and stays there', async () => {
  const { client, sent } = fakeClient((input) => input.Engine === 'neural' ? unsupported() : undefined)
  const polly = new PollyService('us-east-2', { client, engine: 'neural' })
  await polly.synthesize('First reply.', 'Stephen', 90)
  await polly.synthesize('Second reply.', 'Joanna', 90)
  assert.deepEqual(sent.map((input) => `${input.Engine}/${input.VoiceId}/${input.SampleRate}`),
    ['neural/Stephen/24000', 'standard/Matthew/22050', 'standard/Joanna/22050'])
  assert.equal(polly.activeEngine, 'standard')
})

test('other Polly errors are reported, not retried', async () => {
  const denied = Object.assign(new Error('explicit deny'), { name: 'AccessDeniedException' })
  const { client, sent } = fakeClient(() => denied)
  const polly = new PollyService('us-east-1', { client, engine: 'neural' })
  await assert.rejects(polly.synthesize('Hello.', 'Joanna', 90), { code: 'aws_access' })
  assert.equal(sent.length, 1)
})
