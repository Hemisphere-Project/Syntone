# 02 — Clock sync and synchronised playout

*Research axis report. Status: desk research, 2026-11-20. Nothing here has been measured by the project yet. Numbers come from the cited sources. Where a claim could not be checked against a primary source it is marked **(unverified)**.*

## Question

How do you get N different devices (phones running a web app or native app, Raspberry Pi, ESP32) on WiFi and LTE to play **the same audio sample at the same wall-clock instant**? How good can that get per device class and per network, and how good does it need to be?

## TL;DR

- **The problem has three error terms that add up**: (1) the error in **network clock sync**, (2) the error in **mapping that clock to the audio device's sample clock**, plus the drift between the two, and (3) the **output-path latency**: DAC, OS mixer, and above all Bluetooth. On good WiFi, (1) can reach the sub-millisecond range. (3) is the biggest unknown for phones, especially on Bluetooth, and the browser's `outputLatency` value cannot be trusted there.
- **Proposed target ladder**: **Bronze ≤ 40 ms** (separate listeners and headphones), **Silver ≤ 10 ms** (co-located phones or speakers in a crowd), **Gold ≤ 2 ms** (fixed speaker clusters in an installation). Anything below about 0.1 ms is line-array territory (AES67/Milan, wired PTP) and out of scope.
- **Physics caps the benefit**: sound travels about **2.9 ms per metre**. With phones spread across a room, listeners already hear several ms of acoustic offset, so Silver is "as good as it gets" for a crowd of handhelds. Gold only matters for fixed speakers.
- **Realistic tiers**: Snapcast-class native clients (Pi, ESP32) on WiFi or Ethernet reach Gold (Snapcast states typically < 0.2 ms). A browser **AudioWorklet** playout engine synced on the audio clock should reach Silver, and possibly Gold on good devices **(to be proven)**. The current FlanerieMozaic media-element loop is Bronze by design: it has a 50 ms deadband. Any Bluetooth output is Bronze unless calibrated acoustically. LTE adds an asymmetric-delay bias, which I estimate at a few ms (unverified), so LTE caps at Silver.
- **Recommendation**: build one playout engine in an AudioWorklet. It keeps a ring buffer of server-timestamped audio, runs a fractional resampler steered by a PI controller (±500 ppm, inaudible), hard-resyncs on large errors, and applies a per-device calibrated latency term. Clock sync should use @ircam/sync-style regression plus burst and coded-pair probes, over WebTransport datagrams with a WebSocket fallback. Use Snapcast's design and clients as the reference and for Pi/ESP32. **Build acoustic calibration early**: it is the only route to Silver on Bluetooth, and it also absorbs LTE bias.
- **Rule out**: media-element `playbackRate` for audio-grade sync, PTP in the browser or phone, and relying on WebRTC's built-in jitter buffer (NetEq) for cross-receiver alignment.

## Findings

### 1. How tight is tight enough (perception and physics)

- **Comb filtering.** Two equal copies offset by Δt cancel at f = (2k+1)/(2Δt). At 1 ms the first notch is at 500 Hz, at 0.1 ms it is at 5 kHz. Comb filtering never disappears for a listener who is not equidistant from two sources, so sub-ms electronic sync only helps on fixed axes (stereo pairs, clusters). This follows from the formula; no source needed.
- **Precedence / echo threshold.** Lead-lag fusion holds up to about **1–5 ms for clicks** and about **30–50 ms for speech and music** before a distinct echo is heard. The value depends on stimulus and criterion (Litovsky et al. review; Litovsky 2001 JASA).
- **Acoustic path.** c ≈ 343 m/s, so **2.9 ms per metre**. Devices 3 m apart give a listener up to about 9 ms of offset however good the electronics are.
- **Audio vs picture** (for audio walks with visual cues or video): ITU-R BT.1359 puts detectability at **+45 ms / −125 ms** (sound early / late) and acceptability at **+90 / −185 ms**.
- **Pro audio for comparison.** L-Acoustics (AES 160th, 2026) reports AES67 at **< 4.5 µs** and Milan-AVB at **< 0.1 µs** at the 6th hop under heavy traffic, and Dante timing variations **> 100 µs under load**. That range is for line arrays, not for this project.

**Proposed ladder**

| Tier | Inter-device error (p95) | Use case | Why this bound |
|---|---|---|---|
| Bronze | ≤ 40 ms | separate listeners on headphones, a "shared moment" | below the speech/music echo threshold (30–50 ms), inside lip-sync detectability |
| Silver | ≤ 10 ms | co-located phones or BT speakers in a crowd | same order as acoustic path spread (3.4 m); no distinct echo |
| Gold | ≤ 2 ms | fixed speaker pairs or clusters in an installation | inside click precedence window; about 70 cm of acoustic path |
| (Platinum) | ≤ 0.1 ms | line arrays | AES67/Milan with wired PTP: out of scope |

### 2. Network clock sync: transports and realistic accuracy

**Algorithms.**
- *Cristian* (offset = server time − RTT/2) and the *NTP four-timestamp* exchange both assume **symmetric paths**. The bias per sample is (d_up − d_down)/2, bounded by RTT/2. The four-timestamp form also removes the server's processing time, which matters with a Node.js event loop.
- *Min-RTT selection* keeps only the fastest exchanges, since queueing only ever adds delay (RFC 5905 logic, as quoted in beatsync's code).
- *@ircam/sync* (BSD-3-Clause, v2.1.0, last published 2022-10) sends ping series (default 10 pings, 250 ms apart, a series every 10–20 s). Per series it keeps the min-travel-time samples and takes the median offset. It then runs a **linear regression of server time against local time** over a long window (default 900 s, 120 s training) to estimate offset **and frequency ratio (skew)**. FlanerieMozaic shortens this to series every 2–4 s, 20 s training and `estimationStability` 500e-6.
- *Snapcast* keeps the **median of the last 200** offset samples. snapweb, its browser client, keeps the median of the last 100.
- *Huygens* (NSDI 2018) introduced **coded probes**: two probes sent with a known gap, kept only if they arrive with the same gap. It also uses SVM and a network-wide transitivity correction, reaching tens of ns in data centres, but it **assumes symmetric paths**. beatsync uses the coded-pair idea in the browser: 25 ms gap, ±5 ms tolerance, then min-RTT.
- **Kalman or lower-envelope skew estimation** are the natural upgrade over plain regression when temperature makes the skew wander. Phone crystals shift by several ppm within minutes of warm-up (Paderborn ICASSP'22).

**Measured accuracy.**
- *Phones, WiFi, native code*: Google's libsoftwaresync synchronised Android phones to **< 250 µs** over WiFi on commodity hardware (Ansari et al.).
- *Phones, WiFi, browser*: the IRCAM paper (Lambert, Robaszkiewicz, Schnell, WAC 2016) reports audio events rendered with **1–10 ms individual accuracy, 5 ms standard deviation** across heterogeneous devices. That figure includes output-latency spread, not only clock error.
- A 2025 smartphone-sensor study reports NTP errors of **a few ms** over WiFi (arXiv 2501.04886, abstract-level reading).
- *Browser timer floor*: `performance.now()` is coarsened to **100 µs**, or **5 µs** when cross-origin isolated. That is not the bottleneck. On non-Windows systems it does **not tick during sleep**, so the clock model must be reset after the device sleeps (MDN).

**LTE specifics.**
- Uplink access needs a scheduling request and a grant: a Rel-8 breakdown lists about 1+3+1+3+1+3 ms of SR, grant and decode steps, and 8 ms UL HARQ RTT (arXiv 1808.07034). DRX power saving adds wake-up delay.
- Measured median **LTE uplink latency was 42 ms** for four apps on four US carriers. It fell to **5 ms** when small dummy packets were sent just before the data so the radio was already scheduled (LDRP, IEEE TMC).
- **Consequence**: uplink and downlink are structurally asymmetric on LTE, which biases every NTP-style offset. Min-RTT filtering bounds the bias but does not remove it. **Estimate (unverified): a residual bias of roughly 1–8 ms per device.** It changes with cell, operator and handover. Two receivers on the same cell share part of it, so part of it cancels.
- Mitigations:
  - **burst probing**: back-to-back probes, so the later ones ride an already-granted radio (the LDRP insight);
  - **acoustic calibration**, which measures the end result directly;
  - **GNSS time**, which skips the network entirely. Android has `SystemClock.currentGnssTimeClock()` since API 29 and `GnssClock` raw measurements since API 24. Its achievable accuracy on phones is **unverified**. Pi or ESP32 with a GPS PPS input reach µs-level (from general knowledge, unverified here).
- **CGNAT** blocks only peer-to-peer. A client-to-server design with a public server works over WebSocket, WebTransport, and WebRTC with the server as a peer. Peer-to-peer WebRTC through CGNAT needs TURN.
- **The sender's clock error is common-mode.** If the sender stamps capture time in server time wrongly, every receiver shifts by the same amount. That changes end-to-end latency, not inter-device sync. Only receiver-side error matters for sync.

**Transports for sync probes** (all are client↔server):
- **WebSocket** (TCP): universal. Suffers head-of-line blocking and retransmission stalls on lossy LTE, which min-RTT filtering mostly discards.
- **WebRTC DataChannel** with `ordered:false, maxRetransmits:0`: no head-of-line blocking, but needs an SCTP/DTLS/ICE stack on the server.
- **WebTransport datagrams**: no head-of-line blocking, simpler server (HTTP/3). **Now in all major engines: Safari added it in 26.4 (March 2026, WebKit release notes).** Chrome and Firefox have had it since 2022/2023 (secondary sources). Needs a fallback where UDP is blocked.
- **NTP/SNTP or PTP**: native code only. PTP in GStreamer reaches **2–20 µs on wired LAN** and is "not that accurate" over WiFi (Dröge, 2015). AirPlay 2 uses a partial IEEE 1588 implementation (nqptp: ports 319/320, no hardware timestamping).

### 3. The audio clock problem

**Drift magnitudes (ppm).**
- Smartphones: measured sampling-rate offsets of **−40 to +416 ppm** (same vendor varies less), and **−500 to +400 ppm** for handheld devices. Several ppm of temperature change within minutes (LibriWASN; Paderborn ICASSP'22).
- Consumer sound cards: **50–100 ppm** (baudline survey).
- ESP32: the crystal must be **±10 ppm** (Espressif schematic checklist). The I2S clock is derived from it via the APLL.
- Raspberry Pi with a USB interface: the interface runs on its own crystal, so expect tens of ppm against the Pi's system clock (unverified, no Pi-specific measurement found).
- Roon staff give **100 ppm → about 60 ms over a 10-minute song**, and logged a WiFi speaker at −25.9 ppm next to an endpoint at −1.9 ppm.
- **Rule of thumb: 50 ppm = 3 ms/min.** Without continuous correction, Gold is lost within a minute and Silver within a few minutes.

**Browser clocks and how much to trust them (2026).**

| API | What it gives | Support | Trust |
|---|---|---|---|
| `AudioContext.currentTime` | context time, advances by render quantum (128 frames ≈ 2.7 ms at 48 kHz); runs on the **audio device clock** | all | Exact for the sample count. It drifts against `performance.now()` |
| `getOutputTimestamp()` | `{contextTime, performanceTime}` pair: which sample is at the output, and when in `performance.now()` time | Chrome 57, Firefox 70, Safari 14.1 / iOS 14.5 | The right primitive for mapping. WebKit returned `contextTime` divided by the sample rate until a fix in Feb 2024 (bug 264247), so older Safari is unsafe. Whether `performanceTime` includes the hardware or BT latency **differs by engine (unverified)**. Measure it (E2) |
| `outputLatency` | estimated output latency (s) | Chrome 102, Firefox 70, **Safari 18.4** (Baseline since March 2025) | **Unreliable for Bluetooth.** Chromium discussion described it as the platform callback buffer (macOS 128 frames, Windows 10 ms, Android 96 frames). beatsync ignores any value > 100 ms after seeing 648 ms on BT and uses a manual nudge. iOS developers report AirPods `outputLatency` ≈ 160 ms against about 180 ms measured, and drift of 193 → 260 ms within a minute (forum reports) |
| `baseLatency` | processing latency of the context | widely supported | small, informational |
| `AudioContext.playbackStats` | avg/min/max latency, underrun count and duration, updated once per second | Chromium intent to ship approved Feb 2026; **stable-channel status unverified**; not in other engines | Good for monitoring underruns. 1 Hz is too coarse to steer with |

**Native platforms.**
- Android's compatibility definition **strongly recommends** that `AudioTrack.getTimestamp` / `AAudioStream_getTimestamp` be accurate to **±1 ms** (CDD 9, C-SR), with continuous output latency ≤ 45 ms. The A2DP HAL builds its presentation position from a latency estimate reported by the remote headset, so on Bluetooth the result is only as good as that report.
- iOS `AVAudioSession.outputLatency` is an estimate; see the forum reports above.

**Mapping strategy.**
- snapweb runs its sync protocol **directly on the audio clock** (`getOutputTimestamp().contextTime`) instead of on `performance.now()`. That removes the system-clock to audio-clock drift term entirely. The cost is quantisation to the callback period, which can be avoided by interpolating with the `performanceTime` half of the pair.
- IRCAM's README gives the same advice: "convert to local time at the last moment".

### 4. Drift correction methods and their audibility

| Method | Used by | Range | Audibility |
|---|---|---|---|
| Single-sample drop/insert | Snapcast (soft correction starts at 100 µs error, up to **500 ppm**); ESP32 snapclient ("a single sample every chunk_ms") | ≤ 500 ppm | Used in production. A single-sample discontinuity is generally masked in music; pure tones may tick (unverified) |
| Fractional resampling | Shairport Sync ("resample sequences of audio frames", libsoxr when the CPU allows) | ± hundreds of ppm | 500 ppm ≈ **0.87 cent** pitch shift (1 cent ≈ 578 ppm), well under a ~5-cent pitch JND (JND from general knowledge, unverified). Cheap enough in an AudioWorklet (cubic or polyphase) |
| Media element `playbackRate` | FlanerieMozaic: rate = 1 ± min(0.3, 2·|Δ|) above a 50 ms deadband, seek above 1 s | huge | With default `preservesPitch=true`, Chromium switches to **WSOLA for any rate ≠ 1.0**, which risks artifacts near 1.00 (Chromium source; blink-dev). `preservesPitch=false` gives plain resampling. ±30 % is fine for video and wrong for audio. `currentTime` is not tied to the output sample clock |
| Time-stretch (WSOLA, phase vocoder) | catch-up after underrun | > 1 % | audible phasiness; reserve for exceptions |
| Hard resync | Snapcast: if the long median exceeds 2 ms, the short median 5 ms, or the mini median 50 ms; snapweb: if \|age\| > 5 ms, fast-forward or insert silence | step | a click unless crossfaded over 5–10 ms |

### 5. How existing systems do it

| System | Clock sync | Playout and drift | Published accuracy | Notes |
|---|---|---|---|---|
| **Snapcast** (GPL-3.0, v0.35.0, March 2026) | TCP ping, median of 200 | timestamped chunks, drop/insert ≤ 500 ppm, hard sync | "typically below **0.2 ms**" | Clients: Linux/ALSA (80 ms buffer default), Android (Oboe), macOS, Windows, **ESP32** (FLAC/Opus/PCM, up to 758 ms buffer), **snapweb** browser client |
| **AirPlay 2 / Shairport Sync** | PTP-like (nqptp) | resampling | "usually to within a **fraction of a millisecond**" | 0.5 s latency on AirPlay 2, 2.0–2.25 s on classic AirPlay; Apple-only sender |
| **Sonos** | group coordinator clock plus per-member offset and rate (patents) | timestamped tasks | none published | |
| **Chromecast groups** | undisclosed | — | none; manual "group delay correction", typical inherent delay 0–40 ms (speakers) and 0–80 ms (soundbars) | the per-device latency term is exposed to the user |
| **Roon RAAT** | packets every few seconds, chosen clock master | models the DAC clock | none; staff: drift problems usually come from WiFi or switch issues | |
| **LMS / squeezelite** | server-driven | adjustments of at most 5 ms each | none | |
| **AES67 / Dante / Milan** | PTPv2 / PTPv1 / gPTP, wired | media clock locked | µs (above) | not reachable from phones or browsers |
| **GStreamer netclock / RFC 7273** | NTP/PTP/netclock signalled in SDP | `rtpjitterbuffer` syncs to the signalled clock | PTP 2–20 µs wired | good fit for the Pi |
| **IRCAM sync / soundworks** | WebSocket ping, regression | Web Audio scheduling | 1–10 ms (SD 5 ms), 2016 | base of FlanerieMozaic |
| **beatsync** (MIT, about 3.2k stars) | WebSocket NTP plus coded pairs, min-RTT | `AudioBufferSourceNode.start(when)`, minus `outputLatency` if < 100 ms, manual nudge | claims "millisecond-accurate", no measurement published | I found no continuous drift correction in its client store |
| **AmpMe / SoundSeeder / Spotify Jam** | proprietary | — | none | AmpMe used the phone mic and ultrasonic signals to detect latency (press). Jam is a shared listening session; I found no sync-accuracy claim (unverified) |

## Options compared (for this project)

| Option | WiFi tier | LTE tier | BT output | Platforms | Effort / upkeep | Verdict |
|---|---|---|---|---|---|---|
| A. FlanerieMozaic media-element loop (as is) | Bronze (50 ms deadband) | Bronze | Bronze | all browsers | exists | baseline only |
| B. Scheduled Web Audio buffers (beatsync style) | Silver at start, decays about 3 ms/min at 50 ppm | Silver− | Bronze | all browsers; files only | low | not for live, no drift correction |
| C. **AudioWorklet playout engine** (Snapcast logic in the browser) | **Silver, Gold candidate** | Silver (bias-limited) | Silver with acoustic calibration | all current browsers | medium, one codebase | **build this** |
| D. WebRTC native playout (NetEq) plus `jitterBufferTarget` (Baseline since Sept 2026, 0–4000 ms hint) and `estimatedPlayoutTimestamp` nudging | Bronze (estimate) | Bronze | Bronze | all | low | only for "radio-like" Bronze |
| E. Native apps (Oboe/AAudio, AVAudioEngine) running C's engine | Gold plausible | Silver | Silver with calibration | iOS and Android | high, two stores | phase 2, only if C stalls |
| F. Snapcast clients on Pi and ESP32 | Gold | Silver (estimate) | n/a (wired or I2S) | Linux, ESP32 | low (reuse) | **use for fixed nodes** |
| G. PTP / AES67 | µs, wired only | — | — | wired Linux | high | rule out (except a wired backbone) |
| H. GNSS-disciplined time | — | removes LTE bias | — | Android (API 29+), Pi or ESP32 with GPS | medium | experiment for outdoor walks |

## Recommendation

1. **One playout model everywhere.** The server stamps every audio chunk with a server-time presentation instant: `T_present = T_capture + D`, where D is a global playout delay. Each receiver emits sample n at `T_present(n) − L_out(device)`. `L_out` is a **per-device calibrated** output latency, never taken blindly from `outputLatency`. D is chosen to be at least the largest (network p99 + jitter + `L_out`) in the group. If Bluetooth receivers (about 150–300 ms) share a group with wired ones, everyone inherits that delay. Offer **zones**, and let a live low-latency zone exclude Bluetooth.
2. **Browser engine (option C).**
   - An AudioWorklet with a ring buffer and a cubic or polyphase fractional resampler.
   - A PI controller on the error between the server time of the sample now at the output and the scheduled time, with ratio clamped to **±500 ppm**.
   - A crossfaded hard resync above about 20 ms.
   - The clock model uses `getOutputTimestamp()` pairs together with server sync.
   - The same engine serves axis A (files, large D) and axis B (live, small D). That is the main architectural win over FlanerieMozaic's per-media-element loop.
3. **Clock sync.** Keep @ircam/sync's structure: series, min-RTT, regression for skew. Add **burst probes** (keeps the LTE radio granted), **coded-pair rejection**, a Kalman or windowed skew tracker, and a reset on wake or visibility change. Run it over **WebTransport datagrams with a WebSocket fallback**. Use DataChannel only if WebRTC is already carrying media.
4. **Acoustic calibration as a first-class feature, built early.** A reference device (the sender, or a calibrator phone) records scheduled chirps from each receiver in turn. Because every receiver is measured by the same recorder, the recorder's own input latency cancels out, and the result is one number per device: clock bias + `L_out` + Bluetooth. It is the only practical path to Silver on Bluetooth and it absorbs LTE bias. Re-run it on reconnect, and periodically, because Bluetooth latency drifts.
5. **Fixed nodes**: run snapclient on the Pi and the ESP32 snapclient, either behind a server that also speaks the Snapcast protocol or as the reference implementation for our own protocol. The GPL-3.0 licence is compatible with FlanerieMozaic's GPL-3.0.
6. **Rule out**: media-element `playbackRate` sync for audio (Bronze ceiling, WSOLA artifacts); PTP on phones or in the browser; trusting `outputLatency` on Bluetooth; relying on NetEq for alignment across receivers; Huygens' SVM machinery (assumes symmetric paths, too complex for a 1–2 person studio).
7. **Targets for phase 1 (phone to phone over LTE)**: **Silver (p95 ≤ 10 ms) on wired or phone-speaker output, Bronze on Bluetooth**, and Silver on Bluetooth once calibration exists. Gold is reserved for Pi/ESP32 installations on local WiFi or Ethernet.

## Proposed experiments

1. **E1 — Ground-truth rig (first, everything else depends on it).**
   - *Goal*: measure inter-device error objectively.
   - *Method*: wire every device's headphone output (or a contact mic on each Bluetooth speaker) into one multichannel USB interface, then cross-correlate the scheduled clicks or chirps.
   - *Pass*: resolution ≤ 0.1 ms; repeatable within ±0.2 ms.
2. **E2 — Browser output-timing truth table.**
   - *Goal*: find out what `getOutputTimestamp` and `outputLatency` really mean per engine, OS and output.
   - *Method*: schedule clicks at server time T on Chrome Android, Safari iOS, Firefox and desktop, through speaker, wired and Bluetooth outputs. Record bias and SD against E1.
   - *Pass*: after a constant per-model correction, SD ≤ 1 ms on wired outputs. Publish the bias table.
3. **E3 — Clock sync shoot-out, WiFi vs LTE.**
   - *Goal*: choose the transport and filter.
   - *Method*: WebSocket vs WebTransport datagram vs DataChannel, crossed with IRCAM regression vs burst+min-RTT vs coded pairs. Run 10 phones for 30 min on venue WiFi and on two LTE operators.
   - *Pass*: inter-device clock error p95 ≤ 2 ms on WiFi and ≤ 5 ms on LTE, converging within 10 s.
4. **E4 — LTE asymmetry and GNSS reference.**
   - *Goal*: size the LTE bias and test GNSS as a fix.
   - *Method*: an Android phone with `currentGnssTimeClock()`, and a Pi with GPS PPS on an LTE dongle, logging network-derived offset against GNSS time, including through handovers.
   - *Pass*: bias quantified (mean and SD). The GNSS path stays within ±1 ms of PPS.
5. **E5 — Drift and correction audibility.**
   - *Goal*: measure real ppm and choose the corrector.
   - *Method*: 60-minute runs on phones, Pi and ESP32 to log ppm. ABX tests of drop/insert vs cubic resampling vs `playbackRate` (with `preservesPitch` true and false) at ±100, ±500 and ±2000 ppm on a sine, piano and speech.
   - *Pass*: ppm table produced; the chosen corrector is not ABX-detectable at 500 ppm.
6. **E6 — Acoustic auto-calibration.**
   - *Goal*: make Bluetooth usable.
   - *Method*: a calibrator phone records chirps; apply the per-device offsets; re-measure with E1 after 0, 10 and 30 minutes and after a Bluetooth reconnect.
   - *Pass*: residual p95 ≤ 2 ms on wired and ≤ 10 ms on Bluetooth, holding for 30 minutes.
7. **E7 — FlanerieMozaic baseline.**
   - *Goal*: quantify today's system for audio.
   - *Method*: same rig, audio-only media.
   - *Pass*: none; it is the reference line (expected Bronze).

## Open questions

- **Owner decision**: which tier do the first shows actually need? Headphone audio walk (Bronze is enough) or co-located speakers in a crowd (Silver)?
- **Owner decision**: is a native app acceptable when the web cannot reach the target tier (store distribution, upkeep on two platforms)?
- **Owner decision**: should Bluetooth receivers share a sync group with wired ones? That forces a global delay of 150–300 ms. The alternative is separate zones.
- **Owner decision**: is asking receivers for location permission acceptable, so they can use GNSS time outdoors?
- Does Web Audio keep running with the screen locked on iOS and Android (needed for phones in pockets)? Not verified here; it belongs to the platform axis.
- Does `getOutputTimestamp().performanceTime` include hardware and Bluetooth latency in each engine? (E2)
- Will venue WiFi with hundreds of phones keep min-RTT samples clean enough? Airtime contention is not studied here.
- Server placement (cloud vs on-site edge) changes LTE RTT but not the uplink/downlink asymmetry, which comes from the radio. Needs measuring.

## Sources

- Snapcast README and source (time_provider.cpp, stream.cpp): https://github.com/badaix/snapcast
- Snapcast releases (v0.35.0, 2026-03-10): https://github.com/badaix/snapcast/releases
- snapweb (browser client, snapstream.ts): https://github.com/badaix/snapweb
- ESP32 snapclient: https://github.com/CarlosDerSeher/snapclient
- @ircam/sync README and publication note: https://github.com/ircam-ismm/sync
- Lambert, Robaszkiewicz, Schnell, "Synchronisation for Distributed Audio Rendering over Heterogeneous Devices, in HTML5", WAC 2016: https://hal.archives-ouvertes.fr/hal-01304889v1 and https://repository.gatech.edu/entities/publication/1f9d9d03-57b1-438d-a7b2-6a4f7c468119
- FlanerieMozaic `www/js/player_sync.js`, `server.js` (GPL-3.0): https://github.com/Hemisphere-Project/FlanerieMozaic
- beatsync (ntp.ts, global.tsx, constants): https://github.com/freeman-jiang/beatsync
- Shairport Sync: https://github.com/mikebrady/shairport-sync
- nqptp: https://github.com/mikebrady/nqptp
- Geng et al., Huygens, NSDI 2018: https://www.usenix.org/conference/nsdi18/presentation/geng
- Ansari et al., Wireless Software Synchronization of Multiple Distributed Cameras: https://arxiv.org/abs/1812.09366
- Distributed network of smartphone sensors: https://arxiv.org/pdf/2501.04886
- Tan et al., LDRP (LTE uplink latency): https://par.nsf.gov/servlets/purl/10488002
- URLLC / LTE latency enhancements: https://arxiv.org/pdf/1808.07034
- LibriWASN (sampling-rate offsets): https://arxiv.org/pdf/2308.10682
- Paderborn ICASSP'22 (SRO ranges, temperature): https://ris.uni-paderborn.de/download/33807/48990/gburrek_icassp22.pdf
- baudline sample-rate survey: https://baudline.com/solutions/sample_rate/index.html
- Espressif ESP32 schematic checklist: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/schematic-checklist.html
- MDN `AudioContext.getOutputTimestamp`: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp
- caniuse getOutputTimestamp: https://caniuse.com/mdn-api_audiocontext_getoutputtimestamp
- caniuse outputLatency: https://caniuse.com/mdn-api_audiocontext_outputlatency
- web.dev, audio output latency: https://web.dev/articles/audio-output-latency
- WebKit bug 264247: https://bugs.webkit.org/show_bug.cgi?id=264247
- blink-dev outputLatency thread: https://mail-archive.com/blink-dev@chromium.org/msg01177.html
- MDN AudioPlaybackStats: https://developer.mozilla.org/en-US/docs/Web/API/AudioPlaybackStats
- Intent to Ship, Playback Statistics API: https://groups.google.com/a/chromium.org/g/blink-dev/c/p-IHBp8Nw2Q
- WICG web_audio_playout: https://github.com/WICG/web_audio_playout
- MDN `performance.now()`: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
- WebKit, Safari 26.4 features (WebTransport): https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- MDN `jitterBufferTarget`: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
- MDN `estimatedPlayoutTimestamp`: https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats/estimatedPlayoutTimestamp
- Chromium `audio_renderer_algorithm.h` (WSOLA): https://trac.godzil.net/starfive-tech/chromium.src/src/0cffb7645682728ec1f46f00a0b01135aef4129b/media/filters/audio_renderer_algorithm.h
- blink-dev preservesPitch: https://groups.google.com/a/chromium.org/g/blink-dev/c/XVCt0EXVplQ
- Android CDD 9, audio latency: https://android.googlesource.com/platform/compatibility/cdd/+/refs/tags/android-9.0.0_r30/5_multimedia/5_6_audio-latency.md
- Android SystemClock: https://developer.android.com/reference/android/os/SystemClock
- Android GnssClock: https://developer.android.com/reference/android/location/GnssClock
- Apple developer forum, AirPods latency: https://developer.apple.com/forums/thread/679274
- Apple developer forum, Bluetooth output latency: https://developer.apple.com/forums/thread/126277
- Dröge, PTP in GStreamer: https://coaxion.net/blog/2015/05/
- Dröge, GStreamer Conference 2015 slides: https://gstreamer.freedesktop.org/data/events/gstreamer-conference/2015/Sebastian%20Dr%C3%B6ge%20-%20Synchronised%20multi-room%20media%20playback%20and%20distributed%20live%20media%20processing%20and%20mixing%20with%20GStreamer.pdf
- Duval et al., Qualifying Timing Errors in AoE Networks, AES 160th (2026): https://www.l-acoustics.com/wp-content/uploads/2026/06/Qualifying_Timing_Errors_in_Audio-over-Ethernet_Networks_for_Live_Sound.pdf
- Google Cast group delay correction: https://support.google.com/chromecast/answer/6318642
- Sonos patent US9313591: https://patents.google.com/patent/US9313591
- Roon community, RAAT and clock ownership: https://community.roonlabs.com/t/raat-and-clock-ownership/6915
- LMS sync bug archive: https://bugs-archive.lyrion.org/bug-11983.html
- AmpMe (press): https://venturebeat.com/ai/ampme-plans-to-kill-bluetooth-speakers-by-syncing-music-between-smartphones
- ITU-R BT.1359-1: https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-1-199811-I!!PDF-E.pdf
- Litovsky 2001 JASA (cites the click and speech/music echo-threshold ranges; the 1999 review by Litovsky, Colburn, Yost and Guzman is the canonical reference, not opened here): https://www.cmu.edu/dietrich/psychology/shinn/publications/pdfs/2001/2001jasa_litovsky.pdf
