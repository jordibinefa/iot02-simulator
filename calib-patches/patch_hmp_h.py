#!/usr/bin/env python3
"""
patch_hmp_h.py — Afegeix declaracions HMP a hmp.h
Ús: python3 patch_hmp_h.py /path/to/include/monitor/hmp.h
"""
import sys

path = sys.argv[1]
text = open(path).read()

if 'hmp_oled_dump' in text:
    print(f"patch_hmp_h.py: ja present a {path}, s'omet")
    sys.exit(0)

decls = (
    'void hmp_oled_dump(Monitor *mon, const QDict *qdict);\n'
    'void hmp_bme_temp(Monitor *mon, const QDict *qdict);\n'
    'void hmp_bme_hum(Monitor *mon, const QDict *qdict);\n'
    'void hmp_bme_pres(Monitor *mon, const QDict *qdict);\n'
)

last_endif = text.rfind('#endif')
if last_endif == -1:
    result = text + '\n' + decls
else:
    result = text[:last_endif] + decls + '\n' + text[last_endif:]

open(path, 'w').write(result)
print(f"patch_hmp_h.py: {path} patched OK")
