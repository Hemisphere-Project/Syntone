// The click test's constants — shared by the page that plays the clicks and the script that measures them.

export const PERIOD_MS = 1000      // one beat per second of relay time
export const STAGGER_MS = 100      // staggered mode: slot s clicks s * 100 ms after the beat
export const MAX_SLOTS = 8         // 8 * 100 ms leaves the last 200 ms of each second silent: the recording's anchor
export const BURST_MS = 6          // tone burst length
export const ACCENT_EVERY = 8      // unison mode: beat 1 of 8 is higher, so a whole-second error is audible

/** Staggered mode: one pitch per slot, 500 Hz apart, inside what a phone speaker reproduces. */
export const slotFreq = (slot) => 1500 + 500 * (slot % MAX_SLOTS)
