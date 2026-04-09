/**
 * InteractiveOled.js
 * Renderitza el framebuffer OLED de 128×64 píxels de la placa IoT-02.
 * El framebuffer arriba com a array de 1024 bytes (8 pàgines × 128 columnes,
 * 1 bit per píxel, bit 0 = fila superior de cada pàgina).
 *
 * Rep l'event 'oledFramebuffer' del SimulatorTransport.
 * Renderitza amb <canvas> i image-rendering: pixelated per píxels nítids.
 *
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5, Xat B)
 * Material docent - Formació Professional
 */

class InteractiveOled {

    // Dimensions reals de la pantalla OLED en píxels físics
    static OLED_W = 128;
    static OLED_H = 64;

    /**
     * @param {HTMLElement} container
     * @param {Object} options
     * @param {number}  options.boardX
     * @param {number}  options.boardY
     * @param {number}  options.boardWidth   - Amplada de la zona OLED a la imatge (346px)
     * @param {number}  options.boardHeight  - Alçada de la zona OLED a la imatge (173px)
     * @param {SimulatorTransport} options.mqttController
     */
    constructor(container, options) {
        this._container = container;
        this._bX  = options.boardX;
        this._bY  = options.boardY;
        this._bW  = options.boardWidth;
        this._bH  = options.boardHeight;
        this._transport = options.mqttController;

        this._el  = null;   // div contenidor
        this._canvas = null;
        this._ctx    = null;

        // Buffer temporal 128×64 per construir ImageData
        this._tempCanvas = document.createElement('canvas');
        this._tempCanvas.width  = InteractiveOled.OLED_W;
        this._tempCanvas.height = InteractiveOled.OLED_H;
        this._tempCtx = this._tempCanvas.getContext('2d');

        this._render();
        this._bindEvents();
    }

    // --- API pública ---

    /**
     * Recalcula posició i mida del canvas sobre la foto de la placa.
     * Cridat per recalculatePositions() cada cop que canvia la mida del contenidor.
     */
    updatePosition(imageScale, xOffset, yOffset) {
        if (!this._el) return;

        this._el.style.left   = `${this._bX * imageScale + xOffset}px`;
        this._el.style.top    = `${this._bY * imageScale + yOffset}px`;
        this._el.style.width  = `${this._bW * imageScale}px`;
        this._el.style.height = `${this._bH * imageScale}px`;

        // El canvas CSS s'estira automàticament; la resolució interna és fixa 128×64
    }

    destroy() {
        if (this._el) this._el.remove();
    }

    // --- Mètodes privats ---

    _render() {
        // Contenidor (mateix estil que .interactive-oled del style.css)
        this._el = document.createElement('div');
        this._el.className = 'interactive-oled';

        // Canvas intern resolució 128×64, s'escala via CSS
        this._canvas = document.createElement('canvas');
        this._canvas.width  = InteractiveOled.OLED_W;
        this._canvas.height = InteractiveOled.OLED_H;
        this._canvas.style.width  = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.display = 'block';
        this._canvas.style.imageRendering = 'pixelated';  // Píxels nítids sense antialiasing

        this._ctx = this._canvas.getContext('2d');

        // Fons negre inicial
        this._clearCanvas();

        this._el.appendChild(this._canvas);
        this._container.appendChild(this._el);
    }

    /** Omple el canvas de negre (estat apagat) */
    _clearCanvas() {
        this._ctx.fillStyle = '#000000';
        this._ctx.fillRect(0, 0, InteractiveOled.OLED_W, InteractiveOled.OLED_H);
    }

    /**
     * Renderitza el framebuffer OLED de 1024 bytes al canvas.
     *
     * Format del framebuffer:
     *   framebuffer[page * 128 + col] = byte
     *   - page: 0..7 (cada pàgina cobreix 8 files verticals)
     *   - col:  0..127 (columnes horitzontals)
     *   - byte: 8 bits verticals, bit 0 = fila superior de la pàgina
     *
     * @param {Uint8Array|Array} framebuffer - 1024 bytes
     */
    _renderFramebuffer(framebuffer) {
        if (!framebuffer || framebuffer.length < 1024) return;

        // Construir ImageData 128×64 al canvas temporal
        const imgData = this._tempCtx.createImageData(
            InteractiveOled.OLED_W, InteractiveOled.OLED_H
        );

        for (let page = 0; page < 8; page++) {
            for (let col = 0; col < 128; col++) {
                const byte = framebuffer[page * 128 + col] || 0;
                for (let bit = 0; bit < 8; bit++) {
                    const y   = page * 8 + bit;
                    const x   = col;
                    const idx = (y * 128 + x) * 4;

                    if ((byte >> bit) & 1) {
                        // Píxel encès: blanc pur (serà cyan via CSS mix-blend o directament)
                        imgData.data[idx]     = 255;
                        imgData.data[idx + 1] = 255;
                        imgData.data[idx + 2] = 255;
                        imgData.data[idx + 3] = 255;
                    } else {
                        // Píxel apagat: negre
                        imgData.data[idx]     = 0;
                        imgData.data[idx + 1] = 0;
                        imgData.data[idx + 2] = 0;
                        imgData.data[idx + 3] = 255;
                    }
                }
            }
        }

        // Pintar al canvas temporal i escalar al canvas principal
        this._tempCtx.putImageData(imgData, 0, 0);
        this._ctx.imageSmoothingEnabled = false;
        this._ctx.drawImage(
            this._tempCanvas,
            0, 0,
            InteractiveOled.OLED_W, InteractiveOled.OLED_H
        );
    }

    _bindEvents() {
        // Rebre el framebuffer del SimulatorTransport
        this._transport.addEventListener('oledFramebuffer', (e) => {
            this._renderFramebuffer(e.detail.framebuffer);
        });
    }
}
