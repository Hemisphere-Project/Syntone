# 03 — Low-latency live transport (axis B, phone-to-phone over LTE first)

*Research note. State of the art checked on 2026-11-20. Numbers carry their source. Claims I could not check on the web are marked **(unverified)**.*

## Question

A live line or mic input goes from a sender (a phone, or a Raspberry Pi with a USB interface) through a web-hosted relay to a mixed fleet of receivers: phones in a browser or app, Pi, ESP32. How do we get a **low, fixed and identical** mouth-to-ear latency on every receiver over LTE, with little jitter? What does each stage cost in milliseconds? Which transport should we build on: WebRTC + SFU, WebTransport/WebCodecs/MoQ, WebSocket, or native protocols? What does it cost per listener?

## TL;DR

- **Over LTE, phone → cloud → phone cannot be "FM-like" (≈0 ms).** In a browser with a jitter buffer that survives LTE, the realistic floor is about **110–200 ms for one well-placed receiver**. A **whole fleet that must play together** needs a common target of **≈200–400 ms**. On venue WiFi or LAN with native clients, 30–80 ms is reachable. Bluetooth output adds 100–300 ms; that is phase 2.
- **LTE turns loss into delay.** Radio retransmissions (HARQ/RLC) mean IP packets rarely get lost; they arrive late or in bursts. Handovers interrupt for ~25–50 ms, with tails of 80–100 ms. Uplink scheduling adds ~10–20 ms, and a busy uplink can queue for 100s of ms. So **the jitter-buffer depth (the target latency `L`) is THE quality/latency knob**. Opus frame size and FEC/RED are second-order.
- **Stock WebRTC gives low latency per receiver, not a shared latency.** NetEq adapts each receiver on its own and time-stretches (built for speech). `RTCRtpReceiver.jitterBufferTarget` is now available in all three engines: Chrome 124, Firefox 115 and **Safari 27 (Sept 2026)**. But it only sets the *buffer* part, and receivers still differ by their network and output-path delays. The `playout-delay` RTP extension is applied to video only (LiveKit docs: "These values apply only to video. Audio buffering is automatic").
- **To get synchronised, controlled playout, own the playout.** Stamp every Opus frame with a capture time in a shared server clock. Every receiver plays it at `captureTime + L`, using an AudioWorklet scheduled against `AudioContext.getOutputTimestamp()`/`outputLatency`, with small resampling to absorb clock drift. This is the Snapcast / AES67 / Dante model; FlanerieMozaic's IRCAM clock sync can be reused as is. Every browser part now exists: WebCodecs `AudioDecoder` (Chrome 94, Firefox 130, **Safari 26**), AudioWorklet everywhere, **WebTransport in Safari 26.4** (Baseline since March 2026). A WASM Opus decoder covers older iOS.
- **Transport recommendation:** a small custom relay, with **WebTransport datagrams as the main path and WebSocket (TCP/443) as the fallback**, carrying the same timestamped frame format. Native UDP/QUIC carries the same format for Pi/ESP32. Keep a stock LiveKit/mediasoup set-up only as a one-day **baseline**. An interesting middle path keeps WebRTC as the transport but reads frames through `RTCRtpScriptTransform` (Chrome 141, Firefox 117, Safari 15.4) and bypasses NetEq.
- **MoQ is promising but not yet a foundation for a 2-person studio.** The spec moved from draft‑14 to draft‑19 during 2026. Cloudflare's relay is still in beta (drafts 14/16/18), and moq.dev runs its own moq‑lite 01–05. Design the frame format so that moving to it later is cheap.
- **Cost is negligible.** About 120–180 kbps per listener (Opus stereo 96–128 kbps plus packet overhead) is **≈55–80 MB per listener-hour**. That is ≈ $0.003/listener-hour on Cloudflare Realtime ($0.05/GB, first 1,000 GB/month free) and almost free on a self-hosted VPS. 1,000 listeners ≈ 120–180 Mbit/s egress.

## Findings

### 1. LTE: what the network really does

| Quantity | Value | Source |
|---|---|---|
| LTE median RTT / RTT jitter | 69.5 ms / 5.6 ms (US, 2012) | Huang et al., MobiSys 2012 |
| 4G average latency in France (2025) | ~35 ms; 5G NSA ~22 ms (nPerf, via secondary article) | tech-insider.org **(secondary)** |
| LTE uplink one-way, good radio | ~36 ms for 90 % delivery, ~40 ms for 99 % (WiFi needed ~80 ms for 99 %) | Aalborg, arXiv 2108.03035 |
| Uplink scheduling-request → grant → data | 17–24 ms modelled; live median ~30 ms, floor ~10 ms | arXiv 2211.08298 and refs |
| Handover data interruption | spec target <50 ms (known cell), 130 ms (unknown cell); measured 24–29 ms average, median ~50 ms, tails 80–100 ms | Aalborg mobility papers; patents |
| On-device uplink bufferbloat | queuing up to 400 ms at 8 Mbit/s uplink; up to 4 s under load | "Understanding On-device Bufferbloat for Cellular Upload" |
| SRT over 4G | average RTT ~150 ms; the usual 3–4×RTT latency rule "will not reliably cover" delay swings, so 5–8×RTT was tested | Innovation Labs SRT-over-4G study |
| Loss behaviour | with RLC acknowledged mode, weaker coverage mainly raises delay and jitter, with almost no loss up to the coverage limit | HAL hal-01574796 (abstract) |

Consequences:

- **Jitter is bursty.** Packets arrive in bunches after a handover or a scheduling stall. A buffer sized from the *median* jitter fails a few times a minute. You must size it from the p99.9 delay spread over a walk, a crowd or a handover. Experiment E1 measures this.
- **The sender's uplink is the single point of failure.** Every listener depends on it. Keep other uploads off the sender phone; at ~150 kbit/s audio does not cause bloat itself. On a Pi sender, consider **sending each frame twice over two paths** (two SIMs, or WiFi + LTE) and letting the relay drop duplicates by sequence number (the SMPTE 2022‑7 idea).
- **Carrier NAT is mostly a non-issue with a relay.** Phones connect *out* to a server with a public IP. What matters is **UDP being blocked** (some venue or corporate WiFi), so you need a TCP/TLS 443 fallback. Old Chrome telemetry: 12.1 % TURN/UDP, 5 % TURN/TCP, <0.5 % TURN/TLS (fippo, ~2017). TCP fallback costs ~20–40 ms extra (vendor estimate).
- **Server placement:** put the server in the same region as the carriers' internet exits: Paris or Frankfurt for French operators, or an anycast edge such as Cloudflare. The detour should then be ~5–15 ms **(unverified, typical)**.

### 2. Opus: the per-frame cost

- Algorithmic delay = frame + lookahead. The default is **26.5 ms at 20 ms frames** (6.5 ms lookahead). CELT restricted-low-delay goes down to **5 ms at 2.5 ms frames**. Frame sizes: 2.5/5/10/20/40/60 ms (CELT 2.5–20, SILK 10–60, hybrid 10/20) (Opus docs / Wikipedia).
- **The browser's WebRTC Opus encoder cannot go below 10 ms.** libwebrtc's `kOpusSupportedFrameLengths = {10, 20, 40, 60, 120}`. `a=ptime` is rounded up to the next supported length, and `maxptime` does not set the frame length. Stereo selects `kAudio` mode and mono `kVoip`. Defaults: 32 kbit/s mono / 64 kbit/s stereo fullband. Parsed fmtp: `stereo`, `maxaveragebitrate`, `cbr`, `useinbandfec`, `usedtx`, `ptime`, `minptime/maxptime`, `maxplaybackrate` (`audio_encoder_opus.cc`).
- Music settings for WebRTC:
  - capture: `getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:2}})`
  - SDP fmtp: `stereo=1; sprop-stereo=1; maxaveragebitrate=96000–128000; usedtx=0; cbr=1` (constant packet size helps pacing), plus `a=ptime:10` when every ms counts.
  - **In-band FEC (LBRR) is a SILK-layer feature.** Fullband stereo music at ≥64 kbit/s runs in CELT mode, so `useinbandfec=1` protects little **(unverified in practice; follows from RFC 6716's design)**. **RED (RFC 2198)** is the redundancy that actually covers music: distance 1 doubles payload, and distance 2 performed much better under heavy loss (webrtcHacks).
  - **DRED** (Opus 1.5, much improved in 1.6, Dec 2025) is a neural speech coder for 200 ms+ bursts. It is not meant for music.
- Opus 1.6 (Dec 2025; 1.6.1 since) adds 96 kHz, a 24-bit API and a BWE module (opus-codec.org).
- Outside WebRTC, through WebCodecs `AudioEncoder` or WASM/native libopus, you keep access to **2.5/5 ms CELT frames**. On LAN that saves 10–20 ms. On LTE it buys little and multiplies packet overhead (see costs).

### 3. WebRTC + SFU: what you can and cannot control

**What exists in browsers today (MDN browser-compat-data, read 2026‑11‑20):**

| API | Chrome | Firefox | Safari | Use for sync |
|---|---|---|---|---|
| `RTCRtpReceiver.jitterBufferTarget` (0–4000 ms, a hint) | 124 | 115 | **27** | sets a common buffer floor |
| `getSynchronizationSources()` (`timestamp`, `rtpTimestamp`) | 73 (rtpTimestamp 76) | 59 (72) | 12.1 (**no rtpTimestamp**) | "RTP ts X played at local T" |
| `captureTimestamp` / `senderCaptureTimeOffset` (needs `abs-capture-time`) | shipped (intent: M82/M83; exact milestone unverified) | not found | not found | sender-clock capture time |
| `RTCRtpScriptTransform` (encoded transform) | **141** | 117 | 15.4 | carry own timestamps; tap frames |
| `RTCEncodedAudioFrame.getMetadata().rtpTimestamp` | 127 | 145 | 26 | |
| `inbound-rtp.estimatedPlayoutTimestamp` | partial (populated with A/V sync) | ? | ? | sender-NTP time of the sample now playing |

How the jitter buffer behaves:

- **NetEq** keeps a 20 ms-bucket histogram of arrival delays and targets a quantile (0.95 in the worked example). It forgets slowly (factor 0.983: ~3.5 s to drop from 140 ms to 20 ms). It reaches the target by **accelerate / preemptive-expand time-stretching**, which is designed for speech (webrtcHacks).
- One Chrome bench against Cloudflare Realtime measured NetEq at **~40 ms p50 ("floor about 40 ms")**. The stage breakdown was: Opus 20 ms + lookahead ~26, network+SFU ~12, buffer ~40. End to end was 170 ms p50 by default and **103 ms after switching to 10 ms ptime and removing a Web Audio hop**, *excluding* ~45–60 ms of output device latency (ralph‑meet PR #91; a single developer's bench, but well instrumented). An older peer-reviewed black-box study found ~150 ms mouth-to-ear in Chrome, with 20 ms frames the optimum (Komperda et al., 2016).
- **`jitterBufferTarget`** "influences … but does not directly set" the buffer (MDN). It is the old `playoutDelayHint`, renamed. In Chrome it works as a minimum-delay floor **(unverified detail)**. It now ships in Safari 27 (release notes: "Added support for RTCRtpReceiver.jitterBufferTarget").
- **`playout-delay` RTP header extension:** min/max in 10 ms steps, 0–40.95 s, "best effort" (libwebrtc doc). LiveKit's docs state it applies **only to video**.
- **`abs-capture-time`:** a 64-bit NTP capture timestamp, plus an optional capture-clock offset, sent about once a second. It is designed to survive mixers (libwebrtc doc). Mostly used by Google Meet (rtcbits).

**What that means for a fleet.** With every receiver set to `jitterBufferTarget = 200`, all of them buffer roughly 200 ms. Their end-to-end delays still differ by:
- downlink delay (±10–40 ms between carriers or cells),
- the output path (±10–50 ms between Android models; Chrome on Android adapts its WebAudio buffering per device, Chrome 136 note),
- NetEq's own adaptation.

Expected pairwise spread: **tens of ms, drifting** **(unverified estimate; E2 measures it)**. That is fine for isolated headphone listeners and audible as echo for phones sharing a room. A **closed loop is possible on Chrome/Firefox**:
1. The sender publishes an RTP-ts → shared-clock mapping, via an encoded-transform trailer or a data channel.
2. Each receiver reads `getSynchronizationSources()` (`rtpTimestamp` + local `timestamp`), adds `outputLatency`, and nudges `jitterBufferTarget` towards a common `L`.

It cannot be done on Safari, which lacks `rtpTimestamp` there. Accuracy is limited by 10 ms frame granularity and NetEq stretching.

**SFUs** (all active in Nov 2026):

| SFU | Licence | Notes |
|---|---|---|
| LiveKit | Apache‑2.0 | Go/Pion. Built-in TURN/TLS on 443. "Lossy" data packets relayed. Benchmark: 10 publishers → **3,000 audio subscribers on 16 cores at 80 % CPU, 23 MB/s out** |
| mediasoup | ISC | C++ worker, Node/Rust API. Unreliable `DataProducer`/`DataConsumer`. Most control, most code to write |
| Janus | GPL‑3.0 | C. Streaming plugin; abs-capture-time discussed for it |
| Galène | MIT | Small Go SFU, easy to self-host |
| MediaMTX | MIT | Gateway. Publish/read via WebRTC, RTSP, RTMP, SRT, HLS, RTP, and **Media‑over‑QUIC since v1.19/1.20 (drafts 16/17)**. Converts protocols automatically: ideal glue for Pi/RTSP/SRT |
| Cloudflare Realtime SFU | managed | **$0.05/GB egress, first 1,000 GB/month free** (shared with TURN) |
| ion-sfu | MIT | **inactive since 2023**, rule out |

### 4. Bypassing NetEq: own jitter buffer and playout

Parts and support:
- **WebCodecs `AudioDecoder`/`AudioEncoder`:** Chrome 94, Firefox 130, Safari 26 (release notes: "Added support for WebCodec's AudioEncoder and AudioDecoder"). Opus support on iOS Safari must be checked with `isConfigSupported` **(unverified)**.
- **WASM fallback:** a libopus build such as `wasm-audio-decoders` (`opus-decoder`).
- **AudioWorklet** (Safari 14.1+), `getOutputTimestamp()` (Safari 14.1), `outputLatency` (Safari 18.4).

Transports for the encoded frames:
- **WebRTC data channel, unreliable** (`ordered:false, maxRetransmits:0`): every browser, every iOS version, works through SFUs (LiveKit lossy data, mediasoup DataConsumers), ICE/TURN included.
- **WebTransport datagrams:** Chrome 97, Firefox 114, **Safari/iOS 26.4** (March 2026). `serverCertificateHashes` is supported in Safari 26.4 too, so an **offline venue server (a Pi) can serve WebTransport with a self-signed short-lived certificate**. Gaps:
  - no WebRTC-grade congestion control or audio processing (webrtc.ventures);
  - the `congestionControl:"low-latency"` option is not yet in Chrome stable (BCD);
  - QUIC on UDP 443 can be blocked, so a fallback is needed.
- **Receiver-side `RTCRtpScriptTransform`:** take the Opus frames as they arrive from WebRTC (SRTP, ICE, TURN and SFU fan-out all reused). Decode them with WebCodecs and schedule them yourself. Do not attach the track to an `<audio>` element, so NetEq's output stays silent. The sender transform appends an 8-byte shared-clock capture time; E2EE-style trailers already pass through LiveKit and mediasoup **(unverified for each SFU)**. Supported in Chrome 141+, Firefox 117+, Safari 15.4+.

The playout algorithm is the same for all three. It is also what Snapcast does (server-stamped chunks, a fixed end-to-end buffer of **1000 ms by default**, drift fixed by inserting or dropping single samples), and what the ESP32 Snapcast client does (Opus/FLAC/PCM over I2S, up to 758 ms buffer on WROOM modules):

```
on frame(seq, t_capture, opus):  buffer[seq] = decode(opus)       // or keep encoded, decode just in time
each render quantum:            t_out = syncClock(ctx.getOutputTimestamp()) + outputLatency
                                play samples whose t_capture + L == t_out   // fractional resampler, ±200–500 ppm
                                missing frame → Opus PLC (or FEC/RED copy); too late → drop
```

- **Clock sync** is FlanerieMozaic's existing `@ircam/sync` (NTP-like, minimum-RTT filtering) over the same connection. Its media-element loop (20 ms ticks, 50 ms dead band, rate change up to ±30 %, seeks above 1 s) is *not* reusable for live audio. Its clock *is* reusable.
- On LTE, uplink and downlink delays differ, which biases the offset by roughly half the difference: a few ms up to ~10 ms **(unverified; E6)**.
- **Audio clock drift** between devices: typical crystal tolerance of tens of ppm **(unverified, typical)**. 50 ppm is 3 ms per minute, 180 ms per hour. Without the resampler, sync is lost within minutes.

### 5. WebSocket (TCP) + Opus + AudioWorklet

- It works everywhere, through every proxy and captive portal, on TCP/443, with the simplest server.
- A lost segment blocks everything behind it. At 50–100 packets/s, fast retransmit kicks in after 3 duplicate ACKs (~30–60 ms) plus one RTT, so a stall of **~100–150 ms**. A retransmission *timeout* (Linux minimum RTO 200 ms) means ≥250 ms **(unverified, standard TCP behaviour)**.
- Because LTE hides most losses below IP, TCP over LTE is **good enough when `L` ≥ ~300–400 ms**. That covers axis A, the "safe" live profile, and the fallback path. Safari 26 also supports WebSocket over HTTP/2 and HTTP/3; head-of-line blocking within one stream remains.

### 6. Media over QUIC (MoQ), Nov 2026

- IETF `draft-ietf-moq-transport` reached ‑18 (May 2026) and ‑19 (by July 2026), with Working Group Last Call targeted (secondary sources).
- **Cloudflare MoQ relay:** launched Aug 2025 on 330+ cities, now **beta, free** with per-relay tokens. Recommends draft‑18; draft‑14/16 endpoints remain. The 2025 launch post said self-serve pricing would be $0.05/GB once generally available.
- **moq.dev** (Apache‑2.0/MIT): moq‑relay (clustered), Rust/TS libraries (`@moq/publish`, `@moq/watch`), `hang` container, Opus/AAC in `moq-mux`. It speaks moq‑lite 01–04 (05 announced) plus IETF drafts 14–18. Bindings are labelled alpha.
- MediaMTX publishes and reads MoQ since v1.19. Ant Media (April 2026) still said its MoQ player is Chromium-only.
- **Verdict:** the architecture is the right shape (pub/sub of timestamped objects with partial reliability, CDN fan-out). But the wire format is still changing, and a small team would spend its time tracking drafts. Use plain WebTransport now. Revisit MoQ as the **fan-out layer** if one show needs more than a few thousand listeners.

### 7. Native / Pi / ESP32 options

| Option | Licence | Latency class | Fit |
|---|---|---|---|
| RTP/Opus (GStreamer/ffmpeg) | LGPL | `rtpjitterbuffer` latency configurable (tens of ms on LAN) | simplest Pi receiver/sender; no NAT help |
| SRT | MPL‑2.0 | default 120 ms, ≥2.5–4×RTT; 5–8×RTT on 4G (≈0.6–1.2 s) | **Pi → server contribution** only; no browser |
| RIST | BSD (librist) **(unverified)** | ARQ, similar to SRT | same niche, smaller ecosystem |
| Icecast/HLS | GPL / — | seconds (HLS 15–30 s, LL‑HLS ~3 s per Cloudflare) | axis A baseline only |
| Snapcast (+ snapdroid, ESP32 snapclient) | GPL‑3.0 | default 1000 ms end to end, fixed, synchronised | **reference design** for synced playout; LAN/WiFi |
| Roc Toolkit | MPL‑2.0 | "guaranteed latency", FEC, clock-domain conversion | good Pi/Linux receiver (PipeWire modules) |
| AOO (Audio over OSC) | custom | ms on LAN; timestamped streams, dynamic resampling | library behind SonoBus; Pd/SC/Max |
| SonoBus | GPL‑3.0 | ms; peer-to-peer mesh, Opus or PCM, **no encryption** | musicians, not 1→N |
| JackTrip / Jamulus | open source (licences not checked) | ~10–50 ms on wired links **(unverified)** | needs native clients and low-jitter links; rule out on LTE |
| VBAN | open protocol | uncompressed PCM UDP, LAN | quick ESP32 LAN demo only |
| NDI audio / Dante (Connect) | proprietary | LAN / broadcast cloud | rule out |

**ESP32:**
- Opus decode at 48 kHz plus UDP plus I2S works on classic ESP32/S2. The Snapcast client proves it, though it is GPL‑3, which matters if code is reused.
- Plain UDP datagrams carrying the same frame format are enough. Correct drift by trimming the APLL/I2S clock or by inserting/dropping samples.

### 8. Glass-to-glass budget (ms)

| Stage | Stock browser WebRTC over LTE | **Synced fleet, own playout, LTE** | Native Pi/ESP32 on venue WiFi |
|---|---|---|---|
| Capture (ADC + OS + engine) | 10–40 **(unverified)** | 10–40 | 3–10 |
| Encode (frame + lookahead) | 26.5 (20 ms) / 16.5 (10 ms) | 16.5 (10 ms) or 26.5 | 5–7.5 (2.5–5 ms CELT) |
| Uplink radio | 15–40 typ., p99 80–150+ | same | 2–10 |
| Core → relay → core | 5–20 | 5–20 | 0–5 |
| Downlink radio | 10–30 typ., p99 60–100+ | same | 2–10 |
| Jitter buffer | NetEq adaptive ~40–120 | **slack = L − rest** | 10–30 |
| Decode | <1 | <1 | <1 |
| Output (mixer + DAC) | 20–100 per device **(unverified)** | measured, compensated | 3–15 |
| **Total** | **~110–300, different per receiver** | **fixed L = 200–400, identical** | **30–80** |

For scale: 3 ms of latency is about 1 m of sound travel. 300 ms is like standing ~100 m from a loudspeaker. If listeners can also hear the live source acoustically, anything above ~20–30 ms sounds like an echo. That changes the dramaturgy rather than the engineering.

### 9. Bandwidth and cost per listener

Packet overhead ≈ 62 B per packet (IPv4 20 + UDP 8 + RTP 12 + SRTP tag 10 + extensions ~12). IPv6 adds 20 B. WebSocket/TLS/TCP costs about the same.

| Profile | Payload | Packets/s | On the wire | MB per listener-hour |
|---|---|---|---|---|
| 20 ms, 64 kbit/s | 160 B | 50 | ~89 kbit/s | ~40 |
| 20 ms, 96 kbit/s stereo | 240 B | 50 | ~121 kbit/s | ~54 |
| 10 ms, 128 kbit/s stereo | 160 B | 100 | ~178 kbit/s | ~80 |
| 10 ms, 128 kbit/s + RED (distance 1) | ~325 B | 100 | ~310 kbit/s | ~139 |
| 5 ms CELT, 128 kbit/s (native) | 80 B | 200 | ~227 kbit/s | ~102 |

| Listeners | Egress at 121 kbit/s | Per show-hour | Cloudflare Realtime ($0.05/GB) | LiveKit Cloud **(pricing unverified)** | Self-host VPS |
|---|---|---|---|---|---|
| 10 | 1.2 Mbit/s | 0.54 GB | free tier | ~$0.30 (minutes) | any €5 VPS |
| 100 | 12 Mbit/s | 5.4 GB | $0.27 (or free) | ~$3 | €5–20 VPS |
| 1,000 | 121 Mbit/s | 54 GB | $2.70 (or free) | ~$30 + bandwidth | 4–8 vCPU, 1 Gbit/s; EU Hetzner includes 20 TB/month, ~€1/TB beyond |

Notes:
- LiveKit Cloud bills participant-minutes ($0.0004–0.0005/min, so ≈ $0.024–0.03 per listener-hour) plus ~$0.10–0.12/GB (secondary sources). That is ~10× Cloudflare.
- Fan-out CPU is not the limit at these scales (LiveKit: 3,000 audio subscribers on 16 cores).

### 10. The knob, ordered by impact

1. **`L` (common target latency / buffer depth).** It sets the on-time ratio and whether retransmission is possible: when `L` > RTT + margin (≈ ≥250 ms on LTE), cheap NACK/ARQ beats FEC.
2. **Redundancy:** RED (×2 bitrate, covers isolated losses), or duplication over two paths on the sender.
3. **Frame size:** 20 → 10 ms saves 10 ms and adds ~24 kbit/s of headers. 2.5/5 ms only on native/LAN.
4. **Bitrate:** 64–128 kbit/s stereo. On LTE this barely affects latency.

Proposed presets: **LAN-tight** L≈40–80 ms (native, 5 ms frames) · **LTE-live** L≈250 ms (10 ms, 128 kbit/s, RED off, ARQ on) · **LTE-safe** L≈400–600 ms (20 ms, 96 kbit/s, RED or ARQ, WebSocket OK) · **Buffered (axis A)** L = 2–5 s.

## Options compared

| | Sync across fleet | Latency floor (LTE) | Browser support (Nov 2026) | Pi/ESP32 | Build effort | Maturity |
|---|---|---|---|---|---|---|
| A. Stock WebRTC + SFU, `jitterBufferTarget` common | weak (tens of ms, drifts) | ~110–200 | all (Safari 27 for the hint) | Pi via Pion/GStreamer; ESP32 hard | **low** | high |
| B. WebRTC + closed loop on `jitterBufferTarget` | medium (Chrome/Firefox only) | ~150–250 | partial (no Safari) | — | medium | experimental |
| C. WebRTC transport + receiver encoded-transform → own playout | **strong** | L ≥ ~150 | Chrome 141, Firefox 117, Safari 15.4 | Pi via libwebrtc/Pion | medium-high | experimental |
| D. **WebTransport datagrams + own playout (WebSocket fallback)** | **strong** | L ≥ ~150 (WT) / ≥ ~300 (WS) | all, iOS ≥ 26.4 for WT; WS everywhere | **same protocol over UDP/QUIC** | medium (simple server) | WT Baseline 2026 |
| E. DataChannel (unreliable) + own playout | strong | L ≥ ~150 | all incl. old iOS | Pi via Pion/node-datachannel | medium-high | high |
| F. MoQ (moq.dev / Cloudflare) | strong if timestamped | L ≥ ~150 | WebTransport browsers | Rust client | medium + spec churn | low/medium |
| G. Icecast / HLS | none / weak | seconds | all | yes | low | high |
| H. SRT / RIST | n/a (contribution) | 0.3–1.2 s on 4G | none | yes | low | high |

## Recommendation

**Build first: one timestamped-frame protocol with a fixed shared latency `L`, and the receiver owns playout.**

1. **Frame format** (transport-agnostic, MoQ-compatible later): `{streamId, seq, t_capture (server clock, µs), opusFrame}`, plus a control channel for `L`, the profile and clock-sync pings (`@ircam/sync`).
2. **Relay:** a small server, in Rust (quinn/wtransport) or Go (webtransport-go), that fans out datagrams. It also offers a WebSocket endpoint on 443 for the same frames, and accepts RTP/SRT from a Pi sender through MediaMTX if useful. One VPS in Paris/Frankfurt. The same binary runs on a Pi for offline venues (WebTransport with `serverCertificateHashes`).
3. **Web receiver:** WebTransport → (fallback WebSocket) → jitter buffer → WebCodecs `AudioDecoder` (WASM libopus fallback) → AudioWorklet scheduler at `t_capture + L`, using `getOutputTimestamp` + `outputLatency` + a drift resampler.
4. **Web sender:** `getUserMedia` (processing off) → AudioWorklet → WebCodecs `AudioEncoder` Opus 10/20 ms (WASM fallback) → datagrams. Native Android/iOS or a Pi sender comes later, for 5 ms frames and line-in/USB interfaces.
5. **Baseline in parallel (1–2 days):** a stock LiveKit room with `jitterBufferTarget`. It is the yardstick, and it shows whether option A is "good enough" for headphone-only audio walks.

**Rule out for axis B:** Icecast/HLS (seconds), JackTrip/Jamulus/SonoBus (musician meshes, native-only, not 1→N over LTE), NDI/Dante (proprietary, LAN), VBAN (LAN PCM only), ion-sfu (dead), MoQ *as a foundation* (for now), and the `playout-delay` extension for audio (video-only in practice).

## Proposed experiments

| # | Goal | Method | Pass / fail metric |
|---|---|---|---|
| E1 | Size `L` from real LTE behaviour | Two phones on two French carriers send 10 ms timestamped datagrams (WebTransport + WebSocket) to a Paris VPS and back down. Sessions: static, walking, crowd, 1 h each. Log one-way delay with synced clocks | Report the p50/p99/p99.9 spread and gap counts. **Pass:** p99.9 one-way spread ≤ 150 ms static, ≤ 300 ms walking (so L ≤ 250/400 ms) |
| E2 | How unsynchronised stock WebRTC is | LiveKit (or mediasoup) room, 6–10 mixed phones (Chrome/Android, Safari 27, Firefox), `jitterBufferTarget` = 200. A click track is recorded by one reference mic; offsets come from cross-correlation | **Pass** (option A suffices): max pairwise offset ≤ 20 ms and stable over 30 min |
| E3 | Own playout precision | Prototype D (and C) with `t_capture + L`, same acoustic method, WiFi and LTE | **Pass:** pairwise ≤ 5 ms on WiFi, ≤ 15 ms on LTE; < 1 underrun per 10 min at L = 250 ms; works on iOS Safari + Chrome Android |
| E4 | Choose the transport | Same pipeline over WebTransport datagrams / unreliable DataChannel / WebSocket / WebRTC+transform on LTE, with L ∈ {100, 150, 250, 400} | On-time ratio per L. **Pass:** the simplest transport reaching 99.9 % on time at the chosen L |
| E5 | Choose the Opus profile | 10 vs 20 ms; 64/96/128 kbit/s stereo; RED on/off; ARQ on/off; 1–3 % bursty loss (`tc netem`). Informal MUSHRA with the team on show material | Pick a default; bandwidth logged; no audible PLC artefact at 1 % loss |
| E6 | Clock and output calibration | Per device over 30 min: audio clock drift (ppm), clock-sync offset error (LTE vs WiFi), and `outputLatency` accuracy against acoustic measurement | **Pass:** residual drift ≤ 1 ms; sync bias ≤ 5 ms; outputLatency error ≤ 10 ms (else add a manual calibration step) |
| E7 | Fan-out capacity | 1,000 headless subscribers against the relay on a 4–8 vCPU VPS | CPU < 70 %; added p99 jitter < 5 ms |
| E8 | Non-phone receivers | Pi (Rust/C) and ESP32 (UDP + libopus + I2S) implementing the same protocol | **Pass:** ≤ 5 ms offset against phones on the same WiFi; ESP32 CPU < 60 % |

## Open questions

- **Target experience:** will listeners also hear the live source acoustically (performer in the room) or only through their device (audio walk)? This decides whether 250–400 ms is acceptable or whether axis B must be a WiFi/LAN-only mode.
- **How tight must sync be:** do several phones play in the same space (≤ 5 ms needed) or are listeners isolated on headphones (≤ 50 ms is fine, so option A may do)?
- **iOS floor:** is requiring iOS 26.4+ for WebTransport acceptable, or must older iPhones be covered (DataChannel/WebSocket fallback)? Does Safari's WebCodecs decode Opus (to be checked on a device)?
- **Background playback:** can a web receiver keep playing with the screen locked on iOS/Android? If not, a native receiver app becomes mandatory **(unverified; check in E3)**.
- **Licence of the project:** GPL‑3 code (Snapcast ESP32 client, Janus, SonoBus) can only be reused if the project is GPL-compatible.
- **Hosting:** self-hosted VPS (cheapest, full control) or Cloudflare (anycast, near-zero ops, vendor dependency)?
- **Sender hardware for shows:** dual-SIM/dual-path Pi sender for redundancy, or a phone only?

## Sources

- MDN — RTCRtpReceiver.jitterBufferTarget: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
- MDN browser-compat-data (RTCRtpReceiver, RTCRtpScriptTransform, RTCEncodedAudioFrame, WebTransport, AudioDecoder, AudioContext): https://github.com/mdn/browser-compat-data
- Safari 27 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
- Safari 26 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- Firefox jitterBufferTarget bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1592988
- Chromium intent to ship jitterBufferTarget: https://groups.google.com/a/chromium.org/g/blink-dev/c/bReU8otUmdk
- Chromium intent captureTimestamp/senderCaptureTimeOffset: https://groups.google.com/a/chromium.org/g/blink-dev/c/SRfE60yI0uc
- abs-capture-time header extension: https://webrtc.googlesource.com/src/+/main/docs/native-code/rtp-hdrext/abs-capture-time/README.md
- playout-delay header extension: https://webrtc.googlesource.com/src/+/main/docs/native-code/rtp-hdrext/playout-delay/README.md
- WebRTC header extensions review: https://www.rtcbits.com/2023/05/webrtc-header-extensions.html
- LiveKit playout delay: https://docs.livekit.io/robotics/media/performance/low-latency/playout-delay/
- LiveKit benchmark: https://docs.livekit.io/transport/self-hosting/benchmark/
- libwebrtc Opus encoder: https://webrtc.googlesource.com/src/+/main/modules/audio_coding/codecs/opus/audio_encoder_opus.cc
- NetEq explained (webrtcHacks): https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/
- RED for Opus (webrtcHacks): https://webrtchacks.com/red-improving-audio-quality-with-redundancy/
- Chrome + Cloudflare SFU latency bench: https://github.com/115jon/ralph-meet/pull/91
- Komperda et al., Black-box analysis of WebRTC mouth-to-ear delays: http://komunikacie.uniza.sk/pdfs/csl/2016/01/02.pdf
- MDN estimatedPlayoutTimestamp: https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats/estimatedPlayoutTimestamp
- Opus (format overview): https://en.wikipedia.org/wiki/Opus_(audio_format)
- libopus 1.6: https://opus-codec.org/release/stable/2025/12/15/libopus-1_6.html
- WebTransport is Baseline: https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/
- caniuse WebTransport: https://caniuse.com/webtransport
- Cloudflare MoQ launch: https://blog.cloudflare.com/moq/
- Cloudflare MoQ docs: https://developers.cloudflare.com/moq/
- moq.dev: https://github.com/moq-dev/moq and https://new.moq.dev/blog/update-00
- MediaMTX: https://github.com/bluenviron/mediamtx (releases v1.19.0, v1.20.0)
- Cloudflare Realtime pricing: https://developers.cloudflare.com/realtime/sfu/pricing/
- LiveKit pricing: https://livekit.com/pricing
- Hetzner traffic: https://docs.hetzner.com/robot/general/traffic/
- Huang et al., 4G LTE performance (MobiSys 2012): https://web.eecs.umich.edu/~zmao/Papers/RRC4G_mobisys2012.pdf
- On-device bufferbloat for cellular upload: https://www.researchgate.net/publication/310822219_Understanding_On-device_Bufferbloat_for_Cellular_Upload
- LTE vs WiFi latency (Aalborg): https://arxiv.org/pdf/2108.03035
- LTE uplink scheduling latency: https://arxiv.org/pdf/2211.08298
- LTE mobility / handover interruption: https://vbn.aau.dk/ws/files/232547880/Mobility_Performance_in_Slow_and_High_Speed_LTE_Real_Scenarios.pdf and https://vbn.aau.dk/ws/portalfiles/portal/218342776/Paper_RACHless_Final.pdf
- RAN-induced delay (CellNinjia/Gandalf): https://arxiv.org/abs/2507.00337
- WebRTC voice in LTE coverage tests: https://hal.archives-ouvertes.fr/hal-01574796
- SRT over 4G: https://medium.com/innovation-labs-blog/examining-srt-streaming-over-4g-networks-925e71c45cdf
- OBS SRT/RIST guide: https://obsproject.com/wiki/Streaming-With-SRT-Or-RIST-Protocols
- TURN usage statistics: https://medium.com/@fippo/what-kind-of-turn-server-is-being-used-d67dbfc2ff5d
- France 4G/5G latency (secondary): https://tech-insider.org/fr/5g-vs-4g-2026-debit-latence-opensignal-arcep/
- Chrome WebAudio adaptive buffering (Chrome 136): https://groups.google.com/a/chromium.org/g/fugu-dev/c/AavLqm3hk0Y
- Android low-latency audio: https://developer.android.com/games/sdk/oboe/low-latency-audio
- Snapcast configuration: https://github.com/badaix/snapcast/blob/master/doc/configuration.md
- ESP32 Snapcast client: https://github.com/CarlosDerSeher/snapclient
- Roc Toolkit: https://github.com/roc-streaming/roc-toolkit
- SonoBus: https://github.com/sonosaurus/sonobus
- AOO: https://github.com/essej/aoo and https://soundingfuture.com/en/article/aoo-low-latency-peer-peer-audio-streaming-and-messaging
- WASM audio decoders: https://github.com/eshaz/wasm-audio-decoders
- Web-based networked music performance via WebRTC (AES): https://aes.org/publications/elibrary-page/22017.pdf
