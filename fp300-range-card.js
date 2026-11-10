/**
 * FP300 Range Card
 *
 * Home Assistant dashboard card to configure the 24 distance bands of an Aqara
 * FP300 presence sensor (Zigbee2MQTT model PS-S04D).
 *
 * Reads the raw Zigbee2MQTT payload from an MQTT sensor (attributes) and writes
 * through the `mqtt.publish` action. Single file, no build step, no dependencies.
 *
 * The pure logic is exported so it can be tested in Node; the custom element at
 * the bottom only patches the DOM from the view model built by `buildView`.
 */

const CARD_TAG = 'fp300-range-card';

export const BAND_COUNT = 24;
export const BAND_WIDTH_M = 0.25;
export const MAX_RANGE_M = BAND_COUNT * BAND_WIDTH_M;
export const ALL_BANDS = 2 ** BAND_COUNT - 1;

const DEFAULT_BASE_TOPIC = 'zigbee2mqtt';
const STORAGE_PREFIX = 'fp300-range-card:';
// Shared "applied" state lives outside the Zigbee2MQTT namespace, on a retained topic.
const APPLIED_TOPIC_PREFIX = 'fp300_range_card';
const ENTITY_ID_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;

// Zigbee2MQTT keeps a queued write for a sleeping FP300 for about one hour.
const PENDING_EXPIRY_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// A distance that changed this recently is considered live tracking.
const LIVE_WINDOW_MS = 15 * 1000;
// How long we wait for the first distance after asking to start tracking.
const TRACK_WAIT_MS = 60 * 1000;
// Re-evaluates the time based states (live -> stale, pending -> expired).
const TICK_MS = 5 * 1000;

// Fan geometry, in SVG user units. The apex is the sensor, the fan opens upwards.
const VIEW_WIDTH = 440;
const VIEW_HEIGHT = 250;
const APEX_X = 200;
const APEX_Y = 236;
const FAN_RADIUS = 220;
const HALF_ANGLE_RAD = (60 * Math.PI) / 180;
const BAND_THICKNESS = FAN_RADIUS / BAND_COUNT;
const UNITS_PER_METRE = FAN_RADIUS / MAX_RANGE_M;

// ---------------------------------------------------------------------------
// Bands: a 24-bit mask, bit i = band i = [i * 0.25 m, (i + 1) * 0.25 m)
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {boolean} */
function isMask(value) {
  return Number.isInteger(value) && value >= 0 && value <= ALL_BANDS;
}

/** @param {number} mask @param {number} index @returns {boolean} */
function isBandOn(mask, index) {
  return ((mask >>> index) & 1) === 1;
}

/** @param {number} index @returns {string} */
function bandKey(index) {
  return `detection_range_${index}`;
}

/**
 * Zigbee2MQTT treats every missing key as `false`, so all 24 keys are emitted.
 * @param {number} mask
 * @returns {Record<string, boolean>}
 */
export function maskToComposite(mask) {
  const composite = {};
  for (let index = 0; index < BAND_COUNT; index += 1) {
    composite[bandKey(index)] = isBandOn(mask, index);
  }
  return composite;
}

/**
 * @param {unknown} composite
 * @returns {number | null} null unless all 24 booleans are present
 */
export function compositeToMask(composite) {
  if (composite === null || typeof composite !== 'object') return null;
  let mask = 0;
  for (let index = 0; index < BAND_COUNT; index += 1) {
    const value = composite[bandKey(index)];
    if (typeof value !== 'boolean') return null;
    if (value) mask += 2 ** index;
  }
  return mask;
}

/**
 * Reads the bands reported by Zigbee2MQTT. The composite wins over the mask.
 * @param {Record<string, unknown> | undefined} attributes
 * @returns {number | null}
 */
export function parseReported(attributes) {
  if (!attributes) return null;
  const fromComposite = compositeToMask(attributes.detection_range_composite);
  if (fromComposite !== null) return fromComposite;
  return isMask(attributes.detection_range) ? attributes.detection_range : null;
}

/** @param {number} mask @param {number} index @returns {number} */
export function toggleBand(mask, index) {
  return (mask ^ (1 << index)) >>> 0;
}

/** @param {number} metres @returns {number} bands from 0 m up to the distance */
export function upToMask(metres) {
  if (!Number.isFinite(metres)) return ALL_BANDS;
  const bands = Math.min(BAND_COUNT, Math.max(1, Math.round(metres / BAND_WIDTH_M)));
  return 2 ** bands - 1;
}

/** @param {number} mask @returns {number} */
export function invertMask(mask) {
  return (ALL_BANDS ^ mask) >>> 0;
}

/**
 * @param {number | null} mask
 * @returns {number | null} N when exactly the first N bands are on, else null
 */
export function prefixBands(mask) {
  if (!isMask(mask) || mask === 0) return null;
  const bands = Math.log2(mask + 1);
  return Number.isInteger(bands) ? bands : null;
}

/**
 * Moves the "up to" limit by whole bands. A custom selection steps from its
 * farthest active band.
 * @param {number} mask
 * @param {number} delta bands to add (negative to remove)
 * @returns {number}
 */
export function stepUpTo(mask, delta) {
  const current = prefixBands(mask) ?? 32 - Math.clz32(mask);
  return upToMask((current + delta) * BAND_WIDTH_M);
}

/** @param {unknown} metres @returns {number | null} band the distance falls in */
export function bandIndexAt(metres) {
  if (!isDistance(metres) || metres > MAX_RANGE_M) return null;
  return Math.min(BAND_COUNT - 1, Math.floor(metres / BAND_WIDTH_M));
}

// ---------------------------------------------------------------------------
// Configuration and MQTT messages
// ---------------------------------------------------------------------------

/** @param {unknown} value @param {string} field @returns {string} */
function topicPart(value, field) {
  const invalid =
    typeof value !== 'string' ||
    value.trim() === '' ||
    /[#+\u0000-\u001f]/.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//');
  if (invalid) {
    throw new Error(`"${field}" non valido: niente caratteri jolly MQTT (# +) né segmenti vuoti`);
  }
  return value;
}

/** @returns {number} */
function numberOption(value, fallback, field, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`"background.${field}" deve essere un numero tra ${min} e ${max}`);
  }
  return value;
}

function normalizeBackground(background) {
  if (background === undefined || background === null) return null;
  if (typeof background.image !== 'string' || background.image.trim() === '') {
    throw new Error('"background.image" deve essere il percorso di un\'immagine (es. /local/pianta.png)');
  }
  const width = numberOption(background.width_m, MAX_RANGE_M, 'width_m', 0, 100);
  if (width === 0) throw new Error('"background.width_m" deve essere maggiore di 0');
  return {
    image: background.image,
    width_m: width,
    sensor_x: numberOption(background.sensor_x, 0.5, 'sensor_x', 0, 1),
    sensor_y: numberOption(background.sensor_y, 1, 'sensor_y', 0, 1),
    rotation: numberOption(background.rotation, 0, 'rotation', -360, 360),
    opacity: numberOption(background.opacity, 0.5, 'opacity', 0, 1),
  };
}

/**
 * Validates the card configuration and applies the defaults.
 * @param {Record<string, any> | null | undefined} config
 */
export function normalizeConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Configurazione mancante');
  if (typeof config.entity !== 'string' || !ENTITY_ID_PATTERN.test(config.entity)) {
    throw new Error('"entity" deve essere il sensore MQTT raw (es. sensor.fp300_raw_demo)');
  }
  const appliedEntity = config.applied_entity ?? null;
  if (appliedEntity !== null && (typeof appliedEntity !== 'string' || !ENTITY_ID_PATTERN.test(appliedEntity))) {
    throw new Error('"applied_entity" deve essere il sensore dello stato applicato (es. sensor.fp300_applied_demo)');
  }
  const friendlyName = topicPart(config.friendly_name, 'friendly_name');
  return {
    entity: config.entity,
    friendly_name: friendlyName,
    base_topic: topicPart(config.base_topic ?? DEFAULT_BASE_TOPIC, 'base_topic'),
    title: typeof config.title === 'string' && config.title ? config.title : `FP300 · ${friendlyName}`,
    bands_open: config.bands_open === true,
    simple: config.simple === true,
    applied_entity: appliedEntity,
    background: normalizeBackground(config.background),
  };
}

function deviceTopic(config, suffix) {
  return `${config.base_topic}/${config.friendly_name}/${suffix}`;
}

/** Never retained: a retained /set would be re-applied at every Zigbee2MQTT restart. */
function message(topic, payload) {
  return { topic, payload: JSON.stringify(payload), retain: false };
}

/** The only write to the bands: all 24 booleans and nothing else. */
export function buildSetMessage(config, mask) {
  if (!isMask(mask)) throw new Error('Maschera delle fasce non valida');
  return message(deviceTopic(config, 'set'), { detection_range_composite: maskToComposite(mask) });
}

/** Asks Zigbee2MQTT to read the bands back from the sensor. */
export function buildGetMessage(config) {
  return message(deviceTopic(config, 'get'), { detection_range_composite: '' });
}

export function buildTrackMessage(config) {
  return message(deviceTopic(config, 'set'), { track_target_distance: 'start_tracking_distance' });
}

/**
 * Shares what this card applied with the other dashboards, through a retained
 * topic read back by a second MQTT sensor. `null` clears it with an explicit
 * marker, because Home Assistant ignores an empty payload.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {Applied | null} applied
 */
export function buildAppliedMessage(config, applied) {
  return {
    topic: `${APPLIED_TOPIC_PREFIX}/${config.friendly_name}/applied`,
    payload: JSON.stringify(applied ?? { phase: 'none' }),
    retain: true,
  };
}

// ---------------------------------------------------------------------------
// Sync state: what this card applied versus what Zigbee2MQTT reports
// ---------------------------------------------------------------------------

/**
 * A pending write stays pending until `settleApplied` promotes it: a report
 * that merely equals the applied bands may predate the write.
 *
 * @typedef {{ mask: number, at: number, phase: 'pending' | 'written', confirmedAt?: number }} Applied
 * @param {number | null} reported
 * @param {Applied | null} applied
 * @param {number} now
 * @returns {'idle' | 'pending' | 'expired' | 'written' | 'drift'}
 */
export function deriveSync(reported, applied, now) {
  if (!applied) return 'idle';
  if (applied.phase === 'written') {
    return reported === null || reported === applied.mask ? 'written' : 'drift';
  }
  return now - applied.at > PENDING_EXPIRY_MS ? 'expired' : 'pending';
}

/**
 * Promotes a pending write to written. Call it only for a state received after
 * the write was published.
 * @param {Applied | null} applied
 * @param {number | null} reported
 * @param {number} now
 * @returns {Applied | null}
 */
export function settleApplied(applied, reported, now) {
  if (!applied || applied.phase !== 'pending' || reported !== applied.mask) return applied;
  return { ...applied, phase: 'written', confirmedAt: now };
}

/**
 * Validates an applied record coming from storage or from entity attributes.
 * @param {unknown} value
 * @returns {Applied | null}
 */
export function parseApplied(value) {
  const valid =
    value !== null &&
    typeof value === 'object' &&
    isMask(value.mask) &&
    Number.isFinite(value.at) &&
    (value.phase === 'pending' || value.phase === 'written');
  if (!valid) return null;
  const applied = { mask: value.mask, at: value.at, phase: value.phase };
  return Number.isFinite(value.confirmedAt) ? { ...applied, confirmedAt: value.confirmedAt } : applied;
}

/** @param {string | null} raw @returns {Applied | null} */
export function parseStored(raw) {
  if (!raw) return null;
  try {
    return parseApplied(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function round(value) {
  return Number(value.toFixed(2));
}

/** Point at `radius` from the apex, `angle` radians clockwise from straight ahead. */
function polar(radius, angle) {
  return `${round(APEX_X + radius * Math.sin(angle))} ${round(APEX_Y - radius * Math.cos(angle))}`;
}

function arcTo(radius, angle, sweep) {
  return `A${round(radius)} ${round(radius)} 0 0 ${sweep} ${polar(radius, angle)}`;
}

/** @param {number} index @returns {string} SVG path of one band */
export function bandPath(index) {
  const inner = index * BAND_THICKNESS;
  const outer = inner + BAND_THICKNESS;
  const closing = inner === 0 ? '' : ` ${arcTo(inner, -HALF_ANGLE_RAD, 0)}`;
  return (
    `M${polar(outer, -HALF_ANGLE_RAD)} ${arcTo(outer, HALF_ANGLE_RAD, 1)} ` +
    `L${polar(inner, HALF_ANGLE_RAD)}${closing} Z`
  );
}

/** @param {unknown} value @returns {boolean} */
function isDistance(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The sensor measures distance only, not direction: the target is drawn as an
 * arc across the whole field, not as a point.
 * @param {unknown} metres
 * @returns {string | null}
 */
export function markerPath(metres) {
  if (!isDistance(metres)) return null;
  const radius = Math.min(metres, MAX_RANGE_M) * UNITS_PER_METRE;
  return `M${polar(radius, -HALF_ANGLE_RAD)} ${arcTo(radius, HALF_ANGLE_RAD, 1)}`;
}

/**
 * Places a top-down image (floor plan) so that its sensor point sits on the apex.
 * @param {ReturnType<typeof normalizeBackground>} background
 * @param {number | null} aspect image height / width
 */
export function backgroundPlacement(background, aspect) {
  if (!background || !(aspect > 0)) return null;
  const width = background.width_m * UNITS_PER_METRE;
  const height = width * aspect;
  return {
    x: APEX_X - background.sensor_x * width,
    y: APEX_Y - background.sensor_y * height,
    width,
    height,
    rotation: background.rotation,
    opacity: background.opacity,
    pivotX: APEX_X,
    pivotY: APEX_Y,
  };
}

// ---------------------------------------------------------------------------
// Target distance tracking
// ---------------------------------------------------------------------------

/**
 * @typedef {{ seen?: boolean, last?: unknown, changedAt?: number, startedAt?: number }} Track
 * @param {Track} track
 * @param {unknown} value
 * @param {number} now
 * @returns {Track} the same object when nothing changed
 */
export function observeDistance(track, value, now) {
  if (!track.seen) return { ...track, seen: true, last: value };
  if (Object.is(track.last, value)) return track;
  return { ...track, last: value, changedAt: now };
}

/**
 * @param {Track} track
 * @param {unknown} value
 * @param {number} now
 * @returns {'live' | 'waiting' | 'stale' | 'none'}
 */
export function trackStatus(track, value, now) {
  const hasValue = isDistance(value);
  if (hasValue && track.changedAt !== undefined && now - track.changedAt <= LIVE_WINDOW_MS) {
    return 'live';
  }
  const answered = track.changedAt !== undefined && track.changedAt >= track.startedAt;
  if (track.startedAt !== undefined && now - track.startedAt <= TRACK_WAIT_MS && !answered) {
    return 'waiting';
  }
  return hasValue ? 'stale' : 'none';
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const WAKE_HINT = "premi il pulsante sull'FP300";
const WAKE_HOW = 'una pressione breve, senza tenerlo premuto';

/** @param {number} value @returns {string} Italian decimal, no trailing zeros */
function formatNumber(value) {
  return String(round(value)).replace('.', ',');
}

/** @returns {string} "alle 17:54" today, "il 10 novembre alle 17:54" otherwise */
function formatWhen(timestamp, now) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return `alle ${time}`;
  return `il ${date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })} alle ${time}`;
}

function bandLabel(index) {
  return `${formatNumber(index * BAND_WIDTH_M)}–${formatNumber((index + 1) * BAND_WIDTH_M)}`;
}

function joinList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/**
 * @param {number} mask
 * @returns {string} the active ranges in plain words, e.g. "da 0 a 3 m e da 5 a 5,25 m"
 */
export function describeMask(mask) {
  if (mask === 0) return 'nessuna fascia';
  const ranges = [];
  let start = null;
  for (let index = 0; index <= BAND_COUNT; index += 1) {
    const on = index < BAND_COUNT && isBandOn(mask, index);
    if (on && start === null) start = index;
    if (!on && start !== null) {
      ranges.push(`da ${formatNumber(start * BAND_WIDTH_M)} a ${formatNumber(index * BAND_WIDTH_M)} m`);
      start = null;
    }
  }
  return mask === ALL_BANDS ? `${ranges[0]} (tutte)` : joinList(ranges);
}

function bandStateText(band) {
  if (band.unknown) return 'stato sconosciuto';
  if (band.changed) return band.on ? 'da attivare' : 'da disattivare';
  if (band.pending) return band.on ? 'attivazione in attesa' : 'disattivazione in attesa';
  const state = band.on ? 'attiva' : 'disattivata';
  return band.drift ? `${state} sul sensore, diversa da quella applicata` : state;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

function presenceView(available, attributes) {
  if (available && attributes.presence === true) return { kind: 'on', text: 'Presenza' };
  if (available && attributes.presence === false) return { kind: 'off', text: 'Nessuna presenza' };
  return { kind: 'unknown', text: 'Presenza sconosciuta' };
}

function distanceView(track, value, now) {
  const status = trackStatus(track, value, now);
  const empty = { status, detail: '', marker: null, band: null };
  if (status === 'waiting') return { ...empty, text: 'In attesa del sensore…' };
  if (status === 'none') return { ...empty, text: 'nessuna misura' };
  const band = bandIndexAt(value);
  const text = band === null ? `oltre ${formatNumber(MAX_RANGE_M)} m` : `${formatNumber(value)} m`;
  if (status === 'stale') {
    return { status, text, detail: 'ultimo valore, misura non in corso', marker: markerPath(value), band: null };
  }
  const detail = band === null ? 'fuori dal campo' : `nella fascia ${bandLabel(band)} m`;
  return { status, text, detail, marker: markerPath(value), band };
}

function syncBanner(sync, applied, reported, now) {
  const actions = ['reapply', 'accept'];
  const when = formatWhen(applied.at, now);
  switch (sync) {
    case 'pending': {
      const minutes = Math.max(1, Math.ceil((PENDING_EXPIRY_MS - (now - applied.at)) / MINUTE_MS));
      return {
        id: 'pending',
        kind: 'action',
        label: 'Da fare',
        text:
          `In attesa che il sensore si svegli: ${WAKE_HINT} (${WAKE_HOW}). ` +
          `Inviato ${when}: Zigbee2MQTT tiene la richiesta in coda ancora per circa ${minutes} min.`,
        actions: [],
      };
    }
    case 'expired':
      return {
        id: 'expired',
        kind: 'warning',
        label: 'Attenzione',
        text:
          `Nessuna conferma da oltre un'ora per le fasce inviate ${when}: ` +
          `la richiesta in coda è probabilmente scaduta. Rimandale e ${WAKE_HINT}.`,
        actions,
      };
    case 'drift':
      return {
        id: 'drift',
        kind: 'error',
        label: 'Fasce cambiate',
        text:
          `Zigbee2MQTT riporta fasce diverse da quelle applicate da questo dispositivo ${when} ` +
          `(${describeMask(reported ^ applied.mask)}). ` +
          'Sono state cambiate altrove, oppure il sensore è tornato indietro da solo.',
        actions,
      };
    case 'written':
      return {
        id: 'written',
        kind: 'ok',
        label: 'Fatto',
        text:
          `Zigbee2MQTT ha confermato la scrittura ${formatWhen(applied.confirmedAt ?? applied.at, now)}. ` +
          'Insieme è stata chiesta una rilettura: se il sensore riportasse fasce diverse lo vedresti qui.',
        actions: [],
      };
    default:
      return null;
  }
}

function summaryText({ stateObj, available, shown, hasDraft, queued }) {
  if (!stateObj || !available) return 'Fasce attive: non disponibili';
  if (shown === null) return 'Fasce attive: non ancora lette dal sensore';
  if (hasDraft) return `Bozza: ${describeMask(shown)}`;
  if (queued) return `In coda per il sensore: ${describeMask(shown)}`;
  return `Il sensore rileva ${describeMask(shown)}`;
}

function upToView(shown) {
  if (shown === null) return { value: null, text: 'Solo fino a … m' };
  const bands = prefixBands(shown);
  if (bands === null) return { value: null, text: 'Selezione personalizzata' };
  const value = bands * BAND_WIDTH_M;
  return { value, text: `Solo fino a ${formatNumber(value)} m` };
}

function stateBanners({
  config, stateObj, available, reported, sync, queued, applied, hasDraft, draft, now, appliedMissing,
}) {
  const plain = (id, kind, label, text) => ({ id, kind, label, text, actions: [] });
  if (!stateObj) {
    return [plain('missing', 'error', 'Errore',
      `Entità ${config.entity} non trovata: controlla il package YAML e il nome dell'entità.`)];
  }
  if (!available) {
    return [plain('unavailable', 'error', 'Errore',
      'Il sensore non risponde: Zigbee2MQTT o MQTT non sono raggiungibili. Da qui non si può fare nulla, riprova più tardi.')];
  }
  const banners = [];
  if (appliedMissing) {
    banners.push(plain('applied-missing', 'warning', 'Attenzione',
      `Entità ${config.applied_entity} non trovata: lo stato applicato resta solo in questo browser. ` +
      'Controlla il package YAML.'));
  }
  const banner = sync === 'idle' ? null : syncBanner(sync, applied, reported, now);
  if (banner) banners.push(banner);
  if (reported === null && !queued) {
    banners.push(plain('unknown', 'warning', 'Attenzione',
      `Le fasce non sono ancora state lette dal sensore: usa «Rileggi dal sensore» e ${WAKE_HINT}. ` +
      'Fino ad allora non si possono modificare.'));
  }
  if (hasDraft && draft === 0) {
    banners.push(plain('empty', 'warning', 'Attenzione',
      'Seleziona almeno una fascia: questa card non disattiva tutte le fasce.'));
  } else if (hasDraft) {
    banners.push(plain('draft', 'info', 'Bozza', 'Premi «Applica» per inviare le modifiche al sensore.'));
  }
  return banners;
}

/**
 * Builds everything the element needs to paint, from plain data.
 * @param {{ config: ReturnType<typeof normalizeConfig>, stateObj: any, draft: number | null,
 *           applied: Applied | null, track: Track, now: number, appliedMissing?: boolean }} input
 */
export function buildView({ config, stateObj, draft, applied, track, now, appliedMissing = false }) {
  const available = Boolean(stateObj) && stateObj.state !== 'unavailable';
  const attributes = (available && stateObj.attributes) || {};
  const reported = available ? parseReported(attributes) : null;
  const sync = available ? deriveSync(reported, applied, now) : 'idle';
  const queued = sync === 'pending' || sync === 'expired';

  // While a write is queued the card shows (and edits from) what was applied.
  // Without a report there is no base: the card never invents a state.
  const base = queued ? applied.mask : reported;
  const editable = available && base !== null;
  const hasDraft = editable && draft !== null && draft !== base;
  const shown = hasDraft ? draft : base;
  const distance = distanceView(track, attributes.target_distance, now);

  const bands = Array.from({ length: BAND_COUNT }, (_, index) => {
    const label = bandLabel(index);
    const name = `Fascia da ${label.replace('–', ' a ')} metri`;
    if (shown === null) {
      return { classes: ['unknown'], on: false, label, aria: `${name}, ${bandStateText({ unknown: true })}` };
    }
    const on = isBandOn(shown, index);
    const changed = hasDraft && on !== isBandOn(base, index);
    const differs = reported !== null && applied && isBandOn(applied.mask, index) !== isBandOn(reported, index);
    const band = {
      on,
      changed,
      pending: Boolean(queued && differs && !changed),
      drift: Boolean(sync === 'drift' && differs && !changed),
    };
    const flags = ['changed', 'pending', 'drift'].filter((flag) => band[flag]);
    if (distance.band === index) flags.push('target');
    return { classes: [on ? 'on' : 'off', ...flags], on, label, aria: `${name}, ${bandStateText(band)}` };
  });

  return {
    title: config.title,
    base,
    bands,
    summary: summaryText({ stateObj, available, shown, hasDraft, queued }),
    upTo: upToView(shown),
    banners: stateBanners({
      config, stateObj, available, reported, sync, queued, applied, hasDraft, draft, now, appliedMissing,
    }),
    presence: presenceView(available, attributes),
    distance: { status: distance.status, text: distance.text, detail: distance.detail },
    marker: distance.marker,
    canApply: hasDraft && draft !== 0,
    canReset: hasDraft,
    editDisabled: !editable,
    sensorDisabled: !available,
  };
}

// ---------------------------------------------------------------------------
// Custom element (thin DOM patcher around buildView)
// ---------------------------------------------------------------------------

const ACTION_LABELS = { reapply: 'Rimanda le mie fasce', accept: 'Tieni quelle del sensore' };

const STYLE = `
  :host { display: block; }
  ha-card { display: block; padding: 16px; color: var(--primary-text-color); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 1.25rem; font-weight: 500; overflow-wrap: anywhere; }
  .presence { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border: 1px solid var(--secondary-text-color, #727272); border-radius: 999px; font-size: 0.85rem;
    white-space: nowrap; }
  .dot { box-sizing: border-box; width: 10px; height: 10px; border-radius: 50%;
    border: 2px dashed var(--secondary-text-color, #727272); }
  .presence.on .dot { border: 0; background: var(--success-color, #43a047); }
  .presence.off .dot { border-style: solid; }
  svg { display: block; width: 100%; height: auto; margin-top: 8px; touch-action: manipulation; }
  .band { stroke: var(--card-background-color, #fff); stroke-width: 0.6; cursor: pointer; }
  .band.on { fill: var(--primary-color, #03a9f4); fill-opacity: 0.85; }
  .band.off { fill: var(--secondary-text-color, #727272); fill-opacity: 0.22; }
  .has-bg .band.on { fill-opacity: 0.45; }
  .has-bg .band.off { fill-opacity: 0.1; }
  /* State is carried by the line pattern, never by hue alone. */
  .band.unknown { fill: none; stroke: var(--secondary-text-color, #727272); stroke-dasharray: 2 4; cursor: default; }
  .band.changed { stroke: var(--primary-text-color, #212121); stroke-width: 1.8; }
  .band.pending { stroke: var(--primary-text-color, #212121); stroke-width: 1.8; stroke-dasharray: 5 4; }
  .band.drift { stroke: var(--error-color, #db4437); stroke-width: 2.4; stroke-dasharray: 0.1 4;
    stroke-linecap: round; }
  .disabled .band { cursor: default; }
  .scale { fill: var(--primary-text-color, #212121); font-size: 13px; }
  .sensor { fill: var(--primary-text-color, #212121); }
  .marker { fill: none; stroke: var(--primary-text-color, #212121); stroke-width: 3.5; stroke-linecap: round;
    pointer-events: none; }
  .marker.stale { opacity: 0.55; stroke-dasharray: 1 7; }
  .summary { margin: 8px 0 0; font-size: 1.05rem; font-weight: 500; }
  .distance { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px;
    margin-top: 6px; font-size: 0.9rem; }
  .distance strong { font-size: 1.05rem; }
  #banners:focus { outline: none; }
  .banner { --tone: var(--info-color, #039be5); display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    margin-top: 12px; padding: 10px 12px; border: 1px solid var(--tone); border-radius: 8px;
    background: color-mix(in srgb, var(--tone) 12%, transparent); font-size: 0.95rem; }
  .banner.action { --tone: var(--primary-color, #03a9f4); border-width: 2px; }
  .banner.warning { --tone: var(--warning-color, #ffa600); }
  .banner.error { --tone: var(--error-color, #db4437); border-width: 2px; }
  .banner.ok { --tone: var(--success-color, #43a047); }
  .banner p { flex: 1 1 220px; margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .btn { flex: 1 1 140px; min-height: 44px; padding: 0 16px; border: 1px solid var(--secondary-text-color, #727272);
    border-radius: 8px; background: transparent; color: var(--primary-text-color); font: inherit; cursor: pointer; }
  .btn.primary { border-color: transparent; background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff); font-weight: 500; }
  .btn.step { flex: 0 0 48px; padding: 0; font-size: 1.4rem; line-height: 1; }
  .btn:disabled, .chip:disabled { border: 1px dashed var(--secondary-text-color, #727272); background: transparent;
    color: var(--secondary-text-color, #727272); cursor: not-allowed; }
  .btn:focus-visible, .chip:focus-visible, summary:focus-visible, input:focus-visible {
    outline: 2px solid var(--primary-text-color, #212121); outline-offset: 2px; }
  .limit { margin-top: 12px; }
  .limit-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .limit input { flex: 1 1 auto; min-width: 0; min-height: 44px; margin: 0;
    accent-color: var(--primary-color, #03a9f4); }
  details { margin-top: 8px; }
  summary { min-height: 44px; display: flex; align-items: center; gap: 8px; cursor: pointer; }
  summary::before { content: '▸'; }
  details[open] summary::before { content: '▾'; }
  .chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
  .chip { min-height: 44px; padding: 0 4px; border: 1px solid var(--secondary-text-color, #727272);
    border-radius: 8px; background: transparent; color: var(--primary-text-color); font: inherit;
    font-size: 0.85rem; cursor: pointer; }
  .chip::before { content: '○ '; }
  .chip.on { border-color: var(--primary-color, #03a9f4);
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 22%, transparent); }
  .chip.on::before { content: '● '; }
  .chip.unknown::before { content: '? '; }
  .chip.changed { border: 2px solid var(--primary-text-color, #212121); }
  .chip.changed::before { content: '✎ '; }
  .chip.pending { border: 2px dashed var(--primary-text-color, #212121); }
  .chip.pending::before { content: '◷ '; }
  .chip.drift { border: 2px dotted var(--error-color, #db4437); }
  .chip.drift::before { content: '⚠ '; }
  .chip.target { outline: 3px solid var(--primary-text-color, #212121); outline-offset: 1px; }
  /* Simple mode: only the fan, the plain sentence, the limit and Applica/Annulla. */
  .simple [data-advanced] { display: none; }
  .simple .band { cursor: default; }
  .simple .marker { display: none; }
`;

function scaleLabels() {
  return Array.from({ length: MAX_RANGE_M }, (_, index) => {
    const radius = (index + 1) * UNITS_PER_METRE;
    const x = round(APEX_X + radius * Math.sin(HALF_ANGLE_RAD) + 6);
    const y = round(APEX_Y - radius * Math.cos(HALF_ANGLE_RAD) + 5);
    return `<text class="scale" x="${x}" y="${y}">${index + 1} m</text>`;
  }).join('');
}

// Built from constants only: no configuration or sensor data is interpolated here.
function skeleton() {
  const indexes = Array.from({ length: BAND_COUNT }, (_, index) => index);
  const paths = indexes.map((i) => `<path data-band="${i}" d="${bandPath(i)}"></path>`).join('');
  const chips = indexes
    .map((i) => `<button type="button" class="chip" data-band="${i}">${bandLabel(i)}</button>`)
    .join('');
  return `
    <style>${STYLE}</style>
    <ha-card>
      <div class="head">
        <h2 id="title"></h2>
        <span id="presence" class="presence"><span class="dot"></span><span id="presence-text"></span></span>
      </div>
      <div id="fan">
        <svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" aria-hidden="true">
          <image id="background" preserveAspectRatio="none" display="none"></image>
          <g id="bands">${paths}</g>
          ${scaleLabels()}
          <path id="marker" class="marker" display="none"></path>
          <circle class="sensor" cx="${APEX_X}" cy="${APEX_Y}" r="4"></circle>
        </svg>
      </div>
      <p id="summary" class="summary"></p>
      <div class="distance" data-advanced>
        <span>Distanza rilevata: <strong id="distance"></strong></span>
        <span id="distance-detail"></span>
      </div>
      <div id="banners" aria-live="polite" aria-atomic="false" tabindex="-1"></div>
      <div class="limit" role="group" aria-labelledby="up-to-text">
        <span id="up-to-text"></span>
        <div class="limit-row">
          <button type="button" class="btn step" data-action="less" data-needs-bands
            aria-label="Riduci il limite di 25 centimetri">−</button>
          <input id="up-to" type="range" min="${BAND_WIDTH_M}" max="${MAX_RANGE_M}" step="${BAND_WIDTH_M}"
            value="${MAX_RANGE_M}" aria-label="Limite massimo di distanza" data-needs-bands />
          <button type="button" class="btn step" data-action="more" data-needs-bands
            aria-label="Aumenta il limite di 25 centimetri">+</button>
        </div>
      </div>
      <details id="details" data-advanced>
        <summary>Scegli le singole fasce (metri)</summary>
        <div class="chips" role="group" aria-label="Fasce di rilevamento">${chips}</div>
        <div class="row">
          <button type="button" class="btn" data-action="all" data-needs-bands>Attiva tutte</button>
          <button type="button" class="btn" data-action="invert" data-needs-bands>Inverti selezione</button>
        </div>
      </details>
      <div class="row">
        <button type="button" class="btn primary" data-action="apply">Applica</button>
        <button type="button" class="btn" data-action="reset">Annulla</button>
      </div>
      <div class="row" data-advanced>
        <button type="button" class="btn" data-action="track" data-needs-sensor>Avvia tracciamento</button>
        <button type="button" class="btn" data-action="refresh" data-needs-sensor>Rileggi dal sensore</button>
      </div>
    </ha-card>
  `;
}

function errorText(error) {
  return (error && typeof error.message === 'string' && error.message) || String(error);
}

/** Avoids rewriting unchanged text nodes, which would disturb screen readers. */
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

const BaseElement = globalThis.HTMLElement ?? class {};

class Fp300RangeCard extends BaseElement {
  static getStubConfig() {
    return { entity: 'sensor.fp300_raw_mmwave', friendly_name: 'mmwave' };
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._draft = null;
    this._note = null;
    this._track = {};
    this._refreshAt = null;
    this._stateObj = this._hass?.states?.[this._config.entity];
    this._appliedObj = this._appliedSource();
    this._applied = this._readApplied();
    this._loadBackground();
    this._build();
    this._els.card.classList.toggle('simple', this._config.simple);
    this._els.details.open = this._config.bands_open;
    this._observe();
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const stateObj = hass?.states?.[this._config.entity];
    const appliedObj = this._appliedSource();
    // Home Assistant sets `hass` on every state change in the house: only react to our entities.
    if (stateObj === this._stateObj && appliedObj === this._appliedObj && this._view) return;
    if (appliedObj !== this._appliedObj) {
      // The shared record is authoritative: another dashboard may have applied or settled it.
      this._appliedObj = appliedObj;
      this._applied = this._readApplied();
    }
    if (stateObj !== this._stateObj) {
      this._stateObj = stateObj;
      // Informational notes describe a request: a new state makes them stale.
      if (this._note && this._note.kind !== 'error') this._note = null;
      this._observe();
    }
    this._update();
  }

  /** @returns {object | undefined} the entity holding the shared applied state, when configured */
  _appliedSource() {
    const entity = this._config.applied_entity;
    return entity ? this._hass?.states?.[entity] : undefined;
  }

  _readApplied() {
    if (!this._config.applied_entity || !this._appliedObj) return this._loadLocalApplied();
    return this._appliedObj.state === 'unavailable' ? this._applied ?? null : parseApplied(this._appliedObj.attributes);
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._update(), TICK_MS);
    this._onStorage = (event) => {
      // Another tab applied bands for the same sensor: follow it.
      if (!this._config || this._config.applied_entity || event.key !== this._storageKey()) return;
      this._applied = parseStored(event.newValue);
      this._update();
    };
    globalThis.addEventListener?.('storage', this._onStorage);
    this._update();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    globalThis.removeEventListener?.('storage', this._onStorage);
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  _build() {
    if (this._els) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = skeleton();
    const byId = (id) => root.getElementById(id);
    this._root = root;
    this._els = {
      card: root.querySelector('ha-card'),
      title: byId('title'),
      presence: byId('presence'),
      presenceText: byId('presence-text'),
      fan: byId('fan'),
      background: byId('background'),
      marker: byId('marker'),
      summary: byId('summary'),
      distance: byId('distance'),
      distanceDetail: byId('distance-detail'),
      banners: byId('banners'),
      details: byId('details'),
      upTo: byId('up-to'),
      upToText: byId('up-to-text'),
      paths: [...root.querySelectorAll('path[data-band]')],
      chips: [...root.querySelectorAll('.chip')],
      apply: root.querySelector('[data-action="apply"]'),
      reset: root.querySelector('[data-action="reset"]'),
      bandControls: [...root.querySelectorAll('[data-needs-bands]')],
      sensorControls: [...root.querySelectorAll('[data-needs-sensor]')],
    };
    root.addEventListener('click', (event) => this._onClick(event));
    this._els.upTo.addEventListener('input', () => {
      this._edit(() => upToMask(Number(this._els.upTo.value)));
    });
  }

  /** Follows a state received from Home Assistant: tracking, confirmation, read-back. */
  _observe() {
    const stateObj = this._stateObj;
    if (!stateObj || stateObj.state === 'unavailable') return;
    const now = Date.now();
    const attributes = stateObj.attributes || {};
    const reported = parseReported(attributes);
    this._track = observeDistance(this._track, attributes.target_distance, now);
    const settled = settleApplied(this._applied, reported, now);
    if (settled !== this._applied) this._setApplied(settled);
    if (this._refreshAt !== null && reported !== null) {
      this._refreshAt = null;
      this._note = {
        kind: 'ok',
        label: 'Fatto',
        text: `Dopo la richiesta è arrivato un messaggio dal sensore (${formatWhen(now, now)}). ` +
          `Fasce riportate: ${describeMask(reported)}.`,
      };
    }
  }

  _update() {
    if (!this._els || !this._config) return;
    const now = Date.now();
    const input = {
      config: this._config,
      stateObj: this._stateObj,
      applied: this._applied,
      track: this._track,
      now,
      appliedMissing: Boolean(this._config.applied_entity) && !this._appliedObj,
    };
    let view = buildView({ ...input, draft: this._draft });
    if (this._draft !== null && this._draft === view.base) {
      // The sensor caught up with the draft: drop it, or it would come back later.
      this._draft = null;
      view = buildView({ ...input, draft: null });
    }
    this._view = view;
    const els = this._els;

    setText(els.title, view.title);
    els.presence.className = `presence ${view.presence.kind}`;
    setText(els.presenceText, view.presence.text);
    setText(els.summary, view.summary);
    setText(els.distance, view.distance.text);
    setText(els.distanceDetail, view.distance.detail);
    setText(els.upToText, view.upTo.text);
    if (view.upTo.value !== null) els.upTo.value = String(view.upTo.value);
    els.upTo.setAttribute('aria-valuetext', view.upTo.value === null ? view.upTo.text : `${view.upTo.value} metri`);

    view.bands.forEach((band, index) => {
      els.paths[index].setAttribute('class', ['band', ...band.classes].join(' '));
      const chip = els.chips[index];
      chip.className = ['chip', ...band.classes].join(' ');
      chip.setAttribute('aria-pressed', String(band.on));
      chip.setAttribute('aria-label', band.aria);
      chip.disabled = view.editDisabled;
    });

    if (view.marker) {
      els.marker.setAttribute('d', view.marker);
      els.marker.setAttribute('class', `marker ${view.distance.status}`);
      els.marker.removeAttribute('display');
    } else {
      els.marker.setAttribute('display', 'none');
    }

    const placement = backgroundPlacement(this._config.background, this._backgroundAspect);
    els.fan.className = [placement && 'has-bg', view.editDisabled && 'disabled'].filter(Boolean).join(' ');
    this._paintBackground(placement);

    this._paintBanners(this._note ? [...view.banners, { id: 'note', actions: [], ...this._note }] : view.banners);
    this._setDisabled(els.apply, !view.canApply || this._busy);
    this._setDisabled(els.reset, !view.canReset);
    for (const control of els.bandControls) this._setDisabled(control, view.editDisabled);
    for (const control of els.sensorControls) this._setDisabled(control, view.sensorDisabled || this._busy);
  }

  /** A focused control that becomes disabled would drop keyboard focus: move it to the status area. */
  _setDisabled(control, disabled) {
    if (disabled && !control.disabled && this._root.activeElement === control) this._els.banners.focus();
    control.disabled = disabled;
  }

  _paintBackground(placement) {
    const image = this._els.background;
    if (!placement) {
      image.setAttribute('display', 'none');
      return;
    }
    image.setAttribute('href', this._config.background.image);
    for (const key of ['x', 'y', 'width', 'height', 'opacity']) image.setAttribute(key, String(placement[key]));
    image.setAttribute('transform', `rotate(${placement.rotation} ${placement.pivotX} ${placement.pivotY})`);
    image.removeAttribute('display');
  }

  /** Rebuilt only when the content changes, so focus on the action buttons survives. */
  _paintBanners(banners) {
    const signature = JSON.stringify(banners);
    if (signature === this._bannerSignature) return;
    this._bannerSignature = signature;
    const container = this._els.banners;
    const hadFocus = container.contains(this._root.activeElement);
    const nodes = banners.map((banner) => {
      const node = document.createElement('div');
      node.className = `banner ${banner.kind}`;
      const text = document.createElement('p');
      const label = document.createElement('strong');
      label.textContent = `${banner.label}: `;
      text.append(label, banner.text);
      node.append(text);
      for (const action of banner.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.action = action;
        button.textContent = ACTION_LABELS[action];
        node.append(button);
      }
      return node;
    });
    container.replaceChildren(...nodes);
    if (hadFocus) container.focus();
  }

  _onClick(event) {
    const target = event.target.closest?.('[data-band], [data-action]');
    if (!target || target.disabled || !this._view) return;
    if (target.dataset.band !== undefined) {
      // In simple mode the fan is a picture: a stray tap must not switch a single band.
      if (this._view.editDisabled || this._config.simple) return;
      this._edit((mask) => toggleBand(mask, Number(target.dataset.band)));
      return;
    }
    const actions = {
      apply: () => this._apply(this._draft),
      reapply: () => this._apply(this._applied?.mask),
      accept: () => this._change(() => this._setApplied(null)),
      reset: () => this._change(() => { this._draft = null; }),
      all: () => this._edit(() => ALL_BANDS),
      invert: () => this._edit(invertMask),
      less: () => this._edit((mask) => stepUpTo(mask, -1)),
      more: () => this._edit((mask) => stepUpTo(mask, 1)),
      track: () => this._startTracking(),
      refresh: () => this._refresh(),
    };
    actions[target.dataset.action]?.();
  }

  _change(mutate) {
    this._note = null;
    mutate();
    this._update();
  }

  _edit(transform) {
    const base = this._view.base;
    if (base === null || this._view.editDisabled) return;
    const next = transform(this._draft ?? base);
    this._change(() => { this._draft = next === base ? null : next; });
  }

  async _publish(mqttMessage, onSuccess) {
    if (this._busy || !this._hass) return;
    const config = this._config;
    this._busy = true;
    this._note = null;
    this._update();
    try {
      await this._hass.callService('mqtt', 'publish', mqttMessage);
      // The card may have been pointed at another sensor while the call was in flight.
      if (config === this._config) onSuccess();
    } catch (error) {
      this._note = { kind: 'error', label: 'Errore', text: `Invio non riuscito: ${errorText(error)}` };
    } finally {
      this._busy = false;
      this._update();
    }
  }

  _apply(mask) {
    if (!isMask(mask) || mask === 0) return;
    this._publish(buildSetMessage(this._config, mask), () => {
      // Saved only once Home Assistant accepted the publish, and always as pending:
      // only a state received afterwards can confirm it.
      this._setApplied({ mask, at: Date.now(), phase: 'pending' });
      // Bands edited while the call was in flight stay in the draft.
      if (this._draft === mask) this._draft = null;
      // Queue a read-back behind the write: one wake-up writes and reports the real value.
      this._send(buildGetMessage(this._config));
    });
  }

  /** Publishes without the busy gate, for follow-up messages. Failures are shown, never swallowed. */
  _send(mqttMessage) {
    this._hass.callService('mqtt', 'publish', mqttMessage).catch((error) => {
      this._note = { kind: 'error', label: 'Errore', text: `Invio non riuscito: ${errorText(error)}` };
      this._update();
    });
  }

  _startTracking() {
    this._publish(buildTrackMessage(this._config), () => {
      this._track = { ...this._track, startedAt: Date.now() };
      this._note = {
        kind: 'info',
        label: 'Nota',
        text: `Tracciamento richiesto: mostra a che distanza ti vede il sensore. Se dorme, ${WAKE_HINT}. ` +
          'Si ferma da solo dopo poco.',
      };
    });
  }

  _refresh() {
    this._publish(buildGetMessage(this._config), () => {
      this._refreshAt = Date.now();
      this._note = {
        kind: 'info',
        label: 'Nota',
        text: `Rilettura richiesta: se il sensore dorme, ${WAKE_HINT}. ` +
          'Quando risponde lo vedrai scritto qui.',
      };
    });
  }

  _storageKey() {
    return `${STORAGE_PREFIX}${this._config.base_topic}/${this._config.friendly_name}`;
  }

  _loadLocalApplied() {
    try {
      return parseStored(globalThis.localStorage.getItem(this._storageKey()));
    } catch {
      // Storage can be blocked (private mode): the card works without it, per page load.
      return null;
    }
  }

  _setApplied(applied) {
    this._applied = applied;
    if (this._config.applied_entity && this._appliedObj && this._hass) {
      this._send(buildAppliedMessage(this._config, applied));
      return;
    }
    try {
      if (applied) globalThis.localStorage.setItem(this._storageKey(), JSON.stringify(applied));
      else globalThis.localStorage.removeItem(this._storageKey());
    } catch {
      // Same as above: losing persistence only loses the pending/drift notice after a reload.
    }
  }

  _loadBackground() {
    this._backgroundAspect = null;
    const source = this._config.background?.image;
    if (!source) return;
    const image = new Image();
    image.onload = () => {
      if (this._config.background?.image !== source || !image.naturalWidth) return;
      this._backgroundAspect = image.naturalHeight / image.naturalWidth;
      this._update();
    };
    image.onerror = () => {
      this._note = { kind: 'error', label: 'Errore', text: `Immagine di sfondo non caricabile: ${source}` };
      this._update();
    };
    image.src = source;
  }
}

if (globalThis.customElements && !globalThis.customElements.get(CARD_TAG)) {
  globalThis.customElements.define(CARD_TAG, Fp300RangeCard);
  globalThis.customCards = globalThis.customCards || [];
  globalThis.customCards.push({
    type: CARD_TAG,
    name: 'FP300 Range Card',
    description: 'Configura le fasce di distanza di un Aqara FP300 (Zigbee2MQTT)',
  });
}
