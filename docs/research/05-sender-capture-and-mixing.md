# 05 — Sender side: capture and mixing

*Research axis D. State of platforms as checked on 2026-11-20. Claims I could not verify on the web are marked **(unverified)**.*

## Question

The sender must mix three kinds of source and hand one stream (or one timestamped chunk stream) to the distribution layer:

1. **Live inputs**: built-in mic, external/USB mic, line-in through a USB audio interface or a TRRS / Lightning / USB-C adapter.
2. **Local media**: files on the sender.
3. **Device stream**: what another app on the same device is playing (Spotify, YouTube, a browser tab).

The sender may be a phone running a web app or a native app, a Raspberry Pi with a USB audio interface, or a laptop. What can each platform capture in November 2026? What does each capture cost in latency, fidelity and user friction? Which sender should the project build first?

## TL;DR

- **A pure web app can capture live inputs and local media on every platform, but not a device stream on any phone.** `getDisplayMedia` does not exist on Chrome for Android, Firefox for Android or Samsung Internet. Safari on iOS gained `getDisplayMedia` in version 27, but MDN's compatibility data lists no audio capture for it. On desktop Chrome, system audio is available on Windows and ChromeOS, and reportedly on macOS 14.2+ from Chrome 141.
- **Android native is the only phone platform with a supported "capture what Spotify plays" API.** It is `AudioPlaybackCaptureConfiguration` (Android 10+), and it comes with real friction:
  - a consent dialog for every session;
  - a foreground service of type `mediaProjection`;
  - capture stops when the screen locks on Android 15 QPR1 and later;
  - each app can opt out.
  Spotify, YouTube, YouTube Music and Deezer are reported capturable. SoundCloud and Netflix are not.
- **iOS has no clean route.** A ReplayKit broadcast extension receives app audio, but it runs under a 50 MB memory cap, the user must start it from a system picker, and Apple Music audio is muted during capture. Reports on Spotify conflict. On iPhone, the practical way to get "what this phone plays" is to have the phone **send its output** to a receiver the project controls (AirPlay, Bluetooth A2DP, or a cable into an interface), not to capture it.
- **The Raspberry Pi "audio hub" is the most pragmatic first-class sender.** It turns "capture Spotify on the phone" into "the Pi *is* the speaker the phone casts to", using these receivers:
  - go-librespot or librespot for Spotify Connect (Premium required);
  - shairport-sync for AirPlay 2;
  - a PipeWire or BlueALSA Bluetooth sink;
  - a USB interface for line/mic.

  This works for iPhone and Android alike, needs no app-store work, and gives a stable audio clock and ALSA-level latency control. The Pi then encodes to Opus and publishes, through GStreamer `whipclientsink` or `ffmpeg -f whip` to MediaMTX, or as timestamped chunks for the buffered mode.
- **The sender's own latency is small next to the network and receiver buffers.** A tuned native or Pi live path adds about 15–40 ms from capture to packet. A browser adds roughly 30–80 ms (unverified estimate). Device-stream ingests are slow on their own: AirPlay 2 runs at about 0.5 s and classic AirPlay at 2 s. That is fine for the buffered mode (axis A) and not usable for the live mode (axis B).
- **Legal flag.** Spotify's terms grant "personal, non-commercial use" and prohibit "broadcasting… performing… making available to the public". In France, playing recorded music in public needs SACEM authorisation (authors' rights) and neighbouring-rights remuneration. Device-stream rebroadcast of streaming services should be treated as a **rehearsal/private feature**, not a show feature.

## Findings

### 1. Android (native)

**Playback capture (the "device stream").**
- **Requirements.** `AudioPlaybackCaptureConfiguration` needs `RECORD_AUDIO`, a user-approved `MediaProjectionManager.createScreenCaptureIntent()`, and the capturing and playing apps in the same profile.
- **What is capturable.** Only players whose usage is `USAGE_MEDIA`, `USAGE_GAME` or `USAGE_UNKNOWN`, so calls and VoIP are excluded. The player's effective policy must also be `ALLOW_CAPTURE_BY_ALL`.
- **Opt-out rules.** Apps targeting API 29+ are capturable by default and opt out with `android:allowAudioPlaybackCapture="false"` or `ALLOW_CAPTURE_BY_SYSTEM/NONE`. Apps targeting ≤ API 28 are *not* capturable unless they opt in. When the manifest, `AudioManager` and `AudioAttributes` policies disagree, the most restrictive one wins.
- **Effect on the captured app.** The API "does not affect the latency of the app whose audio is being captured" (Android docs).
- **Not usable by third-party apps.** `REMOTE_SUBMIX` requires `CAPTURE_AUDIO_OUTPUT`, a system-only permission.

**Which apps can be captured.** This is a field report, not vendor documentation. The AudioRelay compatibility thread was created in 2021 and maintained into 2026.
- Capturable: Spotify, YouTube, YouTube Music, Deezer, Twitch, Prime Video, VLC, Pocket Casts.
- Not capturable: Netflix, SoundCloud.
- Chrome "started to work on versions shipped after 2026-06".
- A late-2026 Spotify community post (Spotify 9.1.80, HyperOS 3) confirms that Spotify audio *is* captured by internal-audio screen recorders.
- I found no data for Apple Music, Tidal, Qobuz or Amazon Music on Android.

**Fragility.** Android System WebView 147 (released 7 April 2026) made every MediaProjection + AudioPlaybackCapture app receive silence until roughly 22 June 2026 (PRISM Live and Discord support notes). An OS component the project does not control can silently break this path.

**Friction in Android 14–16.**
- Targeting Android 14+ requires the `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission and a `mediaProjection` foreground service.
- Each `createScreenCaptureIntent()` result can be used **once**: consent is needed every session, and reuse throws `SecurityException`.
- From **Android 15 QPR1**, a prominent status-bar chip shows the projection, and "**screen projection automatically stops when the device screen is locked**". The docs also state that when a projection stops, "the virtual displays or audio streams associated with the session stop receiving media streams".
- **Consequence:** an Android capture sender must stay unlocked with the screen on. It cannot sit in a pocket. AOSP-derived code shows the only exemptions are privileged (holders of `RECORD_SENSITIVE_CONTENT` and the app-streaming role).
- This is my reading of the docs. It should be verified on a device (experiment E1).

**Live inputs.**
- **Unprocessed sources.**
  - `AudioSource.UNPROCESSED` (API 24) asks for raw mic sound "if available" and otherwise behaves like `DEFAULT`.
  - `VOICE_PERFORMANCE` (API 29) is meant for "live performance (e.g. karaoke)" and "will minimize latency and coupling with playback path".
  - `VOICE_COMMUNICATION` turns on AEC and AGC and should be avoided for music.
- **Latency guarantees.** The CDD feature flags state what a device promises:
  - `android.hardware.audio.low_latency`: continuous output latency ≤ 45 ms;
  - `android.hardware.audio.pro`: round-trip latency ≤ 20 ms, and ≤ 20 ms over USB host mode (later CDD revisions *recommend* ≤ 10 ms).
- **Measured figures.**
  - Google's 2021 sample of popular phones averaged **39 ms** round trip (range 28–56 ms), down from 109 ms in 2017.
  - Oboe's guide measures **20 ms** when all recommendations are followed, **205 ms** without `PerformanceMode::LowLatency`, and 62 ms without MMAP or a callback.
  - Input latency is roughly half the round trip.
- **USB interfaces.** USB Audio Class is supported from Android 5. I found no Android 14–16 release note covering UAC2 multichannel input. On the web side, a Chrome for Android issue reports that USB inputs are *enumerated* but selection silently falls back to the built-in mic. Native code (Oboe with an explicit `deviceId`) is the reliable route (experiment E6).
- **Mixing.** Device audio and mic can be captured at the same time (the stock screen recorder offers "device audio and microphone"). Mixing is then app code: an Oboe callback or a Kotlin mixer feeding one Opus encoder.

### 2. iOS (native)

**ReplayKit broadcast upload extension.** This is the only API that delivers other apps' audio.
- It delivers `.audioApp` and `.audioMic` sample buffers to a separate extension process.
- The user must start it from Control Center or `RPSystemBroadcastPickerView`. An app cannot start it silently.
- The extension has a hard **50 MB memory limit** and is killed by jetsam if it exceeds it. Developers report a 1–2 s cold start.
- Developer threads show recurring cases of "zeroed" app-audio buffers for some sources.

**DRM and protected apps.**
- Since iOS 11.3, **Apple Music audio is muted during screen capture**. Apple Community threads date this to March 2018 and attribute it, second-hand, to licensing.
- For **Spotify on iOS**, reports conflict. Some users say audio is captured, while vendor support pages say Spotify mutes. I could not find an authoritative statement, so treat it as **unreliable (unverified)**.
- No iOS API lets an app opt out of capture the way Android's `allowAudioPlaybackCapture` does. Protection appears tied to FairPlay or system policy (unverified).

**Live inputs.**
- AVAudioSession with category `.playAndRecord` and mode `.measurement` disables system voice processing. Superpowered recommends this mode for minimum built-in-mic latency, and the exact Apple wording is unverified.
- iPhones historically measure about **7–11 ms** round trip with an interface (forum and Superpowered figures for older devices). Current-device figures are unverified.
- Class-compliant USB interfaces work through the Lightning Camera Adapter, or directly on USB-C iPhones (15 and later).
- **iOS 26** adds `AVInputPickerInteraction`, a system input picker with level meters and microphone modes, plus a high-quality Bluetooth recording option (WWDC25 session 251). A developer-forum bug reports that the picker's selection immediately reverts on iOS 26.

**Inter-app routes.**
- Inter-App Audio was deprecated in iOS 13.
- AUv3 hosts (AUM, Audiobus) can route audio between *plugins*, so a custom AUv3 "network send" plugin is possible for musicians.
- None of this reaches Spotify or Apple Music, which are not Audio Units.

**Background.** With the `audio` background mode, a native app keeps capturing after it is backgrounded. The WebKit maintainers confirm that WKWebView mic capture is muted in the background unless `UIBackgroundModes` contains `audio`.

### 3. Mobile and desktop browsers

**getUserMedia for music** (MDN browser-compat-data, November 2026):

| Constraint | Chrome (desktop + Android) | Safari (macOS + iOS) | Firefox |
|---|---|---|---|
| `echoCancellation` | 59+ | 11+ | 50+ |
| `autoGainControl` / `noiseSuppression` | 67+ | **no** | 55+ |
| `channelCount` | 59+ | **no** | no |
| `sampleRate` | 59+ | 11+ | no |
| `latency` | 59+ | no | 50+ |
| `restrictOwnAudio` | 141 (desktop only) | no | no |

**Safari quirks.**
- On Safari, `echoCancellation:false` is effectively the only switch. My understanding is that it moves WebKit off the voice-processing I/O unit, which also drops AGC and noise suppression (unverified).
- **WebKit bug 281978** (open since October 2024): disabling echo cancellation yields **left-channel-only** audio on iOS 17.6 and Safari 18.
- **WebKit bug 326286** (October 2026): page audio crackles on **iOS 27** while a mic track *with* echo cancellation is open.
- A 2026 Apple forum thread reports that Safari 26 ignores `channelCount` when echo cancellation is off.

Stereo music input from an iPhone browser is therefore **not dependable**.

**Device-stream capture in the browser** (`getDisplayMedia` audio):
- Desktop Chrome: tab audio everywhere. Whole-system audio on Windows and ChromeOS. On macOS 14.2+, system audio via Core Audio taps from Chrome 141; this is reported by testing, and BCD still says tab-only on macOS.
- Firefox and Safari desktop: no audio capture.
- **Mobile: none.** Chrome for Android and Firefox for Android have no `getDisplayMedia`. Safari iOS 27 has it, but with no audio-capture support listed.

**Mixing and encoding in the page.**
- Every target supports the same mixing graph: `MediaStreamAudioSourceNode` (mic) + `MediaElementAudioSourceNode` (local file) → `GainNode`s → `MediaStreamAudioDestinationNode`. The result feeds an `RTCPeerConnection` or a WebCodecs encoder.
- `AudioWorklet` is available on Chrome 66+, Safari 14.1+ and Firefox 76+.
- WebCodecs `AudioEncoder` is in Chrome 94+, **Safari 26+** and Firefox 130 (not Firefox for Android). The browser can therefore produce timestamped Opus chunks itself for the buffered mode. Opus support in Safari's encoder specifically is unverified.
- `WebTransport` is in Chrome 97+, Safari 26.4+ and Firefox 114+.
- `navigator.audioSession.type` (Safari 16.4+) can set `"play-and-record"`.

**Background behaviour.**
- Mobile browser capture survives only with the tab in the foreground. Keep the screen on with the Screen Wake Lock API (Chrome 84+, iOS Safari 18.4+).
- Chrome for Android has reports of WebRTC capture stopping about a minute after the screen goes off.
- Safari mutes capture when the page is hidden.

### 4. Desktop as an easy sender

- **macOS**:
  - ScreenCaptureKit audio (macOS 13+, needs Screen Recording permission);
  - Core Audio process taps, `AudioHardwareCreateProcessTap` (macOS 14.2+, audio-capture permission; reference code `insidegui/AudioCap`, BSD-2);
  - BlackHole loopback driver (about 20k stars, custom licence; check its terms before bundling).
- **Windows**: WASAPI loopback, and per-process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 build 20348+), with include or exclude of a process tree.
- **Linux**: a PipeWire sink monitor (`pw-record` on `<sink>.monitor`).
- **Off-the-shelf:** OBS Studio has had **WHIP output since 30.0 (November 2023)** and per-application audio capture on macOS 13+. A laptop running OBS that publishes WHIP to MediaMTX gives a desktop sender with a mixer and per-app capture, with no code to write.

### 5. Raspberry Pi "audio hub"

**Audio stack.** Raspberry Pi OS Desktop has used PipeWire since Bookworm (2023). Lite images are ALSA-only unless PipeWire is installed. PipeWire's quantum sets the per-cycle buffer: 256 frames at 48 kHz is about 5.3 ms. Expect USB interfaces to need 256–1024 frames.

**Device-stream inputs.** Each one makes the Pi a target the phone sends to:

| Ingest | Project (licence, latest release) | Phone side | Ingest latency |
|---|---|---|---|
| Spotify Connect | librespot (MIT, v0.8.0, 2025-11-10); go-librespot (GPL-3.0, v0.10.7, 2026-11-18) | Spotify app, **Premium required** | buffered, ~seconds, not a concern |
| AirPlay 2 / classic | shairport-sync (custom permissive licence, 5.6.3, 2026-11-10) | iPhone/Mac, any app incl. Apple Music | AirPlay 2 ≈ 0.5 s; classic 2.0–2.25 s (README) |
| Bluetooth A2DP sink | BlueZ 5.88 + PipeWire, or BlueALSA (MIT) | any phone, any app | ~100–300 ms (unverified) |
| Line/mic | ALSA/PipeWire + class-compliant USB interface | — | a few ms |
| Local media | mpv/mpd/GStreamer filesrc | — | — |

- Both Spotify Connect and AirPlay are **reverse-engineered**.
- A Spotify backend change broke existing librespot builds in November 2025, and v0.8.0 fixed it (moOde and CoreELEC threads).
- shairport-sync states that "there is no assurance that Shairport Sync will continue to work in future".

**Mixing.** Use a PipeWire graph (`pw-loopback`, `filter-chain`) or one GStreamer pipeline (`audiomixer` → `opusenc`), or Liquidsoap (GPL-2.0, v2.4.6) when scripted ducking, scheduling and fallback are wanted.

**Publishing.**
- GStreamer `whipclientsink` (gst-plugins-rs `rswebrtc`, Opus and raw audio pads).
- FFmpeg 8.0 "Huffman" (22 August 2025) includes a WHIP muxer.
- Pion (MIT, v4.2.27) for custom Go code.
- MediaMTX (MIT, v1.21.4) ingests WHIP, RTSP, SRT and Media-over-QUIC and serves WebRTC (WHEP) and others.
- Snapcast (GPL-3.0, v0.35.0) is the reference design for the *buffered* hub. Its sources are pipe, ALSA, PipeWire, librespot, airplay and tcp, plus meta streams for priority switching. It has a default 1000 ms end-to-end buffer and 20 ms chunks (FLAC adds about 26 ms codec latency), and corrects drift by sample insert/drop, with "typically… below 0.2 ms" deviation.

### 6. Sender-side latency budget (live mode)

| Stage | Native/Pi tuned | Browser |
|---|---|---|
| Input buffer | 2–10 ms (AAudio MMAP; ALSA period; iOS 5 ms IO buffer) | 10–40 ms (unverified) |
| Mix | < 3 ms (one 128-frame Web Audio quantum = 2.67 ms) | 3–10 ms |
| Opus frame + look-ahead | 10 ms frame ≈ 16.5 ms; 20 ms ≈ 26.5 ms (RFC 6716, from memory) | same, 20 ms default in WebRTC |
| Packetise/send | ~1 ms | ~1–5 ms |
| **Total** | **~15–40 ms** | **~30–80 ms** |

**Clocks.** Every capture device has its own crystal, so the nominal 48 kHz is never exact. Android's docs warn about this explicitly; typical drift is tens of ppm (unverified). The sender's audio clock should be treated as the master *media* clock: either resample to the sync clock at the sender, or publish timestamps so receivers track it, as Snapcast does.

## Options compared

| Sender | Live in (mic/line/USB) | Local media | Device stream | Latency (sender part) | Friction | Build cost |
|---|---|---|---|---|---|---|
| Phone web app (Android Chrome) | yes; USB selection unreliable | yes | **no** | 30–80 ms | tab must stay in front; Wake Lock | low |
| Phone web app (iOS Safari) | yes; mono/left-only quirks with AEC off | yes | **no** (iOS 27 `getDisplayMedia` has no audio) | 30–80 ms | page must stay visible | low |
| Android native (Kotlin/Oboe or Capacitor plugin) | yes, UNPROCESSED/VOICE_PERFORMANCE, USB | yes | **yes** (Spotify, YouTube, Deezer; not SoundCloud/Netflix) | 15–40 ms | consent each session; FGS; **stops on lock** (15 QPR1+) | medium |
| iOS native | yes, `.measurement`, USB-C | yes | weak: ReplayKit, Apple Music muted, Spotify uncertain | 15–40 ms | user starts broadcast; 50 MB cap; App Store review | high |
| Desktop (OBS or Chrome) | yes | yes | yes (WASAPI, Core Audio taps, PipeWire monitor) | 20–60 ms | laptop on site | ~zero (OBS) |
| **Raspberry Pi hub** | **yes, ALSA-level** | yes | **yes, by being the target**: Spotify Connect, AirPlay 2, BT A2DP | 15–40 ms live; AirPlay/BT ingest 0.1–2 s | box + interface; phone pairs/casts | medium |

## Recommendation

**Sender roadmap. What I would build first:**

1. **S0, browser sender, days 1–10.** One web page, used as a test harness and the first deliverable:
   - inputs: `getUserMedia` with all processing off, plus a local file through `<audio>`;
   - mixing: a Web Audio gain graph;
   - outputs: (a) WebRTC to MediaMTX through WHIP for the live mode, and (b) WebCodecs Opus chunks with sync-clock timestamps over WebSocket or WebTransport for the buffered mode.

   It runs as-is on desktop Chrome, where `getDisplayMedia` adds tab or system audio, and on phones for mic plus files. This is the "phone-to-phone over LTE" sender of phase 1.
2. **S1, Raspberry Pi hub, the first-class sender, weeks 2–6.** Pi 4 or 5 with a class-compliant 2-in/2-out USB interface:
   - one mixing graph (GStreamer `audiomixer`, or PipeWire);
   - inputs: line/mic, local files, go-librespot (pipe backend), shairport-sync (pipe output), and a Bluetooth A2DP sink;
   - output: one Opus stream to both the live (WHIP) and buffered (chunks) paths;
   - a small web control page for gains and mutes.

   This solves "Spotify / Apple Music / anything on any phone" without capture APIs. It keeps the audio clock under control and is cheap to replicate. Snapcast is worth studying, and possibly reusing as the buffered-mode backend for non-browser receivers.
3. **S2, Android native capture, only if field use needs a phone-only rig.** A thin native layer (Capacitor/Cordova plugin or small Kotlin app): Oboe input (`VOICE_PERFORMANCE`, USB device by id) plus `AudioPlaybackCapture`, publishing to the same endpoints. Budget for the lock-screen stop and the per-session consent.
4. **S3, iOS native: defer.** Use the Pi hub (AirPlay or Bluetooth) or a cable into an interface instead. Revisit only for an AUv3 "network send" plugin for musicians.

**What I would rule out:**
- device-stream capture from any phone web app (no API exists);
- ReplayKit as a music source (Apple Music muted, fragile extension);
- `REMOTE_SUBMIX` and `CAPTURE_AUDIO_OUTPUT` (system-only);
- Inter-App Audio (deprecated);
- AirPlay or Bluetooth ingest for the **live** mode (0.1–2 s);
- writing a Spotify client (use librespot or go-librespot).

**Product stance.** Present device-stream inputs as rehearsal/private conveniences. Shows should run from licensed files or live inputs (see the legal note below).

## Legal and terms-of-service flags (facts, not legal advice)

- **Spotify** (Terms of Use updated 4 September 2026): "personal, non-commercial use"; "you will not redistribute, sell or transfer the Spotify Service or the Content". The User Guidelines prohibit "recording… performing… displaying to the public, broadcasting, or making available to the public" and "circumventing any technology used by Spotify". Rebroadcasting Spotify to a fleet of devices at a public event conflicts with these terms whatever the capture method. librespot is unofficial and reverse-engineered.
- **France**: an association running a public event with music must obtain **SACEM** authorisation even when entry is free (service-public.fr). Recorded music also carries neighbouring-rights remuneration (performers and producers), separate from authors' rights. A personal streaming subscription does not license public diffusion.
- **DRM**: Android's opt-out flag and iOS's Apple Music muting are the platforms' technical protections. Working around them, for example by rooting, is not something a public project should ship.

## Proposed experiments

| # | Goal | Method | Pass/fail metric |
|---|---|---|---|
| E1 | Android playback-capture matrix | Minimal Kotlin app. Spotify, YouTube Music, Deezer, SoundCloud, Apple Music, Tidal, Chrome tab × Android 14/15/16 × three makes (Pixel, Samsung, Xiaomi). Test screen on, screen locked, media volume at 0. | Pass: ≥ 3 services non-silent (RMS > −60 dBFS) on all makes with screen on. Record lock behaviour and whether the volume slider changes captured level. |
| E2 | Sender-side latency | Feed a click into line-in. Timestamp the arrival at a wired reference receiver on LAN; subtract a known receiver path. Paths: Chrome Android, Safari iOS, Chrome desktop, Oboe native, Pi (ALSA + GStreamer). | Native/Pi ≤ 30 ms median, ≤ 40 ms p95. Browser ≤ 60 ms median. |
| E3 | "Processing off" fidelity | Sweeps and stereo test tones into mic/line with AEC/NS/AGC off. Analyse the received stream. | Gain variation < 1 dB over 60 s (no AGC). Stereo preserved (L/R distinct). Flat to ≥ 16 kHz at 48 kHz/Opus 128 kb/s. |
| E4 | Browser sender endurance | 30 min send per browser: foreground, screen-dimmed with Wake Lock, app switch, lock. | 0 dropouts in foreground with Wake Lock. Document the rest. |
| E5 | Pi hub ingest + mix | Pi 4 and Pi 5: go-librespot + shairport-sync + PipeWire BT sink + USB line + file mixed → Opus → WHIP to MediaMTX for 2 h. | CPU < 50 %, 0 xruns, 0 publisher reconnects. Measure each ingest's latency (phone "play" to Pi output). |
| E6 | USB interfaces on phones | Class-compliant 2-in interface on Android (Chrome + Oboe) and USB-C iPhone (Safari + native). | Native: selectable, stereo, 48 kHz. Browser: record whether `deviceId` selection holds and whether `getSettings()` matches. |
| E7 | Sender clock drift | Log capture sample count against the NTP/@ircam/sync clock for 1 h (Pi + USB interface, phone mic). | Drift estimate stable within ±1 ppm after 5 min, so receivers can track it. |

## Open questions (some are decisions for the project owner)

1. Is rebroadcasting streaming services in scope for **public** shows at all, given Spotify's terms and SACEM/neighbouring rights? Or is the device stream a rehearsal-only feature? This decides how much S2 and S3 matter.
2. Is a Pi "box in the bag" acceptable as the main sender, or must a phone alone be enough on site?
3. Is the project willing to ship native apps: a sideloaded or Play-Store Android APK, an iOS App Store or TestFlight app (Apple developer account)?
4. Live-mode budget: what capture-to-ear target (for example ≤ 150 ms or ≤ 300 ms)? This decides whether browser senders are acceptable for axis B.
5. Mono or stereo, and what bitrate? Several phone and browser paths are mono-only in practice.
6. Does a project Spotify Premium account for the hub fit the studio's accounts and terms?
7. Does the sender operator need local monitoring (headphones) while sending, with a sender-side cue/mix bus?

## Sources

- Android: capture video and audio playback — https://developer.android.com/media/platform/av-capture
- Android: media projection (FGS, consent, Android 15 QPR1 chip and lock stop) — https://developer.android.com/media/grow/media-projection
- AOSP-derived keyguard restriction commit (e/OS mirror) — https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/da18f328058dc500411fc25b81d93c4381e619ea
- AudioRelay capture compatibility list — https://community.audiorelay.net/t/android-audio-capture-compatibility/418
- Spotify community: Spotify audio captured by Android screen recordings — https://community.spotify.com/t5/Android/Spotify-audio-is-being-captured-by-Android-screen-recordings/td-p/7555778
- PRISM Live: WebView 147 capture bug — https://guide.prismlive.com/mobile/announcement/service-disruption/android-internal-audio-capture-issue
- Discord: Android screenshare audio issue — https://support.discord.com/hc/en-us/articles/40397083647511--SOLVED-Audio-Issues-when-Screensharing-on-Android
- Android audio latency (CDD flags) — https://developer.android.com/ndk/guides/audio/audio-latency
- Oboe low-latency guide — https://developer.android.com/games/sdk/oboe/low-latency-audio
- Android audio latency update 2021 — https://android-developers.googleblog.com/2021/03/an-update-on-androids-audio-latency.html
- MediaRecorder.AudioSource — https://developer.android.com/reference/android/media/MediaRecorder.AudioSource
- AOSP USB digital audio — https://source.android.com/docs/core/audio/usb
- WebRTC samples issue (Chrome Android USB selection) — https://github.com/webrtc/samples/issues/1498
- Apple forums: no app audio in broadcast extension — https://developer.apple.com/forums/thread/91322
- Apple forums: broadcast extension memory limit — https://developer.apple.com/forums/thread/651367
- Apple Community: iOS 11.3 Apple Music muted in screen recording — https://discussions.apple.com/thread/8339462
- WWDC25 session 251 (audio recording, input picker) — https://developer.apple.com/videos/play/wwdc2025/251/
- AVInputPickerInteraction — https://developer.apple.com/documentation/avkit/avinputpickerinteraction
- Apple forums: input picker selection reverts on iOS 26 — https://developer.apple.com/forums/thread/802404
- Superpowered latency test — https://superpowered.com/latency
- MDN browser-compat-data (MediaDevices, MediaStreamTrack, AudioEncoder, AudioSession, WakeLock, WebTransport, RTCRtpReceiver) — https://github.com/mdn/browser-compat-data
- WebKit bug 281978 (left channel only with AEC off) — https://bugs.webkit.org/show_bug.cgi?id=281978
- WebKit bug 326286 (iOS 27 crackle with AEC) — https://bugs.webkit.org/show_bug.cgi?id=326286
- WebKit bug 226620 (background mic muting) — https://bugs.webkit.org/show_bug.cgi?id=226620
- Apple forums: Safari 26 channelCount with AEC off — https://developer.apple.com/forums/thread/804765
- addpipe: Chrome 141 system audio on macOS — https://blog.addpipe.com/getdisplaymedia-allows-capturing-the-screen-with-system-sounds-on-chrome-on-macos/
- AudioCap (Core Audio taps sample) — https://github.com/insidegui/AudioCap
- WASAPI process loopback params — https://learn.microsoft.com/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params
- OBS macOS desktop audio capture — https://obsproject.com/kb/macos-desktop-audio-capture-guide
- OBS Studio 30 WHIP output — https://www.phoronix.com/news/OBS-Studio-30-Released
- librespot — https://github.com/librespot-org/librespot
- go-librespot — https://github.com/devgianlu/go-librespot
- CoreELEC: librespot broken by Spotify backend change — https://discourse.coreelec.org/t/librespot-stopped-working/58040
- shairport-sync — https://github.com/mikebrady/shairport-sync
- Snapcast and configuration — https://github.com/badaix/snapcast , https://github.com/badaix/snapcast/blob/develop/doc/configuration.md
- BlueALSA — https://github.com/arkq/bluez-alsa
- Collabora: Pi as Bluetooth speaker with PipeWire — https://www.collabora.com/news-and-blog/blog/2022/09/02/using-a-raspberry-pi-as-a-bluetooth-speaker-with-pipewire-wireplumber/
- Raspberry Pi OS Bookworm — https://www.raspberrypi.com/news/bookworm-the-new-version-of-raspberry-pi-os/
- GStreamer whipclientsink — https://gstreamer.freedesktop.org/documentation/rswebrtc/whipclientsink.html
- FFmpeg 8.0 release — https://ffmpeg.org/pipermail/ffmpeg-devel/2025-August/347617.html
- MediaMTX — https://github.com/bluenviron/mediamtx
- Liquidsoap — https://github.com/savonet/liquidsoap
- Pion WebRTC — https://github.com/pion/webrtc
- Opus codec — https://opus-codec.org/
- Spotify Terms of Use — https://www.spotify.com/us/legal/end-user-agreement/
- Spotify User Guidelines — https://www.spotify.com/us/legal/user-guidelines/
- service-public.fr: music at association events (SACEM) — https://www.service-public.gouv.fr/associations/vosdroits/F31621
