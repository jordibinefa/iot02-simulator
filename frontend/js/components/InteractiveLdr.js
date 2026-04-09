/**
 * InteractiveLdr.js
 * Simula el sensor LDR (Light Dependent Resistor) de la placa IoT-02.
 * - Cercle gris semitransparent amb etiqueta "LDR"
 * - En clicar (mode manual), obre un popup amb un slider 0-4095
 * - En mode aleatori, genera valors cada 2 segons
 * - Mostra el valor actual sota el sensor
 *
 * Adaptat d'InteractiveLdr.qml (Qt) per al simulador web.
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 */

class InteractiveLdr {

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

        this._currentValue = 500;
        this._imageScale   = 1;
        this._randomTimer  = null;
        this._el           = null;
        this._popup        = null;
        this._valueDisplay = null;
        this._sliderEl     = null;

        this._render();
        this._bindEvents();
        this._startRandomIfNeeded();
    }

    // --- API pública ---

    /** Retorna el valor actual (per enviar al backend en monitor_ready) */
    get currentValue() { return this._currentValue; }

    /** Estableix el valor externament (p.ex. des de MQTT) sense publicar de tornada */
    setExternalValue(value) {
        const clamped = Math.max(0, Math.min(4095, Math.round(value)));
        this._currentValue = clamped;
        this._valueDisplay.textContent = String(clamped);
        this._mqtt.setLdrValue ? this._mqtt.setLdrValue(clamped) : null;
        // Actualitzar el slider del popup si està obert
        if (this._sliderEl) {
            this._sliderEl.value = clamped;
            const label = this._popup && this._popup.querySelector('.ldr-val-label');
            if (label) label.textContent = clamped;
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
        // Element principal: cercle gris semitransparent
        this._el = document.createElement('div');
        this._el.className = 'interactive-sensor ldr-sensor';
        this._el.innerHTML = `<span class="sensor-label">LDR</span>`;
        this._container.appendChild(this._el);

        // Display del valor actual (sempre visible, sota el sensor)
        this._valueDisplay = document.createElement('div');
        this._valueDisplay.className = 'sensor-value-display';
        this._valueDisplay.textContent = String(this._currentValue);
        this._container.appendChild(this._valueDisplay);

        // Popup amb slider (s'afegeix al body per evitar clipping)
        this._popup = document.createElement('div');
        this._popup.className = 'sensor-popup';
        this._popup.style.display = 'none';
        this._popup.innerHTML = `
            <div class="popup-title">Valor LDR: <span class="ldr-val-label">${this._currentValue}</span></div>
            <input type="range" class="ldr-slider" min="0" max="4095" step="1" value="${this._currentValue}">
            <div class="popup-hint">Arrossega per canviar el valor</div>
        `;
        document.body.appendChild(this._popup);

        this._sliderEl = this._popup.querySelector('.ldr-slider');
    }

    _bindEvents() {
        // Clic sobre el sensor → obrir popup (si no és mode aleatori)
        this._el.addEventListener('click', () => {
            if (!this._settings.ldrRandom) {
                this._openPopup();
            }
        });

        // Slider del popup → actualitzar valor i enviar al backend
        this._sliderEl.addEventListener('input', () => {
            this._currentValue = parseInt(this._sliderEl.value, 10);
            this._popup.querySelector('.ldr-val-label').textContent = this._currentValue;
            this._valueDisplay.textContent = String(this._currentValue);
            this._mqtt.publishLdrValue(this._currentValue);
        });

        // Tancar popup en clicar fora
        document.addEventListener('click', (e) => {
            if (this._popup.style.display !== 'none' &&
                !this._popup.contains(e.target) &&
                !this._el.contains(e.target)) {
                this._closePopup();
            }
        });

        // Respondre a peticions del backend
        this._mqtt.addEventListener('ldrRequested', () => {
            this._mqtt.publishLdrValue(this._currentValue);
        });
    }

    _openPopup() {
        const rect = this._el.getBoundingClientRect();
        this._popup.style.left    = `${rect.right + 10}px`;
        this._popup.style.top     = `${rect.top - 20}px`;
        this._popup.style.display = 'block';
        this._sliderEl.value      = this._currentValue;
    }

    _closePopup() {
        this._popup.style.display = 'none';
    }

    /** Actualitza la posició del display de valor sota el sensor */
    _updateValueDisplay() {
        if (!this._valueDisplay || !this._el) return;
        const left   = parseFloat(this._el.style.left)   || 0;
        const top    = parseFloat(this._el.style.top)    || 0;
        const width  = parseFloat(this._el.style.width)  || this._bW;
        const height = parseFloat(this._el.style.height) || this._bH;

        this._valueDisplay.style.left = `${left + width / 2}px`;
        this._valueDisplay.style.top  = `${top + height + 5 * this._imageScale}px`;
        this._valueDisplay.style.fontSize = `${Math.max(10, 12 * this._imageScale)}px`;
        this._valueDisplay.style.transform = 'translateX(-50%)';
    }

    _startRandomIfNeeded() {
        if (this._settings.ldrRandom) {
            this._randomTimer = setInterval(() => {
                const min = this._settings.ldrMin;
                const max = this._settings.ldrMax;
                this._currentValue = Math.floor(Math.random() * (max - min + 1)) + min;
                this._valueDisplay.textContent = String(this._currentValue);
                this._mqtt.publishLdrValue(this._currentValue);
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
