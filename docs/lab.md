# The lab: measuring sync with clicks

The click test answers one question: when several devices are told to make a sound at the same instant, how far apart do they really make it? It needs no audio stream, only the shared clock, so it isolates the two errors every later stage inherits: the clock itself, and each device's output latency.

## Run it

```sh
npm install
npm start            # relay on http://localhost:3700
```

Phones need HTTPS to use audio features and must reach the relay. For a first test from a laptop, any HTTPS tunnel to port 3700 will do; for LTE tests the relay has to be on a public host.

Open `/lab/` on every device (add `?room=name` to keep groups apart) and tap the button. Each device gets a slot number, shown at the top.

## By ear: unison

In **Unison** mode every device clicks once per second at the same instant; one beat in eight is higher, so a whole-second error is audible too. Hold two devices next to each other:

- one click: within about 10 ms;
- a flam (two clicks close together): 15–40 ms;
- a clear echo: more.

Raise the **trim** of the device that is late until the flam closes. That number is the device's unreported latency against the other one. With a Bluetooth speaker expect 100–300 ms.

## By measurement: staggered

In **Staggered** mode each slot clicks in its own 100 ms window, at its own pitch. Record 30 seconds with one microphone, all devices at the same distance from it (10 cm of difference is 0.3 ms), then:

```sh
node lab/analyse-clicks.mjs recording.wav
```

Example, from a synthetic recording with three devices placed at 0, +7.5 and −3.2 ms:

```
slot  pitch   clicks   offset vs ref (median)   5%…95%            spread   drift
   0  1500 Hz     28                 +0.00 ms   +0.00 … +0.00       0.00 ms  +0.00 ms/min
   1  2000 Hz     28                 +7.49 ms   +7.06 … +8.14       1.08 ms  -0.21 ms/min
   2  2500 Hz     28                 -3.09 ms   -4.72 … -1.72       2.99 ms  +2.32 ms/min
```

- **offset**: how much later than the reference slot that device is heard. This is the number to trim out.
- **spread**: how much it wanders from click to click. Trim cannot fix this; it is the floor for that device.
- **drift**: whether the offset is moving over the recording. It should be near zero; if not, the clock fit or the audio mapping is losing track. On a 30-second recording a device with a wide spread shows a few ms/min of drift by chance alone (slot 2 above): record two minutes before believing a drift.

Up to eight devices per recording. Any format ffmpeg reads will do, including a phone's voice memo.

## The three mapping modes

A web page schedules sound on the audio clock; the clock test needs to know when that sound leaves the speaker. Browsers offer two hints, and they do not always agree, so the page lets you pick per device:

| Mode | Uses | Expectation |
|---|---|---|
| `timestamp` | `AudioContext.getOutputTimestamp()` | Should include the output latency. To be verified per browser |
| `latency` | `currentTime` plus `outputLatency` (or `baseLatency`) | What the browser says about its output path |
| `raw` | `currentTime` only | The baseline: shows how much the other two correct |

The page shows both latency figures side by side. Where they differ, the measurement says which one to believe.

## What to write down

Use **Copy room snapshot** on any device: it holds every device's clock quality, mode, trim, reported latencies and browser. Paste it next to the analyser output in a dated note under `docs/results/`, with the network (WiFi or LTE, operator) and the output (speaker, jack, Bluetooth model).
