#!/usr/bin/env python3
"""
patch_hmp_hx.py — Afegeix comandes HMP per oled_dump, bme_temp/hum/pres, adc_set
Ús: python3 patch_hmp_hx.py /path/to/hmp-commands.hx
"""
import sys

path = sys.argv[1]
text = open(path).read()

if 'oled_dump' in text:
    print(f"patch_hmp_hx.py: ja present a {path}, s'omet")
    sys.exit(0)

addition = r"""
    {
        .name       = "oled_dump",
        .args_type  = "",
        .params     = "",
        .help       = "dump SSD1306 OLED framebuffer (1024 bytes hex)",
        .cmd        = hmp_oled_dump,
    },
SRST
``oled_dump``
  Dump SSD1306 OLED framebuffer as hex.
ERST

    {
        .name       = "bme_temp",
        .args_type  = "value:i",
        .params     = "value",
        .help       = "set BME280 temperature (value = degrees*100, e.g. 2250 = 22.50C)",
        .cmd        = hmp_bme_temp,
    },
SRST
``bme_temp`` *value*
  Set BME280 temperature. Value is degrees Celsius times 100.
ERST

    {
        .name       = "bme_hum",
        .args_type  = "value:i",
        .params     = "value",
        .help       = "set BME280 humidity (value = percent*100, e.g. 5500 = 55.00%)",
        .cmd        = hmp_bme_hum,
    },
SRST
``bme_hum`` *value*
  Set BME280 humidity. Value is %RH times 100.
ERST

    {
        .name       = "bme_pres",
        .args_type  = "value:i",
        .params     = "value",
        .help       = "set BME280 pressure (value = hPa*100, e.g. 101325 = 1013.25hPa)",
        .cmd        = hmp_bme_pres,
    },
SRST
``bme_pres`` *value*
  Set BME280 pressure. Value is hPa times 100.
ERST

    {
        .name       = "adc_set",
        .args_type  = "channel:i,value:i",
        .params     = "channel value",
        .help       = "set ESP32 ADC1 channel value (0-7, 0-4095)",
        .cmd        = hmp_adc_set,
    },
SRST
``adc_set`` *channel* *value*
  Set ESP32 ADC1 channel value (0-7, 0-4095).
ERST
"""

open(path, 'a').write(addition)
print(f"patch_hmp_hx.py: {path} patched OK")
