// ESP32 Simulator — Backend Server
// Express + WebSocket + QEMU Session Management + arduino-cli Compilation

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { QemuManager } = require('./QemuManager');
const { MqttBridge }  = require('./MqttBridge');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Configuration ───
const CONFIG = {
  port: 3000,
  maxConcurrentCompilations: 4,
  maxCompileQueue: 20,
  compileTimeout: 120_000,     // 120s for first compilation
  cacheCompileTimeout: 10_000, // 10s for cached
  rateLimitMs: 30_000,         // 30s between compilations per session
  maxCodeSize: 6 * 1024 * 1024, // 6MB (flash images merged fan 4MB)
  maxCacheEntries: 200,
  maxSessions: 30,
  sessionTimeoutMs: 15 * 60_000,    // 15 min inactivity
  sessionGracePeriodMs: 2 * 60_000, // 2 min grace after warning
  fqbn: 'esp32:esp32:esp32:FlashFreq=40,FlashSize=4M,FlashMode=dio',  // QEMU-compatible flash settings
  cacheDir: '/app/cache',
  firmwareDir: '/app/firmware',
  compilationsDir: '/app/compilations',
  sessionsDir: '/app/sessions',
  shimDir: '/app/ethernet_shim',
};

// ─── State ───
let activeCompilations = 0;
const compileQueue = [];
const compilationCache = new Map(); // sha256 → { elfHash, binPath, timestamp }
const sessionRateLimits = new Map(); // sessionId → lastCompileTime
const qemuManager = new QemuManager(CONFIG);

// ─── Pont MQTT ───
const MQTT_BRIDGE_URL = process.env.MQTT_BRIDGE_URL || 'mqtt://mosquitto-broker:1883';
const mqttBridge = new MqttBridge({
  brokerUrl:      MQTT_BRIDGE_URL,
  getSession:     (id) => qemuManager.getSession(id),
  getSessionList: ()   => qemuManager.getSessionList(),
});
mqttBridge.connect();
qemuManager.mqttBridge = mqttBridge;

// ─── Middleware ───
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: CONFIG.maxCodeSize },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip') ||
        file.originalname.endsWith('.bin') ||
        file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Només es permeten fitxers ZIP o BIN'));
    }
  }
});

// ─── Helper: SHA256 d'un fitxer ───
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Helper: Generate random MAC ───
function generateMac() {
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered, unicast
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

// ─── Helper: Apply Ethernet shim to project ───
function applyEthernetShim(projectDir) {
  const shimDir = CONFIG.shimDir;
  if (!fs.existsSync(shimDir)) return;

  // Eliminar IoT-02_wifiMng.cpp per evitar "multiple definition" al linker:
  // el shim redefiniex vSetupWifi, szGetMac, etc. que ja estan en aquest fitxer.
  const wifiMngCpp = path.join(projectDir, 'IoT-02_wifiMng.cpp');
  if (fs.existsSync(wifiMngCpp)) {
    fs.unlinkSync(wifiMngCpp);
  }

  // Copiar fitxers del shim al projecte
  const shimFiles = fs.readdirSync(shimDir);
  for (const f of shimFiles) {
    fs.copyFileSync(path.join(shimDir, f), path.join(projectDir, f));
  }

  // Patchejar fitxers del projecte
  const files = fs.readdirSync(projectDir).filter(f =>
    f.endsWith('.ino') || f.endsWith('.cpp') || f.endsWith('.h'));

  for (const f of files) {
    // No modificar els fitxers del shim que acabem de copiar
    if (f === 'qemu_ethernet_shim.h' || f === 'qemu_ethernet_shim.cpp') continue;

    const filePath = path.join(projectDir, f);
    let content = fs.readFileSync(filePath, 'utf8');

    if (f.endsWith('.ino')) {
      // Afegir #define USING_ETHERNET_QEMU al principi del .ino,
      // ABANS del #define USING_WIFI original (necessari perquè els
      // #ifdef al .ino es processen en ordre de lectura).
      if (!content.includes('USING_ETHERNET_QEMU')) {
        content = '#define USING_ETHERNET_QEMU\n' + content;
      }

      // Substituir WiFi.localIP() per QEMU_LOCAL_IP() (macro definida al shim)
      // que retorna la IP real de la interfície Ethernet emulada en lloc de 0.0.0.0.
      content = content.replace(/WiFi\.localIP\(\)/g, 'QEMU_LOCAL_IP()');
      // Substituir WiFiClient per NetworkClient perquè PubSubClient
      // usi la interfície Ethernet en lloc de la pila WiFi no inicialitzada.
      content = content.replace(/\bWiFiClient\b/g, 'NetworkClient');
    }
    // Fase 2 DNS: ja NO reescrivim mqtt_server — el firmware usa el hostname
    // original del sketch (p.ex. "broker.binefa.cat"). El shim configura DNS
    // apuntant al gateway slirp, que reenvia a 8.8.8.8 via l'argument -nic.
    // Només normalitzem el port a 1883 (per si el sketch usa un port diferent).
    content = content.replace(
      /const int\s*mqtt_port\s*=\s*\d+/,
      'const int mqtt_port = 1883'
    );

    // Injectar #define QEMU_ETHERNET_SHIM_IMPL + #include del shim just després
    // de IoT-02_wifiCredentials.h (o IoT-02_wifiMng.h com a fallback).
    // El #define QEMU_ETHERNET_SHIM_IMPL és imprescindible: activa les
    // implementacions dins el header-only, que es compilen UNA SOLA VEGADA
    // des del .ino (arduino-cli no compila .cpp afegits dinàmicament al sketch).
    if (!content.includes('qemu_ethernet_shim.h')) {
      content = content.replace(
        /#include\s*"IoT-02_wifiCredentials\.h"/,
        '#include "IoT-02_wifiCredentials.h"\n#define QEMU_ETHERNET_SHIM_IMPL\n#include "qemu_ethernet_shim.h"'
      );
      // Fallback: injectar després de IoT-02_wifiMng.h si no hi ha credentials
      if (!content.includes('qemu_ethernet_shim.h')) {
        content = content.replace(
          /#include\s*"IoT-02_wifiMng\.h"/,
          '#include "IoT-02_wifiMng.h"\n#define QEMU_ETHERNET_SHIM_IMPL\n#include "qemu_ethernet_shim.h"'
        );
      }
    }

    fs.writeFileSync(filePath, content);
  }
}

// ─── Helper: Run compilation ───
function compileProject(workDir, sessionId) {
  return new Promise((resolve, reject) => {
    // Find the .ino file
    const files = fs.readdirSync(workDir);
    const inoFile = files.find(f => f.endsWith('.ino'));
    if (!inoFile) {
      return reject(new Error('No .ino file found in ZIP'));
    }

    // arduino-cli requires the sketch to be in a folder with the same name
    const sketchName = path.basename(inoFile, '.ino');
    const sketchDir = path.join(workDir, sketchName);

    // If files aren't already in a subfolder matching the sketch name
    if (!fs.existsSync(sketchDir)) {
      fs.mkdirSync(sketchDir, { recursive: true });
      for (const f of files) {
        const src = path.join(workDir, f);
        if (fs.statSync(src).isFile()) {
          fs.renameSync(src, path.join(sketchDir, f));
        }
      }
    }

    // Apply Ethernet shim
    applyEthernetShim(sketchDir);

    const buildDir = path.join(workDir, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    // Compile with arduino-cli
    const args = [
      'compile',
      '--fqbn', CONFIG.fqbn,
      '--build-path', buildDir,
      '--warnings', 'none',
      sketchDir
    ];

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Compilation timeout'));
    }, CONFIG.compileTimeout);

    const child = execFile('arduino-cli', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: CONFIG.compileTimeout,
    }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      if (error) {
        return reject(new Error(`Compilation error: ${stderr || error.message}`));
      }

      // Find the .elf and .bin files
      const elfPath = path.join(buildDir, `${sketchName}.ino.elf`);
      const appBin = path.join(buildDir, `${sketchName}.ino.bin`);
      const bootloaderBin = path.join(buildDir, `${sketchName}.ino.bootloader.bin`);
      const partitionsBin = path.join(buildDir, `${sketchName}.ino.partitions.bin`);

      if (!fs.existsSync(appBin)) {
        return reject(new Error('Compilation succeeded but .bin not found'));
      }

      // Create merged flash image with esptool.py merge_bin
      const flashImage = path.join(buildDir, 'flash_image.bin');

      // Determine boot_app0.bin location (inside the Arduino core)
      const boot_app0 = findBootApp0();

      const mergeArgs = [
        '--chip', 'esp32',
        'merge_bin',
        '--flash_mode', 'dio',
        '--flash_freq', '40m',
        '--flash_size', '4MB',
        '--fill-flash-size', '4MB',
        '-o', flashImage
      ];

      // Add bootloader if exists
      if (fs.existsSync(bootloaderBin)) {
        mergeArgs.push('0x1000', bootloaderBin);
      }
      // Add partition table
      if (fs.existsSync(partitionsBin)) {
        mergeArgs.push('0x8000', partitionsBin);
      }
      // Add boot_app0 if found
      if (boot_app0 && fs.existsSync(boot_app0)) {
        mergeArgs.push('0xe000', boot_app0);
      }
      // Add application
      mergeArgs.push('0x10000', appBin);

      execFile('esptool.py', mergeArgs, (mergeErr, mergeOut, mergeStderr) => {
        if (mergeErr) {
          // Try without fill-flash-size (older esptool)
          console.warn('merge_bin with fill failed, trying manual pad:', mergeStderr);
          // Fallback: create padded image manually
          try {
            createPaddedFlashImage(bootloaderBin, partitionsBin, boot_app0, appBin, flashImage);
          } catch (padErr) {
            return reject(new Error(`Flash image creation failed: ${padErr.message}`));
          }
        }

        if (!fs.existsSync(flashImage)) {
          return reject(new Error('Flash image not created'));
        }

        resolve({
          elfPath,
          flashImagePath: flashImage,
          appBinPath: appBin,
          stdout: stdout,
        });
      });
    });
  });
}

// ─── Helper: Find boot_app0.bin in Arduino core ───
function findBootApp0() {
  const searchPaths = [
    '/root/.arduino15/packages/esp32/hardware/esp32/2.0.17/tools/partitions/boot_app0.bin',
    '/root/Arduino/hardware/espressif/esp32/tools/partitions/boot_app0.bin',
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  // Search recursively
  try {
    const result = require('child_process').execSync(
      'find /root/.arduino15 -name boot_app0.bin 2>/dev/null | head -1',
      { encoding: 'utf8' }
    ).trim();
    if (result) return result;
  } catch (e) {}
  return null;
}

// ─── Helper: Manual flash image padding ───
function createPaddedFlashImage(bootloader, partitions, bootApp0, app, output) {
  const FLASH_SIZE = 4 * 1024 * 1024; // 4MB
  const buf = Buffer.alloc(FLASH_SIZE, 0xFF);

  if (bootloader && fs.existsSync(bootloader)) {
    const bl = fs.readFileSync(bootloader);
    bl.copy(buf, 0x1000);
  }
  if (partitions && fs.existsSync(partitions)) {
    const pt = fs.readFileSync(partitions);
    pt.copy(buf, 0x8000);
  }
  if (bootApp0 && fs.existsSync(bootApp0)) {
    const ba = fs.readFileSync(bootApp0);
    ba.copy(buf, 0xe000);
  }
  const appBuf = fs.readFileSync(app);
  appBuf.copy(buf, 0x10000);

  fs.writeFileSync(output, buf);
}

// ─── REST API ───

// ─── Helper: cerca dinàmica d'un fitxer dins arduino15 ───
function findInArduino(pattern) {
  try {
    const result = require('child_process').execSync(
      `find /root/.arduino15 -name "${pattern}" 2>/dev/null | head -1`,
      { encoding: 'utf8' }
    ).trim();
    return result || null;
  } catch { return null; }
}

// ─── Helper: merge app.bin + bootloader + partitions → flash_image.bin ───
function mergeFlashImage(appBin, bootloaderBin, partBin, boot_app0, flashImage) {
  return new Promise((resolve, reject) => {
    const mergeArgs = [
      '--chip', 'esp32', 'merge_bin', '--fill-flash-size', '4MB', '-o', flashImage,
    ];
    if (bootloaderBin && fs.existsSync(bootloaderBin)) mergeArgs.push('0x1000', bootloaderBin);
    if (partBin       && fs.existsSync(partBin))       mergeArgs.push('0x8000', partBin);
    if (boot_app0     && fs.existsSync(boot_app0))     mergeArgs.push('0xe000', boot_app0);
    mergeArgs.push('0x10000', appBin);

    execFile('esptool.py', mergeArgs, (err, _out, stderr) => {
      if (err) {
        console.warn('[merge] esptool fallit, usant createPaddedFlashImage:', stderr.trim());
        try {
          createPaddedFlashImage(bootloaderBin, partBin, boot_app0, appBin, flashImage);
          resolve();
        } catch (e) { reject(e); }
      } else {
        resolve();
      }
    });
  });
}

// POST /upload-bin — Upload directe de binaris precompilats (sense compilació).
// Accepta dues formes:
//   A) Un sol fitxer .bin  (app binary) → usa bootloader/partitions del core Arduino
//   B) Un ZIP amb *.ino.bin + *.ino.bootloader.bin + *.ino.partitions.bin → merge directe
app.post('/upload-bin', upload.single('firmware'), async (req, res) => {
  const tmpFiles = [];
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No s\'ha rebut cap fitxer' });
    }
    tmpFiles.push(req.file.path);

    const flashImage = path.join('/tmp/uploads', `flash_${Date.now()}.bin`);
    const boot_app0  = findBootApp0();
    let   appBin, bootloaderBin, partBin;

    // ── Forma B: ZIP amb els tres binaris ──
    if (req.file.originalname.endsWith('.zip')) {
      const extractDir = path.join('/tmp/uploads', `binzip_${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });
      tmpFiles.push(extractDir);

      await new Promise((resolve, reject) => {
        execFile('unzip', ['-o', req.file.path, '-d', extractDir], (err) => {
          if (err) reject(new Error('Error extraient ZIP')); else resolve();
        });
      });

      const allBins = [];
      (function walk(dir) {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (f.endsWith('.bin')) allBins.push({ name: f, path: full });
        }
      })(extractDir);

      appBin        = allBins.find(f => f.name.match(/\.ino\.bin$/))?.path;
      bootloaderBin = allBins.find(f => f.name.match(/\.ino\.bootloader\.bin$/))?.path;
      partBin       = allBins.find(f => f.name.match(/\.ino\.partitions\.bin$/))?.path;

      if (!appBin) {
        return res.status(400).json({ success: false,
          message: 'ZIP sense fitxer *.ino.bin. Cal: *.ino.bin, *.ino.bootloader.bin, *.ino.partitions.bin' });
      }

      console.log(`[upload-bin ZIP] app:${appBin} boot:${bootloaderBin} part:${partBin}`);

    // ── Forma A: .bin sol ──
    } else if (req.file.originalname.endsWith('.bin')) {
      // Detectar si és un flash_image.bin ja merged (4MB exactes) — no es pot tornar a fer merge
      const binSize = req.file.size;
      if (binSize === 4 * 1024 * 1024) {
        // És la imatge completa — la usem directament sense merge
        console.log('[upload-bin BIN] Detectat flash_image merged (4MB) — us directe sense merge');
        const elfHash = await sha256File(req.file.path);
        const fwDir   = path.join(CONFIG.firmwareDir, elfHash);
        fs.mkdirSync(fwDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(fwDir, 'flash_image.bin'));
        return res.json({ success: true, elfHash, message: 'Flash image carregada directament' });
      }

      appBin = req.file.path;
      bootloaderBin = findInArduino('bootloader_dio_40m.bin')
                   || findInArduino('bootloader_qio_40m.bin');
      partBin       = findInArduino('default.bin');
      console.log(`[upload-bin BIN] bootloader:${bootloaderBin} partitions:${partBin} boot_app0:${boot_app0}`);
      if (!bootloaderBin) {
        // El core 3.x no té bootloaders precompilats accessibles — cal el ZIP amb els tres fitxers
        return res.status(400).json({
          success: false,
          message: 'Bootloader no trobat al servidor. Puja un ZIP amb els tres fitxers: ' +
                   '*.ino.bin + *.ino.bootloader.bin + *.ino.partitions.bin'
        });
      }

    } else {
      return res.status(400).json({ success: false, message: 'Cal un fitxer .bin o un ZIP amb els tres binaris' });
    }

    await mergeFlashImage(appBin, bootloaderBin, partBin, boot_app0, flashImage);
    tmpFiles.push(flashImage);

    const elfHash = await sha256File(flashImage);
    const fwDir   = path.join(CONFIG.firmwareDir, elfHash);
    fs.mkdirSync(fwDir, { recursive: true });
    fs.copyFileSync(flashImage, path.join(fwDir, 'flash_image.bin'));

    res.json({ success: true, elfHash, message: 'Binari carregat i preparat' });

  } catch (error) {
    console.error('upload-bin error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    for (const p of tmpFiles) {
      try {
        if (fs.existsSync(p)) {
          if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
          else fs.unlinkSync(p);
        }
      } catch { /* ignora errors de neteja */ }
    }
  }
});

// POST /compile — Upload ZIP, compile, return elfHash
app.post('/compile', upload.single('project'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No ZIP file uploaded' });
    }

    const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId || uuidv4();

    // Rate limit
    const lastCompile = sessionRateLimits.get(sessionId);
    if (lastCompile && Date.now() - lastCompile < CONFIG.rateLimitMs) {
      const waitSec = Math.ceil((CONFIG.rateLimitMs - (Date.now() - lastCompile)) / 1000);
      fs.unlinkSync(req.file.path);
      return res.status(429).json({
        success: false,
        message: `Espera ${waitSec}s entre compilacions`,
        retryAfter: waitSec
      });
    }

    // Check queue
    if (activeCompilations >= CONFIG.maxConcurrentCompilations) {
      if (compileQueue.length >= CONFIG.maxCompileQueue) {
        fs.unlinkSync(req.file.path);
        return res.status(503).json({
          success: false,
          message: 'Servidor ocupat. Torna a intentar-ho en uns segons.'
        });
      }
    }

    // Check cache
    const zipHash = await sha256File(req.file.path);
    if (compilationCache.has(zipHash)) {
      const cached = compilationCache.get(zipHash);
      fs.unlinkSync(req.file.path);
      sessionRateLimits.set(sessionId, Date.now());
      return res.json({
        success: true,
        cached: true,
        elfHash: cached.elfHash,
        sessionId,
        message: 'Binari trobat al caché'
      });
    }

    // Queue or compile
    sessionRateLimits.set(sessionId, Date.now());

    const workDir = path.join(CONFIG.compilationsDir, `compile_${Date.now()}_${sessionId}`);
    fs.mkdirSync(workDir, { recursive: true });

    // Extract ZIP
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', req.file.path, '-d', workDir], (err) => {
        fs.unlinkSync(req.file.path);
        if (err) reject(new Error('Error extracting ZIP'));
        else resolve();
      });
    });

    // If ZIP contains a single directory, move into it
    const entries = fs.readdirSync(workDir);
    if (entries.length === 1) {
      const subDir = path.join(workDir, entries[0]);
      if (fs.statSync(subDir).isDirectory()) {
        const subFiles = fs.readdirSync(subDir);
        for (const f of subFiles) {
          fs.renameSync(path.join(subDir, f), path.join(workDir, f));
        }
        fs.rmdirSync(subDir);
      }
    }

    // Detectar si el ZIP conté binaris precompilats en lloc de codi font
    const allFiles = [];
    (function walk(dir) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else allFiles.push({ name: f, path: full });
      }
    })(workDir);

    const appBinFile   = allFiles.find(f => f.name.match(/\.ino\.bin$/));
    const bootBinFile  = allFiles.find(f => f.name.match(/\.ino\.bootloader\.bin$/));
    const partBinFile  = allFiles.find(f => f.name.match(/\.ino\.partitions\.bin$/));

    if (appBinFile) {
      // ZIP amb binaris precompilats — fem merge directament sense compilar
      console.log(`[compile→upload-bin] ZIP amb binaris detectat: ${appBinFile.name}`);
      const boot_app0  = findBootApp0();
      const flashImage = path.join(workDir, 'flash_image.bin');
      await mergeFlashImage(
        appBinFile.path,
        bootBinFile?.path || null,
        partBinFile?.path || null,
        boot_app0,
        flashImage
      );
      const elfHash = await sha256File(flashImage);
      const fwDir   = path.join(CONFIG.firmwareDir, elfHash);
      fs.mkdirSync(fwDir, { recursive: true });
      fs.copyFileSync(flashImage, path.join(fwDir, 'flash_image.bin'));
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.json({
        success: true, cached: false, elfHash, sessionId,
        message: 'Binaris precompilats carregats correctament'
      });
    }

    activeCompilations++;
    try {
      const result = await compileProject(workDir, sessionId);

      // Hash the ELF
      const elfHash = await sha256File(result.flashImagePath);

      // Store in firmware dir
      const fwDir = path.join(CONFIG.firmwareDir, elfHash);
      fs.mkdirSync(fwDir, { recursive: true });
      fs.copyFileSync(result.flashImagePath, path.join(fwDir, 'flash_image.bin'));
      if (fs.existsSync(result.elfPath)) {
        fs.copyFileSync(result.elfPath, path.join(fwDir, 'firmware.elf'));
      }
      if (fs.existsSync(result.appBinPath)) {
        fs.copyFileSync(result.appBinPath, path.join(fwDir, 'firmware.bin'));
      }

      // Cache
      compilationCache.set(zipHash, {
        elfHash,
        binPath: path.join(fwDir, 'flash_image.bin'),
        timestamp: Date.now()
      });
      trimCache();

      // Cleanup work dir
      fs.rmSync(workDir, { recursive: true, force: true });

      res.json({
        success: true,
        cached: false,
        elfHash,
        sessionId,
        message: 'Compilació correcta'
      });
    } finally {
      activeCompilations--;
    }

  } catch (error) {
    console.error('Compile error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /firmware/:hash/download — Download merged .bin
app.get('/firmware/:hash/download', (req, res) => {
  const binPath = path.join(CONFIG.firmwareDir, req.params.hash, 'flash_image.bin');
  if (!fs.existsSync(binPath)) {
    return res.status(404).json({ success: false, message: 'Firmware not found' });
  }
  res.download(binPath, 'firmware_esp32.bin');
});

// POST /session/:id/start — Start QEMU with compiled firmware
app.post('/session/:id/start', express.json(), async (req, res) => {
  try {
    const { elfHash } = req.body;
    if (!elfHash) {
      return res.status(400).json({ success: false, message: 'elfHash requerit' });
    }

    const flashImage = path.join(CONFIG.firmwareDir, elfHash, 'flash_image.bin');
    if (!fs.existsSync(flashImage)) {
      return res.status(404).json({ success: false, message: 'Firmware no trobat. Compila primer.' });
    }

    if (qemuManager.getActiveCount() >= CONFIG.maxSessions) {
      return res.status(503).json({
        success: false,
        message: `Màxim de ${CONFIG.maxSessions} sessions actives`,
        capacity: { used: qemuManager.getActiveCount(), max: CONFIG.maxSessions }
      });
    }

    const _rawMac = req.body.mac || '';
    const _macClean = _rawMac.replace(/:/g, '');
    const mac = /^[0-9A-Fa-f]{12}$/.test(_macClean) ? _macClean.match(/.{2}/g).join(':') : generateMac();
    const session = await qemuManager.startSession(req.params.id, flashImage, mac);

    res.json({
      success: true,
      mac: mac,
      sessionId: req.params.id,
    });
  } catch (error) {
    console.error('Session start error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /session/:id — Stop session
app.delete('/session/:id', (req, res) => {
  qemuManager.stopSession(req.params.id);
  res.json({ success: true, message: 'Sessió aturada' });
});

// GET /status — System stats
app.get('/status', (req, res) => {
  res.json({
    compilations: {
      active: activeCompilations,
      queued: compileQueue.length,
      cached: compilationCache.size,
    },
    sessions: {
      active: qemuManager.getActiveCount(),
      max: CONFIG.maxSessions,
      list: qemuManager.getSessionList(),
    },
    uptime: process.uptime(),
  });
});

// ─── Proxy HTTP per fetch d'URLs externes des del frontend (evita CORS) ───
// Ús: GET /proxy?url=https://example.com/firmware.bin
// Restriccions: només HTTPS, mida màxima CONFIG.maxCodeSize, timeout 15s
// Segueix fins a 1 redirecció (GitHub raw en fa una)
const https_mod = require('https');

app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;

  // Validació bàsica
  if (!rawUrl) {
    return res.status(400).json({ error: 'Paràmetre url és obligatori' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'URL invàlida' });
  }

  // Només HTTPS per seguretat
  if (parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Només es permeten URLs HTTPS' });
  }

  // Funció auxiliar: descarrega una URL HTTPS i retorna els chunks
  function fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const req = https_mod.get(url, { timeout: 15_000 }, (upstream) => {
        // Segueix una única redirecció (GitHub raw → raw.githubusercontent.com, etc.)
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          let redirUrl;
          try { redirUrl = new URL(upstream.headers.location, url).href; }
          catch { return reject(new Error('Redirecció invàlida')); }
          if (!redirUrl.startsWith('https://')) return reject(new Error('Redirecció no-HTTPS'));
          return fetchUrl(redirUrl).then(resolve).catch(reject);
        }

        if (upstream.statusCode !== 200) {
          return reject(new Error(`HTTP ${upstream.statusCode}`));
        }

        const chunks = [];
        let totalSize = 0;
        upstream.on('data', chunk => {
          totalSize += chunk.length;
          if (totalSize > CONFIG.maxCodeSize) {
            upstream.destroy();
            return reject(new Error('Fitxer massa gran'));
          }
          chunks.push(chunk);
        });
        upstream.on('end', () => resolve(Buffer.concat(chunks)));
        upstream.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout de connexió')); });
    });
  }

  try {
    const buf = await fetchUrl(rawUrl);
    // Endevina el Content-Type pel nom de fitxer
    const ct = rawUrl.toLowerCase().split('?')[0].endsWith('.bin')
      ? 'application/octet-stream'
      : 'application/zip';
    res.set('Content-Type', ct);
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error(`[Proxy] Error en fetch de ${rawUrl}: ${err.message}`);
    res.status(502).json({ error: `Error al proxy: ${err.message}` });
  }
});

// ─── WebSocket handling ───
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/session\/([^/]+)\/ws$/);

  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const session = qemuManager.getSession(sessionId);

  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId);
  });
});

wss.on('connection', (ws, request, sessionId) => {
  const session = qemuManager.getSession(sessionId);
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  // Register WebSocket with session
  session.addWebSocket(ws);

  // Send initial info
  ws.send(JSON.stringify({
    type: 'session',
    mac: session.mac,
    sessionId: sessionId,
  }));

  ws.send(JSON.stringify({
    type: 'capacity',
    used: qemuManager.getActiveCount(),
    max: CONFIG.maxSessions,
  }));

  // Handle messages from client
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      session.handleClientMessage(msg);
    } catch (e) {
      console.error('WebSocket message error:', e.message);
    }
  });

  ws.on('close', () => {
    session.removeWebSocket(ws);
  });
});

// ─── Cache trimming ───
function trimCache() {
  if (compilationCache.size <= CONFIG.maxCacheEntries) return;
  const sorted = [...compilationCache.entries()]
    .sort((a, b) => a[1].timestamp - b[1].timestamp);
  while (compilationCache.size > CONFIG.maxCacheEntries * 0.8) {
    const [key, val] = sorted.shift();
    compilationCache.delete(key);
    // Don't delete firmware files — they might be in use by sessions
  }
}

// ─── Cleanup on exit ───
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping all sessions...');
  qemuManager.stopAll();
  mqttBridge.disconnect();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, stopping all sessions...');
  qemuManager.stopAll();
  mqttBridge.disconnect();
  process.exit(0);
});

// ─── Start ───
server.listen(CONFIG.port, () => {
  console.log(`ESP32 Simulator running on port ${CONFIG.port}`);
  console.log(`  Max compilations: ${CONFIG.maxConcurrentCompilations}`);
  console.log(`  Max QEMU sessions: ${CONFIG.maxSessions}`);
  console.log(`  FQBN: ${CONFIG.fqbn}`);
});

// ─── Proxy TCP MQTT: reenvia connexions de QEMU (192.168.4.1:1883) al broker real ───
// QEMU slirp exposa el contenidor com a 192.168.4.1 (el gateway).
// El firmware connecta a 192.168.4.1:1883 (gateway slirp), que arriba
// al proxy Node.js que reenvia al broker real (broker.binefa.cat:1883).
const net = require('net');

// Proxy MQTT: firmware → 192.168.4.1:1883 (slirp gateway) → 127.0.0.1:1883 (proxy) → mosquitto-broker:1883
// Slirp redirigeix automàticament les connexions del guest al gateway cap al host (127.0.0.1).
// NO cal hostfwd — hostfwd és per connexions entrants (host→guest), no sortints (guest→host).
const MQTT_PROXY_PORT = 1883;
const MQTT_REAL_HOST  = process.env.MQTT_BROKER_HOST || 'mosquitto-broker';
const MQTT_REAL_PORT  = parseInt(process.env.MQTT_BROKER_PORT || '1883');

const mqttProxy = net.createServer((clientSocket) => {
  console.log(`[MQTT Proxy] Connexió entrant de ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
  const brokerSocket = net.createConnection({ host: MQTT_REAL_HOST, port: MQTT_REAL_PORT }, () => {
    console.log(`[MQTT Proxy] Connectat a ${MQTT_REAL_HOST}:${MQTT_REAL_PORT}`);
  });
  clientSocket.pipe(brokerSocket);
  brokerSocket.pipe(clientSocket);
  clientSocket.on('error', () => brokerSocket.destroy());
  brokerSocket.on('error', (err) => {
    console.error(`[MQTT Proxy] Error broker: ${err.message}`);
    clientSocket.destroy();
  });
});

mqttProxy.listen(MQTT_PROXY_PORT, '0.0.0.0', () => {
  console.log(`[MQTT Proxy] Escoltant al port ${MQTT_PROXY_PORT} → ${MQTT_REAL_HOST}:${MQTT_REAL_PORT}`);
});

mqttProxy.on('error', (err) => {
  console.error(`[MQTT Proxy] Error: ${err.message}`);
});

