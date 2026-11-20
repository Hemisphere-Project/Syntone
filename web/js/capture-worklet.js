// Syntone sender — the AudioWorklet processor that hands captured audio to the page.
//
//   const node = new AudioWorkletNode(ctx, 'syntone-capture', { numberOfInputs: 1, numberOfOutputs: 1,
//     outputChannelCount: [1], processorOptions: { channels: 1, blockSamples: 512 } })
//
// Out through the port, every `blockSamples` samples: { type: 'block', n, pcm: [Float32Array per channel] }
// with `n` = samples captured so far, this block included. The page stamps the block with the relay time
// it reached it (shared/stamps.js takes the lower envelope of those arrivals, so their jitter is not in
// the stamps). A silent input (nothing connected yet) still counts samples: the stream never has holes.
// The output stays silent; connecting it keeps the node pulled by the graph on every browser.
export class SyntoneCapture extends AudioWorkletProcessor {
  constructor(options = {}) {
    super()
    const o = options.processorOptions || {}
    this.channels = o.channels || 1
    this.size = o.blockSamples || 512
    this.n = 0
    this.fill = 0
    this.buf = this._alloc()
    this.running = true
    this.port.onmessage = (ev) => { if (ev.data?.type === 'stop') this.running = false }
  }

  _alloc() { return Array.from({ length: this.channels }, () => new Float32Array(this.size)) }

  process(inputs) {
    const inp = inputs[0] || []
    const len = inp[0]?.length || 128
    let i = 0
    while (i < len) {
      const take = Math.min(len - i, this.size - this.fill)
      for (let c = 0; c < this.channels; c++) {
        const src = inp[c] || inp[0]
        if (src) this.buf[c].set(src.subarray(i, i + take), this.fill)
        else this.buf[c].fill(0, this.fill, this.fill + take)
      }
      this.fill += take; i += take
      if (this.fill === this.size) {
        this.n += this.size
        this.port.postMessage({ type: 'block', n: this.n, pcm: this.buf }, this.buf.map((a) => a.buffer))
        this.buf = this._alloc()
        this.fill = 0
      }
    }
    return this.running
  }
}

registerProcessor('syntone-capture', SyntoneCapture)
