import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, computeOdds, drawSegment, availabilityStatus } from '../src/game.js';
import { defaultConfig } from '../src/defaults.js';

test('default config passes validation', () => {
  const { errors } = validateConfig(defaultConfig());
  assert.deepEqual(errors, []);
});

test('validation rejects bad segments and keeps a useful message', () => {
  const cfg = defaultConfig();
  cfg.segments = [{ label: '', color: 'red', weight: -1, quantity: 1.5 }];
  const { errors } = validateConfig(cfg);
  assert.ok(errors.some((e) => e.includes('at least 2 segments')));
  assert.ok(errors.some((e) => e.includes('label is required')));
  assert.ok(errors.some((e) => e.includes('valid colour')));
  assert.ok(errors.some((e) => e.includes('weight')));
  assert.ok(errors.some((e) => e.includes('quantity')));
});

test('validation requires end after start', () => {
  const cfg = defaultConfig();
  cfg.availability.startAt = '2030-01-02T00:00:00Z';
  cfg.availability.endAt = '2030-01-01T00:00:00Z';
  assert.ok(validateConfig(cfg).errors.some((e) => e.includes('End time')));
});

test('odds exclude out-of-stock and zero-weight segments', () => {
  const segs = [
    { weight: 1, quantity: null },
    { weight: 3, quantity: 0 },
    { weight: 0, quantity: null },
    { weight: 3, quantity: 5 },
  ];
  assert.deepEqual(computeOdds(segs), [0.25, 0, 0, 0.75]);
});

test('drawSegment never returns unavailable segments and follows weights', () => {
  const segs = [
    { weight: 1, quantity: null },
    { weight: 50, quantity: 0 },
    { weight: 3, quantity: 10 },
  ];
  const counts = [0, 0, 0];
  for (let i = 0; i < 20000; i++) counts[drawSegment(segs)]++;
  assert.equal(counts[1], 0);
  const ratio = counts[2] / counts[0];
  assert.ok(ratio > 2.6 && ratio < 3.4, `ratio was ${ratio}`);
});

test('drawSegment is exact at the boundaries', () => {
  const segs = [{ weight: 1, quantity: null }, { weight: 2, quantity: null }];
  assert.equal(drawSegment(segs, () => 0), 0);
  assert.equal(drawSegment(segs, () => 99), 0);
  assert.equal(drawSegment(segs, () => 100), 1);
  assert.equal(drawSegment(segs, () => 299), 1);
});

test('availability respects switch, schedule and stock', () => {
  const cfg = defaultConfig();
  assert.equal(availabilityStatus(cfg).open, true);
  cfg.availability.enabled = false;
  assert.equal(availabilityStatus(cfg).reason, 'disabled');
  cfg.availability.enabled = true;
  cfg.availability.startAt = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(availabilityStatus(cfg).reason, 'not-started');
  cfg.availability.startAt = null;
  cfg.availability.endAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(availabilityStatus(cfg).reason, 'ended');
  cfg.availability.endAt = null;
  cfg.segments.forEach((s) => (s.quantity = 0));
  assert.equal(availabilityStatus(cfg).reason, 'no-outcomes');
});

test('wheel style is validated against the presets', async () => {
  const { STYLE_IDS, resolveColors, getStyle } = await import('../public/js/styles.js');
  const cfg = defaultConfig();
  cfg.wheelStyle = 'festival';
  assert.equal(validateConfig(cfg).config.wheelStyle, 'festival');
  cfg.wheelStyle = '<script>';
  assert.equal(validateConfig(cfg).config.wheelStyle, 'classic');
  assert.ok(STYLE_IDS.length >= 8);
  // No two neighbouring segments share a colour, including where the wheel wraps around.
  for (const id of STYLE_IDS) {
    for (const n of [2, 3, 5, 7, 8, 9]) {
      const segs = Array.from({ length: n }, (_, i) => ({ color: ['#111111', '#222222', '#333333'][i % 3] }));
      const colors = resolveColors(getStyle(id), segs);
      if (getStyle(id).palette && !getStyle(id).palette.gradient) {
        for (let i = 0; i < n; i++) assert.notEqual(colors[i], colors[(i + 1) % n], `${id} n=${n} i=${i}`);
      }
    }
  }
});
