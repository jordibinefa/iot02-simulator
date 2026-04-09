/*
 * BME280 environmental sensor I2C slave for QEMU calib (ESP32 simulator)
 *
 * Responds at address 0x76.
 * Register map (minimal):
 *   0xD0  chip_id  → 0x60
 *   0xF3  status   → 0x00 (not measuring)
 *   0xF4  ctrl_meas → r/w
 *   0xF5  config   → r/w
 *   0xF7-0xFC  raw ADC data (pressure + temperature)
 *   0xFD-0xFE  raw ADC data (humidity)
 *
 * Trimming coefficients (0x88-0x9F, 0xA1, 0xE1-0xE7) are pre-populated
 * with values that produce the configured temperature/pressure/humidity
 * when decoded by the standard BME280 compensation formulas.
 *
 * HMP command:
 *   bme_set temp <value>     (e.g. bme_set temp 22.5)
 *   bme_set hum  <value>     (e.g. bme_set hum  55.0)
 *   bme_set pres <value>     (e.g. bme_set pres 1013.25)
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "hw/i2c/i2c.h"
#include "hw/qdev-properties.h"
#include "monitor/monitor.h"
#include "monitor/hmp.h"
#include "qapi/error.h"
#include <math.h>

#define TYPE_BME280 "bme280"

/* ── Fixed trimming coefficients (from a real BME280 datasheet example) ── */
/* These give T=25°C, P=1013.25hPa, H=50% with the compensation formulas.  */
/* We pre-compute raw ADC values to match the configured physical values.    */

/* dig_T1..T3 */
#define DIG_T1  27504u
#define DIG_T2  26435
#define DIG_T3  -1000

/* dig_P1..P9 */
#define DIG_P1  36477u
#define DIG_P2  -10685
#define DIG_P3  3024
#define DIG_P4  2855
#define DIG_P5  140
#define DIG_P6  -7
#define DIG_P7  15500
#define DIG_P8  -14600
#define DIG_P9  6000

/* dig_H1..H6
 * DIG_H4=0, DIG_H5=0, DIG_H2=100 fan compensate_H quasi-lineal en [0,65535]
 * de manera que bme280_invert_H funcioni correctament en tot el rang 0-100%.
 * DIG_H4=312 i DIG_H2=370 originals feien la corba no-lineal i saturaven
 * a 100% per a valors adc_H > ~35000, impedint la inversió.
 */
#define DIG_H1  75u
#define DIG_H2  100
#define DIG_H3  0u
#define DIG_H4  0
#define DIG_H5  0
#define DIG_H6  30

typedef struct BME280State {
    I2CSlave parent_obj;

    /* Physical values (configurable) */
    double temp_c;   /* Celsius  */
    double hum_pct;  /* %RH      */
    double pres_hpa; /* hPa      */

    /* I2C state */
    bool    in_recv;
    uint8_t reg_ptr;
    bool    reg_ptr_set;

    /* Register file */
    uint8_t regs[256];
} BME280State;

OBJECT_DECLARE_SIMPLE_TYPE(BME280State, BME280)

static BME280State *g_bme280 = NULL;

/* ── BME280 compensation formulas (integer, from datasheet) ────────── */

static int32_t bme280_compensate_T(int32_t adc_T, int32_t *t_fine)
{
    int32_t var1, var2, T;
    var1 = ((((adc_T >> 3) - ((int32_t)DIG_T1 << 1))) * (int32_t)DIG_T2) >> 11;
    var2 = (((((adc_T >> 4) - (int32_t)DIG_T1) *
               ((adc_T >> 4) - (int32_t)DIG_T1)) >> 12) *
             (int32_t)DIG_T3) >> 14;
    *t_fine = var1 + var2;
    T = (*t_fine * 5 + 128) >> 8;
    return T;
}

static uint32_t bme280_compensate_P(int32_t adc_P, int32_t t_fine)
{
    int64_t var1, var2, p;
    var1 = (int64_t)t_fine - 128000;
    var2 = var1 * var1 * (int64_t)DIG_P6;
    var2 += (var1 * (int64_t)DIG_P5) << 17;
    var2 += ((int64_t)DIG_P4) << 35;
    var1 = ((var1 * var1 * (int64_t)DIG_P3) >> 8) +
           ((var1 * (int64_t)DIG_P2) << 12);
    var1 = ((((int64_t)1 << 47) + var1) * (int64_t)DIG_P1) >> 33;
    if (var1 == 0) return 0;
    p    = 1048576 - adc_P;
    p    = (((p << 31) - var2) * 3125) / var1;
    var1 = ((int64_t)DIG_P9 * (p >> 13) * (p >> 13)) >> 25;
    var2 = ((int64_t)DIG_P8 * p) >> 19;
    p    = ((p + var1 + var2) >> 8) + ((int64_t)DIG_P7 << 4);
    return (uint32_t)p;
}

static uint32_t bme280_compensate_H(int32_t adc_H, int32_t t_fine)
{
    int32_t v;
    v = t_fine - 76800;
    v = (((((adc_H << 14) - ((int32_t)DIG_H4 << 20) -
            ((int32_t)DIG_H5 * v)) + 16384) >> 15) *
         (((((((v * (int32_t)DIG_H6) >> 10) *
              (((v * (int32_t)DIG_H3) >> 11) + 32768)) >> 10) +
            2097152) * (int32_t)DIG_H2 + 8192) >> 14));
    v -= (((((v >> 15) * (v >> 15)) >> 7) * (int32_t)DIG_H1) >> 4);
    if (v < 0) v = 0;
    if (v > 419430400) v = 419430400;
    return (uint32_t)(v >> 12);
}

/*
 * Invert the compensation formulas to find the ADC raw value
 * that produces the desired physical output.
 */

static int32_t bme280_invert_T(double target_c)
{
    /*
     * Cerca binària: trobar adc_T (20-bit, rang [0, 2^20))
     * tal que compensate_T(adc_T) ≈ target_c * 100.
     *
     * L'Adafruit lib reconstrueix adc_T = (msb<<12)|(lsb<<4)|(xlsb>>4)
     * i crida compensate_T(adc_T) directament amb aquest valor de 20 bits.
     * Per tant la cerca és directa sobre el rang [0, 2^20) sense cap shift.
     */
    int32_t target = (int32_t)(target_c * 100.0);
    int32_t lo = 0, hi = (1 << 20) - 1, t_fine;
    for (int i = 0; i < 40; i++) {
        int32_t mid = (lo + hi) / 2;
        int32_t got = bme280_compensate_T(mid, &t_fine);
        if (got < target) lo = mid + 1;
        else              hi = mid;
    }
    return hi;
}

static int32_t bme280_invert_P(double target_hpa, int32_t t_fine)
{
    /*
     * compensate_P retorna Pa*256. La funció és DECREIXENT respecte adc_P:
     * adc_P petit → pressió alta, adc_P gran → pressió baixa.
     * Rang adc_P: 20 bits [0, 1048575] directes (no <<4).
     * La cerca binària ha d'anar en sentit invers (got > target → lo = mid+1).
     * Retornem 'hi' per convergència correcta.
     */
    uint32_t target = (uint32_t)(target_hpa * 100.0 * 256.0);
    int32_t lo = 0, hi = (1 << 20) - 1;
    for (int i = 0; i < 40; i++) {
        int32_t mid = (lo + hi) / 2;
        uint32_t got = bme280_compensate_P(mid, t_fine);
        if (got > target) lo = mid + 1;  /* P decreix → cercam cap amunt */
        else              hi = mid;
    }
    return hi;
}

static int32_t bme280_invert_H(double target_pct, int32_t t_fine)
{
    /*
     * compensate_H retorna v>>12 (uint32), on el màxim és 102400 (= 100%).
     * L'Adafruit lib divideix per 1024.0 per obtenir %RH.
     * Per tant: compensate_H / 1024.0 = %RH → compensate_H = %RH * 1024.
     *
     * target ha d'estar en les mateixes unitats que compensate_H:
     *   target = target_pct * 1024  (no target_pct/100 * 1024 * 1024!)
     *
     * Amb DIG_H4=0, DIG_H5=0, DIG_H2=100 la funció és quasi-lineal i creixent.
     * Rang adc_H: [0, 65535].
     */
    uint32_t target = (uint32_t)(target_pct * 1024.0);
    int32_t lo = 0, hi = (1 << 16) - 1;
    for (int i = 0; i < 40; i++) {
        int32_t mid = (lo + hi) / 2;
        uint32_t got = bme280_compensate_H(mid, t_fine);
        if (got < target) lo = mid + 1;
        else              hi = mid;
    }
    return hi;
}

/* ── Update raw ADC registers from physical values ───────────────── */

static void bme280_update_regs(BME280State *s)
{
    int32_t t_fine;

    /* Clamp values to sensor range */
    double tc  = s->temp_c;
    double rh  = s->hum_pct;
    double hpa = s->pres_hpa;
    if (tc  < -40.0)  tc  = -40.0;
    if (tc  > 85.0)   tc  =  85.0;
    if (rh  <  0.0)   rh  =   0.0;
    if (rh  > 100.0)  rh  = 100.0;
    if (hpa < 300.0)  hpa = 300.0;
    if (hpa > 1100.0) hpa = 1100.0;

    /*
     * Totes les funcions invert retornen valors ADC de 20 bits (T, P)
     * o 16 bits (H) directes — el que l'Adafruit lib reconstrueix
     * dels registres i passa a compensate_T/P/H.
     * Els registres guarden els 20 bits en format [19:12],[11:4],[3:0]<<4.
     */
    int32_t adc_T = bme280_invert_T(tc);
    bme280_compensate_T(adc_T, &t_fine);
    int32_t adc_P = bme280_invert_P(hpa, t_fine);
    int32_t adc_H = bme280_invert_H(rh, t_fine);

    /* Press raw: 0xF7 [19:12], 0xF8 [11:4], 0xF9 [3:0]<<4 */
    s->regs[0xF7] = (adc_P >> 12) & 0xFF;
    s->regs[0xF8] = (adc_P >>  4) & 0xFF;
    s->regs[0xF9] = (adc_P <<  4) & 0xF0;

    /* Temp raw: 0xFA [19:12], 0xFB [11:4], 0xFC [3:0]<<4 */
    s->regs[0xFA] = (adc_T >> 12) & 0xFF;
    s->regs[0xFB] = (adc_T >>  4) & 0xFF;
    s->regs[0xFC] = (adc_T <<  4) & 0xF0;

    /* Hum raw: 0xFD [15:8], 0xFE [7:0] */
    s->regs[0xFD] = (adc_H >> 8) & 0xFF;
    s->regs[0xFE] =  adc_H       & 0xFF;
}

/* ── Populate fixed registers ────────────────────────────────────── */

static void bme280_init_regs(BME280State *s)
{
    memset(s->regs, 0, 256);

    s->regs[0xD0] = 0x60;  /* chip_id */
    s->regs[0xF3] = 0x00;  /* status: not measuring */

    /* Trimming: T (0x88-0x8D) */
    s->regs[0x88] = DIG_T1 & 0xFF;
    s->regs[0x89] = (DIG_T1 >> 8) & 0xFF;
    s->regs[0x8A] = (int16_t)DIG_T2 & 0xFF;
    s->regs[0x8B] = ((int16_t)DIG_T2 >> 8) & 0xFF;
    s->regs[0x8C] = (int16_t)DIG_T3 & 0xFF;
    s->regs[0x8D] = ((int16_t)DIG_T3 >> 8) & 0xFF;

    /* Trimming: P (0x8E-0x9F) */
    uint16_t pvals[] = { DIG_P1, (uint16_t)(int16_t)DIG_P2,
                         (uint16_t)(int16_t)DIG_P3, (uint16_t)(int16_t)DIG_P4,
                         (uint16_t)(int16_t)DIG_P5, (uint16_t)(int16_t)DIG_P6,
                         (uint16_t)(int16_t)DIG_P7, (uint16_t)(int16_t)DIG_P8,
                         (uint16_t)(int16_t)DIG_P9 };
    for (int i = 0; i < 9; i++) {
        s->regs[0x8E + i*2]     = pvals[i] & 0xFF;
        s->regs[0x8E + i*2 + 1] = (pvals[i] >> 8) & 0xFF;
    }

    /* Trimming: H */
    s->regs[0xA1] = DIG_H1;
    s->regs[0xE1] = (int16_t)DIG_H2 & 0xFF;
    s->regs[0xE2] = ((int16_t)DIG_H2 >> 8) & 0xFF;
    s->regs[0xE3] = DIG_H3;
    /* H4 = [E4][7:4] | [E5][3:0] */
    s->regs[0xE4] = ((int16_t)DIG_H4 >> 4) & 0xFF;
    s->regs[0xE5] = (DIG_H4 & 0x0F) | (((int16_t)DIG_H5 & 0x0F) << 4);
    s->regs[0xE6] = ((int16_t)DIG_H5 >> 4) & 0xFF;
    s->regs[0xE7] = (int8_t)DIG_H6;
}

/* ── I2C slave callbacks ─────────────────────────────────────────── */

static int bme280_event(I2CSlave *slave, enum i2c_event event)
{
    BME280State *s = BME280(slave);
    switch (event) {
    case I2C_START_SEND:
        s->reg_ptr_set = false;
        s->in_recv     = false;
        break;
    case I2C_START_RECV:
        s->in_recv = true;
        break;
    case I2C_FINISH:
        break;
    default:
        break;
    }
    return 0;
}

static int bme280_send(I2CSlave *slave, uint8_t data)
{
    BME280State *s = BME280(slave);
    if (!s->reg_ptr_set) {
        s->reg_ptr     = data;
        s->reg_ptr_set = true;
    } else {
        /* Write: only writable regs (ctrl_meas, config) */
        s->regs[s->reg_ptr] = data;
        s->reg_ptr++;
    }
    return 0;
}

static uint8_t bme280_recv(I2CSlave *slave)
{
    BME280State *s = BME280(slave);
    uint8_t val = s->regs[s->reg_ptr];
    s->reg_ptr++;
    return val;
}

/* ── HMP commands: bme_temp / bme_hum / bme_pres ─────────────────── */
/* Usen un sol argument enter per evitar problemes amb el parser HMP   */
/* de calib que no suporta bé el tipus 's'.                            */
/* bme_temp: el backend envia (graus+40)*100 per evitar negatius.      */
/*   Exemple: bme_temp 6250 → (6250/100) - 40 = 22.50°C              */
/* bme_hum:  el backend envia %RH*100.   bme_hum 5500 → 55.00%       */
/* bme_pres: el backend envia hPa*100.   bme_pres 101325 → 1013.25   */

void hmp_bme_temp(Monitor *mon, const QDict *qdict)
{
    if (!g_bme280) {
        monitor_printf(mon, "bme_temp: no BME280 device found\n");
        return;
    }
    int64_t val = qdict_get_int(qdict, "value");
    g_bme280->temp_c = (val / 100.0) - 40.0;
    monitor_printf(mon, "BME280: temp=%.2f C\n", g_bme280->temp_c);
    bme280_update_regs(g_bme280);
}

void hmp_bme_hum(Monitor *mon, const QDict *qdict)
{
    if (!g_bme280) {
        monitor_printf(mon, "bme_hum: no BME280 device found\n");
        return;
    }
    int64_t val = qdict_get_int(qdict, "value");
    g_bme280->hum_pct = val / 100.0;
    monitor_printf(mon, "BME280: hum=%.1f %%\n", g_bme280->hum_pct);
    bme280_update_regs(g_bme280);
}

void hmp_bme_pres(Monitor *mon, const QDict *qdict)
{
    if (!g_bme280) {
        monitor_printf(mon, "bme_pres: no BME280 device found\n");
        return;
    }
    int64_t val = qdict_get_int(qdict, "value");
    g_bme280->pres_hpa = val / 100.0;
    monitor_printf(mon, "BME280: pres=%.2f hPa\n", g_bme280->pres_hpa);
    bme280_update_regs(g_bme280);
}

/* ── Device init ─────────────────────────────────────────────────── */

static void bme280_realize(DeviceState *dev, Error **errp)
{
    BME280State *s = BME280(dev);
    s->temp_c   = 25.0;
    s->hum_pct  = 50.0;
    s->pres_hpa = 1013.25;
    bme280_init_regs(s);
    bme280_update_regs(s);
    g_bme280 = s;
}

static void bme280_class_init(ObjectClass *klass, void *data)
{
    DeviceClass   *dc = DEVICE_CLASS(klass);
    I2CSlaveClass *sc = I2C_SLAVE_CLASS(klass);

    dc->realize = bme280_realize;
    sc->event   = bme280_event;
    sc->send    = bme280_send;
    sc->recv    = bme280_recv;
}

static const TypeInfo bme280_info = {
    .name          = TYPE_BME280,
    .parent        = TYPE_I2C_SLAVE,
    .instance_size = sizeof(BME280State),
    .class_init    = bme280_class_init,
};

static void bme280_register_types(void)
{
    type_register_static(&bme280_info);
}

type_init(bme280_register_types)
