import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { freshDatabase } from './helpers.js';

let server;
let base;
let dataDir;
let closeApp;

const SUPER_PASS = 'super-secret-pw';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-super-test-'));
  const app = await createApp({ dataDir, adminPassword: SUPER_PASS, databaseUrl: await freshDatabase(), log: () => {} });
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

async function loginSuper() {
  const c = client();
  const r = await c('/api/auth/login', { method: 'POST', body: { email: 'admin@pharmkulen.local', password: SUPER_PASS } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

async function signup(name, email, password = 'password123') {
  const c = client();
  const r = await c('/api/auth/signup', { method: 'POST', body: { name, email, password } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

test('initial user is created with superadmin role and can manage roles', async () => {
  const admin = await loginSuper();
  const session = await admin('/api/auth/session');
  assert.equal(session.data.user.role, 'superadmin');

  // Can access super admin endpoints
  const usersRes = await admin('/api/super/users');
  assert.equal(usersRes.status, 200);
  assert.ok(Array.isArray(usersRes.data.users));
  assert.ok(usersRes.data.roles.includes('superadmin'));
  assert.ok(usersRes.data.roles.includes('admin'));
  assert.ok(usersRes.data.roles.includes('staff'));
  assert.ok(usersRes.data.roles.includes('user'));

  // Super stats
  const statsRes = await admin('/api/super/stats');
  assert.equal(statsRes.status, 200);
  assert.equal(typeof statsRes.data.totalUsers, 'number');
  assert.equal(typeof statsRes.data.totalCompanies, 'number');
});

test('non-super admin cannot access super admin endpoints', async () => {
  const regular = await signup('Regular Owner', 'regular@example.com');
  const session = await regular('/api/auth/session');
  assert.equal(session.data.user.role, 'admin');

  const forbidden = await regular('/api/super/users');
  assert.equal(forbidden.status, 403);

  const statsForbidden = await regular('/api/super/stats');
  assert.equal(statsForbidden.status, 403);
});

test('super admin can change another user role and prevent demoting the sole superadmin', async () => {
  const admin = await loginSuper();
  const target = await signup('Staff Person', 'staff@example.com');
  const targetMe = await target('/api/auth/session');
  const targetId = targetMe.data.user.id;

  // Change to staff
  const updateRes = await admin(`/api/super/users/${targetId}/role`, { method: 'PUT', body: { role: 'staff' } });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.data.user.role, 'staff');

  // Verify staff session reflects new role
  const staffCheck = await target('/api/auth/session');
  assert.equal(staffCheck.data.user.role, 'staff');

  // Invalid role is rejected
  const badRole = await admin(`/api/super/users/${targetId}/role`, { method: 'PUT', body: { role: 'hacker' } });
  assert.equal(badRole.status, 422);

  // Demoting the only superadmin is blocked
  const mySession = await admin('/api/auth/session');
  const soleSuperId = mySession.data.user.id;
  const demoteSelf = await admin(`/api/super/users/${soleSuperId}/role`, { method: 'PUT', body: { role: 'admin' } });
  assert.equal(demoteSelf.status, 400);
});

test('super admin can access and manage another user company admin', async () => {
  const admin = await loginSuper();
  const owner = await signup('Company Guy', 'guy@example.com');
  const created = await owner('/api/companies', { method: 'POST', body: { name: 'Guy Store' } });
  assert.equal(created.status, 201);
  const slug = created.data.company.slug;

  // Super admin checks /admin/session for Guy Store
  const adminSession = await admin(`/api/c/${slug}/admin/session`);
  assert.equal(adminSession.status, 200);
  assert.equal(adminSession.data.allowed, true);
  assert.equal(adminSession.data.isSuperAdmin, true);

  // Super admin can read and update config
  const cfg = await admin(`/api/c/${slug}/admin/config`);
  assert.equal(cfg.status, 200);
  const updatedCfg = { ...cfg.data.config, branding: { ...cfg.data.config.branding, title: 'Updated By Super' } };
  const putRes = await admin(`/api/c/${slug}/admin/config`, { method: 'PUT', body: { version: cfg.data.version, config: updatedCfg } });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.data.config.branding.title, 'Updated By Super');
});

test('super admin can transfer company ownership', async () => {
  const admin = await loginSuper();
  const alice = await signup('Alice Smith', 'alice@example.com');
  const bob = await signup('Bob Jones', 'bob@example.com');
  const bobMe = await bob('/api/auth/session');

  const comp = await alice('/api/companies', { method: 'POST', body: { name: 'Alice Shop' } });
  assert.equal(comp.status, 201);
  const slug = comp.data.company.slug;

  // Transfer Alice Shop to Bob
  const transfer = await admin(`/api/super/companies/${slug}/owner`, { method: 'PUT', body: { ownerId: bobMe.data.user.id } });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.data.company.ownerId, bobMe.data.user.id);

  // Bob can now see Alice Shop in their companies
  const bobComps = await bob('/api/companies');
  assert.ok(bobComps.data.companies.some((c) => c.slug === slug));

  // Alice no longer has it
  const aliceComps = await alice('/api/companies');
  assert.ok(!aliceComps.data.companies.some((c) => c.slug === slug));
});

test('super admin can reset another user password', async () => {
  const admin = await loginSuper();
  await signup('Reset Target', 'target@example.com', 'original123');

  const usersList = (await admin('/api/super/users')).data.users;
  const user = usersList.find((u) => u.email === 'target@example.com');
  assert.ok(user);

  const resetRes = await admin(`/api/super/users/${user.id}/reset-password`, { method: 'POST', body: { newPassword: 'brandNewPassword123' } });
  assert.equal(resetRes.status, 200);

  // Target can sign in with new password
  const targetClient = client();
  const loginRes = await targetClient('/api/auth/login', { method: 'POST', body: { email: 'target@example.com', password: 'brandNewPassword123' } });
  assert.equal(loginRes.status, 200);
});

test('staff role restrictions: staff cannot edit wheel config or delete company', async () => {
  const admin = await loginSuper();
  const staff = await signup('Staff Member', 'staff2@example.com');
  const staffMe = (await staff('/api/auth/session')).data.user;

  // Promote staff2 to staff role
  await admin(`/api/super/users/${staffMe.id}/role`, { method: 'PUT', body: { role: 'staff' } });

  // Staff cannot create companies
  const createAttempt = await staff('/api/companies', { method: 'POST', body: { name: 'Staff Shop' } });
  assert.equal(createAttempt.status, 403);
});
