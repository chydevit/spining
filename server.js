// PharmKulen Spin — Node.js server.
// Serves the public game, the admin console and a small JSON API.
// Storage: PostgreSQL when DATABASE_URL is set (production / Render), otherwise data/db.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStorage } from './src/storage/index.js';
import { defaultConfig } from './src/defaults.js';
import {
  SessionManager, RateLimiter, hashPassword, verifyPassword, generatePassword,
  SESSION_TTL_MS, MIN_PASSWORD_LENGTH,
} from './src/auth.js';
import {
  validateConfig, availabilityStatus, computeOdds, drawSegment, isSegmentAvailable, claimCode, dayKey, validatePlayer,
} from './src/game.js';
import { buildXlsx } from './src/xlsx.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const ADMIN_COOKIE = 'pk_admin';
const PLAYER_COOKIE = 'pk_player';
const MAX_BODY = 64 * 1024;
const MAX_IMAGE = 1.5 * 1024 * 1024;
const UPLOAD_NAME = /^([a-f0-9]{24})\.(png|jpg|webp)$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/; // server-local day, as stored on each spin
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Identify an uploaded image by its magic bytes (never trust the declared type). */
function detectImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function createApp({
  dataDir = path.join(ROOT, 'data'), databaseUrl, adminPassword, trustProxy = false, secureCookies = false, log = console.log,
} = {}) {
  const store = createStorage({ dataDir, databaseUrl, log });
  const db = await store.init();
  const sessions = new SessionManager(store, log);
  sessions.load(await store.loadSessions());
  log(`[storage] using ${store.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `file ${path.join(dataDir, 'db.json')}`}`);
  const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  // Generous: many players may share one shop Wi-Fi IP. Per-device limits are separate.
  const spinLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 60 });

  // First run: starter wheel + admin password.
  if (!db.config) {
    db.config = defaultConfig();
    await store.saveConfig(db);
  }
  if (!db.admin) {
    const initial = adminPassword || generatePassword();
    db.admin = { password: hashPassword(initial), createdAt: new Date().toISOString() };
    await store.saveAdmin(db);
    if (!adminPassword) {
      log('\n  ┌──────────────────────────────────────────────────────────┐');
      log('  │  Admin account created. Sign in at /admin with:          │');
      log(`  │  Password: ${initial.padEnd(46)}│`);
      log('  │  Change it from Admin → Security after signing in.       │');
      log('  └──────────────────────────────────────────────────────────┘\n');
    }
  }

  // ---------- helpers ----------
  /** Save a change; if the database write fails, undo the in-memory change and report 503. */
  async function persist(write, undo) {
    try {
      await write();
    } catch (err) {
      undo?.();
      log('[storage] write failed:', err.message);
      throw new HttpError(503, 'Could not save right now. Please try again in a moment.');
    }
  }

  const configVersion = () => db.configUpdatedAt ?? 'initial';

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function isSecure(req) {
    return secureCookies || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function cookie(req, name, value, { maxAge, sameSite = 'Strict', path: p = '/' } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=${sameSite}`;
    if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
    if (isSecure(req)) c += '; Secure';
    return c;
  }

  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  async function readBody(req, limit, tooLarge = 'Request is too large.') {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, tooLarge);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected a JSON request.');
    const body = await readBody(req, MAX_BODY);
    if (!body.length) return {};
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Malformed JSON.');
    }
  }

  // Block cross-site state changes (in addition to SameSite cookies + JSON-only bodies).
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin.'); }
    const expected = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    if (host !== expected) throw new HttpError(403, 'Cross-site request blocked.');
  }

  function requireAdmin(req) {
    const token = parseCookies(req)[ADMIN_COOKIE];
    if (!sessions.validate(token)) throw new HttpError(401, 'Please sign in to continue.');
    return token;
  }

  function publicSegments() {
    const odds = computeOdds(db.config.segments);
    return db.config.segments.map((s, i) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      color: s.color,
      isPrize: s.isPrize,
      image: s.image ?? null,
      available: isSegmentAvailable(s),
      soldOut: s.quantity === 0,
      ...(db.config.showOdds ? { odds: odds[i] } : {}),
    }));
  }

  const collectsDetails = () => db.config.collectDetails !== false;

  // The daily limit counts per phone number when players enter their details
  // (works on a shared counter tablet), otherwise per browser cookie.
  const limitPeriod = () => (db.config.availability.limitPeriod === 'total' ? 'total' : 'day');

  /** Spins already used by this player in the current limit period (today, or the whole game). */
  function spinsUsed({ device, phone }) {
    const today = limitPeriod() === 'day' ? dayKey() : null;
    const byPhone = collectsDetails();
    let n = 0;
    for (let i = db.spins.length - 1; i >= 0; i--) {
      const s = db.spins[i];
      if (today && s.day !== today) break; // spins are stored chronologically
      if (byPhone ? phone && s.phone === phone : s.player === device) n++;
    }
    return n;
  }

  function spinsLeft(who) {
    const limit = db.config.availability.spinsPerDevicePerDay;
    if (!limit) return null; // unlimited
    return Math.max(0, limit - spinsUsed(who));
  }

  function publicSpin(s) {
    return {
      id: s.id, at: s.at, segmentId: s.segmentId, label: s.label, isPrize: s.isPrize, code: s.code, redeemed: s.redeemed,
      name: s.name ?? null, phone: s.phone ?? null,
    };
  }

  /** Server-local time as "YYYY-MM-DD HH:mm:ss" for spreadsheets. */
  function localStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function buildStats() {
    const today = dayKey();
    const segs = db.config.segments;
    const odds = computeOdds(segs);
    const hits = new Map();
    const hitsToday = new Map();
    const devicesToday = new Set();
    const phonesToday = new Set();
    const phones = new Set();
    let today_ = 0, prizes = 0, prizesToday = 0, redeemed = 0;
    for (const s of db.spins) {
      hits.set(s.segmentId, (hits.get(s.segmentId) ?? 0) + 1);
      if (s.phone) phones.add(s.phone);
      if (s.isPrize) prizes++;
      if (s.redeemed) redeemed++;
      if (s.day === today) {
        today_++;
        devicesToday.add(s.player);
        if (s.phone) phonesToday.add(s.phone);
        hitsToday.set(s.segmentId, (hitsToday.get(s.segmentId) ?? 0) + 1);
        if (s.isPrize) prizesToday++;
      }
    }
    const knownIds = new Set(segs.map((s) => s.id));
    const removedHits = [...hits].filter(([id]) => !knownIds.has(id)).reduce((a, [, n]) => a + n, 0);

    const days = [];
    const byDay = new Map();
    for (const s of db.spins) {
      const d = byDay.get(s.day) ?? { spins: 0, prizes: 0 };
      d.spins++;
      if (s.isPrize) d.prizes++;
      byDay.set(s.day, d);
    }
    for (let i = 13; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = dayKey(date);
      days.push({ day: key, ...(byDay.get(key) ?? { spins: 0, prizes: 0 }) });
    }

    return {
      totals: {
        spins: db.spins.length,
        spinsToday: today_,
        prizesAwarded: prizes,
        prizesToday,
        redeemed,
        devicesToday: devicesToday.size,
        playersToday: phonesToday.size,
        players: phones.size,
      },
      segments: segs.map((s, i) => ({
        id: s.id, label: s.label, color: s.color, isPrize: s.isPrize, weight: s.weight,
        remaining: s.quantity, available: isSegmentAvailable(s), odds: odds[i],
        hits: hits.get(s.id) ?? 0, hitsToday: hitsToday.get(s.id) ?? 0,
      })),
      removedSegmentHits: removedHits,
      days,
      recent: db.spins.slice(-25).reverse().map(publicSpin),
      status: availabilityStatus(db.config),
      generatedAt: new Date().toISOString(),
    };
  }

  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // defuse spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // ---------- routes ----------
  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

    // ----- public -----
    if (pathname === '/api/game' && method === 'GET') {
      const pid = parseCookies(req)[PLAYER_COOKIE];
      return send(res, 200, {
        branding: db.config.branding,
        showOdds: db.config.showOdds,
        segments: publicSegments(),
        status: availabilityStatus(db.config),
        collectDetails: collectsDetails(),
        wheelStyle: db.config.wheelStyle ?? 'classic',
        // With player details on, the count depends on the phone number, which we only see when they spin.
        spinsLeft: collectsDetails() ? null : spinsLeft({ device: pid }),
        spinsPerDay: db.config.availability.spinsPerDevicePerDay || null,
        limitPeriod: limitPeriod(),
        version: configVersion(),
      });
    }

    if (pathname === '/api/spin' && method === 'POST') {
      const body = await readJson(req);
      const limit = spinLimiter.check(clientIp(req));
      if (!limit.allowed) {
        throw new HttpError(429, 'Whoa, that was fast! Please wait a moment before spinning again.', { retryAfterMs: limit.retryAfterMs });
      }
      const headers = {};
      let pid = parseCookies(req)[PLAYER_COOKIE];
      if (!pid || !/^[A-Za-z0-9_-]{16,64}$/.test(pid)) {
        pid = crypto.randomBytes(16).toString('base64url');
        headers['Set-Cookie'] = cookie(req, PLAYER_COOKIE, pid, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'Lax' });
      }

      const status = availabilityStatus(db.config);
      if (!status.open) throw new HttpError(409, status.message, { status, headers });

      let player = { name: null, phone: null };
      if (collectsDetails()) {
        const checked = validatePlayer(body);
        const first = Object.values(checked.errors)[0];
        if (first) throw new HttpError(422, first, { fields: checked.errors, needDetails: true, headers });
        player = checked.player;
      }
      const who = { device: pid, phone: player.phone };

      const left = spinsLeft(who);
      if (left === 0) {
        const total = limitPeriod() === 'total';
        const msg = collectsDetails()
          ? total
            ? 'This phone number has already played. To spin again, please enter a different name and phone number.'
            : "This phone number has used all of today's spins. Come back tomorrow!"
          : total
            ? "You've used all your spins. Thanks for playing!"
            : "You've used all your spins for today. Come back tomorrow!";
        throw new HttpError(429, msg, { spinsLeft: 0, phoneUsed: collectsDetails(), headers });
      }

      const index = drawSegment(db.config.segments);
      if (index < 0) throw new HttpError(409, db.config.availability.closedMessage, { headers });
      const seg = db.config.segments[index];
      if (seg.quantity !== null) seg.quantity -= 1; // reserved now; rolled back if saving fails

      const now = new Date();
      const spin = {
        id: crypto.randomUUID(),
        at: now.toISOString(),
        day: dayKey(now),
        player: pid,
        name: player.name,
        phone: player.phone,
        segmentId: seg.id,
        label: seg.label,
        isPrize: seg.isPrize,
        code: seg.isPrize ? claimCode() : null,
        redeemed: false,
      };
      db.spins.push(spin);
      try {
        await store.addSpin(spin, db);
      } catch (err) {
        const at = db.spins.lastIndexOf(spin);
        if (at >= 0) db.spins.splice(at, 1);
        if (seg.quantity !== null) seg.quantity += 1;
        log('[storage] could not save spin:', err.message);
        throw new HttpError(503, 'We could not save your spin. Please try again in a moment.', { headers });
      }

      return send(res, 200, {
        index,
        segment: { id: seg.id, label: seg.label, description: seg.description, color: seg.color, isPrize: seg.isPrize, image: seg.image ?? null },
        code: spin.code,
        at: spin.at,
        spinsLeft: spinsLeft(who),
        version: configVersion(),
        wheelStyle: db.config.wheelStyle ?? 'classic',
        segments: publicSegments(),
      }, headers);
    }

    // ----- admin auth -----
    if (pathname === '/api/admin/session' && method === 'GET') {
      const token = parseCookies(req)[ADMIN_COOKIE];
      return send(res, 200, { authenticated: sessions.validate(token) });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const ip = clientIp(req);
      const limit = loginLimiter.check(ip);
      if (!limit.allowed) {
        const mins = Math.ceil(limit.retryAfterMs / 60000);
        throw new HttpError(429, `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
      const body = await readJson(req);
      const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      if (!verifyPassword(password, db.admin.password)) {
        throw new HttpError(401, 'That password is not correct.');
      }
      loginLimiter.reset(ip);
      const token = sessions.create();
      return send(res, 200, { ok: true }, {
        'Set-Cookie': cookie(req, ADMIN_COOKIE, token, { maxAge: SESSION_TTL_MS }),
      });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      sessions.destroy(parseCookies(req)[ADMIN_COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, ADMIN_COOKIE, '', { maxAge: 0 }) });
    }

    // ----- admin (authenticated) -----
    if (pathname.startsWith('/api/admin/')) {
      requireAdmin(req);

      if (pathname === '/api/admin/config' && method === 'GET') {
        return send(res, 200, { config: db.config, version: configVersion(), updatedAt: db.configUpdatedAt });
      }

      if (pathname === '/api/admin/config' && method === 'PUT') {
        const body = await readJson(req);
        if (body.version !== configVersion()) {
          throw new HttpError(409, 'Another admin saved changes since you loaded this page. Reload to see the latest settings.', { conflict: true });
        }
        const { config, errors } = validateConfig(body.config);
        if (errors.length) throw new HttpError(422, 'Please fix the highlighted problems.', { errors });

        // Stock keeps moving while players spin. If an admin didn't touch a quantity,
        // keep the live server value instead of overwriting it with a stale number.
        const loaded = new Map((body.config.segments ?? []).map((s) => [s?.id, s?.quantityLoaded]));
        const current = new Map(db.config.segments.map((s) => [s.id, s]));
        for (const seg of config.segments) {
          const live = current.get(seg.id);
          if (live && loaded.has(seg.id) && loaded.get(seg.id) !== undefined && seg.quantity === loaded.get(seg.id)) {
            seg.quantity = live.quantity;
          }
        }

        const before = { config: db.config, configUpdatedAt: db.configUpdatedAt };
        db.config = config;
        db.configUpdatedAt = new Date().toISOString();
        await persist(() => store.saveConfig(db), () => Object.assign(db, before));
        pruneUploads();
        return send(res, 200, { config: db.config, version: configVersion(), updatedAt: db.configUpdatedAt });
      }

      if (pathname === '/api/admin/uploads' && method === 'POST') {
        const type = req.headers['content-type'] ?? '';
        if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new HttpError(415, 'Upload a PNG, JPEG or WebP image.');
        const buf = await readBody(req, MAX_IMAGE, 'That image is too large. Please use one under 1.5 MB.');
        const ext = detectImage(buf);
        if (!ext) throw new HttpError(415, 'That file is not a PNG, JPEG or WebP image.');
        const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        await persist(() => store.putUpload(name, IMAGE_MIME[ext], buf));
        return send(res, 201, { url: `/uploads/${name}` });
      }

      if (pathname === '/api/admin/stats' && method === 'GET') {
        return send(res, 200, buildStats());
      }

      if (pathname === '/api/admin/spins' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().toUpperCase();
        const day = url.searchParams.get('day') ?? '';
        if (day && !DAY_KEY.test(day)) throw new HttpError(400, 'Day must look like 2026-10-16.');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const qDigits = q.replace(/[^\d]/g, '');
        const out = [];
        let total = 0;
        let prizes = 0;
        for (let i = db.spins.length - 1; i >= 0; i--) {
          const s = db.spins[i];
          if (day && s.day !== day) continue;
          const match = !q
            || (s.code && s.code.includes(q))
            || s.label.toUpperCase().includes(q)
            || (s.name && s.name.toUpperCase().includes(q))
            || (qDigits.length >= 3 && s.phone && s.phone.includes(qDigits));
          if (!match) continue;
          total++;
          if (s.isPrize) prizes++;
          if (out.length < limit) out.push(publicSpin(s));
        }
        return send(res, 200, { spins: out, total, prizes });
      }

      if (pathname === '/api/admin/spins/delete-day' && method === 'POST') {
        const body = await readJson(req);
        const day = String(body.day ?? '');
        if (!DAY_KEY.test(day)) throw new HttpError(400, 'Choose a day to delete.');
        if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
        const before = db.spins;
        const kept = before.filter((s) => s.day !== day);
        const deleted = before.length - kept.length;
        if (deleted) {
          db.spins = kept;
          await persist(() => store.deleteSpinsByDay(day, db), () => { db.spins = before; });
        }
        return send(res, 200, { deleted });
      }

      const redeemMatch = pathname.match(/^\/api\/admin\/spins\/([0-9a-f-]{36})\/redeem$/);
      if (redeemMatch && method === 'POST') {
        const body = await readJson(req);
        const spin = db.spins.find((s) => s.id === redeemMatch[1]);
        if (!spin) throw new HttpError(404, 'Spin not found.');
        if (!spin.isPrize) throw new HttpError(400, 'Only gift results can be marked as handed out.');
        const before = { redeemed: spin.redeemed, redeemedAt: spin.redeemedAt };
        spin.redeemed = body.redeemed !== false;
        spin.redeemedAt = spin.redeemed ? new Date().toISOString() : null;
        await persist(() => store.updateSpin(spin, db), () => Object.assign(spin, before));
        return send(res, 200, { spin: publicSpin(spin) });
      }

      if (pathname === '/api/admin/stats/reset' && method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
        const before = db.spins;
        db.spins = [];
        await persist(() => store.clearSpins(db), () => { db.spins = before; });
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/admin/password' && method === 'POST') {
        const body = await readJson(req);
        if (!verifyPassword(String(body.currentPassword ?? ''), db.admin.password)) {
          throw new HttpError(400, 'Your current password is not correct.', { field: 'currentPassword' });
        }
        const next = String(body.newPassword ?? '');
        if (next.length < MIN_PASSWORD_LENGTH || next.length > 200) {
          throw new HttpError(422, `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`, { field: 'newPassword' });
        }
        const before = { ...db.admin };
        db.admin.password = hashPassword(next);
        db.admin.changedAt = new Date().toISOString();
        await persist(() => store.saveAdmin(db), () => { db.admin = before; });
        await sessions.destroyAll(); // sign out every other device
        const token = sessions.create();
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, ADMIN_COOKIE, token, { maxAge: SESSION_TTL_MS }) });
      }

      if ((pathname === '/api/admin/export.csv' || pathname === '/api/admin/export.xlsx') && method === 'GET') {
        const header = ['Time', 'Name', 'Phone', 'Outcome', 'Gift', 'Claim code', 'Handed out', 'Handed out at', 'Device', 'Spin ID'];
        const rows = db.spins.map((s) => [
          localStamp(s.at), s.name ?? '', s.phone ?? '', s.label, s.isPrize ? 'Yes' : 'No', s.code ?? '',
          s.isPrize ? (s.redeemed ? 'Yes' : 'No') : '', localStamp(s.redeemedAt), s.player.slice(0, 8), s.id,
        ]);
        const stamp = dayKey();

        if (pathname.endsWith('.xlsx')) {
          const stats = buildStats();
          const summary = [
            ['Outcome', 'Type', 'Chance now', 'Landed today', 'Landed all time', 'Stock left'],
            ...stats.segments.map((x) => [
              x.label, x.isPrize ? 'Gift' : 'Message', `${(x.odds * 100).toFixed(1)}%`, x.hitsToday, x.hits,
              x.remaining === null ? 'Unlimited' : x.remaining,
            ]),
          ];
          const file = buildXlsx([
            { name: 'Spins', rows: [header, ...rows], widths: [20, 24, 16, 18, 8, 14, 12, 20, 11, 38] },
            { name: 'Summary', rows: summary, widths: [22, 10, 12, 14, 16, 12] },
          ]);
          return send(res, 200, file, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="pharmkulen-spins-${stamp}.xlsx"`,
          });
        }

        const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
        // BOM so Excel opens Khmer and other non-Latin names correctly.
        return send(res, 200, '\uFEFF' + csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="pharmkulen-spins-${stamp}.csv"`,
        });
      }
    }

    throw new HttpError(404, 'Not found.');
  }

  // Remove uploaded images no segment uses any more (after a grace period, so
  // images uploaded into another admin's unsaved draft are not lost).
  function pruneUploads() {
    const used = new Set(db.config.segments.map((s) => s.image).filter(Boolean).map((u) => u.slice('/uploads/'.length)));
    store.pruneUploads(used, Date.now() - 24 * 60 * 60 * 1000)
      .catch((err) => log('[storage] could not prune uploads:', err.message));
  }

  async function serveUpload(req, res, url) {
    const m = url.pathname.slice('/uploads/'.length).match(UPLOAD_NAME);
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, 'Not found');
    const file = await store.getUpload(m[0]);
    if (!file) return send(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': IMAGE_MIME[m[2]],
      'Content-Length': file.data.length,
      'Cache-Control': 'public, max-age=86400, immutable', // names are random and never reused
    });
    res.end(req.method === 'HEAD' ? undefined : file.data);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
    if (rel === '/') rel = '/index.html';
    else if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      const ext = path.extname(file);
      // Pages, styles and scripts are revalidated on every load (cheap 304s), so an update
      // shows up immediately instead of mixing new HTML with a cached old stylesheet.
      const revalidate = ext === '.html' || ext === '.css' || ext === '.js';
      const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=300',
        ETag: etag,
      };
      if (rel.startsWith('/admin')) headers['X-Robots-Tag'] = 'noindex, nofollow';
      if (req.headers['if-none-match'] === etag) {
        delete headers['Content-Type'];
        delete headers['Content-Length'];
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/uploads/')) return await serveUpload(req, res, url);
      if (url.pathname === '/healthz') {
        try {
          await store.ping();
          return send(res, 200, { ok: true, storage: store.kind });
        } catch {
          return send(res, 503, { ok: false });
        }
      }
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        const { headers = {}, ...extra } = err.extra;
        return send(res, err.status, { error: err.message, ...extra }, headers);
      }
      console.error(err);
      return send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  }

  return { handler, store, db, sessions, close: () => store.close() };
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = await createApp({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    databaseUrl: process.env.DATABASE_URL || undefined,
    adminPassword: process.env.ADMIN_PASSWORD,
    trustProxy: process.env.TRUST_PROXY === '1',
    secureCookies: process.env.COOKIE_SECURE === '1',
  });
  const server = http.createServer(app.handler);
  server.listen(port, host, () => {
    console.log(`PharmKulen Spin running → http://localhost:${port}  (admin: http://localhost:${port}/admin)`);
  });

  // Render (and Docker) send SIGTERM before stopping: finish requests, then close the database.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down…`);
    server.close(async () => {
      await app.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
