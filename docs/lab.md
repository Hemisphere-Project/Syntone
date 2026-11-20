# The lab: measuring sync with clicks

The click test answers one question: when several devices are told to make a sound at the same instant, how far apart do they really make it? It needs no audio stream, only the shared clock, so it isolates the two errors every later stage inherits: the clock itself, and each device's output latency.

## Run it

```sh
npm install
npm start            # relay on http://localhost:3700
```

Phones need HTTPS to use audio features and must reach the relay. On WiFi, any HTTPS tunnel to port 3700 will do for a first try. For LTE measurements the relay has to be on a public host ([deploy/](../deploy/README.md)): a tunnel adds a path of its own, and the point of the LTE runs is to measure the path.

Open `/lab/` on every device (add `?room=name` to keep groups apart) and tap the button. Each device gets a slot number, shown at the top. The page keeps the screen on; a phone that locks suspends its audio.

## By ear: unison

In **Unison** mode every device clicks once per second at the same instant; one beat in eight is higher, so a whole-second error is audible too. Hold two devices next to each other:

- one click: within about 5 ms;
- a flam (two clicks close together): roughly 5–30 ms;
- a clear echo: more.

Raise the **trim** of the device that is late until the flam closes. That is a coarse setting: the ear cannot confirm the 10 ms target, only get near it. With a Bluetooth speaker expect a trim of 100–300 ms. The trim is kept on the device between visits, so set it back to 0 before a measurement.

## By measurement: staggered

In **Staggered** mode each slot clicks in its own 100 ms window, at its own pitch. Record with one microphone, all devices at the same distance from it (10 cm of difference is 0.3 ms), then:

```sh
node lab/analyse-clicks.mjs recording.wav
```

Example, from a synthetic recording with three devices placed at 0, +7.5 and −3.2 ms:

```
slot  pitch   clicks   offset vs ref (median)   5%…95%            spread   wander   drift
   0  1500 Hz     28                 +0.00 ms   +0.00 … +0.00       0.00 ms  0.00 ms  +0.00 ms/min
   1  2000 Hz     28                 +7.49 ms   +7.06 … +8.14       1.08 ms  1.07 ms  -0.21 ms/min
   2  2500 Hz     28                 -3.09 ms   -4.72 … -1.72       2.99 ms  1.98 ms  +2.32 ms/min
```

- **offset**: how much later than the reference slot that device is heard. This is the number to trim out.
- **spread**: how much it varies from click to click. Trim cannot fix this; it is the floor for that device.
- **wander**: how much the offset moves from one click to the next. Two devices in one room with a moving offset sound phasey even when the offset is small.
- **drift**: whether the offset is moving over the recording. It should be near zero; if not, the clock fit or the audio mapping is losing track. On a 30-second recording a device with a wide spread shows a few ms/min of drift by chance alone (slot 2 above): record two minutes before believing a drift.

Any format ffmpeg reads will do, including a phone's voice memo.

Three things spoil a recording without saying so:

- **More than eight devices.** There are eight slots per room. A ninth device stays silent in staggered mode and says so on its page.
- **The roster changing mid-recording.** A device that reconnects asks for its old slot back, and gets it when the slot is free. If the device list changed while recording, record again.
- **A stray tab.** Every open `/lab/` page clicks, including one opened on a laptop just to watch. Close it, or use it as the reference.

### Check the room first: self-test

The test tones are narrow, and a reflection off a table can shift where each pitch appears to start, by up to a millisecond, differently per pitch. To measure that error rather than trim it into the devices, open `/lab/?selftest=1` on one device: in staggered mode it plays all eight slots itself. Record it from the spot where the measurements will be made. Every slot should read within 0.3 ms of slot 0. If not, move the microphone or the devices (closer, away from hard surfaces) until it does.

To check that an offset belongs to a device and not to its pitch, swap two devices between slots (have both leave, then join in the opposite order) and record again: each offset should follow its device.

## The three mapping modes

A web page schedules sound on the audio clock; the click test needs to know when that sound leaves the speaker. Browsers offer two hints, and they do not always agree, so the room can switch between them:

| Mode | Uses | Expectation |
|---|---|---|
| `timestamp` | `AudioContext.getOutputTimestamp()` | Should include the output latency. To be verified per browser |
| `latency` | `currentTime` plus `baseLatency` and `outputLatency` | What the browser says about its output path |
| `raw` | `currentTime` only | The baseline: shows how much the other two correct |

The mode is set for the whole room: change it on one device and every device follows. The roster shows both latency figures side by side; where they differ, the measurement says which one to believe. Where a browser gives no usable timestamp, `timestamp` mode falls back to `latency` and the roster shows it as `timestamp→latency`: do not file that row under `timestamp`.

## The roster

One line per device, in milliseconds unless said:

| Column | Meaning |
|---|---|
| bound | Worst-case clock error: half the best round trip to the relay, or more when recent exchanges contradict the estimate |
| rtt | Best round trip |
| skew | How fast this device's clock runs against the relay's, in parts per million |
| pair | Pings go in pairs; this is how much later the first lands than the second. Near zero on WiFi. On LTE it shows the cost of waking the radio, which shifts a clock estimate without showing in the bound |
| base, out | The two latencies the browser reports for its output path |
| ts-lat | The output latency its timestamp implies. Comparable with base + out |
| skips | Clicks that could not be queued in time. Should stay at 0 |

## Run sheet for a truth table (about one hour)

1. A laptop joins first and is the reference (slot 0). Then the phones, trim at 0, close to one microphone and equidistant from it.
2. **Self-test** in this room, 30 s. Adjust until every slot is within 0.3 ms.
3. **Modes on WiFi**: staggered, one 30 s recording per mode (three recordings). Copy the room snapshot after each.
4. **Modes on LTE**: phones off WiFi, same three recordings.
5. **Stability**: the best mode, one 10-minute recording on WiFi and one on LTE.
6. **Repeatability**: repeat one 30 s recording without touching anything.
7. **Swap**: two phones exchange slots, 30 s.

Use **Copy room snapshot** on any device after each recording: it holds every device's clock quality, mode, trim, reported latencies, browser, and what that browser supports for the next milestone (Opus encoding and decoding, output timestamps). Paste it next to the analyser output in a dated note under `docs/results/`, with the network (WiFi or LTE, operator) and the output (speaker, jack, Bluetooth model).
