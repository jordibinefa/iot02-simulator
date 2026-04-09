// QemuManager.js — Manages QEMU ESP32 process lifecycle per session
// v3: HMP gpio_set for button injection (no GDB needed), ANSI-clean polling

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

// ─── Strip ANSI escape sequences from QEMU calib monitor responses ───
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][0-9A-B]/g, '')
            .replace(/\x1b[@-Z\\-_]/g, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// ─── Parse hex value from QEMU 'xp' command response ───
function parseXpHexValue(rawResp) {
  if (!rawResp) return null;
  const clean = stripAnsi(rawResp);
  let m = clean.match(/[0-9a-fA-F]{8,16}:\s+0x([0-9a-fA-F]{1,8})\b/);
  if (m) return parseInt(m[1], 16);
  m = clean.match(/[0-9a-fA-F]{8,16}:\s+([0-9a-fA-F]{8})\b/);
  if (m) return parseInt(m[1], 16);
  return null;
}

// Parseja tots els valors d'una resposta xp /Nw — retorna array de N enters o null
// Format típic: "3ff44004: 0x00800000 0x00000000 0x00000000 0x00000001\r\n(qemu) "
function parseXpMultiValues(rawResp) {
  if (!rawResp) return null;
  const clean = stripAnsi(rawResp);
  const m = clean.match(/[0-9a-fA-F]{8,16}:\s+((?:0x[0-9a-fA-F]{1,8}\s*)+)/);
  if (!m) return null;
  return m[1].trim().split(/\s+/).map(v => parseInt(v.replace('0x',''), 16));
}


function normalizeMac(mac) {
  // L'IDF afegeix +3 al darrer byte de la base efuse per a ESP_MAC_ETH.
  // L'usuari edita la MAC ETH visible; restem 3 per obtenir la base que va a QEMU.
  const bytes = mac.split(":").map(b => parseInt(b, 16));
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  let carry = 3;
  for (let i = 5; i >= 0 && carry; i--) {
    const v = bytes[i] - carry;
    carry = v < 0 ? 1 : 0;
    bytes[i] = (v + 256) % 256;
  }
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2,"0")).join(":");
}

function generateEfuseBin(mac, filePath) {
  // MAC format: 'AA:BB:CC:DD:EE:FF'
  const bytes = mac.split(':').map(b => parseInt(b, 16));
  // ESPEfuseBlocks: 84 x uint32 = 336 bytes, tots a zero
  const buf = Buffer.alloc(336, 0);
  // rd_mac_spi_sys_0 offset=24: bytes[0..3] little-endian
  buf.writeUInt32LE((bytes[0] | (bytes[1]<<8) | (bytes[2]<<16) | (bytes[3]<<24)) >>> 0, 24);
  // rd_mac_spi_sys_1 offset=28: bytes[4..5]
  buf.writeUInt32LE(bytes[4] | (bytes[5]<<8), 28);
  // rd_mac_spi_sys_3 offset=36: chip revision 0x030c0000
  buf.writeUInt32LE(0x030c0000, 36);
  require('fs').writeFileSync(filePath, buf);
}
class QemuSession {
  constructor(sessionId, flashImagePath, mac, config, mqttBridge = null) {
    this.sessionId = sessionId;
    this.flashImagePath = flashImagePath;
    this.mac = mac;
    this.config = config;
    this.mqttBridge = mqttBridge;
    this.process = null;
    this.webSockets = new Set();
    this.lastActivity = Date.now();
    this.timeoutWarned = false;
    this.timeoutTimer = null;
    this.graceTimer = null;
    this.monitorSocket = null;
    this.serialBuffer = '';
    this.state = 'starting';

    // GPIO state tracking
    this.lastGpioOut = null;
    this.lastGpioOut1 = null;
    this.gpioDebugCount = 0;
    this._monitorReady = false;
    this._pendingResolve = null;
    this._responseAcc = '';
    this.gpioPollingInterval = null;

    // OLED polling
    this.oledPollingInterval = null;
    this.lastOledHash = '';

    // Command queue — serialitza totes les comandes HMP
    this._cmdQueue = [];
    this._cmdRunning = false;
    this._currentCmd = null;
    this._cmdTimer = null;
  }

  async start() {
    const sessionDir = path.join(this.config.sessionsDir, this.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionFlash = path.join(sessionDir, 'flash_image.bin');
    fs.copyFileSync(this.flashImagePath, sessionFlash);

    const monitorPort = await findFreePort(10000, 20000);
    this.monitorPort = monitorPort;

    const serialPort = await findFreePort(20000, 30000);
    this.serialPort = serialPort;

    const efusePath = path.join(sessionDir, 'efuse.bin');
    // baseMac: MAC base (efuse) derivada de la MAC ETH visible (this.mac).
    // NO mutem this.mac per evitar que cada restart resti 3 al darrer byte.
    const baseMac = normalizeMac(this.mac);
    generateEfuseBin(baseMac, efusePath);
    const qemuArgs = [
      '-nographic',
      '-machine', 'esp32',
      '-drive', 'file=' + sessionFlash + ',if=mtd,format=raw',
      '-serial', 'tcp:127.0.0.1:' + serialPort + ',server,nowait',
      '-monitor', 'tcp:127.0.0.1:' + monitorPort + ',server,nowait',
      '-nic', 'user,model=open_eth,net=192.168.4.0/24,host=192.168.4.1,dns=8.8.8.8,hostfwd=tcp::0-:80,mac=' + baseMac,
      '-drive', 'if=none,id=efuse,file=' + efusePath + ',format=raw',
      '-global', 'nvram.esp32.efuse.drive=efuse',
      '-global', 'driver=timer.esp32.timg,property=wdt_disable,value=true',
    ];

    console.log('[Session ' + this.sessionId + '] Starting QEMU with ETH MAC ' + this.mac + ' (base efuse: ' + baseMac + ')');
    console.log('[Session ' + this.sessionId + '] Serial:' + serialPort + ' Monitor:' + monitorPort);

    const qemuEnv = Object.assign({}, process.env, { QEMU_ESP32_MAC: baseMac.replace(/:/g, '') });
    this.process = spawn('qemu-system-xtensa', qemuArgs, {
      cwd: sessionDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: qemuEnv,
    });

    this.state = 'running';

    this.process.stdout.on('data', (data) => {
      console.log('[QEMU ' + this.sessionId + ' stdout] ' + data.toString().trim());
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Filtrar soroll BLE/BTDM de QEMU calib (milers de línies per sessió)
      if (msg.includes('Gtk-WARNING') || msg.includes('dbind-WARNING') ||
          msg.includes('EM_RD ') || msg.includes('EM_WR ') ||
          msg.includes('BTDM') || msg.includes('BLE Timer') ||
          msg.includes('INTMATRIX') || msg.includes('TX Completion Timer') ||
          msg.includes('ble_force_start') || msg.includes('VHCI now')) {
        return;
      }
      console.log('[QEMU ' + this.sessionId + ' stderr] ' + msg);
    });

    this.process.on('exit', (code, signal) => {
      console.log('[Session ' + this.sessionId + '] QEMU exited: code=' + code + ', signal=' + signal);
      if (this.state !== 'stopping') {
        // Mort inesperada (no iniciada per stop()) — notificar clients
        this.broadcastToClients({ type: 'session_end', reason: 'QEMU process ended' });
      }
      this.state = 'stopped';
      this.cleanup();
    });

    this.process.on('error', (err) => {
      console.error('[Session ' + this.sessionId + '] QEMU error:', err.message);
      this.state = 'stopped';
    });

    setTimeout(() => this.connectSerial(), 2000);
    setTimeout(() => this.connectMonitor(), 3000);

    // Publicar info de sessió al bridge MQTT (retained)
    if (this.mqttBridge) {
      this.mqttBridge.publishSessionInfo(this.sessionId, this.mac, true);
    }

    this.resetTimeout();
    return this;
  }

  // ─── Serial Connection ───
  connectSerial() {
    if (this.state !== 'running') return;

    const client = new net.Socket();
    client.connect(this.serialPort, '127.0.0.1', () => {
      console.log('[Session ' + this.sessionId + '] Connected to QEMU serial');
    });

    client.on('data', (data) => {
      const text = data.toString();
      this.serialBuffer += text;
      this.broadcastToClients({ type: 'serial', data: text });
      this.parseSerialForGpio(text);
    });

    client.on('error', (err) => {
      if (this.state === 'running') {
        console.warn('[Session ' + this.sessionId + '] Serial error:', err.message);
        setTimeout(() => this.connectSerial(), 3000);
      }
    });

    client.on('close', () => {
      if (this.state === 'running') {
        setTimeout(() => this.connectSerial(), 3000);
      }
    });

    this.serialSocket = client;
  }

  // ─── QEMU HMP Monitor Connection ───
  connectMonitor() {
    if (this.state !== 'running') return;

    const client = new net.Socket();

    client.connect(this.monitorPort, '127.0.0.1', () => {
      console.log('[Session ' + this.sessionId + '] Connected to QEMU monitor');
      this.monitorSocket = client;
    });

    client.on('data', (data) => {
      const text = data.toString();
      this._responseAcc += text;

      if (this.gpioDebugCount < 2) {
        console.log('[Session ' + this.sessionId + '] Monitor raw: ' + JSON.stringify(text.substring(0, 200)));
      }

      const cleanAcc = stripAnsi(this._responseAcc);

      // Per oled_dump: acumular fins a OLED_FB_END (arriba en múltiples chunks TCP)
      if (this._currentCmd === 'oled_dump') {
        if (cleanAcc.includes('OLED_FB_END') && this._pendingResolve) {
          const cb = this._pendingResolve;
          const response = this._responseAcc;
          this._pendingResolve = null;
          this._responseAcc = '';
          this._currentCmd = null;
          cb(response);
        }
        // No fer res més — seguir acumulant fins que arribi OLED_FB_END o timeout
        return;
      }

      if (cleanAcc.includes('(qemu)')) {
        if (!this._monitorReady) {
          this._monitorReady = true;
          this._responseAcc = '';
          console.log('[Session ' + this.sessionId + '] QEMU monitor ready, starting GPIO polling @100ms');
          // MAC s'injectarà via -global nvram.esp32.efuse.mac un cop rebuild
          this.gpioPollingInterval = setInterval(() => this.pollGpioState(), 100);
          this.oledPollingInterval = setInterval(() => this.pollOledState(), 250);
          // Notificar al frontend que el monitor és llest → enviarà els valors dels sliders
          this.broadcastToClients({ type: 'monitor_ready' });
          return;
        }

        if (this._pendingResolve) {
          const cb = this._pendingResolve;
          const response = this._responseAcc;
          this._pendingResolve = null;
          this._responseAcc = '';
          this._currentCmd = null;
          cb(response);
        } else {
          this._responseAcc = '';
        }
      }
    });

    client.on('error', (err) => {
      console.warn('[Session ' + this.sessionId + '] Monitor error:', err.message);
    });

    client.on('close', () => {
      this.monitorSocket = null;
      if (this.gpioPollingInterval) {
        clearInterval(this.gpioPollingInterval);
        this.gpioPollingInterval = null;
      }
      if (this.oledPollingInterval) {
        clearInterval(this.oledPollingInterval);
        this.oledPollingInterval = null;
      }
    });
  }

  // Send command to QEMU HMP monitor and get response
  // ─── Serialitzed HMP command queue ───
  // Comandes GPIO (xp) tenen prioritat: van al davant de la cua.
  // oled_dump va al final i no pot bloquejar el GPIO polling.
  monitorCommand(cmd, timeoutMs) {
    const ms = timeoutMs || (cmd === 'oled_dump' ? 2000 : 500);
    return new Promise((resolve) => {
      const entry = { cmd, ms, resolve };
      // Prioritat: xp va al davant, la resta al final
      if (cmd.startsWith('xp ') || cmd.startsWith('adc_set') || cmd.startsWith('gpio_set') || cmd.startsWith('bme_set')) {
        this._cmdQueue.unshift(entry);
      } else {
        this._cmdQueue.push(entry);
      }
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (this._cmdRunning) return;
    if (this._cmdQueue.length === 0) return;
    if (!this.monitorSocket || this.monitorSocket.destroyed || !this._monitorReady) {
      // Flush queue with nulls
      while (this._cmdQueue.length) this._cmdQueue.shift().resolve(null);
      return;
    }

    this._cmdRunning = true;
    const { cmd, ms, resolve } = this._cmdQueue.shift();
    this._currentCmd = cmd;

    this._responseAcc = '';
    this._pendingResolve = (response) => {
      if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }
      this._cmdRunning = false;
      resolve(response);
      this._drainQueue();
    };

    this.monitorSocket.write(cmd + '\n');

    this._cmdTimer = setTimeout(() => {
      this._cmdTimer = null;
      if (this._pendingResolve) {
        const cb = this._pendingResolve;
        this._pendingResolve = null;
        this._currentCmd = null;
        this._cmdRunning = false;
        cb(null);
        this._responseAcc = '';
        this._drainQueue();
      }
    }, ms);
  }

  // ─── GPIO Polling via HMP 'xp' ───
  // Llegeix GPIO_OUT (0x3FF44004) i GPIO_OUT1 (0x3FF44010) en UNA sola comanda:
  // xp /4w 0x3FF44004 retorna 4 words: [OUT, -, -, OUT1] (OUT1 és a offset +0xC)
  async pollGpioState() {
    if (this.state !== 'running' || !this.monitorSocket || !this._monitorReady) return;

    try {
      const resp = await this.monitorCommand('xp /4w 0x3FF44004');
      const vals = parseXpMultiValues(resp);
      // vals[0] = GPIO_OUT (0x3FF44004), vals[3] = GPIO_OUT1 (0x3FF44010)
      const gpioOut  = vals ? vals[0] : null;
      const gpioOut1 = vals ? vals[3] : null;

      if (this.gpioDebugCount < 2) {
        console.log('[Session ' + this.sessionId + '] GPIO poll #' + this.gpioDebugCount +
          ' OUT=0x' + (gpioOut  !== null ? gpioOut.toString(16).padStart(8,'0')  : 'null') +
          ' OUT1=0x' + (gpioOut1 !== null ? gpioOut1.toString(16).padStart(8,'0') : 'null'));
        this.gpioDebugCount++;
      }

      if (gpioOut !== null && gpioOut !== this.lastGpioOut) {
        if (this.lastGpioOut !== null) {
          console.log('[Session ' + this.sessionId + '] GPIO_OUT changed: 0x' + this.lastGpioOut.toString(16).padStart(8,'0') + ' -> 0x' + gpioOut.toString(16).padStart(8,'0'));
          this.processGpioChanges(gpioOut, this.lastGpioOut, false);
        }
        this.lastGpioOut = gpioOut;
      }

      if (gpioOut1 !== null && gpioOut1 !== this.lastGpioOut1) {
        if (this.lastGpioOut1 !== null) {
          console.log('[Session ' + this.sessionId + '] GPIO_OUT1 changed: 0x' + this.lastGpioOut1.toString(16).padStart(8,'0') + ' -> 0x' + gpioOut1.toString(16).padStart(8,'0'));
          this.processGpioChanges(gpioOut1, this.lastGpioOut1, true);
        }
        this.lastGpioOut1 = gpioOut1;
      }
    } catch (e) {
      console.warn('[Session ' + this.sessionId + '] GPIO poll error:', e.message);
    }
  }

  // Detect which GPIO pins changed and notify clients
  processGpioChanges(newVal, oldVal, isHigh) {
    const offset = isHigh ? 32 : 0;
    const diff = newVal ^ oldVal;

    const ledPins = { 19: 'LED_W', 23: 'LED_R', 27: 'LED_Y', 32: 'LED_G' };

    for (const [pinStr, name] of Object.entries(ledPins)) {
      const pin = parseInt(pinStr);
      const regBit = pin - offset;
      if (regBit < 0 || regBit > 31) continue;

      if (diff & (1 << regBit)) {
        const value = (newVal >> regBit) & 1;
        console.log('[Session ' + this.sessionId + '] LED ' + name + ' (GPIO ' + pin + ') -> ' + (value ? 'ON' : 'OFF'));
        this.broadcastToClients({ type: 'gpio', pin, value, name });
      }
    }

    this.broadcastToClients({
      type: 'gpio_reg',
      reg: isHigh ? 'GPIO_OUT1' : 'GPIO_OUT',
      value: newVal,
      hex: '0x' + newVal.toString(16).padStart(8, '0'),
    });
  }

  // ─── GPIO Input Injection via HMP 'gpio_set' ───
  // Pauses polling, sends gpio_set command, resumes polling.
  // gpio_set modifies calib's internal s->gpio_in directly (patched QEMU).
  async setGpioInput(pin, value) {
    if (this.state !== 'running') return;

    // Pin value for calib: pressed → pin LOW (0), released → pin HIGH (1)
    const pinLevel = value ? 0 : 1;

    if (!this._monitorReady || !this.monitorSocket) {
      console.warn('[Session ' + this.sessionId + '] Monitor not ready for gpio_set');
      return;
    }

    // Pause GPIO + OLED polling to free the monitor channel
    if (this.gpioPollingInterval) {
      clearInterval(this.gpioPollingInterval);
      this.gpioPollingInterval = null;
    }
    if (this.oledPollingInterval) {
      clearInterval(this.oledPollingInterval);
      this.oledPollingInterval = null;
    }

    // Wait for any pending monitor command to complete
    await new Promise(r => setTimeout(r, 150));

    // Send gpio_set command
    const resp = await this.monitorCommand('gpio_set ' + pin + ' ' + pinLevel);
    const clean = resp ? stripAnsi(resp) : '';

    if (clean.includes('OK')) {
      console.log('[Session ' + this.sessionId + '] HMP: gpio_set ' + pin + ' ' + pinLevel + ' -> ' + clean.replace(/[\r\n]+/g, ' ').trim());
    } else {
      console.warn('[Session ' + this.sessionId + '] HMP: gpio_set response: ' + clean.trim());
    }

    // Resume GPIO + OLED polling
    if (!this.gpioPollingInterval && this.state === 'running') {
      this.gpioPollingInterval = setInterval(() => this.pollGpioState(), 100);
    }
    if (!this.oledPollingInterval && this.state === 'running') {
      this.oledPollingInterval = setInterval(() => this.pollOledState(), 250);
    }
  }


  // ─── OLED Polling via HMP 'oled_dump' ───
  async pollOledState() {
    if (this.state !== 'running' || !this.monitorSocket || !this._monitorReady) return;
    try {
      const resp = await this.monitorCommand('oled_dump');
      if (!resp) return;
      const clean = stripAnsi(resp);

      // Extreure tot el que hi ha entre OLED_FB_BEGIN i OLED_FB_END
      const start = clean.indexOf('OLED_FB_BEGIN');
      const end   = clean.indexOf('OLED_FB_END');
      if (start === -1 || end === -1) {
        console.warn('[Session ' + this.sessionId + '] oled_dump: markers not found, resp length=' + clean.length);
        return;
      }

      const hexStr = clean.slice(start + 13, end).replace(/\s+/g, '');
      if (hexStr.length !== 2048) {
        console.warn('[Session ' + this.sessionId + '] oled_dump: hexStr.length=' + hexStr.length + ' (expected 2048)');
        return;
      }
      if (hexStr === this.lastOledHash) return;

      // Ignorar framebuffer tot zeros (display.clear() en trànsit)
      if (/^0+$/.test(hexStr)) return;

      this.lastOledHash = hexStr;

      const framebuffer = [];
      for (let i = 0; i < 2048; i += 2) {
        framebuffer.push(parseInt(hexStr.slice(i, i + 2), 16));
      }
      this.broadcastToClients({ type: 'oled', framebuffer });
      // Debug: log first non-zero page
      if (this.oledDebugCount === undefined) this.oledDebugCount = 0;
      if (this.oledDebugCount < 3) {
        this.oledDebugCount++;
        for (let p = 0; p < 8; p++) {
          const row = framebuffer.slice(p * 128, p * 128 + 128);
          const nonzero = row.some(b => b !== 0);
          if (nonzero) {
            console.log('[OLED] page' + p + ': ' + row.map(b => b.toString(16).padStart(2,'0')).join(' '));
          }
        }
      }
    } catch (e) {
      console.warn('[Session ' + this.sessionId + '] pollOledState error:', e.message);
    }
  }

  // ─── BME280 value injection via HMP 'bme_temp/bme_hum/bme_pres' ───
  // Cada comanda rep un enter positiu per compatibilitat amb el parser HMP de calib.
  // bme_temp: (graus + 40) × 100  (offset +4000 per evitar negatius; el C resta 40)
  // bme_hum:  %RH × 100
  // bme_pres: hPa × 100
  async setBmeSensor(field, value) {
    if (!this._monitorReady || !this.monitorSocket) return;
    let intVal;
    let cmd;
    if (field === 'temp') {
      intVal = Math.round((value + 40) * 100);  // offset +40°C → sempre positiu
      cmd = 'bme_temp ' + intVal;
    } else if (field === 'hum') {
      intVal = Math.round(value * 100);
      cmd = 'bme_hum '  + intVal;
    } else if (field === 'pres') {
      intVal = Math.round(value * 100);
      cmd = 'bme_pres ' + intVal;
    } else return;
    const resp = await this.monitorCommand(cmd);
    const clean = resp ? stripAnsi(resp).trim() : '';
    console.log('[Session ' + this.sessionId + '] HMP ' + cmd + ' -> ' + clean);
  }

  // ─── LDR (ADC1 GPIO36 = channel 0) injection via HMP 'adc_set' ───
  // GPIO36 = ADC1_CHANNEL_0
  // Coalesce: descarta adc_set anteriors de la cua i fa fire-and-forget
  setLdrValue(rawValue) {
    if (!this._monitorReady || !this.monitorSocket) return;
    const clamped = Math.max(0, Math.min(4095, Math.round(rawValue)));

    // Descartar qualsevol adc_set pendent a la cua
    const before = this._cmdQueue.length;
    this._cmdQueue = this._cmdQueue.filter(entry => {
      if (entry.cmd && entry.cmd.startsWith('adc_set ')) {
        entry.resolve(null);
        return false;
      }
      return true;
    });

    const cmd = 'adc_set 0 ' + clamped;
    // Fire-and-forget: no bloqueja el handleClientMessage
    this.monitorCommand(cmd).then(resp => {
      if (before > 0 || this.gpioDebugCount < 20) {
        const clean = resp ? stripAnsi(resp).trim() : 'null';
        const short = clean.includes('ADC1') ? clean.substring(clean.lastIndexOf('ADC1')) : clean;
        console.log('[Session ' + this.sessionId + '] adc_set ' + clamped +
          (before > this._cmdQueue.length ? ' (dropped ' + (before - this._cmdQueue.length) + ' old)' : '') +
          ' -> ' + short.replace(/[\r\n]+/g,' ').substring(0, 40));
      }
    });
  }

  // Parse serial output for status info
  parseSerialForGpio(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.includes('WiFi connected') || line.includes('MQTT connect')) {
        this.broadcastToClients({ type: 'status', message: line.trim() });
      }
    }
  }

  // Handle messages from browser client
  handleClientMessage(msg) {
    this.lastActivity = Date.now();
    this.resetTimeout();

    switch (msg.type) {
      case 'keepalive':
        break;

      case 'button':
        console.log('[Session ' + this.sessionId + '] Button pin=' + msg.pin + ' value=' + msg.value);
        this.setGpioInput(msg.pin, msg.value);
        break;

      case 'ldr':
        if (!this._ldrLogCount) this._ldrLogCount = 0;
        if (this._ldrLogCount++ % 20 === 0)
          console.log('[Session ' + this.sessionId + '] LDR value=' + msg.value);
        this.setLdrValue(Math.round(msg.value));
        break;

      case 'bme':
        console.log('[Session ' + this.sessionId + '] BME: T=' + msg.temp + ' RH=' + msg.rh + ' P=' + msg.pressure);
        if (msg.temp !== undefined)     this.setBmeSensor('temp', msg.temp);
        if (msg.rh !== undefined)       this.setBmeSensor('hum',  msg.rh);
        if (msg.pressure !== undefined) this.setBmeSensor('pres', msg.pressure);
        break;

      case 'serial_input':
        if (this.serialSocket && !this.serialSocket.destroyed) {
          this.serialSocket.write(msg.data);
        }
        break;

      case 'sim_control':
        if (msg.action === 'stop') {
          this.stop();
        } else if (msg.action === 'pause' && this.monitorSocket) {
          this.monitorSocket.write('stop\n');
        } else if (msg.action === 'resume' && this.monitorSocket) {
          this.monitorSocket.write('cont\n');
        }
        break;

      default:
        console.warn('[Session ' + this.sessionId + '] Unknown message type: ' + msg.type);
    }
  }

  addWebSocket(ws) {
    this.webSockets.add(ws);
    this.lastActivity = Date.now();

    // Send current LED state to newly connected client
    const ledPins = { 19: 'LED_W', 23: 'LED_R', 27: 'LED_Y', 32: 'LED_G' };
    for (const [pinStr, name] of Object.entries(ledPins)) {
      const pin = parseInt(pinStr);
      let value;
      if (pin < 32) {
        value = this.lastGpioOut !== null ? (this.lastGpioOut >> pin) & 1 : 0;
      } else {
        value = this.lastGpioOut1 !== null ? (this.lastGpioOut1 >> (pin - 32)) & 1 : 0;
      }
      ws.send(JSON.stringify({ type: 'gpio', pin, value, name }));
    }
  }

  removeWebSocket(ws) {
    this.webSockets.delete(ws);
  }

  broadcastToClients(msg) {
    // Permet session_end fins i tot durant l'aturada; bloqueja la resta
    if ((this.state === 'stopping' || this.state === 'stopped') && msg.type !== 'session_end') return;
    const json = JSON.stringify(msg);
    for (const ws of this.webSockets) {
      if (ws.readyState === 1) {
        ws.send(json);
      }
    }
    // Pont MQTT: re-publica cada missatge rellevant
    if (this.mqttBridge) {
      this.mqttBridge.publishFromSession(this.sessionId, msg);
    }
  }

  resetTimeout() {
    this.timeoutWarned = false;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);

    this.timeoutTimer = setTimeout(() => {
      this.timeoutWarned = true;
      this.broadcastToClients({
        type: 'timeout_warning',
        seconds: this.config.sessionGracePeriodMs / 1000,
      });
      this.graceTimer = setTimeout(() => {
        if (Date.now() - this.lastActivity >= this.config.sessionTimeoutMs) {
          console.log('[Session ' + this.sessionId + '] Timeout — stopping');
          this.broadcastToClients({ type: 'session_end', reason: 'timeout' });
          this.stop();
        }
      }, this.config.sessionGracePeriodMs);
    }, this.config.sessionTimeoutMs);
  }

  stop() {
    // Notificar clients ABANS de canviar state per garantir que el missatge s'envia
    this.broadcastToClients({ type: 'session_end', reason: 'stopped' });
    // Marcar sessió com a inactiva al bridge MQTT
    if (this.mqttBridge) {
      this.mqttBridge.publishSessionInfo(this.sessionId, this.mac, false);
    }
    this.state = 'stopping';
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.gpioPollingInterval) {
      clearInterval(this.gpioPollingInterval);
      this.gpioPollingInterval = null;
    }
    if (this.oledPollingInterval) {
      clearInterval(this.oledPollingInterval);
      this.oledPollingInterval = null;
    }

    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }

    if (this.serialSocket) this.serialSocket.destroy();
    if (this.monitorSocket) this.monitorSocket.destroy();

    for (const ws of this.webSockets) {
      ws.close(1000, 'Session ended');
    }
    this.webSockets.clear();
    this.cleanup();
  }

  cleanup() {
    const sessionDir = path.join(this.config.sessionsDir, this.sessionId);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('[Session ' + this.sessionId + '] Cleanup error:', e.message);
    }
  }
}

class QemuManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.mqttBridge = null; // s'assigna des de server.js
  }

  async startSession(sessionId, flashImagePath, mac) {
    if (this.sessions.has(sessionId)) {
      this.stopSession(sessionId);
    }
    const session = new QemuSession(sessionId, flashImagePath, mac, this.config, this.mqttBridge);
    this.sessions.set(sessionId, session);
    try {
      await session.start();
      return session;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.stop();
      this.sessions.delete(sessionId);
    }
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getActiveCount() {
    return this.sessions.size;
  }

  getSessionList() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      mac: s.mac,
      state: s.state,
      lastActivity: s.lastActivity,
      wsClients: s.webSockets.size,
    }));
  }

  stopAll() {
    for (const [id, session] of this.sessions) {
      session.stop();
    }
    this.sessions.clear();
  }
}

function findFreePort(min, max) {
  return new Promise((resolve, reject) => {
    const port = min + Math.floor(Math.random() * (max - min));
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      findFreePort(min, max).then(resolve).catch(reject);
    });
  });
}

module.exports = { QemuManager, QemuSession };
