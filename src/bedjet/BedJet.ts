import { EventEmitter } from 'events';
import type { Logger } from 'homebridge';
import NodeBle = require('node-ble');
const { createBluetooth } = NodeBle;
import {
  BEDJET3_SERVICE_UUID,
  BEDJET3_STATUS_UUID,
  BEDJET3_NAME_UUID,
  BEDJET3_COMMAND_UUID,
  BEDJET3_NOTIFICATION_LENGTH,
  BEDJET3_STATUS_LENGTH,
  OperatingMode,
  BedJetCommand,
  BedJetButton,
  OPERATING_MODE_BUTTON_MAP,
} from './constants';

// Max delay between reconnect attempts (ms)
const MAX_RECONNECT_DELAY_MS = 60_000;
import type { BedJetConfig, BedJetState } from './types';
import { DEFAULT_STATE } from './types';

// node-ble uses BlueZ D-Bus — works alongside BlueZ without raw HCI conflicts.
// This mirrors how Python bleak / Home Assistant ha-bedjet connects.

export class BedJet extends EventEmitter {
  private _state: BedJetState = { ...DEFAULT_STATE };
  private deviceName: string | null = null;
  private firmwareVersion: string | null = null;

  private reconnectAttempts = 0;
  private connecting = false;
  private destroyed = false;

  private bleDestroy: (() => void) | null = null;
  private commandChar: NodeBle.GattCharacteristic | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BedJetConfig,
    private readonly log: Logger,
  ) {
    super();
  }

  get state(): BedJetState { return this._state; }
  get name(): string { return this.deviceName ?? this.config.name; }
  get firmware(): string | null { return this.firmwareVersion; }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connecting || this.destroyed) {
      return;
    }
    this.connecting = true;
    try {
      await this._doConnect();
    } catch (err) {
      this.log.error(`[${this.config.name}] Connect failed: ${err}`);
      this._scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async _doConnect(): Promise<void> {
    // Clean up any previous bluetooth instance
    if (this.bleDestroy) {
      try { this.bleDestroy(); } catch { /* ignore */ }
      this.bleDestroy = null;
    }

    const { bluetooth, destroy } = createBluetooth();
    this.bleDestroy = destroy;

    this.log.info(`[${this.config.name}] Getting Bluetooth adapter…`);
    const adapter = await bluetooth.defaultAdapter();

    if (!await adapter.isDiscovering()) {
      await adapter.startDiscovery();
    }

    const timeoutMs = (this.config.scanTimeout ?? 30) * 1000;
    this.log.info(`[${this.config.name}] Waiting for device ${this.config.address}…`);

    const device = await adapter.waitDevice(
      this.config.address.toUpperCase(),
      timeoutMs,
    );

    await adapter.stopDiscovery().catch(() => { /* ignore if already stopped */ });

    this.log.info(`[${this.config.name}] Connecting…`);
    await device.connect();
    this.log.info(`[${this.config.name}] Connected — getting GATT server…`);

    device.on('disconnect', () => {
      this.log.warn(`[${this.config.name}] Device disconnected`);
      this._onDisconnected();
    });

    const gatt = await device.gatt();
    this.log.info(`[${this.config.name}] Got GATT server — getting BedJet service…`);

    const service = await gatt.getPrimaryService(BEDJET3_SERVICE_UUID);
    this.log.info(`[${this.config.name}] Got service — getting characteristics…`);

    const statusChar = await service.getCharacteristic(BEDJET3_STATUS_UUID);
    this.commandChar  = await service.getCharacteristic(BEDJET3_COMMAND_UUID);

    this.log.info(`[${this.config.name}] Got characteristics — subscribing to notifications…`);
    await statusChar.startNotifications();
    statusChar.on('valuechanged', (buf: Buffer) => this._handleNotification(buf));

    this.log.info(`[${this.config.name}] Subscribed — reading initial state…`);

    // Read the 11-byte status characteristic directly
    try {
      const statusData = await statusChar.readValue();
      this._handleStatusRead(statusData);
    } catch (err) {
      this.log.warn(`[${this.config.name}] Could not read device status: ${err}`);
    }

    // Read device name
    try {
      const nameChar = await service.getCharacteristic(BEDJET3_NAME_UUID);
      const nameData = await nameChar.readValue();
      this.deviceName = nameData.toString('utf8').replace(/\0/g, '').trim();
      this.log.info(`[${this.config.name}] Device name: ${this.deviceName}`);
    } catch (err) {
      this.log.warn(`[${this.config.name}] Could not read device name: ${err}`);
    }

    this.reconnectAttempts = 0;
    this._state = { ...this._state, isConnected: true };
    this._resetStaleTimer();

    this.emit('connected');
    this.emit('stateChange', this._state);

    this.log.info(`[${this.config.name}] Ready`);
  }

  // ── Packet parsing ──────────────────────────────────────────────────────────

  private _handleNotification(data: Buffer): void {
    if (data.length !== BEDJET3_NOTIFICATION_LENGTH) {
      return;
    }
    this._state = {
      ...this._state,
      hoursRemaining:     data[4],
      minutesRemaining:   data[5],
      secondsRemaining:   data[6],
      currentTemperature: data[7] / 2,
      targetTemperature:  data[8] / 2,
      operatingMode:      data[9] as OperatingMode,
      fanSpeed:           (data[10] + 1) * 5,
      // bytes 13 & 14 are NOT min/max temps — don't parse them
      turboTimeSeconds:   (data[15] << 8) | data[16],
      ambientTemperature: data[17] / 2,
      isConnected:        true,
    };
    this._resetStaleTimer();
    this.emit('stateChange', this._state);
  }

  private _handleStatusRead(data: Buffer): void {
    if (data.length !== BEDJET3_STATUS_LENGTH) {
      return;
    }
    const flags = data[7];
    this._state = {
      ...this._state,
      isDualZone:       (data[2] & 0x02) !== 0,
      connTestPassed:   (flags & 0x20) !== 0,
      ledEnabled:       (flags & 0x10) !== 0,
      unitsSetup:       (flags & 0x04) !== 0,
      beepsMuted:       (flags & 0x01) !== 0,
      notificationCode: data[9],
    };
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  private async _sendCommand(command: BedJetCommand, ...args: number[]): Promise<void> {
    if (!this.commandChar) {
      // Kick off a reconnect attempt if one isn't already in progress
      if (!this.connecting && !this.destroyed) {
        this.log.info(`[${this.config.name}] Command issued while disconnected — reconnecting`);
        this.connect().catch(err =>
          this.log.error(`[${this.config.name}] Reconnect on command failed: ${err}`),
        );
      }
      throw new Error(`[${this.config.name}] Not connected`);
    }
    const buf = Buffer.from([command, ...args]);
    try {
      // writeValueWithResponse = write with response, required for BedJet V3
      await this.commandChar.writeValueWithResponse(buf);
    } catch (err) {
      this.log.error(`[${this.config.name}] Command 0x${command.toString(16)} failed: ${err}`);
      throw err;
    }
  }

  async setTemperature(celsius: number): Promise<void> {
    await this._sendCommand(BedJetCommand.SET_TEMPERATURE, Math.round(celsius * 2));
  }

  async setFanSpeed(percent: number): Promise<void> {
    const step = Math.max(0, Math.min(19, Math.round(percent / 5) - 1));
    await this._sendCommand(BedJetCommand.SET_FAN, step);
  }

  async setOperatingMode(mode: OperatingMode): Promise<void> {
    await this._sendCommand(BedJetCommand.BUTTON, OPERATING_MODE_BUTTON_MAP[mode]);
  }

  async pressButton(button: BedJetButton): Promise<void> {
    await this._sendCommand(BedJetCommand.BUTTON, button);
  }

  async setClock(hour: number, minute: number): Promise<void> {
    await this._sendCommand(BedJetCommand.SET_CLOCK, hour, minute);
  }

  async setRuntimeRemaining(hours: number, minutes: number): Promise<void> {
    await this._sendCommand(BedJetCommand.SET_RUNTIME, hours, minutes);
  }

  async setLed(on: boolean): Promise<void> {
    await this.pressButton(on ? BedJetButton.LED_ON : BedJetButton.LED_OFF);
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.pressButton(muted ? BedJetButton.MUTE : BedJetButton.UNMUTE);
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private _resetStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }
    this.staleTimer = setTimeout(() => {
      this.log.warn(`[${this.config.name}] No notification received — tearing down and reconnecting`);
      // Route through the same teardown as a BlueZ disconnect event. Marking
      // isConnected=false alone leaves a zombie: commandChar stays set, so
      // _sendCommand never triggers a reconnect and every command fails with
      // "DBusError: Not connected" until the process restarts.
      this._onDisconnected();
    }, 65_000);
  }

  // ── Disconnect / reconnect ──────────────────────────────────────────────────

  private _onDisconnected(): void {
    this.commandChar = null;

    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }

    this._state = { ...this._state, isConnected: false };
    this.emit('disconnected');
    this.emit('stateChange', this._state);

    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (this.destroyed) {
      return;
    }
    // Exponential backoff capped at MAX_RECONNECT_DELAY_MS — retries indefinitely
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, Math.pow(2, this.reconnectAttempts + 1) * 1000);
    // Cap the counter so the exponent doesn't grow forever
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.log.info(
      `[${this.config.name}] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => {
      this.connect().catch(err =>
        this.log.error(`[${this.config.name}] Reconnect failed: ${err}`),
      );
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.commandChar = null;

    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.bleDestroy) {
      try { this.bleDestroy(); } catch { /* ignore */ }
      this.bleDestroy = null;
    }
  }
}
