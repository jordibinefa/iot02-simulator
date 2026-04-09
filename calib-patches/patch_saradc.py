#!/usr/bin/env python3
"""
patch_saradc.py — Integra esp32_saradc al build de calib.
"""
import re, sys, os, shutil

calib   = sys.argv[1]
patches = os.path.dirname(os.path.abspath(__file__))

# ── 1. Copiar esp32_saradc.c a hw/misc ───────────────────────────
dst = os.path.join(calib, 'hw/misc/esp32_saradc.c')
shutil.copy(os.path.join(patches, 'esp32_saradc.c'), dst)
print(f"Copiat {dst}")

# ── 2. hw/misc/meson.build ───────────────────────────────────────
# El bloc CONFIG_XTENSA_ESP32 és multilínia:
#   system_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files(
#     'xxx.c',
#     ...
#   ))                  ← inserir AQUÍ una nova línia independent
meson = os.path.join(calib, 'hw/misc/meson.build')
text  = open(meson).read()

if 'esp32_saradc' not in text:
    addition = "system_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('esp32_saradc.c'))\n"
    # Trobar el primer bloc CONFIG_XTENSA_ESP32 multilínia i inserir despres del seu ))
    # El patró és: system_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files(\n...\n))
    m = re.search(
        r"(system_ss\.add\(when:\s*'CONFIG_XTENSA_ESP32'.*?files\(.*?\)\))",
        text, re.DOTALL)
    if m:
        idx = m.end()
        text = text[:idx] + '\n' + addition + text[idx:]
        open(meson, 'w').write(text)
        print("hw/misc/meson.build: afegit despres del bloc multilinia")
    else:
        # Fallback: afegir al final
        text = text.rstrip() + '\n' + addition
        open(meson, 'w').write(text)
        print("hw/misc/meson.build: afegit al final (fallback)")
else:
    print("hw/misc/meson.build: ja present")

# ── 3. esp32.c: nova funció + crida ──────────────────────────────
esp32c = os.path.join(calib, 'hw/xtensa/esp32.c')
text   = open(esp32c).read()

if 'esp32-saradc' not in text:
    new_func = (
        '\nstatic void esp32_machine_init_saradc(void)\n'
        '{\n'
        '    DeviceState *dev = qdev_new("esp32-saradc");\n'
        '    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);\n'
        '    sysbus_mmio_map(SYS_BUS_DEVICE(dev), 0, 0x3FF48800);\n'
        '}\n'
    )
    anchor = 'static void esp32_machine_init_i2c('
    if anchor in text:
        text = text.replace(anchor, new_func + anchor, 1)
    else:
        text += new_func

    call = 'esp32_machine_init_i2c('
    if call in text:
        text = text.replace(call,
            'esp32_machine_init_saradc();\n    ' + call, 1)

    open(esp32c, 'w').write(text)
    print("esp32.c: afegit esp32_machine_init_saradc")
else:
    print("esp32.c: ja present")

# ── 4. hmp.h ─────────────────────────────────────────────────────
hmp_h = os.path.join(calib, 'include/monitor/hmp.h')
text  = open(hmp_h).read()
if 'hmp_adc_set' not in text:
    idx  = text.rfind('#endif')
    text = text[:idx] + 'void hmp_adc_set(Monitor *mon, const QDict *qdict);\n\n' + text[idx:]
    open(hmp_h, 'w').write(text)
    print("hmp.h: afegit")
else:
    print("hmp.h: ja present")

# ── 5. hmp-commands.hx ───────────────────────────────────────────
hx   = os.path.join(calib, 'hmp-commands.hx')
text = open(hx).read()
if 'adc_set' not in text:
    open(hx, 'a').write(
        '\n    {\n'
        '        .name       = "adc_set",\n'
        '        .args_type  = "channel:i,value:i",\n'
        '        .params     = "channel value",\n'
        '        .help       = "set ESP32 ADC1 channel value (0-7, 0-4095)",\n'
        '        .cmd        = hmp_adc_set,\n'
        '    },\n'
    )
    print("hmp-commands.hx: afegit")
else:
    print("hmp-commands.hx: ja present")

print("patch_saradc.py: fet")
