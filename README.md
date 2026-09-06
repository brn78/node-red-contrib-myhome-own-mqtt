# node-red-contrib-myhome-own-mqtt

[![npm version](https://img.shields.io/npm/v/node-red-contrib-myhome-own-mqtt.svg)](https://www.npmjs.com/package/node-red-contrib-myhome-own-mqtt)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A professional, high-performance, and reliable **BTicino / Legrand MyHome SCS OpenWebNet (OWN) to MQTT** bidirectional bridge for **Node-RED**.

Designed with **zero external dependencies** (uses native Node.js `net` and `crypto` modules) and featuring **dual outputs**:
1. **MQTT Output**: Publishes structured topics and JSON payloads for home automation controllers and MQTT brokers.
2. **OWN Output**: Emits the raw OpenWebNet bus frames *as-is* in plain text (e.g. `*1*1*21##`), ideal for logging, direct filtering, or custom processing.

Also includes optional **Home Assistant MQTT Auto-Discovery**, automatically publishing retained configuration topics so your lights, covers, thermostats, and contacts appear in Home Assistant without manual YAML!

---

## Features

- **Robust Gateway Connection**:
  - Persistent TCP monitoring session (`*99*1##`) with automatic reconnection and exponential backoff (500ms to 30s).
  - OpenWebNet authentication support: no password (authorized IP range), basic numeric password hash, and **HMAC SHA-1 / SHA-256** (for modern gateways like MyHOMEServer1, F454, MH200N).
  - Safe, serialized command execution via command sessions (`*99*0##`) with configurable inter-command pacing delay.
  - Periodic gateway heartbeat watchdog (`*#13**15##`).

- **Complete Subsystem Translation**:
  - **Lighting (WHO = 1)**: On, Off, Dimmer 10, Dimmer 100, Timed lights (11-18), Flashing/Blinking lights (20-29).
  - **Automation / Shutters (WHO = 2)**: Open, Close, Stop, Position percentages.
  - **Climate & Thermoregulation (WHO = 4)**: Heating, Cooling, Off, Auto modes; Master probe and Slave probes (t1–t8) temperatures; Setpoints and Offsets; Fan coil speeds; Valves and Actuators status; Split AC control.
  - **Dry Contacts (WHO = 25)**: Contact open/closed states, with individual contact inversion support.
  - **CEN & CEN+ Pushbuttons (WHO = 15, 25)**: Pressed, Released, Hold pressure, and Rotary Selectors (slow/quick clockwise/counter-clockwise).
  - **Auxiliary Contacts (WHO = 9)**: Open / Closed.
  - **Scenarios & Programming (WHO = 0, 17)**: Scenario trigger and Scene programmer states.
  - **Gateway Diagnostics (WHO = 13)**: Model, firmware, uptime, date/time, IP, MAC address.
  - **Actuator Lock / Disable (WHO = 14)**: Special light and disable modes.

- **Dual Outputs**:
  - **Output 1 (MQTT)**: `{ topic: "...", payload: "{...}", qos: 0, retain: false }`
  - **Output 2 (OWN)**: `{ payload: "*1*1*21##", topic: "myhome/own/event" }`

- **Optional Home Assistant MQTT Auto-Discovery**:
  - Automatically generates standard discovery payloads (`homeassistant/<component>/.../config`) with `retain: true` for lights, covers, thermostats, contacts, and gateway connectivity.

---

## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
cd ~/.node-red
npm install node-red-contrib-myhome-own-mqtt
```

Or install directly via the Node-RED Palette Manager by searching for `node-red-contrib-myhome-own-mqtt`.

---

## Architecture & Wiring

```
                    ┌──────────────────────────────┐
                    │    MyHome Gateway (TCP)      │
                    └──────────────┬───────────────┘
                                   │ OpenWebNet
                                   ▼
[MQTT in / Flow] ──► ┌───────────────────────────┐ ──► Port 1: [MQTT out / Broker]
(Commands/Topics)    │  myhome-own-mqtt (Bridge) │
                     └───────────────────────────┘ ──► Port 2: [Debug / OWN as-is]
```

---

## MQTT Topic Reference

### Status Topics (Emitted on Output 1)

| Subsystem | MQTT Topic | Payload Example |
|---|---|---|
| **Lighting** | `<WHERE>/<BUS>/light/myhome/status` | `{"state":"ON","brightness":255,"attributes":{...}}` |
| **Automation** | `<WHERE>/<BUS>/cover/myhome/status` | `{"state":"opening","position":255,"attributes":{...}}` |
| **Climate Action** | `<ZONE>/action/climate/myhome/status` | `{"state":"heating","attributes":{...}}` |
| **Climate Temp** | `<ZONE>/temperature/climate/myhome/status` | `{"state":21.5,"attributes":{...}}` |
| **Climate Slave** | `<ZONE>/<SLAVE>/temperature/climate/myhome/status` | `{"state":20.8,"attributes":{...}}` |
| **Climate Setpoint**| `<ZONE>/setpoint/climate/myhome/status` | `{"state":20.5,"attributes":{...}}` |
| **Climate Mode** | `<ZONE>/mode/climate/myhome/status` | `{"state":"heat","attributes":{...}}` |
| **Climate Fan** | `<ZONE>/fan/climate/myhome/status` | `{"state":"medium","percentage":66,"attributes":{...}}` |
| **Dry Contact** | `<NUMBER>/contact/myhome/status` | `{"state":"ON","attributes":{"contact_state":"CLOSED"}}` |
| **Auxiliary** | `<WHERE>/aux/myhome/status` | `{"state":"ON","attributes":{"contact_state":"CLOSED"}}` |
| **CEN Button** | `<WHERE>/<BUTTON>/<BUS>/button/myhome/status` | `{"state":"ON","trigger":"PRESSED","attributes":{...}}` |
| **CEN+ Button**| `<WHERE>/<BUTTON>/button/plus/myhome/status` | `{"state":"ON","trigger":"PRESSED","attributes":{...}}` |
| **Scenarios** | `<WHERE>/<WHAT>/<BUS>/scenarios/myhome/status` | `{"state":"ON","attributes":{"scenarios":1}}` |
| **Scene** | `<WHERE>/<BUS>/scene/myhome/status` | `{"state":"ON","attributes":{"started":true}}` |
| **Gateway Info** | `gateway/myhome/status` | `{"state":"ON","attributes":{"info":"F454"}}` |
| **Connection** | `connection/myhome/status` | `{"state":"ON","attributes":{"function":"Connection watchdog"}}` |

`<BUS>` is `"00"` for the private riser or `"01"`–`"15"` for a local bus.

---

### Command Topics (Received on Input)

| Command | MQTT Topic | Payload | Resulting OWN Frame |
|---|---|---|---|
| **Light On/Off** | `<WHERE>/<BUS>/light/myhome/set` | `"on"` / `"off"` | `*1*1*<WHERE>##` / `*1*0*<WHERE>##` |
| **Light Dimmer** | `<WHERE>/<BUS>/brightness/myhome/set` | `0`–`255` | `*#1*<WHERE>*#1*<100-200>*0##` |
| **Cover Control**| `<WHERE>/<BUS>/cover/myhome/set` | `"open"`, `"close"`, `"stop"` | `*2*1*<WHERE>##`, `*2*2*<WHERE>##`, `*2*0*<WHERE>##` |
| **Climate Setpoint** | `<ZONE>/setpoint/climate/myhome/set` | `21.5` | `*#4*<ZONE>*#7*1*1*0215##` |
| **Climate Delta**| `<ZONE>/setpoint/delta/climate/myhome/set` | `1` or `-1` | Adjusts setpoint and sends update |
| **Climate Mode** | `<ZONE>/mode/climate/myhome/set` | `"heat"`, `"cool"`, `"auto"`, `"off"` | Sends mode command |
| **Climate Fan** | `<ZONE>/fan/climate/myhome/set` | `"auto"`, `"low"`, `"medium"`, `"high"` | `*#4*<ZONE>*#11*<speed>##` |
| **Scene Control**| `<WHERE>/<BUS>/scene/myhome/set` | `"on"`, `"off"`, `"enabled"`, `"disabled"` | `*17*<1-4>*<WHERE>##` |
| **Scenarios** | `<WHERE>/<BUS>/scenarios/myhome/set` | `1`–`20` | `*0*<WHAT>*<WHERE>##` |
| **System Sync** | `myhome/sync` or `sync/myhome/set` | any | Queries all configured contacts & zones |
| **Direct OWN** | *(no topic or any topic)* | `"*1*1*21##"` or array | Sends command directly to SCS bus |

---

## Configuration Options

### Gateway Node (`myhome-own-mqtt-gateway`)
- **Host / IP**: IP address or hostname of the OpenWebNet gateway (e.g. `192.168.1.35`).
- **Port**: Gateway OpenWebNet port (default: `20000`).
- **Password**: Numeric OpenPass or alphanumeric HMAC password. Leave blank if IP range authentication is enabled.
- **Keep-Alive**: Interval in seconds between keep-alive heartbeat frames (default: `60`).
- **Inter-Command Delay**: Pacing delay in milliseconds between sequential commands sent to the bus (default: `50`).

### Main Node (`myhome-own-mqtt`)
- **Climate Zones**: Comma-separated list of active climate zones (e.g. `0,21,22,23,24`). `0` represents the Central Unit.
- **OFF Mode**: Select whether turning climate off sets `303` (standard OFF) or `302` (thermal/frost protection OFF).
- **Dry Contacts**: Comma-separated list of dry contact numbers (e.g. `1,2,3,4`).
- **Dry Contacts Reversed**: Comma-separated list of contacts whose polarity is reversed (e.g. `1,2`).
- **Auto-Discovery**: Enable automatic Home Assistant MQTT discovery (`homeassistant/<component>/.../config`).
- **Discovery Prefix**: MQTT discovery prefix (default: `homeassistant`).
- **Auto Sync**: Automatically query states on gateway connection.
- **Periodic Sync**: Periodic refresh interval in seconds (default: `300`).
- **Watchdog**: Periodically checks gateway responsiveness.

---

## License

MIT © 2026 Bruno Leonardi & Antigravity
