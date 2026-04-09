/**
 * ConfigPage.js — Versió simplificada per al simulador ESP32-QEMU.
 * Overlay de configuració: MAC, mode aleatori BME/LDR i rangs.
 * Sense camps broker/user/password (transport és WS intern).
 *
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5, Xat C)
 * Material docent - Formació Professional
 */

class ConfigPage {

    /**
     * @param {HTMLElement} container - Contenidor de tota l'app (#app o body)
     * @param {Object} options
     * @param {SettingsManager} options.settingsManager
     * @param {Function}        options.onSaved - Callback quan es desa (opcional)
     */
    constructor(container, options) {
        this._container = container;
        this._settings  = options.settingsManager;
        this._onSaved   = options.onSaved || (() => {});

        this._el = null;
        this._render();
    }

    // --- API pública ---

    show() {
        if (this._el) {
            this._fillForm();
            this._el.style.display = 'flex';
            // Focus al primer camp editable
            this._el.querySelector('#cfg-mac').focus();
        }
    }

    hide() {
        if (this._el) this._el.style.display = 'none';
    }

    destroy() {
        if (this._el) this._el.remove();
    }

    // --- Mètodes privats ---

    _render() {
        this._el = document.createElement('div');
        this._el.id = 'config-page';
        this._el.style.display = 'none';

        this._el.innerHTML = `
            <div class="config-card">
                <div class="config-header">
                    <h2 class="config-title">⚙ Configuració</h2>
                    <button class="config-close" id="cfg-close" title="Tanca">✕</button>
                </div>

                <!-- MAC -->
                <fieldset class="config-section">
                    <legend>Dispositiu</legend>
                    <div class="config-field">
                        <label for="cfg-mac">Adreça MAC</label>
                        <input type="text" id="cfg-mac"
                               placeholder="Ex: AABBCCDDEEFF"
                               maxlength="17" autocomplete="off" spellcheck="false">
                        <small>12 caràcters hexadecimals, sense dos punts</small>
                    </div>
                </fieldset>

                <!-- Sensor LDR -->
                <fieldset class="config-section">
                    <legend>Sensor LDR</legend>
                    <div class="config-field config-inline">
                        <label>
                            <input type="checkbox" id="cfg-ldr-random">
                            Valors aleatoris automàtics (cada 2 s)
                        </label>
                    </div>
                    <div class="config-field config-range">
                        <label>Rang de valors (0–4095):</label>
                        <div class="range-inputs">
                            <span>Mínim</span>
                            <input type="number" id="cfg-ldr-min" min="0" max="4095" step="1">
                            <span>Màxim</span>
                            <input type="number" id="cfg-ldr-max" min="0" max="4095" step="1">
                        </div>
                    </div>
                </fieldset>

                <!-- Sensor BME280 -->
                <fieldset class="config-section">
                    <legend>Sensor BME280</legend>
                    <div class="config-field config-inline">
                        <label>
                            <input type="checkbox" id="cfg-bme-random">
                            Valors aleatoris automàtics (cada 2 s)
                        </label>
                    </div>
                    <div class="config-field config-range">
                        <label>Rang temperatura (°C):</label>
                        <div class="range-inputs">
                            <span>Mínim</span>
                            <input type="number" id="cfg-temp-min" min="-40" max="85" step="0.5">
                            <span>Màxim</span>
                            <input type="number" id="cfg-temp-max" min="-40" max="85" step="0.5">
                        </div>
                    </div>
                    <div class="config-field config-range">
                        <label>Rang humitat (%):</label>
                        <div class="range-inputs">
                            <span>Mínim</span>
                            <input type="number" id="cfg-rh-min" min="0" max="100" step="1">
                            <span>Màxim</span>
                            <input type="number" id="cfg-rh-max" min="0" max="100" step="1">
                        </div>
                    </div>
                    <div class="config-field config-range">
                        <label>Rang pressió (hPa):</label>
                        <div class="range-inputs">
                            <span>Mínim</span>
                            <input type="number" id="cfg-pres-min" min="300" max="1100" step="1">
                            <span>Màxim</span>
                            <input type="number" id="cfg-pres-max" min="300" max="1100" step="1">
                        </div>
                    </div>
                </fieldset>

                <!-- Accions -->
                <div class="config-actions">
                    <button class="btn" style="background:var(--border); color:var(--fg);"
                            id="cfg-cancel">Cancel·la</button>
                    <button class="btn btn-primary" id="cfg-save">💾 Desa</button>
                </div>
                <div id="cfg-error" class="config-error" style="display:none"></div>
            </div>
        `;

        this._container.appendChild(this._el);
        this._fillForm();
        this._bindEvents();
    }

    _fillForm() {
        const s = this._settings;
        this._el.querySelector('#cfg-mac').value          = s.mqttMac;
        this._el.querySelector('#cfg-ldr-random').checked = s.ldrRandom;
        this._el.querySelector('#cfg-ldr-min').value      = s.ldrMin;
        this._el.querySelector('#cfg-ldr-max').value      = s.ldrMax;
        this._el.querySelector('#cfg-bme-random').checked = s.bmeRandom;
        this._el.querySelector('#cfg-temp-min').value     = s.tempMin;
        this._el.querySelector('#cfg-temp-max').value     = s.tempMax;
        this._el.querySelector('#cfg-rh-min').value       = s.rhMin;
        this._el.querySelector('#cfg-rh-max').value       = s.rhMax;
        this._el.querySelector('#cfg-pres-min').value     = s.pressureMin;
        this._el.querySelector('#cfg-pres-max').value     = s.pressureMax;
    }

    _bindEvents() {
        this._el.querySelector('#cfg-save').addEventListener('click', () => this._saveAndClose());
        this._el.querySelector('#cfg-cancel').addEventListener('click', () => this.hide());
        this._el.querySelector('#cfg-close').addEventListener('click', () => this.hide());

        // Clic al fons de l'overlay → tanca
        this._el.addEventListener('click', (e) => {
            if (e.target === this._el) this.hide();
        });

        // Enter al camp MAC → desa directament
        this._el.querySelector('#cfg-mac').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._saveAndClose();
            if (e.key === 'Escape') this.hide();
        });
    }

    _saveAndClose() {
        const mac = this._el.querySelector('#cfg-mac').value
            .trim().toUpperCase().replace(/:/g, '');
        const errorEl = this._el.querySelector('#cfg-error');

        // Validació MAC (12 hex chars)
        if (!/^[0-9A-F]{12}$/.test(mac)) {
            errorEl.textContent = '⚠ La MAC ha de tenir 12 caràcters hexadecimals (0–9, A–F).';
            errorEl.style.display = 'block';
            this._el.querySelector('#cfg-mac').focus();
            return;
        }

        errorEl.style.display = 'none';

        this._settings.save({
            mqttMac:     mac,
            ldrRandom:   this._el.querySelector('#cfg-ldr-random').checked,
            ldrMin:      this._el.querySelector('#cfg-ldr-min').value,
            ldrMax:      this._el.querySelector('#cfg-ldr-max').value,
            bmeRandom:   this._el.querySelector('#cfg-bme-random').checked,
            tempMin:     this._el.querySelector('#cfg-temp-min').value,
            tempMax:     this._el.querySelector('#cfg-temp-max').value,
            rhMin:       this._el.querySelector('#cfg-rh-min').value,
            rhMax:       this._el.querySelector('#cfg-rh-max').value,
            pressureMin: this._el.querySelector('#cfg-pres-min').value,
            pressureMax: this._el.querySelector('#cfg-pres-max').value,
        });

        this.hide();
        this._onSaved();
    }
}
