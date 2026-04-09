#!/bin/bash
# generate_board_package.sh — Genera el board custom "ESP32-QEMU (IoT-02)"
# Executa dins el contenidor esp32sim.
#
# Genera:
#   /app/frontend/arduino/package_iot02_qemu_index.json
#   /app/frontend/arduino/esp32-qemu-iot02-3.0.7.zip
#
# L'estudiant afegeix la URL:
#   https://esp32sim.binefa.cat/arduino/package_iot02_qemu_index.json
# al Board Manager de l'IDE d'Arduino.

set -e

# ─── Configuració ────────────────────────────────────────────────────────────
BOARD_VERSION="3.0.7"
BOARD_NAME="esp32-qemu"
PACKAGE_NAME="iot02_qemu"
VENDOR="iot02"

# Paths del core original
CORE_SRC="/root/.arduino15/packages/esp32/hardware/esp32/${BOARD_VERSION}"
SDK_SRC="/root/.arduino15/packages/esp32/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a"

# Directori de treball
WORK="/tmp/board_package"
STAGE="$WORK/staging/${BOARD_NAME}"
OUTPUT="/app/frontend/arduino"

# URL base on es servirà
BASE_URL="https://esp32sim.binefa.cat/arduino"

echo "=== Generant board custom ESP32-QEMU (IoT-02) ==="
echo "  Core font: $CORE_SRC"
echo "  SDK font: $SDK_SRC"

# ─── 1. Preparar directori d'staging ─────────────────────────────────────────
rm -rf "$WORK"
mkdir -p "$STAGE" "$OUTPUT"

echo "[1/7] Copiant core Arduino ESP32..."
# Copiar TOTS els fitxers del core (platform.txt, boards.txt, cores/, libraries/, variants/, etc.)
cp -a "$CORE_SRC"/. "$STAGE/"

echo "[2/7] Copiant SDK libs (esp32 only)..."
# Crear l'estructura tools/ dins el staging
# El board custom porta les seves pròpies libs SDK (amb el shim injectat)
# però usa el TOOLCHAIN extern (esp-x32@2302) que l'estudiant ja té instal·lat
mkdir -p "$STAGE/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a"
cp -a "$SDK_SRC/esp32" "$STAGE/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a/esp32"

# Copiar també els altres targets mínims necessaris (per si boards.txt els referencia)
# Realment només necessitem esp32, però copiem la mida mínima
for chip in esp32s2 esp32s3 esp32c3 esp32c6 esp32h2; do
    if [ -d "$SDK_SRC/$chip" ]; then
        cp -a "$SDK_SRC/$chip" "$STAGE/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a/$chip"
    fi
done

echo "[3/7] Injectant libqemu_wifi_shim.a..."
ESP32_SDK="$STAGE/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a/esp32"
cp /tmp/shim/libqemu_wifi_shim.a "$ESP32_SDK/lib/"

echo "[4/7] Patchejant ld_flags i ld_libs..."
# Afegir --wrap flags
cat >> "$ESP32_SDK/flags/ld_flags" << 'WRAPEOF'
-Wl,--wrap=esp_wifi_init
-Wl,--wrap=esp_wifi_deinit
-Wl,--wrap=esp_wifi_start
-Wl,--wrap=esp_wifi_stop
-Wl,--wrap=esp_wifi_set_mode
-Wl,--wrap=esp_wifi_get_mode
-Wl,--wrap=esp_wifi_scan_start
-Wl,--wrap=esp_wifi_scan_stop
-Wl,--wrap=esp_wifi_scan_get_ap_num
-Wl,--wrap=esp_wifi_scan_get_ap_records
-Wl,--wrap=esp_wifi_connect
-Wl,--wrap=esp_wifi_disconnect
-Wl,--wrap=esp_wifi_get_mac
-Wl,--wrap=esp_wifi_set_config
-Wl,--wrap=esp_wifi_set_storage
-Wl,--wrap=esp_wifi_set_ps
-Wl,--wrap=esp_wifi_restore
-Wl,--wrap=esp_netif_create_default_wifi_sta
-Wl,--wrap=esp_netif_create_default_wifi_ap
-Wl,--wrap=esp_netif_destroy_default_wifi
WRAPEOF

# Afegir -lqemu_wifi_shim al principi de ld_libs
sed -i '1s/^/-lqemu_wifi_shim\n/' "$ESP32_SDK/flags/ld_libs"

# Assegurar CONFIG_ETH_USE_OPENETH a sdkconfig.h
find "$ESP32_SDK" -name "sdkconfig.h" -exec \
    sh -c 'grep -q CONFIG_ETH_USE_OPENETH "$1" || echo "#define CONFIG_ETH_USE_OPENETH 1" >> "$1"' _ {} \;

echo "[5/7] Personalitzant boards.txt..."
# Simplificar boards.txt: només l'ESP32 QEMU
cat > "$STAGE/boards.txt" << 'BOARDSTXT'
# ESP32-QEMU (IoT-02) — Board per a simulació amb QEMU
# Compila firmwares WiFi que funcionen dins el simulador esp32sim.binefa.cat
# El WiFi es redirigeix automàticament a Ethernet emulat (OpenEth).

esp32qemu.name=ESP32-QEMU (IoT-02 Simulator)

esp32qemu.upload.tool=esptool_py
esp32qemu.upload.tool.default=esptool_py
esp32qemu.upload.tool.network=esp_ota
esp32qemu.upload.maximum_size=1310720
esp32qemu.upload.maximum_data_size=327680
esp32qemu.upload.speed=921600

esp32qemu.bootloader.tool=esptool_py
esp32qemu.bootloader.tool.default=esptool_py

esp32qemu.build.tarch=xtensa
esp32qemu.build.target=esp32
esp32qemu.build.mcu=esp32
esp32qemu.build.chip_variant=esp32
esp32qemu.build.core=esp32
esp32qemu.build.variant=esp32
esp32qemu.build.board=ESP32_DEV
esp32qemu.build.f_cpu=240000000L
esp32qemu.build.flash_size=4MB
esp32qemu.build.flash_freq=40m
esp32qemu.build.flash_mode=dio
esp32qemu.build.boot=dio
esp32qemu.build.boot_freq=40m
esp32qemu.build.partitions=default
esp32qemu.build.defines=-DBOARD_HAS_PSRAM
esp32qemu.build.loop_core=-DARDUINO_RUNNING_CORE=1
esp32qemu.build.event_core=-DARDUINO_EVENT_RUNNING_CORE=1
esp32qemu.build.memory_type=dio_qspi

esp32qemu.menu.UploadSpeed.921600=921600
esp32qemu.menu.UploadSpeed.921600.upload.speed=921600
esp32qemu.menu.UploadSpeed.115200=115200
esp32qemu.menu.UploadSpeed.115200.upload.speed=115200

esp32qemu.menu.DebugLevel.none=Cap
esp32qemu.menu.DebugLevel.none.build.code_debug=0
esp32qemu.menu.DebugLevel.error=Error
esp32qemu.menu.DebugLevel.error.build.code_debug=1
esp32qemu.menu.DebugLevel.warn=Warn
esp32qemu.menu.DebugLevel.warn.build.code_debug=2
esp32qemu.menu.DebugLevel.info=Info
esp32qemu.menu.DebugLevel.info.build.code_debug=3
esp32qemu.menu.DebugLevel.debug=Debug
esp32qemu.menu.DebugLevel.debug.build.code_debug=4
esp32qemu.menu.DebugLevel.verbose=Verbose
esp32qemu.menu.DebugLevel.verbose.build.code_debug=5
BOARDSTXT

echo "[6/7] Creant ZIP del board..."
cd "$WORK/staging"
# L'estructura dins el ZIP ha de ser directament els fitxers (sense subdirectori arrel)
# perquè Arduino Board Manager els extreu al directori del platform
cd "$STAGE"
ZIP_FILE="$OUTPUT/esp32-qemu-iot02-${BOARD_VERSION}.zip"
zip -r -q "$ZIP_FILE" . -x "*.DS_Store"
ZIP_SIZE=$(stat -c%s "$ZIP_FILE")
ZIP_SHA256=$(sha256sum "$ZIP_FILE" | cut -d' ' -f1)
echo "  ZIP: $ZIP_FILE"
echo "  Mida: $ZIP_SIZE bytes"
echo "  SHA256: $ZIP_SHA256"

echo "[7/7] Generant package_iot02_qemu_index.json..."
cat > "$OUTPUT/package_iot02_qemu_index.json" << JSONEOF
{
  "packages": [
    {
      "name": "${VENDOR}",
      "maintainer": "Jordi Binefa — IoT-02 QEMU Simulator",
      "websiteURL": "https://esp32sim.binefa.cat",
      "email": "jordi@binefa.cat",
      "help": {
        "online": "https://esp32sim.binefa.cat"
      },
      "platforms": [
        {
          "name": "ESP32-QEMU (IoT-02 Simulator)",
          "architecture": "esp32",
          "version": "${BOARD_VERSION}",
          "category": "ESP32",
          "url": "${BASE_URL}/esp32-qemu-iot02-${BOARD_VERSION}.zip",
          "archiveFileName": "esp32-qemu-iot02-${BOARD_VERSION}.zip",
          "checksum": "SHA-256:${ZIP_SHA256}",
          "size": "${ZIP_SIZE}",
          "help": {
            "online": "https://esp32sim.binefa.cat"
          },
          "boards": [
            {
              "name": "ESP32-QEMU (IoT-02 Simulator)"
            }
          ],
          "toolsDependencies": [
            {
              "packager": "esp32",
              "name": "esp-x32",
              "version": "2302"
            },
            {
              "packager": "esp32",
              "name": "esp-xs2",
              "version": "2302"
            },
            {
              "packager": "esp32",
              "name": "esp-xs3",
              "version": "2302"
            },
            {
              "packager": "esp32",
              "name": "esp-rv32",
              "version": "2302"
            },
            {
              "packager": "esp32",
              "name": "esptool_py",
              "version": "4.6"
            },
            {
              "packager": "esp32",
              "name": "esp32-arduino-libs",
              "version": "idf-release_v5.1-632e0c2a"
            }
          ]
        }
      ],
      "tools": []
    }
  ]
}
JSONEOF

echo ""
echo "=== GENERAT! ==="
echo ""
echo "Fitxers:"
ls -la "$OUTPUT"/
echo ""
echo "L'estudiant ha d'afegir al Board Manager:"
echo "  ${BASE_URL}/package_iot02_qemu_index.json"
echo ""
echo "IMPORTANT: L'estudiant necessita tenir instal·lat prèviament:"
echo "  esp32 by Espressif Systems versió 3.0.7"
echo "  (per les toolsDependencies: esp-x32, esptool_py, etc.)"

# Neteja
rm -rf "$WORK"
