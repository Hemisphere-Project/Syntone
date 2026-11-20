# Syntone

**One live source, heard in sync on a fleet of phones, ESP32 boards and Raspberry Pis, over WiFi and 4G.** What an FM transmitter and a handful of receivers give you, rebuilt on the networks and devices people already carry.

*Syntoniser*: to tune in to a station. A research project by [Hemisphere](https://github.com/Hemisphere-Project), started November 2026.

> **Status: research, week one.** The clock and the measuring tools exist and are tested. No audio is streamed yet. See [the plan](docs/plan.md).

## The idea

Every piece of audio carries the time it was captured, on a clock all devices share. Every receiver hands it to its audio system at `capture time + D − its own output latency`, so that it is heard at `capture time + D`, where `D` is one delay for the whole group. Devices should then agree with each other within a few milliseconds (the target, tested in the first milestones), and the delay is a number you choose rather than whatever each device ends up with.

What the desk research expects. None of it is measured yet; the [plan](docs/plan.md) lists the experiment and pass mark for each line:

| Situation | Delay | Devices agree within |
|---|---|---|
| Buffered playback | 0.5–10 s, chosen | 1–10 ms |
| Live on venue WiFi, native receivers | 30–80 ms | 1–2 ms |
| Live on venue WiFi, phones in a browser | about 70–200 ms | 1–10 ms |
| Live, phone to phones over LTE | about 200–400 ms | 5–15 ms |
| Live over LTE to Bluetooth speakers | about 450–600 ms | 10–20 ms after calibration |

## What is here

| Path | What |
|---|---|
| [`docs/plan.md`](docs/plan.md) | The research plan: priorities, architecture, milestones, open decisions |
| [`docs/research/`](docs/research/README.md) | Eight research reports the plan is built on |
| [`docs/lab.md`](docs/lab.md) | How to measure sync between real devices with the click test |
| `shared/clock.js` | Clock sync estimator: runs in the browser and in Node, small enough to port to an ESP32 |
| `shared/beats.js` | Decides which clicks to queue on each pass, whatever the device's output delay |
| `server/` | The relay: reference clock, rooms, static pages |
| `deploy/` | Running the relay on a host, behind a reverse proxy |
| `web/lab/` | Click test page: every device clicks on the same beat |
| `lab/analyse-clicks.mjs` | Measures a one-microphone recording of the click test |

## Try the click test

```sh
npm install
npm start          # http://localhost:3700/lab/
npm test
```

Open `/lab/` in two browser tabs or on two devices and tap to join. [docs/lab.md](docs/lab.md) explains how to read and measure the result. Needs Node 20 or later; the analyser needs `ffmpeg`.

## Related work

Syntone stands on ideas from [Snapcast](https://github.com/snapcast/snapcast), [Sendspin](https://github.com/Sendspin/spec), IRCAM's [@ircam/sync](https://github.com/ircam-ismm/sync) and the studio's own [FlanerieMozaic](https://github.com/Hemisphere-Project/FlanerieMozaic). The [landscape report](docs/research/08-landscape-existing-systems.md) says what each covers and where the gap is.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
