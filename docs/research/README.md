# Research reports

Desk research of 2026-11-20, one report per axis, each written by an independent research agent (Claude Opus 5.5) from primary sources where it could reach them. They are the basis of [the plan](../plan.md). Nothing in them has been measured by this project; each report marks the claims it could not verify, and proposes the experiments that would.

| # | Report | Its answer in one line |
|---|---|---|
| 01 | [Prior art in-house: FlanerieMozaic](01-prior-art-flaneriemozaic.md) | The clock layer carries over to audio; the media-element steering (50 ms dead band, 10 % rate steps) does not |
| 02 | [Clock sync and synchronised playout](02-clock-sync-and-playout.md) | Three errors add up: network clock, audio clock drift, output latency. One AudioWorklet engine with a small resampler handles the first two; the third needs calibration |
| 03 | [Low-latency live transport](03-low-latency-live-transport.md) | Over LTE a fleet that plays together needs a common delay of about 200–400 ms. The receiver must own playout; stock WebRTC cannot align receivers |
| 04 | [Buffered sync and the mobile web platform](04-buffered-sync-and-mobile-web-platform.md) | A web page is enough for a foreground receiver; guaranteed locked-screen playback and capturing other apps need a native shell |
| 05 | [Sender side: capture and mixing](05-sender-capture-and-mixing.md) | No phone browser can capture another app's audio. A Raspberry Pi hub that phones cast *to* is the pragmatic sender |
| 06 | [Embedded receivers: ESP32 and Raspberry Pi](06-embedded-receivers-esp32-rpi.md) | ESP32-S3 with an I2S DAC decodes Opus comfortably; Sendspin is an existing protocol that browsers, ESP32 and Pi already speak |
| 07 | [Bluetooth output latency](07-bluetooth-output-latency.md) | 100–300 ms, not fixed, and reported only as an estimate the speaker declares, often wrong. Calibrate by microphone; Auracast is the only Bluetooth mode with a defined shared delay |
| 08 | [Landscape: existing systems](08-landscape-existing-systems.md) | Nothing covers the whole brief. Low-delay systems do not sync receivers; synced systems buffer a second and stay on a local network |

Where reports disagree, the plan says which way it went and why:

- **Wire format.** Reports 06 and 08 recommend adopting Sendspin's now; report 03 proposes a frame of our own; report 02 points at Snapcast's protocol for fixed nodes. The plan keeps its own frame through the first milestones, measures Sendspin as a baseline, and decides at the embedded milestone.
- **Clock sync code.** Report 01 recommends vendoring `@ircam/sync`; report 08 warns against a home-grown algorithm; report 04 allows a small NTP-style estimator. The repo has its own small estimator using the same method, and the first milestone checks it against `@ircam/sync`.
- **Delay over LTE.** 120–250 ms (08), 150–350 ms (07), 200–400 ms (03). The plan follows 03, the report that studied the network.
