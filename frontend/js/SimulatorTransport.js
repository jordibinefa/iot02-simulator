/**
 * SimulatorTransport.js
 * Substitueix MqttController com a transport dels components interactius.
 * Mateixa API pública, però el transport intern és WebSocket directe
 * cap al backend QEMU (en lloc de MQTT).
 *
 * NO crea el WebSocket — rep una referència via attachWebSocket(ws).
 *
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 * Material docent - Formació Professional
 */

class SimulatorTransport extends EventTarget {

    // Constants d'estat de connexió (compatibles amb MqttController)
    static Disconnected = 0;
    static Connecting   = 1;
    static Connected    = 2;

    static STATE_COLORS = {
        0: '#e53935',  // Vermell
        1: '#1e88e5',  // Blau
        2: '#43a047',  // Verd
    };

    static STATE_TEXTS = {
        0: 'Desconnectat',
        1: 'Connectant...',
        2: 'Connectat',
    };

    // Mapa: mqttName del botó → pin GPIO
    static BUTTON_PIN_MAP = { btIO0: 0, btI34: 34, btI35: 35 };

    // Mapa: pin GPIO → mqttName del LED
    static LED_PIN_MAP = { 19: 'ledW', 23: 'ledR', 27: 'ledY', 32: 'ledG' };

    constructor() {
        super();
        this._ws    = null;
        this._state = SimulatorTransport.Disconnected;

        // Valors actuals dels sensors (estat intern)
        this._ldrValue      = 500;
        this._tempValue     = 20.0;
        this._rhValue       = 50;
        this._pressureValue = 1010;
        this._bmeDebounce      = null;
        this._ldrThrottleTimer = null;

        console.log('SimulatorTransport inicialitzat');
    }

    // --- Getters d'estat ---

    get connectionState() { return this._state; }
    get connectionText()  { return SimulatorTransport.STATE_TEXTS[this._state]; }
    get connectionColor() { return SimulatorTransport.STATE_COLORS[this._state]; }

    // --- Gestió del WebSocket ---

    /**
     * Associa el WebSocket existent creat per connectWebSocket() a index.html.
     * @param {WebSocket} ws
     */
    attachWebSocket(ws) {
        this._ws = ws;
        this._setState(SimulatorTransport.Connected);
    }

    /** Desassocia el WebSocket (sense tancar-lo) */
    detachWebSocket() {
        this._ws = null;
        this._setState(SimulatorTransport.Disconnected);
    }

    // --- Recepció de missatges del backend ---

    /**
     * Cridat des de handleWsMessage() quan arriba { type: 'gpio', pin, value }.
     * Tradueix pin GPIO → mqttName i emet 'ledStateChanged'.
     */
    handleGpioMessage(pin, value) {
        const ledName = SimulatorTransport.LED_PIN_MAP[pin];
        if (ledName) {
            this._emit('ledStateChanged', { ledName, state: value === 1 });
        }
    }

    /**
     * Cridat des de handleWsMessage() quan arriba { type: 'oled', framebuffer: [...] }.
     * Emet l'event 'oledFramebuffer' perquè InteractiveOled el renderitzi.
     * @param {Array|Uint8Array} framebuffer - 1024 bytes (128×64, 1 bit/píxel)
     */
    handleOledMessage(framebuffer) {
        this._emit('oledFramebuffer', { framebuffer });
    }

    /**
     * Cridat des de handleWsMessage() quan arriba { type: 'monitor_ready' }.
     * Envia els valors actuals de BME280 i LDR al backend.
     */
    sendCurrentSensorValues() {
        this._sendBmeImmediate();
        this._sendLdrImmediate();
    }

    // --- Publicació de missatges (API compatible amb MqttController) ---

    /** Publica que un botó ha estat premut */
    publishButtonPressed(buttonName) {
        const pin = SimulatorTransport.BUTTON_PIN_MAP[buttonName];
        if (pin !== undefined) {
            this._sendWs({ type: 'button', pin, value: 1 });
        }
    }

    /** Publica que un botó ha estat alliberat */
    publishButtonReleased(buttonName) {
        const pin = SimulatorTransport.BUTTON_PIN_MAP[buttonName];
        if (pin !== undefined) {
            this._sendWs({ type: 'button', pin, value: 0 });
        }
    }

    /** Publica el valor actual del LDR */
    publishLdrValue(value) {
        this._ldrValue = value;
        this._sendLdrValue();
    }

    /** Publica el valor de temperatura */
    publishTempValue(value) {
        this._tempValue = value;
        this._sendBmeValues();
    }

    /** Publica el valor d'humitat relativa */
    publishRhValue(value) {
        this._rhValue = value;
        this._sendBmeValues();
    }

    /** Publica el valor de pressió atmosfèrica */
    publishPressureValue(value) {
        this._pressureValue = value;
        this._sendBmeValues();
    }

    // Setters interns (sense publicació, per al mode aleatori)
    setTempValue(v)     { this._tempValue = v; }
    setRhValue(v)       { this._rhValue = v; }
    setPressureValue(v) { this._pressureValue = v; }

    // --- Mètodes privats ---

    /** Envia un missatge pel WebSocket */
    _sendWs(msg) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Envia els 3 valors BME280 agrupats en un sol missatge.
     * Debounce de 200ms per evitar saturar la cua HMP de QEMU
     * (cada missatge 'bme' genera 3 comandes HMP: bme_temp, bme_hum, bme_pres).
     */
    _sendBmeValues() {
        clearTimeout(this._bmeDebounce);
        this._bmeDebounce = setTimeout(() => {
            this._sendWs({
                type: 'bme',
                temp: this._tempValue,
                rh: this._rhValue,
                pressure: this._pressureValue,
            });
        }, 200);
    }

    /** Envia els valors BME immediatament (sense debounce, per a monitor_ready) */
    _sendBmeImmediate() {
        clearTimeout(this._bmeDebounce);
        this._sendWs({
            type: 'bme',
            temp: this._tempValue,
            rh: this._rhValue,
            pressure: this._pressureValue,
        });
    }

    /**
     * Envia el valor LDR amb throttle de 50ms per evitar saturar la cua HMP.
     * Sempre envia el valor més recent.
     */
    _sendLdrValue() {
        if (!this._ldrThrottleTimer) {
            this._ldrThrottleTimer = setTimeout(() => {
                this._ldrThrottleTimer = null;
                this._sendWs({ type: 'ldr', value: this._ldrValue });
            }, 50);
        }
    }

    /** Envia el valor LDR immediatament (sense throttle, per a monitor_ready) */
    _sendLdrImmediate() {
        clearTimeout(this._ldrThrottleTimer);
        this._ldrThrottleTimer = null;
        this._sendWs({ type: 'ldr', value: this._ldrValue });
    }

    /** Canvia l'estat de connexió i emet l'event */
    _setState(newState) {
        this._state = newState;
        this._emit('connectionStateChanged', {
            state: newState,
            text:  SimulatorTransport.STATE_TEXTS[newState],
            color: SimulatorTransport.STATE_COLORS[newState],
        });
    }

    /** Emet un CustomEvent */
    _emit(eventName, detail) {
        this.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
}
