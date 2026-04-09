/*
 * ESP32 SAR ADC1 minimal MMIO emulation for QEMU calib
 *
 * Covers the SENS peripheral block: 0x3FF48800 - 0x3FF48BFF
 *
 * ────────────────────────────────────────────────────────────────
 * REGISTRE CLAU: SENS_SAR_MEAS_START1_REG  (offset 0x0054)
 *
 *   bit 31       : SAR1_EN_PAD_FORCE   (R/W)
 *   bits [30:19] : SAR1_EN_PAD         (R/W) bitmask del canal
 *   bit 18       : MEAS1_START_FORCE   (R/W)
 *   bit 17       : MEAS1_START_SAR     (R/W) trigger conversió
 *   bit 16       : MEAS1_DONE_SAR      (RO)  conversió completada
 *   bits [15:0]  : MEAS1_DATA_SAR      (RO)  resultat 12-bit
 *
 * El driver ESP-IDF (adc_convert / rtc_module.c) fa:
 *   1. Escriu sar1_en_pad = (1 << channel)  a offset 0x54
 *   2. Escriu meas1_start_sar = 0           a offset 0x54
 *   3. Escriu meas1_start_sar = 1           a offset 0x54
 *   4. Llegeix offset 0x54, poll bit 16 (meas1_done_sar)
 *   5. Llegeix offset 0x54, extreu bits [15:0] (meas1_data_sar)
 *
 * NOTA: SENS_SAR_READ_STATUS1_REG (offset 0x04) NO s'utilitza
 *       pel driver RTC (mode single-shot). Té un layout diferent
 *       (data als bits [27:16], done al bit 15).
 *       El posem coherent per si algun codi alternatiu el consulta.
 *
 * Exposa comanda HMP: adc_set channel value
 * ────────────────────────────────────────────────────────────────
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "monitor/monitor.h"
#include "monitor/hmp.h"
#include "qapi/error.h"

#define TYPE_ESP32_SARADC "esp32-saradc"
#define ESP32_SARADC_SIZE  0x400   /* 1KB: 0x3FF48800 - 0x3FF48BFF */

/* Register offsets from base 0x3FF48800 */
#define SENS_SAR_READ_CTRL_OFF     0x0000  /* SAR_READ_CTRL (config) */
#define SENS_SAR_READ_STATUS1_OFF  0x0004  /* ADC1 result alt (not used by driver) */
#define SENS_SAR_MEAS_START1_OFF   0x0054  /* ADC1 start + done + data */
#define SENS_SAR_SLAVE_ADDR1_OFF   0x003C  /* meas_status field polled before start */

/* Bit definitions for SENS_SAR_MEAS_START1_REG (offset 0x54) */
#define MEAS1_SAR1_EN_PAD_FORCE_BIT  31
#define MEAS1_SAR1_EN_PAD_SHIFT      19     /* bits [30:19] */
#define MEAS1_SAR1_EN_PAD_MASK       0xFFF
#define MEAS1_START_FORCE_BIT        18
#define MEAS1_START_SAR_BIT          17
#define MEAS1_DONE_SAR_BIT           16     /* RO: conversion done */
#define MEAS1_DATA_SAR_MASK          0xFFFF /* bits [15:0], 12 bits útils */

/* Bit definitions for SENS_SAR_READ_STATUS1_REG (offset 0x04) */
#define STATUS1_DONE_BIT             15     /* bit 15 = done */
#define STATUS1_DATA_SHIFT           16     /* bits [27:16] = 12-bit */
#define STATUS1_DATA_MASK            0x0FFF

typedef struct Esp32SarAdcState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;

    /* ADC channel values (0-7 for ADC1) */
    uint16_t adc1_values[8];

    /* Currently selected channel (from EN_PAD bits) */
    uint8_t  selected_channel;

    /* Shadow of the R/W bits of MEAS_START1 */
    uint32_t meas_start1_rw;

    /* Register file for driver compatibility */
    uint32_t regs[ESP32_SARADC_SIZE / 4];
} Esp32SarAdcState;

OBJECT_DECLARE_SIMPLE_TYPE(Esp32SarAdcState, ESP32_SARADC)

static Esp32SarAdcState *g_saradc = NULL;

/* ── MMIO read ───────────────────────────────────────────────────── */

static uint64_t esp32_saradc_read(void *opaque, hwaddr offset, unsigned size)
{
    Esp32SarAdcState *s = ESP32_SARADC(opaque);

    if (offset == SENS_SAR_MEAS_START1_OFF) {
        /*
         * El driver llegeix MEAS_START1 per:
         *   - Comprovar DONE (bit 16): retornem sempre 1
         *   - Llegir DATA (bits [15:0]): valor del canal seleccionat
         *
         * Preservem els bits R/W (EN_PAD, START_FORCE, etc.)
         * i sobreescrivim els bits RO (DONE + DATA).
         */
        uint16_t val = s->adc1_values[s->selected_channel] & 0xFFF;
        return (s->meas_start1_rw & 0xFFFE0000u)  /* bits R/W [31:17] */
               | (1u << MEAS1_DONE_SAR_BIT)        /* bit 16 = DONE */
               | (uint32_t)val;                     /* bits [15:0] = DATA */
    }

    if (offset == SENS_SAR_READ_STATUS1_OFF) {
        /*
         * Registre alternatiu (no usat pel driver RTC estàndard,
         * però el posem coherent per si algun codi el consulta).
         * Layout: bits [27:16] = data, bit 15 = done.
         */
        uint16_t val = s->adc1_values[s->selected_channel] & STATUS1_DATA_MASK;
        return ((uint32_t)val << STATUS1_DATA_SHIFT) | (1u << STATUS1_DONE_BIT);
    }

    if (offset == SENS_SAR_SLAVE_ADDR1_OFF) {
        /*
         * El driver comprova SENS.sar_slave_addr1.meas_status != 0
         * abans de llançar la conversió. Retornem 0 = "lliure".
         * El camp meas_status és als bits [7:0] d'aquest registre.
         */
        return s->regs[offset >> 2] & ~0xFFu;  /* meas_status = 0 */
    }

    if ((offset >> 2) < (ESP32_SARADC_SIZE / 4)) {
        return s->regs[offset >> 2];
    }
    return 0;
}

/* ── MMIO write ──────────────────────────────────────────────────── */

static void esp32_saradc_write(void *opaque, hwaddr offset,
                               uint64_t value, unsigned size)
{
    Esp32SarAdcState *s = ESP32_SARADC(opaque);

    if ((offset >> 2) < (ESP32_SARADC_SIZE / 4)) {
        s->regs[offset >> 2] = (uint32_t)value;
    }

    if (offset == SENS_SAR_MEAS_START1_OFF) {
        /* Guardem els bits R/W per retornar-los a les lectures */
        s->meas_start1_rw = (uint32_t)value;

        /* Extreure el canal seleccionat de SAR1_EN_PAD bits [30:19] */
        uint32_t en_pad = (value >> MEAS1_SAR1_EN_PAD_SHIFT) & MEAS1_SAR1_EN_PAD_MASK;
        if (en_pad) {
            /* El bit més baix actiu = canal actiu */
            for (int i = 0; i < 8; i++) {
                if (en_pad & (1u << i)) {
                    s->selected_channel = i;
                    break;
                }
            }
        }
    }
}

static const MemoryRegionOps esp32_saradc_ops = {
    .read       = esp32_saradc_read,
    .write      = esp32_saradc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
};

/* ── HMP command: adc_set ────────────────────────────────────────── */

void hmp_adc_set(Monitor *mon, const QDict *qdict)
{
    if (!g_saradc) {
        monitor_printf(mon, "adc_set: no SAR ADC device found\n");
        return;
    }
    int     channel = (int)qdict_get_int(qdict, "channel");
    int     value   = (int)qdict_get_int(qdict, "value");

    if (channel < 0 || channel > 7) {
        monitor_printf(mon, "adc_set: channel must be 0-7\n");
        return;
    }
    if (value < 0 || value > 4095) {
        monitor_printf(mon, "adc_set: value must be 0-4095\n");
        return;
    }
    g_saradc->adc1_values[channel] = (uint16_t)value;
    monitor_printf(mon, "ADC1 ch%d = %d\n", channel, value);
}

/* ── Device init ─────────────────────────────────────────────────── */

static void esp32_saradc_realize(DeviceState *dev, Error **errp)
{
    Esp32SarAdcState *s = ESP32_SARADC(dev);
    SysBusDevice     *sbd = SYS_BUS_DEVICE(dev);

    memory_region_init_io(&s->iomem, OBJECT(dev), &esp32_saradc_ops,
                          s, TYPE_ESP32_SARADC, ESP32_SARADC_SIZE);
    sysbus_init_mmio(sbd, &s->iomem);

    /* Default ADC values: mid-scale */
    for (int i = 0; i < 8; i++) {
        s->adc1_values[i] = 2048;
    }
    s->selected_channel = 0;
    s->meas_start1_rw = 0;
    memset(s->regs, 0, sizeof(s->regs));
    g_saradc = s;
}

static void esp32_saradc_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    dc->realize = esp32_saradc_realize;
}

static const TypeInfo esp32_saradc_info = {
    .name          = TYPE_ESP32_SARADC,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(Esp32SarAdcState),
    .class_init    = esp32_saradc_class_init,
};

static void esp32_saradc_register_types(void)
{
    type_register_static(&esp32_saradc_info);
}

type_init(esp32_saradc_register_types)
