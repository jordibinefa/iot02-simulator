/**
 * InteractiveBme280.js
 * Simula el sensor BME280 (temperatura, humitat i pressió) de la placa IoT-02.
 * - Cercle blau clar semitransparent amb etiqueta "BME 280"
 * - En clicar (mode manual), obre un popup amb 3 sliders
 * - En mode aleatori, genera valors cada 2 segons
 * - Mostra els valors en un rectangle a l'esquerra del sensor
 *
 * Adaptat d'InteractiveBme280.qml (Qt) per al simulador web.
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 */

class InteractiveBme280 {

    /**
     * @param {HTMLElement} container
     * @param {Object} options
     * @param {number}  options.boardX
     * @param {number}  options.boardY
     * @param {number}  options.boardWidth
     * @param {number}  options.boardHeight
     * @param {SettingsManager}     options.settingsManager
     * @param {SimulatorTransport}  options.mqttController
     */
    constructor(container, options) {
        this._container = container;
        this._bX  = options.boardX;
        this._bY  = options.boardY;
        this._bW  = options.boardWidth;
        this._bH  = options.boardHeight;
        this._settings = options.settingsManager;
        this._mqtt     = options.mqttController;

        // Valors actuals dels sensors
        this._tempValue     = 20.0;
        this._rhValue       = 50;
        this._pressureValue = 1010;
        this._imageScale    = 1;
        this._randomTimer   = null;

        this._el           = null;
        this._popup        = null;
        this._valueDisplay = null;

        this._render();
        this._bindEvents();
        this._startRandomIfNeeded();

        // Sincronitzar els valors inicials amb el transport
        this._mqtt.setTempValue(this._tempValue);
        this._mqtt.setRhValue(this._rhValue);
        this._mqtt.setPressureValue(this._pressureValue);
    }

    // --- API pública ---

    /** Retorna els valors actuals (per enviar al backend en monitor_ready) */
    get tempValue()     { return this._tempValue; }
    get rhValue()       { return this._rhValue; }
    get pressureValue() { return this._pressureValue; }

    /**
     * Estableix els valors externament (p.ex. des de MQTT) sense publicar de tornada.
     * Accepta un objecte parcial: {temp?, rh?, pressure?}
     */
    setExternalValues({ temp, rh, pressure } = {}) {
        if (temp     !== undefined) this._tempValue     = Math.max(-40, Math.min(85,   parseFloat(temp)));
        if (rh       !== undefined) this._rhValue       = Math.max(0,   Math.min(100,  parseInt(rh, 10)));
        if (pressure !== undefined) this._pressureValue = Math.max(300, Math.min(1100, parseInt(pressure, 10)));
        // Actualitzar l'estat intern del transport (per al proper monitor_ready)
        if (temp     !== undefined) this._mqtt.setTempValue(this._tempValue);
        if (rh       !== undefined) this._mqtt.setRhValue(this._rhValue);
        if (pressure !== undefined) this._mqtt.setPressureValue(this._pressureValue);
        // Actualitzar el text visible a la placa
        this._updateValueText();
        // Actualitzar sliders del popup si està obert
        if (this._popup) {
            if (temp     !== undefined) {
                const s = this._popup.querySelector('.bme-temp-slider');
                const l = this._popup.querySelector('.bme-temp-label');
                if (s) s.value = this._tempValue;
                if (l) l.textContent = this._tempValue.toFixed(1);
            }
            if (rh       !== undefined) {
                const s = this._popup.querySelector('.bme-rh-slider');
                const l = this._popup.querySelector('.bme-rh-label');
                if (s) s.value = this._rhValue;
                if (l) l.textContent = this._rhValue;
            }
            if (pressure !== undefined) {
                const s = this._popup.querySelector('.bme-pres-slider');
                const l = this._popup.querySelector('.bme-pres-label');
                if (s) s.value = this._pressureValue;
                if (l) l.textContent = this._pressureValue;
            }
        }
    }

    updatePosition(imageScale, xOffset, yOffset) {
        if (!this._el) return;
        this._imageScale = imageScale;

        this._el.style.left   = `${this._bX * imageScale + xOffset}px`;
        this._el.style.top    = `${this._bY * imageScale + yOffset}px`;
        this._el.style.width  = `${this._bW * imageScale}px`;
        this._el.style.height = `${this._bH * imageScale}px`;

        const fontSize = Math.max(8, 12 * imageScale);
        const label = this._el.querySelector('.sensor-label');
        if (label) label.style.fontSize = `${fontSize}px`;

        this._updateValueDisplay();
    }

    destroy() {
        this._stopRandom();
        if (this._el)           this._el.remove();
        if (this._popup)        this._popup.remove();
        if (this._valueDisplay) this._valueDisplay.remove();
    }

    // --- Mètodes privats ---

    _render() {
        // Element principal: cercle blau clar semitransparent
        this._el = document.createElement('div');
        this._el.className = 'interactive-sensor bme-sensor';
        this._el.innerHTML = `<span class="sensor-label">BME<br>280</span>`;
        this._container.appendChild(this._el);

        // Display dels valors (sempre visible, a l'esquerra del sensor)
        this._valueDisplay = document.createElement('div');
        this._valueDisplay.className = 'sensor-value-display bme-values';
        this._updateValueText();
        this._container.appendChild(this._valueDisplay);

        // Popup amb 3 sliders
        this._popup = document.createElement('div');
        this._popup.className = 'sensor-popup bme-popup';
        this._popup.style.display = 'none';
        this._popup.innerHTML = `
            <div class="popup-section">
                <div class="popup-title">Temperatura: <span class="bme-temp-label">${this._tempValue.toFixed(1)}</span> °C</div>
                <input type="range" class="bme-temp-slider" min="-40" max="85" step="0.1" value="${this._tempValue}">
            </div>
            <div class="popup-section">
                <div class="popup-title">Humitat relativa: <span class="bme-rh-label">${this._rhValue}</span> %</div>
                <input type="range" class="bme-rh-slider" min="0" max="100" step="1" value="${this._rhValue}">
            </div>
            <div class="popup-section">
                <div class="popup-title">Pressió atmosfèrica: <span class="bme-pres-label">${this._pressureValue}</span> hPa</div>
                <input type="range" class="bme-pres-slider" min="300" max="1100" step="1" value="${this._pressureValue}">
            </div>
        `;
        document.body.appendChild(this._popup);
    }

    _bindEvents() {
        // Clic sobre el sensor
        this._el.addEventListener('click', () => {
            if (!this._settings.bmeRandom) {
                this._openPopup();
            }
        });

        // Sliders del popup (usem classes en lloc d'IDs per evitar conflictes)
        const tempSlider = this._popup.querySelector('.bme-temp-slider');
        const rhSlider   = this._popup.querySelector('.bme-rh-slider');
        const presSlider = this._popup.querySelector('.bme-pres-slider');

        tempSlider.addEventListener('input', () => {
            this._tempValue = Math.round(parseFloat(tempSlider.value) * 10) / 10;
            this._popup.querySelector('.bme-temp-label').textContent = this._tempValue.toFixed(1);
            this._mqtt.setTempValue(this._tempValue);
            this._mqtt.publishTempValue(this._tempValue);
            this._updateValueText();
        });

        rhSlider.addEventListener('input', () => {
            this._rhValue = parseInt(rhSlider.value, 10);
            this._popup.querySelector('.bme-rh-label').textContent = this._rhValue;
            this._mqtt.setRhValue(this._rhValue);
            this._mqtt.publishRhValue(this._rhValue);
            this._updateValueText();
        });

        presSlider.addEventListener('input', () => {
            this._pressureValue = parseInt(presSlider.value, 10);
            this._popup.querySelector('.bme-pres-label').textContent = this._pressureValue;
            this._mqtt.setPressureValue(this._pressureValue);
            this._mqtt.publishPressureValue(this._pressureValue);
            this._updateValueText();
        });

        // Tancar popup en clicar fora
        document.addEventListener('click', (e) => {
            if (this._popup.style.display !== 'none' &&
                !this._popup.contains(e.target) &&
                !this._el.contains(e.target)) {
                this._closePopup();
            }
        });

        // Respondre a peticions del backend (via SimulatorTransport events)
        this._mqtt.addEventListener('tempRequested', () => {
            this._mqtt.publishTempValue(this._tempValue);
        });

        this._mqtt.addEventListener('rhRequested', () => {
            this._mqtt.publishRhValue(this._rhValue);
        });

        this._mqtt.addEventListener('pressureRequested', () => {
            this._mqtt.publishPressureValue(this._pressureValue);
        });
    }

    _openPopup() {
        const rect = this._el.getBoundingClientRect();
        this._popup.style.left    = `${rect.right + 10}px`;
        this._popup.style.top     = `${rect.top - 20}px`;
        this._popup.style.display = 'block';
        // Sincronitzar sliders amb valors actuals
        this._popup.querySelector('.bme-temp-slider').value = this._tempValue;
        this._popup.querySelector('.bme-rh-slider').value   = this._rhValue;
        this._popup.querySelector('.bme-pres-slider').value = this._pressureValue;
    }

    _closePopup() {
        this._popup.style.display = 'none';
    }

    /** Actualitza el text del display de valors */
    _updateValueText() {
        if (!this._valueDisplay) return;
        this._valueDisplay.innerHTML =
            `${this._tempValue.toFixed(1)}°C<br>` +
            `${this._rhValue}%<br>` +
            `${this._pressureValue} hPa`;
    }

    /** Reposiciona el display de valors a l'esquerra del sensor */
    _updateValueDisplay() {
        if (!this._valueDisplay || !this._el) return;
        const left   = parseFloat(this._el.style.left)   || 0;
        const top    = parseFloat(this._el.style.top)    || 0;
        const height = parseFloat(this._el.style.height) || this._bH;

        const dispW = 100 * this._imageScale;
        this._valueDisplay.style.left      = `${left - dispW - 5 * this._imageScale}px`;
        this._valueDisplay.style.top       = `${top + (height / 2)}px`;
        this._valueDisplay.style.transform = 'translateY(-50%)';
        this._valueDisplay.style.fontSize  = `${Math.max(10, 12 * this._imageScale)}px`;
    }

    _startRandomIfNeeded() {
        if (this._settings.bmeRandom) {
            this._randomTimer = setInterval(() => {
                const s = this._settings;
                this._tempValue     = parseFloat((Math.random() * (s.tempMax - s.tempMin) + s.tempMin).toFixed(1));
                this._rhValue       = Math.floor(Math.random() * (s.rhMax - s.rhMin + 1)) + s.rhMin;
                this._pressureValue = Math.floor(Math.random() * (s.pressureMax - s.pressureMin + 1)) + s.pressureMin;
                this._mqtt.setTempValue(this._tempValue);
                this._mqtt.setRhValue(this._rhValue);
                this._mqtt.setPressureValue(this._pressureValue);
                this._mqtt.publishTempValue(this._tempValue);
                this._updateValueText();
            }, 2000);
        }
    }

    _stopRandom() {
        if (this._randomTimer) {
            clearInterval(this._randomTimer);
            this._randomTimer = null;
        }
    }

    restartRandom() {
        this._stopRandom();
        this._startRandomIfNeeded();
    }
}
