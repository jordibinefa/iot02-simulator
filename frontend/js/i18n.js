/**
 * i18n.js — Traduccions de la interfície del Simulador IoT-02
 *
 * Ús:
 *   1. Defineix `const LANG = 'ca'|'en'|'es'` ABANS de carregar aquest fitxer.
 *   2. Afegeix atributs `data-i18n="clau"` als elements HTML estàtics.
 *   3. Crida `applyTranslations()` just després de carregar aquest fitxer.
 *   4. Usa `T.clau` a l'script principal per als textos dinàmics.
 *
 * Per afegir un idioma nou: copia el bloc d'un idioma existent,
 * canvia la clau i tradueix els valors.
 */

const I18N = {

    ca: {
        // ── Títol i toolbar ──
        pageTitle:          'ESP32 Simulator — IoT-02',
        connDisconnected:   'Desconnectat',
        connConnecting:     'Connectant...',
        connConnected:      'Connectat',
        connError:          'Error de connexió',
        labelMac:           'MAC:',
        labelId:            'ID:',
        sessionIdTitle:     'Session ID (MQTT)',
        btnCopySession:     '⎘',
        btnCopyDone:        '✓',
        labelSessions:      'Sessions:',
        btnSettings:        '⚙',
        titleSettings:      'Configuració',

        // ── Zona d'upload ──
        uploadTitle:        '📦 Compilació',
        uploadIcon:         '📁',
        uploadHint:         'Arrossega aquí el <strong>ZIP del projecte</strong>, un <strong>ZIP amb binaris</strong> o un <strong>.bin merged</strong>',
        uploadHint2:        'ZIP binaris: *.ino.bin + bootloader + partitions · BIN merged: 4MB flash image',
        btnCompile:         'Compila / Carrega',
        btnStart:           '▶ Inicia QEMU',
        btnStop:            '⬛ Atura',
        btnDownload:        '⬇ .bin',
        macTitle:           'MAC editable (12 hex chars)',

        // ── Serial Monitor ──
        serialTitle:        '🖥️ Serial Monitor (115200 baud)',
        serialPlaceholder:  'Tramet al Serial...',
        btnSerialSend:      'Tramet',
        btnSerialClear:     'Neteja',

        // ── Missatges d'estat (dinàmics, usats via T.clau) ──
        statusProcessing:   'Processant...',
        statusCompiling:    'Compilant...',
        statusStarting:     'Iniciant QEMU...',
        statusStarted:      '✅ QEMU iniciat!',
        statusLoadingBin:   'Carregant binari des de URL...',
        statusUploadingBin: 'Pujant binari...',
        statusBinReady:     '✅ Binari llest',
        statusLoadingCode:  'Carregant codi font des de URL...',
        statusCached:       '✅ Binari trobat al caché!',
        statusOk:           '✅ Compilació correcta',
        errHashFormat:      '❌ Hash mal format',
        errSidInvalid:      '⚠️ sid= invàlid (no pot contenir /, + ni #), s\'usa el guardat',
        errMacInvalid:      '⚠️ MAC de la URL invàlida, s\'usa la guardada',
        errFetch:           '❌ Error al fetch:',
        errUpload:          '❌ Error al pujar:',
        errCompile:         '❌ Error a la compilació:',
        errGeneric:         '❌ Error:',
        errBoardImage:      '⚠️ No s\'ha pogut carregar la imatge de la placa',
        sessionIdFull:      'Session ID complet:',
        sessionIdMqtt:      '(tòpic MQTT: iot02/{id}/...)',
        sessionIdPrompt:    'Session ID (copia manualment):',
        sessionTimeout:     '\n⚠️ Sessió inactiva! Tens {s}s per respondre.\n',
        sessionEnd:         '\n🛑 Sessió acabada: ',
        sessionEndUnknown:  'desconegut',
        sessionEnded:       'Sessió acabada',
    },

    en: {
        // ── Title and toolbar ──
        pageTitle:          'ESP32 Simulator — IoT-02',
        connDisconnected:   'Disconnected',
        connConnecting:     'Connecting...',
        connConnected:      'Connected',
        connError:          'Connection error',
        labelMac:           'MAC:',
        labelId:            'ID:',
        sessionIdTitle:     'Session ID (MQTT)',
        btnCopySession:     '⎘',
        btnCopyDone:        '✓',
        labelSessions:      'Sessions:',
        btnSettings:        '⚙',
        titleSettings:      'Settings',

        // ── Upload zone ──
        uploadTitle:        '📦 Compilation',
        uploadIcon:         '📁',
        uploadHint:         'Drop your <strong>project ZIP</strong>, a <strong>binary ZIP</strong> or a <strong>merged .bin</strong> here',
        uploadHint2:        'Binary ZIP: *.ino.bin + bootloader + partitions · Merged BIN: 4MB flash image',
        btnCompile:         'Compile / Upload',
        btnStart:           '▶ Start QEMU',
        btnStop:            '⬛ Stop',
        btnDownload:        '⬇ .bin',
        macTitle:           'Editable MAC (12 hex chars)',

        // ── Serial Monitor ──
        serialTitle:        '🖥️ Serial Monitor (115200 baud)',
        serialPlaceholder:  'Send to Serial...',
        btnSerialSend:      'Send',
        btnSerialClear:     'Clear',

        // ── Status messages (dynamic, used via T.key) ──
        statusProcessing:   'Processing...',
        statusCompiling:    'Compiling...',
        statusStarting:     'Starting QEMU...',
        statusStarted:      '✅ QEMU started!',
        statusLoadingBin:   'Loading binary from URL...',
        statusUploadingBin: 'Uploading binary...',
        statusBinReady:     '✅ Binary ready',
        statusLoadingCode:  'Loading source code from URL...',
        statusCached:       '✅ Binary found in cache!',
        statusOk:           '✅ Compilation successful',
        errHashFormat:      '❌ Malformed hash',
        errSidInvalid:      '⚠️ sid= invalid (cannot contain /, + or #), using saved value',
        errMacInvalid:      '⚠️ MAC from URL is invalid, using saved value',
        errFetch:           '❌ Fetch error:',
        errUpload:          '❌ Upload error:',
        errCompile:         '❌ Compilation error:',
        errGeneric:         '❌ Error:',
        errBoardImage:      '⚠️ Could not load board image',
        sessionIdFull:      'Full session ID:',
        sessionIdMqtt:      '(MQTT topic: iot02/{id}/...)',
        sessionIdPrompt:    'Session ID (copy manually):',
        sessionTimeout:     '\n⚠️ Session inactive! You have {s}s to respond.\n',
        sessionEnd:         '\n🛑 Session ended: ',
        sessionEndUnknown:  'unknown',
        sessionEnded:       'Session ended',
    },

    es: {
        // ── Título y barra de herramientas ──
        pageTitle:          'ESP32 Simulator — IoT-02',
        connDisconnected:   'Desconectado',
        connConnecting:     'Conectando...',
        connConnected:      'Conectado',
        connError:          'Error de conexión',
        labelMac:           'MAC:',
        labelId:            'ID:',
        sessionIdTitle:     'Session ID (MQTT)',
        btnCopySession:     '⎘',
        btnCopyDone:        '✓',
        labelSessions:      'Sesiones:',
        btnSettings:        '⚙',
        titleSettings:      'Configuración',

        // ── Zona de carga ──
        uploadTitle:        '📦 Compilación',
        uploadIcon:         '📁',
        uploadHint:         'Arrastra aquí el <strong>ZIP del proyecto</strong>, un <strong>ZIP con binarios</strong> o un <strong>.bin merged</strong>',
        uploadHint2:        'ZIP binarios: *.ino.bin + bootloader + partitions · BIN merged: imagen flash 4MB',
        btnCompile:         'Compilar / Cargar',
        btnStart:           '▶ Iniciar QEMU',
        btnStop:            '⬛ Detener',
        btnDownload:        '⬇ .bin',
        macTitle:           'MAC editable (12 caracteres hex)',

        // ── Monitor Serie ──
        serialTitle:        '🖥️ Monitor Serie (115200 baud)',
        serialPlaceholder:  'Enviar al Serie...',
        btnSerialSend:      'Enviar',
        btnSerialClear:     'Limpiar',

        // ── Mensajes de estado (dinámicos, usados via T.clave) ──
        statusProcessing:   'Procesando...',
        statusCompiling:    'Compilando...',
        statusStarting:     'Iniciando QEMU...',
        statusStarted:      '✅ ¡QEMU iniciado!',
        statusLoadingBin:   'Cargando binario desde URL...',
        statusUploadingBin: 'Subiendo binario...',
        statusBinReady:     '✅ Binario listo',
        statusLoadingCode:  'Cargando código fuente desde URL...',
        statusCached:       '✅ ¡Binario encontrado en caché!',
        statusOk:           '✅ Compilación correcta',
        errHashFormat:      '❌ Hash con formato incorrecto',
        errSidInvalid:      '⚠️ sid= inválido (no puede contener /, + ni #), se usa el guardado',
        errMacInvalid:      '⚠️ MAC de la URL inválida, se usa la guardada',
        errFetch:           '❌ Error al fetch:',
        errUpload:          '❌ Error al subir:',
        errCompile:         '❌ Error de compilación:',
        errGeneric:         '❌ Error:',
        errBoardImage:      '⚠️ No se pudo cargar la imagen de la placa',
        sessionIdFull:      'Session ID completo:',
        sessionIdMqtt:      '(tópico MQTT: iot02/{id}/...)',
        sessionIdPrompt:    'Session ID (copia manualmente):',
        sessionTimeout:     '\n⚠️ ¡Sesión inactiva! Tienes {s}s para responder.\n',
        sessionEnd:         '\n🛑 Sesión terminada: ',
        sessionEndUnknown:  'desconocido',
        sessionEnded:       'Sesión terminada',
    },
};

// ── Exporta les traduccions de l'idioma actiu com a T ──
// LANG ha d'estar definida abans de carregar aquest fitxer.
// eslint-disable-next-line no-undef
const T = I18N[typeof LANG !== 'undefined' ? LANG : 'ca'] || I18N.ca;

/**
 * Aplica les traduccions estàtiques als elements amb data-i18n.
 * Ha de cridar-se un cop el DOM estigui carregat.
 *
 * Modes:
 *   data-i18n="clau"            → element.textContent = T[clau]
 *   data-i18n-html="clau"       → element.innerHTML   = T[clau]  (permet HTML)
 *   data-i18n-placeholder="clau"→ element.placeholder = T[clau]
 *   data-i18n-title="clau"      → element.title       = T[clau]
 */
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (T[key] !== undefined) el.textContent = T[key];
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        if (T[key] !== undefined) el.innerHTML = T[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (T[key] !== undefined) el.placeholder = T[key];
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (T[key] !== undefined) el.title = T[key];
    });
    // Títol de la pàgina
    if (T.pageTitle) document.title = T.pageTitle;
}
