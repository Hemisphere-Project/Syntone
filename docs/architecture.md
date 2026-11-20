# Syntone — one core, interchangeable parts

*2026-11-20. A design, not a description of what exists: the first build has one part behind each seam. Expected figures come from the [research reports](research/README.md); none is measured.*

The first use of Syntone is demanding in one direction: people's own phones, at a demonstration, over 4G, with nothing to configure and nothing that locates them. Other uses are demanding in other directions: an installation with its own WiFi and its own players, where a GPS clock and a device registry are welcome and 2 ms matters.

These are the same project if three things hold:

1. **A small core never changes**, whatever the setting.
2. **Everything a setting may want done differently is a part behind a seam**: a narrow interface with several possible implementations.
3. **A profile names a choice of parts and a policy** on what devices may be asked. The strictest policy is the default; anything looser is chosen by an operator, on purpose.

## 1. The core

Four things are the same in every profile:

- **The timeline.** A room has one timeline, counted in microseconds. A frame is a sequence number, a capture time on that timeline, and a payload that names its codec.
- **The playout rule.** A receiver hands a sample to its audio system at `capture time + D − L(device)`, so that it is heard at `capture time + D`. `D` belongs to the group, `L` to the device.
- **The receiver's contract.** Given frames and a way to turn timeline time into its own audio clock, hold the rule; follow drift gently; when data is late, play silence and rejoin exactly on time.
- **The measuring method.** The click test and its analyser ([lab guide](lab.md)) work the same on a phone, a Pi or an ESP32. What a profile achieves is a number from it.

## 2. The seams

| Seam | The question it answers | Parts: **built**, planned, *possible* |
|---|---|---|
| Time base | What time is it on the room's timeline? | **Exchange with the relay**; the same with a relay on site; *satellite time (GPS)*; *PTP on a wired network* |
| Transport | How do frames travel? | WebSocket; WebTransport datagrams; WebRTC DataChannel; plain UDP; *UDP multicast on a dedicated network* |
| Topology | Through what? | **One hosted relay**; a relay on site; a chain (hosted relay feeding a relay on site); *the sender as its own relay* |
| Codec | In what form? | Opus at 20, 10 or 5 ms; plain PCM on a local network |
| Player | What runs the receiver's contract? | Browser page; the same page in a native app; Raspberry Pi; ESP32 |
| Output latency | How does a device learn its own `L`? | **Reported by the system**; **set by an operator**; measured by its own microphone; measured by a reference device; fixed by design (an ESP32 with an amplifier has one value per model) |
| Joining | How does a device get in, and who is it? | A link or QR code, anonymous; *provisioned devices with names, remote settings and monitoring* |
| Source | Where does audio come from? | Browser sender; Raspberry Pi hub; *native capture* |
| Last hop | What makes the sound? | The device's own output; *local rebroadcast (Auracast, FM)* |

Each seam is an interface small enough to state in a few lines. The two that matter first:

```js
// Time base — the player never knows which one it has
timeBase.toLocal(timelineMs)     // → this device's clock
timeBase.toTimeline(localMs)
timeBase.boundMs                 // honest worst case, shown to the operator

// Transport — the relay and the player never know which one carries the frames
transport.send(frame)
transport.onFrame = (frame) => {}
transport.stats                  // loss, lateness
```

Three cautions about mixing parts:

- **One time base rules a room.** Two devices on different time bases agree only as well as the room's timeline is tied to both. GPS time on a receiver is worth nothing if the relay's own clock is a cloud server's, good to a few milliseconds. A room declares one time base as its reference; another is usable only when the relay publishes how its timeline maps to it, and how precisely.
- **Not every part suits every player.** A browser cannot receive plain UDP or read satellite time; an ESP32 cannot speak WebTransport. A room therefore often carries the same frames over two transports at once.
- **Multicast on WiFi is not free.** Access points send it slowly and without retries unless the network is set up for it. It belongs to networks the operator controls, and has not been through desk research yet.

## 3. Policy: what a room may ask of a device

A room carries a policy, set by its operator. It is sent to a device before the device joins, and both sides hold to it.

| Policy item | Values | Default |
|---|---|---|
| Identity | none · a device name | none |
| Reports from devices | none · anonymous counts · per device | anonymous counts |
| Location | never · opt-in · required | never |
| Microphone | never · opt-in · required | never |
| Records kept by the relay | none · operational | none |

Three consequences:

- **A relay started with no configuration is a public relay.** Looser policies are switched on by someone, for a room, deliberately.
- **Off means absent.** A page served for a public room does not contain the parts that locate or identify: they are not loaded, so the claim can be checked by reading what the page fetched.
- **A device says what the room asks.** When a room asks for anything beyond the default, the listener sees it before joining, in plain words, and can decline.

## 4. Joining: each device gets the best path it has

On joining, a device says what it has: time bases, transports, codecs, ways to learn its latency, what kind of player it is. The relay answers with what the room uses and what that device should use.

- **Groups.** A room is one timeline. Inside it, a group is the set of devices that share a space and therefore share one delay `D`. The relay sets each group's `D` from the worst path and slowest output among its members. Two groups may have different delays; two devices in one space never do.
- **Requirements.** A room may require a capability (for example a time base good to 1 ms). A device that cannot meet it is told so, and why, rather than joining out of sync.
- **Fallback.** A device takes the best transport it shares with the relay and falls back to WebSocket, with the deeper buffer that implies.

## 5. Profiles

A profile is a starting point with a name, not a mode locked into the code.

| Profile | Setting | Time base | Transport | Devices and latency | Policy | Expected delay | Expected agreement |
|---|---|---|---|---|---|---|---|
| **Street** (the first) | The public's phones, 4G | Hosted relay | WebSocket, then datagrams | Browser page; latency as reported, calibration opt-in | Default, strictest | 200–600 ms | 5–15 ms |
| **Venue** | The public's phones on the venue's WiFi | Relay on site | Datagrams on the local network | Browser page | Default | 70–200 ms | 1–10 ms |
| **Installation** | Operated players on a dedicated network | Relay on site, or PTP when wired | UDP, unicast or multicast | Pi, ESP32, studio phones; latency set per device or fixed by design | Named devices, monitoring | 30–80 ms | 1–2 ms |
| **Operated outdoors** | Studio devices over 4G, outdoors | Satellite time, with a relay disciplined by it | Datagrams, UDP | Pi, ESP32, native app; location allowed | Named devices, location required | 200–400 ms | set by the outputs, not the network |
| **Trunk and last hop** | A distant source, a local audience | Relay on site, fed by the hosted one | 4G between relays, local beyond | Any of the above locally | As the local profile | The 4G leg adds to the local delay | As the local profile |

The compromises, said plainly:

- **Street** trades delay for reach and privacy. It cannot promise more than the phones report about themselves.
- **Venue** gains delay and agreement by putting the relay in the room. It needs the audience on the venue's WiFi, which is a setting unless the network is open and the join link does the rest.
- **Installation** gains the most, because every unknown becomes a known: the network, the devices, their outputs. It costs an operator.
- **Operated outdoors** removes the 4G clock bias. It needs location, which is why it is for the studio's devices and never the default.
- **Trunk and last hop** keeps the public's devices off the 4G path altogether, when there is something local to carry the sound.

## 6. What this asks of the first build

Building only the Street profile, but with the seams in place, costs little now and a rewrite later if skipped:

- The clock estimator is already separate from the connection ([shared/clock.js](../shared/clock.js)); the player takes a time base, not a socket.
- The click test's three mapping modes and its trim are already the first two latency sources; the player takes `L` from a source, not from a setting.
- The relay's `hello` carries what the device has; the room carries its policy and its groups. With one part each, the answer is always the same, and the path exists.
- A frame names its codec. The transport sits behind `send` and `onFrame`, with WebSocket as its only implementation.
- The player's behaviour is written as test vectors (these frames, this clock trace, those output positions), so a port to a Pi or an ESP32 can be checked before it makes a sound.

And one rule to keep the project small: **a second part is added to a seam only with a measurement showing what it buys, in a named profile.**
