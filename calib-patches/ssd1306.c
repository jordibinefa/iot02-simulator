/*
 * SSD1306 OLED I2C slave for QEMU calib (ESP32 simulator)
 *
 * Implements horizontal addressing mode (MEMORYMODE=0x00), which is what
 * the ESP32 OLED library (SSD1306Wire / OLEDDisplay) uses:
 *
 *   Init sequence sends: MEMORYMODE(0x20) 0x00 → horizontal mode
 *   display() sends:
 *     COLUMNADDR(0x21) col_start col_end
 *     PAGEADDR(0x22)   page_start page_end
 *     Then N transactions of: 0x40 + 16 data bytes
 *     Data auto-advances: col++ → wrap to next page when col > col_end
 *
 * HMP command: oled_dump → emits framebuffer as single printf (no TCP frag)
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "hw/i2c/i2c.h"
#include "hw/qdev-properties.h"
#include "monitor/monitor.h"
#include "monitor/hmp.h"
#include "qapi/error.h"

#define TYPE_SSD1306 "ssd1306"
#define SSD1306_FB_SIZE 1024   /* 128 cols × 8 pages */
#define SSD1306_WIDTH   128
#define SSD1306_PAGES   8

typedef struct SSD1306State {
    I2CSlave parent_obj;

    uint8_t framebuffer[SSD1306_FB_SIZE];

    /* I2C transaction state */
    bool    control_received;  /* first byte of transaction received? */
    bool    is_data;           /* control byte was 0x40 (data stream) */

    /* Multi-byte command parser */
    uint8_t cmd_pending;       /* current command waiting for args */
    uint8_t cmd_args[2];       /* arguments collected */
    uint8_t cmd_arg_count;     /* how many args received so far */
    uint8_t cmd_args_needed;   /* how many args this command needs */

    /* Addressing (horizontal mode) */
    uint8_t col_start;
    uint8_t col_end;
    uint8_t page_start;
    uint8_t page_end;
    uint8_t cur_col;
    uint8_t cur_page;

    bool    display_on;
} SSD1306State;

OBJECT_DECLARE_SIMPLE_TYPE(SSD1306State, SSD1306)

static SSD1306State *g_ssd1306 = NULL;

/* ── Command handling ────────────────────────────────────────────── */

static void ssd1306_reset_addr(SSD1306State *s)
{
    s->cur_col  = s->col_start;
    s->cur_page = s->page_start;
}

static void ssd1306_handle_command(SSD1306State *s, uint8_t cmd)
{
    /* Multi-byte command: collect arguments */
    if (s->cmd_args_needed > 0) {
        s->cmd_args[s->cmd_arg_count++] = cmd;
        if (s->cmd_arg_count < s->cmd_args_needed) return;

        /* All args received — execute */
        switch (s->cmd_pending) {
        case 0x20:  /* MEMORYMODE: arg = mode (0=horizontal) */
            break;
        case 0x21:  /* COLUMNADDR: arg0=start, arg1=end */
            s->col_start = s->cmd_args[0] < SSD1306_WIDTH ? s->cmd_args[0] : 0;
            s->col_end   = s->cmd_args[1] < SSD1306_WIDTH ? s->cmd_args[1] : SSD1306_WIDTH - 1;
            ssd1306_reset_addr(s);
            break;
        case 0x22:  /* PAGEADDR: arg0=start, arg1=end */
            s->page_start = s->cmd_args[0] < SSD1306_PAGES ? s->cmd_args[0] : 0;
            s->page_end   = s->cmd_args[1] < SSD1306_PAGES ? s->cmd_args[1] : SSD1306_PAGES - 1;
            ssd1306_reset_addr(s);
            break;
        default:
            break;
        }
        s->cmd_pending    = 0;
        s->cmd_arg_count  = 0;
        s->cmd_args_needed = 0;
        return;
    }

    /* Single-byte or start of multi-byte command */
    switch (cmd) {
    case 0x20:  /* MEMORYMODE — needs 1 arg */
        s->cmd_pending     = cmd;
        s->cmd_args_needed = 1;
        s->cmd_arg_count   = 0;
        break;
    case 0x21:  /* COLUMNADDR — needs 2 args */
        s->cmd_pending     = cmd;
        s->cmd_args_needed = 2;
        s->cmd_arg_count   = 0;
        break;
    case 0x22:  /* PAGEADDR — needs 2 args */
        s->cmd_pending     = cmd;
        s->cmd_args_needed = 2;
        s->cmd_arg_count   = 0;
        break;
    case 0xAE:  s->display_on = false; break;
    case 0xAF:  s->display_on = true;  break;
    /* Page-address mode commands (ignored — we use horizontal mode) */
    /* Everything else silently ignored (charge pump, contrast, etc.) */
    default:
        break;
    }
}

/* ── Data write (horizontal addressing auto-advance) ─────────────── */

static void ssd1306_write_data(SSD1306State *s, uint8_t data)
{
    if (s->cur_page > s->page_end) return;  /* out of window */

    uint16_t idx = (uint16_t)s->cur_page * SSD1306_WIDTH + s->cur_col;
    if (idx < SSD1306_FB_SIZE) {
        s->framebuffer[idx] = data;
    }

    /* Auto-advance: col first, then page */
    s->cur_col++;
    if (s->cur_col > s->col_end) {
        s->cur_col = s->col_start;
        s->cur_page++;
    }
}

/* ── I2C slave callbacks ─────────────────────────────────────────── */

static int ssd1306_event(I2CSlave *slave, enum i2c_event event)
{
    SSD1306State *s = SSD1306(slave);
    switch (event) {
    case I2C_START_SEND:
        s->control_received = false;
        s->is_data          = false;
        break;
    case I2C_START_RECV:
        break;
    case I2C_FINISH:
        break;
    default:
        break;
    }
    return 0;
}

static int ssd1306_send(I2CSlave *slave, uint8_t data)
{
    SSD1306State *s = SSD1306(slave);

    if (!s->control_received) {
        /* First byte: control byte */
        s->control_received = true;
        s->is_data = (data == 0x40);
        return 0;
    }

    if (s->is_data) {
        ssd1306_write_data(s, data);
    } else {
        ssd1306_handle_command(s, data);
    }
    return 0;
}

static uint8_t ssd1306_recv(I2CSlave *slave)
{
    return 0;
}

/* ── HMP command: oled_dump ──────────────────────────────────────── */

void hmp_oled_dump(Monitor *mon, const QDict *qdict)
{
    if (!g_ssd1306) {
        monitor_printf(mon, "oled_dump: no SSD1306 device found\n");
        return;
    }
    /*
     * Single printf to avoid TCP fragmentation.
     * "OLED_FB_BEGIN\n" + 2048 hex chars + "\nOLED_FB_END\n"
     */
    char buf[2080];
    int pos = 0;
    static const char *hdr = "OLED_FB_BEGIN\n";
    for (const char *p = hdr; *p; ) buf[pos++] = *p++;

    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < SSD1306_FB_SIZE; i++) {
        uint8_t b = g_ssd1306->framebuffer[i];
        buf[pos++] = hex[(b >> 4) & 0xF];
        buf[pos++] = hex[b & 0xF];
    }
    static const char *ftr = "\nOLED_FB_END\n";
    for (const char *p = ftr; *p; ) buf[pos++] = *p++;
    buf[pos] = '\0';
    monitor_printf(mon, "%s", buf);
}

/* ── Device init ─────────────────────────────────────────────────── */

static void ssd1306_realize(DeviceState *dev, Error **errp)
{
    SSD1306State *s = SSD1306(dev);
    memset(s->framebuffer, 0, SSD1306_FB_SIZE);
    s->control_received = false;
    s->is_data          = false;
    s->cmd_pending      = 0;
    s->cmd_arg_count    = 0;
    s->cmd_args_needed  = 0;
    s->col_start        = 0;
    s->col_end          = SSD1306_WIDTH - 1;
    s->page_start       = 0;
    s->page_end         = SSD1306_PAGES - 1;
    s->cur_col          = 0;
    s->cur_page         = 0;
    s->display_on       = false;
    g_ssd1306 = s;
}

static void ssd1306_class_init(ObjectClass *klass, void *data)
{
    DeviceClass   *dc = DEVICE_CLASS(klass);
    I2CSlaveClass *sc = I2C_SLAVE_CLASS(klass);
    dc->realize = ssd1306_realize;
    sc->event   = ssd1306_event;
    sc->send    = ssd1306_send;
    sc->recv    = ssd1306_recv;
}

static const TypeInfo ssd1306_info = {
    .name          = TYPE_SSD1306,
    .parent        = TYPE_I2C_SLAVE,
    .instance_size = sizeof(SSD1306State),
    .class_init    = ssd1306_class_init,
};

static void ssd1306_register_types(void)
{
    type_register_static(&ssd1306_info);
}

type_init(ssd1306_register_types)
