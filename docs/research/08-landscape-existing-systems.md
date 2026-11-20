# 08 — Landscape: existing systems for "FM-like" audio to many devices over IP

*Research axis 08. Status: desk research, 2026-11-20. Vendor figures are labelled as vendor claims; anything not verified on the web is marked "unverified".*

## Question

Which existing products and open-source systems already deliver one audio source to many personal devices (phones, embedded boards, Pi) over Wi-Fi or cellular? What latency and inter-device sync does each really achieve, and why? Is there an open-source system that already covers more than 70 % of this project, and if so, what should be extended instead of rebuilt? What is the gap this project could own? Which market claims are physics and which are marketing? And what can IP + LTE + Bluetooth honestly promise compared with FM?

## TL;DR

- **Nobody does the whole thing.** Products split into three families that never meet. (1) **Live, low-latency, unsynchronised:** assistive listening over Wi-Fi, Mixhalo, interpretation apps, SonoBus, Jamulus. They get 25–120 ms on a managed LAN, but each receiver has its own jitter buffer and nobody aligns receivers to one another. (2) **Synchronised, high-latency:** Snapcast, Sendspin / Music Assistant, AirPlay 2, beatsync, FlanerieMozaic. They play in sync to within about 1 ms (native) or a few ms (browser), but they buffer 0.25–2 s, live on one LAN, and treat Bluetooth as a manual offset. (3) **Scale CDNs:** WebRTC CDNs, LL-HLS and MoQ. They reach thousands of viewers at 0.2–5 s, and their "sync" means tens to hundreds of ms, which is fine for betting and quizzes but not for co-located loudspeakers.
- **Closest open-source match: Sendspin** (Open Home Foundation's protocol behind Music Assistant, RC1 in 2026). It has a Kalman clock filter, timestamped Opus/FLAC/PCM chunks, a ±1 ms sync floor in the spec, a per-device `output_delay_ms`, a browser client that subtracts `AudioContext.outputLatency`, ESP32 / Android / desktop players, and a `source` role for line-in or mic capture. **Snapcast** is the mature, GPL reference for the same design: sample-stuffing correction, typically under 0.2 ms deviation, ESP32 client, browser player in Snapweb. Sendspin's scope is explicitly a **"local IP network"**, though, and both default to about 1 s of buffer. Neither has a low-latency live profile, a cellular/WAN relay, or Bluetooth calibration.
- **Coverage estimate:** Sendspin plus Snapcast cover about 60–70 % of axis A (buffered sync) on a LAN, about 40 % of axis A over LTE, and under 25 % of axis B (low-latency live over LTE). No system covers more than 70 % of the full project, so building on existing parts is right but a turnkey extension is not available. **Reuse the clock/timestamp/output-delay design, and ideally the wire protocol and the ESP32 clients. Build the WAN relay, the live tier and the Bluetooth calibration.**
- **The gap this project could own:** *a controlled, declared global playout deadline across browsers (iOS and Android), MCUs and Pis over LTE, with per-device output-path compensation including Bluetooth, and two tiers (buffered and live) in one system.* No product or open project found does this.
- **Physics check:** FM has about 0 ms latency (3.3 µs per km) and passive receivers. IP cannot match that. Honest targets are below.

| Tier | Latency (end to end) | Inter-device sync |
|---|---|---|
| Buffered | 0.5–3 s, or pre-loaded | ≤1 ms native, ≤5–10 ms browser |
| Live, managed Wi-Fi | 40–100 ms | ≤5–10 ms |
| Live, LTE, wired output | ~120–250 ms | ≤10–20 ms, only with a common playout deadline |
| Live, LTE, classic BT output | ~250–500 ms | depends on calibration (≤20 ms is a research target) |

## Findings

### 1. Assistive listening and venue audio to phones (live, LAN, closed)

| System | Claimed latency | Scale | Notes |
|---|---|---|---|
| Sennheiser MobileConnect | 40–60 ms typical; "as little as 25 ms" unicast, best case (vendor) | multi-channel | Adjustable latency setting to trade delay for stability; native app |
| Listen EVERYWHERE / ListenWIFI | 40–60 ms "dependent on network, traffic and QoS" (vendor) | up to ~1000 users per server; ~140 kbps per user, unicast | Vendor's own app listing warns that Bluetooth headphones add delay |
| Williams AV WaveCAST | "ultra-low latency", no number published | 45+ unicast or 1500+ multicast users (vendor) | Multicast needs network engineering |
| AudioFetch Lite | ~115 ms (1 user) to ~120 ms (250 users), typical; excludes network delay (vendor spec sheet) | 250 | Notes higher latency on some Android devices |
| Bettear | 40–110 ms (vendor) | — | Theatre-oriented |
| Listen "Auri" (Auracast, not Wi-Fi) | 31 ms (vendor) | unlimited broadcast receivers | Shows where Bluetooth broadcast is heading |

**Why these numbers:** a dedicated, QoS-managed Wi-Fi LAN, a native app with a fixed small jitter buffer, and no WAN. Unicast per user is what limits scale; multicast fixes it but needs controlled infrastructure. **Inter-device sync is not a design goal.** Each phone plays "as soon as it can", so two phones side by side can differ by tens of ms. That is acceptable for headphones, not for loudspeakers in the same room. Every one of these products tells users that Bluetooth breaks lip sync.

**Mixhalo** (in-venue, acquired by DeepL in June 2026) streams the soundboard over a UDP Wi-Fi overlay. Its patents claim under 100 ms from the server audio interface to the phone output. Its marketing describes "dynamic latency" that time-aligns audio to the listener's position in the venue. At 343 m/s, 100 ms is 34 m of air, so beyond about 35 m from the PA a phone can genuinely be ahead of the acoustic sound. That claim is physics, not marketing. A 2020 hands-on review still noted slightly-off lip sync.

**Peex** (2019) advertised "zero latency", but it used a dedicated RF wearable precisely because routing through a phone or Bluetooth added too much delay (Engadget). It is not a phone system.

**Interpretation and tour-guide apps** (LiveVoice, Interactio, KUDO, Interprefy, Vox Connect/Aura) run over 4G/5G or Wi-Fi with one talker and many listeners. Interprefy states a platform delay below 0.2 s. The others publish no numbers ("extremely low latency"). Interpretation adds a human delay of about 5 s, so these products optimise robustness and auto-reconnect, not milliseconds. They are the best existing evidence that **phone-to-many-phones over LTE works at 150–300 ms**. None claims inter-listener sync.

**Drive-in cinema and museum audio** (Cinewav, Nubart Sync, Sennheiser Cinema Connect) is the closest to axis A. Nubart plays a pre-loaded or streamed soundtrack in the browser from a QR code. A server sends timestamps only, and per-device learning compensates browser latency (it reports Safari as the slowest). Its "zero latency" means **zero offset against a clock-driven video, not a live path**, which is achievable with pre-buffered content. Film-Tech operators report that latency in drive-in streaming systems grew with the number of connected phones, which is the classic failure of unicast without fixed buffering.

### 2. Party, group-listening and multi-room (synchronised, buffered)

**Consumer apps.**
- **Spotify Jam / Group Session and Apple SharePlay** synchronise *control*. Each device fetches its own stream from the service. Spotify staff say there is no automatic start-together option, and users report devices drifting off-beat, one by about 42 s.
- **SharePlay** coordinates AVPlayers through `AVPlaybackCoordinator`. For live HLS it uses the `EXT-X-PROGRAM-DATE-TIME` timeline. Apple publishes no accuracy figure.
- **AmpMe** used ultrasonic chirps to measure and remove device latency ("millisecond accuracy", vendor). It claims 22,000 synced phones at a Montreal event (vendor-reported), and its FAQ says it works for pre-recorded music only, not live.
- **SoundSeeder** (Android, LAN) publishes nothing about its method.
- **Rave, Vertigo and JQBX** are watch- or listen-together tools tolerating hundreds of ms to seconds, and several are reported discontinued (unverified).

None of these is reusable (closed source) or relevant for live audio.

**Open source, browser.**
- **beatsync** (MIT, about 3.2k stars, active 2026). Uses NTP-style sync over WebSocket and Web Audio scheduling, with a Bun server and a Next.js client. The README calls mobile "experimental". The author says it "pretty much only works for the device's native speaker", and Bluetooth adds audible offset. Good proof that Web Audio-scheduled playback reaches a few ms in browsers. No live input.
- **Syncplay** (Apache-2.0) syncs mpv/VLC positions with thresholds in **seconds**: slow down to 0.95× beyond 1.75 s behind, rewind beyond 4 s. Not relevant beyond confirming that position sync is not audio sync.
- **FlanerieMozaic** (GPL-3.0, the owner's prior work). Uses `@ircam/sync` over Socket.IO and drives HTML media elements: a 20 ms update loop, a **50 ms dead band**, `playbackRate` up to ±30 %, and seeks beyond about 1 s. It does no output-latency compensation. By design, sync is therefore around ±50 ms. Media-element rate nudging is also fragile on Safari (dash.js documents Safari stalling on `playbackRate` changes with audio).

**Open source, multi-room (the strongest prior art).**

- **Snapcast** (GPL-3.0, about 8.1k stars, active Nov 2026).
  - The server timestamps PCM chunks (PCM, FLAC, Vorbis or Opus) and sends them over TCP.
  - Clients continuously sync clocks and correct drift by dropping or duplicating single samples. The README says the deviation is "typically below 0.2 ms".
  - The default `buffer` of **1000 ms is defined as end-to-end latency**.
  - Inputs include ALSA line-in, pipes, librespot, AirPlay, JACK, PipeWire and a `meta` source that mixes sources.
  - Clients: Linux, macOS, Windows, Android (Snapdroid, Oboe/AAudio), **ESP32** (CarlosDerSeher/snapclient, GPL-3.0, active, FLAC/Opus/PCM, about 758 ms buffer on WROOM modules), and **a browser player in Snapweb** (`snapstream.ts`, Web Audio, reads `outputLatency`).
  - LAN-oriented: no NAT traversal, no low-latency mode, and Bluetooth is handled as a manual per-client latency setting.

- **Sendspin** (formerly "Resonate"; Open Home Foundation; spec under the Community Specification License; reference implementations Apache-2.0; RC1 in 2026). This is Music Assistant's native protocol and the most modern design found:
  - WebSocket transport with Noise encryption and pairing.
  - Bursts of 8 or more time pings feeding a **2-D Kalman filter (offset and drift)**.
  - Binary chunks with a server-domain play timestamp and a `send_ahead` field that lets clients measure arrival-delay distributions.
  - Per-player `output_delay_ms` (0–5000 ms, persisted per output) and `required_lead_time_ms` / `min_buffer_ms` reported by the player.
  - A **spec sync floor of ±1 ms (target ±0.5 ms)**, measured against the filter's prediction rather than acoustically.
  - A `source` role so a device can capture line-in or a mic into the server, which mixes and redistributes.
  - Implementations: Python (aiosendspin), C++ (sendspin-cpp, ESP-IDF), ESPHome component, Rust, Go, a TypeScript browser client (`sendspin-js`), an Android client, a Swift kit, a Cast receiver, and a Bluetooth bridge.
  - The browser client tracks `baseLatency + outputLatency` with an EMA and falls back to a 40 ms estimate where Safari does not report it.
  - Server defaults: `min_buffer_ms = 1000` and `required_lead_time_ms = 250`.
  - **Scope is explicitly "multi-room … over a local IP network"**, with mDNS discovery and plain `ws://` plus Noise.

- **Music Assistant** (Apache-2.0) is the server that speaks Sendspin, Snapcast, AirPlay, Chromecast, Squeezelite, Sonos and more.
- **OwnTone** (GPL-2.0) drives AirPlay 1/2 multi-room.
- **iotsound (ex balena-sound)** (MIT) is a Pi image whose multi-room mode is built on Snapcast.
- **Soundsync** is archived (2023) and uses the Business Source License, so it is not reusable.
- **Strobe** (GPL-3.0, Elixir) has been inactive since 2022.

**Why this family syncs well:** a shared clock, timestamped audio, and playout scheduled at the audio driver with sample-level correction. Large buffers absorb network jitter. **Why it doesn't do live or LTE:** the large buffers themselves, LAN discovery, and TCP head-of-line blocking (harmless with 1 s of buffer, harmful at 100 ms).

### 3. Pro low-latency audio over the internet (live, point-to-point or small N, no group playout)

- **Jamulus** (GPL): server-mixed, 64- or 128-sample frames. Overall delay of about 7–13 ms on a near server (user reports). The FAQ says about 30–50 ms is the playable limit.
- **JackTrip**: uncompressed. Virtual Studio is around 17–23 ms (SFCV correction of vendor figures). A browser version uses WebRTC **data channels plus AudioWorklet** to avoid WebRTC's default de-jitter buffer, which an AES paper says pushes latency to problematic levels for music. That result supports a "custom transport + AudioWorklet" design for the live tier.
- **SonoBus / AOO** (GPL; AOO is IEM's Audio over OSC): peer-to-peer Opus or PCM with per-peer adaptive jitter buffers. Native iOS and Android apps exist. One developer report: an 11–21 ms auto jitter buffer on 5 GHz Wi-Fi. The user guide warns that Wi-Fi needs larger buffers. AOO resamples dynamically to compensate clock drift.
- **Audiomovers Listento:** a configurable 0.1–2 s buffer, with browser and mobile receivers.
- **Broadcast codecs:** Comrex ACCESS has coding delay under 25 ms (linear) or under 30 ms (Opus/FLAC), versus about 100 ms for AAC. Network jitter buffers sit on top. Tieline's auto jitter range is 60–1000 ms, with fixed buffers recommended for cellular or satellite.
- **Dante Connect / AES67 over WAN:** a fixed latency of about 20 ms on clocking zones on managed links. A public-internet AES67 proof of concept reported up to about 600 ms (AES convention paper, as summarised; not opened).
- **Cleanfeed, Source-Connect, ipDTL:** no published latency figures were found.

**Lesson:** these systems reach 10–50 ms because they own the endpoints, use wired networks or small N, and accept dropouts. They **never align N receivers to one deadline**. Each receiver adapts on its own, which is the opposite of what a loudspeaker fleet needs. Their adaptive and fixed jitter-buffer logic and Opus low-delay settings are worth reusing. Their topologies are not.

### 4. Broadcast-style and real-time CDNs (scale first)

- **Icecast / HLS webradio:** seconds of latency and no sync. HLS with 6 s segments sits at roughly 15–30 s (unverified, common practice).
- **LL-HLS:** Apple targets "two seconds or less". In practice 2–5 s (vendor estimates).
- **Sync via a shared wall-clock:** HLS `EXT-X-PROGRAM-DATE-TIME` (used by SharePlay for live) and DASH `ServiceDescription` latency targets with `playbackRate` catch-up (dash.js, MPD rate bounds 0.96–1.04). Both can give sync within tens of ms on top of seconds of latency. Safari's `playbackRate` stalls with audio are a known caveat.
- **Phenix:** under 0.5 s, with "SyncWatch" claiming sync within 100 ms across an audience of up to about 500k viewers (vendor).
- **Dolby OptiView (ex Millicast):** WebRTC at 0.2–1 s. Claims viewers are "naturally tightly synchronized" (vendor).
- **AWS IVS Real-Time:** under 300 ms, 12 publishers, and 10k subscribers per stage by default, adjustable upward.
- **nanoStream H5Live:** about 1 s, or about 0.5 s with the baseline profile.
- **Media over QUIC:** the IETF draft is at transport -20 (Aug 2026), plus moq-lite. WebTransport became Baseline when **Safari 26.4 shipped it (confirmed in WebKit release notes)**. Cloudflare runs a free technical-preview MoQ relay, and `moq-dev/moq` is the Apache-2.0 reference. Claimed latencies of 200–300 ms are vendor blog figures, and no audio-sync measurements were found.

**Why sync is loose here:** WebRTC receivers each run an independent NetEQ jitter buffer, and the spec gives no cross-receiver playout alignment. `jitterBufferTarget` (Chrome and Firefox) is only a hint and a minimum. A spread of tens of ms between viewers is therefore normal, and 100 ms "sync" is a fairness guarantee for betting and trivia, well above the roughly 10–50 ms echo threshold that matters for co-located speakers.

### 5. Research, art and Bluetooth broadcast

- **IRCAM CoSiMa / soundworks** (BSD-3, active 2026) and **@ircam/sync** (BSD-3, last push 2022) come from the same lineage as FlanerieMozaic. Lambert, Robaszkiewicz and Schnell (WAC 2016) report distributed rendering of audio events on heterogeneous HTML5 devices with **1–10 ms individual accuracy (5 ms SD)**. They also note that clock sync alone is not enough: per-device audio output latency had to be calibrated.
- **Shared Motion / Timing Object** (W3C Multi-Device Timing CG; the `mediasync.js` vendored in FlanerieMozaic comes from it) claimed under 10 ms over the internet in Chrome and Firefox (2014–2016, self-reported). It flagged iOS `playbackRate` issues.
- **Fields** (Shaw & Piquemal, NIME 2015) diffused sound across audience phones from the browser over Wi-Fi.
- An art project called "Nü" could not be identified.
- **Auracast (LE Audio broadcast).** The BIG/BIS presentation delay renders every sink at the same reference instant. Nordic's sample uses a 40 ms presentation delay, and the SIG says unlimited synchronised receivers. This is the **only technology in this survey that is FM-like on the last hop**. Limits:
  - It needs LE Audio sinks (older Bluetooth speakers will never get it).
  - Android 13–16 phones vary in support.
  - **iPhone has no native Auracast** as of WWDC26 (press; unverified against iOS 27 notes).
  - Classic ESP32 is Bluetooth Classic/BLE 4.2 and cannot do it; an nRF5340-class chip can broadcast.

## Physics sanity check: what can be promised in each tier

- **FM:** propagation is about 3.3 µs per km. Receivers are analogue (DSP tuners may add a few ms; unverified). There is no handshake, no buffer, no N-limit, and sync is within µs. **IP cannot do this.** Every IP hop is packetised, contended and buffered, and every phone OS adds an output buffer.
- **Rough budget for live audio, phone to server to phone over LTE (wired output).** Sources are cited in brackets; others are unverified estimates.
  - Capture: 5–20 ms native, 10–40 ms in the browser (unverified).
  - Opus, default 20 ms frame: 26.5 ms algorithmic delay, down to about 5 ms in low-delay mode.
  - LTE uplink plus downlink: idle RTT 18–23 ms (Ofcom/Opensignal UK 4G), so roughly 20–40 ms one-way phone to phone through a nearby relay. Uplink is the slow direction (Rohde & Schwarz).
  - Jitter buffer: it must cover the tail, not the median. Opensignal treats under 12 ms of jitter as excellent, but **loaded** latency can reach hundreds of ms (Ookla, peak hours, up to 724 ms in one market). Plan for 40–100 ms.
  - Output path: 10–40 ms wired. Classic Bluetooth adds **110–250 ms** (RTINGS, SBC/aptX) and averages about 300 ms on some Android phones (SoundGuys).
  - **Total: about 120–250 ms wired, about 250–500 ms over classic Bluetooth.** A managed Wi-Fi LAN with native apps reaches 25–60 ms, which is what the assistive-listening vendors sell.
- **Sync is a separate promise from latency.** Sync is achievable at 1–10 ms in every tier *if* all receivers share a clock and play at `capture_time + D`, with D chosen above the worst path you intend to keep. The cost of sync is that **everyone inherits the slowest receiver's latency**. Perceptually, below about 1 ms two speakers comb-filter, 1–30 ms they fuse into one image, and beyond about 30–50 ms they are heard as echoes. A same-room loudspeaker fleet therefore needs ≤10–20 ms of spread, headphone listeners do not, and co-located live sources make the phone lag audible unless listeners are far from the stage.

## Marketing vs physics

| Claim | Verdict |
|---|---|
| Mixhalo "faster than sound" | **Physics.** Under 100 ms equals 34 m of air. |
| Peex "zero latency" | True only for its dedicated RF wearable, not for phones. |
| Nubart / AmpMe "zero latency", "ms sync" | **Physics for pre-recorded content.** They achieve zero *offset* against a clock, not zero *latency*. AmpMe itself says no live. |
| OptiView "naturally tightly synchronized" WebRTC viewers | **Marketing.** No cross-receiver playout alignment exists in WebRTC. |
| Phenix "≤100 ms sync" | Plausible, but 100 ms is an echo, not sync, for co-located speakers. |
| Sendspin "microsecond sync" | The clock filter may achieve it. Acoustic output on browsers and phones is bounded by the accuracy of `outputLatency` reporting (ms) and Bluetooth (tens of ms). The spec itself only mandates ±1 ms against the filter's prediction. |
| Assistive-listening "25 ms" | Best case, unicast, on a managed LAN, wired headphones. 40–60 ms is the honest typical figure. Bluetooth breaks it, and the vendors say so themselves. |
| MoQ "200–300 ms at scale" | Vendor blogs. No independent audio benchmark was found. |

## Options compared

| Option | Axis A (buffered sync) | Axis B (live low latency) | LTE / WAN | Browser iOS + Android | ESP32 / Pi | BT handling | Licence | Reuse verdict |
|---|---|---|---|---|---|---|---|---|
| Sendspin + Music Assistant | Strong (±1 ms spec) | Weak (1 s default buffer) | Out of scope (LAN) | Yes (`sendspin-js`, outputLatency) | Yes (ESPHome, cpp) | Manual `output_delay_ms` | Apache-2.0 + Community Spec | **Adopt the design, ideally wire-compatible; extend** |
| Snapcast (+ Snapweb, ESP32 snapclient) | Strong (<0.2 ms native) | Weak | LAN, TCP | Snapweb player | Yes | Manual latency | GPL-3.0 | **Benchmark / Pi and ESP32 fallback** |
| FlanerieMozaic (@ircam/sync + media elements) | Medium (±50 ms dead band) | No | Works over internet | Yes | No | None | GPL-3.0 | Reuse UX and ops, replace the playout engine |
| beatsync | Medium–strong | No | Hosted | Experimental mobile | No | None | MIT | Read for Web Audio scheduling ideas |
| SonoBus / AOO, JackTrip, Jamulus | No group alignment | Strong (10–50 ms) | Yes | JackTrip web only | Pi yes | None | GPL | Borrow jitter-buffer and drift ideas |
| WebRTC SFU (LiveKit, mediasoup, Janus) | Weak | Medium (NetEQ not controllable across receivers) | Yes (ICE/TURN) | Yes | Pi yes, ESP32 hard | None | Apache / ISC / GPL | Fallback transport for live |
| WebTransport / MoQ (moq-dev, Cloudflare relay) | Possible | Promising | Yes | Yes since Safari 26.4 | Pi yes | None | Apache-2.0 | **Prototype for the live tier** |
| LL-HLS / DASH with PDT sync | Medium (tens of ms) | No (2–5 s) | Yes, CDN scale | Yes | Pi yes | None | — | Fallback for thousands of listeners |
| Commercial ALS (MobileConnect, Listen, WaveCAST…) | No | Strong on LAN | No | App only | No | Vendors say "avoid" | Proprietary | Learn only |
| Auracast | Inherent at last hop | Strong (~30–40 ms) | n/a | No native iOS | nRF-class only | It *is* BT | Spec | Phase-2 research: Pi/nRF rebroadcaster |

## Is there an open-source system that covers more than 70 %?

**No, not for the whole brief.** Sendspin comes closest, at about 60–70 % of axis A on a LAN. It has the right primitives:
- a Kalman clock filter;
- timestamped chunks;
- per-device output delay and lead time;
- server-side mixing of `source` inputs;
- browser, ESP32, Android and desktop players;
- a permissive licence.

What it lacks is exactly what makes this project different: cellular/WAN operation through a hosted relay (its scope is a local network), a low-latency live profile, explicit Bluetooth measurement, and iOS web realities. Snapcast is the mature GPL sibling and the best benchmark. Recommendation: **do not invent a new clock and timestamp protocol.** Build a WAN relay plus a live tier plus calibration around Sendspin's model, and keep wire compatibility with Sendspin where feasible so ESP32 and Pi clients come for free. Contribute upstream what fits their scope.

## Recommendation

1. **Phase-1 core (axis A over LTE):** a hosted relay that speaks a Sendspin-compatible protocol over `wss://`. Start from aiosendspin or a TypeScript or Go port, and use `sendspin-js` (or a fork) as the web player. Measure it on LTE before writing new code. Keep FlanerieMozaic's Socket.IO and control UX ideas, but replace media-element nudging with Web Audio / AudioWorklet scheduled playout.
2. **Live tier (axis B):** prototype **WebTransport datagrams (Baseline in 2026) + Opus 10 ms frames + AudioWorklet**, with a **declared global playout deadline D** stamped by the sender's synced clock. Use WebCodecs `AudioDecoder` where it exists and WASM libopus elsewhere. Safari support for WebCodecs audio is unverified. Use a WebRTC SFU (LiveKit, Apache-2.0) only as the fallback, because its receivers cannot be aligned.
3. **Embedded:** reuse the ESP32 Sendspin or Snapcast clients and do not write a new ESP32 player. USB tethering to a phone is a transport detail.
4. **Bluetooth (phase 2):** an explicit research track with three steps: (a) trust `outputLatency` where the OS reports it; (b) acoustic calibration with the phone mic (chirp loopback), stored as `output_delay_ms`; (c) explore Auracast rebroadcast from a Pi or nRF5340 node for LE Audio sinks.
5. **Rule out:** party apps and SharePlay or Jam (closed, control-only sync); Icecast or plain HLS for anything live; Dante, AES67 or NDI (PTP on a LAN, not phones or LTE); commercial assistive-listening products (closed, LAN, app-only); and writing a new clock-sync algorithm.

## Proposed experiments

1. **E1: LAN sync baseline.**
   - Goal: establish what each existing engine achieves.
   - Method: the same Wi-Fi network; Snapcast (Pi native + ESP32 + Snapweb), Sendspin (Music Assistant + `sendspin-js` + ESP32) and FlanerieMozaic on 2 Android + 2 iOS phones + 1 Pi + 1 ESP32, all wired out. Record every output on a multichannel interface playing a click track and cross-correlate.
   - Pass: native ≤1 ms p95, browser ≤5 ms p95. FlanerieMozaic is measured as the reference.
2. **E2: Sendspin over LTE.**
   - Goal: test whether the LAN design survives cellular.
   - Method: put the server behind a TLS reverse proxy in a cloud region; phones on two operators; buffers of 250, 500 and 1000 ms. Log the `send_ahead` arrival-delay distribution, underruns and sync error.
   - Pass: ≤5 ms p95 sync and under 1 underrun per 10 min at ≤500 ms buffer.
3. **E3: live-tier transport shoot-out.**
   - Goal: choose the live transport.
   - Method: WebRTC SFU vs WebTransport datagrams + Opus 10 ms + AudioWorklet with deadline D, sender phone on LTE, 5 receivers. Measure mouth-to-ear (acoustic loopback) and inter-receiver spread.
   - Pass: ≤150 ms p95 mouth-to-ear with wired outputs, ≤10 ms p95 spread, under 1 audible glitch per minute.
4. **E4: Bluetooth compensation.**
   - Goal: decide whether OS-reported latency is enough.
   - Method: 6 Bluetooth speakers/headsets × Android Chrome, iOS Safari and native. Compare reported `outputLatency` with the measured acoustic delay, then apply chirp calibration.
   - Pass: residual ≤20 ms with reported values only, ≤5 ms after calibration, stable across reconnects.
5. **E5: iOS web survival.**
   - Goal: test whether a web player is viable on iPhone.
   - Method: a 30 min session with the screen locked, app switching and a call interruption, on both tiers.
   - Pass: audio resumes in sync within 2 s, or it fails and justifies a native app.
6. **E6: scale.**
   - Goal: estimate relay cost and capacity.
   - Method: simulated receivers (headless) on the relay at 100 and 1000 connections.
   - Pass: relay CPU and egress figures documented; per-receiver cost in € per hour.

## Open questions (owner decisions)

1. The live tier's target: is about 200 ms over LTE acceptable? Will the live source be acoustically audible to the listeners, which makes the phone lag audible?
2. The target fleet size per show (10, 100 or 1000+), which decides between a self-hosted relay and LiveKit/MoQ/CDN.
3. Licence of the new public repo. Apache-2.0 allows tight reuse of Sendspin; using Snapcast or FlanerieMozaic code implies GPL-3.0.
4. Should the project aim for **Sendspin wire compatibility** (ecosystem, ESP32 for free, upstream politics) or keep its own protocol inspired by it?
5. Is a native iOS/Android app acceptable for Bluetooth calibration and background playback, or must it be web-only?
6. ESP32 hardware targets: classic ESP32 has BR/EDR Bluetooth, S3 has BLE only. I2S DAC output or USB to a phone?
7. Phase 2: is it acceptable to require LE Audio (Auracast) speakers for tight Bluetooth sync, given there is no native iOS support?

## Sources

Open-source systems
- Snapcast README: https://github.com/snapcast/snapcast
- Snapcast configuration, buffer = end-to-end latency: https://sources.debian.org/src/snapcast/0.34.0-2/doc/configuration.md
- Snapweb browser player: https://github.com/snapcast/snapweb (src/snapstream.ts)
- ESP32 Snapcast client: https://github.com/CarlosDerSeher/snapclient
- Sendspin site: https://www.sendspin-audio.com
- Sendspin spec (messaging.md, roles/player/v1.md, roles/source/v1.md, SCOPE.md): https://github.com/Sendspin/spec
- sendspin-js (output-latency-tracker.ts): https://github.com/Sendspin/sendspin-js
- aiosendspin (player defaults): https://github.com/Sendspin/aiosendspin
- ESPHome Sendspin: https://esphome.io/components/sendspin/
- Music Assistant: https://github.com/music-assistant/server
- beatsync: https://github.com/freeman-jiang/beatsync and https://hn.jakechampion.name/item/43835584
- Syncplay constants: https://github.com/Syncplay/syncplay
- OwnTone: https://github.com/owntone/owntone-server
- iotsound: https://github.com/iotsound/iotsound
- Soundsync (archived, BSL): https://github.com/geekuillaume/soundsync
- Strobe: https://github.com/strobe-audio/strobe-hub
- FlanerieMozaic: https://github.com/Hemisphere-Project/FlanerieMozaic
- @ircam/sync: https://github.com/ircam-ismm/sync
- soundworks: https://github.com/collective-soundworks/soundworks
- LiveKit, mediasoup, Janus, MoQ: https://github.com/livekit/livekit, https://github.com/versatica/mediasoup, https://github.com/meetecho/janus-gateway, https://github.com/moq-dev/moq

Assistive listening and venue audio
- Sennheiser MobileConnect: https://sennheiser.com/en-us/catalog/products/bi-directional-communication/mobileconnect and https://www.bhphotovideo.com/c/product/1171638-REG/sennheiser_506735_mobile_connect_wifi_based_low_latency.html
- Listen Technologies latency: https://www.listentech.com/understanding-latency-what-it-is-and-why-it-matters/
- Listen EVERYWHERE network guide: https://www.rentex.com/wp-content/uploads/2020/05/Listen-Everywhere-Network-Guide.pdf
- ListenWIFI app: https://apps.apple.com/ae/app/listenwifi/id1391914337
- WaveCAST spec: https://www.fullcompass.com/common/files/37353-WaveCASTWFT5SpecificationSheet.pdf
- AudioFetch Lite spec: https://www.pacificav.co.nz/wp-content/uploads/2018/08/AudioFetch-Lite-NE-Spec-Sheet.pdf
- Bettear flyer: https://issuu.com/madisonav/docs/bettear_2pp_flyer_aug_24
- Mixhalo patent: https://patentsgazette.uspto.gov/week35/OG/html/1538-1/US12405765-20250902.html
- Mixhalo review: https://www.controlgeek.net/blog/2020/6/12/mixhalo-wireless-phone-audio
- DeepL acquires Mixhalo: https://techcrunch.com/2026/06/17/deepl-acquires-mixhalo-for-live-event-audio-streaming-and-translation
- Peex: https://www.engadget.com/2019/03/13/peex-live-concert-headphones-elton-john/
- LiveVoice: https://livevoice.io/en/simultaneous-interpretation
- Interprefy delay: https://ai-knowledge.interprefy.com/what-is-the-sound-delay-between-the-speaker-and-the-interpretation.md
- Interactio review: https://meetings.skift.com/reviews/interactio-translation-app-review/
- Vox Connect: https://apps.apple.com/us/app/vox-connect/id1499323695
- Nubart Sync: https://blooloop.com/technology/in-depth/nubart-sync/
- Cinewav: https://cinewav.odoo.com/audio-solution-for-drive-ins
- Film-Tech thread: https://www.film-tech.com/ubb/f16/t003600.html

Group listening
- AmpMe FAQ: https://ampme.com/faq
- SharePlay: https://developer.apple.com/videos/play/wwdc2021/10225 and https://developer.apple.com/forums/thread/710748
- Spotify group-session sync: https://community.spotify.com/t5/Android/Group-Session-is-off-beat-between-listeners/m-p/5238899/highlight/true

Pro network audio
- SonoBus: https://sonobus.net/sonobus_userguide.html and https://groups.google.com/g/sonobus-users/c/mT_dKDOwDzA
- AOO: https://soundingfuture.com/en/article/aoo-low-latency-peer-peer-audio-streaming-and-messaging
- Jamulus: https://jamulus.io/wiki/Software-Manual and https://jamulus.io/wiki/FAQ
- JackTrip FAQ: https://support.jacktrip.com/virtual-studio-frequently-asked-questions-faqs
- JackTrip latency (SFCV): https://www.sfcv.org/music-news/new-tech-makes-a-virtual-ensemble-possible
- JackTrip-WebRTC paper (not opened, 403): https://iris.polito.it/bitstream/11583/2974022/1/JackTrip_WebRTC_Journal.post-print.pdf
- Audiomovers Web Transmitter guide: https://audiomovers.com/storage/pdfs/WebTransmitterUserGuide.pdf
- Comrex ACCESS manual: https://www.comrex.com/wp-content/uploads/2016/02/ACCESS-Rackmount-Manual-1.pdf
- Tieline ViA manual: https://www.manualslib.com/manual/1305006/Tieline-Via.html?page=153
- Dante over WAN: https://clear-com.atlassian.net/wiki/spaces/SF/pages/617938988/Using+Dante+DDM+Clocking+Zones+and+AES67+over+WAN

Broadcast and CDN
- Phenix: https://www.phenixrts.com/docs/getting-started/real-time-use-cases/
- Dolby OptiView: https://optiview.dolby.com/resources/blog/streaming/how-to-ensure-viewer-synchronization-for-live-sports/
- AWS IVS quotas: https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/service-quotas.html
- AWS IVS launch: https://aws.amazon.com/blogs/aws/new-deliver-interactive-real-time-live-streams-with-amazon-ivs
- nanocosmos latency modes: https://documentation.nanocosmos.de/docs/nanoplayer/nanoplayer_feature_latency_control_modes
- Apple LL-HLS: https://developer.apple.com/wwdc20/10228 and https://developer.apple.com/wwdc19/502
- dash.js low latency: https://dashif.org/dash.js/pages/usage/low-latency.html
- MoQ transport draft: https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
- Cloudflare MoQ: https://blog.cloudflare.com/moq/
- Safari 26.4 WebTransport: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- WebRTC jitterBufferTarget: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget

Browser audio, research, Bluetooth, networks, perception
- outputLatency (MDN): https://developer.mozilla.org/docs/Web/API/AudioContext/outputLatency
- outputLatency (caniuse): https://caniuse.com/mdn-api_audiocontext_outputlatency
- Audio output latency (web.dev): https://web.dev/articles/audio-output-latency
- Lambert, Robaszkiewicz, Schnell, WAC 2016: https://repository.gatech.edu/entities/publication/1f9d9d03-57b1-438d-a7b2-6a4f7c468119 and https://lists.w3.org/Archives/Public/public-webtiming/2016Mar/0003.html
- Shared Motion / Timing Object: https://lists.w3.org/Archives/Public/public-web-and-tv/2014Dec/0002.html and https://timingsrc.readthedocs.io/en/latest/sync/mediasync.html
- Fields (NIME 2015): https://nime.org/proc/nime2015_tshaw/
- CoSiMa: https://cosima.ircam.fr/
- LE isochronous channels FAQ: https://www.bluetooth.com/blog/10-frequently-asked-questions-on-le-isochronous-channels/
- nRF Auraconfig: https://nrfconnectdocs.nordicsemi.com/ncs/latest/nrf/samples/bluetooth/nrf_auraconfig/README.html
- Android audio sharing (Auracast missing on iOS 26): https://www.slashgear.com/1998370/how-to-use-android-audio-share-multiple-bluetooth
- Bluetooth latency: https://www.rtings.com/headphones/learn/latency and https://soundguys.com/android-bluetooth-latency-22732
- Ofcom/Opensignal 4G latency: https://www.ispreview.co.uk/index.php/2025/07/ofcom-study-examines-uk-speed-and-coverage-of-4g-and-5g-mobile-networks.html
- Ookla peak-hour loaded latency: https://www.ispreview.co.uk/index.php/2026/05/ookla-examine-impact-of-peak-time-uk-and-eu-mobile-network-congestion.html
- Rohde & Schwarz one-way latency: https://www.rohde-schwarz.com/se/_255963.html
- Precedence and comb filtering: https://beatkitchen.io/guides/mix-primer/21-delay/ and https://www.l-acoustics.com/wp-content/uploads/2022/07/AES152_Moulin-22-comb-filtering-HF.pdf
