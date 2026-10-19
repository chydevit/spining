// Accounts and companies: sign-up, ownership, isolation between companies, and the move from
// the old single-company data file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { freshDatabase } from './helpers.js';
import { hashPassword } from '../src/auth.js';
import { defaultConfig } from '../src/defaults.js';
import { slugify, validateCompany } from '../src/tenancy.js';

let server;
let base;
let dataDir;
let closeApp;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-tenancy-'));
  const app = await createApp({ dataDir, databaseUrl: await freshDatabase(), log: () => {} });
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

/** A tiny browser: keeps cookies between calls. */
function client() {
  const jar = new Map();
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(';')[0].split('=');
      if (v) jar.set(k, v); else jar.delete(k);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

async function signup(name, email) {
  const c = client();
  const r = await c('/api/auth/signup', { method: 'POST', body: { name, email, password: 'password123' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

test('company links are made from names and checked', () => {
  assert.equal(slugify('Sunrise Café & Bakery!'), 'sunrise-cafe-bakery');
  assert.equal(validateCompany({ name: 'Ok shop', slug: 'admin' }).errors.slug, 'That link is reserved. Please choose another.');
  assert.ok(validateCompany({ name: 'Ok shop', slug: '-bad' }).errors.slug);
  assert.ok(validateCompany({ name: 'X' }).errors.name);
  assert.deepEqual(validateCompany({ name: 'Ok shop' }, { slugTaken: () => false }).errors, {});
});

test('sign-up validates input and refuses a duplicate email', async () => {
  const c = client();
  const bad = await c('/api/auth/signup', { method: 'POST', body: { name: 'A', email: 'nope', password: 'short' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.fields.name && bad.data.fields.email && bad.data.fields.password);
  await signup('First Owner', 'dup@example.com');
  const again = await client()('/api/auth/signup', { method: 'POST', body: { name: 'Other', email: 'DUP@example.com', password: 'password123' } });
  assert.equal(again.status, 422);
  assert.match(again.data.fields.email, /already exists/);
});

test('a new user creates a company, customises it and players play it', async () => {
  const owner = await signup('Sok Dara', 'dara@example.com');
  const me = await owner('/api/auth/session');
  assert.equal(me.data.user.email, 'dara@example.com');

  const created = await owner('/api/companies', { method: 'POST', body: { name: 'Sunrise Café' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.company.slug, 'sunrise-cafe');
  assert.equal((await owner('/api/companies/check-slug?slug=sunrise-cafe')).data.available, false);
  assert.equal((await owner('/api/companies', { method: 'POST', body: { name: 'Again', slug: 'sunrise-cafe' } })).status, 422);

  // Starter game, worded for this company and without PharmKulen artwork.
  const player = client();
  const game = await player('/api/c/sunrise-cafe/game');
  assert.equal(game.status, 200);
  assert.deepEqual(game.data.company, { name: 'Sunrise Café', slug: 'sunrise-cafe', brand: 'generic' });
  assert.match(game.data.branding.tagline, /Sunrise Café/);
  assert.ok(!JSON.stringify(game.data).includes('PharmKulen'));

  // The owner customises it.
  const cfg = await owner('/api/c/sunrise-cafe/admin/config');
  assert.equal(cfg.status, 200);
  cfg.data.config.branding.title = 'Lucky Café Spin';
  cfg.data.config.wheelStyle = 'festival';
  const saved = await owner('/api/c/sunrise-cafe/admin/config', { method: 'PUT', body: { version: cfg.data.version, config: cfg.data.config } });
  assert.equal(saved.status, 200);
  const after = await player('/api/c/sunrise-cafe/game');
  assert.equal(after.data.branding.title, 'Lucky Café Spin');
  assert.equal(after.data.wheelStyle, 'festival');

  const spin = await player('/api/c/sunrise-cafe/spin', { method: 'POST', body: { name: 'Vanna', phone: '012345678' } });
  assert.equal(spin.status, 200);
  const stats = await owner('/api/c/sunrise-cafe/admin/stats');
  assert.equal(stats.data.totals.spins, 1);
  const list = await owner('/api/companies');
  assert.equal(list.data.companies.length, 1);
  assert.equal(list.data.companies[0].spinsToday, 1);
});

test("companies are kept apart: no access to another owner's admin, separate spins and limits", async () => {
  const a = await signup('Owner A', 'a@example.com');
  const b = await signup('Owner B', 'b@example.com');
  await a('/api/companies', { method: 'POST', body: { name: 'Shop A', slug: 'shop-a' } });
  await b('/api/companies', { method: 'POST', body: { name: 'Shop B', slug: 'shop-b' } });

  for (const p of ['/api/c/shop-a/admin/config', '/api/c/shop-a/admin/stats', '/api/c/shop-a/admin/export.xlsx']) {
    assert.equal((await b(p)).status, 403, p);
  }
  assert.equal((await client()('/api/c/shop-a/admin/config')).status, 401);
  const session = await b('/api/c/shop-a/admin/session');
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.allowed, false);
  assert.deepEqual((await b('/api/companies')).data.companies.map((c) => c.slug), ['shop-b']);
  assert.equal((await b('/api/companies/shop-a', { method: 'PUT', body: { name: 'Hacked' } })).status, 404);

  // The same phone number plays once in each company (the default limit is one spin per phone).
  const player = client();
  assert.equal((await player('/api/c/shop-a/spin', { method: 'POST', body: { name: 'Lina', phone: '099111222' } })).status, 200);
  assert.equal((await player('/api/c/shop-a/spin', { method: 'POST', body: { name: 'Lina', phone: '099111222' } })).status, 429);
  assert.equal((await player('/api/c/shop-b/spin', { method: 'POST', body: { name: 'Lina', phone: '099111222' } })).status, 200);
  assert.equal((await a('/api/c/shop-a/admin/stats')).data.totals.spins, 1);
  assert.equal((await b('/api/c/shop-b/admin/stats')).data.totals.spins, 1);
});

test('owners can rename and delete a company; profile and password changes work', async () => {
  const c = await signup('Renamer', 'renamer@example.com');
  await c('/api/companies', { method: 'POST', body: { name: 'Old Name', slug: 'old-name' } });
  const renamed = await c('/api/companies/old-name', { method: 'PUT', body: { name: 'New Name' } });
  assert.equal(renamed.data.company.name, 'New Name');
  assert.equal((await client()('/api/c/old-name/game')).data.company.name, 'New Name');

  assert.equal((await c('/api/companies/old-name', { method: 'DELETE', body: { confirm: 'wrong' } })).status, 400);
  assert.equal((await c('/api/companies/old-name', { method: 'DELETE', body: { confirm: 'old-name' } })).status, 200);
  assert.equal((await client()('/api/c/old-name/game')).status, 404);
  assert.equal((await fetch(`${base}/c/old-name`)).status, 404);

  const profile = await c('/api/auth/profile', { method: 'PUT', body: { name: 'Renamed Owner', email: 'renamed@example.com' } });
  assert.equal(profile.data.user.email, 'renamed@example.com');
  const pw = await c('/api/auth/password', { method: 'POST', body: { currentPassword: 'password123', newPassword: 'newpassword456' } });
  assert.equal(pw.status, 200);
  const fresh = client();
  assert.equal((await fresh('/api/auth/login', { method: 'POST', body: { email: 'renamed@example.com', password: 'newpassword456' } })).status, 200);
  assert.equal((await c('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await c('/api/companies')).status, 401);
});

test('an old single-game data file becomes the PharmKulen company, keeping spins and password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-legacy-'));
  const config = defaultConfig();
  config.branding.title = 'Legacy Title';
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 1,
    config,
    configUpdatedAt: '2026-01-01T00:00:00.000Z',
    admin: { password: hashPassword('old-admin-pass') },
    spins: [{ id: '00000000-0000-4000-8000-000000000001', at: '2026-01-02T03:04:05.000Z', day: '2026-01-02', player: 'p'.repeat(20), name: 'Old', phone: '012000000', segmentId: 'seg-tote', label: 'Tote Bag', isPrize: true, code: 'PK-OLD123', redeemed: false }],
  }));
  const app = await createApp({ dataDir: dir, log: () => {} });
  const srv = http.createServer(app.handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const game = await (await fetch(`${url}/api/c/pharmkulen/game`)).json();
    assert.equal(game.branding.title, 'Legacy Title');
    assert.equal(game.company.brand, 'pharmkulen');
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@pharmkulen.local', password: 'old-admin-pass' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const stats = await (await fetch(`${url}/api/c/pharmkulen/admin/stats`, { headers: { Cookie: cookie } })).json();
    assert.equal(stats.totals.spins, 1);
    assert.ok(fs.existsSync(path.join(dir, 'db.json.v1-backup')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).version, 2);
  } finally {
    srv.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
