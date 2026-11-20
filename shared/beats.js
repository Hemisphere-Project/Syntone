// Which beats should be handed to the audio system on this scheduler pass?
//
// A beat is due at a relay time; `whenOf` turns that into an AudioContext time, which already
// accounts for the device's output latency and trim. The decision has to be made on THAT time:
// a Bluetooth speaker 300 ms late means the sample must be queued 300 ms earlier, so a window
// measured in relay time would be silently too short (and at 700 ms, drop every beat).
//
//   too late   when < ctxNow + minLead    never play late: count it as skipped, move on
//   in time    …up to ctxNow + lead       queue it
//   too early  beyond that                leave it for a later pass
//
// Pure, so it is tested without a browser.

/**
 * @param {object} o
 * @param {number} o.nowS       relay time now (ms)
 * @param {number} o.lastBeat   last beat index already decided (-1 after a reset)
 * @param {number} o.period     ms between beats
 * @param {number} o.offset     this slot's offset inside the period (ms)
 * @param {(serverMs:number)=>number} o.whenOf  relay time → AudioContext time (s)
 * @param {number} o.ctxNow     AudioContext.currentTime (s)
 * @param {number} [o.lead]     queue this far ahead (s)
 * @param {number} [o.minLead]  below this it cannot be on time (s)
 * @param {number} [o.reach]    how far back in relay time a beat can still be playable (ms): a
 *                              negative trim plays a beat AFTER its relay time
 * @returns {{beats:Array<{k:number, serverT:number, when:number}>, lastBeat:number, skipped:number}}
 */
export function planBeats({ nowS, lastBeat, period, offset, whenOf, ctxNow, lead = 0.7, minLead = 0.005, reach = 1000 }) {
  const fresh = lastBeat < 0                       // after a reset, beats already gone are not "skipped"
  const beats = []
  let skipped = 0
  const oldest = Math.ceil((nowS - reach - offset) / period)
  let k = lastBeat + 1
  if (oldest > k) { if (!fresh) skipped += oldest - k; k = oldest }   // beats that went by while the page was stalled
  for (let guard = 0; guard < 64; guard++, k++) {
    const serverT = k * period + offset
    const when = whenOf(serverT)
    if (!(when <= ctxNow + lead)) break            // too early (or not a number): try again next pass
    lastBeat = k
    if (when < ctxNow + minLead) { if (!fresh || beats.length) skipped++; continue }
    beats.push({ k, serverT, when })
  }
  return { beats, lastBeat, skipped }
}
