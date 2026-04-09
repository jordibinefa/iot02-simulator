/**
 * SettingsManager.js
 * Versió simplificada per al simulador ESP32-QEMU.
 * Persisteix la configuració al localStorage.
 * No inclou camps MQTT (el transport és WebSocket directe).
 *
 * Projecte: ESP32 Simulator — IoT-02 (Fase 5)
 * Material docent - Formació Professional
 */

class SettingsManager {
    constructor() {
        // Clau prefix per al localStorage
        this._prefix = 'esp32sim_';

        // Valors per defecte
        this._defaults = {
            mqttMac:      '',
            ldrMin:       100,
            ldrMax:       3000,
            ldrRandom:    false,
            bmeRandom:    false,
            tempMin:      15.0,
            tempMax:      30.0,
            rhMin:        30,
            rhMax:        70,
            pressureMin:  990,
            pressureMax:  1020,
        };

        console.log('SettingsManager inicialitzat');
    }

    // --- Mètodes de baix nivell ---

    /** Llegeix un valor del localStorage, retornant el default si no existeix */
    _get(key) {
        const raw = localStorage.getItem(this._prefix + key);
        if (raw === null) return this._defaults[key];

        const def = this._defaults[key];
        if (typeof def === 'boolean') return raw === 'true';
        if (typeof def === 'number') {
            return Number.isInteger(def) ? parseInt(raw, 10) : parseFloat(raw);
        }
        return raw;
    }

    /** Escriu un valor al localStorage */
    _set(key, value) {
        localStorage.setItem(this._prefix + key, String(value));
    }

    // --- Propietats MAC ---

    get mqttMac()      { return this._get('mqttMac'); }
    set mqttMac(v)     { this._set('mqttMac', v.toUpperCase().replace(/:/g, '')); }

    // --- Propietats LDR ---

    get ldrMin()       { return this._get('ldrMin'); }
    set ldrMin(v)      { this._set('ldrMin', v); }

    get ldrMax()       { return this._get('ldrMax'); }
    set ldrMax(v)      { this._set('ldrMax', v); }

    get ldrRandom()    { return this._get('ldrRandom'); }
    set ldrRandom(v)   { this._set('ldrRandom', v); }

    // --- Propietats BME280 ---

    get bmeRandom()    { return this._get('bmeRandom'); }
    set bmeRandom(v)   { this._set('bmeRandom', v); }

    get tempMin()      { return this._get('tempMin'); }
    set tempMin(v)     { this._set('tempMin', v); }

    get tempMax()      { return this._get('tempMax'); }
    set tempMax(v)     { this._set('tempMax', v); }

    get rhMin()        { return this._get('rhMin'); }
    set rhMin(v)       { this._set('rhMin', v); }

    get rhMax()        { return this._get('rhMax'); }
    set rhMax(v)       { this._set('rhMax', v); }

    get pressureMin()  { return this._get('pressureMin'); }
    set pressureMin(v) { this._set('pressureMin', v); }

    get pressureMax()  { return this._get('pressureMax'); }
    set pressureMax(v) { this._set('pressureMax', v); }

    // --- Mètodes públics ---

    /** Retorna true si la MAC no ha estat configurada mai */
    isFirstRun() {
        return this.mqttMac === '';
    }

    /** Desa configuració parcial (es cridarà des de ConfigPage al Xat C) */
    save(data) {
        if (data.mqttMac      !== undefined) this.mqttMac      = data.mqttMac;
        if (data.ldrMin       !== undefined) this.ldrMin       = parseInt(data.ldrMin, 10);
        if (data.ldrMax       !== undefined) this.ldrMax       = parseInt(data.ldrMax, 10);
        if (data.ldrRandom    !== undefined) this.ldrRandom    = Boolean(data.ldrRandom);
        if (data.bmeRandom    !== undefined) this.bmeRandom    = Boolean(data.bmeRandom);
        if (data.tempMin      !== undefined) this.tempMin      = parseFloat(data.tempMin);
        if (data.tempMax      !== undefined) this.tempMax      = parseFloat(data.tempMax);
        if (data.rhMin        !== undefined) this.rhMin        = parseInt(data.rhMin, 10);
        if (data.rhMax        !== undefined) this.rhMax        = parseInt(data.rhMax, 10);
        if (data.pressureMin  !== undefined) this.pressureMin  = parseInt(data.pressureMin, 10);
        if (data.pressureMax  !== undefined) this.pressureMax  = parseInt(data.pressureMax, 10);
        console.log('Configuració desada. MAC:', this.mqttMac);
    }
}
