import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PASSWORD = 'correct-horse-battery';
const who = (phone, name = 'Test Player') => ({ name, phone });
let server;
let closeApp;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-spin-test-'));
  const app = await createApp({ dataDir, adminPassword: PASSWORD, databaseUrl: process.env.TEST_DATABASE_URL, log: () => {} });
  closeApp = app.close;
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeApp?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function cookieFrom(res) {
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function call(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}

async function login() {
  const { res } = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

test('public pages and security headers are served', async () => {
  const { res, data } = await call('/');
  assert.equal(res.status, 200);
  assert.match(data, /pharmkulen-logo\.png/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const admin = await call('/admin');
  assert.equal(admin.res.status, 200);
  assert.equal(admin.res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const traversal = await call('/../server.js');
  assert.notEqual(traversal.res.status, 200);
});

test('game config hides stock numbers', async () => {
  const { data } = await call('/api/game');
  assert.equal(data.status.open, true);
  assert.ok(data.segments.length >= 2);
  assert.equal(data.segments[0].quantity, undefined);
  assert.equal(data.segments[0].weight, undefined);
});

test('admin endpoints require authentication', async () => {
  for (const [p, m] of [['/api/admin/config', 'GET'], ['/api/admin/stats', 'GET'], ['/api/admin/export.csv', 'GET']]) {
    const { res } = await call(p, { method: m });
    assert.equal(res.status, 401, p);
  }
  const { res } = await call('/api/admin/config', { method: 'PUT', body: {} });
  assert.equal(res.status, 401);
});

test('wrong password is rejected, right one gives an HttpOnly session', async () => {
  const bad = await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(bad.res.status, 401);
  const good = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(good.res.status, 200);
  assert.match(good.res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});

test('cross-origin state changes are blocked', async () => {
  const { res } = await call('/api/admin/login', {
    method: 'POST', body: { password: PASSWORD }, headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});

test('spinning decrements stock, issues claim codes and is counted', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  // Make a deterministic wheel: one gift with 2 in stock and one unlimited message (weight 0).
  const config = cfgRes.config;
  config.segments = [
    { id: 'gift', label: 'Sticker', description: '', color: '#11BD9B', weight: 1, quantity: 2, isPrize: true },
    { id: 'msg', label: 'Try Again', description: '', color: '#62DBFF', weight: 0, quantity: null, isPrize: false },
  ];
  config.availability.spinsPerDevicePerDay = 0;
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.data));

  const s1 = await call('/api/spin', { method: 'POST', body: who('011100100') });
  assert.equal(s1.res.status, 200);
  assert.equal(s1.data.segment.id, 'gift');
  assert.match(s1.data.code, /^PK-[A-Z2-9]{6}$/);
  const player = cookieFrom(s1.res);
  const s2 = await call('/api/spin', { method: 'POST', body: who('011100100'), cookie: player });
  assert.equal(s2.res.status, 200);
  // Stock now 0 and nothing else has weight → closed.
  const s3 = await call('/api/spin', { method: 'POST', body: who('011100100'), cookie: player });
  assert.equal(s3.res.status, 409);
  assert.equal(s3.data.status.reason, 'no-outcomes');

  const { data: stats } = await call('/api/admin/stats', { cookie });
  assert.equal(stats.totals.spins, 2);
  assert.equal(stats.totals.prizesAwarded, 2);
  assert.equal(stats.segments.find((s) => s.id === 'gift').remaining, 0);

  // Redeem one and find it by code.
  const found = await call(`/api/admin/spins?q=${s1.data.code}`, { cookie });
  assert.equal(found.data.spins.length, 1);
  const red = await call(`/api/admin/spins/${found.data.spins[0].id}/redeem`, { method: 'POST', cookie, body: { redeemed: true } });
  assert.equal(red.data.spin.redeemed, true);

  const csv = await call('/api/admin/export.csv', { cookie });
  assert.match(csv.res.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, new RegExp(s1.data.code));
});

test('saving with an untouched stale quantity keeps the live stock', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.segments = [
    { id: 'gift', label: 'Sticker', description: '', color: '#11BD9B', weight: 1, quantity: 5, isPrize: true },
    { id: 'msg', label: 'Try Again', description: '', color: '#62DBFF', weight: 0, quantity: null, isPrize: false },
  ];
  let r = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  const version = r.data.version;
  const loaded = r.data.config;

  await call('/api/spin', { method: 'POST', body: who('011200200') }); // stock 5 → 4 while admin edits

  loaded.branding.title = 'Spin & Smile';
  loaded.segments.forEach((s) => (s.quantityLoaded = s.quantity));
  r = await call('/api/admin/config', { method: 'PUT', cookie, body: { version, config: loaded } });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.config.segments[0].quantity, 4);
  assert.equal(r.data.config.branding.title, 'Spin & Smile');

  // Stale version is rejected.
  const stale = await call('/api/admin/config', { method: 'PUT', cookie, body: { version, config: loaded } });
  assert.equal(stale.res.status, 409);
});

test('invalid config returns 422 with readable errors', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.branding.title = '';
  const r = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(r.res.status, 422);
  assert.ok(r.data.errors.some((e) => e.includes('Game title')));
});

test('daily spin limit per device is enforced', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.segments = [
    { id: 'a', label: 'Health Tip', description: '', color: '#19B2FF', weight: 1, quantity: null, isPrize: false },
    { id: 'b', label: 'Try Again', description: '', color: '#62DBFF', weight: 1, quantity: null, isPrize: false },
  ];
  config.availability.spinsPerDevicePerDay = 2;
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200);

  const s1 = await call('/api/spin', { method: 'POST', body: who('011300300') });
  const player = cookieFrom(s1.res);
  assert.equal(s1.data.spinsLeft, 1);
  const s2 = await call('/api/spin', { method: 'POST', body: who('011300300'), cookie: player });
  assert.equal(s2.data.spinsLeft, 0);
  const s3 = await call('/api/spin', { method: 'POST', body: who('011300300'), cookie: player });
  assert.equal(s3.res.status, 429);
});

test('password change signs out other sessions', async () => {
  const a = await login();
  const b = await login();
  const r = await call('/api/admin/password', { method: 'POST', cookie: a, body: { currentPassword: PASSWORD, newPassword: 'another-long-password' } });
  assert.equal(r.res.status, 200);
  const newA = cookieFrom(r.res);
  assert.equal((await call('/api/admin/stats', { cookie: b })).res.status, 401);
  assert.equal((await call('/api/admin/stats', { cookie: newA })).res.status, 200);
  // restore for other tests
  await call('/api/admin/password', { method: 'POST', cookie: newA, body: { currentPassword: 'another-long-password', newPassword: PASSWORD } });
});

test('admins can upload a segment image; others cannot; bad files are rejected', async () => {
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const anon = await fetch(`${base}/api/admin/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(anon.status, 401);

  const cookie = await login();
  const fake = await fetch(`${base}/api/admin/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: Buffer.from('<svg onload=alert(1)>') });
  assert.equal(fake.status, 415);

  const up = await fetch(`${base}/api/admin/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: png });
  assert.equal(up.status, 201);
  const { url } = await up.json();
  assert.match(url, /^\/uploads\/[a-f0-9]{24}\.png$/);

  const served = await fetch(base + url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/uploads/../db.json`)).status, 404);

  // Attach it to a segment and check players receive it.
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.segments[0].image = url;
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200);
  const { data: game } = await call('/api/game');
  assert.equal(game.segments[0].image, url);

  // Arbitrary URLs are refused.
  config.segments[0].image = 'https://evil.example/x.png';
  const bad = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: saved.data.version, config } });
  assert.equal(bad.res.status, 422);
});

test('spinning requires a name and valid phone; details are stored and exported', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.segments = [
    { id: 'gift', label: 'Sticker', description: '', color: '#11BD9B', weight: 1, quantity: null, isPrize: true },
    { id: 'msg', label: 'Try Again', description: '', color: '#62DBFF', weight: 0, quantity: null, isPrize: false },
  ];
  config.availability.spinsPerDevicePerDay = 1;
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200);

  const missing = await call('/api/spin', { method: 'POST', body: {} });
  assert.equal(missing.res.status, 422);
  assert.equal(missing.data.needDetails, true);
  assert.ok(missing.data.fields.name && missing.data.fields.phone);
  assert.equal(missing.data.fields.consent, undefined);

  const badPhone = await call('/api/spin', { method: 'POST', body: { name: 'Dara', phone: 'call me' } });
  assert.equal(badPhone.data.fields.phone !== undefined, true);

  const ok = await call('/api/spin', { method: 'POST', body: { name: '  សុខ   Dara ', phone: '012 345-678' } });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.spinsLeft, 0);

  // Limit follows the phone number, even from a different device (no cookie).
  const again = await call('/api/spin', { method: 'POST', body: who('012345678') });
  assert.equal(again.res.status, 429);
  // ...but a different person on the same shared device can still play.
  const other = await call('/api/spin', { method: 'POST', body: who('098765432', 'Sophea'), cookie: cookieFrom(ok.res) });
  assert.equal(other.res.status, 200);

  const found = await call('/api/admin/spins?q=345678', { cookie });
  assert.equal(found.data.spins[0].name, 'សុខ Dara');
  assert.equal(found.data.spins[0].phone, '012345678');

  const csv = await call('/api/admin/export.csv', { cookie });
  const rawCsv = Buffer.from(await (await fetch(`${base}/api/admin/export.csv`, { headers: { Cookie: cookie } })).arrayBuffer());
  assert.deepEqual([...rawCsv.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
  assert.match(csv.data, /Time,Name,Phone,Outcome/);
  assert.match(csv.data, /សុខ Dara,012345678,Sticker/);

  const xlsx = await fetch(`${base}/api/admin/export.xlsx`, { headers: { Cookie: cookie } });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // ZIP signature
  assert.ok(buf.includes(Buffer.from('xl/worksheets/sheet1.xml')));

  const anon = await fetch(`${base}/api/admin/export.xlsx`);
  assert.equal(anon.status, 401);
});

test('"in total" limit: a phone number can only play once, a new name and phone can play', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = cfgRes.config;
  config.segments = [
    { id: 'a', label: 'Health Tip', description: '', color: '#19B2FF', weight: 1, quantity: null, isPrize: false },
    { id: 'b', label: 'Try Again', description: '', color: '#62DBFF', weight: 1, quantity: null, isPrize: false },
  ];
  config.availability.spinsPerDevicePerDay = 1;
  config.availability.limitPeriod = 'total';
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.config.availability.limitPeriod, 'total');

  const game = await call('/api/game');
  assert.equal(game.data.limitPeriod, 'total');
  assert.equal(game.data.spinsPerDay, 1);

  const first = await call('/api/spin', { method: 'POST', body: who('015555001', 'Vanna') });
  assert.equal(first.res.status, 200);
  assert.equal(first.data.spinsLeft, 0);
  const device = cookieFrom(first.res);

  const repeat = await call('/api/spin', { method: 'POST', body: who('015 555 001', 'Vanna again'), cookie: device });
  assert.equal(repeat.res.status, 429);
  assert.equal(repeat.data.phoneUsed, true);
  assert.match(repeat.data.error, /different name and phone number/);

  const next = await call('/api/spin', { method: 'POST', body: who('015555002', 'Rithy'), cookie: device });
  assert.equal(next.res.status, 200);
});

test('spins can be filtered by day, and one day can be deleted', async () => {
  const cookie = await login();
  const today = (await call('/api/admin/stats', { cookie })).data.days.at(-1).day;

  const day = await call(`/api/admin/spins?day=${today}`, { cookie });
  assert.equal(day.res.status, 200);
  assert.ok(day.data.total > 0);
  assert.ok(day.data.spins.every((s) => s.at));
  const other = await call('/api/admin/spins?day=2000-01-01', { cookie });
  assert.equal(other.data.total, 0);
  assert.equal((await call('/api/admin/spins?day=yesterday', { cookie })).res.status, 400);

  // Search and day combine.
  const both = await call(`/api/admin/spins?day=${today}&q=015555001`, { cookie });
  assert.equal(both.data.total, 1);

  const noConfirm = await call('/api/admin/spins/delete-day', { method: 'POST', cookie, body: { day: today } });
  assert.equal(noConfirm.res.status, 400);
  const anon = await call('/api/admin/spins/delete-day', { method: 'POST', body: { day: today, confirm: 'DELETE' } });
  assert.equal(anon.res.status, 401);

  const del = await call('/api/admin/spins/delete-day', { method: 'POST', cookie, body: { day: today, confirm: 'DELETE' } });
  assert.equal(del.res.status, 200);
  assert.equal(del.data.deleted, day.data.total);
  assert.equal((await call(`/api/admin/spins?day=${today}`, { cookie })).data.total, 0);

  // The "in total" limit is counted from spins, so that player can play again.
  const again = await call('/api/spin', { method: 'POST', body: who('015555001', 'Vanna') });
  assert.equal(again.res.status, 200);
});

test('styles and scripts revalidate with an ETag', async () => {
  const first = await fetch(`${base}/css/base.css`);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await fetch(`${base}/css/base.css`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
});

test('the claw machine style can be chosen and is sent to players', async () => {
  const cookie = await login();
  const { data: cfgRes } = await call('/api/admin/config', { cookie });
  const config = { ...cfgRes.config, wheelStyle: 'claw' };
  const saved = await call('/api/admin/config', { method: 'PUT', cookie, body: { version: cfgRes.version, config } });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.config.wheelStyle, 'claw');
  assert.equal((await call('/api/game')).data.wheelStyle, 'claw');
});
