/**
 * Captures the microphone as 16-bit PCM mono at `sampleRate` using an
 * AudioWorklet (public/pcm-worklet.js). Chunks are handed to `onChunk`.
 */
export class MicrophoneCapture {
  private stream?: MediaStream
  private context?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private node?: AudioWorkletNode
  private stopped = false

  async start(sampleRate: number, onChunk: (chunk: ArrayBuffer, level: number) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      if (this.stopped) throw new MicrophoneProblem('Recording was cancelled.')
      // The AudioContext resamples the device's native rate to what Transcribe expects.
      this.context = new AudioContext({ sampleRate })
      await this.context.audioWorklet.addModule(new URL('pcm-worklet.js', window.location.href).toString())
      if (this.stopped) throw new MicrophoneProblem('Recording was cancelled.')
      this.source = this.context.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.context, 'pcm-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
        processorOptions: { chunkSamples: Math.round(sampleRate / 10) }
      })
      this.node.port.onmessage = (event: MessageEvent<{ type: string; chunk?: ArrayBuffer; level?: number }>) => {
        if (event.data.type === 'audio' && event.data.chunk && !this.stopped) onChunk(event.data.chunk, event.data.level ?? 0)
      }
      this.source.connect(this.node)
      // The processor writes nothing to its output, so this only keeps the graph running (silently).
      this.node.connect(this.context.destination)
      if (this.context.state === 'suspended') await this.context.resume()
    } catch (error) {
      await this.release()
      throw toMicrophoneProblem(error)
    }
  }

  /** Sends any buffered audio (< 100 ms), then releases the microphone. */
  async stop(): Promise<void> {
    if (this.node && !this.stopped) {
      const node = this.node
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250)
        node.port.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
          if (event.data.type === 'flushed') { clearTimeout(timer); resolve() }
        })
        node.port.postMessage('flush')
      })
    }
    await this.release()
  }

  private async release(): Promise<void> {
    this.stopped = true
    this.source?.disconnect()
    this.node?.disconnect()
    if (this.node) this.node.port.onmessage = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    if (this.context && this.context.state !== 'closed') await this.context.close().catch(() => undefined)
    this.stream = undefined; this.context = undefined; this.source = undefined; this.node = undefined
  }
}

export class MicrophoneProblem extends Error {}

function toMicrophoneProblem(error: unknown): MicrophoneProblem {
  if (error instanceof MicrophoneProblem) return error
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new MicrophoneProblem('Microphone access is blocked. Allow Triage in System Settings → Privacy & Security → Microphone.')
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new MicrophoneProblem('No microphone was found. Connect one and try again.')
  if (name === 'NotReadableError')
    return new MicrophoneProblem('The microphone is being used by another app. Close it and try again.')
  return new MicrophoneProblem('The microphone could not be started. Please try again.')
}
