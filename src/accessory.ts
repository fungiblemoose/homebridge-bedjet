import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BedJet } from './bedjet/BedJet';
import { OperatingMode } from './bedjet/constants';
import type { BedJetConfig, BedJetState, DefaultMode } from './bedjet/types';
import type { BedJetPlatform } from './platform';
import { sanitizeName } from './utils';

const DEFAULT_MODE_MAP: Record<DefaultMode, OperatingMode> = {
  heat:         OperatingMode.HEAT,
  turbo:        OperatingMode.TURBO,
  extendedHeat: OperatingMode.EXTENDED_HEAT,
  cool:         OperatingMode.COOL,
  dry:          OperatingMode.DRY,
};


// OperatingMode → CurrentHeatingCoolingState value
const CURRENT_STATE_MAP: Record<OperatingMode, number> = {
  [OperatingMode.STANDBY]:       0, // OFF
  [OperatingMode.HEAT]:          1, // HEAT
  [OperatingMode.TURBO]:         1, // HEAT
  [OperatingMode.EXTENDED_HEAT]: 1, // HEAT
  [OperatingMode.COOL]:          2, // COOL
  [OperatingMode.DRY]:           2, // COOL
  [OperatingMode.WAIT]:          0, // OFF
};

// TargetHeatingCoolingState value → OperatingMode
const TARGET_TO_MODE: Record<number, OperatingMode> = {
  0: OperatingMode.STANDBY,
  1: OperatingMode.HEAT,
  2: OperatingMode.COOL,
  3: OperatingMode.HEAT, // AUTO — fall back to heat
};

export class BedJetAccessory {
  private readonly thermostatService: Service;
  private readonly fanService: Service;
  private readonly ambientService: Service | null = null;
  private readonly turboService: Service | null = null;
  private readonly bedjet: BedJet;

  // Debounce handles for setter commands
  private tempDebounce: NodeJS.Timeout | null = null;
  private fanDebounce: NodeJS.Timeout | null = null;

  // Optimistic values — held after a set to suppress stale BLE notification bounces
  private pendingTemp: number | null = null;
  private pendingTempTimer: NodeJS.Timeout | null = null;
  private pendingFanSpeed: number | null = null;
  private pendingFanSpeedTimer: NodeJS.Timeout | null = null;
  private pendingMode: number | null = null;
  private pendingModeTimer: NodeJS.Timeout | null = null;

  private setPending<T>(
    value: T,
    store: 'pendingTemp' | 'pendingFanSpeed' | 'pendingMode',
    timer: 'pendingTempTimer' | 'pendingFanSpeedTimer' | 'pendingModeTimer',
    ms = 3000,
  ): void {
    if (this[timer]) {
      clearTimeout(this[timer] as NodeJS.Timeout);
    }
    (this as unknown as Record<string, unknown>)[store] = value;
    (this as unknown as Record<string, unknown>)[timer] = setTimeout(() => {
      (this as unknown as Record<string, unknown>)[store] = null;
    }, ms);
  }

  constructor(
    private readonly platform: BedJetPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: BedJetConfig,
  ) {
    const { Service, Characteristic } = platform.api.hap;
    const safeName = sanitizeName(config.name);

    // AccessoryInformation
    const infoService = this.accessory.getService(Service.AccessoryInformation)
      ?? this.accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'BedJet')
      .setCharacteristic(Characteristic.Model, 'BedJet 3')
      .setCharacteristic(Characteristic.SerialNumber, config.address);

    // Thermostat service
    this.thermostatService = this.accessory.getService(Service.Thermostat)
      ?? this.accessory.addService(Service.Thermostat, 'BedJet', 'thermostat');

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.bedjet.state.currentTemperature);

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 19, maxValue: 43, minStep: 0.5 })
      .onGet(() => this.pendingTemp ?? this.bedjet.state.targetTemperature)
      .onSet((value: CharacteristicValue) => {
        this.setPending(value as number, 'pendingTemp', 'pendingTempTimer');
        if (this.tempDebounce) {
          clearTimeout(this.tempDebounce);
        }
        this.tempDebounce = setTimeout(() => {
          this._applyTemperature(value as number).catch(err =>
            this.platform.log.error(`[${config.name}] setTemperature failed: ${err}`),
          );
        }, 100);
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => CURRENT_STATE_MAP[this.bedjet.state.operatingMode] ?? 0);

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => {
        const mode = this.bedjet.state.operatingMode;
        if (mode === OperatingMode.STANDBY || mode === OperatingMode.WAIT) return 0;
        if (mode === OperatingMode.COOL || mode === OperatingMode.DRY) return 2;
        return 1; // HEAT / TURBO / EXTENDED_HEAT
      })
      .onSet((value: CharacteristicValue) => {
        const val = value as number;
        const wasOff = this.bedjet.state.operatingMode === OperatingMode.STANDBY
          || this.bedjet.state.operatingMode === OperatingMode.WAIT;
        const turningOn = val !== 0;

        let mode: OperatingMode;
        if (val === 3 || (turningOn && wasOff)) {
          // Siri sends Auto (3) when turning on — and any turn-on from standby —
          // should respect the user's configured defaultMode.
          mode = config.defaultMode
            ? DEFAULT_MODE_MAP[config.defaultMode]
            : TARGET_TO_MODE[val] ?? OperatingMode.HEAT;
        } else {
          mode = TARGET_TO_MODE[val] ?? OperatingMode.STANDBY;
        }

        // Smart heat (opt-in): "Heat" means the longest-running heat mode for
        // the target temp. EXT_HT caps at 92°F but allows ~13h runs; HEAT above
        // that scales down (4h/2h/1h at 93–97/100/104°F) in firmware.
        if (config.smartHeat === true && (mode === OperatingMode.HEAT || mode === OperatingMode.EXTENDED_HEAT)) {
          const t = this.pendingTemp ?? this.bedjet.state.targetTemperature;
          mode = t <= 33.5 ? OperatingMode.EXTENDED_HEAT : OperatingMode.HEAT;
        }

        this._applyModeAndDefaults(mode, wasOff && turningOn).catch(err =>
          this.platform.log.error(`[${config.name}] setOperatingMode failed: ${err}`),
        );
      });

    // FanV2 service
    this.fanService = this.accessory.getService(Service.Fanv2)
      ?? this.accessory.addService(Service.Fanv2, 'BedJet Fan', 'fan');

    this.fanService.getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.bedjet.state.operatingMode !== OperatingMode.STANDBY
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet((value: CharacteristicValue) => {
        if (value === Characteristic.Active.INACTIVE) {
          this.setPending(0, 'pendingMode', 'pendingModeTimer');
          this.bedjet.setOperatingMode(OperatingMode.STANDBY).catch(err =>
            this.platform.log.error(`[${config.name}] setOperatingMode(STANDBY) failed: ${err}`),
          );
        } else if (this.bedjet.state.operatingMode === OperatingMode.STANDBY) {
          // Turning on — use configured default mode and apply all defaults
          const mode = this.config.defaultMode
            ? DEFAULT_MODE_MAP[this.config.defaultMode]
            : OperatingMode.HEAT;
          this._applyModeAndDefaults(mode, true).catch(err =>
            this.platform.log.error(`[${config.name}] turn on failed: ${err}`),
          );
        }
      });

    this.fanService.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 5, maxValue: 100, minStep: 5 })
      .onGet(() => this.pendingFanSpeed ?? this.bedjet.state.fanSpeed)
      .onSet((value: CharacteristicValue) => {
        this.setPending(value as number, 'pendingFanSpeed', 'pendingFanSpeedTimer');
        if (this.fanDebounce) {
          clearTimeout(this.fanDebounce);
        }
        this.fanDebounce = setTimeout(() => {
          this.bedjet.setFanSpeed(value as number).catch(err =>
            this.platform.log.error(`[${config.name}] setFanSpeed failed: ${err}`),
          );
        }, 100);
      });

    // Ambient temperature sensor (opt-in) — the unit reports bedside air temp
    if (config.exposeAmbientSensor === true) {
      this.ambientService = this.accessory.getServiceById(Service.TemperatureSensor, 'ambient')
        ?? this.accessory.addService(Service.TemperatureSensor, `${safeName} Ambient`, 'ambient');
      this.ambientService.getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(() => this.bedjet.state.ambientTemperature);
    }

    // Preheat switch (opt-in) — turbo mode; the unit time-limits it and the
    // tile follows the unit's actual state
    if (config.exposeTurboSwitch === true) {
      this.turboService = this.accessory.getServiceById(Service.Switch, 'turbo')
        ?? this.accessory.addService(Service.Switch, `${safeName} Preheat`, 'turbo');
      this.turboService.getCharacteristic(Characteristic.On)
        .onGet(() => this.bedjet.state.operatingMode === OperatingMode.TURBO)
        .onSet((value: CharacteristicValue) => {
          if (value) {
            this._applyModeAndDefaults(OperatingMode.TURBO, false).catch(err =>
              this.platform.log.error(`[${config.name}] preheat on failed: ${err}`),
            );
          } else if (this.bedjet.state.operatingMode === OperatingMode.TURBO) {
            this.bedjet.setOperatingMode(OperatingMode.STANDBY).catch(err =>
              this.platform.log.error(`[${config.name}] preheat off failed: ${err}`),
            );
          }
        });
    }

    // Create BLE client and wire up state change events
    this.bedjet = new BedJet(config, platform.log);

    this.bedjet.on('stateChange', (state: BedJetState) => this._syncHomeKit(state));
    this.bedjet.on('connected', () => {
      // Update FirmwareRevision once we have it
      const fw = this.bedjet.firmware;
      if (fw) {
        infoService.setCharacteristic(Characteristic.FirmwareRevision, fw);
      }
    });

    // Start connecting — errors are logged but don't crash Homebridge
    this.bedjet.connect().catch(err =>
      this.platform.log.error(`[${config.name}] Initial connect failed: ${err}`),
    );
  }

  /**
   * Apply a target temperature. With smart heat enabled, a temp change that
   * crosses the EXT_HT ceiling (92°F) switches between EXTENDED_HEAT and HEAT
   * first — heat modes remember separate targets, so the temp is sent after
   * the switch, and the mode change re-triggers the runtime top-up.
   */
  private async _applyTemperature(tempC: number): Promise<void> {
    const { config } = this;
    const cur = this.bedjet.state.operatingMode;
    const heatFamily = cur === OperatingMode.HEAT || cur === OperatingMode.EXTENDED_HEAT;
    if (config.smartHeat === true && heatFamily) {
      const desired = tempC <= 33.5 ? OperatingMode.EXTENDED_HEAT : OperatingMode.HEAT;
      if (desired !== cur) {
        this.platform.log.info(`[${config.name}] Smart heat: switching to ${desired === OperatingMode.EXTENDED_HEAT ? 'extended heat' : 'heat'} for ${Math.round(tempC * 9 / 5 + 32)}°F`);
        await this._applyModeAndDefaults(desired, false);
      }
    }
    await this.bedjet.setTemperature(tempC);
  }

  /**
   * Set the operating mode, then optionally apply default temperature and fan
   * speed from config. applyDefaults=true when turning on from off.
   * applyMode=true when the mode itself should come from defaultMode config
   * (fan turn-on path); false when HomeKit supplied the mode explicitly
   * (thermostat path).
   */
  private async _applyModeAndDefaults(
    mode: OperatingMode,
    applyDefaults: boolean,
  ): Promise<void> {
    const { config } = this;

    // Determine HomeKit target state for pending optimistic value
    const pendingState =
      mode === OperatingMode.STANDBY ? 0
        : mode === OperatingMode.COOL || mode === OperatingMode.DRY ? 2
          : 1;
    this.setPending(pendingState, 'pendingMode', 'pendingModeTimer', 5000);

    await this.bedjet.setOperatingMode(mode);

    if (applyDefaults) {
      if (config.defaultTemperature !== undefined) {
        // Config stores °F (values > 43 are unambiguously Fahrenheit).
        // Old configs stored °C (≤ 43) — leave those as-is for backward compat.
        let tempC = config.defaultTemperature;
        if (tempC > 43) {
          tempC = (tempC - 32) * 5 / 9;
        }
        // Clamp to BedJet V3 valid range 19–43 °C, rounded to nearest 0.5
        tempC = Math.max(19, Math.min(43, Math.round(tempC * 2) / 2));
        this.setPending(tempC, 'pendingTemp', 'pendingTempTimer', 5000);
        await this.bedjet.setTemperature(tempC);
      }
      if (config.defaultFanSpeed !== undefined) {
        this.setPending(config.defaultFanSpeed, 'pendingFanSpeed', 'pendingFanSpeedTimer', 5000);
        await this.bedjet.setFanSpeed(config.defaultFanSpeed);
      }
    }

    if (mode !== OperatingMode.STANDBY && config.defaultRuntimeHours !== undefined) {
      // Mode button presses reset the unit's countdown to its per-mode default
      // (e.g. 30 min for heat), so the runtime must be re-sent after every mode
      // change — not just on turn-on. The BedJet clamps mode-specific maximums
      // (turbo) itself.
      const total = Math.max(0.5, Math.min(12, config.defaultRuntimeHours));
      const hours = Math.floor(total);
      // 12h requests go out as 12h59 — EXT_HT's measured max; other modes
      // clamp down to their own caps.
      const minutes = total >= 12 ? 59 : Math.round((total - hours) * 60);
      await this.bedjet.setRuntimeRemaining(hours, minutes);
    }
  }

  private _syncHomeKit(state: BedJetState): void {
    const { Characteristic } = this.platform.api.hap;

    // Clamp helper — keeps values within the bounds HomeKit expects
    const clamp = (val: number, min: number, max: number) =>
      Math.min(max, Math.max(min, val));

    if (this.ambientService) {
      this.ambientService.updateCharacteristic(Characteristic.CurrentTemperature, clamp(state.ambientTemperature, -270, 100));
    }
    if (this.turboService) {
      this.turboService.updateCharacteristic(Characteristic.On, state.operatingMode === OperatingMode.TURBO);
    }

    // BedJet V3 fixed range: 66°F–109°F = 19–43°C
    const minTemp = 19;
    const maxTemp = 43;

    this.thermostatService.updateCharacteristic(
      Characteristic.CurrentTemperature,
      clamp(state.currentTemperature, -270, 100),
    );

    // Use pending (optimistic) values if set — suppresses stale BLE notification bounces
    const targetTemp = this.pendingTemp ?? clamp(state.targetTemperature, minTemp, maxTemp);
    const fanSpeed   = this.pendingFanSpeed ?? clamp(state.fanSpeed, 5, 100);

    const derivedTargetState =
      state.operatingMode === OperatingMode.STANDBY || state.operatingMode === OperatingMode.WAIT
        ? 0
        : state.operatingMode === OperatingMode.COOL || state.operatingMode === OperatingMode.DRY
          ? 2
          : 1;
    const targetState = this.pendingMode ?? derivedTargetState;

    this.thermostatService.updateCharacteristic(
      Characteristic.TargetTemperature,
      targetTemp,
    );

    this.thermostatService.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      CURRENT_STATE_MAP[state.operatingMode] ?? 0,
    );

    this.thermostatService.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      targetState,
    );

    this.fanService.updateCharacteristic(
      Characteristic.Active,
      targetState !== 0
        ? Characteristic.Active.ACTIVE
        : Characteristic.Active.INACTIVE,
    );

    this.fanService.updateCharacteristic(
      Characteristic.RotationSpeed,
      fanSpeed,
    );
  }
}
