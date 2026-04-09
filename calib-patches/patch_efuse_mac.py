#!/usr/bin/env python3
import sys, os

calib_dir = sys.argv[1]

MAC_CODE = '''
    /* Reinjectar MAC des de variable d entorn QEMU_ESP32_MAC */
    {
        const char *mac_src = s->mac_str ? s->mac_str : getenv("QEMU_ESP32_MAC");
        if (mac_src && strlen(mac_src) == 12) {
            uint8_t b[6];
            int i, ok = 1;
            for (i = 0; i < 6; i++) {
                char hex[3] = { mac_src[i*2], mac_src[i*2+1], 0 };
                char *end;
                b[i] = (uint8_t)strtoul(hex, &end, 16);
                if (end != hex + 2) { ok = 0; break; }
            }
            if (ok) {
                s->efuse_rd.blk1[0] = b[0] | (b[1]<<8) | (b[2]<<16) | ((uint32_t)b[3]<<24);
                s->efuse_rd.blk1[1] = b[4] | (b[5]<<8);
                fprintf(stderr, "[EFUSE] MAC: %02X:%02X:%02X:%02X:%02X:%02X\\n",
                    b[0],b[1],b[2],b[3],b[4],b[5]);
            }
        }
    }'''

# ── 1. esp32_efuse.h — afegir char *mac_str ──
h_path = os.path.join(calib_dir, 'include/hw/nvram/esp32_efuse.h')
with open(h_path) as f:
    h = f.read()
old = '    uint32_t dac_conf_reg;\n} Esp32EfuseState;'
new = '    uint32_t dac_conf_reg;\n    char *mac_str;\n} Esp32EfuseState;'
assert old in h, 'esp32_efuse.h: anchor not found'
h = h.replace(old, new, 1)
with open(h_path, 'w') as f:
    f.write(h)
print('esp32_efuse.h: mac_str afegit')

# ── 2. esp32_efuse.c — DEFINE_PROP_STRING + MAC a reset_hold ──
c_path = os.path.join(calib_dir, 'hw/nvram/esp32_efuse.c')
with open(c_path) as f:
    c = f.read()

# Afegir DEFINE_PROP_STRING
old = 'static Property esp32_efuse_properties[] = {\n    DEFINE_PROP_DRIVE("drive", Esp32EfuseState, blk),\n    DEFINE_PROP_END_OF_LIST(),\n};'
new = 'static Property esp32_efuse_properties[] = {\n    DEFINE_PROP_DRIVE("drive", Esp32EfuseState, blk),\n    DEFINE_PROP_STRING("mac", Esp32EfuseState, mac_str),\n    DEFINE_PROP_END_OF_LIST(),\n};'
assert old in c, 'esp32_efuse.c: properties anchor not found'
c = c.replace(old, new, 1)

# Afegir MAC a reset_hold després de esp32_efuse_read_op
old = 'static void esp32_efuse_reset_hold(Object *obj, ResetType type)\n{\n    Esp32EfuseState *s = ESP32_EFUSE(obj);\n    esp32_efuse_read_op(s);\n}'
new = 'static void esp32_efuse_reset_hold(Object *obj, ResetType type)\n{\n    Esp32EfuseState *s = ESP32_EFUSE(obj);\n    esp32_efuse_read_op(s);' + MAC_CODE + '\n}'
assert old in c, 'esp32_efuse.c: reset_hold anchor not found'
c = c.replace(old, new, 1)

with open(c_path, 'w') as f:
    f.write(c)
print('esp32_efuse.c: MAC a reset_hold afegit')

# ── 3. esp32_efuse.c — substituir hardcoded MAC per getenv ──
# (s'afegeix al mateix fitxer c_path)
with open(c_path) as f:
    c = f.read()

old = '    if(addr==4) r= 0x00c40a24;//0xC4000110;\n    if(addr==8) r= 0xfe1001;//0xfe240A;'
new = '''    /* MAC configurable via QEMU_ESP32_MAC */
    if (addr == 4 || addr == 8) {
        const char *mac_src = s->mac_str ? s->mac_str : getenv("QEMU_ESP32_MAC");
        if (mac_src && strlen(mac_src) == 12) {
            uint8_t b[6];
            int i, ok = 1;
            for (i = 0; i < 6; i++) {
                char hex[3] = { mac_src[i*2], mac_src[i*2+1], 0 };
                char *end;
                b[i] = (uint8_t)strtoul(hex, &end, 16);
                if (end != hex + 2) { ok = 0; break; }
            }
            if (ok) {
                /* MAC en ordre invers, CRC crc8_le sobre bytes invertits */
                uint8_t inv[6] = {b[5],b[4],b[3],b[2],b[1],b[0]};
                uint8_t crc = 0;
                int j2;
                for (j2 = 0; j2 < 6; j2++) {
                    int k2;
                    crc ^= b[j2];
                    for (k2 = 0; k2 < 8; k2++) {
                        if (crc & 1) crc = (crc >> 1) ^ 0x8C;
                        else crc >>= 1;
                    }
                }
                if (addr == 4) r = inv[0] | (inv[1]<<8) | (inv[2]<<16) | ((uint32_t)inv[3]<<24);
                if (addr == 8) r = inv[4] | (inv[5]<<8) | ((uint32_t)crc<<16);
            }
        } else {
            if (addr == 4) r = 0x00c40a24;
            if (addr == 8) r = 0xfe1001;
        }
    }'''
assert old in c, 'esp32_efuse.c: hardcoded MAC anchor not found'
c = c.replace(old, new, 1)
with open(c_path, 'w') as f:
    f.write(c)
print('esp32_efuse.c: hardcoded MAC substituïda per getenv')
