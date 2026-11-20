// Syntone audio frame — the one binary message on the wire.
//
// A frame carries its own timing, so it can travel over WebSocket now and over WebTransport
// datagrams, a DataChannel or plain UDP later without changing (plan §3). The relay reads only the
// header, never the audio.
//
//   byte 0       type        1 = audio
//   bytes 1–8    captureUs   capture time on the relay clock, in microseconds (int64, big-endian)
//   bytes 9–12   seq         sequence number (uint32, big-endian, wraps)
//   bytes 13…    payload     one Opus packet (or one PCM block, the fallback codec)
//
// The layout starts like Sendspin's binary messages (a type byte, then a big-endian int64 µs
// timestamp); the sequence number is ours. Same code in the browser and in Node: no Buffer, only
// Uint8Array and DataView.

export const FRAME_AUDIO = 1
export const HEADER_BYTES = 13
/** Opus tops out at 1275 bytes a frame; this leaves room for 20 ms of 16-bit stereo PCM at 48 kHz (3840). */
export const MAX_PAYLOAD = 8192

/**
 * @param {{seq:number, captureUs:number, payload:Uint8Array, type?:number}} f
 * @returns {Uint8Array} header + payload, one allocation
 */
export function encodeFrame({ seq, captureUs, payload, type = FRAME_AUDIO }) {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) throw new RangeError(`seq ${seq}`)
  if (!Number.isFinite(captureUs) || Math.abs(captureUs) > Number.MAX_SAFE_INTEGER) throw new RangeError(`captureUs ${captureUs}`)
  if (!(payload instanceof Uint8Array) || payload.length > MAX_PAYLOAD) throw new RangeError('payload')
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  const dv = new DataView(out.buffer)
  dv.setUint8(0, type)
  dv.setBigInt64(1, BigInt(Math.round(captureUs)))
  dv.setUint32(9, seq)
  out.set(payload, HEADER_BYTES)
  return out
}

/**
 * Reads a frame without copying: `payload` is a view into `bytes`.
 * Accepts a Uint8Array (a Node Buffer is one, possibly a slice of a shared pool) or an ArrayBuffer
 * (what a browser WebSocket hands over with binaryType 'arraybuffer').
 * @returns {{type:number, captureUs:number, seq:number, payload:Uint8Array} | null} null if it is not a valid frame
 */
export function decodeFrame(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes)
  if (!(bytes instanceof Uint8Array)) return null
  if (bytes.length <= HEADER_BYTES || bytes.length > HEADER_BYTES + MAX_PAYLOAD) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = dv.getUint8(0)
  if (type !== FRAME_AUDIO) return null
  const captureUs = Number(dv.getBigInt64(1))
  return { type, captureUs, seq: dv.getUint32(9), payload: bytes.subarray(HEADER_BYTES) }
}

/** a − b for uint32 sequence numbers, across the wrap: positive when `a` comes after `b`. */
export const seqDiff = (a, b) => ((((a - b) >>> 0) + 0x80000000) >>> 0) - 0x80000000
