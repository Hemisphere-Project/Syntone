# Syntone — research plan

*Version 1, 2026-11-20. Built on eight desk-research reports ([research/](research/README.md)) and revised after an independent review of the first draft. Nothing in it has been measured by the project yet: every number below is either cited from a report or a target to test.*

## 1. What we are after

An FM transmitter and a handful of FM receivers give you something simple and precious: one source, heard on every receiver at the same instant, with no delay to speak of. Syntone tries to get as close to that as IP networks allow, with the devices people already carry.

- **Source**: a line or microphone input, local media, or what a device is playing.
- **Sender**: a phone (web page first) or a Raspberry Pi with a USB audio interface.
- **Receivers**: phones (web page first, on iOS and Android), ESP32 boards, Raspberry Pi.
- **Outputs**: a jack, a built-in speaker, and most often a Bluetooth speaker.
- **Network**: WiFi and 4G/LTE, through a small hosted relay.

### What the desk research expects (not measured)

FM is about 0 ms and its receivers are passive. IP is neither.

| Situation | Delay from source to ear | Devices agree within | From report |
|---|---|---|---|
| Buffered playback (a file, or a live source held back) | 0.5–10 s, chosen | 1–10 ms | 04, 08 |
| Live on venue WiFi, native receivers (Pi, ESP32) | 30–80 ms | 1–2 ms | 03, 06 |
| Live on venue WiFi, phones in a browser | about 70–200 ms | 1–10 ms | 03, 05 |
| Live, phone to phones over LTE, wired or built-in outputs | about 200–400 ms | 5–15 ms | 03 |
| Live over LTE with classic Bluetooth speakers | about 450–600 ms | 10–20 ms after calibration | 07 |

The reports do not agree on the LTE row: 120–250 ms (08), 150–350 ms (07) and 200–400 ms (03). This table follows report 03, the one that studied the network; measuring it is milestone M3.

Three facts shape everything else:

- **Sound itself travels 2.9 ms per metre**, so phones spread across a room cannot agree better than a few milliseconds at the listener's ear.
- **Devices only play together if they all wait for the slowest one**: the group's delay is set by its worst network path plus its slowest output.
- **If listeners also hear the source directly** (a performer in the room), any delay above roughly 30 ms is heard as an echo of the stage. Live over LTE, at a few hundred milliseconds, suits walks and spaces where the source is not heard directly; a performer in the room calls for the venue-WiFi tiers.

### Priorities (decided 2026-11-20)

1. **Devices that share a space must not echo against each other.** Target: within 10 ms of each other 95 % of the time, *and* a steady offset: two copies of one sound whose offset keeps moving sound phasey even when the offset stays small. Starting bound for that wander, to be validated by ear: under 1 ms per minute.
2. **The delay is fixed and declared.** One number for the whole group, stable over the session.
3. **Then push that delay down**, as close to the performer's gesture as the network allows.

Fleet size: up to 30 receivers first, then 100–300. Removing the single relay as a point of failure (peer-to-peer or several relays) is of interest, after sync and delay.

## 2. The idea in one equation

Every piece of audio carries the time it was captured, on a clock all devices share. Every receiver hands it to its audio system at:

```
hand-off time = capture time + D − L(device)        so that it is HEARD at capture time + D
```

- **D** is the group's delay, chosen by the relay: large enough for the worst network path and the slowest output in the group.
- **L(device)** is how long that device takes between handing a sample to its audio system and the sound leaving the speaker. It is small and stable on a jack, large and unreliable on Bluetooth.

Four errors add up, and each has its own track of work:

| Error | Size if ignored | How it is handled |
|---|---|---|
| Clock: devices disagree on what time it is | 5–100 ms | NTP-style exchange with the relay, keeping only the fastest round trips, fitted for drift ([shared/clock.js](../shared/clock.js)). On LTE, pings go in pairs: the first wakes the radio, the second measures |
| Receiver audio clock: each sound card runs slightly fast or slow | 3 ms per minute at 50 ppm | The player measures its own error and resamples. It follows the device's steady drift gently (tens of ppm), and keeps the full ±500 ppm range for recovery only |
| Output latency: L(device) is unknown | 5–40 ms wired, 100–300 ms Bluetooth | What the browser reports, then a per-device trim (a manual correction in ms), then calibration by microphone |
| Sender: its sound card has a rate of its own, and its input has a latency | 3 ms per minute; 10–40 ms | Capture times come from a line fitted through (sample count, relay time), so they are smooth and advance at the sender's real rate; receivers then absorb it with their own drift. The sender's input latency is measured once per sender and declared as part of D |

The receiver owns its playout. This is how Snapcast, AirPlay 2 and Sendspin (an open multi-room protocol from the Open Home Foundation) work, and it is why stock WebRTC is not the foundation here: it makes each receiver play as early as *it* can, with its own adaptive buffer, built for speech, not for agreeing with its neighbours.

One engine serves both research axes. Buffered playback is the same player with D at several seconds; low-latency live is the same player with D at a few hundred milliseconds and a faster transport.

### What quality buys

The brief allows trading audio quality for latency. The research answer: on LTE, codec settings are not the lever. Going from 20 ms to 10 ms Opus frames saves about 10 ms; bitrate barely moves latency. The real trade is **D against dropouts**: a shallower buffer is a lower delay and more holes. So the plan works with presets rather than a quality knob (from report 03, to be tuned by measurement):

| Preset | D | Frames | Transport |
|---|---|---|---|
| Venue WiFi, native | 40–80 ms | 5 ms | UDP |
| LTE live | about 250 ms | 10 ms, with redundancy | datagrams |
| LTE safe | 400–600 ms | 20 ms | WebSocket is enough |
| Buffered | 2–10 s | 20 ms | anything |

## 3. Architecture

```
 sender                      relay                        receivers
 ──────                      ─────                        ─────────
 capture ─► mix ─► Opus      reference clock              jitter buffer ─► Opus decode
 stamp with capture time ──► rooms, group delay D ──────► ring buffer in the audio thread
                             fan-out of frames            resample to hold  capture + D − L
                                                          report clock, error, dropouts
```

- **Relay** ([server/](../server/index.js)): Node.js, one process. It is the clock, the room list and the fan-out. It never decodes audio.
- **Frame**: sequence number, capture time in relay microseconds, one Opus packet. The same frame is meant to travel over WebSocket first, then WebTransport datagrams, a WebRTC DataChannel or plain UDP, and through a second relay or a peer: timing lives in the frame, not in the transport.
- **Sender**: microphone or line with all voice processing off, or a file; mixed in Web Audio; encoded with the browser's Opus encoder, with a WebAssembly fallback.
- **Receiver**: decodes, then plays from an AudioWorklet (code running in the browser's audio thread) that holds the equation above. When data is late it plays silence and rejoins exactly on time; it never stalls and catches up.
- **Lab** ([web/lab/](../web/lab/), [lab/](../lab/analyse-clicks.mjs)): the measuring instruments. Nothing is called working until it has a number from here.

### What is reused, what is ruled out

| | Verdict | Why |
|---|---|---|
| FlanerieMozaic: rooms, QR join, control page, device registry | Reuse the ideas for the control side | Its playback layer steers a media element with a 50 ms dead band: fine for a video wall, an echo for audio |
| Clock: `@ircam/sync`, which FlanerieMozaic uses | Same method, own small estimator | [shared/clock.js](../shared/clock.js) has no dependency, runs unchanged in browser and Node, and is small enough to port to an ESP32. M0 checks it against `@ircam/sync` on the same phones |
| Sendspin and Snapcast | Model, benchmark, possible wire format | Both solve synced playout on a local network with about 1 s of buffer. Neither covers LTE, a low-delay live tier, or Bluetooth calibration. Measured as a baseline in M2 |
| WebRTC with a media server and stock playout (LiveKit) | Baseline to measure against | Low delay per receiver, no alignment between receivers |
| WebRTC DataChannel carrying our frames | Candidate live transport, and the browser's only peer-to-peer path | Works on iPhones older than iOS 26.4; needs a TURN relay behind carrier NAT |
| WebTransport datagrams | Candidate live transport | In every major browser since Safari 26.4; avoids TCP stalls on LTE |
| HLS, Icecast | Ruled out | Seconds of delay, no sync |
| Media-element `playbackRate` steering | Ruled out | Audible pitch steps, glitches on iOS |

## 4. Milestones

Each milestone ends on a measurement with a pass mark. Only the first two carry dates.

### M0 — Lab: can we measure? *(tools built; phone sitting in early December 2026)*

Clock sync, a click test page where every device clicks on the same beat, and a script that measures a one-microphone recording of those clicks ([lab guide](lab.md)).

- **Built and tested**: clock estimator with sleep detection, relay, click page, analyser.
- **To do, with phones in hand**: the *truth table*. For each phone and browser, on WiFi and LTE, and for each of the three ways the page can map the clock to the speaker: how far is it from a reference device, and how much does that move over ten minutes? The same sitting records what each phone's browser supports for M1 (Opus encode and decode, output timestamps), which the page logs by itself.
- **Also**: the clock estimator compared with `@ircam/sync` on the same phones.
- **Pass**:
  - *The instrument is accurate*: in self-test (one device playing all eight slots), the analyser reports every slot within 0.3 ms in the room where the measurements are made.
  - *An offset belongs to the device*: with two devices swapped between slots, each offset follows its device within 0.3 ms.
  - *Coverage*: at least one iPhone and one Android measured on WiFi and LTE (two of each if at hand). Run-to-run variation is recorded as a result, not as a pass mark.

### M1 — First demo: live, phone to phones, over LTE *(target: 18 December 2026)*

A sender page and receiver pages, through the hosted relay, at one fixed delay.

- Opus 20 ms frames over WebSocket; AudioWorklet player with drift correction; a trim per device; the lab roster extended with each device's playout error and dropout count.
- **How it is measured**: a *stream click test*. The sender puts the staggered click pattern into the audio stream itself, and in test mode each receiver lets through only its own slot. The analyser then measures the real path (capture stamp, relay, decode, player, speaker) with the M0 method. For D, a lab device on slot 0 clicks into the sender's microphone, so the recording holds the source next to every receiver. A dropout is a frame the player reports as missing, not an impression.
- **Pass**: three phones on LTE (at least one iPhone, one Android, two operators if at hand), built-in speakers, trims set from one staggered recording of the same session:
  - within 10 ms of each other 95 % of the time, wander under 1 ms per minute, over 30 minutes;
  - measured source-to-ear delay within 5 ms of the declared D, with D at or under 500 ms;
  - at most one dropout per 10 minutes;
  - after a forced reconnect of one phone, it is back within 10 ms without touching its trim.
- **Kept small on purpose**: the sender is Chrome on a laptop or an Android phone (iPhones receive only); the measured run uses the test source, the microphone is for showing; receivers stay in the foreground with the screen kept on, in a Safari or Chrome tab; if Opus fails on a phone in hand, plain PCM is the fallback codec.
- **Not in the demo**: Bluetooth, ESP32, background playback, more than one sender.

#### Road to 18 December

| When | Who | What |
|---|---|---|
| to 2 Dec | the coding agent, unattended | Relay fan-out; player core as tested modules; sender and receiver pages; stream click test. All testable on a laptop |
| by 2 Dec | owner, with a session | Relay online at its public address |
| 3–5 Dec | owner, one hour | M0 truth table, cut to what M1 needs |
| 6–10 Dec | owner and agent | M1 on real phones: WiFi first, then LTE |
| 10 Dec | owner | Go or no-go on one measured 30-minute run |
| to 17 Dec | | Fixes, pass runs |

**If the gate fails**, the demo falls back to the same build on WiFi, or with D at 2 s: the same engine, still showing priorities 1 and 2.

### M2 — Buffered mode and survival on real phones

The same player with D at 2–10 s: a file played in sync, a live input held back, rejoining after a network hole. Then the background matrix: screen locked, app switched, call received, Low Power Mode, per platform.

- Also here: **30 receivers** (real phones plus headless clients) holding M1's sync, since D is set by the worst of them; and **Sendspin measured as a baseline** (its reference server and browser player, phones on LTE, same click method).
- **Pass**: within 5 ms of the shared timeline 100 ms after data returns; the matrix says, per platform, whether a web page is enough.
- **Decides**: whether receivers need a thin native shell (the studio already ships a Cordova app).

### M3 — Push the delay down

A transport shoot-out on real LTE paths (static, walking, handover): WebSocket, WebTransport datagrams, WebRTC DataChannel. 10 ms frames. Against loss, either the previous frame carried again in each packet, or a WebAssembly Opus decoder that can conceal a missing frame (the browser's built-in decoder cannot). Frame size, bitrate, mono or stereo compared by ear. A stock LiveKit room as the yardstick.

- **Pass**: D at or under 250 ms standing still and 400 ms walking or through a handover, with M1's bar on dropouts (one per 10 minutes, after redundancy) and M1's sync.

### M4 — Bluetooth

A per-device, per-route latency that is measured, not believed: a reference phone's microphone times each receiver's chirps. Recalibration when the speaker reconnects or changes codec. A side look at Auracast, the only Bluetooth mode with a defined, shared delay.

- **Pass**: Bluetooth receivers within 10 ms of each other and of their group's timeline, 95 % of the time, over 30 minutes; after a reconnect, automatic recalibration restores that within 10 s.

### M5 — Small receivers: ESP32 and Raspberry Pi

ESP32-S3 with an I2S amplifier; Pi with a DAC. First question: speak Sendspin on the wire and reuse its ESP32 and Pi players, or keep our own frame and port the player.

- **Getting them online**, in order of preference: a phone's WiFi hotspot; a Pi tethered to a phone over USB (works with Android and iPhone); an ESP32 tethered over USB as a spike, Android only (unproven); iPhone-to-ESP32 over USB is ruled out by the research.
- **Pass**: embedded receivers within 2 ms of each other on WiFi, within 5 ms of phones.

### M6 — The sender grows up

- **Phone sender**: microphone, a line or external microphone through a USB-C or TRRS adapter, and one local file, mixed with gains, with a monitor output. Pass: stereo kept and no automatic gain, on Android Chrome and iOS Safari. Known traps to measure: iOS gives left-channel-only audio when echo cancellation is off; Android Chrome does not always honour the chosen USB input.
- **Raspberry Pi audio hub** with a USB interface: line and microphone inputs, local files, and "what a phone is playing" received as a Spotify Connect or AirPlay speaker rather than captured. No phone browser can capture another app's audio; an Android native capture path only if a phone-only rig proves necessary.

### M7 — Scale and resilience

100–300 receivers on one relay with cost per listener-hour; then a second relay, or peer-to-peer forwarding over WebRTC DataChannels, which the frame format is designed to allow.

## 5. Decisions

Settled so far: the name and licence, the three priorities, fleet sizes, the December demo, and the relay's home for the tests and the demo (an existing studio server, public HTTPS, WebSocket only; a host with direct UDP comes with M3).

Waiting for the owner:

| # | Question | Needed by | Recommendation |
|---|---|---|---|
| 1 | What is the demo: for whom, where, which source? | early December | A table of three phones and a laptop sender, indoors, a music file and a microphone |
| 2 | Which phones and SIM cards (operators) can the tests use? | M0 sitting | Two iOS, two Android, two operators |
| 3 | Will listeners of the live mode also hear the source directly? | before M3 | LTE live for walks and spaces where the source is not heard; venue WiFi with a local relay otherwise |
| 4 | Is a native shell acceptable for receivers? | M2 | Web only until the M2 matrix says where it fails |
| 5 | In one space, does a Bluetooth speaker raise everyone's delay, or is it kept out of that space's live group? | M4 | Priority 1 already answers: never two delays in one space. Raise D, or keep Bluetooth for buffered content |
| 6 | Is rebroadcasting streaming services (Spotify and others) in scope for public shows? | M6 | Private and rehearsal use only: it conflicts with the services' terms and needs public-performance licensing |
| 7 | Is a Raspberry Pi in the bag acceptable as the main sender? | M6 | Yes: a phone page covers microphone, line and files; only a Pi (or a native app) gets other apps' audio |

A technical default, not an owner question: the wire format stays our own, shaped like Sendspin's, until M5 decides with the M2 baseline in hand.

## 6. Risks

- **iOS changes under us.** WebKit audio behaviour has regressed between releases. Mitigation: the lab page doubles as a regression test before every show.
- **Clock bias on LTE.** A lone uplink packet waits for the cell to grant it a slot, the answer does not: every estimate is shifted by a few milliseconds per device, differently per operator. Paired pings measure it (M0); a trim absorbs what stays constant; a local relay as time anchor is the fallback for fixed fleets.
- **A moving offset.** Drift correction that works too hard is heard as a flanger between two devices in one space, even inside the 10 ms target. Hence the wander bound, and a player that corrects gently.
- **Bluetooth latency moves.** It drifts over a session and resets on reconnect. One calibration is not enough; M4 has to detect and redo it.
- **One sender uplink.** Every listener depends on the sender's LTE uplink. A Pi sender with two paths is the eventual answer.
- **The measuring room.** Narrow test tones shift with reflections: a table top can move a reading by a millisecond. The self-test of M0 measures exactly that, per room.
- **Upkeep.** Browser, two phone platforms, ESP32 and Pi is a lot for a small studio. One engine, one frame format, reuse of existing embedded players where they fit.

## 7. How results are recorded

Each experiment gets a dated note in `docs/results/` with the setup, the raw numbers and the verdict against its pass mark. A decision that follows from a result is added to this plan with its date.
