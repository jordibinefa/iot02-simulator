# IoT-02 Simulator

> **[Llegeix-me en català](LLEGEIX-ME.md)**

A browser-based simulator for the **IoT-02 board** (ESP32-S3), powered by a patched QEMU
with custom SSD1306 OLED, BME280 and OpenEth emulation. Compile Arduino sketches in your computer, upload binaries, and interact with a live digital twin — no physical board required.

## How it works

```
Browser (student)                     Backend (Node.js)
─────────────────────                 ──────────────────────────────────────
Write sketch (editor)                 POST /compile
Upload ZIP or .bin       ──────►      arduino-cli → esp32:esp32@3.0.7
                                      Returns compiled firmware
Interactive digital twin ◄──────      WebSocket ↔ QEMU (ESP32-S3, Xtensa)
  LEDs / Buttons                      GPIO, I²C (SSD1306, BME280), ADC
  OLED canvas                         OpenEth → slirp → host network
  BME280 / LDR sliders

External MQTT clients    ◄──────────► MqttBridge ↔ QEMU sessions
  Node-RED, Snap!, etc.               Topics: iot02/{sessionId}/state|action
```

Up to **30 concurrent QEMU sessions** per instance.

---

## Installation

Choose your setup:

- [Linux virtual machine (Debian / Ubuntu)](#option-a--linux-virtual-machine-debian--ubuntu)
- [Windows with WSL2](#option-b--windows-with-wsl2)
- [VPS with Traefik and HTTPS](#option-c--vps-with-traefik-and-https)

---

## Option A — Linux virtual machine (Debian / Ubuntu)

### Prerequisites

- Debian 13 / Ubuntu 22.04 or later
- At least **4 GB RAM** and **2 CPU cores** assigned to the VM
- Internet connection for the first `docker pull`

### 1. Install Docker Engine

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli \
  containerd.io docker-buildx-plugin docker-compose-plugin

# Optional: run Docker without sudo
sudo usermod -aG docker $USER && newgrp docker
```

> **Debian 13 (trixie):** if the repository fails, replace `$VERSION_CODENAME` with
> `bookworm` in the echo command above. The packages are compatible.

### 2. Get the project

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
```

### 3. Pull the pre-built image

```bash
docker pull jordibinefa/iot02sim:latest
```

This downloads the pre-built image (~2.8 GB) from Docker Hub. **No local compilation needed.**
The image includes a patched QEMU, arduino-cli, esp32:esp32@3.0.7 and all dependencies.

### 4. Start

```bash
docker compose -f docker-compose.local.yml up -d
```

### 5. Verify

Open `http://localhost:5555` in your browser. The interface automatically selects the language based on your browser settings (Catalan, Spanish or English). To force a specific language, navigate directly to `index.ca.html`, `index.en.html` or `index.es.html`.

```bash
curl http://localhost:5555/status
```

The MQTT broker is also available at `localhost:1883` (MQTT) and `localhost:9001` (WebSockets),
with no username or password required.

---

## Option B — Windows with WSL2

### Prerequisites

- Windows 10 (21H2 or later) or Windows 11
- WSL2 enabled with an Ubuntu distribution installed

### 1. Enable WSL2

Open PowerShell **as administrator**:

```powershell
wsl --install
# Restart if prompted
```

If WSL is already installed but running version 1:

```powershell
wsl --set-default-version 2
```

### 2. Install Docker Desktop

Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/).

During installation, make sure **"Use the WSL 2 based engine"** is checked.

Once installed, open Docker Desktop → **Settings → Resources → WSL Integration** and enable
integration with your Ubuntu distribution.

### 3. Pull the pre-built image and start

Open the Ubuntu (WSL) terminal:

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
docker pull jordibinefa/iot02sim:latest
docker compose -f docker-compose.local.yml up -d
```

This downloads the pre-built image (~2.8 GB) from Docker Hub. **No local compilation needed.**

### 4. Verify

Open `http://localhost:5555` in your Windows browser (Chrome, Edge...). The interface automatically selects the language based on your browser settings. If it doesn't work the first time, repeat again:
```bash
docker compose -f docker-compose.local.yml up -d
```

The MQTT broker is also available at `localhost:1883` (MQTT) and `localhost:9001` (WebSockets),
with no username or password required.

> **Note:** WSL2 automatically forwards ports to the Windows host. No extra configuration needed.

---

## Option C — VPS with Traefik and HTTPS

### Prerequisites

- VPS running Debian/Ubuntu with Docker installed
- Traefik running with the external network `proxy` and a `letsencrypt` certresolver
- A DNS record pointing to the VPS

### 1. Point your DNS

At your DNS provider, add an A record:

```
iot02sim.yourdomain.com  →  YOUR_VPS_IP
```

### 2. Configure the domain

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator

sed -i 's/iot02sim.exemple.cat/iot02sim.yourdomain.com/g' docker-compose.vps.yml
```

### 3. Pull the pre-built image and start

```bash
docker pull jordibinefa/iot02sim:latest
docker compose -f docker-compose.vps.yml up -d
```

### 4. Verify

```bash
curl https://iot02sim.yourdomain.com/status
```

> **Note:** The HTTPS certificate may take a few minutes to issue on first run.

### CORS configuration (Traefik)

Copy `middlewares-cors.yml` to your Traefik dynamic configuration directory and add your
allowed origins. The file already includes `https://snap.berkeley.edu` for Snap! integration.

---

## Arduino IDE setup

To compile sketches and generate binaries compatible with the simulator, see:

**[ARDUINO-IDE.md](ARDUINO-IDE.md)**

This guide covers installing the esp32 core 3.0.7, adding the IoT-02 board package, exporting
compiled binaries, and loading them into either the local or online simulator.

---

## MQTT remote control

The simulator exposes a bidirectional MQTT bridge. Any MQTT client can subscribe to session
state updates or send actions to a running simulator session.

### Topic reference

| Direction | Topic | Payload |
|-----------|-------|---------|
| State → subscribers | `iot02/{sessionId}/state/gpio` | `{"pin":19,"value":1}` |
| State → subscribers | `iot02/{sessionId}/state/oled` | `{"png":"<base64>"}` |
| State → subscribers | `iot02/{sessionId}/state/bme` | `{"temp":22.5,"rh":48,"pressure":1013}` |
| State → subscribers | `iot02/{sessionId}/state/ldr` | `{"value":500}` |
| State → subscribers | `iot02/{sessionId}/info` | `{"sessionId":"...","mac":"AA:BB:...","active":true}` *(retained)* |
| State → subscribers | `iot02/sessions` | `[{"sessionId":"...","mac":"..."},...]` *(retained)* |
| Action → simulator | `iot02/{sessionId}/action/button` | `{"pin":0,"value":1}` |
| Action → simulator | `iot02/{sessionId}/action/bme` | `{"temp":22.5,"rh":48,"pressure":1013}` |
| Action → simulator | `iot02/{sessionId}/action/ldr` | `{"value":300}` |

### Terminal examples

```bash
# List active sessions
mosquitto_sub -h localhost -t "iot02/sessions" -C 1

# Subscribe to OLED updates (PNG frames as base64)
mosquitto_sub -h localhost -t "iot02/YOUR_SESSION_ID/state/oled"

# Press button on GPIO 0
mosquitto_pub -h localhost \
  -t "iot02/YOUR_SESSION_ID/action/button" \
  -m '{"pin":0,"value":1}'

# Set BME280 temperature to 35 °C
mosquitto_pub -h localhost \
  -t "iot02/YOUR_SESSION_ID/action/bme" \
  -m '{"temp":35,"rh":60,"pressure":1013}'
```

---

## URL schemes

Load firmware directly via URL hash parameters:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `#run:` | Load and run a `.bin` URL immediately | `#run:https://example.com/fw.bin` |
| `#open:` | Open firmware without running | `#open:https://example.com/fw.bin` |
| `sid=` | Request a specific session ID | `#run:...&sid=mylab01` |
| `mac=` | Request a specific MAC address | `#run:...&mac=AA:BB:CC:DD:EE:FF` |
| `bin=` | Alias for `#run:` (GET parameter) | `?bin=https://...` |
| `code=` | Load sketch source code into editor | `?code=https://...` |

---

## Container management

```bash
# Stop
docker compose -f docker-compose.local.yml down

# Restart
docker compose -f docker-compose.local.yml restart

# Follow logs
docker compose -f docker-compose.local.yml logs -f

# Server status (sessions, cache)
curl http://localhost:5555/status
```

---

## Server limits

| Measure | Local value | VPS value | Description |
|---------|:-----------:|:---------:|-------------|
| Concurrent sessions | 30 | 30 | Max simultaneous QEMU instances |
| Concurrent compilations | 4 | 4 | Protects CPU |
| Max memory | 4 GB | 8 GB | Docker limit |
| Compile queue | 20 | 20 | Prevents backlog |
| Rate limit per session | 30 s | 30 s | Between compilations |
| Compilation timeout | 120 s | 120 s | First build; 10 s if cached |
| Max source / firmware size | 6 MB | 6 MB | Prevents abuse |
| SHA256 cache | 200 entries | 200 entries | Same firmware → no recompilation |
| Session inactivity timeout | 15 min | 15 min | Frees QEMU process |

---

## File structure

```
iot02-simulator/
├── backend/
│   ├── server.js           ← Express + WebSocket + compilation + session API
│   ├── QemuManager.js      ← QEMU process lifecycle and session management
│   ├── MqttBridge.js       ← Bidirectional MQTT ↔ QEMU bridge
│   └── package.json
├── frontend/
│   ├── index.html          ← Language detector (redirects to index.ca/en/es.html)
│   ├── index.ca.html       ← Catalan UI
│   ├── index.en.html       ← English UI
│   ├── index.es.html       ← Spanish UI
│   ├── css/
│   ├── js/
│   │   ├── i18n.js         ← UI translations (ca / en / es)
│   │   └── ...
│   └── imatges/
├── qemu-devices/
│   └── ethernet_shim/      ← C headers injected into sketches for QEMU networking
├── calib-patches/          ← Patches applied to QEMU source (SSD1306, BME280, eFuse MAC)
├── calib-src.tar.gz        ← Patched QEMU source (calib fork, ESP32-S3 support)
├── libraries/              ← Arduino libraries bundled in the image
├── Dockerfile              ← Two-stage build: QEMU + Node.js service
├── entrypoint.sh
├── mosquitto.conf          ← Minimal Mosquitto configuration (anonymous, no auth)
├── docker-compose.local.yml  ← Local use (VM / WSL), port 5555, pre-built image
├── docker-compose.yml        ← Local use (VM / WSL), port 5555, build from source
├── docker-compose.vps.yml    ← VPS with Traefik + HTTPS
├── middlewares-cors.yml    ← Traefik CORS middleware
├── ARDUINO-IDE.md          ← Arduino IDE setup guide (English)
├── ARDUINO-IDE.ca.md       ← Guia de configuració de l'IDE d'Arduino (català)
├── README.md               ← This file (English)
└── LLEGEIX-ME.md           ← Català
```

---

## Building from source

If you prefer to build the image locally instead of pulling from Docker Hub, use
`docker-compose.yml` (which mounts the local source files and builds the image):

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
docker compose up -d
```

The build compiles QEMU (calib fork) with ESP32-S3 patches, installs arduino-cli, downloads
`esp32:esp32@3.0.7`, patches `libesp_eth.a` for OpenEth support, and installs Node.js
dependencies. **Expect 20–40 minutes** on a modern machine.

---

## Troubleshooting

**Browser shows "No connection" immediately**
Check that the container is running: `docker compose -f docker-compose.local.yml ps`

**Session never starts after uploading firmware**
The VM may not have enough RAM. Assign at least 4 GB. Check logs:
`docker compose -f docker-compose.local.yml logs iot02sim`

**MQTT bridge not connecting**
Verify the mosquitto container is running:
`docker compose -f docker-compose.local.yml ps mosquitto`

**HTTPS certificate not appearing** (VPS)
Wait a few minutes. Check DNS: `dig iot02sim.yourdomain.com`

**"arduino-cli not found" during build**
Rebuild from scratch: `docker build --no-cache -t jordibinefa/iot02sim:latest .`

**Interface shows in the wrong language**
The language is detected from browser preferences. To force a language, navigate directly to `index.ca.html`, `index.en.html` or `index.es.html`.

---

## Licence

MIT — free to use, adapt and share for educational purposes.
