/**
 * InteractiveButton.js
 * Rectangle transparent posicionat sobre la imatge de la placa.
 * En prémer, publica "pressed"; en alliberar, "released" via SimulatorTransport.
 *
 * Adaptat d'InteractiveButton.qml (Qt) per al simulador web.
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 */

class InteractiveButton {

    /**
     * @param {HTMLElement} container - El #board-container
     * @param {Object} options
     * @param {number}  options.boardX      - Posició X en píxels de la imatge original
     * @param {number}  options.boardY      - Posició Y en píxels de la imatge original
     * @param {number}  options.boardWidth  - Amplada en píxels de la imatge original
     * @param {number}  options.boardHeight - Alçada en píxels de la imatge original
     * @param {string}  options.mqttName    - Nom del botó (ex: "btIO0")
     * @param {SimulatorTransport} options.mqttController
     */
    constructor(container, options) {
        this._container = container;
        this._bX  = options.boardX;
        this._bY  = options.boardY;
        this._bW  = options.boardWidth;
        this._bH  = options.boardHeight;
        this._mqttName   = options.mqttName;
        this._mqtt       = options.mqttController;

        this._el = null;
        this._toggled = false;
        this._render();
        this._bindEvents();
    }

    // --- API pública ---

    updatePosition(imageScale, xOffset, yOffset) {
        if (!this._el) return;
        this._el.style.left   = `${this._bX * imageScale + xOffset}px`;
        this._el.style.top    = `${this._bY * imageScale + yOffset}px`;
        this._el.style.width  = `${this._bW * imageScale}px`;
        this._el.style.height = `${this._bH * imageScale}px`;
    }

    /** Estableix l'estat premut/alliberat externament (p.ex. des de MQTT) */
    setPressed(pressed) {
        this._toggled = !!pressed;
        if (this._toggled) {
            this._el.classList.add('pressed');
        } else {
            this._el.classList.remove('pressed');
        }
    }

    destroy() {
        if (this._el) this._el.remove();
    }

    // --- Mètodes privats ---

    _render() {
        this._el = document.createElement('div');
        this._el.className = 'interactive-button';
        this._el.title = this._mqttName;
        this._container.appendChild(this._el);
    }

    _bindEvents() {
        const toggle = (e) => {
            e.preventDefault();
            this._toggled = !this._toggled;
            if (this._toggled) {
                this._el.classList.add('pressed');
                this._mqtt.publishButtonPressed(this._mqttName);
            } else {
                this._el.classList.remove('pressed');
                this._mqtt.publishButtonReleased(this._mqttName);
            }
        };

        // Clic de ratolí
        this._el.addEventListener('mousedown', toggle);

        // Suport tàctil (mòbil/tablet)
        this._el.addEventListener('touchstart', toggle, { passive: false });
    }
}
