// Runs on the audio rendering thread. Converts the microphone's float samples
// (already resampled by the AudioContext to its sample rate, 16 kHz) into
// 16-bit little-endian PCM and posts fixed-size chunks (100 ms by default)
// to the main thread, with an RMS level for a simple input meter.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.chunkSamples = (options && options.processorOptions && options.processorOptions.chunkSamples) || 1600
    this.buffer = new Int16Array(this.chunkSamples)
    this.length = 0
    this.sumSquares = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.flush()
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let index = 0; index < channel.length; index++) {
        const sample = Math.max(-1, Math.min(1, channel[index]))
        this.buffer[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        this.sumSquares += sample * sample
        if (this.length === this.chunkSamples) this.flush()
      }
    }
    return true
  }

  flush() {
    if (!this.length) return
    const chunk = this.buffer.slice(0, this.length)
    const level = Math.sqrt(this.sumSquares / this.length)
    this.port.postMessage({ type: 'audio', chunk: chunk.buffer, level }, [chunk.buffer])
    this.length = 0
    this.sumSquares = 0
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
