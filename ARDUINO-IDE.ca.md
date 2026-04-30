# Preparació de l'IDE d'Arduino per al simulador IoT-02

Aquesta guia explica com configurar l'IDE d'Arduino per compilar sketches i generar binaris
compatibles amb el simulador IoT-02, tant si fas servir la **instal·lació local**
(`http://localhost:5555`) com si fas servir el **simulador en línia**
(`https://iot02sim.binefa.cat`).

---

## Requisits previs

- [Arduino IDE 2.x](https://www.arduino.cc/en/software) instal·lat

---

## 1. Afegir el core esp32 versió 3.0.7

El simulador requereix exactament la versió **3.0.7** del core `esp32:esp32`.

Obre l'IDE d'Arduino i ves a **File → Preferences** (o **Arduino IDE → Preferences** a macOS).
Al camp **"Additional boards manager URLs"**, afegeix:

```
https://raw.githubusercontent.com/vishalsoniindia/Multi_ESP32_Package/refs/heads/main/package_multi_esp32_index.json
```

> Si ja tens altres URLs, separa-les amb comes o fes clic a la icona de la dreta del camp
> per obrir l'editor de llista.

Ves a **Tools → Board → Boards Manager**, cerca `esp32` i instal·la la versió **3.0.7**
(apareixerà com a `esp32_board_0` o similar, depenent de la URL afegida).

---

## 2. Afegir el board package IoT-02

Al camp **"Additional boards manager URLs"** de les Preferences, afegeix també:

```
https://iot02sim.binefa.cat/arduino/package_iot02_qemu_index.json
```

Ves al **Boards Manager**, cerca `iot02` i instal·la el package.

---

## 3. Seleccionar la placa

Ves a **Tools → Board → ESP32-QEMU (IoT-02 Simulator) → ESP32-QEMU (IoT-02 Simulator)**.

---

## 4. Compilar i exportar el binari

Amb el teu sketch obert, ves a **Sketch → Export Compiled Binary**.

Arduino IDE compilarà el codi i crearà una carpeta `build` al costat del fitxer `.ino`.
Dins de `build/iot02.esp32.esp32qemu/` trobaràs un fitxer acabat en **`.merged.bin`**.
Aquest és el binari que has de carregar al simulador.

---

## 5. Carregar el binari al simulador

### Opció A — Instal·lació local

1. Obre `http://localhost:5555` al navegador.
2. Arrossega el fitxer `.merged.bin` a la zona de càrrega, o fes clic a **"Tria fitxer"**.
3. Prem **"Compila / Carrega"**.
4. Prem **"Inicia QEMU"** per arrencar la simulació.
5. Quan acabis, prem **"Atura"** (hi ha un límit de sessions simultànies).

### Opció B — Simulador en línia

1. Obre `https://iot02sim.binefa.cat` al navegador.
2. Segueix els mateixos passos que a l'Opció A.

---

## Connexió MQTT (instal·lació local)

Amb la instal·lació local, el broker MQTT és accessible directament:

| Protocol | Adreça | Port |
|----------|--------|------|
| MQTT | `localhost` | `1883` |
| WebSockets | `localhost` | `9001` |

No cal usuari ni contrasenya. Consulta la secció
[Telecontrol MQTT](LLEGEIX-ME.md#telecontrol-mqtt) per als topics disponibles.
