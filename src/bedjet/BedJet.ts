import { EventEmitter } from 'events';
import type { Logger } from 'homebridge';
import NodeBle = require('node-ble');
const { createBluetooth } = NodeBle;
import { Variant } from 'dbus-next';

// A connection that drops within this window of going Ready counts as
// "short-lived"; this many in a row means the BlueZ controller is flapping and
// needs a power-cycle, not just another reconnect.
const SHORT_LIVED_MS = 15_000;
const FLAP_THRESHOLD = 3;
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
  private writeQueue: Promise<void> | null = null;

  private lastReadyAt = 0;
  private shortLivedCount = 0;
  private powerCycleNext = false;

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

    // If the controller was flapping, power-cycle it before trying again — a
    // plain reconnect onto a wedged controller just flaps again.
    if (this.powerCycleNext) {
      this.powerCycleNext = false;
      await this._powerCycleAdapter(adapter);
    }

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
    this.lastReadyAt = Date.now();
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
    // Serialize writes — BlueZ rejects overlapping GATT operations with
    // "In Progress", which silently dropped user commands (e.g. a fan-speed
    // set racing a runtime write). Retry transient busy errors with backoff.
    const run = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        if (!this.commandChar) {
          throw new Error(`[${this.config.name}] Not connected`);
        }
        try {
          // writeValueWithResponse = write with response, required for BedJet V3
          await this.commandChar.writeValueWithResponse(buf);
          return;
        } catch (err) {
          if (attempt < 4 && String(err).includes('In Progress')) {
            await new Promise(resolve => setTimeout(resolve, 300 * attempt));
            continue;
          }
          this.log.error(`[${this.config.name}] Command 0x${command.toString(16)} failed: ${err}`);
          throw err;
        }
      }
    };
    this.writeQueue = (this.writeQueue ?? Promise.resolve()).then(run, run);
    return this.writeQueue;
  }

  async setTemperature(celsius: number): Promise<void> {
    await this._sendCommand(BedJetCommand.SET_TEMPERATURE, Math.round(celsius * 2));
    await this._maybeExtendRuntime();
  }

  async setFanSpeed(percent: number): Promise<void> {
    const step = Math.max(0, Math.min(19, Math.round(percent / 5) - 1));
    await this._sendCommand(BedJetCommand.SET_FAN, step);
    await this._maybeExtendRuntime();
  }

  // Adjustments don't reset the unit's countdown on their own — top it up so any
  // interaction keeps the run going for the configured runtime.
  private async _maybeExtendRuntime(): Promise<void> {
    if (this.config.defaultRuntimeHours === undefined) {
      return;
    }
    const mode = this._state.operatingMode;
    if (mode === OperatingMode.STANDBY || mode === OperatingMode.WAIT) {
      return;
    }
    const total = Math.max(0.5, Math.min(12, this.config.defaultRuntimeHours));
    const hours = Math.floor(total);
    // 12h requests go out as 12h59 — EXT_HT's measured max; other modes clamp
    // down to their own caps.
    const minutes = total >= 12 ? 59 : Math.round((total - hours) * 60);
    await this.setRuntimeRemaining(hours, minutes);
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
    // The firmware silently drops SET_RUNTIME it doesn't accept, and clamps it
    // to a mode/temperature-dependent maximum (measured on a V3: cool 12h, heat
    // at a high target temp 4h) — verify against the unit's own notifications
    // rather than fire-and-forget. Success = countdown reached the request,
    // rose past the pre-send baseline, or is stable across two attempts (the
    // unit's hard cap).
    const requested = hours * 60 + minutes;
    const baseline = this._state.hoursRemaining * 60 + this._state.minutesRemaining;
    const fmtState = () => `${this._state.hoursRemaining}h${String(this._state.minutesRemaining).padStart(2, '0')}m`;
    let prevGot = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this._sendCommand(BedJetCommand.SET_RUNTIME, hours, minutes);
      let got = 0;
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        got = this._state.hoursRemaining * 60 + this._state.minutesRemaining;
        if (got >= requested - 5) {
          this.log.info(`[${this.config.name}] Runtime confirmed: ${fmtState()}`);
          return;
        }
        if (got > baseline + 5) {
          this.log.info(`[${this.config.name}] Runtime set: ${fmtState()} (unit max for current mode/temp; requested ${hours}h${String(minutes).padStart(2, '0')}m)`);
          return;
        }
      }
      // Same readback twice in a row = the unit's hard cap, not a dropped
      // command. (Baseline can be stale right after a mode switch, so the
      // baseline check alone can't tell these apart.)
      if (prevGot >= 0 && Math.abs(got - prevGot) <= 6) {
        this.log.info(`[${this.config.name}] Runtime set: ${fmtState()} (unit max for current mode/temp; requested ${hours}h${String(minutes).padStart(2, '0')}m)`);
        return;
      }
      prevGot = got;
      this.log.warn(`[${this.config.name}] Runtime ${hours}h${minutes}m not confirmed (unit reports ${fmtState()}), attempt ${attempt}/3`);
    }
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
      this.log.warn(`[${this.config.name}] No notification received — marking disconnected`);
      this._state = { ...this._state, isConnected: false };
      this.emit('stateChange', this._state);
    }, 65_000);
  }

  // ── Disconnect / reconnect ──────────────────────────────────────────────────

  private _onDisconnected(): void {
    this.commandChar = null;

    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }

    // Flap detection: a connection that dies almost immediately after going
    // Ready, repeatedly, means the controller is wedged. After a few in a row,
    // ask the next reconnect to power-cycle the adapter.
    if (this.lastReadyAt > 0 && Date.now() - this.lastReadyAt < SHORT_LIVED_MS) {
      this.shortLivedCount++;
      if (this.shortLivedCount >= FLAP_THRESHOLD) {
        this.log.warn(`[${this.config.name}] Connection flapping (${this.shortLivedCount} short-lived sessions) — will power-cycle the adapter on next reconnect`);
        this.powerCycleNext = true;
        this.shortLivedCount = 0;
      }
    } else {
      this.shortLivedCount = 0;
    }
    this.lastReadyAt = 0;

    this._state = { ...this._state, isConnected: false };
    this.emit('disconnected');
    this.emit('stateChange', this._state);

    this._scheduleReconnect();
  }

  // Toggle the controller's Powered property off/on via BlueZ. node-ble has no
  // setter, so this reaches the writable D-Bus property through its helper;
  // fully defensive so an internals change degrades to a plain reconnect.
  private async _powerCycleAdapter(adapter: NodeBle.Adapter): Promise<void> {
    const helper = (adapter as unknown as { helper?: { set(prop: string, value: Variant): Promise<void> } }).helper;
    if (!helper || typeof helper.set !== 'function') {
      this.log.warn(`[${this.config.name}] Cannot power-cycle adapter (node-ble internals unavailable); reconnecting normally`);
      return;
    }
    try {
      this.log.info(`[${this.config.name}] Power-cycling Bluetooth adapter…`);
      await helper.set('Powered', new Variant('b', false));
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await helper.set('Powered', new Variant('b', true));
      await new Promise(resolve => setTimeout(resolve, 2_000));
      this.log.info(`[${this.config.name}] Adapter power-cycled`);
    } catch (err) {
      this.log.warn(`[${this.config.name}] Adapter power-cycle failed (${err}); reconnecting normally`);
    }
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
