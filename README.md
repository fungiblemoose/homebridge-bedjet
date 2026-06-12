# homebridge-bedjet

DISCLAIMER - This project is entirely vibecoded. I don't have development experience.

Homebridge plugin for the **BedJet V3** climate comfort system via Bluetooth LE.

Exposes a **Thermostat** and a **Fan** accessory in HomeKit so you can control temperature and fan speed from the Home app, Siri, or automations — without needing the BedJet cloud or the BedJet mobile app running.

## Features

- Direct BLE connection from the Homebridge host — no cloud required
- Thermostat service: current/target temperature, heating/cooling mode
- FanV2 service: on/off and rotation speed (5–100%)
- Automatic reconnection with exponential backoff (retries indefinitely)
- Multi-device support for dual-zone BedJet setups
- Bluetooth discovery UI built into the Homebridge config panel — no need to find the MAC address manually

## Prerequisites

### Linux / Raspberry Pi (recommended)

```bash
# Install BlueZ
sudo apt-get install bluetooth bluez

# Make sure the Bluetooth service is running
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# Add the homebridge user to the bluetooth group so it can use BlueZ without root
sudo usermod -aG bluetooth homebridge

# Reboot (or restart Homebridge) for group membership to take effect
sudo reboot
```

Then pair your BedJet **once** before starting the plugin (see [Pairing your BedJet](#pairing-your-bedjet) below).

### macOS

Works out of the box. A CoreBluetooth permission prompt will appear on first run.

## Installation

Search for **homebridge-bedjet** in the Homebridge UI plugins tab and install from there.

Or via terminal:
```bash
npm install -g homebridge-bedjet
```

## Pairing your BedJet

The BedJet V3 requires a one-time Bluetooth pairing before the plugin can connect to it. You only need to do this once.

On your Raspberry Pi:

```bash
bluetoothctl
```

Then inside the bluetoothctl prompt:

```
scan on
```

Wait until you see your BedJet appear (it will show up as `BEDJET_V3` with its MAC address). Then:

```
pair   AA:BB:CC:DD:EE:FF
trust  AA:BB:CC:DD:EE:FF
disconnect AA:BB:CC:DD:EE:FF
exit
```

> **Note:** When you run `pair`, the BedJet will prompt you to press the **WiFi/BT button** on the top of the unit to confirm the pairing. Press it when prompted.

After pairing, restart Homebridge and the plugin will connect automatically.

## Configuration

The easiest way is to use the **Bluetooth Discovery** panel in the Homebridge plugin settings — click **Scan for BedJets**, wait ~12 seconds, then click **Add to Config** next to your device. Restart Homebridge when done.

To configure manually, add to your `~/.homebridge/config.json`:

```json
{
  "platforms": [
    {
      "platform": "BedJetPlatform",
      "devices": [
        {
          "name": "BedJet",
          "address": "AA:BB:CC:DD:EE:FF"
        }
      ]
    }
  ]
}
```

For a dual-zone setup, add both units:

```json
{
  "platforms": [
    {
      "platform": "BedJetPlatform",
      "devices": [
        { "name": "Left BedJet",  "address": "AA:BB:CC:DD:EE:FF" },
        { "name": "Right BedJet", "address": "11:22:33:44:55:66" }
      ]
    }
  ]
}
```

### Config options

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Display name in HomeKit |
| `address` | Yes | — | BLE MAC address of your BedJet V3 |
| `scanTimeout` | No | `30` | Seconds to wait for the device on connect |
| `defaultRuntimeHours` | No | — | Runtime (0.5–12 h) sent on every mode, temperature, or fan-speed adjustment, overriding the unit's per-mode default countdown (e.g. 30 min for heat). 12 requests the firmware max for the current mode/temperature. Leave blank to keep the BedJet's own defaults. |
| `smartHeat` | No | `false` | HomeKit "Heat" picks the longest-running heat mode for the target temp: Extended Heat for ≤92°F (~13 h max), regular Heat above (firmware caps ~4 h at 93–97°F, 2 h at 100°F, 1 h at 104°F). Crossing 92°F mid-run switches modes automatically. |

## Troubleshooting

### Plugin says "Connect failed" or never shows Ready

**1. Check Bluetooth is enabled and unblocked:**
```bash
# See all radio devices and whether they're blocked
rfkill list

# Unblock Bluetooth if it shows as blocked
sudo rfkill unblock bluetooth

# Check the adapter is up
hciconfig
```

**2. Make sure BlueZ is running:**
```bash
sudo systemctl status bluetooth

# If it's not running:
sudo systemctl enable bluetooth
sudo systemctl start bluetooth
```

**3. Check the homebridge user is in the bluetooth group:**
```bash
groups homebridge
# Should include "bluetooth" in the list
```

If it's missing:
```bash
sudo usermod -aG bluetooth homebridge
sudo reboot
```

**4. Make sure the BedJet is paired** (see [Pairing your BedJet](#pairing-your-bedjet) above). Without pairing, BlueZ can see the device during a scan but won't be able to connect to it and access GATT services.

**5. Close the BedJet mobile app** — the BedJet V3 only allows one BLE connection at a time. If the app is connected, this plugin cannot connect.

---

### Plugin connects but then disconnects frequently

This usually means BLE signal is weak. Move your Raspberry Pi closer to the BedJet, or add a USB Bluetooth adapter with better range.

---

### "Scan found 0 devices" in the discovery panel

- Make sure the BedJet is powered on and not already connected to your phone or the app
- The scan runs for 12 seconds — make sure you wait for it to finish
- Try running `bluetoothctl scan on` in a terminal on the Pi to confirm the Pi can see it

---

### Homebridge log shows D-Bus or permissions errors

The plugin uses the BlueZ D-Bus API (the same method used by Python's `bleak` library and the Home Assistant BedJet integration). If you see D-Bus permission errors, the homebridge user doesn't have access to BlueZ:

```bash
sudo usermod -aG bluetooth homebridge
sudo reboot
```

## HomeKit behaviour

| HomeKit control | BedJet action |
|---|---|
| Thermostat → Off | Standby |
| Thermostat → Heat | Standard heat mode |
| Thermostat → Cool | Fan-only cool mode |
| Thermostat → Auto | Heat mode |
| Temperature slider | Set target temperature |
| Fan → Off | Standby |
| Fan → On | Heat mode (if currently off) |
| Fan speed slider | Set fan speed (5–100% in 5% steps) |

## BedJet BLE limitation

The BedJet V3 only allows **one active BLE connection at a time**. Close the BedJet mobile app fully before using this plugin.

## Credits

The BedJet V3 BLE protocol details — service/characteristic UUIDs, notification packet layout, and command encoding — were derived from the [**pybedjet**](https://github.com/jfparis/pybedjet) library and the [Home Assistant BedJet integration](https://www.home-assistant.io/integrations/bedjet/). This plugin would not exist without that prior reverse-engineering work.

BLE communication uses [node-ble](https://github.com/chrvadala/node-ble), which wraps the Linux BlueZ D-Bus API — the same approach used by Python's `bleak` library and the HA integration.

## License

MIT
