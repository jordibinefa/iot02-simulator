# STAGE 1: Compilar QEMU calib
FROM debian:bookworm AS qemu-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ninja-build meson pkg-config python3 python3-venv \
    libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev libgcrypt-dev \
    libgtk-3-dev libvte-2.91-dev \
    flex bison git ca-certificates libfdt-dev \
    && rm -rf /var/lib/apt/lists/*

COPY calib-src.tar.gz /tmp/
RUN cd /tmp && tar xzf calib-src.tar.gz && rm calib-src.tar.gz

# Apply SSD1306 + BME280 patches
COPY calib-patches/ /tmp/calib-patches/
RUN set -e; \
    \
    # 1. Copy new device source files
    cp /tmp/calib-patches/ssd1306.c /tmp/calib/hw/i2c/ssd1306.c; \
    cp /tmp/calib-patches/bme280.c  /tmp/calib/hw/i2c/bme280.c;  \
    \
    # 2. Add ssd1306.c and bme280.c to hw/i2c/meson.build
    python3 /tmp/calib-patches/patch_meson.py /tmp/calib/hw/i2c/meson.build; \
    \
    # 3. Patch esp32.c: swap tmp105@0x76 → bme280, add ssd1306@0x3C
    python3 /tmp/calib-patches/patch_esp32.py /tmp/calib/hw/xtensa/esp32.c; \
    \
    # 4. Add HMP function declarations to include/monitor/hmp.h
    \
    # 5. Register HMP commands in hmp-commands.hx
    python3 /tmp/calib-patches/patch_hmp_hx.py /tmp/calib/hmp-commands.hx; \
    \
    \
    # 6. Afegir propietat mac a Esp32EfuseState
    python3 /tmp/calib-patches/patch_efuse_mac.py /tmp/calib; \
    \
    echo "=== SSD1306 + BME280 + SARADC patches applied ==="

RUN cd /tmp/calib && \
    mkdir build && cd build && \
    ../configure \
        --target-list=xtensa-softmmu \
        --enable-slirp \
        --enable-gtk \
        --disable-werror \
        --disable-docs --enable-gcrypt \
        --prefix=/opt/qemu-calib && \
    make -j$(nproc) && \
    make install

RUN cp /tmp/calib/pc-bios/esp32-v3-rom.bin /opt/qemu-calib/share/qemu/ 2>/dev/null || true

# STAGE 2: Servei
FROM node:20-bookworm

LABEL maintainer="Jordi Binefa"

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget unzip python3 python3-pip \
    libglib2.0-0 libpixman-1-0 libslirp0 libgcrypt20 \
    libgtk-3-0 libvte-2.91-0 \
    xvfb x11vnc imagemagick \
    xz-utils ca-certificates \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages esptool

ENV ARDUINO_CLI_VERSION=1.1.1
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | \
    BINDIR=/usr/local/bin sh -s ${ARDUINO_CLI_VERSION}

RUN arduino-cli config init && \
    arduino-cli config add board_manager.additional_urls \
      https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json && \
    arduino-cli core update-index && \
    arduino-cli core install esp32:esp32@3.0.7

# ─── Patch OpenEth: compilar emac_openeth.c i afegir-lo a libesp_eth.a ───────
# arduino-esp32 3.x distribueix libesp_eth.a sense CONFIG_ETH_USE_OPENETH=y.
# Descarreguem el font del commit exacte d'ESP-IDF que usa aquest core
# (release/v5.1 @ 632e0c2a9f), el compilem amb el cross-compiler Xtensa
# inclòs al core, i l'injectem a la lib existent.
ENV IDF_COMMIT=632e0c2a9f
ENV LIBS_DIR=/root/.arduino15/packages/esp32/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a/esp32
ENV TOOLCHAIN=/root/.arduino15/packages/esp32/tools/esp-x32/2302/bin
ENV LIBESP_ETH=${LIBS_DIR}/lib/libesp_eth.a

RUN set -e; \
    # ─── 1. Descarregar fonts OpenEth d'ESP-IDF (commit exacte) ───
    curl -fsSL \
      "https://raw.githubusercontent.com/espressif/esp-idf/${IDF_COMMIT}/components/esp_eth/src/esp_eth_mac_openeth.c" \
      -o /tmp/esp_eth_mac_openeth.c; \
    curl -fsSL \
      "https://raw.githubusercontent.com/espressif/esp-idf/${IDF_COMMIT}/components/esp_eth/src/openeth.h" \
      -o /tmp/openeth.h; \
    \
    # ─── 2. Patchejar openeth.h ───
    # Eliminar ESP_STATIC_ASSERT (problemàtic fora de context IDF complet)
    sed -i 's/ESP_STATIC_ASSERT[^;]*;//g' /tmp/openeth.h; \
    # Afegir #include <assert.h> al principi (usat per assert() a les inline)
    sed -i '1s|^|#include <assert.h>\n|' /tmp/openeth.h; \
    \
    # ─── 3. Crear stubs de HEADERS ───
    # Arduino-ESP32 3.x no distribueix els headers de FreeRTOS com a fitxers
    # separats (portmacro.h no existeix). Necessitem stubs de headers amb:
    #   - typedefs i macros correctes (per satisfer la compilació)
    #   - funcions declarades com extern (NO inline no-ops) perquè el linker
    #     les resolgui contra les libs reals (libfreertos.a, libesp_hw_support.a)
    #     quan arduino-cli compili el firmware de l'estudiant.
    mkdir -p /tmp/xtensa_stub/xtensa/config \
              /tmp/xtensa_stub/esp_hw_support/include \
              /tmp/xtensa_stub/driver/include/driver \
              /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/include/freertos \
              /tmp/xtensa_stub/freertos/esp_additions/include/freertos \
              /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/portable/xtensa/include/freertos; \
    \
    # --- xtensa/*.h ---
    printf '#pragma once\n#include <stdint.h>\ntypedef void (*xt_handler)(void *);\nint xt_int_has_handler(unsigned int intr_num, int cpu);\nvoid xt_set_interrupt_handler(unsigned int intr_num, xt_handler handler, void *arg);\nvoid *xt_get_interrupt_handler_arg(unsigned int intr_num);\nvoid xt_ints_on(unsigned int mask);\nvoid xt_ints_off(unsigned int mask);\nvoid xthal_set_intclear(unsigned int mask);\n' \
      > /tmp/xtensa_stub/xtensa/xtensa_api.h; \
    touch /tmp/xtensa_stub/xtensa/xt_utils.h; \
    touch /tmp/xtensa_stub/xtensa/xtensa_context.h; \
    touch /tmp/xtensa_stub/xtensa/corebits.h; \
    touch /tmp/xtensa_stub/xtensa/config/core.h; \
    \
    # --- esp_cpu.h stub: talla la cadena de headers Xtensa complexa ---
    printf '#pragma once\n#include <stdint.h>\n#include <stdbool.h>\nstatic inline int esp_cpu_get_core_id(void) { return 0; }\n' \
      > /tmp/xtensa_stub/esp_hw_support/include/esp_cpu.h; \
    \
    # --- FreeRTOS stubs: typedefs i macros reals, funcions extern ---
    printf '#pragma once\n' \
      > /tmp/xtensa_stub/freertos/esp_additions/include/freertos/FreeRTOSConfig.h; \
    printf '#pragma once\n' \
      > /tmp/xtensa_stub/freertos/esp_additions/include/freertos/FreeRTOSConfig_arch.h; \
    # portmacro.h: macros i typedefs del port Xtensa
    printf '#pragma once\n#include <stdint.h>\ntypedef uint32_t StackType_t;\ntypedef int32_t BaseType_t;\ntypedef uint32_t UBaseType_t;\ntypedef uint32_t TickType_t;\n#define portMAX_DELAY 0xFFFFFFFFUL\n#define portTICK_PERIOD_MS 1\n#define portYIELD_FROM_ISR() \n#define portNUM_PROCESSORS 1\n' \
      > /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/portable/xtensa/include/freertos/portmacro.h; \
    # FreeRTOS.h: inclou portmacro i defineix les macros bàsiques
    printf '#pragma once\n#include <stdint.h>\n#include <stdlib.h>\n#include "freertos/portmacro.h"\n#define pdTRUE   1\n#define pdFALSE  0\n#define pdPASS   pdTRUE\n#define pdFAIL   pdFALSE\n#define pdMS_TO_TICKS(x) ((TickType_t)(x) / portTICK_PERIOD_MS)\n#define configASSERT(x)\n#define tskNO_AFFINITY 0x7FFFFFFF\ntypedef void * TaskHandle_t;\ntypedef void * SemaphoreHandle_t;\ntypedef void * QueueHandle_t;\ntypedef void (*TaskFunction_t)(void *);\n' \
      > /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/include/freertos/FreeRTOS.h; \
    # task.h: declaracions extern (noms reals de la lib) + macros de compatibilitat
    printf '#pragma once\n#include "freertos/FreeRTOS.h"\n#include <assert.h>\nBaseType_t xTaskCreatePinnedToCore(TaskFunction_t pxTaskCode, const char *pcName, uint32_t usStackDepth, void *pvParameters, UBaseType_t uxPriority, TaskHandle_t *pxCreatedTask, BaseType_t xCoreID);\nvoid vTaskDelete(TaskHandle_t xTaskToDelete);\nvoid vTaskGenericNotifyGiveFromISR(TaskHandle_t xTaskToNotify, UBaseType_t uxIndexToNotify, BaseType_t *pxHigherPriorityTaskWoken);\nuint32_t ulTaskNotifyTake(BaseType_t xClearCountOnExit, TickType_t xTicksToWait);\n#define vTaskNotifyGiveFromISR(xTaskToNotify, pxHigherPriorityTaskWoken) vTaskGenericNotifyGiveFromISR((xTaskToNotify), 0, (pxHigherPriorityTaskWoken))\n#define ESP_EARLY_LOGW(tag, ...) \n' \
      > /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/include/freertos/task.h; \
    # portable.h: inclou portmacro
    printf '#pragma once\n#include "freertos/portmacro.h"\n' \
      > /tmp/xtensa_stub/freertos/FreeRTOS-Kernel/include/freertos/portable.h; \
    \
    # --- esp_intr_alloc.h stub: declaracions extern ---
    printf '#pragma once\n#include <stdint.h>\ntypedef void * intr_handle_t;\ntypedef void (*intr_handler_t)(void *);\n#define ESP_INTR_FLAG_IRAM (1<<9)\n#define ESP_INTR_FLAG_LEVEL1 (1<<1)\nint esp_intr_alloc(int source, int flags, intr_handler_t handler, void *arg, intr_handle_t *ret_handle);\nint esp_intr_free(intr_handle_t handle);\nint esp_intr_enable(intr_handle_t handle);\nint esp_intr_disable(intr_handle_t handle);\n' \
      > /tmp/xtensa_stub/esp_intr_alloc.h; \
    \
    # --- spi_master.h stub ---
    printf '#pragma once\ntypedef int spi_host_device_t;\ntypedef void* spi_device_handle_t;\ntypedef struct { int dummy; } spi_device_interface_config_t;\ntypedef struct { int dummy; } spi_transaction_t;\n' \
      > /tmp/xtensa_stub/driver/include/driver/spi_master.h; \
    \
    # ─── 4. Compilar amb stubs de headers + funcions extern ───
    # La compilació genera un .o amb símbols UNDEFINED per a les funcions de
    # FreeRTOS i esp_intr_alloc. Aquests es resoldran quan arduino-cli linki
    # el firmware contra libfreertos.a i libesp_hw_support.a (que sí tenen
    # les implementacions reals de xTaskCreatePinnedToCore, esp_intr_alloc, etc.)
    SDKCONFIG_DIR=$(dirname $(find ${LIBS_DIR} -name 'sdkconfig.h' | head -1)); \
    INCLUDE_FLAGS=$(find ${LIBS_DIR}/include -maxdepth 4 -type d \
      | sed 's|^|-I|' | tr '\n' ' '); \
    ${TOOLCHAIN}/xtensa-esp32-elf-gcc \
      -O2 -mlongcalls \
      -DCONFIG_ETH_USE_OPENETH=1 \
      -DCONFIG_IDF_TARGET_ESP32=1 \
      -UCONFIG_ETH_USE_SPI_ETHERNET \
      -DNDEBUG \
      -DCONFIG_ETH_OPENETH_DMA_RX_BUFFER_NUM=4 \
      -DCONFIG_ETH_OPENETH_DMA_TX_BUFFER_NUM=4 \
      '-DIRAM_ATTR=__attribute__((section(".iram1")))' \
      -DETS_ETH_MAC_INTR_SOURCE=38 \
      -DMALLOC_CAP_DMA=4 \
      -DMALLOC_CAP_INTERNAL=2048 \
      -I/tmp/xtensa_stub \
      -I/tmp/xtensa_stub/esp_hw_support/include \
      -I/tmp/xtensa_stub/freertos/FreeRTOS-Kernel/include \
      -I/tmp/xtensa_stub/freertos/FreeRTOS-Kernel/portable/xtensa/include \
      -I/tmp/xtensa_stub/freertos/esp_additions/include \
      -I/tmp/xtensa_stub/driver/include \
      -I/tmp \
      -I${SDKCONFIG_DIR} \
      ${INCLUDE_FLAGS} \
      -c /tmp/esp_eth_mac_openeth.c \
      -o /tmp/esp_eth_mac_openeth.c.obj; \
    \
    # ─── 5. Stubs assembly: esp_cpu_get_core_id + funcions Xtensa HAL ───
    # esp_cpu.h (inline) referencia funcions Xtensa HAL. El linker les necessita
    # tot i que emac_openeth.c no les crida directament. Fem weak stubs.
    printf '.section .text\n.align 4\n.global esp_cpu_get_core_id\n.type esp_cpu_get_core_id,@function\nesp_cpu_get_core_id:\nentry sp,16\nmovi a2,0\nretw.n\n.align 4\n.weak assert\n.global assert\n.type assert,@function\nassert:\nentry sp,16\nretw.n\n.align 4\n.weak static_assert\n.global static_assert\n.type static_assert,@function\nstatic_assert:\nentry sp,16\nretw.n\n.align 4\n.weak __assert_func\n.global __assert_func\n.type __assert_func,@function\n__assert_func:\nentry sp,16\nretw.n\n.align 4\n.weak xt_int_has_handler\n.global xt_int_has_handler\n.type xt_int_has_handler,@function\nxt_int_has_handler:\nentry sp,16\nmovi a2,0\nretw.n\n.align 4\n.weak xt_set_interrupt_handler\n.global xt_set_interrupt_handler\n.type xt_set_interrupt_handler,@function\nxt_set_interrupt_handler:\nentry sp,16\nretw.n\n.align 4\n.weak xt_get_interrupt_handler_arg\n.global xt_get_interrupt_handler_arg\n.type xt_get_interrupt_handler_arg,@function\nxt_get_interrupt_handler_arg:\nentry sp,16\nmovi a2,0\nretw.n\n.align 4\n.weak xt_ints_on\n.global xt_ints_on\n.type xt_ints_on,@function\nxt_ints_on:\nentry sp,16\nretw.n\n.align 4\n.weak xt_ints_off\n.global xt_ints_off\n.type xt_ints_off,@function\nxt_ints_off:\nentry sp,16\nretw.n\n.align 4\n.weak xthal_set_intclear\n.global xthal_set_intclear\n.type xthal_set_intclear,@function\nxthal_set_intclear:\nentry sp,16\nretw.n\n' > /tmp/esp_cpu_stub.s; \
    ${TOOLCHAIN}/xtensa-esp32-elf-gcc -O2 -mlongcalls \
      -c /tmp/esp_cpu_stub.s -o /tmp/esp_cpu_stub.o; \
    \
    # ─── 6. Injectar a libesp_eth.a ───
    # Primer eliminar l'objecte antic si existís (no hauria, és build net)
    ${TOOLCHAIN}/xtensa-esp32-elf-ar d ${LIBESP_ETH} esp_eth_mac_openeth.c.obj 2>/dev/null || true; \
    ${TOOLCHAIN}/xtensa-esp32-elf-ar rcs ${LIBESP_ETH} \
      /tmp/esp_eth_mac_openeth.c.obj /tmp/esp_cpu_stub.o; \
    \
    # ─── 7. Activar CONFIG_ETH_USE_OPENETH a sdkconfig.h ───
    find ${LIBS_DIR} -name "sdkconfig.h" -exec \
      sed -i 's/.*CONFIG_ETH_USE_OPENETH.*//' {} \; -exec \
      sh -c 'echo "#define CONFIG_ETH_USE_OPENETH 1" >> "$1"' _ {} \;; \
    sed -i 's/# CONFIG_ETH_USE_OPENETH is not set/CONFIG_ETH_USE_OPENETH=y/' \
      ${LIBS_DIR}/sdkconfig; \
    \
    # ─── 8. Guardar openeth.h (necessari en temps de compilació del sketch) ───
    # No eliminem openeth.h perquè pot ser útil per debug.
    rm -f /tmp/esp_eth_mac_openeth.c /tmp/esp_eth_mac_openeth.c.obj /tmp/esp_cpu_stub.s /tmp/esp_cpu_stub.o; \
    echo "=== OpenEth patch aplicat (amb FreeRTOS REAL) ==="

COPY libraries/ /tmp/libraries/
RUN mkdir -p /root/Arduino/libraries && \
    for lib in /tmp/libraries/*.zip; do \
      arduino-cli lib install --zip-path "$lib" 2>/dev/null || \
      unzip -o "$lib" -d /root/Arduino/libraries/; \
    done && \
    rm -rf /tmp/libraries

COPY --from=qemu-builder /opt/qemu-calib /opt/qemu-calib
RUN ln -s /opt/qemu-calib/bin/qemu-system-xtensa /usr/local/bin/qemu-system-xtensa

RUN mkdir -p /app/qemu-rom && \
    cp /opt/qemu-calib/share/qemu/esp32*.bin /app/qemu-rom/ 2>/dev/null || true

WORKDIR /app
COPY backend/package.json backend/package-lock.json* /app/
RUN npm ci --production 2>/dev/null || npm install --production

COPY backend/ /app/
COPY frontend/ /app/frontend/
COPY qemu-devices/ethernet_shim/ /app/ethernet_shim/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN mkdir -p /app/compilations /app/sessions /app/cache /app/firmware

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/status || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
