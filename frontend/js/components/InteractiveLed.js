/**
 * InteractiveLed.js
 * Rectangle posicionat sobre la imatge que simula un LED SMD.
 * L'estat (encès/apagat) es controla per missatges del SimulatorTransport.
 *
 * Adaptat d'InteractiveLed.qml (Qt) per al simulador web.
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 */

class InteractiveLed {

    /**
     * @param {HTMLElement} container - El #board-container
     * @param {Object} options
     * @param {number}  options.boardX
     * @param {number}  options.boardY
     * @param {number}  options.boardWidth
     * @param {number}  options.boardHeight
     * @param {string}  options.color          - Color CSS del LED (ex: "white", "red", "lime")
     * @param {string}  options.mqttName       - Identificador del LED (ex: "ledW")
     * @param {SimulatorTransport} options.mqttController
     */
    constructor(container, options) {
        this._container = container;
        this._bX  = options.boardX;
        this._bY  = options.boardY;
        this._bW  = options.boardWidth;
        this._bH  = options.boardHeight;
        this._color      = options.color;
        this._mqttName   = options.mqttName;
        this._mqtt       = options.mqttController;

        this._isOn = false;
        this._el   = null;
        this._imageScale = 1;

        this._render();
        this._bindEvents();
    }

    // --- API pública ---

    updatePosition(imageScale, xOffset, yOffset) {
        if (!this._el) return;
        this._imageScale = imageScale;
        this._el.style.left   = `${this._bX * imageScale + xOffset}px`;
        this._el.style.top    = `${this._bY * imageScale + yOffset}px`;
        this._el.style.width  = `${this._bW * imageScale}px`;
        this._el.style.height = `${this._bH * imageScale}px`;
        this._applyState(this._isOn, imageScale);
    }

    destroy() {
        if (this._el) this._el.remove();
    }

    // --- Mètodes privats ---

    _render() {
        this._el = document.createElement('div');
        this._el.className = 'interactive-led';
        this._applyState(false, 1);
        this._container.appendChild(this._el);
    }

    /**
     * Aplica l'estil visual corresponent a l'estat encès/apagat.
     * @param {boolean} isOn
     * @param {number}  imageScale
     */
    _applyState(isOn, imageScale) {
        this._isOn = isOn;
        this._el.style.background = this._color;
        if (isOn) {
            const glowSize = Math.max(4, 10 * (imageScale || 1));
            this._el.style.boxShadow = `0 0 ${glowSize}px ${glowSize}px ${this._color}`;
            this._el.style.filter    = 'brightness(1)';
        } else {
            this._el.style.boxShadow = 'none';
            this._el.style.filter    = 'brightness(0.15)';
        }
    }

    _bindEvents() {
        this._mqtt.addEventListener('ledStateChanged', (e) => {
            const { ledName, state } = e.detail;
            if (ledName === this._mqttName) {
                this._applyState(state, this._imageScale);
            }
        });
    }
}
