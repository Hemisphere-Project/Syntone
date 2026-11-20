# 01 — Prior art in-house: FlanerieMozaic's sync, and what an audio-grade version needs

*Research axis 01 · written 2026-11-20 · code reviewed: `Hemisphere-Project/FlanerieMozaic` @ `5b8aa89` (2026-03-11)*

## Question

FlanerieMozaic keeps a wall of phones/tablets playing one video in sync from a web server. How exactly does it do it,
what accuracy can that design give, and which parts can be reused for a system whose job is **audio** — one source heard
on many heterogeneous receivers (phones over Wi-Fi/LTE, Raspberry Pi, ESP32), often through Bluetooth speakers?
What would the audio-grade version look like, and what do the reference libraries (@ircam/sync, soundworks, Timing
Object / timingsrc / MediaSync) actually achieve?

## TL;DR

- **Clock layer: reusable as-is.** FlanerieMozaic uses `@ircam/sync` 2.1.0 (BSD-3): NTP-like ping series over
  Socket.IO, min-travel-time filtering, then a linear regression (offset + frequency ratio) over a ~15 min window, slewed
  so the sync clock stays monotonic. The authors report **1–10 ms per-device accuracy (σ 5 ms) for audio events** on the
  devices they measured (WAC 2016). Local clock is `performance.now()`, which is the right choice.
- **Shared timeline: reusable as a concept, too thin as a model.** Media position = `syncTime − offsetTime` (server
  time at "play"), modulo duration. No lead time before start, no pause state, no per-device latency offset.
- **Media steering: not reusable for audio.** It nudges `HTMLMediaElement.playbackRate` with a **±50 ms dead band**
  and a **minimum step of 10 %** (`rate = 1 ± min(0.3, 2·|diff|)`), re-set on every 20 ms tick, and seeks above 1 s.
  For video that gives roughly **±50 ms per device, i.e. 1–3 frames between screens** (estimate from the code; the repo
  holds no measurements). For audio, 50 ms between two co-located phones is an audible echo, and 10 % rate steps are
  audible either as a ~1.65-semitone pitch jump or as time-stretch artefacts. On iOS each `playbackRate` change causes
  a 40–300 ms hiccup (WebKit bug 163433, open since 2016).
- **The audio-grade version** keeps the clock layer and replaces everything below it: Web Audio only, sync clock mapped
  to the audio device clock with `getOutputTimestamp()`, sample-accurate scheduling (`AudioBufferSourceNode.start(when)`)
  for buffered media, an **AudioWorklet ring buffer with a fractional resampler** (corrections of ≤ 500 ppm, i.e.
  < 1 cent) for streams and drift, and a **per-device, per-route output-latency offset** (reported `outputLatency`
  where it is trustworthy, calibration otherwise, which means always for Bluetooth).
- **Benchmarks to beat:** MediaSync (Arntzen/Borch) reached **≈ 7 ms** on media elements on desktops and high-end phones
  ("echoless" band ±10 ms, ~3 s to converge). A Web Audio engine should do better than 10 ms on wired outputs. Bluetooth
  is a separate problem, dominated by an unknown and varying output latency.
- In-house, **HPlayer2's `Drifter` servo** already holds the lessons FlanerieMozaic lacks (hysteresis dead zone,
  median filter, learned seek latency, position-age correction). Use it as the design reference for the control loop.

## Findings

### F1. How FlanerieMozaic's clock sync works

**Server** (`server.js`): one `SyncServer` with a monotonic clock, `process.hrtime()` seconds since start. For each
Socket.IO connection it answers `ping(pingId, clientPingTime)` with
`pong(pingId, clientPingTime, serverPingTime, serverPongTime)`. Registration is delayed by a random 0–500 ms per socket
to spread the load when many devices connect at once; pings sent in that window time out (1 s) and are retried.

**Client** (`www/libs/ircamsync_client.js`, vendored `SyncClient`; local clock `performance.now()/1000`):

1. **Ping series.** Pings go out every `pingSeriesPeriod` and only the pong of the latest ping is accepted. For each pong:
   `travel = (clientPong − clientPing) − (serverPong − serverPing)`, `offset = mid(server) − mid(client)`.
2. **End of series.** Samples are sorted by travel time. Those within 1.01× the minimum travel time are kept, the
   median is taken, and the offset is the mean of the 3 samples around that median. The series' (client, server) mid
   times go into a long-term circular buffer.
3. **States.** `startup` → `training` (phase offset only, frequency ratio = 1) for `longTermDataTrainingDuration` → `sync`
   (least-squares regression over the long-term buffer: `T = T0 + R·(t − t0)`). If |R − 1| ≥ 500 ppm it re-trains.
4. **Stabilisation.** Each new estimate is slewed in at `estimationStability` (max 500 ppm). For example, a 10 ms
   correction takes ≥ 20 s to apply. The sync clock never jumps and is strictly monotonic.

**Parameters**, FlanerieMozaic vs library defaults (`player_sync.js`):

| Parameter | FlanerieMozaic | Default | Effect |
|---|---|---|---|
| `pingSeriesIterations` | 8 | 10 | pings per series |
| `pingSeriesPeriod` | 0.25 s | 0.25 s | one series ≈ 2 s |
| `pingSeriesDelay` | 2–4 s | 10–20 s | ~4× more series |
| `longTermDataTrainingDuration` | 20 s | 120 s | frequency estimate used 6× sooner (noisier) |
| `estimationStability` | 500e-6 (max) | 160e-6 | fastest slew allowed |
| `longTermDataDuration` | 900 s (default) | 900 s | regression window ≈ 300 series |

The player also declares itself `synced` during training, once two consecutive reports agree within 100 ms and training
has lasted more than 5 s. For video, this gets the wall playing within ~5–10 s. For audio it is too loose: a 100 ms
consistency check accepts a clock error far above the target.

Three smaller points. The Socket.IO server comment says the 5 s heartbeat is "for precision", but Engine.IO heartbeats
play no part in clock sync. `transports: ['websocket']` is commented out, so first contact goes over HTTP long-polling.
Min-travel filtering absorbs that, but it is wasted series. And `@ircam/sync` has had no release since v2.1.0
(2022-10). The code is small and BSD-licensed, so vendoring or forking it is cheap.

### F2. How the shared timeline is derived

On `play`, `playsync`, `playindex` or `resyncall`, the server sets `state.offsetTime = now` (server clock) and broadcasts
the room state. Each client's target position is `getSyncTime() − offsetTime`, wrapped modulo `duration` (looping
media). Sharing one `offsetTime` across rooms gives cross-room sync. Limitations:

- **No lead time.** `offsetTime` is "now", so every device starts late (network + load + decode) and has to seek and
  chase. A scheduled start (`offsetTime = now + 1–2 s`) would let all devices start on the same sample with no correction.
- **No pause state.** `pause` only toggles a flag, the timeline keeps running, and the client handler does not act on it.
  A `{position, velocity, timestamp}` vector (the Timing Object model) handles pause, seek and rate cleanly.
- **No per-device skew.** There is no slot for output latency or calibration. WORK notes list "Timeoffset / device ?
  (optional)" as an open item.

### F3. How the media element is steered (`SyncPlayer.update`, every 20 ms via `setTimeout`)

```
diff = target − video.currentTime                      (seconds)
if |diff| ≥ adaptiveThreshold (1 s, ×1.5 after 3 consecutive seeks, ≤ 5 s)
   and ≥ 2 s since the last seek     → seek: currentTime = target; playbackRate = 1; next tick in 60 ms
elif |diff| < 0.050                  → playbackRate = 1; threshold decays ×0.9 toward 1 s
else                                 → playbackRate = 1 + sign(diff)·min(0.3, 2·|diff|)
```

What this implies:

- **The dead band is the accuracy.** Correction stops as soon as |diff| < 50 ms, so a device parks near ±50 ms. Devices
  that start late (all of them, see F2) arrive from the same side, which hides some of the spread. Devices that
  overshoot a seek can arrive from the other side, so the worst case is ~100 ms between two screens.
- **Bang-bang on rate.** The smallest non-unity rate is 1.10 and it rises to 1.30. The rate is re-assigned whenever the
  computed value changes, i.e. almost every tick while outside the dead band.
- **No measurement hygiene.** `currentTime` is compared with "now" as if it were fresh. MDN notes that its update
  cadence depends on the browser and pipeline. HPlayer2 measured a +20–40 ms bias from the same mistake with mpv.
  There is no smoothing (MediaSync averages 3 samples, HPlayer2 takes a median of 5), and no seek-latency compensation
  (MediaSync overshoots and learns, HPlayer2 learns an EMA of seek cost).
- **Background:** a 20 ms `setTimeout` loop is throttled to 1 Hz in a hidden Chrome tab unless the page has been audible
  within the last 30 s. That is fine for a lit video wall and fragile for a phone in a pocket.
- **Media encoding:** H.264 baseline, `bframes=0`, no explicit GOP (x264 default keyint 250 ≈ 10 s at 25 fps), so an
  accurate seek on a weak phone decodes up to ~10 s of frames. Downloads are queued one at a time to stay within
  HTTP/1.1 connection limits.

**Accuracy for video.** Clock error is a few ms. Steering residual is ±50 ms per device, plus staleness bias, plus
seek-overshoot transients. I estimate **20–60 ms typical and ~100 ms worst case between screens, i.e. 1–3 frames at
25 fps**. The repository holds no measurements and the field accuracy is unverified. That is adequate for a mosaic of
separate screens, and visible on fast motion that crosses a bezel.

The vendored `timingsrc-v3.js`, `timingprovider.js` and `mediasync.js` are **vestigial**: only a commented-out block in
`mapping.js` references them. For contrast, MediaSync (Borch, 2015) does what SyncPlayer omits:
- 3-sample averaging, driven by `timeupdate`.
- Graded gain bands: > 1 s jump; 0.5–1 s ±0.5; 0.1–0.5 s ±0.4; 25–100 ms ±0.3 at gain 0.6; and below 25 ms a fine
  trim at gain 0.07, capped at **±2 %**.
- Thrash detection, and seek overshoot learned from measured seek cost.
- Optional automute outside 0.95–1.05.
- **Skip-only mode forced on Safari**, because variable playback rate was unreliable there.

### F4. Published accuracy of the reference stacks

| Stack | Reported accuracy | Conditions / source |
|---|---|---|
| `@ircam/sync` (and soundworks `plugin-sync`, a wrapper around it) | 1–10 ms individual, σ 5 ms, for audio events; "more accurate than the audio block duration" | WAC 2016 abstract. The stabilisation was added after the paper |
| Timing Object / Shared Motion (InMotion service) | 0–1 ms on desktop browsers vs an NTP-synced clock; "a few ms" on all major browsers incl. Android; degrades gracefully on EDGE | Arntzen, Borch, Daoust, *Media Synchronization on the Web* (MediaSync handbook chapter) |
| MediaSync on HTMLMediaElement | ≈ 7 ms for audio and video on desktops, laptops and high-end phones ("echoless"); frame-accurate (±25 ms) on lesser devices; ~3 s to reach echoless | same chapter, §9.2. Figure 8 uses Chrome on Android with a ±10 ms echoless band |
| HPlayer2 wallclock + `Drifter` (in-house, Raspberry Pi, mpv) | dead zone entered at 25 ms, left at 80 ms; Wi-Fi delivery jitter ±30 ms on raw diffs; Pi crystals drift ~0.1 s/hour (≈ 28 ppm) | `core/engine/drifter.py`, `core/interfaces/wallclock.py` comments |

The chapter also says what no library fixes: **synchronization errors in online sync are dominated by media element
behaviour**, and "a lack of standardization and common tests makes it impossible to provide any guarantees". The
soundworks README states the open problem plainly: scheduling on a synced clock "will not compensate for the audio
output latency of each client (which may differ to a great extent)".

### F5. What is and is not reusable for an audio-only system

**Reusable as-is**
- `SyncServer`/`SyncClient` and their ping-pong over a socket. Tune the parameters: a 60 s training window and
  160e-6 stability as a starting point, plus a stricter "usable" test.
- `performance.now()` as the local clock. It keeps running while an `AudioContext` is suspended. `audioContext.currentTime`
  advances in 128-frame steps (2.67 ms at 48 kHz) and reads 0 until `resume()`.
- The room = channel model (the "FM frequency"), QR join, control page, device registry, wake-lock/NoSleep helpers,
  nginx range-request media serving.

**Not reusable for audio**
- `HTMLMediaElement` steering. `playbackRate` changes pitch (`preservesPitch=false`; +10 % ≈ +1.65 semitones) or
  engages time-stretching (default `preservesPitch=true`; Chrome 86, Firefox 101, Safari 17.2), with audible artefacts
  at these step sizes. Gecko mutes outside 0.25–4.0. On iOS, each rate change produces a 40–60 ms gap measured on
  AVPlayer and 200–300 ms freezes reported on iOS 15–17. WebKit bug 163433 has been open since 2016; its last comment
  is from June 2025.
- `currentTime` as the measured position: coarse, browser-dependent update cadence, and blind to output latency.
- No output-latency handling, no drift model of the audio device clock, and no live-stream path.

**Mobile constraints known in-house.** FlanerieAudioMap (audio walk, public repo) documents these in field audits:
- An iOS Bluetooth A2DP→HFP route flip dropped narration.
- Android WebView suspended JS in the background, fixed with an in-renderer `AudioContext` keepalive.
- Android AudioTrack pool exhaustion.
- iOS audio moved to a native plugin.
- WebKit reports that an `AudioContext` is suspended in the background even with `navigator.audioSession.type =
  'playback'` (Safari 16.4+). That setting is still needed so Web Audio is not muted by the ringer switch.

### F6. What the audio-grade version looks like (platform facts, verified against MDN BCD and the specs)

- **Clock mapping.**
  - Sync time → `performance.now()` via `SyncClient.getLocalTime()`.
  - `performance.now()` → audio context time via pairs from `AudioContext.getOutputTimestamp()` (Chrome 57, Firefox 70,
    Safari 14.1). By spec, `contextTime` is the frame "currently being rendered by the audio output device", so it
    should already lag `currentTime` by the output path.
  - Fit these pairs over time to get the **audio-clock vs system-clock ratio**, i.e. the DAC drift (tens of ppm; ≈ 28 ppm
    between two Pis in-house).
- **Latency.** `AudioContext.outputLatency` exists in Chrome 102, Firefox 70 and Safari 18.4. For headphones the spec
  defines it up to "when a sample's sound is produced". Measurements disagree with it: Firefox returned "implausibly low"
  values (< ½ of measured end-to-end), and Bluetooth headsets are "notorious for reporting much lower latencies than they
  actually implement". Treat it as a hint and add a calibrated per-route offset.
- **Buffered playback (axis A).** Decode in 2–10 s segments (`decodeAudioData`, or WebCodecs `AudioDecoder`: Chrome 94,
  Firefox 130, Safari 26) and schedule each `AudioBufferSourceNode.start(when, offset)` sample-accurately on the mapped
  clock. Correct drift at segment seams with a short crossfade. This is simple, needs no SharedArrayBuffer, and works on
  iOS 14.1+.
- **Live / streamed playback (axis B).**
  - An `AudioWorklet` (Chrome 66, Firefox 76, Safari 14.1) pulls PCM from a ring buffer, each block stamped with its
    position on the sync timeline.
  - It reads with a fractional pointer at ratio *r*, set by a PI loop on `error = (timeline position of the frame now
    reaching the DAC) − (syncNow − playoutDelay)`.
  - Cap *r* at ±500 ppm (0.87 cent, inaudible; it corrects 0.5 ms/s). Above ~100 ms, jump with a 5–10 ms crossfade.
  - SharedArrayBuffer needs cross-origin isolation (COOP/COEP headers). Without it, use `MessagePort`.
- **Instrumentation.** `AudioContext.playbackStats` (Chrome 146+: underrun events/duration, min/avg/max latency) for fleet
  telemetry. `renderSizeHint` (Chrome 153+) for smaller render quanta on Chrome.
- **Transport for pings.** Fully supported options now include raw WebSocket, an `RTCDataChannel` (unordered,
  `maxRetransmits: 0`), or WebTransport datagrams (now also Safari 26.4). The last two avoid TCP head-of-line stalls on
  lossy LTE.
- **Video, if ever needed again.** `requestVideoFrameCallback` (Chrome 83, Safari 15.4, Firefox 132) gives presented-frame
  `mediaTime`, which is a better measured position than `currentTime`.

### F7. Other Hemisphere-Project repositories touching this

| Repo | What it is | Relevance |
|---|---|---|
| AudioTxRx (2020, public) | Pi + USB card → `ffmpeg` Opus 256 kb/s in Ogg → Icecast; receivers `mpv --profile=low-latency` | The "internet radio" baseline: buffered, no sync |
| RadioModule (2021) | ESP32 (M5 Atom) + TEA5767 FM receiver chip | The FM reference this project replaces |
| Audio5 (2022) | M5Stack + PCM5102 I2S DAC + LoRaWAN, ESP32 web radio | ESP32 audio output path |
| HSync (2019) | README only ("Zyre + FileMQ") | none |
| HPlayer2 (active) | Zyre NTP-like clock shift (keeps 0.1–30 % lowest-RTT samples, weighted) + 20 Hz UDP wallclock + `Drifter` speed servo | **Best in-house control-loop reference** (see F4) |
| ESPNowMeshClock / Nowde (2025–26) | 64-bit µs mesh clock over ESP-NOW, slewed; Nowde regenerates MTC "within a few milliseconds" | ESP32 receivers; not IP-based |
| HPlayer0 (2026) | ESP32-S3 looping audio player, resampled to 48 kHz | Candidate ESP32 receiver base |
| FlanerieAudioMap (2026) | GPS audio-walk web/Cordova app | Field knowledge of mobile audio (F5) |

One further repository is private and was not reviewed for this public report.

## Options compared

| Option | Expected inter-device error (wired) | Audio quality during correction | iOS web | Effort (1–2 people) | Verdict |
|---|---|---|---|---|---|
| A. FlanerieMozaic SyncPlayer as-is on `<audio>` | ±50 ms per device, ~100 ms worst (estimate) | 10–30 % rate steps: pitch jumps or stretch artefacts | rate-change hiccups 40–300 ms | none | **Rule out** for audio |
| B. MediaSync / timingsrc on `<audio>` | ≈ 7 ms reported (Chrome-class) | ≤ 2 % trims; artefacts noted by its authors | forced skip-only mode | low (LGPL-3.0, last push 2025-01) | Useful benchmark only |
| C. @ircam/sync + Web Audio, chunked `start(when)` | < 10 ms target (1–10 ms clock + ~1 ms scheduling) | none (crossfade at seams) | works (14.1+); background is fragile | low–medium | **Build first** (axis A) |
| D. @ircam/sync + AudioWorklet ring buffer + resampler | < 10 ms target, live-capable | inaudible (≤ 500 ppm) | works; WebCodecs needs Safari 26 | medium | **Build second** (axis B, long-running A) |
| E. soundworks framework (plugin-sync + platform-init + state manager) | same as C/D (same sync core) | same as C/D | same | medium; framework lock-in | Option if the shared-state layer is wanted |
| F. timing-provider (WebRTC P2P timing object) | unknown | n/a | unknown | low, but needs a third-party signalling client ID | Rule out as a dependency |

## Recommendation

1. **Keep the clock, change the transport.** Reuse `@ircam/sync` (vendor it). Use `performance.now()` locally. Move
   ping-pong off Socket.IO polling to a raw WebSocket now, and test WebRTC DataChannel / WebTransport datagrams for LTE.
   Start from defaults that are tighter than FlanerieMozaic's (training ~60 s, stability 160e-6), but let playback start
   after 2–3 consistent series (< 2 ms spread) rather than the 100 ms test.
2. **Replace the timeline model** with a vector `{position, velocity, timestamp_sync}` (the Timing Object model, or an
   MIT `timing-object` implementation over our own provider). Every start is scheduled at `now + lead` (1–2 s for
   buffered media) and every device has a `skew` slot (output latency + calibration).
3. **Web Audio only on receivers.** Build option C first: it delivers axis A on phones, Pi (Chromium) and laptops within
   weeks. Then build option D: one AudioWorklet engine that serves live input (axis B) and long sessions (drift),
   fed by WebCodecs Opus where available.
4. **Port HPlayer2's control-loop lessons, not FlanerieMozaic's:** hysteresis dead zone, median-of-N on measured error,
   position-age correction, learned jump cost. Correct in the resampler, never with `playbackRate`.
5. **Make latency explicit.** Use `outputLatency` as a hint and store per-device × per-route calibration. Bluetooth always
   needs calibration (axis C, phase 2).
6. **Instrument from day 1:** each receiver reports clock offset, travel time, measured playout error p50/p95, underruns
   (`playbackStats` where available) and route changes to the control page, like HPlayer2's drift CSV.
7. **Plan for a native shell on iOS** if receivers must play with the screen locked. Run E7 below before committing.

## Proposed experiments

| # | Goal | Method | Pass / fail metric |
|---|---|---|---|
| E1 | Clock accuracy, Wi-Fi vs LTE | 6+ devices (iOS + Android, Wi-Fi and LTE) run SyncClient with FlanerieMozaic params vs tuned params. Each plays a 1 ms click at every integer sync second through Web Audio, on wired output. One reference mic equidistant; cross-correlate | pass: p95 inter-device < 5 ms (Wi-Fi), < 10 ms (LTE) after 60 s; report bias per network type |
| E2 | Baseline: FlanerieMozaic on audio | Serve a click track through unmodified SyncPlayer to the same devices for 10 min; log rate changes and seeks; record | expected fail: documents spread (ms) and audible artefacts per platform |
| E3 | Option C engine | Chunked `AudioBufferSourceNode` + `getOutputTimestamp` mapping, 30 min session | pass: p95 inter-device < 10 ms wired, no drift growth over 30 min, 0 audible seams |
| E4 | Output-latency truth table | Per device × route (speaker, jack, 3+ BT models), compare `outputLatency`, `baseLatency`, `getOutputTimestamp` lag vs acoustically measured latency | pass: wired error < 5 ms → use the reported value; BT error distribution feeds the calibration design |
| E5 | Resampling audibility and authority | AudioWorklet with ratio offsets 100 / 500 / 1000 / 3000 ppm on music and speech; ABX with 3+ listeners | pass: 500 ppm not detected (≥ 70 % ABX failure to discriminate) |
| E6 | Ping transport on LTE | Same devices: Socket.IO (polling-first) vs WebSocket vs DataChannel unordered vs WebTransport datagrams; 30 min each | pick the transport with the lowest offset σ and fewest > 20 ms outliers |
| E7 | iOS background survival | Locked screen, `audioSession.type='playback'`, Web Audio playing, 30 min, with and without a playing `<audio>` element | pass: no suspension. Fail ⇒ native shell required for pocket use |

## Open questions

- **Accuracy target (owner decision):** "echoless" (≤ 10 ms, co-located speakers) or "lip-sync" (≤ 40 ms, each listener on
  their own headphones)? This sets whether Bluetooth calibration is critical or a refinement.
- **Licence (owner decision):** FlanerieMozaic is GPL-3.0; `@ircam/sync` and soundworks are BSD-3; timingsrc is LGPL-3.0.
  Copying FlanerieMozaic code makes the new repo GPL-3.0 compatible; a permissive licence means reusing only the BSD parts.
- **Framework (owner decision):** build on soundworks (maintained, v5, state manager + sync) or keep a minimal custom
  stack like FlanerieMozaic?
- Does `getOutputTimestamp().contextTime` include the hardware/Bluetooth path on each engine, or only the OS buffer? E4
  answers this.
- How large is the NTP asymmetry bias on LTE (uplink scheduling vs downlink)? It cannot be filtered out; E1 measures it.
- Was FlanerieMozaic's field sync ever measured? No numbers exist in the repository.

## Sources

- FlanerieMozaic: https://github.com/Hemisphere-Project/FlanerieMozaic (`server.js`, `www/js/player_sync.js`, `www/js/player.js`, `www/libs/*`, `MediaManager.js`, `WORK`)
- @ircam/sync: https://github.com/ircam-ismm/sync · https://www.npmjs.com/package/@ircam/sync
- Lambert, Robaszkiewicz, Schnell, *Synchronisation for Distributed Audio Rendering over Heterogeneous Devices, in HTML5*, WAC 2016: https://hal.archives-ouvertes.fr/hal-01304889v1 · https://repository.gatech.edu/entities/publication/1f9d9d03-57b1-438d-a7b2-6a4f7c468119
- soundworks plugin-sync: https://github.com/collective-soundworks/soundworks-plugin-sync · soundworks: https://github.com/collective-soundworks/soundworks · sc-scheduling: https://github.com/ircam-ismm/sc-scheduling
- Arntzen, Borch, Daoust, *Media Synchronization on the Web*: https://cdn.jsdelivr.net/npm/webtiming-timingsrc@3.0.0/chapter/submit/arntzen_mediasync.pdf
- timingsrc / MediaSync: https://github.com/webtiming/timingsrc · https://webtiming.github.io/timingsrc/doc/background_mediasync.html · Timing Object: https://webtiming.github.io/timingobject/
- timing-object / timing-provider: https://github.com/chrisguttandin/timing-object · https://github.com/chrisguttandin/timing-provider
- WebKit bug 163433 (playbackRate pause): https://bugs.webkit.org/show_bug.cgi?id=163433 · WebKit bug 237322 (Web Audio muted by ringer): https://bugs.webkit.org/show_bug.cgi?id=237322
- Audio Session API: https://w3c.github.io/audio-session/
- Web Audio API (Editor's Draft, getOutputTimestamp, outputLatency, AudioPlaybackStats, renderSizeHint): https://webaudio.github.io/web-audio-api/ · source https://github.com/WebAudio/web-audio-api
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime · …/HTMLMediaElement/playbackRate · …/HTMLMediaElement/preservesPitch · …/BaseAudioContext/currentTime · …/AudioContext/outputLatency · …/AudioContext/getOutputTimestamp · …/Performance/now
- MDN browser-compat-data (support versions quoted): https://github.com/mdn/browser-compat-data
- Chrome timer throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- web.dev, audio output latency: https://web.dev/articles/audio-output-latency
- J. Kaufman, *Browser Audio Latency*: https://www.jefftk.com/p/browser-audio-latency
- HPlayer2 (Drifter, wallclock, zyre): https://github.com/Hemisphere-Project/HPlayer2
- ESPNowMeshClock: https://github.com/Hemisphere-Project/ESPNowMeshClock · Nowde: https://github.com/Hemisphere-Project/Nowde · HPlayer0: https://github.com/Hemisphere-Project/HPlayer0
- FlanerieAudioMap (mobile-audit.md): https://github.com/Hemisphere-Project/FlanerieAudioMap
- AudioTxRx: https://github.com/Hemisphere-Project/AudioTxRx · RadioModule: https://github.com/Hemisphere-Project/RadioModule · Audio5: https://github.com/Hemisphere-Project/Audio5 · HSync: https://github.com/Hemisphere-Project/HSync

*Unverified (from memory or estimated): the 20–60 ms / ~100 ms FlanerieMozaic video spread (derived from code, not
measured); the `timeupdate` cadence (HTML spec suggests 15–250 ms); the Chrome/Firefox/Safari time-stretch algorithms
behind `preservesPitch`; LTE uplink/downlink asymmetry magnitudes; typical phone audio-crystal tolerance (tens of ppm);
whether each browser's `getOutputTimestamp` includes the hardware/Bluetooth path.*
