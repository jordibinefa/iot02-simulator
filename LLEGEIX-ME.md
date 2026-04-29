# Simulador IoT-02

> **[Read in English](README.md)**

Simulador web per a la placa **IoT-02** (ESP32-S3), basat en un QEMU adaptat (patched) amb emulació
personalitzada de la pantalla SSD1306 OLED, el sensor BME280 i la interfície OpenEth.
Compila els codis d'Arduino al navegador, puja els binaris i interactua amb un bessó digital en viu —
sense necessitat de tenir cap placa física.

## Com funciona

```
Navegador (alumne)                    Backend (Node.js)
─────────────────────                 ──────────────────────────────────────
Escriure sketch (editor)              POST /compile
Pujar ZIP o .bin         ──────►      arduino-cli → esp32:esp32@3.0.7
                                      Retorna el firmware compilat
Bessó digital interactiu ◄──────      WebSocket ↔ QEMU (ESP32-S3, Xtensa)
  LEDs / Botons                       GPIO, I²C (SSD1306, BME280), ADC
  Canvas OLED                         OpenEth → slirp → xarxa host
  Sliders BME280 / LDR

Clients MQTT externs      ◄──────────► MqttBridge ↔ sessions QEMU
  Node-RED, Snap!, etc.               Topics: iot02/{sessionId}/state|action
```

Fins a **30 sessions QEMU simultànies** per instància.

---

## Instal·lació

Tria el teu cas:

- [Màquina virtual Linux (Debian / Ubuntu)](#opció-a--màquina-virtual-linux-debian--ubuntu)
- [Windows amb WSL2](#opció-b--windows-amb-wsl2)
- [VPS amb Traefik i HTTPS](#opció-c--vps-amb-traefik-i-https)

---

## Opció A — Màquina virtual Linux (Debian / Ubuntu)

### Requisits previs

- Debian 13 / Ubuntu 22.04 o superior
- Mínim **4 GB de RAM** i **2 CPU** assignats a la VM
- Connexió a Internet per al primer `docker pull`

### 1. Instal·lar Docker Engine

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

# Opcional: evitar escriure sudo a cada comanda
sudo usermod -aG docker $USER && newgrp docker
```

> **Debian 13 (trixie):** si el repositori falla, substitueix `$VERSION_CODENAME` per
> `bookworm` a la comanda echo. Els paquets són compatibles.

### 2. Obtenir el projecte

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
```

### 3. Descarregar la imatge precompilada

```bash
docker pull jordibinefa/iot02sim:latest
```

Descarrega la imatge precompilada (~2,8 GB) des de Docker Hub. **No cal compilar res localment.**
La imatge inclou un QEMU parchejat, arduino-cli, esp32:esp32@3.0.7 i totes les dependències.

### 4. Arrencar

```bash
docker compose -f docker-compose.local.yml up -d
```

### 5. Verificar

Obre `http://localhost:5555` al navegador.

```bash
curl http://localhost:5555/status
```

---

## Opció B — Windows amb WSL2

### Requisits previs

- Windows 10 (21H2 o superior) o Windows 11
- WSL2 habilitat amb una distribució Ubuntu instal·lada

### 1. Habilitar WSL2

Obre PowerShell **com a administrador**:

```powershell
wsl --install
# Reinicia l'ordinador si te ho demana
```

Si ja tens WSL instal·lat però en versió 1:

```powershell
wsl --set-default-version 2
```

### 2. Instal·lar Docker Desktop

Descarrega i instal·la [Docker Desktop per a Windows](https://www.docker.com/products/docker-desktop/).

Durant la instal·lació, assegura't que l'opció **"Use the WSL 2 based engine"** està marcada.

Un cop instal·lat, obre Docker Desktop → **Settings → Resources → WSL Integration** i activa
la integració amb la teva distribució Ubuntu.

### 3. Descarregar la imatge i arrencar

Obre el terminal d'Ubuntu (WSL):

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
docker pull jordibinefa/iot02sim:latest
docker compose -f docker-compose.local.yml up -d
```

Descarrega la imatge precompilada (~2,8 GB) des de Docker Hub. **No cal compilar res localment.**

### 4. Verificar

Obre `http://localhost:5555` al navegador de Windows (Chrome, Edge...). Si no funciona bé el primer cop, repetiu un altre cop:
```bash
docker compose -f docker-compose.local.yml up -d
```

> **Nota:** WSL2 reenvía automàticament els ports al sistema Windows. No cal configurar res addicional.

---

## Opció C — VPS amb Traefik i HTTPS

### Requisits previs

- VPS amb Debian/Ubuntu i Docker instal·lat
- Traefik funcionant amb la xarxa externa `proxy` i el certresolver `letsencrypt`
- Registre DNS apuntant al VPS

### 1. Apuntar el DNS

Al teu proveïdor DNS, afegeix un registre A:

```
iot02sim.elteudomain.cat  →  IP_DEL_VPS
```

### 2. Configurar el domini

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator

sed -i 's/iot02sim.exemple.cat/iot02sim.elteudomain.cat/g' docker-compose.vps.yml
```

### 3. Descarregar la imatge i arrencar

```bash
docker pull jordibinefa/iot02sim:latest
docker compose -f docker-compose.vps.yml up -d
```

### 4. Verificar

```bash
curl https://iot02sim.elteudomain.cat/status
```

> **Nota:** El certificat HTTPS pot trigar uns minuts a emetre's la primera vegada.

### Configuració CORS (Traefik)

Copia `middlewares-cors.yml` al directori de configuració dinàmica de Traefik i afegeix els
orígens permesos. El fitxer ja inclou `https://snap.berkeley.edu` per a la integració amb Snap!

---

## Telecontrol MQTT

El simulador exposa un pont MQTT bidireccional. Qualsevol client MQTT pot subscriure's a les
actualitzacions d'estat de la sessió o enviar accions al bessó digital.

### Referència de topics

| Direcció | Topic | Payload |
|----------|-------|---------|
| Estat → subscriptors | `iot02/{sessionId}/state/gpio` | `{"pin":19,"value":1}` |
| Estat → subscriptors | `iot02/{sessionId}/state/oled` | `{"png":"<base64>"}` |
| Estat → subscriptors | `iot02/{sessionId}/state/bme` | `{"temp":22.5,"rh":48,"pressure":1013}` |
| Estat → subscriptors | `iot02/{sessionId}/state/ldr` | `{"value":500}` |
| Estat → subscriptors | `iot02/{sessionId}/info` | `{"sessionId":"...","mac":"AA:BB:...","active":true}` *(retained)* |
| Estat → subscriptors | `iot02/sessions` | `[{"sessionId":"...","mac":"..."},...]` *(retained)* |
| Acció → simulador | `iot02/{sessionId}/action/button` | `{"pin":0,"value":1}` |
| Acció → simulador | `iot02/{sessionId}/action/bme` | `{"temp":22.5,"rh":48,"pressure":1013}` |
| Acció → simulador | `iot02/{sessionId}/action/ldr` | `{"value":300}` |

### Exemples de terminal

```bash
# Llistar sessions actives
mosquitto_sub -h localhost -t "iot02/sessions" -C 1

# Subscriure's als frames OLED (PNG en base64)
mosquitto_sub -h localhost -t "iot02/EL_TEU_SESSION_ID/state/oled"

# Prémer el botó del GPIO 0
mosquitto_pub -h localhost \
  -t "iot02/EL_TEU_SESSION_ID/action/button" \
  -m '{"pin":0,"value":1}'

# Establir temperatura BME280 a 35 °C
mosquitto_pub -h localhost \
  -t "iot02/EL_TEU_SESSION_ID/action/bme" \
  -m '{"temp":35,"rh":60,"pressure":1013}'
```

---

## Esquemes d'URL

Carrega firmware directament via paràmetres al hash de la URL:

| Paràmetre | Descripció | Exemple |
|-----------|------------|---------|
| `#run:` | Carrega i executa un `.bin` immediatament | `#run:https://exemple.com/fw.bin` |
| `#open:` | Obre el firmware sense executar | `#open:https://exemple.com/fw.bin` |
| `sid=` | Sol·licita un ID de sessió específic | `#run:...&sid=lab01` |
| `mac=` | Sol·licita una adreça MAC específica | `#run:...&mac=AA:BB:CC:DD:EE:FF` |
| `bin=` | Àlies de `#run:` (paràmetre GET) | `?bin=https://...` |
| `code=` | Carrega codi font al editor | `?code=https://...` |

---

## Gestió del contenidor

```bash
# Aturar
docker compose -f docker-compose.local.yml down

# Reiniciar
docker compose -f docker-compose.local.yml restart

# Veure logs en temps real
docker compose -f docker-compose.local.yml logs -f

# Estat del servidor (sessions, caché)
curl http://localhost:5555/status
```

---

## Protecció del servidor

| Mesura | Valor local | Valor VPS | Descripció |
|--------|:-----------:|:---------:|------------|
| Sessions simultànies | 30 | 30 | Màx. instàncies QEMU simultànies |
| Compilacions simultànies | 4 | 4 | Protegeix la CPU |
| Memòria màxima | 4 GB | 8 GB | Límit Docker |
| Cua de compilació | 20 | 20 | Evita acumulació |
| Rate limit per sessió | 30 s | 30 s | Entre compilacions |
| Timeout compilació | 120 s | 120 s | Primera build; 10 s si en caché |
| Mida màxima codi/firmware | 6 MB | 6 MB | Evita abusos |
| Caché SHA256 | 200 entrades | 200 entrades | Mateix firmware → no recompila |
| Timeout inactivitat sessió | 15 min | 15 min | Allibera el procés QEMU |

---

## Estructura de fitxers

```
iot02-simulator/
├── backend/
│   ├── server.js           ← Express + WebSocket + compilació + API de sessions
│   ├── QemuManager.js      ← Cicle de vida dels processos QEMU i gestió de sessions
│   ├── MqttBridge.js       ← Pont bidireccional MQTT ↔ QEMU
│   └── package.json
├── frontend/
│   ├── index.html          ← Frontend complet (editor + UI del bessó digital)
│   ├── css/
│   ├── js/
│   └── imatges/
├── qemu-devices/
│   └── ethernet_shim/      ← Headers C injectats als sketches per a la xarxa QEMU
├── calib-patches/          ← Patches aplicats al font de QEMU (SSD1306, BME280, eFuse MAC)
├── calib-src.tar.gz        ← Font de QEMU parchejat (fork calib, suport ESP32-S3)
├── libraries/              ← Llibreries Arduino incloses a la imatge
├── Dockerfile              ← Build en dos stages: QEMU + servei Node.js
├── entrypoint.sh
├── mosquitto.conf          ← Configuració mínima de Mosquitto
├── docker-compose.local.yml  ← Ús local (VM / WSL), port 5555
├── docker-compose.vps.yml    ← VPS amb Traefik + HTTPS
├── middlewares-cors.yml    ← Middleware CORS de Traefik
├── README.md               ← Anglès
└── LLEGEIX-ME.md           ← Aquest fitxer (català)
```

---

## Compilar des del codi font

Si prefereixes compilar la imatge localment en lloc de descarregar-la de Docker Hub:

```bash
git clone https://github.com/jordibinefa/iot02-simulator.git
cd iot02-simulator
docker build -t jordibinefa/iot02sim:latest .
```

El build compila QEMU (fork calib) amb els patches d'ESP32-S3, instal·la arduino-cli,
descarrega `esp32:esp32@3.0.7`, patcheja `libesp_eth.a` per al suport OpenEth i instal·la
les dependències Node.js. **Compta amb 20-40 minuts** en una màquina moderna.

---

## Resolució de problemes

**El navegador mostra "No connection" immediatament**
Comprova que el contenidor s'executa: `docker compose -f docker-compose.local.yml ps`

**La sessió no arrenca després de pujar el firmware**
La VM pot no tenir prou RAM. Assigna mínim 4 GB. Mira els logs:
`docker compose -f docker-compose.local.yml logs iot02sim`

**El pont MQTT no es connecta**
Verifica que el contenidor mosquitto funciona:
`docker compose -f docker-compose.local.yml ps mosquitto`

**El certificat HTTPS no apareix** (VPS)
Espera uns minuts. Comprova que el DNS ja apunta al VPS: `dig iot02sim.elteudomain.cat`

**Error "arduino-cli not found" durant el build**
Reconstrueix des de zero: `docker build --no-cache -t jordibinefa/iot02sim:latest .`

---

## Llicència

MIT — lliure per usar, adaptar i compartir amb finalitats educatives.
