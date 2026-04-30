# Setting up the Arduino IDE for the IoT-02 Simulator

This guide explains how to configure the Arduino IDE to compile sketches and generate binaries
compatible with the IoT-02 simulator, whether you are using a **local installation**
(`http://localhost:5555`) or the **online simulator** (`https://iot02sim.binefa.cat`).

---

## Prerequisites

- [Arduino IDE 2.x](https://www.arduino.cc/en/software) installed

---

## 1. Add the esp32 core version 3.0.7

The simulator requires exactly version **3.0.7** of the `esp32:esp32` core.

Open the Arduino IDE and go to **File → Preferences** (or **Arduino IDE → Preferences** on macOS).
In the **"Additional boards manager URLs"** field, add:

```
https://raw.githubusercontent.com/vishalsoniindia/Multi_ESP32_Package/refs/heads/main/package_multi_esp32_index.json
```

> If you already have other URLs, separate them with commas or click the icon to the right
> of the field to open the list editor.

Go to **Tools → Board → Boards Manager**, search for `esp32` and install version **3.0.7**
(it will appear as `esp32_board_0` or similar, depending on the URL added).

---

## 2. Add the IoT-02 board package

In the **"Additional boards manager URLs"** field in Preferences, also add:

```
https://iot02sim.binefa.cat/arduino/package_iot02_qemu_index.json
```

Go to the **Boards Manager**, search for `iot02` and install the package.

---

## 3. Select the board

Go to **Tools → Board → ESP32-QEMU (IoT-02 Simulator) → ESP32-QEMU (IoT-02 Simulator)**.

---

## 4. Compile and export the binary

With your sketch open, go to **Sketch → Export Compiled Binary**.

The Arduino IDE will compile the code and create a `build` folder next to the `.ino` file.
Inside `build/iot02.esp32.esp32qemu/` you will find a file ending in **`.merged.bin`**.
This is the binary you need to load into the simulator.

---

## 5. Load the binary into the simulator

### Option A — Local installation

1. Open `http://localhost:5555` in your browser.
2. Drag and drop the `.merged.bin` file onto the upload area, or click **"Choose file"**.
3. Press **"Compile / Upload"**.
4. Press **"Start QEMU"** to begin the simulation.
5. When finished, press **"Stop"** (there is a limit on concurrent sessions).

### Option B — Online simulator

1. Open `https://iot02sim.binefa.cat` in your browser.
2. Follow the same steps as Option A.

---

## MQTT connection (local installation)

With a local installation, the MQTT broker is directly accessible:

| Protocol | Address | Port |
|----------|---------|------|
| MQTT | `localhost` | `1883` |
| WebSockets | `localhost` | `9001` |

No username or password required. See the
[MQTT remote control](README.md#mqtt-remote-control) section for available topics.
