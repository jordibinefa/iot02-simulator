#!/usr/bin/env python3
"""
patch_esp32.py — Modifica esp32.c per usar bme280 i ssd1306.
Idempotent: si ja estan presents, no fa res.
"""
import re, sys

path = sys.argv[1]
text = open(path).read()

changed = False

# ── bme280 ──────────────────────────────────────────────────────
if '"bme280"' in text:
    print("patch_esp32.py: bme280 ja present, s'omet")
else:
    # Substituir les dues línies tmp_bme (tmp105 a 0x76)
    old = (r'([ \t]*I2CSlave\s*\*\s*tmp_bme\s*=\s*i2c_slave_create_simple'
           r'\s*\(\s*i2c_bus\s*,\s*"tmp105"\s*,\s*0x76\s*\)\s*;[^\n]*\n)'
           r'([^\n]*object_property_set_int[^\n]*tmp_bme[^\n]*\n)')
    result = re.sub(old, '    i2c_slave_create_simple(i2c_bus, "bme280", 0x76);\n', text)
    if result == text:
        # Fallback: substituir qualsevol tmp105 a 0x76
        result = re.sub(
            r'i2c_slave_create_simple\s*\(\s*i2c_bus\s*,\s*"tmp105"\s*,\s*0x76\s*\)',
            'i2c_slave_create_simple(i2c_bus, "bme280", 0x76)',
            text)
    if result == text:
        print("ERROR: no s'ha pogut patchar bme280", file=sys.stderr)
        sys.exit(1)
    text = result
    changed = True
    print("patch_esp32.py: bme280 patchat OK")

# ── ssd1306 ─────────────────────────────────────────────────────
if '"ssd1306"' in text:
    print("patch_esp32.py: ssd1306 ja present, s'omet")
else:
    result = re.sub(
        r'([ \t]*i2c_slave_create_simple\s*\(\s*i2c_bus\s*,\s*"mpu6050"\s*,\s*0x68\s*\)\s*;\n)',
        r'\1    i2c_slave_create_simple(i2c_bus, "ssd1306", 0x3C);\n',
        text)
    if result == text:
        print("ERROR: no s'ha pogut patchar ssd1306", file=sys.stderr)
        sys.exit(1)
    text = result
    changed = True
    print("patch_esp32.py: ssd1306 patchat OK")

if changed:
    open(path, 'w').write(text)

print("patch_esp32.py: fet")
