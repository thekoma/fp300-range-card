import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_BANDS,
  BAND_COUNT,
  backgroundPlacement,
  bandIndexAt,
  bandPath,
  buildAppliedMessage,
  describeMask,
  parseApplied,
  prefixBands,
  stepUpTo,
  buildGetMessage,
  buildSetMessage,
  buildTrackMessage,
  compositeToMask,
  deriveSync,
  invertMask,
  markerPath,
  maskToComposite,
  normalizeConfig,
  observeDistance,
  parseReported,
  parseStored,
  settleApplied,
  toggleBand,
  trackStatus,
  upToMask,
} from '../fp300-range-card.js';

const HOUR = 60 * 60 * 1000;
const baseConfig = { entity: 'sensor.fp300_raw_demo', friendly_name: 'fp300_a' };

test('module imports in Node without a DOM', () => {
  assert.equal(BAND_COUNT, 24);
  assert.equal(ALL_BANDS, 16777215);
});

// --- mask <-> composite -----------------------------------------------------

test('maskToComposite always emits the 24 keys in order', () => {
  const composite = maskToComposite(0b101);
  const keys = Object.keys(composite);

  assert.equal(keys.length, 24);
  assert.deepEqual(keys, Array.from({ length: 24 }, (_, i) => `detection_range_${i}`));
  assert.equal(composite.detection_range_0, true);
  assert.equal(composite.detection_range_1, false);
  assert.equal(composite.detection_range_2, true);
  assert.equal(composite.detection_range_23, false);
});

test('bit order: bit 0 is the nearest band, bit 23 the farthest', () => {
  assert.equal(compositeToMask(maskToComposite(1)), 1);
  assert.equal(maskToComposite(2 ** 23).detection_range_23, true);
  assert.equal(compositeToMask(maskToComposite(ALL_BANDS)), ALL_BANDS);
});

test('compositeToMask returns null for partial or malformed composites', () => {
  const partial = { ...maskToComposite(ALL_BANDS) };
  delete partial.detection_range_7;

  assert.equal(compositeToMask(partial), null);
  assert.equal(compositeToMask({ ...maskToComposite(1), detection_range_3: 'yes' }), null);
  assert.equal(compositeToMask(null), null);
  assert.equal(compositeToMask('abc'), null);
});

test('parseReported prefers the composite over the mask', () => {
  const attrs = { detection_range: 7, detection_range_composite: maskToComposite(3) };

  assert.equal(parseReported(attrs), 3);
});

test('parseReported falls back to the mask when the composite is unusable', () => {
  assert.equal(parseReported({ detection_range: 255 }), 255);
  assert.equal(parseReported({ detection_range: 255, detection_range_composite: {} }), 255);
});

test('parseReported returns null for missing or out-of-range values', () => {
  for (const value of [-1, 2 ** 24, 1.5, 'abc', null, undefined]) {
    assert.equal(parseReported({ detection_range: value }), null, String(value));
  }
  assert.equal(parseReported(undefined), null);
  assert.equal(parseReported({}), null);
});

// --- draft editing ----------------------------------------------------------

test('toggleBand flips one band and does not touch the others', () => {
  assert.equal(toggleBand(0, 0), 1);
  assert.equal(toggleBand(ALL_BANDS, 23), ALL_BANDS - 2 ** 23);
  assert.equal(toggleBand(toggleBand(5, 9), 9), 5);
});

test('upToMask enables the bands below the given distance', () => {
  assert.equal(upToMask(0.25), 0b1);
  assert.equal(upToMask(1), 0b1111);
  assert.equal(upToMask(6), ALL_BANDS);
});

test('upToMask clamps out-of-range distances', () => {
  assert.equal(upToMask(0), 0b1);
  assert.equal(upToMask(99), ALL_BANDS);
  assert.equal(upToMask(Number.NaN), ALL_BANDS);
});

test('invertMask stays inside 24 bits', () => {
  assert.equal(invertMask(0), ALL_BANDS);
  assert.equal(invertMask(ALL_BANDS), 0);
  assert.equal(invertMask(0b1111), ALL_BANDS - 0b1111);
});

// --- config and messages ----------------------------------------------------

test('normalizeConfig applies defaults', () => {
  const config = normalizeConfig(baseConfig);

  assert.equal(config.base_topic, 'zigbee2mqtt');
  assert.equal(config.title, 'FP300 · fp300_a');
  assert.equal(config.background, null);
});

test('normalizeConfig rejects missing or malformed fields', () => {
  assert.throws(() => normalizeConfig(null), /configurazione/i);
  assert.throws(() => normalizeConfig({ friendly_name: 'x' }), /entity/);
  assert.throws(() => normalizeConfig({ entity: 'not an entity', friendly_name: 'x' }), /entity/);
  assert.throws(() => normalizeConfig({ entity: 'sensor.x' }), /friendly_name/);
});

test('normalizeConfig rejects MQTT wildcards and empty topic segments', () => {
  for (const bad of ['#', 'a/#', '+', 'a+b', '/lead', 'trail/', 'a//b', '', ' ', 'a\u0000b']) {
    assert.throws(() => normalizeConfig({ ...baseConfig, friendly_name: bad }), /friendly_name/, bad);
    assert.throws(() => normalizeConfig({ ...baseConfig, base_topic: bad }), /base_topic/, bad);
  }
});

test('normalizeConfig accepts friendly names with a slash', () => {
  const config = normalizeConfig({ ...baseConfig, friendly_name: 'casa/fp300' });

  assert.equal(buildSetMessage(config, 1).topic, 'zigbee2mqtt/casa/fp300/set');
});

test('normalizeConfig validates the background block', () => {
  const config = normalizeConfig({ ...baseConfig, background: { image: '/local/pianta.png' } });

  assert.deepEqual(config.background, {
    image: '/local/pianta.png',
    width_m: 6,
    sensor_x: 0.5,
    sensor_y: 1,
    rotation: 0,
    opacity: 0.5,
  });
  assert.throws(() => normalizeConfig({ ...baseConfig, background: {} }), /background.image/);
  assert.throws(
    () => normalizeConfig({ ...baseConfig, background: { image: 'x.png', width_m: 0 } }),
    /width_m/,
  );
  assert.throws(
    () => normalizeConfig({ ...baseConfig, background: { image: 'x.png', opacity: 2 } }),
    /opacity/,
  );
});

test('buildSetMessage sends only the 24 bands, not retained', () => {
  const message = buildSetMessage(normalizeConfig(baseConfig), 0b11);
  const payload = JSON.parse(message.payload);

  assert.equal(message.topic, 'zigbee2mqtt/fp300_a/set');
  assert.equal(message.retain, false);
  assert.deepEqual(Object.keys(payload), ['detection_range_composite']);
  assert.deepEqual(payload.detection_range_composite, maskToComposite(0b11));
  assert.equal(Object.keys(payload.detection_range_composite).length, 24);
  assert.equal(
    message.payload.startsWith(
      '{"detection_range_composite":{"detection_range_0":true,"detection_range_1":true,"detection_range_2":false,',
    ),
    true,
  );
});

// --- summaries and stepping -------------------------------------------------

test('prefixBands recognises "from 0 up to N" selections only', () => {
  assert.equal(prefixBands(0b1), 1);
  assert.equal(prefixBands(0b1111), 4);
  assert.equal(prefixBands(ALL_BANDS), 24);
  assert.equal(prefixBands(0), null);
  assert.equal(prefixBands(0b1011), null);
  assert.equal(prefixBands(null), null);
});

test('describeMask lists the active ranges in metres', () => {
  assert.equal(describeMask(0), 'nessuna fascia');
  assert.equal(describeMask(ALL_BANDS), 'da 0 a 6 m (tutte)');
  assert.equal(describeMask(0b1111), 'da 0 a 1 m');
  assert.equal(describeMask(upToMask(3) + 2 ** 20), 'da 0 a 3 m e da 5 a 5,25 m');
  assert.equal(describeMask(0b1 + 0b100 + 0b10000), 'da 0 a 0,25 m, da 0,5 a 0,75 m e da 1 a 1,25 m');
});

test('stepUpTo moves the limit one band at a time and clamps', () => {
  assert.equal(stepUpTo(upToMask(2), 1), upToMask(2.25));
  assert.equal(stepUpTo(upToMask(2), -1), upToMask(1.75));
  assert.equal(stepUpTo(upToMask(0.25), -1), upToMask(0.25));
  assert.equal(stepUpTo(ALL_BANDS, 1), ALL_BANDS);
  // A custom selection steps from its farthest active band.
  assert.equal(stepUpTo(0b1000001, 1), upToMask(2));
});

test('bandIndexAt maps a distance to its band', () => {
  assert.equal(bandIndexAt(0), 0);
  assert.equal(bandIndexAt(0.25), 1);
  assert.equal(bandIndexAt(2.35), 9);
  assert.equal(bandIndexAt(5.99), 23);
  assert.equal(bandIndexAt(6.5), null);
  assert.equal(bandIndexAt(undefined), null);
});

test('buildSetMessage refuses an invalid mask', () => {
  const config = normalizeConfig(baseConfig);

  assert.throws(() => buildSetMessage(config, -1));
  assert.throws(() => buildSetMessage(config, 2 ** 24));
  assert.throws(() => buildSetMessage(config, 1.5));
});

test('buildGetMessage asks Zigbee2MQTT to read the bands back', () => {
  const message = buildGetMessage(normalizeConfig({ ...baseConfig, base_topic: 'z2m' }));

  assert.equal(message.topic, 'z2m/fp300_a/get');
  assert.equal(message.payload, '{"detection_range_composite":""}');
  assert.equal(message.retain, false);
});

test('buildTrackMessage starts distance tracking', () => {
  const message = buildTrackMessage(normalizeConfig(baseConfig));

  assert.equal(message.topic, 'zigbee2mqtt/fp300_a/set');
  assert.equal(message.payload, '{"track_target_distance":"start_tracking_distance"}');
  assert.equal(message.retain, false);
});

// --- sync state -------------------------------------------------------------

test('deriveSync covers idle, pending, written, drift and expired', () => {
  const now = 10 * HOUR;
  const pending = { mask: 3, at: now - 1000, phase: 'pending' };
  const written = { mask: 3, at: now - 1000, phase: 'written' };

  assert.equal(deriveSync(7, null, now), 'idle');
  assert.equal(deriveSync(7, pending, now), 'pending');
  // An equal report alone is not a confirmation: it may predate the write.
  assert.equal(deriveSync(3, pending, now), 'pending');
  assert.equal(deriveSync(3, written, now), 'written');
  assert.equal(deriveSync(7, written, now), 'drift');
  assert.equal(deriveSync(7, { ...pending, at: now - HOUR - 1 }, now), 'expired');
});

test('deriveSync keeps the stored phase while the reported state is unknown', () => {
  const now = 10 * HOUR;

  assert.equal(deriveSync(null, { mask: 3, at: now, phase: 'pending' }, now), 'pending');
  assert.equal(deriveSync(null, { mask: 3, at: now, phase: 'written' }, now), 'written');
});

test('settleApplied promotes pending to written once the report matches', () => {
  const pending = { mask: 3, at: 1, phase: 'pending' };

  assert.deepEqual(settleApplied(pending, 3, 99), {
    mask: 3,
    at: 1,
    phase: 'written',
    confirmedAt: 99,
  });
  assert.equal(settleApplied(pending, 7, 99), pending);
  assert.equal(settleApplied(pending, null, 99), pending);
  assert.equal(settleApplied(null, 3, 99), null);
  assert.equal(pending.phase, 'pending', 'input is not mutated');
});

test('parseStored ignores corrupt or tampered storage', () => {
  assert.deepEqual(parseStored('{"mask":3,"at":5,"phase":"pending"}'), {
    mask: 3,
    at: 5,
    phase: 'pending',
  });
  assert.equal(parseStored('{"mask":3,"at":5,"phase":"written","confirmedAt":9}').confirmedAt, 9);
  for (const bad of [null, '', 'not json', '{}', '{"mask":-1,"at":5,"phase":"pending"}',
    '{"mask":3,"at":"x","phase":"pending"}', '{"mask":3,"at":5,"phase":"other"}', '[]']) {
    assert.equal(parseStored(bad), null, String(bad));
  }
});

// --- shared applied state and card modes ------------------------------------

test('normalizeConfig reads the optional mode and shared-state entity', () => {
  const plain = normalizeConfig(baseConfig);
  const full = normalizeConfig({
    ...baseConfig,
    simple: true,
    applied_entity: 'sensor.fp300_applied_fp300_a',
  });

  assert.equal(plain.simple, false);
  assert.equal(plain.applied_entity, null);
  assert.equal(full.simple, true);
  assert.equal(full.applied_entity, 'sensor.fp300_applied_fp300_a');
  assert.throws(() => normalizeConfig({ ...baseConfig, applied_entity: 'not an entity' }), /applied_entity/);
});

test('buildAppliedMessage keeps the shared state on a retained topic outside Zigbee2MQTT', () => {
  const config = normalizeConfig({ ...baseConfig, base_topic: 'z2m' });
  const applied = { mask: 255, at: 5, phase: 'pending' };
  const message = buildAppliedMessage(config, applied);

  assert.equal(message.topic, 'fp300_range_card/fp300_a/applied');
  assert.equal(message.retain, true);
  assert.deepEqual(JSON.parse(message.payload), applied);
  assert.equal(message.topic.startsWith('z2m'), false);
});

test('buildAppliedMessage clears the shared state with an explicit marker', () => {
  const message = buildAppliedMessage(normalizeConfig(baseConfig), null);

  assert.equal(message.payload, '{"phase":"none"}');
  assert.equal(message.retain, true);
  assert.equal(parseApplied(JSON.parse(message.payload)), null);
});

test('parseApplied validates an applied record from entity attributes', () => {
  const attributes = { mask: 255, at: 5, phase: 'written', confirmedAt: 9, friendly_name: 'x' };

  assert.deepEqual(parseApplied(attributes), { mask: 255, at: 5, phase: 'written', confirmedAt: 9 });
  assert.equal(parseApplied({}), null);
  assert.equal(parseApplied(undefined), null);
  assert.equal(parseApplied({ mask: 2 ** 24, at: 5, phase: 'pending' }), null);
});

// --- geometry ---------------------------------------------------------------

test('bandPath draws a closed annular sector for every band', () => {
  for (let i = 0; i < BAND_COUNT; i += 1) {
    const path = bandPath(i);

    assert.match(path, /^M[-\d. ]+A[-\d. ]+L[-\d. ]+/, `band ${i}`);
    assert.match(path, /Z$/);
    assert.equal(path.includes('NaN'), false);
  }
  assert.notEqual(bandPath(0), bandPath(1));
});

test('markerPath is null for unusable distances and clamps beyond 6 m', () => {
  for (const value of [null, undefined, Number.NaN, -1, 'abc']) {
    assert.equal(markerPath(value), null, String(value));
  }
  assert.equal(typeof markerPath(2.5), 'string');
  assert.equal(markerPath(9), markerPath(6));
  assert.notEqual(markerPath(1), markerPath(2));
});

test('backgroundPlacement puts the sensor point of the image on the fan apex', () => {
  const background = normalizeConfig({
    ...baseConfig,
    background: { image: 'x.png', width_m: 6, sensor_x: 0.5, sensor_y: 1, rotation: 30 },
  }).background;
  const placement = backgroundPlacement(background, 0.5);

  // 6 m wide image, half as tall: the apex sits at the bottom centre of the image.
  assert.equal(placement.x + placement.width / 2, placement.pivotX);
  assert.equal(placement.y + placement.height, placement.pivotY);
  assert.equal(placement.height, placement.width / 2);
  assert.equal(placement.rotation, 30);
  assert.equal(backgroundPlacement(null, 0.5), null);
  assert.equal(backgroundPlacement(background, null), null);
});

// --- tracking ---------------------------------------------------------------

test('observeDistance records a change only after the first observation', () => {
  const first = observeDistance({}, 2.5, 1000);
  const same = observeDistance(first, 2.5, 2000);
  const moved = observeDistance(same, 2.6, 3000);

  assert.equal(first.changedAt, undefined);
  assert.equal(same, first);
  assert.equal(moved.changedAt, 3000);
  assert.equal(moved.last, 2.6);
});

test('trackStatus tells live, waiting, stale and none apart', () => {
  const now = 100000;

  assert.equal(trackStatus({}, undefined, now), 'none');
  assert.equal(trackStatus({ seen: true, last: 2 }, 2, now), 'stale');
  assert.equal(trackStatus({ seen: true, last: 2, changedAt: now - 5000 }, 2, now), 'live');
  assert.equal(trackStatus({ seen: true, last: 2, changedAt: now - 20000 }, 2, now), 'stale');
  assert.equal(trackStatus({ startedAt: now - 5000 }, undefined, now), 'waiting');
  assert.equal(trackStatus({ seen: true, last: 2, startedAt: now - 5000 }, 2, now), 'waiting');
  assert.equal(trackStatus({ seen: true, last: 2, startedAt: now - 90000 }, 2, now), 'stale');
});
