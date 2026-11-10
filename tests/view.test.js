import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_BANDS,
  buildView,
  maskToComposite,
  normalizeConfig,
  upToMask,
} from '../fp300-range-card.js';

const config = normalizeConfig({ entity: 'sensor.fp300_raw_demo', friendly_name: 'fp300_a' });
const NOW = 1_800_000_000_000;

function stateWith(mask, extra = {}) {
  return {
    state: String(mask),
    attributes: {
      detection_range: mask,
      detection_range_composite: maskToComposite(mask),
      ...extra,
    },
  };
}

function view(overrides = {}) {
  return buildView({
    config,
    stateObj: stateWith(ALL_BANDS),
    draft: null,
    applied: null,
    track: {},
    now: NOW,
    ...overrides,
  });
}

function bannerIds(result) {
  return result.banners.map((banner) => banner.id);
}

test('reported state with no draft shows plain on/off bands and nothing to apply', () => {
  const result = view({ stateObj: stateWith(0b11) });

  assert.equal(result.bands.length, 24);
  assert.deepEqual(result.bands[0].classes, ['on']);
  assert.deepEqual(result.bands[2].classes, ['off']);
  assert.equal(result.canApply, false);
  assert.equal(result.canReset, false);
  assert.equal(result.editDisabled, false);
  assert.equal(result.sensorDisabled, false);
  assert.deepEqual(bannerIds(result), []);
});

test('band labels are in metres with Italian decimals', () => {
  const result = view();

  assert.equal(result.bands[0].label, '0–0,25');
  assert.equal(result.bands[1].label, '0,25–0,5');
  assert.equal(result.bands[23].label, '5,75–6');
  assert.match(result.bands[0].aria, /da 0 a 0,25 metri.*attiva/);
});

test('the summary says in plain words which ranges are active', () => {
  assert.equal(view({ stateObj: stateWith(upToMask(2)) }).summary, 'Il sensore rileva da 0 a 2 m');
  assert.equal(
    view({ stateObj: stateWith(ALL_BANDS), draft: upToMask(3) + 2 ** 20 }).summary,
    'Bozza: da 0 a 3 m e da 5 a 5,25 m',
  );
});

test('the "up to" control follows the shown bands', () => {
  const prefix = view({ stateObj: stateWith(upToMask(2)) }).upTo;
  const custom = view({ stateObj: stateWith(0b1011) }).upTo;
  const draft = view({ stateObj: stateWith(upToMask(2)), draft: upToMask(4.5) }).upTo;

  assert.deepEqual(prefix, { value: 2, text: 'Solo fino a 2 m' });
  assert.deepEqual(custom, { value: null, text: 'Selezione personalizzata' });
  assert.equal(draft.value, 4.5);
});

test('a draft marks the changed bands and enables Applica and Annulla', () => {
  const result = view({ stateObj: stateWith(0b11), draft: 0b01 });

  assert.deepEqual(result.bands[0].classes, ['on']);
  assert.deepEqual(result.bands[1].classes, ['off', 'changed']);
  assert.match(result.bands[1].aria, /da disattivare/);
  assert.equal(result.canApply, true);
  assert.equal(result.canReset, true);
  assert.deepEqual(bannerIds(result), ['draft']);
});

test('a draft equal to the base is not a change', () => {
  const result = view({ stateObj: stateWith(0b11), draft: 0b11 });

  assert.equal(result.canApply, false);
  assert.equal(result.canReset, false);
});

test('an empty draft cannot be applied', () => {
  const result = view({ draft: 0 });

  assert.equal(result.canApply, false);
  assert.equal(result.canReset, true);
  assert.ok(bannerIds(result).includes('empty'));
});

test('pending shows the wake-up notice and per-band pending states', () => {
  const result = view({
    stateObj: stateWith(0b011),
    applied: { mask: 0b101, at: NOW - 5 * 60 * 1000, phase: 'pending' },
  });
  const pending = result.banners.find((banner) => banner.id === 'pending');

  assert.equal(
    pending.text.startsWith("In attesa che il sensore si svegli: premi il pulsante sull'FP300"),
    true,
  );
  assert.match(pending.text, /55 min/, 'tells how long the queued write is still valid');
  assert.deepEqual(result.bands[0].classes, ['on']);
  assert.deepEqual(result.bands[1].classes, ['off', 'pending']);
  assert.deepEqual(result.bands[2].classes, ['on', 'pending']);
  assert.match(result.bands[2].aria, /attivazione in attesa/);
});

test('a pending write is not shown as written just because the old report matches', () => {
  // Reported is 0b11, a write of 0b01 is queued, then the user applies 0b11 again.
  const result = view({
    stateObj: stateWith(0b11),
    applied: { mask: 0b11, at: NOW - 1000, phase: 'pending' },
  });

  assert.deepEqual(bannerIds(result), ['pending']);
});

test('while pending, a new draft starts from the applied state', () => {
  const applied = { mask: 0b101, at: NOW - 1000, phase: 'pending' };
  const unchanged = view({ stateObj: stateWith(0b011), applied, draft: 0b101 });
  const back = view({ stateObj: stateWith(0b011), applied, draft: 0b011 });

  assert.equal(unchanged.canApply, false);
  assert.equal(back.canApply, true, 'the previous bands can be queued again');
});

test('a pending write older than one hour is flagged as expired', () => {
  const result = view({
    stateObj: stateWith(0b011),
    applied: { mask: 0b101, at: NOW - 61 * 60 * 1000, phase: 'pending' },
  });
  const expired = result.banners.find((banner) => banner.id === 'expired');

  assert.deepEqual(expired.actions, ['reapply', 'accept']);
  assert.equal(expired.kind, 'warning');
});

test('written state is reported without warnings', () => {
  const result = view({
    stateObj: stateWith(0b101),
    applied: { mask: 0b101, at: NOW - 60000, phase: 'written', confirmedAt: NOW - 1000 },
  });

  assert.deepEqual(bannerIds(result), ['written']);
  assert.equal(result.banners[0].kind, 'ok');
  assert.deepEqual(result.bands[2].classes, ['on']);
});

test('drift is flagged prominently, with the differing bands named', () => {
  const result = view({
    stateObj: stateWith(0b011),
    applied: { mask: 0b101, at: NOW - 1000, phase: 'written' },
  });
  const drift = result.banners.find((banner) => banner.id === 'drift');

  assert.equal(drift.kind, 'error');
  assert.deepEqual(drift.actions, ['reapply', 'accept']);
  assert.match(drift.text, /da 0,25 a 0,75 m/, 'says where the bands differ');
  assert.deepEqual(result.bands[0].classes, ['on']);
  assert.deepEqual(result.bands[1].classes, ['on', 'drift']);
  assert.deepEqual(result.bands[2].classes, ['off', 'drift']);
  assert.match(result.bands[1].aria, /diversa da quella applicata/);
});

test('missing entity is handled without throwing', () => {
  const result = view({ stateObj: undefined });

  assert.deepEqual(bannerIds(result), ['missing']);
  assert.equal(result.editDisabled, true);
  assert.equal(result.sensorDisabled, true);
  assert.equal(result.canApply, false);
  assert.equal(result.presence.kind, 'unknown');
  assert.equal(result.marker, null);
});

test('an unavailable sensor never shows invented bands', () => {
  const result = view({ stateObj: { state: 'unavailable', attributes: {} }, draft: 0b1 });

  assert.deepEqual(bannerIds(result), ['unavailable']);
  assert.deepEqual(result.bands[0].classes, ['unknown']);
  assert.match(result.bands[0].aria, /stato sconosciuto/);
  assert.equal(result.editDisabled, true);
  assert.equal(result.sensorDisabled, true);
  assert.equal(result.canApply, false);
  assert.equal(result.upTo.value, null);
});

test('bands that were never read cannot be edited, but the sensor can be asked', () => {
  const result = view({ stateObj: { state: 'unknown', attributes: { presence: true } }, draft: 0b1 });

  assert.deepEqual(bannerIds(result), ['unknown']);
  assert.deepEqual(result.bands[5].classes, ['unknown']);
  assert.equal(result.editDisabled, true);
  assert.equal(result.sensorDisabled, false);
  assert.equal(result.canApply, false);
  assert.equal(result.canReset, false);
  assert.equal(result.presence.kind, 'on');
  assert.equal(result.summary, 'Fasce attive: non ancora lette dal sensore');
});

test('presence maps true, false and anything else', () => {
  assert.equal(view({ stateObj: stateWith(1, { presence: true }) }).presence.text, 'Presenza');
  assert.equal(view({ stateObj: stateWith(1, { presence: false }) }).presence.text, 'Nessuna presenza');
  assert.equal(view({ stateObj: stateWith(1, { presence: null }) }).presence.text, 'Presenza sconosciuta');
});

test('target distance drives the marker, the numeric value and the band it falls in', () => {
  const live = view({
    stateObj: stateWith(1, { target_distance: 2.35 }),
    track: { seen: true, last: 2.35, changedAt: NOW - 1000 },
  });
  const stale = view({
    stateObj: stateWith(1, { target_distance: 2.35 }),
    track: { seen: true, last: 2.35 },
  });
  const far = view({
    stateObj: stateWith(1, { target_distance: 7.5 }),
    track: { seen: true, last: 7.5, changedAt: NOW - 1000 },
  });
  const waiting = view({ track: { startedAt: NOW - 1000 } });

  assert.equal(live.distance.text, '2,35 m');
  assert.equal(live.distance.status, 'live');
  assert.equal(live.distance.detail, 'nella fascia 2,25–2,5 m');
  assert.equal(typeof live.marker, 'string');
  assert.ok(live.bands[9].classes.includes('target'));
  assert.equal(stale.distance.text, '2,35 m');
  assert.equal(stale.distance.detail, 'ultimo valore, misura non in corso');
  assert.equal(stale.bands[9].classes.includes('target'), false);
  assert.equal(far.distance.text, 'oltre 6 m');
  assert.equal(waiting.distance.status, 'waiting');
  assert.equal(waiting.marker, null);
  assert.equal(view().distance.text, 'nessuna misura');
});

test('a configured but missing shared-state entity is reported', () => {
  const result = view({ appliedMissing: true });

  assert.deepEqual(bannerIds(result), ['applied-missing']);
  assert.equal(result.banners[0].kind, 'warning');
});

test('the written notice mentions the read-back queued together with the write', () => {
  const result = view({
    stateObj: stateWith(0b101),
    applied: { mask: 0b101, at: NOW - 60000, phase: 'written', confirmedAt: NOW - 1000 },
  });

  assert.match(result.banners[0].text, /rilettura/);
});

test('the title comes from the config', () => {
  assert.equal(view().title, 'FP300 · fp300_a');
});
