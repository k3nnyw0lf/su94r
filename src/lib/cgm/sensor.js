// ═══════════════════════════════════════════════════════════════════════════
// Sensor age and warm-up tracking.
//
// A CGM sensor is least accurate in its first hours and again as it approaches
// expiry. su94r previously had no idea how old the sensor was, so day-one
// readings — the least trustworthy data the app ever sees — were fed into the
// correlation engine and time-in-range with the same weight as everything else.
//
// The concept is borrowed from Nightscout's device-age plugins, which track
// sensor, cannula, insulin and battery age. The implementation here is
// independent: Nightscout is AGPL-3.0 and su94r is MIT.
//
// Warm-up durations are the manufacturers' own published figures.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wear time and warm-up per sensor family, in hours.
 * `warnAt` is when to start reminding the user to have a replacement ready.
 */
export const SENSOR_SPECS = {
  'libre3': { label: 'FreeStyle Libre 3 / 3+', wearHours: 15 * 24, warmupHours: 1, warnAtHours: 13 * 24 },
  'libre2': { label: 'FreeStyle Libre 2', wearHours: 14 * 24, warmupHours: 1, warnAtHours: 12 * 24 },
  'dexcom-g7': { label: 'Dexcom G7', wearHours: 10 * 24, warmupHours: 0.5, warnAtHours: 9 * 24 },
  'dexcom-g6': { label: 'Dexcom G6', wearHours: 10 * 24, warmupHours: 2, warnAtHours: 9 * 24 },
  'stelo': { label: 'Dexcom Stelo', wearHours: 15 * 24, warmupHours: 0.5, warnAtHours: 13 * 24 },
  'other': { label: 'Other CGM', wearHours: 14 * 24, warmupHours: 1, warnAtHours: 12 * 24 },
};

export const SENSOR_STATE = {
  NONE: 'none',
  WARMUP: 'warmup',
  ACTIVE: 'active',
  ENDING: 'ending',
  EXPIRED: 'expired',
};

/**
 * Current state of the sensor.
 *
 * @param {object} sensor  { startedAt, type }
 * @param {object} [opts]  { now }
 */
export function sensorStatus(sensor, { now = Date.now() } = {}) {
  if (!sensor?.startedAt) {
    return { state: SENSOR_STATE.NONE, label: 'No sensor logged', inWarmup: false, hoursWorn: null };
  }

  const spec = SENSOR_SPECS[sensor.type] || SENSOR_SPECS.other;
  const started = new Date(sensor.startedAt).getTime();
  if (!Number.isFinite(started)) {
    return { state: SENSOR_STATE.NONE, label: 'Sensor start time unreadable', inWarmup: false, hoursWorn: null };
  }

  const hoursWorn = (now - started) / 3_600_000;
  const hoursLeft = spec.wearHours - hoursWorn;
  const common = {
    spec,
    hoursWorn: Math.max(0, Math.round(hoursWorn * 10) / 10),
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    daysWorn: Math.floor(Math.max(0, hoursWorn) / 24),
  };

  if (hoursWorn < 0) {
    return { ...common, state: SENSOR_STATE.NONE, label: 'Start time is in the future', inWarmup: false };
  }

  if (hoursWorn < spec.warmupHours) {
    const mins = Math.ceil((spec.warmupHours - hoursWorn) * 60);
    return {
      ...common,
      state: SENSOR_STATE.WARMUP,
      inWarmup: true,
      label: `Warming up — ${mins} min left`,
      detail:
        'Readings during warm-up are often well off. su94r shows them but leaves ' +
        'them out of time-in-range and the exercise analysis.',
    };
  }

  if (hoursLeft <= 0) {
    return {
      ...common,
      state: SENSOR_STATE.EXPIRED,
      inWarmup: false,
      label: `Expired ${Math.abs(Math.round(hoursLeft))}h ago`,
      detail: 'This sensor is past its wear time. Readings may have stopped or drifted.',
    };
  }

  if (hoursWorn >= spec.warnAtHours) {
    return {
      ...common,
      state: SENSOR_STATE.ENDING,
      inWarmup: false,
      label: `${Math.round(hoursLeft / 24 * 10) / 10} days left`,
      detail: 'Have a replacement ready. Accuracy can drift in the final day.',
    };
  }

  return {
    ...common,
    state: SENSOR_STATE.ACTIVE,
    inWarmup: false,
    label: `Day ${common.daysWorn + 1} of ${Math.round(spec.wearHours / 24)}`,
  };
}

/**
 * True when a given timestamp fell inside any logged sensor's warm-up.
 *
 * Used to exclude historical warm-up readings from analytics, not just live
 * ones — otherwise the first hours of every sensor quietly skew the long-run
 * numbers.
 */
export function wasInWarmup(timestamp, sensors = []) {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return false;

  return sensors.some(s => {
    const spec = SENSOR_SPECS[s.type] || SENSOR_SPECS.other;
    const start = new Date(s.startedAt).getTime();
    if (!Number.isFinite(start)) return false;
    return t >= start && t < start + spec.warmupHours * 3_600_000;
  });
}

/** Strips readings recorded during any sensor warm-up. */
export function excludeWarmup(readings = [], sensors = []) {
  if (!sensors.length) return readings;
  return readings.filter(r => !wasInWarmup(r.timestamp, sensors));
}
