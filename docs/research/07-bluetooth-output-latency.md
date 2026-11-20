# 07 — Bluetooth output latency (phase 2 research)

*Research note, 2026-11-20. Status: desk research plus reading the source code of Android, Chromium, WebKit, PipeWire, ESP-IDF and Zephyr. No bench measurements yet. Claims I could not verify are marked "unverified".*

## Question

When a receiver (phone, Raspberry Pi or ESP32) plays through a Bluetooth speaker or headset, the Bluetooth link adds a large delay that depends on the device and is partly unknown. This note asks five things:

- How large is that delay, and how stable is it?
- What do the OS and the browser report about it?
- How can we measure it when the reported value is wrong?
- Which designs avoid the problem altogether?
- What does this mean for the global playout delay, and so for the "low-latency live" goal?

## TL;DR

- **Classic Bluetooth audio (A2DP) adds roughly 100–300 ms. Some phone and speaker pairs reach about 500 ms.** It also moves around during a session. The best published A2DP data: the same headphones measure 113–241 ms on SBC, depending on the model. Four 2019 Android phones playing to one receiver averaged 244–484 ms from app to sound. Repeated runs varied by 25–90 ms. In one developer's report, AirPods measured about 215–220 ms right after connecting and settled to about 155–160 ms after 20–30 minutes.
- **The OS does receive an estimate, and current stacks pass it all the way up.** It comes from the speaker's AVDTP *delay report*. Current AOSP enables delay reports by default. Android feeds the value into `AudioTrack`/AAudio timestamps. When the speaker sends no report, Android falls back to *its own buffer plus a fixed 200 ms*. Chrome on Android computes `AudioContext.outputLatency` from AAudio timestamps. Safari's `outputLatency` is `AVAudioSession.outputLatency`. PipeWire uses the BlueZ `Delay` property, or a guessed 125 ms (40 ms for LC3/aptX LL).
- **Treat the reported value as a starting estimate, not a measurement.** The speaker firmware declares the delay report; it is often a configured constant. Developers report that iOS under-reports Bluetooth latency and that the value changes over time.
- **Measuring the speaker acoustically works, and the web has traps.** The receiver plays a chirp through its own Bluetooth speaker, records it with its built-in mic, and cross-correlates the recording with the clock-stamped reference. The traps:
  - In Safari, opening the mic sets `PlayAndRecord` with HFP allowed. A headset or speaker that has a mic then flips to the phone-call profile.
  - In Chrome on Android, opening the mic with the default voice processing switches the device to `MODE_IN_COMMUNICATION`.
  - Native apps can avoid both: on iOS, `playAndRecord` with A2DP only; on Android, a plain `AudioRecord` in normal mode.
- **LE Audio / Auracast is the only Bluetooth path whose latency is fixed by the protocol.** Broadcast presets use a 40 ms presentation delay, and every receiver renders at the same anchor point. The audio hop works out to roughly 70–120 ms. Phones can send it: Pixel 8+, Galaxy S23+ and several Xiaomi models. iPhones still cannot, as of iOS 27. A board can also be the transmitter: nRF5340 Audio DK today, ESP32-S31 (LE Audio + Classic, mass production since July 2026). The ESP-IDF LE Audio stack is still marked "preview".
- **Honest promise for live input with Bluetooth in the fleet:** every device must wait for the slowest output.
  - Mixing classic A2DP speakers into a live fleet pushes the global delay to about **0.45–0.6 s**.
  - Wired outputs, the phone's own speakers, ESP32+I2S receivers and LE Audio can hold about **0.15–0.35 s** over LTE.
  - Buffered playback (axis A) absorbs Bluetooth completely.
- **What I would build first:** a measurement tool that does acoustic calibration and logs the reported values next to it; per-device output-latency compensation in the sync engine; latency tiers; and an Auracast spike. I would rule out relying on `outputLatency` alone, near-ultrasonic probes through Bluetooth codecs, aptX LL (no phones send it) and AirPlay (about 2 s).

## Findings

### 1. How large, how variable

| Path | Latency (ms) | Kind of data | Source |
|---|---|---|---|
| A2DP SBC, headphones | 113 (Razer Barracuda Pro) – 241 (Sony WH-1000XM5) | measured | RTINGS changelog (paywalled; figures via search snippet) |
| A2DP SBC / aptX / aptX LL, one headset | 173 / 166 / 34 (wired: 7) | measured | RTINGS, older test bench (Plantronics BackBeat Pro 2) |
| App → sound through a BT receiver, 4 Android phones (2019) | 244–484 average per phone. Per codec: SBC 308, aptX 316, LDAC 324, AAC 369. Run-to-run variation 26–90 | measured (WALT, 100 runs × phone × codec) | SoundGuys |
| AirPods, tap → sound on iOS (includes touch latency) | AirPods 1 ≈ 274, AirPods 2 ≈ 178, Pro ≈ 144 (2019); Pro 2 ≈ 126 vs Pro ≈ 167 (2022) | measured (blog) | Stephen Coyle; 9to5Mac; iThinkDifferent |
| AirPods 2 on iPhone 12 mini | **reported** `outputLatency` 160.7. **Measured** 215–220 just after connecting, falling to 155–160 after 20–30 min | developer report | Apple Developer Forums 679274 |
| A BT headset on iOS | reported value "much smaller than real"; real latency moved 193 → 260 within 1 min | developer report | Apple Developer Forums 126277 |
| aptX Adaptive (hardware, low-latency mode) | ≈ 80; a software encoder gives no latency advantage | vendor figures via Wikipedia | Wikipedia "aptX" |
| aptX LL | ≈ 32–40, but needs a dedicated transmitter; practically no phones | vendor figures | Wikipedia "aptX" |
| Speaker jitter buffer | typically 100. Jitter up to ~80; A2DP 150–200 | patent text | US 11102565 |
| AirPlay output | "can result in a 2-second delay" | Apple docs | `AVAudioSession.outputLatency` |
| LE Audio broadcast (BIS), 48 kHz LC3 | 10 ms frame + 2.5 ms algorithmic delay + 20 ms (low-latency preset) or 65 ms (high-reliability preset) max transport latency + 40 ms presentation delay ≈ **72–118** for the hop | spec presets; computed | Zephyr `bap_lc3_preset.h`; liblc3 |

There is no open, per-model latency database for **speakers**. RTINGS measures headphones and puts most of the data behind a login. The SoundGuys result matters most for us: with the *same* Bluetooth receiver, the phone alone moved the total by about 240 ms. The receiving phone is as much a variable as the speaker.

### 2. Stability over a session

- **Warm-up drift.** The AirPods report above shows latency falling by about 60 ms over 20–30 minutes. That is the behaviour of an adaptive jitter buffer.
- **Sudden changes.** The second iOS report saw a 67 ms jump within a minute.
- **Resets.** The Android Bluetooth audio HAL resets its byte counter and the stored delay report at every stream start and on AVDTP reconfiguration (`ResetPresentationPosition`, `remote_delay_report_ = 0`). Every reconnect or codec change is therefore a new latency regime.
- **Inferred mechanism, unverified.** A2DP has no shared clock. The sink plays at its own DAC rate (crystals are typically ±20–50 ppm, which would be up to about 180 ms per hour if nothing corrected it). The sink must drop or insert samples, or resample, to hold its buffer level. Cheap sinks probably let the buffer creep and then skip. That would produce slow wander plus occasional steps. Experiment E3 tests this.
- **Expect the delay to be fixed only between events.** Plan for recalibration on reconnect, codec change, route change, underrun and audible glitch, plus a periodic check.

### 3. What the OS knows and exposes

**The protocol.** AVDTP 1.3 lets an A2DP sink send a *delay report* in units of 1/10 ms. The sink's firmware declares the value. The ESP-IDF sink API, for example, defaults it to 120 ms and refuses lower values. In other words, it is a configured number, not a measurement. iOS has supported delay-report commands since iOS 8.2 (Apple bluetooth-dev list; snippet only). We found no survey of how many speakers send an *accurate* report.

**Android (AOSP main, read on 2026-11-20).**

- `btif_av.cc`: delay reporting is **on by default**. Only the `persist.bluetooth.disabledelayreports` property disables it. (The 2018 commit that introduced it was opt-in.)
- `audio_bluetooth_hw/stream_apis.cc`: a report between **50 and 1000 ms** is used.
- Otherwise the HAL uses `buffer_frames / rate + kExtraAudioSyncMs (200 ms)`. A speaker with no report therefore gets a *guessed* latency of 200 ms plus a buffer.
- The value flows into `get_presentation_position`, so `AudioTrack.getTimestamp()`, `AAudioStream_getTimestamp()` and Oboe timestamps already include it.
- `adb shell dumpsys bluetooth_manager` prints "Delay Reporting: N (in 1/10 milliseconds)" per peer. That is a cheap survey tool.
- LE Audio unicast passes a remote delay (presentation delay + transport latency) through the same path (`le_audio_software_aidl.cc`).
- Media3/ExoPlayer still adds the hidden `AudioTrack.getLatency()` by reflection on top of timestamp polling.
- Amazon's Fire TV guidance: poll `getTimestamp()` about every 10 s; it returns 0 for "several seconds" at warm-up.
- Many phones offload A2DP encoding to the DSP. Whether vendor HALs feed the delay report into timestamps the same way is **unverified** (see open questions).
- Apps cannot choose the codec or the sink buffer. `BluetoothA2dp.setBufferLengthMillis` / `getBufferConstraints` exist, but only as privileged `@SystemApi`.

**iOS.**

- `AVAudioSession.outputLatency` includes the Bluetooth route estimate (AirPods 2: 160.7 ms).
- Developers report that it under-reports, especially early in a connection, and does not follow later changes. No Apple documentation gives its accuracy.
- AirPlay routes can add about 2 s.

**Linux / Raspberry Pi (PipeWire).**

- `bluez5-dbus.c` uses the BlueZ MediaTransport `Delay` property when the sink reports one.
- Otherwise it falls back to 125 ms for SBC/AAC/aptX/LDAC, 40 ms for aptX LL/LC3, and 20 ms for mSBC/CVSD.
- Each node has a settable `latencyOffsetNsec`. That is the place to inject a calibrated value.
- PipeWire also lists `bap_bcast_source` and `bap_bcast_sink` roles, so it can act as an Auracast transmitter or receiver. That needs a controller with LE isochronous channels; whether the Pi's built-in radio has them is unverified, and is probably not the case on Pi 4/5.

**ESP32 (Classic, as A2DP source to a speaker).** It receives the sink's report as `ESP_A2D_REPORT_SNK_DELAY_VALUE_EVT`.

**Browsers.**

`outputLatency` support: Chrome 102, Firefox 70, Safari 18.4. `getOutputTimestamp` support: Chrome 57, Safari 14.1 (MDN browser-compat-data).

Chrome on Android:

- Uses AAudio output by default (`kUseAAudioDriver` is enabled by default).
- Computes the output delay from `AAudioStream_getTimestamp`, so `outputLatency` carries whatever the HAL believes: the delay report or the 200 ms guess.
- Rounds `outputLatency` to **8 ms** unless the page has mic permission, in which case it rounds to **1 ms**.
- Chromium now also ships `AudioContext.playbackStats` (status "stable"): `underrunEvents` plus minimum, average and maximum latency. These make good recalibration triggers.

Safari / WebKit:

- `outputLatency` = `AVAudioSession.outputLatency` plus the output unit's `kAudioUnitProperty_Latency`.
- It returns **0 when the context is not running**.
- When fingerprinting protection ("noise injection") is active, it returns a fixed `512/sampleRate` (about 10.7 ms at 48 kHz).

Firefox: Mozilla's own bug says `outputLatency` was wrong on Android (bug 1612093).

Media elements: FlanerieMozaic aligns `HTMLMediaElement.currentTime` to the synced clock and has **no output-latency term**. A Bluetooth receiver in that system lags by its full output latency.

### 4. Calibration when the reported value is wrong

**Acoustic self-loopback (the core method).**

1. The receiver schedules a probe for clock time *T*.
2. It plays the probe through its Bluetooth sink, records with its **built-in** mic, and timestamps the capture on the same clock (Android `AudioRecord.getTimestamp` / AAudio input timestamps; Web: AudioWorklet capture plus the `getOutputTimestamp` mapping).
3. It cross-correlates the recording with the reference.
4. Measured output latency = arrival time − *T* − acoustic flight time (2.9 ms/m) − input latency.

How accurate this is:

- A wideband chirp or MLS gives a correlation peak much sharper than 1 ms. Accuracy is limited by how well the input timestamps are known.
- A two-step calibration cancels input latency: first through the phone's own speaker, then through Bluetooth. The difference is (BT − built-in speaker) latency.
- Target: ±2–5 ms. That is an estimate to be validated (E2).
- Prior art: Apple TV's Wireless Audio Sync plays tones that an iPhone mic times, stores the offset, and asks the user to "repeat if equipment changes". Roku's mobile private listening has a beep-based sync test about 10 s long, plus a manual "Adjust audio delay". Patents describe the same play/record/subtract method (e.g. US 10334358). We found no public description of AmpMe's or SoundSeeder's method (unverified).

**The HFP trap.**

- A2DP is output-only. Any route that takes input *from* the Bluetooth device forces HFP/SCO: mono, 8–32 kHz, a different latency. A measurement taken that way is meaningless.
- iOS native: use `playAndRecord` + `.allowBluetoothA2DP` **without** `.allowBluetooth`/`.allowBluetoothHFP`. Apple's documentation says HFP wins when both options are set. Output stays on A2DP and input comes from the built-in mic; this is exactly the setup in the AirPods forum report.
- iOS 26's `.bluetoothHighQualityRecording` gives full-band AirPods mic input, but "may increase input latency". It is not for calibration.
- Safari: getUserMedia sets `PlayAndRecord` with `AllowBluetooth | AllowBluetoothA2DP`. A headset or speaker that has a mic will likely switch to HFP while the mic is open. Whether selecting the built-in mic `deviceId` prevents this is **unverified** (E2).
- Chrome on Android: the first input stream sets `MODE_IN_COMMUNICATION` unless the stream has no effects. Requesting `echoCancellation`, `noiseSuppression` and `autoGainControl` all `false` should keep normal mode. That reading of the source still needs a device check.
- Native Android: `AudioRecord(MIC/UNPROCESSED)` in normal mode without `startBluetoothSco` keeps A2DP.

**Continuous in-band tracking.**

- The receiver knows exactly what it played. It can cross-correlate the mic signal with the program itself, with no probe at all. The WebRTC AEC3 `echo_path_delay_estimator`/`matched_filter` (BSD) is a ready reference design; its search window must be widened to 150–500 ms.
- Risks:
  - Other fleet devices play the *same* program, which gives several correlation peaks. Gate on the strongest, earliest peak near the previous estimate.
  - Crowd noise.
  - Pockets.
- Near-ultrasonic (18–20 kHz) probes are a poor fit. Bluetooth encoders and small speakers often low-pass at about 16 kHz, and LE Audio at 32 kHz sampling is band-limited to 16 kHz (unverified for specific encoders).

**Manual "nudge until it stops flamming".**

- A reference device plays a click track. The user drags the receiver's offset slider until the clicks fuse.
- Clicks fuse below about 1–5 ms and become distinct echoes above about 50 ms; music fuses up to about 40 ms (precedence effect). A trained ear reaches roughly ±5 ms (estimate).
- It is cheap and robust, and it needs no mic permission. WiiM and Roku ship this as a fallback.

**Recalibration triggers.** Bluetooth connect, disconnect or codec change (Android `ACTION_CODEC_CONFIG_CHANGED`, `AudioDeviceCallback`; iOS `routeChangeNotification`; Web `devicechange`). Also: a timestamp discontinuity, underruns (`AudioTrack.getUnderrunCount`, Chrome `playbackStats`), and a periodic in-band check.

### 5. Ways around the problem

**LE Audio / Auracast as the "FM" last hop.**

- One source, unlimited receivers.
- The Broadcast Audio Source Endpoint (BASE) announces the presentation delay. All Zephyr broadcast presets use 40 ms.
- Every receiver renders at the anchor point plus the presentation delay. Sync between receivers is therefore set by the protocol, not left to firmware goodwill. Exact sync accuracy is unverified.
- Phones that can transmit (Android "Audio sharing"): Pixel 8 and later, Galaxy S23/S24/S25 and Z Fold 5–7, Xiaomi 14/15 lines (Google, Sept 2025).
- iOS has **no Auracast** in iOS 26 and, per reports, none in iOS 27 (WWDC26 coverage, beta reports). Hearing-aid apps can act as "assistants" that tell aids which broadcast to join.
- Boards that can transmit:
  - **nRF5340 Audio DK**: USB audio in, broadcast out. Forum users needed a 40 ms presentation delay for third-party earbuds. Sync time is about 1 s with Nordic's application.
  - **ESP32-S31**: Classic plus LE Audio, mass production since July 2026. ESP-IDF's LE Audio API is "preview; provisional".
  - **ESP32-H4**: LE Audio only.
- Receivers: LE Audio earbuds and hearing aids are common. Auracast *speakers* exist but are fewer and often vendor-specific ("party" modes); the receiver list is unverified.
- Range is class-dependent, typically 10–30 m indoors (unverified).
- A Linux host running PipeWire with a controller that supports LE isochronous channels can also broadcast.

**aptX LL / Adaptive dongles.** aptX LL needs a dedicated transmitter; phones do not have it. A USB-C dongle with aptX LL, Adaptive or LE Audio on the receiver phone is possible on Android, and on USB-C iPhones as a USB audio device. It only helps with matching sinks (unverified product support).

**No Bluetooth on the last hop.** Use a wired jack, a Pi with a DAC, or an **ESP32 with an I2S amplifier** (DMA buffers of a few ms, a known and stable output latency). This is the most deterministic receiver and the cheapest to scale.

### 6. What a controlled-latency design implies

Every device *i* schedules audio so that it reaches the air at *t_capture + D*. To do that it writes audio *D − L_i* after capture, where *L_i* is its output latency. The global playout delay *D* must cover the source side, the network p99 including jitter, and the **largest L_i in the group**, plus a margin.

Assumptions for the table: the source side (capture plus encode) is about 20–30 ms; the LTE one-way p99 is about 80–150 ms, an assumed value to be replaced by the network axis numbers; the margin is about 20–50 ms.

| Tier | Typical output latency L | Global delay D over LTE | Inter-device sync (after calibration, target) |
|---|---|---|---|
| T0: wired, phone speaker, ESP32/I2S, Pi DAC | 5–50 ms | ≈ 150–250 ms | ±2–5 ms |
| T1: LE Audio unicast or Auracast, aptX Adaptive LL | ≈ 70–130 ms | ≈ 250–350 ms | ±5 ms (Auracast receivers share one anchor) |
| T2: classic A2DP SBC/AAC | 150–300 ms, outliers to about 500 | ≈ 450–600 ms | ±5–20 ms; needs recalibration |
| Buffered (axis A) | any | 1–3 s | limited only by calibration |

Consequences:

- **One T2 speaker drags the whole group to about half a second.** If any live sound is audible in the room (a performer's voice or instrument), the fleet sounds like an echo 0.5 s behind it. Above about 50–100 ms the precedence effect no longer fuses the two.
- The honest options are:
  - Run separate sync groups per tier, which is fine for spatially separate zones.
  - Restrict the live tier to T0/T1 outputs.
  - Use Bluetooth speakers only for buffered (axis A) content.
- Distance also matters: listeners 10 m apart already hear about 29 ms of difference. Sub-5 ms sync only matters for speakers placed close together.
- Headphone-only audio walks are tolerant. There, Bluetooth latency matters only relative to live acoustic or visual cues, not between listeners.

## Options compared

| Option | Latency known? | Stable? | Inter-device sync | iOS | Android | Effort for 1–2 people | Verdict |
|---|---|---|---|---|---|---|---|
| Trust the OS value (`outputLatency`, timestamps) | estimate; error tens of ms (unverified; 55 ms in the AirPods report) | follows only what the stack knows | ±30–100 ms (estimate) | yes (web + native) | yes (web + native) | trivial | fallback and seed only |
| Acoustic self-calibration (native) | measured | re-measure on triggers | ±2–5 ms target | native: yes (A2DP + built-in mic) | native: yes | medium | **core** |
| Acoustic self-calibration (web) | measured | same | same | HFP trap with mic-equipped sinks (unverified) | probably OK with effects disabled | medium | build, verify per platform |
| In-band continuous tracking (AEC-style) | measured continuously | tracks drift | ±5 ms target | native | native / web worklet | high | phase 2b |
| Manual nudge slider vs reference | perceptual | user re-nudges | ±5–10 ms | yes | yes | low | **always ship as fallback** |
| Per-model latency database | historical | no | poor (phone varies ±240 ms) | – | – | low (crowd-sourced) | log it, don't rely on it |
| Auracast last hop (phone or nRF/ESP transmitter) | defined by protocol (presentation delay) | yes | protocol-defined | not as source or sink (iOS 27) | Pixel 8+, Galaxy S23+ | medium (hardware) | **spike in phase 2** |
| aptX LL / Adaptive dongle | vendor-defined | mostly | good with matching sinks | USB-C only | yes | low | niche |
| ESP32 + I2S amp / wired | known, small | yes | ±1–2 ms | – | – | low–medium | **best receiver for live** |

## Recommendation

1. **Put output-latency compensation into the sync model from day one.** Each device publishes `L_i` and a source label: `measured`, `reported` or `manual`. The server picks *D* per group as max(L_i) + network p99 + margin. Clients schedule against *D − L_i*. For FlanerieMozaic-style media-element sync, aim `currentTime` ahead by `L_i`.
2. **Build the latency probe first, as a web page plus a small Android/iOS native helper.** It plays a chirp at clock time *T*, records with the built-in mic, cross-correlates, and logs the measured value next to `outputLatency`, AudioTrack timestamps, the `dumpsys` delay report, codec and device models. That gives the project its own dataset and answers "can we trust reported values?" with numbers. Publish the dataset openly; no open per-model database exists.
3. **Ship the manual nudge slider** with a reference click track. It is the zero-dependency fallback and the ground truth for user acceptance.
4. **Define tiers and say them plainly.**
   - Live with Bluetooth speakers: about 0.5 s glass-to-air, sync between devices ±10–20 ms.
   - Live with T0/T1 outputs: about 0.15–0.35 s.
   - Buffered: anything.
5. **Phase 2 spike: Auracast.** Feed one nRF5340 Audio DK by USB audio from a Pi or phone, and alternatively use a Pixel or Galaxy's Audio sharing. Use it to drive several LE Audio receivers in one zone. It is the only "one transmitter, N receivers, defined delay" Bluetooth path. Note the gaps: there is no iPhone participation, and speaker support is thin.
6. **For dedicated installations, prefer ESP32 + I2S amplifier receivers over Bluetooth speakers.**
7. **Rule out:**
   - aptX LL as a general solution (no phone sources).
   - Near-ultrasonic probes through Bluetooth codecs.
   - AirPlay outputs (about 2 s).
   - Relying on reported latency without measurement.
   - Web-based mic calibration on iOS with mic-equipped Bluetooth sinks, until E2 proves it safe.

## Proposed experiments

| # | Goal | Method | Pass / fail |
|---|---|---|---|
| E1 | Do reported values match reality? | 8–10 Bluetooth speakers/headsets × 3 phones (Pixel, Samsung, iPhone). Reference: wired phone or measurement mic + audio interface. Play a click at clock time *T* and measure acoustic arrival. Log `outputLatency`, AudioTrack/AAudio timestamps, `dumpsys` delay report. | Pass if \|reported − measured\| ≤ 10 ms for ≥ 80 % of pairs. Otherwise calibration is mandatory. |
| E2 | Self-calibration accuracy and the HFP trap | Same rig. The device self-measures with its built-in mic (native and web: Chrome with effects off, Safari with built-in mic selected). Compare with the reference. Record whether the route flipped to HFP (sample rate, mono, `dumpsys`/route logs). | Pass if error ≤ ±5 ms in 95 % of 20 runs, no HFP flip on native, and 60 dB(A) babble noise doesn't break it. Note the platforms where the web flips to HFP. |
| E3 | Stability over a session | Log measured latency every 30 s for 60 min per pair. Inject events: walk out of range, microwave or Wi-Fi interference, reconnect, codec change. | Pass if drift is ≤ 5 ms within a session, every step coincides with a detectable event, and recalibration restores ±5 ms within 10 s. |
| E4 | Continuous in-band tracking | Run the AEC3-style matched filter on mic vs program during music playback, with 1–3 other fleet devices playing nearby. | Pass if the tracked value stays within ±5 ms of the E1 reference for ≥ 90 % of the time, with no false locks onto other devices. |
| E5 | Manual nudge usability | Five non-expert users align a Bluetooth speaker against a reference click track. | Pass if the median absolute error is ≤ 10 ms and it takes < 60 s per device. |
| E6 | Auracast as the last hop | nRF5340 Audio DK (USB audio in) and a Pixel or Galaxy in Audio sharing → 3+ LE Audio receivers. Measure glass-to-air latency and sync between receivers with a multi-channel recorder. | Pass if receivers agree within ±2 ms, the hop adds ≤ 120 ms, and the link holds 10 m indoors. |
| E7 | End-to-end tier check | Full chain: LTE sender → mixed fleet (T0 + T2) with compensation. | Pass if every device is within ±10 ms of the target at the chosen *D*, and *D* stays ≤ 600 ms with T2 in the group. |

## Open questions

- Do vendor A2DP **offload** HALs (Qualcomm, Samsung, MediaTek) include the delay report in `getTimestamp()` the way the AOSP software path does? This decides whether Android "reported" values are even stable across phones.
- What share of consumer Bluetooth speakers send a delay report at all, and how close is it to reality? There is no published survey; E1 produces one.
- Does selecting the built-in mic in Safari's getUserMedia keep a mic-equipped Bluetooth sink on A2DP?
- Will Apple ship Auracast (source or sink) in a later iOS? As of iOS 27 reports, no. The iPhone half of the fleet cannot join an Auracast last hop natively.
- Can an Android phone act as an Auracast source for *app* audio from a background web page, and does its timestamp path include the broadcast presentation delay?
- Owner decisions:
  - Is about 0.5 s glass-to-air acceptable for "live with Bluetooth speakers", or is Bluetooth confined to buffered content?
  - Are dedicated ESP32/I2S receivers acceptable in place of audience-owned Bluetooth speakers?
  - Can mixed-tier fleets run as separate sync zones?

## Sources

- RTINGS latency test bench: https://www.rtings.com/headphones/learn/research/latency · changelog 1.6: https://rtings.com/headphones/tests/changelogs/1-6 (paywalled; figures via search snippets)
- SoundGuys, Android Bluetooth latency: https://www.soundguys.com/android-bluetooth-latency-22732/
- Stephen Coyle, AirPods latency: https://stephencoyle.net/airpods-pro · https://9to5mac.com/2019/12/22/airpods-latency-test/ · https://www.ithinkdiff.com/airpods-pro-2-better-bluetooth-latency/
- Apple Developer Forums: https://developer.apple.com/forums/thread/679274 · https://developer.apple.com/forums/thread/126277
- Apple docs: https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetootha2dp · https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/bluetoothhighqualityrecording · https://developer.apple.com/documentation/avfaudio/avaudiosession/outputlatency
- Apple bluetooth-dev list, AVDTP delay reporting in iOS/tvOS: https://lists.apple.com/archives/bluetooth-dev/2017/Aug/msg00011.html (snippet only)
- AOSP delay-report commit: https://android.googlesource.com/platform/packages/modules/Bluetooth/+/82fc8edc52%5E%21/
- AOSP sources (main): https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/system/btif/src/btif_av.cc · https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/system/audio_bluetooth_hw/stream_apis.cc · https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/system/audio_hal_interface/aidl/a2dp/a2dp_encoding_aidl.cc · https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/system/audio_hal_interface/aidl/le_audio_software_aidl.cc · https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/framework/java/android/bluetooth/BluetoothA2dp.java
- Media3 `AudioTrackPositionTracker`: https://github.com/androidx/media/blob/main/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioTrackPositionTracker.java
- Amazon Fire TV A/V sync: https://developer.amazon.com/docs/fire-tv/audio-video-synchronization.html
- Chromium: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/android/aaudio_stream_wrapper.cc · https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/android/audio_manager_android.cc · https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/audio_features.cc · https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_context.cc · https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webaudio/audio_playback_stats.idl
- WebKit: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp · https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/AudioDestinationCocoa.cpp · https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm
- MDN browser-compat-data (AudioContext): https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json · web.dev: https://web.dev/articles/audio-output-latency
- Browser audio latency measurements: https://www.lesswrong.com/posts/ooXEzrX7Y9Go6D7st/browser-audio-latency · Mozilla bug 1612093: https://bugzilla.mozilla.org/show_bug.cgi?id=1612093
- PipeWire: https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/master/spa/plugins/bluez5/bluez5-dbus.c · https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/master/spa/plugins/bluez5/media-sink.c · https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/master/doc/dox/config/pipewire-props.7.md
- ESP-IDF A2DP API: https://github.com/espressif/esp-idf/blob/master/components/bt/host/bluedroid/api/include/api/esp_a2dp_api.h · LE Audio status: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32h4/api-guides/esp-ble-audio/ble-audio-feature-support-status.html · ESP-ADF Bluetooth audio: https://docs.espressif.com/projects/esp-adf/en/latest/solution-center/bluetooth-audio.html · ESP32-S31 mass production: https://www.espressif.com/en/news/ESP32_S31_Mass_Production
- Zephyr LC3 presets: https://github.com/zephyrproject-rtos/zephyr/blob/main/include/zephyr/bluetooth/audio/bap_lc3_preset.h · liblc3 (Apache-2.0): https://github.com/google/liblc3
- Nordic: https://nrfconnectdocs.nordicsemi.com/ncs/latest/nrf/samples/bluetooth/nrf_auraconfig/README.html · https://devzone.nordicsemi.com/f/nordic-q-a/127785/le-audio-interoperability-with-non-nordic-device-nrf5340-audio-dk-and-airoha-ab156x/565224 · https://devzone.nordicsemi.com/f/nordic-q-a/125165/nrf5340-audio-dk-setup-as-a-broadcast-source-from-usb-looks-like-it-s-working-but-no-audio-transported/552685 · https://devzone.nordicsemi.com/f/nordic-q-a/119561/decrease-time-to-sync-audio-broadcast/530565
- Google, LE Audio / Auracast on Android: https://blog.google/products-and-platforms/platforms/android/le-audio-auracast-support/ · https://developer.android.com/guide/topics/connectivity/ble-audio/overview
- Apple and Auracast: https://aurahear.com/2026/06/apple-disappoints-on-auracast-support-at-wwdc26-keynote-event/ · https://forum.hearingtracker.com/t/iphone-18-pro/135034
- Apple TV Wireless Audio Sync: https://support.apple.com/guide/tv/atvb228b7711/tvos · https://9to5mac.com/2019/06/18/ios-13-uses-your-iphone-microphone-to-fix-apple-tv-audio-sync-issues/
- Roku: https://cordcuttersnews.com/rokus-bluetooth-wireless-audio-gets-a-built-in-sync-tool-so-your-audio-matches-the-lips-on-the-tv/ · https://support.roku.com/en-gb/article/how-to-resolve-an-issue-with-headphone-mode
- WiiM manual sync: https://faq.wiimhome.com/support/solutions/articles/72000568200-use-manual-sync-to-resolve-the-latency-sync-issue
- Patents: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11102565 · https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10334358
- Audio Precision Technote 123: https://www.ap.com/download/technote-123-measuring-bluetooth-a2dp-profile-audio-quality-2
- WebRTC AEC3: https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/aec3/
- Precedence effect: https://en.wikipedia.org/wiki/Precedence_effect · aptX: https://en.wikipedia.org/wiki/AptX
