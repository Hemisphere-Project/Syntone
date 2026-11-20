# 06 — Embedded receivers and senders: ESP32 and Raspberry Pi

*Research axis 06. State of the art checked on 2026-11-20. Claims marked "(unverified)" or "(from memory)" were not confirmed against a primary source during this pass. The web-search budget ran out partway through. The remaining checks used GitHub sources, Espressif component pages and the ESP-IDF source tree.*

## Question

Which embedded devices can act as **synchronised audio receivers** in a heterogeneous fleet (phones, ESP32 boards, Raspberry Pi), and which can act as **senders** (a Pi with a USB audio interface)? What do they cost in CPU, RAM, latency and sync accuracy? How do they reach the network beyond venue Wi-Fi: a phone hotspot, USB tethering or their own cellular modem? Can they drive a Bluetooth speaker? And which **single wire protocol** (transport, framing, timestamps, clock sync) could a browser, an ESP32 and a Pi all implement?

## TL;DR

- **The common protocol already exists. It is Sendspin.** Sendspin is an open spec from the Open Home Foundation (Release Candidate 1). It runs over WebSocket. Every binary audio chunk starts with a 1-byte type, an int64 server timestamp in µs and a uint32 `send_ahead`, followed by exactly one Opus packet, or FLAC or PCM. Clocks sync through NTP-style 4-timestamp bursts that feed a 2-state Kalman filter (offset and drift). Each player reports its own `min_buffer_ms`, `required_lead_time_ms` and `output_delay_ms`. A `source` role lets a client stream timestamped captured audio *up* to the server. Maintained client SDKs exist for ESP-IDF/C++, the browser (TypeScript) and Python, plus a mainline ESPHome component. The SDKs are Apache-2.0.
- **Use the ESP32-S3 with PSRAM as the baseline embedded receiver.** On the S3, Opus decoding of 48 kHz stereo costs about 6–9 % CPU and about 27–50 KB of state. The original ESP32 only just keeps up with CELT music decoding (real-time factor 0.74 in one benchmark). There are no published Opus numbers for the C3, C5 or C6.
- **ESP32 sync accuracy is proven at about 0.1–0.5 ms on a LAN.** The ESP32 Snapcast client reports 200–500 µs typical and <100 µs after its sync rework, with occasional 2–4 ms excursions. Sendspin *requires* ±1 ms at the output and targets ±0.5 ms. No independent cross-device measurement of Sendspin was found.
- **Drift correction should use sample insertion and deletion.** About 1 frame per second absorbs 20 ppm at 48 kHz, and it works on every chip. An APLL exists only on the ESP32, S2 and P4 (and the upcoming S31). The new `i2s_channel_tune_rate()` API is meant to be called with the channel stopped.
- **Connectivity, ranked by ease:**
  1. Phone Wi-Fi hotspot. Works on every ESP32, but only on 2.4 GHz except the C5.
  2. A Pi tethered to a phone over USB. Linux supports Android RNDIS/NCM and the iPhone's `ipheth` driver.
  3. An ESP32-S3 or P4 as USB host to an Android phone. Possible over RNDIS but not proven with phones. There is no official NCM host driver, and recent Android phones appear to use NCM.
  4. An ESP32 as a USB NCM device plus Android "Ethernet tethering". Plausible but unverified.
  5. iPhone USB tethering to an ESP32. Not feasible, because the protocol is proprietary and needs pairing.
  6. Their own modem: Cat-1 (A7670) or Cat-4 (SIM7600) are fine. Cat-M is marginal. NB-IoT is ruled out because its latency is measured in seconds.
- **Bluetooth from embedded devices:** classic A2DP needs the original ESP32. It supports SBC, plus AAC with an external codec, and it receives the speaker's **delay report** (`ESP_A2D_REPORT_SNK_DELAY_VALUE_EVT`). Wi-Fi and BT then share one radio. LE Audio/Auracast is the way to get a *specified* presentation delay. On Espressif it is a preview on the ESP32-H4 and declared for the ESP32-S31. The Nordic nRF5340 is the mature option today, used as an I2S-fed "Auracast bridge" next to an ESP32 or Pi.
- **What I would build first:** Sendspin as the wire protocol. Receivers: ESP32-S3 + PCM5102A/MAX98357A running sendspin-cpp or ESPHome, and a Pi Zero 2 W or Pi 4 running a Sendspin CLI over ALSA with an I2S DAC. A Pi with a USB interface acts as the `source`. Measure with the Sendspin chirp-correlation tool. Then add a UDP/datagram "live lane" that keeps the same 13-byte chunk header, for low-latency use over LTE.

## Findings

### 1. ESP32 family as a synced receiver

**Chip capabilities**, read from the ESP-IDF master `soc_caps.h`:

| Chip | Cores | PSRAM | APLL | BT Classic (A2DP) | BLE Audio/ISO | USB OTG | Wi-Fi |
|---|---|---|---|---|---|---|---|
| ESP32 | 2 | yes | **yes** | **yes** | no | no | 2.4 GHz |
| ESP32-S2 | 1 | yes | yes | no | no | yes | 2.4 GHz |
| ESP32-S3 | 2 | yes | **no** | no | no | yes | 2.4 GHz |
| ESP32-C3 | 1 | no | no | no | no | no | 2.4 GHz |
| ESP32-C5 | 1 | yes | no | no | no (not flagged) | no | **2.4 + 5 GHz** |
| ESP32-C6 | 1 | no | no | no | no | no | 2.4 GHz (Wi-Fi 6) |
| ESP32-P4 | 2 | yes | yes | no (no radio; Wi-Fi via an ESP-Hosted companion) | no | yes (HS) | none |
| ESP32-H4 | 2 | yes | no | no | **yes** | yes | none |
| ESP32-S31 | 2 | yes | yes | **yes** | **yes** | yes | Wi-Fi 6 |

The ESP32-S31 is a target in ESP-IDF master. Whether silicon and modules are available is unverified. The latest ESP-IDF release is v6.1.1 (2026-11-16).

**Opus decode cost**

- Espressif `esp_audio_codec` v2.6.2 on an ESP32-S3R8, Opus decoder at 48 kHz stereo: **5.86 % CPU, 26.6 KB heap**. The encoder at 90 kbps, complexity 0: 24.9 % CPU, 29.4 KB.
- ESPHome `micro-opus` on an ESP32-S3 at 240 MHz: **CELT about 8–9 % CPU, SILK about 2 %**. Per-frame decode averages 3.0 ms per 20 ms CELT frame (RTF 0.150) and 0.87 ms per SILK frame.
- Same library on the **original ESP32**, fixed point, pseudostack in PSRAM: **14.7 ms per 20 ms CELT frame (RTF 0.736)**, about 36 % headroom. The maintainers say concurrent decoders "do not fit".
- micro-opus recommends PSRAM strongly. It uses a 120 KB pseudostack per decoding thread, 30–50 KB of state per instance, and about 640 KB of flash.
- C3 and C6 default to fixed point. **No published C3/C5/C6 Opus numbers were found.** The C3 has no PSRAM and no Xtensa DSP instructions, so 48 kHz stereo CELT on it is a risk to measure, not an assumption to make (experiment E1).

**Frameworks and clients**

- **sendspin-cpp** (Apache-2.0, ESP-IDF ≥ 5.5.2, on the Espressif component registry). Player, source and controller roles. Noise-encrypted WebSocket. Opus, FLAC and PCM decoding. Opus encoding for the source role. The ESPHome mainline has a `sendspin` component (media_player, media_source and sensor sub-components). It has been tested mostly on the ESP32-S3 with PSRAM (Home Assistant Voice PE), according to the Home Assistant forum thread. The Sendspin site advertises an ESP32-S3 + DAC "SendspinZero" build at under $10 per room.
- **CarlosDerSeher/snapclient** (GPL-3.0, active, ESP-IDF 5.5.1). FLAC, Opus and PCM. Original ESP32 and S2, with S3 reports in its issues. It "buffers up to 758 ms on WROOM" (no PSRAM, 44.1k/16/2). It dropped ESP-ADF because ADF's FLAC was a closed binary that "made it impossible to get good results for multiroom syncing". Sync is either **APLL tuning (only with DACs that take MCLK) or sample insertion: "both … keeping clients in sync ≤ 500 µs"**. Issue #148 has the maintainers measuring two ESP32 + PCM5102A boards: "typically within 200–500 µs", with occasional 2–4 ms excursions. A reworked sync "stays already below 100 µs after ~30 seconds". Their Kalman-filter port "converges much faster" than a median filter, because a median filter gets poisoned by Wi-Fi-delayed time packets. The repo also has an experimental `rtprx` component: Opus over raw RTP/UDP, labelled a prototype.
- **pschatzmann arduino-audio-tools** (GPL-3.0, very active) and **arduino-snapclient** (header-only, Opus/PCM, "PSRAM not needed", last pushed 2025-03). Good for prototyping DSP chains and transports such as UDP and ESP-NOW. It is not a sync solution by itself.
- **squeezelite-esp32** (LMS/Squeezebox sync, AirPlay 1, BT). It needs a **WROVER (4 MB PSRAM)**, and WROOM modules do not work. It is built on ESP-IDF 4.3/4.4. It can **output to a Bluetooth speaker at 44.1 kHz only**. On the S3 it has "much more CPU room" but no BT audio.
- **ESP32-audioI2S** (schreibfaul1, GPL-3.0). An excellent internet-radio/file decoder with no multi-device sync. It suits Axis A only if wrapped in a sync layer.
- **Espressif esp_peer / esp-webrtc-solution.** The WebRTC stack is derived from libpeer: ICE, DTLS-SRTP, SCTP data channels, TURN, NACK, jitter buffer, and Opus or G.711. Demos cover WHIP, OpenAI Realtime, Janus, Kurento and others. A minimal setup runs in under 60 KB RAM without PSRAM. It supports the ESP32, S2, S3, C5, C6, C61, P4 and S31. **However, the core ships as a prebuilt `libpeer_default.a` under an "Espressif Modified MIT" licence restricted to Espressif hardware.** It also gives no multi-receiver playout sync, since WebRTC aims for lowest latency, not a common deadline.
- **libpeer (sepfy)** is MIT, C, with a WHIP/MQTT signalling example for the ESP32. It is the open alternative. The DTLS handshake cost on the ESP32 was not measured here (unverified).

**Clock sync on the ESP32**

- The **default SNTP** client is coarse. Guides quote about 100 ms practical accuracy. Smooth mode slews time with `adjtime()`. The ESP-IDF docs give the APB clock as < ±10 ppm. Do not use SNTP for audio sync.
- **Application-level NTP-style exchanges** do achieve sub-ms: the Snapcast Time message, the Sendspin `client/time` bursts and @ircam/sync are all variants of this.
- **Wi-Fi power save must be off.** ESP-IDF's default is `WIFI_PS_MIN_MODEM`, and receive "delay … may be the same as the DTIM cycle". Use `esp_wifi_set_ps(WIFI_PS_NONE)`. In BT coexistence mode, "Wi-Fi sleeps during non-Wi-Fi time slices even when power save is disabled". sendspin-cpp holds high-performance networking for the length of each time burst for this reason.

**Audio-clock drift correction**

- Crystal tolerance is about ±10–20 ppm per device, so two devices can differ by up to about 40 ppm. At 48 kHz, 20 ppm is about **one frame per second**. Sendspin and Snapcast both drop or duplicate single frames. Sendspin specifies N = 1 frame at 44.1/48 kHz and a speed cap of ±0.5 % averaged over 150 ms, and says this is "individually inaudible".
- **APLL fine tuning** is available only on the ESP32, S2, P4 and S31. Snapclient offers it, and the result is similar (≤ 500 µs).
- ESP-IDF now has **`i2s_channel_tune_rate()`**, which tunes MCLK up or down within configured bounds and returns the buffer watermark. Its doc comment says it is allowed only in READY state, and the official USB example disables the channel before tuning "otherwise plosive sounds might break out". It suits coarse rate matching (the UAC use case), not continuous sync. Use sample insertion for sync.

**I2S output hardware** (part characteristics from memory, verify on datasheets)

- **PCM5102A** DAC: line out, no MCLK needed because of its internal PLL from BCK. The default in many snapclient configs.
- **MAX98357A**: mono I2S class-D amplifier, about 3 W into 4 Ω. Ideal for a single small speaker.
- **ES8388** codec: DAC + ADC with line-in and mic. Used on the AI-Thinker ESP32-A1S AudioKit and the LyraT v4.3. Its ADC makes the board a candidate **ESP32 sender**, and the snapclient repo carries an ES8388 noise fix.
- **ES8311** codec on Espressif S3/P4 boards and the Korvo-2.
- M5Stack and LilyGO audio boards use the same parts (exact BOMs unverified).

### 2. ESP32 connectivity beyond venue Wi-Fi

**Phone Wi-Fi hotspot.** This works on every ESP32 and is the default path. Every ESP32 except the C5 is 2.4 GHz-only. Recent iPhones default the hotspot to 5 GHz unless "Maximize Compatibility" is on (from memory). Expect an extra Wi-Fi hop of a few ms with jitter. Keep `WIFI_PS_NONE` on.

**USB tethering, ESP32 as USB host** (S2, S3, P4)

- Espressif ships `iot_usbh_rndis` (v0.5.x) and `iot_usbh_ecm`. Both are **tested only with 4G modules** (ML307R, EC800E, …) and a CH397A adapter. Measured throughput on an S3: about 5.8 Mbps up and 7.9 Mbps down over RNDIS.
- There is **no official USB-host NCM driver**. Community forks exist.
- Android historically used **RNDIS** for USB tethering: the AOSP config default is 0 = RNDIS, and NCM is selectable. A 2026 user report shows a Pixel on Android 16 enumerating as **cdc_ncm**. So an RNDIS-only ESP host may work on older or OEM phones and fail on newer ones.
- The ESP must also *source* VBUS to the phone.

**USB tethering, ESP32 as USB device.** `esp_tinyusb` provides NCM descriptors. The phone would then see a USB Ethernet adapter. Android 11+ has "Ethernet tethering", which shares mobile data over a USB Ethernet adapter, so phone-as-router plus ESP-as-NIC is plausible. As a bonus, the phone powers the ESP. **Unverified end to end** (experiment E10).

**iPhone USB tethering** uses the Apple-specific `ipheth` path, and the Linux driver notes the phone "must be paired, otherwise it won't respond". That is not realistic on an ESP32. A Pi with `usbmuxd` can do it.

**Cellular modules** (`esp_modem` PPP over UART, or `iot_usbh_modem` over USB)

- A7670 (Cat-1, not usable in the USA per Makerfabs), SIM7600 (Cat-4) and SIM7080G (Cat-M/NB-IoT), for example on LilyGO T-SIM boards. esp_modem lists the SIM7600 as supported and has an A7670 CMUX-exit known issue.
- Latency, all from vendor tests or specs: **Cat-1 averaged 69 ms** in one vendor test. Cat-M1 is 10–20 ms on paper but averaged **≈ 117 ms** in a field test, about 50 ms slower than Cat-1. **NB-IoT is 1.6–10 s.**
- Opus at 32–64 kbps fits Cat-1 and Cat-M bandwidth. **NB-IoT is ruled out.** Cat-M is marginal for live use and acceptable for buffered (Axis A). eDRX and PSM must be disabled.

### 3. Bluetooth output from embedded devices

**ESP32 A2DP source** (original ESP32 only today, S31 later)

- ESP-IDF registers an SBC endpoint by default. **AAC** can be registered with `BT_A2DP_USE_EXTERNAL_CODEC` and `ESP_A2D_MAX_SEPS ≥ 2`.
- The source receives the sink's **AVDTP delay report** through `ESP_A2D_REPORT_SNK_DELAY_VALUE_EVT`. The player can feed that value into its `output_delay_ms`.
- Typical A2DP end-to-end latency is 100–200+ ms (third-party figure, unverified). It varies by speaker, and delay reports are only as honest as the speaker firmware.
- Libraries: pschatzmann **ESP32-A2DP** (Apache-2.0) and **squeezelite-esp32** (Wi-Fi in, BT out, 44.1 kHz).
- **Wi-Fi and BT time-share one 2.4 GHz radio**, which adds coexistence risk for a device that receives over Wi-Fi and transmits A2DP at the same time.

**LE Audio / Auracast.** This is the only BT path with a *specified* rendering time: BAP **presentation delay**, rendered simultaneously by every sink in a broadcast.

- Espressif: ESP-BLE-AUDIO (BAP, CAP, PBP, TMAP, … over LC3 and ISO) is documented as a **preview** whose "APIs … are subject to change". `soc_caps.h` flags BLE Audio on the **ESP32-H4** (no Wi-Fi) and the **ESP32-S31**. An Espressif contributor has stated that `esp_bt_audio` supports Auracast broadcast (esp-gmf issue, 2026). Unverified in practice.
- **Nordic nRF5340 Audio DK** (nRF Connect SDK): broadcast source and sink, and an Auracast-compatible preset in `nrf_auraconfig`. One user configuration showed a 40 ms presentation delay, 10 ms frames and 60 ms maximum transport latency. It has no Wi-Fi, so pair it over I2S with an ESP32-S3 or Pi receiver as a **Wi-Fi-to-Auracast bridge**.

### 4. Raspberry Pi as receiver and sender

**Receiver software**

- **snapclient** (Linux, ALSA backend default `buffer_time` 80 ms, min 10). Snapcast claims a deviation "typically below 0.2 ms".
- **Sendspin CLIs**: sendspin-cpp-cli (C++) and sendspin-python-cli (Python). The Home Assistant thread targets "Linux on Raspberry Pi Zero".
- **GStreamer**: RTP/Opus with `rtpbin ntp-sync=true buffer-mode=synced`, a shared `netclientclock`/NTP/PTP pipeline clock, and `rtpjitterbuffer rfc7273-sync`. Sebastian Dröge reported "easily under one frame" of sync between receivers (2015 talk, no benchmark). There are known offset bugs in the RFC 7273 paths.

**Audio path.** Use **ALSA `hw:` directly for sync-critical playback**. PipeWire adds a graph quantum (about 21 ms at 1024/48 kHz, from memory) and is needed mainly for Bluetooth.

**Outputs.** I2S DAC HATs (PCM5102A/PCM512x class) give stable, low, known latency. USB DACs add a few ms and more uncertainty (from memory). The Pi 5 and Zero have no analog jack, and the Pi 3/4 jack is PWM (from memory).

**Hardware choice**

- **Pi Zero 2 W**: 2.4 GHz only, BT 4.2, and Wi-Fi and BT share a combo chip, so avoid it for simultaneous Wi-Fi receive and A2DP. This is from memory.
- **Pi 4 and Pi 5** are dual-band: put Wi-Fi on 5 GHz and BT on 2.4 GHz.

**Pi as A2DP source.** BlueZ + PipeWire/WirePlumber supports SBC, SBC-XQ, AAC, aptX/HD/LL, LDAC, FastStream, LC3plus, PipeWire-only Opus variants and LC3. What actually ships depends on the distro build (unverified for Raspberry Pi OS).

- Delay-report propagation has had bugs. PipeWire issue #2902 saw a reported 300 ms SBC delay that was not applied to the port.
- **LE Audio is not possible on the onboard CYW43455** (BT 5.0, no ISO). An Intel AX210 USB/M.2 controller made BlueZ + PipeWire LE Audio work on a Pi 5.

**Pi as sender.** A USB audio interface goes through ALSA capture and an Opus encoder to the protocol, at trivial CPU cost (from memory). A Pi can also **host the server locally** on its own AP, with an LTE uplink: a "pocket station" for audio walks.

**Pi over LTE**

- USB tethering works with Android (RNDIS/NCM) and the iPhone (`ipheth` + usbmuxd). USB dongles and HATs (Quectel/SIMCom) work with ModemManager.
- NTP over LTE is bounded by path asymmetry, up to half the RTT. A forum estimate puts it at about 100 ms. A Sensys'26 paper finds plain NTP over NB-IoT to be ">100× worse" than its method. chrony can apply a known `asymmetry` but cannot measure it.
- **GPS PPS** gives a Pi about 1–2 µs (PPS-Client, Pi 3, 10 units). That is the only way to get absolute sync between devices on *different* cells without trusting the network. It is attractive for outdoor installations, but browsers cannot read GPS time.

### 5. The common wire protocol

**Sendspin RC1**

- WebSocket. Cleartext JSON init, then a **Noise KKpsk2** handshake. After that, binary messages carry an AEAD payload whose first byte is the type: 0 = JSON, 1 = fragment, 4–7 = player, 12–15 = source.
- **Audio chunk** = `[type][int64 BE timestamp µs, server clock][uint32 BE send_ahead µs][one Opus packet | FLAC frames | PCM]`.
- **Clock**: bursts of ≥ 8 `client/time` messages, each sent after the previous reply, at most 10 s apart. Only the lowest-`max_error` measurement is kept: `measurement = ((T2−T1)+(T3−T4))/2` and `max_error = ((T4−T1)−(T3−T2))/2`. It feeds a Kalman filter `[offset, drift]` with adaptive forgetting, and a reference C++ implementation exists.
- **Player obligations**: ±1 ms floor and ±0.5 ms target at the output, measured against the filter's prediction. That definition *excludes* clock-sync error. No audible correction, and a speed deviation of at most ±0.5 %.
- **Server obligations**: keep each player's queue ≥ `min_buffer_ms` (critical for live). Per-player codec selection: the server MUST support FLAC/PCM and MAY support Opus.
- **Source role**: timestamps capture time in the server domain. The server is "the single place that resamples, transcodes, mixes, buffers, and distributes", which matches the owner's sender-side mixing need.
- Discovery is mDNS. Client-initiated connections "SHOULD" use mDNS. The spec scope says "local IP network". A cloud server reached by URL works with the SDKs, which take a URL, but sits outside the spec's intent.
- The sendspin-js defaults (250 ms lead, 250 ms min buffer) are LAN-oriented.
- Spec licence: Community Specification License 1.0. SDKs: Apache-2.0. Conformance and sync-test repos are being built: a USB-capture chirp cross-correlation tool with about 10 µs resolution.

**Snapcast binary protocol** (v0.35.0, March 2026)

- Little-endian base header with sent and received timestamps. Messages: CodecHeader, WireChunk (server timestamp), Time (ping/pong), Hello and ServerSettings, over TCP or WS.
- Mature clients exist for Linux, Android, ESP32 and the browser (Snapweb).
- Limits: one codec per stream, **no uplink/source role** (sources are pipes, ALSA or librespot on the server), a default end-to-end buffer of 1000 ms, and GPL-3.0 implementations.

**RTP + Opus (RFC 7587) + RFC 7273 + NTP/PTP.** A standards path that suits the ESP32 (UDP) and the Pi (GStreamer). Browsers cannot receive raw RTP: only WebRTC, whose playout deadline a page cannot set precisely. So it fails as the *common* denominator.

**WebRTC.** Good last-mile transport (UDP, NACK/FEC, NAT traversal) for phones, and possible on the ESP32 with esp_peer/libpeer. It is no good as the *sync* layer.

**WebTransport datagrams** are now in Chrome, Firefox and **Safari/iOS 26.4+** (caniuse). They are a good browser-side UDP lane. No mainstream ESP-IDF QUIC/HTTP3 stack is known (unverified).

## Options compared

| Option | Browser | ESP32 | Pi | Sync achieved / required | Live (low-latency) fit | Uplink/source | Maturity, licence | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Sendspin** (WS, Noise, Kalman) | sendspin-js | sendspin-cpp, ESPHome (S3 + PSRAM) | C++/Python CLI | spec ±1 ms (target ±0.5); no independent multi-device data found | per-player `min_buffer_ms`; TCP head-of-line blocking on lossy links | **yes** (`source@v1`) | RC1, very active; Apache-2.0 SDKs | **Adopt as base** |
| Snapcast protocol (TCP/WS) | Snapweb | CarlosDerSeher (≤ 0.5 ms measured), pschatzmann | snapclient (< 0.2 ms claimed) | proven | default 1 s buffer; TCP | no | mature; GPL-3.0 | Reference and fallback |
| RTP/Opus + RFC 7273 + NTP/PTP | no (only via WebRTC) | yes (UDP, `rtprx` prototype) | GStreamer | sub-frame claimed | good (UDP) | yes (RTP send) | standards; LGPL GStreamer | Embedded-only lane |
| WebRTC (esp_peer / libpeer) | native | esp_peer (< 60 KB, Espressif-only licence, binary core) / libpeer (MIT) | GStreamer webrtcbin | no common playout control | best | yes | esp_peer v1.5.8; libpeer MIT | Phone last mile, not sync |
| Custom Opus over WS + @ircam/sync | yes | must port | yes | depends | TCP | custom | in-house | Re-invents Sendspin |
| WebTransport datagrams | yes (Safari 26.4+) | not realistic | yes (aioquic/quic-go) | n/a | good | yes | new | Future browser live lane |
| ESP-NOW rebroadcast (1470 B v2 payload, max 20 peers, broadcast un-ACKed) | no | yes | no | needs own timestamps | very low latency, local only | n/a | ESP-IDF | Niche: local ESP fleet from one gateway |

## Recommendation

1. **Wire protocol: Sendspin, pinned to a spec revision.** Implement our web-hosted server with aiosendspin (Python) or sendspin-go-server. Treat the server as the mixer: the phone or Pi sender uses the `source` role, and the server mixes and re-timestamps. Map the Bluetooth problem onto `output_delay_ms`, which is persisted per output: use the A2DP delay report where one is available and an acoustic calibration otherwise. Contribute upstream where we diverge, rather than forking: WAN/URL connection, cellular-sized buffers and a datagram lane.
2. **Embedded receiver baseline: an ESP32-S3 module with 8 MB octal PSRAM, plus a PCM5102A (line) or MAX98357A (speaker).** Run ESPHome `sendspin` for zero-code devices, or sendspin-cpp under ESP-IDF for custom firmware. Use `WIFI_PS_NONE` and sample-stuffing correction. Keep CarlosDerSeher/snapclient on the same hardware as the measured reference.
3. **Pi receiver and sender:** Pi 4 for Bluetooth and the dual-band work, Pi Zero 2 W for cheap wired nodes. Use an I2S DAC HAT and the Sendspin C++ CLI on ALSA `hw:`. The sender is a Pi with a USB interface in the source role. Use PipeWire only for A2DP.
4. **Low-latency live lane (Axis B), once the baseline is measured.** Carry the *same* 13-byte chunk header and Opus 10 ms packets over UDP: ESP32 and Pi natively, browsers over WebTransport datagrams or WebRTC. Fixed group latency is set as L = max(min_buffer + output_delay) across the group.
5. **Connectivity:** phone hotspot first; a Pi USB-tethered to either phone OS second. Treat ESP32 USB tethering as a research spike. Use Cat-1 modules for SIM-per-device installations.
6. **Bluetooth (Phase 2):**
   - Short term: original ESP32 or Pi 4 as an A2DP source with delay-report compensation.
   - Strategic: LE Audio/Auracast for its presentation delay. An nRF5340 bridge works today. Watch the ESP32-S31.
7. **Rule out:**
   - NB-IoT.
   - Classic ESP32 or C3 as the *Opus* baseline (use FLAC or PCM on LAN if they are needed at all).
   - esp_peer as the core transport, because of its licence and binary blob.
   - SNTP for sync.
   - The Pi Zero 2 W as a simultaneous Wi-Fi + BT node.
   - Raw RTP as the common protocol.
   - Waiting for iPhone USB tethering on ESP32.

## Proposed experiments

| # | Goal | Method | Pass / fail metric |
|---|---|---|---|
| E1 | Opus budget per chip | micro-opus and esp_audio_codec decode benchmarks on ESP32-WROVER, S3-N16R8, C3, C5 and C6 at 48 kHz mono/stereo, 10/20 ms frames, 64/96 kbps, with Wi-Fi, WebSocket and Noise running | RTF ≤ 0.3 and ≥ 50 KB internal RAM free → chip qualifies for Opus over LTE |
| E2 | LAN sync baseline | 2× ESP32-S3+PCM5102A (sendspin-cpp), 1× Pi Zero 2 W + I2S DAC, 1 Android Chrome and 1 iOS Safari against aiosendspin. Sendspin `sync-test` chirps, 96 kHz capture, 1 h | Embedded pairs: p95 \|offset\| ≤ 1 ms, p99 ≤ 2 ms; browser figures recorded separately |
| E3 | Snapcast vs Sendspin on the same boards | Repeat E2 with CarlosDerSeher snapclient + snapserver | Choose the protocol whose embedded p95 is within 0.5 ms of the other at equal buffer and has fewer hard resyncs per hour |
| E4 | Clock sync over LTE | Pi with GPS PPS as ground truth runs the Sendspin time filter (and chrony) against a cloud server over a USB LTE dongle and over a phone tether for 24 h. Two Pis on different operators | Filter error p95 ≤ 2 ms; inter-device (same operator) p95 ≤ 2 ms. Otherwise adopt local or GPS timing for co-located fleets |
| E5 | Fleet on a phone hotspot + LTE | 3 ESP32-S3s on an iPhone hotspot (Maximize Compatibility on) and on an Android hotspot, cloud server by URL. `min_buffer_ms` 150/300/600, 30 min walk | Zero underruns at ≤ 300 ms; co-located p95 ≤ 5 ms |
| E6 | Live lane latency | Pi sender (USB interface, impulse) → server → ESP32-S3 over (a) WS and (b) UDP with the same header. LAN and LTE; `tc netem` 1 %/3 % loss | Mouth-to-ear ≤ 60 ms on LAN and ≤ 200 ms on LTE; ≤ 1 audible glitch per minute at 1 % loss |
| E7 | Drift-correction quality | Sample insertion vs APLL (ESP32 and P4) vs `i2s_channel_tune_rate` on long sine and music | Sync within ±0.5 ms; no artefacts in a blind ABX (n ≥ 10 trials) |
| E8 | A2DP delay reports | Classic ESP32 (ESP32-A2DP) and Pi 4 (PipeWire) to 5 BT speakers. Log the delay report vs the acoustic delay measured with a mic and chirp; check coexistence with a Wi-Fi stream | Reported within ±10 ms of measured on ≥ 3/5 speakers; zero underruns in 30 min |
| E9 | Auracast bridge | ESP32-S3 Sendspin player → I2S → nRF5340 Audio DK broadcast source → 2 LE Audio sinks | End-to-end latency stable within ±2 ms across 10 restarts; sinks ≤ 1 ms apart |
| E10 | ESP32 USB tethering | (a) S3 host + `iot_usbh_rndis` with an older Android (RNDIS) and a recent Pixel (NCM); (b) S3 TinyUSB NCM device + Android Ethernet tethering; (c) Pi with Android and iPhone tethers | DHCP lease and 10 min stable stream with RTT within 5 ms of the hotspot path |
| E11 | Cellular modules | LilyGO A7670 (Cat-1) and SIM7080G (Cat-M) PPP: 50 pps UDP echo for 30 min, then a 64 kbps Opus stream | Cat-1 p99 RTT ≤ 250 ms and no underrun at 500 ms buffer; Cat-M result decides "buffered-only" |

## Open questions

- **Required sync between receivers.** Co-located speakers that hear each other need ≤ 1–2 ms. Listeners spread apart (audio walk) tolerate tens of ms. This decides whether a local timing anchor (a Pi hub or GPS) is mandatory.
- **Is a local hub acceptable?** A Pi on site or in a bag, versus "cloud only". A browser on the hotspot phone cannot host the server.
- **Adopt Sendspin and engage with its governance,** or keep a private protocol? Its RC status means churn: Noise and pairing are recent.
- **Bluetooth hardware strategy.** Classic ESP32 now, an nRF5340 bridge, or wait for the ESP32-S31.
- **Licence of the new repo.** FlanerieMozaic is GPL-3.0, the Sendspin SDKs are Apache-2.0, and snapclient is GPL-3.0.
- **Per-receiver budget, power** (battery, PoE or USB) and whether any receiver needs its own SIM.

## Sources

- Sendspin spec (README, player and source roles, scope/licence): https://github.com/Sendspin/spec ; site: https://www.sendspin-audio.com/
- sendspin-cpp (ESP-IDF ≥ 5.5.2, roles, Noise): https://github.com/Sendspin/sendspin-cpp ; registry: https://components.espressif.com/components/sendspin/sendspin-cpp
- sendspin-js (browser defaults, encryption): https://github.com/Sendspin/sendspin-js ; time filter: https://github.com/Sendspin/time-filter ; sync-test: https://github.com/Sendspin/sync-test ; aiosendspin: https://github.com/Sendspin/aiosendspin
- ESPHome sendspin component: https://github.com/esphome/esphome/tree/dev/esphome/components/sendspin ; HA forum thread: https://community.home-assistant.io/t/new-experimental-sendspin-protocol-formerly-resonate-for-streaming-synchronized-multi-room-audio-and-hifi-music-playback-to-multiple-media-player-appliances-and-smart-speakers-running-esphome-on-esp32-or-linux-on-raspberry-pi-zero/925344
- Snapcast README and binary protocol, snapserver.conf: https://github.com/badaix/snapcast , https://github.com/badaix/snapcast/blob/develop/doc/binary_protocol.md
- ESP32 snapclient (README, Kconfig APLL note, issue #148): https://github.com/CarlosDerSeher/snapclient , https://github.com/CarlosDerSeher/snapclient/issues/148
- pschatzmann: https://github.com/pschatzmann/arduino-audio-tools , https://github.com/pschatzmann/arduino-snapclient , https://github.com/pschatzmann/ESP32-A2DP
- squeezelite-esp32: https://github.com/sle118/squeezelite-esp32 ; ESP32-audioI2S: https://github.com/schreibfaul1/ESP32-audioI2S
- Espressif esp-webrtc-solution / esp_peer (README, LICENSE, libs): https://github.com/espressif/esp-webrtc-solution ; libpeer: https://github.com/sepfy/libpeer
- esp_audio_codec performance: https://components.espressif.com/components/espressif/esp_audio_codec
- micro-opus readme and decode benchmark: https://components.espressif.com/components/esphome/micro-opus/versions/0.4.1/readme , https://components.espressif.com/components/esphome/micro-opus/versions/0.4.1/examples/decode_benchmark
- ESP-IDF soc_caps.h per chip: https://github.com/espressif/esp-idf/tree/master/components/soc ; I2S tuning API: https://github.com/espressif/esp-idf/blob/master/components/esp_driver_i2s/include/driver/i2s_common.h ; I2S docs: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32p4/api-reference/peripherals/i2s.html
- ESP-IDF Wi-Fi power save and throughput: https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/wifi-driver/wifi-performance-and-power-save.html
- ESP-IDF System Time / SNTP: https://docs.espressif.com/projects/esp-idf/en/v5.1/esp32/api-reference/system/system_time.html ; SNTP accuracy guide: https://www.makerguides.com/how-to-synchronize-esp32-clock-with-sntp-server/
- ESP-IDF A2DP API: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/bluetooth/esp_a2dp.html ; A2DP latency (third-party): https://applied-ee.github.io/embedded/docs/audio-projects/bluetooth-audio/a2dp-audio-streaming/
- ESP-BLE-AUDIO (preview): https://docs.espressif.com/projects/esp-idf/en/latest/esp32h4/api-reference/bluetooth/esp-ble-audio.html ; esp-gmf Auracast issue: https://github.com/espressif/esp-gmf/issues/53
- ESP-NOW limits: https://github.com/espressif/esp-idf/blob/master/components/esp_wifi/include/esp_now.h
- USB host RNDIS/ECM: https://docs.espressif.com/projects/esp-iot-solution/en/latest/usb/usb_host/usb_rndis.html , https://docs.espressif.com/projects/esp-iot-solution/en/latest/usb/usb_host/usb_ecm.html ; esp_tinyusb: https://components.espressif.com/components/espressif/esp_tinyusb
- Android tethering RNDIS/NCM: https://wiki.gentoo.org/wiki/Android_USB_tethering , https://discussion.fedoraproject.org/t/usb-tethering-doesnt-work-after-i-updated-my-android-phone-to-android-16/183368 ; Ethernet tethering: https://www.androidpolice.com/2020/04/23/ethernet-tethering-arrives-in-latest-android-11-developer-preview
- iPhone tethering driver: https://sources.debian.org/src/linux/6.19.8-1/drivers/net/usb/ipheth.c ; https://synacktiv.com/publications/ios-a-journey-in-the-usb-networking-stack
- esp_modem: https://docs.espressif.com/projects/esp-protocols/esp_modem/docs/latest/README.html ; LilyGO T-SIM comparison: https://wiki.lilygo.cc/products/t-sim-series/sim.html ; A7670: https://wiki.makerfabs.com/ESP32_S3_4G_LTE_CAT1.html
- Cellular IoT latency: https://www.iotforall.com/the-true-speed-of-cellular-iot , https://hologram.io/blog/nb-iot-vs-cat-m1-vs-cat-1/ , https://docs.aws.amazon.com/whitepapers/latest/implementing-lpwan-solutions-with-aws/lte-m.html
- NTP over LTE: https://devzone.nordicsemi.com/f/nordic-q-a/128560/synchronization-over-lte-nb-iot---sntp-time-accuracy/568576 , https://yasrachandio.github.io/assets/pdfs/Soomro-SynchroNB-Sensys26.pdf , https://kb.meinbergglobal.com/kb/time_sync/time_synchronization_errors_caused_by_network_asymmetries
- GPS PPS on Pi: https://github.com/rascol/Raspberry-Pi-PPS-Client
- GStreamer sync: https://gstreamer.freedesktop.org/data/events/gstreamer-conference/2015/Sebastian%20Dr%C3%B6ge%20-%20Synchronised%20multi-room%20media%20playback%20and%20distributed%20live%20media%20processing%20and%20mixing%20with%20GStreamer.pdf , https://gstreamer.freedesktop.org/documentation/rtpmanager/rtpjitterbuffer.html
- PipeWire/WirePlumber BT codecs and delay issue: https://pipewire.pages.freedesktop.org/wireplumber/daemon/configuration/bluetooth.html , https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/2902
- LE Audio on Pi (AX210): https://ak-experiments.blogspot.com/2025/08/bluetooth-le-audio-on-raspberry-pi-with.html ; Pi BT 5.0 limits: https://argenox.com/library/bluetooth-low-energy/using-raspberry-pi-ble
- nRF5340 Audio / Auraconfig: https://nrfconnectdocs.nordicsemi.com/ncs/latest/nrf/samples/bluetooth/nrf_auraconfig/README.html , https://devzone.nordicsemi.com/f/nordic-q-a/125171/nrf-auraconfig-example-broadcasts-music-but-the-headphone-listening-experience-is-laggy/552252 , https://www.nordicsemi.com/nRF5340AudioDK
- WebTransport support: https://caniuse.com/webtransport
