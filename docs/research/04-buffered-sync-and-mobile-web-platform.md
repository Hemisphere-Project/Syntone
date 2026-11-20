# 04 — Buffered sync playback and the mobile web platform (Nov 2026)

## Question

1. What is the best way to play a file, or a live stream that is deliberately buffered by 2–30 s, in tight sync on many phones? What accuracy does each architecture give, what does it cost to run at scale, and how should it behave on a bad LTE link?
2. What can a web app or PWA really do on phones in November 2026 (iOS Safari and WebViews, Android Chrome, Samsung Internet, Firefox Android)? At what point is a native shell needed, for the receiver and for the sender, and what is the thinnest shell that closes the gaps?

## TL;DR

- **Schedule the audio in Web Audio, not in a media element.** Decode it yourself (WebCodecs `AudioDecoder`, with a WASM Opus fallback) and play it out from an `AudioWorklet` ring buffer on the `AudioContext` clock. Map the server clock to the audio clock with `getOutputTimestamp()` and correct drift by resampling slightly. The scheduling itself is sample-accurate (about 21 µs at 48 kHz). What is left is clock-sync error plus unknown output latency. The open-source multiroom player Snapcast already works this way in its browser client (snapweb).
- **Media elements (`<audio>`/MSE/ManagedMediaSource) steered with `playbackRate` reach about 7–10 ms at best on desktop and Chrome Android.** That figure is from published MediaSync measurements. On iOS, rate changes are a known source of glitches. FlanerieMozaic's loop accepts a 50 ms dead band, which is audible as echo between phones in the same space. Use this path only for loose sync.
- **Use one receiver engine for both axes, with a single parameter: the target delay D.** For axis A, D is 5–30 s and the audio comes as static HTTP segments from a CDN: stateless, cacheable and cheap. For axis B, D is about 0.2–1 s and 20 ms Opus frames arrive over WebSocket or WebTransport. WebTransport is now in every major engine, since Safari 26.4.
- **Underrun policy on bad LTE: stay on the shared timeline.** A device that misses data plays silence with short fades, then rejoins exactly on time. Time-stretch catch-up keeps one phone out of sync for 10–20 times the length of the gap.
- **Platform state in Nov 2026.** iOS Safari 26+ has WebCodecs audio, WebTransport (26.4), `outputLatency` (18.4), Wake Lock in home-screen apps (18.4), `navigator.audioSession` (16.4/17) and ManagedMediaSource (17.1). Background and lock-screen Web Audio in a **Safari tab** has been usable since roughly iOS 17.5 when `audioSession.type = "playback"` is set. Home-screen PWAs had serious audio regressions through iOS 26.x. Android Chrome has everything except output selection (`setSinkId` is not available on Android). Firefox Android has **no WebCodecs**.
- **When native is needed.** The web is enough for a foreground receiver with the screen on. A native shell becomes necessary for (a) guaranteed locked or pocket playback on both OSes, (b) output-route and latency information, and (c) any sender that captures other apps' audio (Spotify), which no mobile browser can do. The thinnest fix is the existing Cordova (or Capacitor) wrapper around the same web engine, plus one small plugin:
  - iOS: `UIBackgroundModes=audio` and `AVAudioSession(.playback)`.
  - Android: a `mediaPlayback` foreground service and a Wi-Fi lock.
  - Both: report route and latency to JS.
- **Bluetooth output latency cannot be known from the web, or reliably from native APIs.** Plan for per-device calibration from day one.

## Findings

### 1. Reference point: what FlanerieMozaic does today

From `www/js/player_sync.js` in the FlanerieMozaic repo:

- **Clock.** `@ircam/sync` (BSD-3-Clause) over Socket.IO, on `performance.now()`. The library's WAC 2016 paper reports 1–10 ms per-event timing accuracy (σ ≈ 5 ms) over heterogeneous HTML5 devices.
- **Correction loop.** A `setTimeout` loop every 20 ms adjusts a `<video>` element:
  - error ≥ 1 s (adaptive up to 5 s): seek;
  - error < 50 ms: rate set back to 1.0;
  - otherwise: `playbackRate = 1 ± min(0.3, 2·error)`.
- **Effective accuracy is about ±50 ms by design.** There is no output-latency compensation. A rate of up to ±30% is very audible on audio. A main-thread timer loop stops correcting as soon as the page is throttled in the background.

This works for a video wall, where one frame is about 40 ms. It is not tight enough for co-located audio.

### 2. Media-element sync: measured limits

- **Published measurements.** The MediaSync library (timingsrc, Arntzen/Borch/Daoust) reports about **7 ms** error "for both audio and video, on desktops, laptops and high-end smartphones". A Chrome Android plot stays mostly inside a **±10 ms** band using variable `playbackRate`. It needs **about 3 s** to converge.
- **iOS rate changes glitch.** The project's own docs warn that "IOS devices have issues with the implementation of variable playbackrate". WebKit bug 208142 reports that each `playbackRate` change causes "a small pause" (it is a duplicate of 163433, framework-level). dash.js still hard-codes `minPlaybackRateChange = isSafari ? 0.25 : 0.02` because of that bug, so on Safari it can only correct in coarse 25% steps.
- **Fixes in Safari 27 (Jun 2026 beta notes).** iOS `currentTime` now updates "more frequently" and `playbackRate` on elements connected to an `AudioContext` is handled correctly. Whether the micro-pause on rate change is gone is **unverified**, and it should be tested (E2).
- **MSE on iPhone means ManagedMediaSource.** Classic MSE is exposed on iPad only. MMS is on iPhone since iOS 17.1, and playback needed `disableRemotePlayback = true` or an AirPlay alternative source. hls.js (v1.7.4, Oct 2026) uses MMS by default (`preferManagedMediaSource: true`).
- **Standard players aim at a latency target, not a shared clock.** hls.js `maxLiveSyncPlaybackRate` (≤ 2) and `liveSyncOnStallIncrease` (+1 s per stall), and dash.js `liveCatchup`/`maxDrift` (v5.3.0, Nov 2026), steer toward a target distance from the live edge. Wall-clock anchors do exist: HLS `EXT-X-PROGRAM-DATE-TIME` "associates the first sample of a Media Segment with an absolute date and/or time" (`hls.playingDate`), and DASH has `ProducerReferenceTime` and `UTCTiming`. But catch-up resolution is the rate step above, and LL-HLS rules (`HOLD-BACK` ≥ 3× target duration, `PART-HOLD-BACK` ≥ 2×, should be 3×, part target) put the floor at seconds.
- **Verdict.** The ideas are worth borrowing (segments plus a wall-clock timeline). The players are not, because their sync tolerance is 10–250 ms.

### 3. Web Audio scheduled playout: the precise path

- **Start times are sample-accurate.** `AudioBufferSourceNode.start(when)` and an `AudioWorklet` ring buffer both play on the audio hardware clock. One frame at 48 kHz is 20.8 µs. One render quantum (128 frames) is 2.67 ms.
- **Clock mapping.** `getOutputTimestamp()` (Chrome 57, Safari 14.1, Firefox 70) returns a `{contextTime, performanceTime}` pair, which links the audio clock to `performance.now()` and, through clock sync, to server time. snapweb (GPL-3.0, active Oct 2026) does exactly this:
  - its clock is `getOutputTimestamp().contextTime`, with `currentTime` as a fallback;
  - the server offset is the median of the last 100 ping samples;
  - Opus and FLAC are decoded in WASM workers;
  - buffers are scheduled with `source.start(playTime)`;
  - drift is fixed by adding or dropping single frames. Snapcast states "typically the deviation is below 0.2 ms" for native clients.
- **Drift must be corrected continuously.** Consumer audio crystals are typically tens of ppm off (from memory, unverified). At 50 ppm, that is 3 ms per minute and 180 ms per hour. Fractional resampling inside the worklet, or dropping or duplicating one frame every few hundred ms, is inaudible at that rate.
- **Decoding: use a decoder that keeps state between segments.** Decoding each compressed segment separately with `decodeAudioData` adds encoder priming and padding at every segment boundary (gaps or clicks, a known AAC/MP3 property). A stateful decoder avoids this:
  - **WebCodecs `AudioDecoder`.** Chrome/Android 94+ and Safari/iOS 26+ (Safari 26 release notes: "Added support for WebCodec's AudioEncoder and AudioDecoder"). Not in Firefox Android.
  - **WASM Opus** (for example, `opus-decoder`, the library snapweb uses) as the fallback.
- **Whole-file pre-download is still the simplest path for axis A.** Use `decodeAudioData` once, then `start(when, offset)`. Memory is the limit: decoded float32 stereo at 48 kHz is 384 KB/s, about 23 MB/min, so a 10-min piece is about 230 MB. That is risky in an iOS tab. Decode in windows (for example, 30 s) for long pieces.
- **Do not depend on SharedArrayBuffer.** MDN's compat data (BCD) lists SAB as **not supported in Android WebView**, and elsewhere it requires COOP/COEP cross-origin isolation (Chrome Android 89, Safari 15.2). Feed the worklet with transferable `ArrayBuffer`s via `postMessage` and keep several seconds buffered inside it, so main-thread throttling never starves it.

### 4. Transport, scale and cost for "buffered"

- **Axis A as static segments.** The sender or Pi runs ffmpeg to produce 0.5–2 s Opus segments (raw packets, Ogg or fMP4) plus a manifest that maps segment n to a server-timeline start time, the equivalent of PROGRAM-DATE-TIME. Any static host or CDN can serve it. The only stateful service is clock sync: a ping endpoint, roughly 1 small request per second per client during bursts, which one small Node process handles for hundreds to thousands of clients (estimate; tested in E8). The existing Socket.IO control plane (rooms, play/stop) can stay.
- **Bandwidth.** Opus at 96 kbit/s stereo is 43 MB per listener-hour, so 500 listeners for 1 h is about 22 GB. At typical CDN egress prices that is on the order of a few euros per show-hour (unverified pricing). A stateful fan-out server would have to send all of it itself: 500 × 96 kbit/s = 48 Mbit/s.
- **Joining mid-stream** costs one clock-sync convergence (FlanerieMozaic waits up to 20 s of "training"; `@ircam/sync` reports a usable estimate after a few ping series) plus one segment fetch. Playback then starts exactly on the timeline at a sample offset, with no "wait for next segment".
- **Degrading gracefully on LTE.** Every device plays position *p = T_server − D*.
  - **Skip-ahead (recommended).** On underrun, fade out over about 5 ms, output silence, then fade in at the exact timeline position once data arrives. Only that device drops out. Everyone else stays coherent.
  - **Stall plus time-stretch (not recommended for shared spaces).** A 1 s gap caught up at 1.05× leaves the device about 20 s out of sync. It is acceptable only for a solo listener on headphones.
  - **Rendition downshift.** Offer several bitrates, for example 96, 48 and 24 kbit/s. Opus uses 20 ms frames at 48 kHz, so all renditions share frame boundaries and a switch is sample-aligned.
  - **D is global.** Choose it from the p95 LTE outage length you expect. Adapting D per device breaks the shared timeline.
- **Axis B uses the same engine.** Push 20 ms Opus frames over WebSocket (or WebTransport datagrams) and set D to 0.2–1 s. WebTransport: Chrome 97, Firefox 114, Safari 26.4 ("a modern API for low-latency, bidirectional communication"). WebRTC hides playout timing (Safari 27 adds `jitterBufferTarget`, a minimum, not an absolute schedule). Other axes cover it.

### 5. Error budget for co-located phones (wired jack or built-in speaker)

| Term | Expected | Status |
|---|---|---|
| Clock-offset estimate, Wi-Fi | 1–5 ms | IRCAM paper 1–10 ms, σ≈5 ms (2016) |
| Clock-offset estimate, LTE | 2–15 ms (asymmetric uplink scheduling) | **unverified** → E1 |
| Server→audio-clock mapping | ≤ 1 render quantum (2.7 ms) | estimate |
| Scheduling | < 0.03 ms | spec property |
| Residual drift after correction | < 1 ms | Snapcast-style |
| Output latency, wired/speaker | constant per model, unknown (5–40 ms?) | **unverified** → calibrate per model (E6) |
| Output latency, Bluetooth A2DP | 100–300+ ms, varies per speaker and codec | **unverified**. Bluetooth headsets are "notorious for reporting much lower latencies than they actually implement"; the AOSP A2DP path may fall back to an estimate |

Psychoacoustic target: MediaSync calls ±10 ms "echoless", and ±25 ms "frame accurate". A realistic goal is ≤ 10 ms p95 on Wi-Fi with wired or speaker output. Bluetooth is only feasible after calibration.

### 6. Mobile web platform, Nov 2026

Versions are from MDN browser-compat-data (main branch, Nov 2026) unless noted otherwise.

| Capability | iOS Safari (all iOS browsers are WebKit) | Android Chrome / Samsung Internet | Firefox Android |
|---|---|---|---|
| AudioContext unlock | User gesture + `resume()`. `interrupted` state on calls and Siri | Gesture (since Chrome 71). Home-screen-installed sites may autoplay | Gesture, autoplay blocked by default |
| Silent switch | Mutes Web Audio unless `navigator.audioSession.type="playback"` ("Since iOS 17", WebKit engineer; BCD: 16.4). Media elements are unaffected | n/a | n/a |
| Background / locked, Safari tab or Chrome tab | `<audio>`: yes. Web Audio with `playback` session: fixed in WebKit bug 261554 (users report OK from 17.5). Fragile across releases | Audio-playing pages are exempt from intensive throttling and discard. Silent pages: timers 1/min after 5 min hidden. Web Audio keeps running with screen off (anecdotal) | **unverified** |
| Background, home-screen PWA | `<audio>` since 15.4. **iOS 26 regressions**: Web Audio silent after return from background (bug 291892, a user reports fixed in 26.2 b3) and `<audio>` silent on reopen (bug 295518, still NEW Dec 2025) | Same as tab (installed PWA) | — |
| In-app WebViews (Instagram, WhatsApp, …) | Background audio only if the host app declares `UIBackgroundModes audio`. Assume it stops on lock | Host-dependent | — |
| Wake Lock (screen) | 16.4. Home-screen apps since **18.4** | 84 | 126 |
| Media Session (lock-screen UI) | 15 | 57 | API without UI |
| AudioWorklet / SAB (COI) | 14.5 / 15.2 | 66 / 89 (**SAB absent in Android WebView**) | 76 / 79 |
| WebCodecs `AudioDecoder` | **26** (multichannel Opus issues, bug 327697) | 94 | **No** |
| ManagedMediaSource / MSE | MMS 17.1 (iPhone). MSE iPad-only | MSE | MSE |
| WebTransport | **26.4** | 97 | 114 |
| `outputLatency` | 18.4 | 102 (Android accuracy unverified) | 70 |
| `setSinkId` / `selectAudioOutput` | BCD 18.4 (no real route choice on iPhone; **unverified**) / no | **Not on Android** / no | Not on Android / no |
| System or other-app audio capture | None (BCD lists `getDisplayMedia` iOS 27 video-only; **unverified**) | None (`getDisplayMedia` absent on Android) | None |
| Low Power Mode | rAF capped at 30 fps ("intentional", WebKit bug 215745). Effect on timers and audio **unverified** | Battery saver / OEM killers (unverified) | — |

Bluetooth and sample-rate notes:

- **Opening the mic changes the Bluetooth link.** On Android, Chrome sets communication mode when a Bluetooth mic is used, which moves A2DP to SCO/HFP: mono, 8–16 kHz.
- **iOS sample-rate changes distort Web Audio.** Several WebKit bugs (231422, 258864, 251091) report distorted or wrong-speed Web Audio when the route's sample rate changes, for example when switching to Bluetooth (headsets "generally run at 16 kHz").
- **Design rule:** a receiver never opens the mic. Let the context use the hardware rate and resample in the decoder or worklet.

Chrome also exempts pages using WebRTC (an open `RTCDataChannel` or a live track) from intensive throttling. WebSocket alone is not an exemption: the Page Lifecycle doc tells pages to close sockets on freeze.

### 7. Where the web stops

**Receiver**

- **The web is enough** for a foreground receiver with the screen on (Wake Lock, user gesture to join) on iOS Safari 17.5+/18.4+ and Android Chrome. That covers installations and seated audiences.
- **Pocket listening (locked screen)** works in Android Chrome. In an iOS Safari tab it "mostly works if `playback` is set". In iOS PWAs and in-app browsers it is not dependable.
- **A native shell is required** for:
  - guaranteed locked or background playback across OS updates;
  - surviving Android's freezer, which freezes cached processes 10 s after they become cached (Android 14+) unless a foreground service is running;
  - Wi-Fi power-save control (a Wi-Fi low-latency lock);
  - route and latency events (AVAudioSession route change and `outputLatency`; Android `AudioTrack.getTimestamp`, which the CDD requires to be accurate to ±1–2 ms on the device side, excluding the headset).

**Sender**

- **The web can** capture mic or line input (`getUserMedia` with processing disabled), mix local files, encode (WebCodecs `AudioEncoder` on Chrome and iOS 26+) and send, as long as the screen stays on.
- **The web cannot** capture another app's audio on any mobile OS, and on iOS it cannot keep capturing in the background.
- **Android native:** `AudioPlaybackCapture` (Android 10+). It needs a MediaProjection consent prompt and `RECORD_AUDIO`. Apps targeting API 29+ (Android 10) "allow their audio to be captured" by default for `USAGE_MEDIA`/`GAME`/`UNKNOWN`, unless they opt out.
- **iOS native:** only a ReplayKit Broadcast Upload Extension (`.audioApp` buffers). Third-party documentation reports that it cannot capture Music-app or AVPlayer audio and that the extension has a 50 MB memory cap. Whether Spotify can be captured this way is **unverified**.
- **A Raspberry Pi sender has none of these limits.** Make it the reference sender.

**Thinnest shell**

The studio already ships a Cordova app. cordova-android 15.1 (Jul 2026) keeps JS timers running in the background by default (`KeepRunning=true`; `handlePause` only pauses timers when it is false). Keep the same web engine inside the WebView and add one plugin, about 300–800 lines per platform (estimate):

- **iOS:**
  - `UIBackgroundModes: audio`;
  - set `AVAudioSession` category `.playback` at join, and set it again after interruptions;
  - expose route changes and `AVAudioSession.outputLatency` to JS.
- **Android:**
  - start a `mediaPlayback` foreground service with a notification from the Join tap (Android 12+ forbids starting it from the background);
  - hold a `WifiManager` low-latency lock and a partial wake lock;
  - expose `AudioManager` output devices and `AudioTrack` latency to JS.

If WKWebView Web Audio still drops in the background (reports from iOS 13–15 era; current state **unverified**), the next step is a native playout plugin. JS would pass timestamped PCM or Opus to AVAudioEngine/AAudio (Oboe), at about 1.5–3k lines per platform. Capacitor is equivalent in WebView capability. Flutter, React Native or fully native builds would not remove the need for native audio code and would double the UI code base.

## Options compared

| Option | Sync accuracy (co-located) | iOS | Scale / cost | Complexity (1–2 people) | Verdict |
|---|---|---|---|---|---|
| A1. `<audio>`/`<video>` + playbackRate/seek (FlanerieMozaic) | ±50 ms as tuned; ~7–10 ms best case (desktop, Chrome Android) | Rate changes glitch (bug 208142). Coarse steps | Static files | Low (exists) | Keep for video walls only |
| A2. MSE/MMS + hls.js/dash.js catch-up with PDT/PRFT | ~10–250 ms (rate-step-limited; unverified for multi-device) | MMS quirks, 0.25 rate steps on Safari | CDN | Medium | Rule out for tight sync |
| A3. Pre-downloaded file + `decodeAudioData` + `start(when)` | ≤ 10 ms (clock + output latency) | Works. Memory ≈ 23 MB/min | Static | Low | **Prototype first** (short pieces) |
| A4. Segments (Opus) + WebCodecs/WASM decode + AudioWorklet playout + drift resampling | ≤ 10 ms target. Same engine for live | Works in Safari tab 17.5+; shell for lock | CDN + tiny sync service | Medium (snapweb is a reference) | **Main architecture** |
| A5. Same as A4 in Cordova/Capacitor shell + plugin | Same, plus native route/latency info | Fixes background | + store distribution | Medium+ | Second step, when E3 fails on web |
| A6. Native playout plugin or fully native | Best (native timestamps) | Full control | Same | High | Only if A5 fails |

## Recommendation

1. **Build one receiver engine ("timeline player") in plain JS/TS.**
   - Clock sync: keep `@ircam/sync`, or a 100-line min-RTT/median NTP-over-WebSocket.
   - Clock mapping: `getOutputTimestamp()`.
   - Decode: WebCodecs `AudioDecoder` (Opus), falling back to WASM Opus.
   - Playout: `AudioWorklet` ring buffer fed by `postMessage` (no SAB), with fractional-resampling drift control and a skip-ahead underrun policy with 5 ms fades.
   - Tuning: a single knob, the target delay D, plus a per-device latency offset.
2. **Axis A transport:** ffmpeg on the Pi or server writes 1 s Opus segments and a JSON timeline manifest to static hosting. Keep the existing Socket.IO control plane.
3. **Phase 1 targets:** an iOS Safari tab (not the home-screen PWA) with `audioSession.type="playback"`, Wake Lock and Media Session metadata, and Android Chrome. Detect in-app browsers and ask the user to open the page in Safari or Chrome. Treat Firefox Android as best effort.
4. **Add calibration UI from the start:**
   - a manual offset slider;
   - an acoustic "tap test" in which one reference phone's mic hears a click emitted by the others at a known server time. This is the only route to Bluetooth.
5. **Add the Cordova plugin** described above as soon as E3 shows that locked playback fails, instead of piling up WebKit workarounds.
6. **Rule out:**
   - media-element or MSE rate steering for co-located audio;
   - LL-HLS/DASH players as the sync mechanism;
   - per-segment `decodeAudioData` of AAC/MP3;
   - SAB-dependent designs;
   - the iOS home-screen PWA as the primary receiver;
   - web-only capture of other apps' audio.

## Proposed experiments

| # | Goal | Method | Pass / fail |
|---|---|---|---|
| E1 | Clock-sync accuracy, Wi-Fi vs LTE | 4 phones schedule a 10 ms 1 kHz tick every 1 s at server time (wired output into one multichannel interface). Cross-correlate. Repeat on Wi-Fi, LTE and mixed, 30 min each | p95 inter-device offset ≤ 5 ms on Wi-Fi, ≤ 10 ms on LTE |
| E2 | Engine comparison | Same 10-min file via A1 (FlanerieMozaic loop), A2 (hls.js + MMS) and A3/A4. iPhone (iOS 26 and 27) + 2 Android. Log offset and count glitches (rate-change pauses) | A4 p95 ≤ 5 ms with 0 audible glitches. Record A1/A2 numbers as baseline |
| E3 | Background survival matrix | {Safari tab, PWA, in-app WebView, Cordova shell+plugin} × {lock 30 min, app switch, incoming call, Low Power Mode, Android Doze/OEM battery saver} | Audio continuous for 30 min. Back within 10 ms of the timeline ≤ 2 s after any interruption |
| E4 | Drift control | Log each device's audio-clock rate vs server (ppm) over 1 h with correction on and off | |error| ≤ 2 ms for 1 h with correction. Report ppm spread |
| E5 | Underrun policy on bad LTE | Pi router with `tc netem` (loss, 2–10 s outages). Compare skip-ahead vs 1.05× time-stretch | Skip-ahead: back to ≤ 5 ms within 100 ms of data arrival. Stretch: measure seconds out of sync |
| E6 | Can output latency be trusted? | Compare reported `outputLatency`/`getOutputTimestamp` with acoustically measured latency on wired, built-in speaker and 5 Bluetooth speakers (iOS + Android, web and native) | |reported − measured| ≤ 10 ms means auto-compensate. Otherwise calibration is mandatory |
| E7 | Bluetooth / sample-rate hazards | On Bluetooth output, change routes mid-play and open the mic in another tab or app. Watch `sampleRate`, `statechange` and audio quality | Engine recovers (rebuilds context) within 1 s without wrong-speed audio |
| E8 | Scale | 1,000 headless clients fetch segments from a CDN and ping the sync endpoint | One small VPS sustains sync for 1,000 clients at < 30% CPU. Segment egress fully offloaded to the CDN |

## Open questions

- **Co-located or individual listening?** If phones share a space (an installation or crowd), the ≤ 10 ms engine is mandatory. If each listener is alone on headphones (an audio walk), ~100 ms is fine and media-element playback is acceptable.
- **How large should D be for axis A?** 5 s or 30 s, and does "live-ness" matter to the artistic intent?
- **Is app-store distribution acceptable?** (TestFlight or Play internal testing versus public listing.) Who owns the developer accounts? Background audio needs App Review justification.
- **Cordova (already in house) or Capacitor** for the shell?
- **Minimum OS versions:** for example iOS 17.5+ (playback session in background) or 18.4+ (Wake Lock in PWAs, `outputLatency`).
- **Repository licence:** GPL-3.0, like FlanerieMozaic and Snapcast, or permissive, like `@ircam/sync` (BSD-3)? This affects whether snapweb code can be reused.
- **Rights:** rebroadcasting a streaming service's audio (the Spotify capture case) may conflict with its terms and with copyright. This is the owner's decision, not a technical one.
- **Fleet size and CDN budget per show.**

## Sources

- MDN browser-compat-data (api/AudioContext, BaseAudioContext, AudioDecoder, AudioEncoder, WebTransport, ManagedMediaSource, MediaSource, WakeLock, MediaSession, HTMLMediaElement, MediaDevices, AudioSession, Navigator; javascript/builtins/SharedArrayBuffer), main branch, read 2026-11-20: https://github.com/mdn/browser-compat-data
- WebKit Features for Safari 26.4: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- News from WWDC26, WebKit in Safari 27 beta: https://webkit.org/?p=17967
- Safari 26 release notes: https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- WebKit bugs: 198277 https://bugs.webkit.org/show_bug.cgi?id=198277 · 291892 https://bugs.webkit.org/show_bug.cgi?id=291892 · 295518 https://bugs.webkit.org/show_bug.cgi?id=295518 · 261554 https://bugs.webkit.org/show_bug.cgi?id=261554 · 237322 https://bugs.webkit.org/show_bug.cgi?id=237322 · 208142 https://bugs.webkit.org/show_bug.cgi?id=208142 · 215745 https://bugs.webkit.org/show_bug.cgi?id=215745 · 258864 https://bugs.webkit.org/show_bug.cgi?id=258864 · 231422 https://bugs.webkit.org/show_bug.cgi?id=231422 · 327697 https://bugs.webkit.org/show_bug.cgi?id=327697
- W3C Audio Session: https://www.w3.org/TR/audio-session/
- Chrome timer throttling (Chrome 88): https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Chrome autoplay policy: https://developer.chrome.com/blog/autoplay
- Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- Audio output latency (web.dev): https://web.dev/articles/audio-output-latency
- Browser audio latency measurements: https://www.jefftk.com/p/browser-audio-latency
- Intent to Ship AudioContext.outputLatency: https://groups.google.com/a/chromium.org/g/blink-dev/c/dTQniJNVVMY
- Snapcast: https://github.com/badaix/snapcast · snapweb (src/snapstream.ts): https://github.com/badaix/snapweb
- @ircam/sync: https://github.com/collective-soundworks/sync · paper: https://hal.archives-ouvertes.fr/hal-01304889v1 · abstract: https://repository.gatech.edu/entities/publication/1f9d9d03-57b1-438d-a7b2-6a4f7c468119
- Arntzen, Borch, Daoust, "Media Synchronization on the Web": https://cdn.jsdelivr.net/npm/webtiming-timingsrc@3.0.0/chapter/submit/arntzen_mediasync.pdf · MediaSync docs: https://timingsrc.readthedocs.io/en/latest/sync/mediasync.html
- hls.js API: https://github.com/video-dev/hls.js/blob/master/docs/API.md · MMS PR: https://github.com/video-dev/hls.js/pull/5542
- dash.js (CatchupController.js, low-latency docs): https://github.com/Dash-Industry-Forum/dash.js
- HLS rfc8216bis-22: https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis
- MMS on iPhone (Safari 17.1): https://www.radiantmediaplayer.com/blog/at-last-safari-17.1-now-brings-the-new-managed-media-source-api-to-iphone.html
- Android cached apps freezer: https://source.android.com/docs/core/perf/cached-apps-freezer
- Android audio playback capture: https://developer.android.com/media/platform/av-capture
- cordova-android (CordovaWebViewImpl.handlePause, KeepRunning): https://github.com/apache/cordova-android
- WKWebView background audio (Apple forums): https://developer.apple.com/forums/thread/713084
- Capacitor background audio notes: https://capgo.app/blog/how-to-play-audio-in-the-background-in-capacitor/
- ReplayKit limits (Twilio sample): https://github.com/twilio/video-quickstart-ios/blob/master/ReplayKitExample
- Bluetooth HFP quality: https://www.daily.co/blog/why-bluetooth-audio-quality-suffers-in-video-calls/ · Chromium commit: https://chromium.googlesource.com/chromium/src/+/78d0de138346e6edfc8c33bdd22c45b3eec4f3d0
- FlanerieMozaic (Hemisphere-Project GitHub organisation), `www/js/player_sync.js`, read locally.
