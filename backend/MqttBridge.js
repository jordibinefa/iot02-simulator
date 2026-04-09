// MqttBridge.js — Pont bidireccional MQTT ↔ sessions QEMU
// Subscriu-se als topics d'acció i re-publica l'estat de cada sessió.
//
// Topics estat  (backend → subscriptors):
//   iot02/{sessionId}/state/gpio     {"pin":19,"value":1}
//   iot02/{sessionId}/state/oled     {"png":"<base64>"}
//   iot02/{sessionId}/state/bme      {"temp":22.5,"rh":48,"pressure":1013}
//   iot02/{sessionId}/state/ldr      {"value":500}
//   iot02/{sessionId}/info           {"sessionId":"...","mac":"AA:BB:...","active":true}  [retained]
//   iot02/sessions                   [{"sessionId":"...","mac":"..."},...] [retained]
//
// Topics acció  (subscriptors → backend):
//   iot02/{sessionId}/action/button  {"pin":0,"value":1}
//   iot02/{sessionId}/action/bme     {"temp":22.5,"rh":48,"pressure":1013}
//   iot02/{sessionId}/action/ldr     {"value":300}
//
// LWT:
//   iot02/{sessionId}/state/alive    "" (buit = mort) [retained]

'use strict';

const mqtt  = require('mqtt');
const { PNG } = require('pngjs');

// ── Converteix el framebuffer SSD1306 (1024 bytes, 128×64, 1bit/px, page layout)
// a una imatge PNG base64. Retorna null si el buffer és invàlid.
function framebufferToPngBase64(framebuffer) {
    if (!framebuffer || framebuffer.length !== 1024) return null;

    const W = 128, H = 64;
    const png = new PNG({ width: W, height: H, colorType: 0 }); // escala de grisos

    for (let page = 0; page < 8; page++) {
        for (let col = 0; col < W; col++) {
            const byte = framebuffer[page * W + col];
            for (let bit = 0; bit < 8; bit++) {
                const row = page * 8 + bit;
                const idx = (row * W + col) << 2; // RGBA → colorType 0 usa RGBA igualment
                const lit = (byte >> bit) & 1;
                const lum = lit ? 255 : 0;
                png.data[idx]     = lum; // R
                png.data[idx + 1] = lum; // G
                png.data[idx + 2] = lum; // B
                png.data[idx + 3] = 255; // A
            }
        }
    }

    // PNG.sync.write retorna un Buffer
    const buf = PNG.sync.write(png);
    return buf.toString('base64');
}

class MqttBridge {
    /**
     * @param {object} opts
     * @param {string} opts.brokerUrl  URL del broker (p.ex. 'mqtt://mosquitto-broker:1883')
     * @param {Function} opts.getSession  (sessionId) → QemuSession | undefined
     * @param {Function} opts.getSessionList  () → [{id, mac, state}]
     */
    constructor({ brokerUrl, getSession, getSessionList }) {
        this._brokerUrl      = brokerUrl;
        this._getSession     = getSession;
        this._getSessionList = getSessionList;
        this._client         = null;
        this._ready          = false;

        // Throttle OLED per sessió: màxim 1 PNG cada 100ms
        this._oledThrottle   = new Map(); // sessionId → timer|null

        // Throttle LDR per sessió: màxim 1 missatge cada 50ms
        this._ldrThrottle    = new Map();
    }

    // ── Connexió al broker ──────────────────────────────────────────────────
    connect() {
        console.log(`[MqttBridge] Connectant a ${this._brokerUrl}...`);

        this._client = mqtt.connect(this._brokerUrl, {
            clientId: `iot02sim-bridge-${Date.now()}`,
            clean: true,
            reconnectPeriod: 5000,
            username: process.env.MQTT_BROKER_USER || undefined,
            password: process.env.MQTT_BROKER_PASS || undefined,
        });

        this._client.on('connect', () => {
            console.log('[MqttBridge] Connectat al broker MQTT');
            this._ready = true;
            // Subscripció a TOTS els topics d'acció de totes les sessions
            this._client.subscribe('iot02/+/action/#', { qos: 0 }, (err) => {
                if (err) console.error('[MqttBridge] Error subscripció:', err.message);
                else     console.log('[MqttBridge] Subscrit a iot02/+/action/#');
            });
            // Publicar llista inicial de sessions (pot estar buida)
            this._publishSessionList();
        });

        this._client.on('reconnect', () => {
            console.log('[MqttBridge] Reconnectant...');
            this._ready = false;
        });

        this._client.on('error', (err) => {
            console.error('[MqttBridge] Error MQTT:', err.message);
        });

        this._client.on('message', (topic, payload) => {
            this._handleActionMessage(topic, payload);
        });
    }

    // ── Publicació des de QemuSession ───────────────────────────────────────

    /** Crida quan broadcastToClients rep un missatge de QEMU */
    publishFromSession(sessionId, msg) {
        if (!this._ready || !this._client) return;

        switch (msg.type) {
            case 'gpio':
                this._pub(
                    `iot02/${sessionId}/state/gpio`,
                    { pin: msg.pin, value: msg.value },
                    { qos: 0 }
                );
                break;

            case 'oled':
                this._publishOled(sessionId, msg.framebuffer);
                break;

            case 'bme':
                // broadcastToClients no envia 'bme' directament; els valors
                // arriben per 'gpio_reg'. Però si en el futur s'afegeix, aquí queda.
                this._pub(
                    `iot02/${sessionId}/state/bme`,
                    { temp: msg.temp, rh: msg.rh, pressure: msg.pressure },
                    { qos: 0 }
                );
                break;

            case 'ldr':
                this._publishLdr(sessionId, msg.value);
                break;

            default:
                // Altres tipus (serial, status, timeout_warning...) no es ponten
                break;
        }
    }

    /** Publica info de sessió (retained) en arrancar o modificar */
    publishSessionInfo(sessionId, mac, active = true) {
        if (!this._ready || !this._client) return;
        this._pub(
            `iot02/${sessionId}/info`,
            { sessionId, mac, active },
            { qos: 1, retain: true }
        );
        // LWT manual en cas d'aturada controlada
        if (!active) {
            this._pub(
                `iot02/${sessionId}/state/alive`,
                '',
                { qos: 1, retain: true }
            );
        } else {
            this._pub(
                `iot02/${sessionId}/state/alive`,
                { ts: Date.now() },
                { qos: 1, retain: true }
            );
        }
        this._publishSessionList();
    }

    /** Publica la llista global de sessions actives (retained) */
    _publishSessionList() {
        if (!this._ready || !this._client) return;
        const list = this._getSessionList()
            .filter(s => s.state === 'running')
            .map(s => ({ sessionId: s.id, mac: s.mac }));
        this._pub('iot02/sessions', list, { qos: 1, retain: true });
    }

    // ── OLED: converteix framebuffer → PNG i publica amb throttle ──────────
    _publishOled(sessionId, framebuffer) {
        if (this._oledThrottle.get(sessionId)) return; // ja hi ha un timer actiu

        this._oledThrottle.set(sessionId, setTimeout(() => {
            this._oledThrottle.set(sessionId, null);
        }, 100));

        // Conversió síncrona (ràpida, <1ms per frame 128×64)
        const png = framebufferToPngBase64(framebuffer);
        if (!png) return;

        this._pub(`iot02/${sessionId}/state/oled`, { png }, { qos: 0 });
    }

    // ── LDR: publica amb throttle 50ms ─────────────────────────────────────
    _publishLdr(sessionId, value) {
        if (this._ldrThrottle.get(sessionId)) return;

        this._ldrThrottle.set(sessionId, setTimeout(() => {
            this._ldrThrottle.set(sessionId, null);
        }, 50));

        this._pub(`iot02/${sessionId}/state/ldr`, { value }, { qos: 0 });
    }

    // ── Recepció d'accions externes ─────────────────────────────────────────
    _handleActionMessage(topic, payload) {
        // topic: iot02/{sessionId}/action/{action}
        const parts = topic.split('/');
        if (parts.length < 4 || parts[0] !== 'iot02' || parts[2] !== 'action') return;

        const sessionId = parts[1];
        const action    = parts[3];

        const session = this._getSession(sessionId);
        if (!session) {
            console.warn(`[MqttBridge] Acció per sessió desconeguda: ${sessionId}`);
            return;
        }

        let data;
        try {
            data = JSON.parse(payload.toString());
        } catch {
            console.warn(`[MqttBridge] Payload JSON invàlid al topic ${topic}`);
            return;
        }

        // Reutilitzem handleClientMessage de QemuSession per no duplicar lògica
        switch (action) {
            case 'button':
                session.handleClientMessage({ type: 'button', pin: data.pin, value: data.value });
                // Retransmetre al frontend perquè el botó es vegi premut/alliberat
                session.broadcastToClients({ type: 'button_state', pin: data.pin, value: data.value });
                break;
            case 'bme':
                session.handleClientMessage({
                    type: 'bme',
                    temp:     data.temp,
                    rh:       data.rh,
                    pressure: data.pressure,
                });
                // Retransmetre al frontend perquè els camps i sliders s'actualitzin
                session.broadcastToClients({ type: 'bme_state', temp: data.temp, rh: data.rh, pressure: data.pressure });
                break;
            case 'ldr':
                session.handleClientMessage({ type: 'ldr', value: data.value });
                // Retransmetre al frontend perquè el slider i el text s'actualitzin
                session.broadcastToClients({ type: 'ldr_state', value: data.value });
                break;
            default:
                console.warn(`[MqttBridge] Acció desconeguda: ${action}`);
        }
    }

    // ── Helper de publicació ────────────────────────────────────────────────
    _pub(topic, payload, opts) {
        if (!this._client || !this._ready) return;
        const json = payload === '' ? '' : JSON.stringify(payload);
        this._client.publish(topic, json, opts, (err) => {
            if (err) console.error(`[MqttBridge] Error publicant ${topic}:`, err.message);
        });
    }

    // ── Neteja en aturar el servidor ────────────────────────────────────────
    disconnect() {
        if (this._client) {
            this._client.end(true);
            this._client = null;
            this._ready  = false;
        }
    }
}

module.exports = { MqttBridge, framebufferToPngBase64 };
