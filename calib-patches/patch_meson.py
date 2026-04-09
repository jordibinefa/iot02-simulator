#!/usr/bin/env python3
"""
patch_meson.py — Afegeix ssd1306.c i bme280.c a hw/i2c/meson.build
Format calib: i2c_ss.add(when: 'CONFIG_xxx', if_true: files('xxx.c'))
"""
import sys

path = sys.argv[1]
text = open(path).read()

if 'ssd1306.c' in text:
    print("ssd1306.c ja present, s'omet")
    sys.exit(0)

# Inserir just desprès de la línia que afegeix esp32_i2c.c per CONFIG_XTENSA_ESP32
anchor = "i2c_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('esp32_i2c.c'))"
if anchor not in text:
    # Fallback: inserir al final, abans de system_ss.add_all
    anchor2 = "system_ss.add_all("
    if anchor2 in text:
        idx = text.find(anchor2)
        addition = (
            "i2c_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('ssd1306.c', 'bme280.c'))\n"
        )
        result = text[:idx] + addition + text[idx:]
        open(path, 'w').write(result)
        print("OK fallback: inserit abans de system_ss.add_all")
        sys.exit(0)
    # Últim recurs: afegir al final
    open(path, 'a').write(
        "\ni2c_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('ssd1306.c', 'bme280.c'))\n"
    )
    print("OK: afegit al final del fitxer")
    sys.exit(0)

addition = "\ni2c_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('ssd1306.c', 'bme280.c'))"
idx = text.find(anchor) + len(anchor)
result = text[:idx] + addition + text[idx:]
open(path, 'w').write(result)
print("OK: inserit despres de esp32_i2c.c")
