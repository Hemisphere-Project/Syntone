# Syntone — research plan

*Version 1, 2026-11-20. Built on eight desk-research reports ([research/](research/README.md)). Nothing in it has been measured by the project yet: every number below is either cited in a report or a target to test.*

## 1. What we are after

An FM transmitter and a handful of FM receivers give you something simple and precious: one source, heard on every receiver at the same instant, with no delay to speak of. Syntone tries to get as close to that as IP networks allow, with the devices people already carry.

- **Source**: a line or microphone input, local media, or what a device is playing.
- **Sender**: a phone (web page first) or a Raspberry Pi with a USB audio interface.
- **Receivers**: phones (web page first, on iOS and Android), ESP32 boards, Raspberry Pi.
- **Outputs**: a jack, a built-in speaker, and most often a Bluetooth speaker.
- **Network**: WiFi and 4G/LTE, through a small hosted relay.

### What physics allows

FM is about 0 ms and its receivers are passive. IP is neither. The honest promises, from the research:

| Situation | Delay from source to ear | Devices agree within |
|---|---|---|
| Buffered playback (a file, or a live source held back) | 0.5–10 s, chosen | 1–10 ms |
| Live, on venue WiFi, wired or built-in outputs | 40–100 ms | 1–10 ms |
| Live, phone to phone over LTE, wired or built-in outputs | about 150–350 ms | 5–15 ms |
| Live over LTE with classic Bluetooth speakers | about 450–600 ms | 10–20 ms after calibration |

Two facts shape everything else. Sound itself travels 2.9 ms per metre, so phones spread across a room cannot agree better than a few milliseconds at the listener's ear. And devices only play together if they all wait for the slowest one: the fleet's delay is set by its worst network path plus its slowest output.

### Priorities (decided 2026-11-20)

1. **Devices that share a space must not echo against each other.** Target: 95 % of the time within 10 ms of each other.
2. **The delay is fixed and declared.** One number for the whole group, stable over the session.
3. **Then push that delay down**, as close to the performer's gesture as the network allows.

Fleet size: up to 30 receivers first, then 100–300. Removing the single relay as a point of failure (peer-to-peer or several relays) is of interest, after sync and delay.

## 2. The idea in one equation

Every piece of audio carries the time it was captured, on a clock all devices share. Every receiver plays it at:

```
play time = capture time + D − L(device)
```

- **D** is the group's delay, chosen by the relay: large enough for the worst network path and the slowest output in the group.
- **L(device)** is how long that device takes between handing a sample to its audio system and the sound leaving the speaker. It is small and stable on a jack, large and unreliable on Bluetooth.

Three errors add up, and each has its own track of work:

| Error | Size if ignored | How it is handled |
|---|---|---|
| Clock: devices disagree on what time it is | 5–100 ms | NTP-style exchange with the relay, keeping only the fastest round trips, fitted for drift ([shared/clock.js](../shared/clock.js)) |
| Audio clock: each device's sound card runs slightly fast or slow | 3 ms per minute at 50 ppm | The player measures its own error and resamples by a fraction of a percent, inaudibly |
| Output latency: L(device) is unknown | 5–40 ms wired, 100–300 ms Bluetooth | What the browser reports, then a per-device trim, then calibration by microphone |

The receiver owns its playout. This is how Snapcast, AirPlay 2 and Sendspin work, and it is why stock WebRTC is not the foundation here: WebRTC makes each receiver play as early as *it* can, with its own adaptive buffer, and offers no way to align receivers with each other.

One engine serves both research axes. Buffered playback is the same player with D at several seconds; low-latency live is the same player with D at a few hundred milliseconds and a faster transport.

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
- **Frame**: sequence number, capture time in relay microseconds, one Opus packet. The same frame travels over WebSocket today, WebTransport datagrams or UDP later, and through a second relay or a peer if we get there: timing lives in the frame, not in the transport.
- **Sender**: microphone or line with all voice processing off, or a file; mixed in Web Audio; encoded with the browser's Opus encoder, with a WebAssembly fallback.
- **Receiver**: decodes, then plays from an AudioWorklet that holds the equation above. When data is late it plays silence and rejoins exactly on time; it never stalls and catches up.
- **Lab** ([web/lab/](../web/lab/), [lab/](../lab/analyse-clicks.mjs)): the measuring instruments. Nothing is called working until it has a number from here.

### What is reused, what is ruled out

| | Verdict | Why |
|---|---|---|
| FlanerieMozaic clock approach, rooms, control page | Reuse the ideas | Its clock layer is sound. Its playback layer steers a media element with a 50 ms dead band: fine for a video wall, an echo for audio |
| Sendspin (Open Home Foundation) and Snapcast | Model, benchmark, possible wire format | Both solve synced playout on a local network with about 1 s of buffer. Neither covers LTE, a low-delay live tier, or Bluetooth calibration |
| WebRTC with an SFU (LiveKit) | Baseline to measure against | Low delay per receiver, no alignment between receivers |
| WebTransport datagrams | The live tier's transport, after the demo | In every major browser since Safari 26.4; avoids TCP stalls on LTE |
| HLS, Icecast | Ruled out | Seconds of delay, no sync |
| Media-element `playbackRate` steering | Ruled out | Audible pitch steps, glitches on iOS |

## 4. Milestones

Each milestone ends on a measurement with a pass mark. Only the first two carry dates.

### M0 — Lab: can we measure? *(in progress, November 2026)*

Clock sync, a click test page where every device clicks on the same beat, and a script that measures a one-microphone recording of those clicks.

- **Built**: clock estimator, relay, click page, analyser, all with tests.
- **To do, with phones in hand**: the *truth table*. For each phone and browser, and each of the three ways the page can map the clock to the speaker, how far is it from a reference device, and how much does that move over ten minutes?
- **Pass**: the method repeats within 0.3 ms on the same setup; at least four phones measured (two iOS, two Android), on WiFi and on LTE.

### M1 — First demo: live, phone to phones, over LTE *(target: 18 December 2026)*

A sender page (microphone or file) and receiver pages, through a hosted relay, at one fixed delay.

- Opus 20 ms frames over WebSocket; AudioWorklet player with drift correction; a trim per device; a control page showing every device's clock quality, playout error and dropouts.
- **Pass**: three phones on LTE (at least one iPhone, one Android), built-in speakers, within 10 ms of each other 95 % of the time after a one-time trim; delay D at or under 500 ms and stable within 2 ms for 30 minutes; at most one audible dropout per 10 minutes.
- **Not in the demo**: Bluetooth, ESP32, background playback, more than one sender.

### M2 — Buffered mode and survival on real phones

The same player with D at 2–10 s; playing a file in sync; rejoining after a network hole. Then the background matrix: screen locked, app switched, call received, Low Power Mode, per platform.

- **Pass**: within 5 ms of the timeline 100 ms after data returns; the matrix says, per platform, whether a web page is enough.
- **Decides**: whether receivers need a thin native shell (the studio already ships a Cordova app).

### M3 — Push the delay down

WebTransport datagrams, 10 ms frames, redundancy against loss. Measure real LTE paths (static, walking, handover). Compare with a stock LiveKit room.

- **Pass**: D at or under 250 ms on LTE with 99.9 % of frames on time; the sync of M1 holds.

### M4 — Bluetooth

A per-device, per-route latency that is measured, not believed: a reference phone's microphone times each receiver's chirps. Groups split into zones so one Bluetooth speaker does not delay everyone. A side look at Auracast, the only Bluetooth mode with a defined, shared delay.

- **Pass**: Bluetooth receivers within 10 ms of wired ones after calibration, still true after a reconnect and after 30 minutes.

### M5 — Small receivers: ESP32 and Raspberry Pi

ESP32-S3 with an I2S amplifier; Pi with a DAC. First question: speak Sendspin on the wire and reuse its ESP32 and Pi players, or keep our own frame and port the player.

- **Pass**: embedded receivers within 2 ms of each other on WiFi, within 5 ms of phones.

### M6 — The sender grows up

A Raspberry Pi audio hub with a USB interface: line and microphone inputs, local files, and "what a phone is playing" received as a Spotify Connect or AirPlay speaker rather than captured. An Android native capture path only if a phone-only rig proves necessary.

### M7 — Scale and resilience

100–300 receivers on one relay with cost per listener-hour; then a second relay or peer-to-peer forwarding, which the frame format already allows.

## 5. Decisions waiting for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Where does the relay for the demo live? It needs a public HTTPS name; later, UDP 443 for WebTransport | A small VM in France reachable on TCP and UDP 443 |
| 2 | Adopt Sendspin's wire format now, or our own frame? | Our own, shaped like Sendspin's, through M4; decide at M5 with measurements of Sendspin over LTE in hand |
| 3 | Is a native shell acceptable for receivers? | Web only until the M2 matrix says where it fails |
| 4 | May Bluetooth speakers sit in the same group as wired outputs for live use? | No: separate zones, each with its own delay |
| 5 | Is rebroadcasting streaming services (Spotify and others) in scope for public shows? | Private and rehearsal use only; it conflicts with the services' terms and needs public-performance licensing |
| 6 | Is a Raspberry Pi in the bag acceptable as the main sender? | Yes: it is the only route to line inputs and other apps' audio that works on every phone |

## 6. Risks

- **iOS changes under us.** WebKit audio behaviour has regressed between releases. Mitigation: the lab page doubles as a regression test before every show.
- **Clock bias on LTE.** Uplink and downlink take different times, which shifts every NTP-style estimate by a few milliseconds per device. Unmeasured; M0 and M3 measure it. Fallback for fixed fleets: a local relay as time anchor.
- **Bluetooth latency moves.** It drifts over a session and resets on reconnect. One calibration is not enough; M4 has to detect and redo it.
- **One sender uplink.** Every listener depends on the sender's LTE uplink. A Pi sender with two paths is the eventual answer.
- **Upkeep.** Browser, two phone platforms, ESP32 and Pi is a lot for a small studio. One engine, one frame format, reuse of existing embedded players where they fit.

## 7. How results are recorded

Each experiment gets a dated note in `docs/results/` with the setup, the raw numbers and the verdict against its pass mark. A decision that follows from a result is added to this plan with its date.
