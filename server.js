// Spin — Node.js server for many companies.
// Anyone can sign up, create a company and customise its own game. Pages:
//   /                 landing page (or HOME_COMPANY's game)      /login   sign in / sign up
//   /account          your companies, create a company, account   /c/<slug>  a company's game
//   /c/<slug>/admin   that company's admin (owner only)
// Storage: PostgreSQL when DATABASE_URL is set (production / Render), otherwise data/db.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStorage } from './src/storage/index.js';
import { defaultConfig } from './src/defaults.js';
import { SessionManager, RateLimiter, hashPassword, verifyPassword, SESSION_TTL_MS } from './src/auth.js';
import {
  MIN_PASSWORD_LENGTH, validateSignup, validateEmail, validateCompany, normalizeEmail, newUser, newCompany, legacyToTenancy,
  ROLES, ROLE_LABELS, validateRole,
} from './src/tenancy.js';

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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
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

const SESSION_COOKIE = 'pk_session';
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
  dataDir = path.join(ROOT, 'data'), databaseUrl, adminPassword, homeCompany = null,
  trustProxy = false, secureCookies = false, log = console.log,
} = {}) {
  const store = createStorage({ dataDir, databaseUrl, log });
  const loaded = await store.init();
  log(`[storage] using ${store.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `file ${path.join(dataDir, 'db.json')}`}`);

  // Everything lives in memory and is written through to storage on every change.
  const users = new Map(loaded.users.map((u) => [u.id, u]));
  const usersByEmail = new Map(loaded.users.map((u) => [u.email, u]));
  const companies = new Map(loaded.companies.map((c) => [c.id, c]));
  const companiesBySlug = new Map(loaded.companies.map((c) => [c.slug, c]));
  // The file store keeps one big object; keep its lists pointing at the same records.
  const fileLists = store.kind === 'file' ? loaded : null;

  const sessions = new SessionManager(store, log);
  sessions.load(await store.loadSessions());
  const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const signupLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  // Generous: many players may share one shop Wi-Fi IP. Per-device limits are separate.
  const spinLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 60 });
  // Compared against when an email is unknown, so a failed sign-in takes the same time either way.
  const dummyPassword = hashPassword(crypto.randomBytes(16).toString('hex'));

  // An empty install with ADMIN_PASSWORD set starts with the PharmKulen company, as before.
  if (!users.size && adminPassword) {
    const { user, company } = legacyToTenancy({ config: defaultConfig(), configUpdatedAt: null, admin: { password: hashPassword(adminPassword) } });
    await addUser(user);
    await addCompany(company);
    log(`[setup] created company "${company.slug}" owned by ${user.email} (password from ADMIN_PASSWORD)`);
  }

  // Ensure there is at least one superadmin in the system
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'admin@pharmkulen.local').toLowerCase();
  let hasSuper = false;
  for (const u of users.values()) {
    if (u.role === 'superadmin') {
      hasSuper = true;
      break;
    }
  }
  if (!hasSuper && users.size > 0) {
    const designated = usersByEmail.get(superAdminEmail) || users.values().next().value;
    if (designated) {
      designated.role = 'superadmin';
      await store.saveUser(designated);
      log(`[auth] designated ${designated.email} as Super Admin`);
    }
  }
  if (process.env.SUPER_ADMIN_EMAIL) {
    const explicit = usersByEmail.get(process.env.SUPER_ADMIN_EMAIL.toLowerCase());
    if (explicit && explicit.role !== 'superadmin') {
      explicit.role = 'superadmin';
      await store.saveUser(explicit);
      log(`[auth] promoted ${explicit.email} to Super Admin (via SUPER_ADMIN_EMAIL)`);
    }
  }

  async function addUser(user) {
    users.set(user.id, user);
    usersByEmail.set(user.email, user);
    fileLists?.users.push(user);
    await store.saveUser(user);
  }


  async function addCompany(company) {
    companies.set(company.id, company);
    companiesBySlug.set(company.slug, company);
    fileLists?.companies.push(company);
    await store.saveCompany(company);
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

  function currentUser(req) {
    const id = sessions.userFor(parseCookies(req)[SESSION_COOKIE]);
    return id ? users.get(id) ?? null : null;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Please sign in to continue.');
    return user;
  }

  function requireOwner(req, company, action = 'view') {
    const user = requireUser(req);
    if (user.role === 'superadmin') return user;
    if (company.ownerId !== user.id) throw new HttpError(403, "You don't have access to this company's admin.", { forbidden: true });
    if (user.role === 'staff' && (action === 'edit' || action === 'delete' || action === 'reset')) {
      throw new HttpError(403, 'Staff members cannot modify wheel settings or delete data.', { forbidden: true });
    }
    return user;
  }

  function requireSuperAdmin(req) {
    const user = requireUser(req);
    if (user.role !== 'superadmin') throw new HttpError(403, 'Super admin access required.', { forbidden: true });
    return user;
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role || 'admin' });

  function signIn(req, user) {
    const token = sessions.create(user.id);
    return { token, cookie: cookie(req, SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS }) };
  }

  function companySummary(c) {
    const today = dayKey();
    let spinsToday = 0;
    for (let i = c.spins.length - 1; i >= 0 && c.spins[i].day === today; i--) spinsToday++;
    const owner = users.get(c.ownerId);
    return {
      id: c.id, name: c.name, slug: c.slug, brand: c.brand, createdAt: c.createdAt,
      ownerId: c.ownerId,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email, role: owner.role || 'admin' } : null,
      title: c.config.branding.title, logo: c.config.branding.logo ?? null, icon: c.config.branding.icon ?? null,
      wheelStyle: c.config.wheelStyle ?? 'classic', open: availabilityStatus(c.config).open,
      spins: c.spins.length, spinsToday,
    };
  }


  // ---------- one company's game + admin ----------
  const tenants = new WeakMap();
  function tenant(db) {
    let t = tenants.get(db);
    if (!t) tenants.set(db, (t = makeTenant(db)));
    return t;
  }

  function makeTenant(db) {
    const configVersion = () => db.configUpdatedAt ?? 'initial';

    /**
     * The segments players see. Hidden ones are always left out. With "hide unavailable" on,
     * out-of-stock and switched-off ones are too, unless that would leave nothing (the game shows
     * as closed then anyway).
     */
    function publicSegments() {
      const odds = computeOdds(db.config.segments);
      const all = db.config.segments.flatMap((s, i) => (s.hidden ? [] : [{
        id: s.id,
        label: s.label,
        description: s.description,
        color: s.color,
        isPrize: s.isPrize,
        image: s.image ?? null,
        imageBg: s.imageBg ?? null,
        available: isSegmentAvailable(s),
        soldOut: s.quantity === 0,
        ...(db.config.showOdds ? { odds: odds[i] } : {}),
      }]));
      if (!db.config.hideUnavailable) return all;
      const shown = all.filter((s) => s.available);
      return shown.length ? shown : all;
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

    // Remove uploaded images this company no longer uses (after a grace period, so
    // images uploaded into an unsaved draft are not lost).
    function pruneUploads() {
      const images = [...db.config.segments.map((s) => s.image), db.config.branding.logo, db.config.branding.icon];
      const used = new Set(images.filter(Boolean).map((u) => u.slice('/uploads/'.length)));
      store.pruneUploads(db.id, used, Date.now() - 24 * 60 * 60 * 1000)
        .catch((err) => log('[storage] could not prune uploads:', err.message));
    }

    /** `sub` is the path after /api/c/<slug>, e.g. "/game" or "/admin/config". */
    async function handle(req, res, url, sub) {
      const method = req.method;

      // ----- public -----
      if (sub === '/game' && method === 'GET') {
        const pid = parseCookies(req)[PLAYER_COOKIE];
        return send(res, 200, {
          company: { name: db.name, slug: db.slug, brand: db.brand },
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

      if (sub === '/spin' && method === 'POST') {
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

        const drawn = drawSegment(db.config.segments);
        if (drawn < 0) throw new HttpError(409, db.config.availability.closedMessage, { headers });
        const seg = db.config.segments[drawn];
        // The wheel as players saw it for this spin, and where the result is on it. Taken before the
        // stock changes: with sold-out gifts hidden, this gift's slice may disappear after the spin.
        const wheel = publicSegments();
        const index = wheel.findIndex((s) => s.id === seg.id);
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
          segment: { id: seg.id, label: seg.label, description: seg.description, color: seg.color, isPrize: seg.isPrize, image: seg.image ?? null, imageBg: seg.imageBg ?? null },
          code: spin.code,
          at: spin.at,
          spinsLeft: spinsLeft(who),
          version: configVersion(),
          wheelStyle: db.config.wheelStyle ?? 'classic',
          wheel, // spin on these…
          segments: publicSegments(), // …then show these (stock after this spin)
        }, headers);
      }

      // ----- admin (company owner or super admin) -----
      if (sub === '/admin/session' && method === 'GET') {
        const user = currentUser(req);
        return send(res, 200, {
          authenticated: !!user,
          allowed: !!user && (user.role === 'superadmin' || db.ownerId === user.id),
          isSuperAdmin: !!user && user.role === 'superadmin',
          user: user ? publicUser(user) : null,
          company: { name: db.name, slug: db.slug, brand: db.brand },
        });
      }

      if (sub.startsWith('/admin/')) {
        const isEdit = (sub === '/admin/config' && method === 'PUT') || sub === '/admin/uploads';
        const isReset = (sub === '/admin/stats/reset' || sub === '/admin/spins/delete-day') && method === 'POST';
        requireOwner(req, db, isEdit ? 'edit' : (isReset ? 'reset' : 'view'));


        if (sub === '/admin/config' && method === 'GET') {
          return send(res, 200, { config: db.config, version: configVersion(), updatedAt: db.configUpdatedAt });
        }

        if (sub === '/admin/config' && method === 'PUT') {
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

        if (sub === '/admin/uploads' && method === 'POST') {
          const type = req.headers['content-type'] ?? '';
          if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new HttpError(415, 'Upload a PNG, JPEG or WebP image.');
          const buf = await readBody(req, MAX_IMAGE, 'That image is too large. Please use one under 1.5 MB.');
          const ext = detectImage(buf);
          if (!ext) throw new HttpError(415, 'That file is not a PNG, JPEG or WebP image.');
          const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
          await persist(() => store.putUpload(name, IMAGE_MIME[ext], buf, db.id));
          return send(res, 201, { url: `/uploads/${name}` });
        }

        if (sub === '/admin/stats' && method === 'GET') {
          return send(res, 200, buildStats());
        }

        if (sub === '/admin/spins' && method === 'GET') {
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

        if (sub === '/admin/spins/delete-day' && method === 'POST') {
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

        const redeemMatch = sub.match(/^\/admin\/spins\/([0-9a-f-]{36})\/redeem$/);
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

        if (sub === '/admin/stats/reset' && method === 'POST') {
          const body = await readJson(req);
          if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
          const before = db.spins;
          db.spins = [];
          await persist(() => store.clearSpins(db), () => { db.spins = before; });
          return send(res, 200, { ok: true });
        }

        if ((sub === '/admin/export.csv' || sub === '/admin/export.xlsx') && method === 'GET') {
          const header = ['Time', 'Name', 'Phone', 'Outcome', 'Gift', 'Claim code', 'Handed out', 'Handed out at', 'Device', 'Spin ID'];
          const rows = db.spins.map((s) => [
            localStamp(s.at), s.name ?? '', s.phone ?? '', s.label, s.isPrize ? 'Yes' : 'No', s.code ?? '',
            s.isPrize ? (s.redeemed ? 'Yes' : 'No') : '', localStamp(s.redeemedAt), s.player.slice(0, 8), s.id,
          ]);
          const stamp = dayKey();

          if (sub.endsWith('.xlsx')) {
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
              'Content-Disposition': `attachment; filename="${db.slug}-spins-${stamp}.xlsx"`,
            });
          }

          const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
          // BOM so Excel opens Khmer and other non-Latin names correctly.
          return send(res, 200, '\uFEFF' + csv, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${db.slug}-spins-${stamp}.csv"`,
          });
        }
      }

      throw new HttpError(404, 'Not found.');
    }

    return { handle };
  }

  // ---------- accounts + companies ----------
  async function handleAccountApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/api/auth/session' && method === 'GET') {
      const user = currentUser(req);
      return send(res, 200, { user: user ? publicUser(user) : null });
    }

    if (pathname === '/api/auth/signup' && method === 'POST') {
      const limit = signupLimiter.check(clientIp(req));
      if (!limit.allowed) throw new HttpError(429, 'Too many new accounts from this network. Please try again later.');
      const input = await readJson(req);
      const { errors, name, email, password } = validateSignup(input);
      if (!errors.email && usersByEmail.has(email)) errors.email = 'An account with this email already exists. Sign in instead.';
      if (Object.keys(errors).length) throw new HttpError(422, Object.values(errors)[0], { fields: errors });
      const user = newUser({ name, email, password: hashPassword(password) });
      await persist(() => addUser(user), () => { users.delete(user.id); usersByEmail.delete(user.email); });
      const { cookie: c } = signIn(req, user);
      return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': c });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const ip = clientIp(req);
      const limit = loginLimiter.check(ip);
      if (!limit.allowed) {
        const mins = Math.ceil(limit.retryAfterMs / 60000);
        throw new HttpError(429, `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
      const body = await readJson(req);
      const user = usersByEmail.get(normalizeEmail(body.email));
      const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      const ok = verifyPassword(password, user ? user.password : dummyPassword);
      if (!user || !ok) throw new HttpError(401, 'That email and password do not match an account.');
      loginLimiter.reset(ip);
      const { cookie: c } = signIn(req, user);
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': c });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      sessions.destroy(parseCookies(req)[SESSION_COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, SESSION_COOKIE, '', { maxAge: 0 }) });
    }

    if (pathname === '/api/auth/profile' && method === 'PUT') {
      const user = requireUser(req);
      const body = await readJson(req);
      const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
      const email = validateEmail(body.email);
      const fields = {};
      if (name.length < 2 || name.length > 60) fields.name = 'Please enter your name (2–60 characters).';
      if (!email) fields.email = 'Please enter a valid email address.';
      else if (email !== user.email && usersByEmail.has(email)) fields.email = 'Another account already uses this email.';
      if (Object.keys(fields).length) throw new HttpError(422, Object.values(fields)[0], { fields });
      const before = { name: user.name, email: user.email };
      usersByEmail.delete(user.email);
      Object.assign(user, { name, email });
      usersByEmail.set(user.email, user);
      await persist(() => store.saveUser(user), () => {
        usersByEmail.delete(user.email);
        Object.assign(user, before);
        usersByEmail.set(user.email, user);
      });
      return send(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/auth/password' && method === 'POST') {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!verifyPassword(String(body.currentPassword ?? ''), user.password)) {
        throw new HttpError(400, 'Your current password is not correct.', { field: 'currentPassword' });
      }
      const next = String(body.newPassword ?? '');
      if (next.length < MIN_PASSWORD_LENGTH || next.length > 200) {
        throw new HttpError(422, `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`, { field: 'newPassword' });
      }
      const before = { password: user.password, changedAt: user.changedAt };
      user.password = hashPassword(next);
      user.changedAt = new Date().toISOString();
      await persist(() => store.saveUser(user), () => Object.assign(user, before));
      await sessions.destroyUser(user.id, parseCookies(req)[SESSION_COOKIE]); // sign out every other device
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/companies' && method === 'GET') {
      const user = requireUser(req);
      const mine = [...companies.values()].filter((c) => c.ownerId === user.id).map(companySummary);
      return send(res, 200, { companies: mine });
    }

    if (pathname === '/api/companies/check-slug' && method === 'GET') {
      requireUser(req);
      const { errors, slug } = validateCompany(
        { name: 'xx', slug: url.searchParams.get('slug') ?? '' },
        { slugTaken: (s) => companiesBySlug.has(s) },
      );
      return send(res, 200, { slug, available: !errors.slug, error: errors.slug ?? null });
    }

    if (pathname === '/api/companies' && method === 'POST') {
      const user = requireUser(req);
      if (user.role === 'staff' || user.role === 'user') {
        throw new HttpError(403, 'Your role does not have permission to create companies. Please contact a Super Admin.');
      }
      const body = await readJson(req);
      const { errors, name, slug } = validateCompany(body, { slugTaken: (s) => companiesBySlug.has(s) });
      if (Object.keys(errors).length) throw new HttpError(422, Object.values(errors)[0], { fields: errors });
      const company = newCompany({ name, slug, ownerId: user.id });
      await persist(() => addCompany(company), () => {
        companies.delete(company.id);
        companiesBySlug.delete(company.slug);
        if (fileLists) fileLists.companies.splice(fileLists.companies.indexOf(company), 1);
      });
      return send(res, 201, { company: companySummary(company) });
    }

    const one = pathname.match(/^\/api\/companies\/([a-z0-9-]{1,40})$/);
    if (one) {
      const user = requireUser(req);
      const company = companiesBySlug.get(one[1]);
      const allowed = company && (company.ownerId === user.id || user.role === 'superadmin');
      if (!company || !allowed) throw new HttpError(404, 'Company not found.');

      if (method === 'PUT') {
        if (user.role === 'staff') throw new HttpError(403, 'Staff cannot rename companies.');
        const body = await readJson(req);
        const { errors, name } = validateCompany({ name: body.name, slug: company.slug });
        if (errors.name) throw new HttpError(422, errors.name, { fields: { name: errors.name } });
        const before = company.name;
        company.name = name;
        await persist(() => store.saveCompany(company), () => { company.name = before; });
        return send(res, 200, { company: companySummary(company) });
      }

      if (method === 'DELETE') {
        if (user.role === 'staff') throw new HttpError(403, 'Staff cannot delete companies.');
        const body = await readJson(req);
        if (body.confirm !== company.slug) throw new HttpError(400, `Type ${company.slug} to confirm.`);
        companies.delete(company.id);
        companiesBySlug.delete(company.slug);
        const at = fileLists?.companies.indexOf(company) ?? -1;
        if (at >= 0) fileLists.companies.splice(at, 1);
        await persist(() => store.deleteCompany(company), () => {
          companies.set(company.id, company);
          companiesBySlug.set(company.slug, company);
          if (at >= 0) fileLists.companies.splice(at, 0, company);
        });
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'Not found.');
  }

  // ---------- super admin (all users, roles and companies) ----------
  async function handleSuperApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const superUser = requireSuperAdmin(req);

    if (pathname === '/api/super/users' && method === 'GET') {
      const list = [...users.values()].map((u) => {
        const owned = [...companies.values()].filter((c) => c.ownerId === u.id);
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role || 'admin',
          createdAt: u.createdAt,
          changedAt: u.changedAt,
          companyCount: owned.length,
          companies: owned.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
        };
      });
      return send(res, 200, { users: list, roles: ROLES, roleLabels: ROLE_LABELS });
    }

    const roleMatch = pathname.match(/^\/api\/super\/users\/([0-9a-f-]{36})\/role$/);
    if (roleMatch && method === 'PUT') {
      const targetUser = users.get(roleMatch[1]);
      if (!targetUser) throw new HttpError(404, 'User not found.');
      const body = await readJson(req);
      const role = validateRole(body.role);
      if (!role) throw new HttpError(422, `Invalid role. Allowed roles are: ${ROLES.join(', ')}.`);

      if (targetUser.role === 'superadmin' && role !== 'superadmin') {
        const superAdmins = [...users.values()].filter((u) => u.role === 'superadmin');
        if (superAdmins.length <= 1) {
          throw new HttpError(400, 'Cannot change role: the system must have at least one Super Admin.');
        }
      }

      const beforeRole = targetUser.role;
      targetUser.role = role;
      await persist(() => store.saveUser(targetUser), () => { targetUser.role = beforeRole; });
      return send(res, 200, { user: publicUser(targetUser) });
    }

    const pwMatch = pathname.match(/^\/api\/super\/users\/([0-9a-f-]{36})\/reset-password$/);
    if (pwMatch && method === 'POST') {
      const targetUser = users.get(pwMatch[1]);
      if (!targetUser) throw new HttpError(404, 'User not found.');
      const body = await readJson(req);
      const newPassword = String(body.newPassword ?? '');
      if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 200) {
        throw new HttpError(422, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      const before = { password: targetUser.password, changedAt: targetUser.changedAt };
      targetUser.password = hashPassword(newPassword);
      targetUser.changedAt = new Date().toISOString();
      await persist(() => store.saveUser(targetUser), () => Object.assign(targetUser, before));
      await sessions.destroyUser(targetUser.id);
      return send(res, 200, { ok: true, email: targetUser.email });
    }

    const userMatch = pathname.match(/^\/api\/super\/users\/([0-9a-f-]{36})$/);
    if (userMatch) {
      const targetUser = users.get(userMatch[1]);
      if (!targetUser) throw new HttpError(404, 'User not found.');

      if (method === 'PUT') {
        const body = await readJson(req);
        const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
        const email = validateEmail(body.email);
        const role = body.role ? validateRole(body.role) : targetUser.role;
        const fields = {};
        if (name.length < 2 || name.length > 60) fields.name = 'Please enter name (2–60 characters).';
        if (!email) fields.email = 'Please enter a valid email address.';
        else if (email !== targetUser.email && usersByEmail.has(email)) fields.email = 'Another account already uses this email.';
        if (!role) fields.role = `Invalid role. Allowed roles: ${ROLES.join(', ')}.`;
        if (Object.keys(fields).length) throw new HttpError(422, Object.values(fields)[0], { fields });

        if (targetUser.role === 'superadmin' && role !== 'superadmin') {
          const superAdmins = [...users.values()].filter((u) => u.role === 'superadmin');
          if (superAdmins.length <= 1) throw new HttpError(400, 'Cannot demote the only Super Admin.');
        }

        const before = { name: targetUser.name, email: targetUser.email, role: targetUser.role };
        usersByEmail.delete(targetUser.email);
        Object.assign(targetUser, { name, email, role });
        usersByEmail.set(targetUser.email, targetUser);
        await persist(() => store.saveUser(targetUser), () => {
          usersByEmail.delete(targetUser.email);
          Object.assign(targetUser, before);
          usersByEmail.set(targetUser.email, targetUser);
        });
        return send(res, 200, { user: publicUser(targetUser) });
      }

      if (method === 'DELETE') {
        if (targetUser.id === superUser.id) {
          throw new HttpError(400, 'You cannot delete your own account.');
        }
        if (targetUser.role === 'superadmin') {
          const superAdmins = [...users.values()].filter((u) => u.role === 'superadmin');
          if (superAdmins.length <= 1) throw new HttpError(400, 'Cannot delete the only Super Admin.');
        }
        const body = await readJson(req).catch(() => ({}));
        if (body.confirm !== 'DELETE' && body.confirm !== targetUser.email) {
          throw new HttpError(400, `Type DELETE or ${targetUser.email} to confirm.`);
        }

        const owned = [...companies.values()].filter((c) => c.ownerId === targetUser.id);
        for (const c of owned) {
          c.ownerId = superUser.id;
          await store.saveCompany(c);
        }

        users.delete(targetUser.id);
        usersByEmail.delete(targetUser.email);
        if (fileLists) {
          const idx = fileLists.users.indexOf(targetUser);
          if (idx >= 0) fileLists.users.splice(idx, 1);
        }
        await store.deleteUser(targetUser);
        await sessions.destroyUser(targetUser.id);
        return send(res, 200, { ok: true, reassignedCompanies: owned.length });
      }
    }

    if (pathname === '/api/super/companies' && method === 'GET') {
      const all = [...companies.values()].map(companySummary);
      return send(res, 200, { companies: all });
    }

    const transferMatch = pathname.match(/^\/api\/super\/companies\/([a-z0-9-]{1,40})\/owner$/);
    if (transferMatch && method === 'PUT') {
      const company = companiesBySlug.get(transferMatch[1]);
      if (!company) throw new HttpError(404, 'Company not found.');
      const body = await readJson(req);
      const newOwner = body.ownerId ? users.get(body.ownerId) : (body.email ? usersByEmail.get(normalizeEmail(body.email)) : null);
      if (!newOwner) throw new HttpError(404, 'Target owner user not found.');
      const before = company.ownerId;
      company.ownerId = newOwner.id;
      await persist(() => store.saveCompany(company), () => { company.ownerId = before; });
      return send(res, 200, { company: companySummary(company) });
    }

    if (pathname === '/api/super/stats' && method === 'GET') {
      let totalSpins = 0;
      let totalSpinsToday = 0;
      const today = dayKey();
      for (const c of companies.values()) {
        totalSpins += c.spins.length;
        for (let i = c.spins.length - 1; i >= 0 && c.spins[i].day === today; i--) totalSpinsToday++;
      }
      const roleCounts = {};
      for (const r of ROLES) roleCounts[r] = 0;
      for (const u of users.values()) {
        const r = u.role || 'admin';
        roleCounts[r] = (roleCounts[r] || 0) + 1;
      }
      return send(res, 200, {
        totalUsers: users.size,
        totalCompanies: companies.size,
        totalSpins,
        totalSpinsToday,
        roleCounts,
      });
    }

    throw new HttpError(404, 'Not found.');
  }

  // ---------- routing ----------
  async function handleApi(req, res, url) {
    const { pathname } = url;
    if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);

    if (pathname.startsWith('/api/super/')) {
      return handleSuperApi(req, res, url);
    }


    const m = pathname.match(/^\/api\/c\/([a-z0-9-]{1,40})(\/.*)$/);
    if (m) {
      const company = companiesBySlug.get(m[1]);
      if (!company) throw new HttpError(404, 'This game does not exist (any more).', { notFound: true });
      return tenant(company).handle(req, res, url, m[2]);
    }
    return handleAccountApi(req, res, url);
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

  function redirect(res, location) {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  /** Map friendly page URLs to files; returns null for anything else (served as a plain file). */
  function pageFor(req, res, rel) {
    if (rel === '/') {
      if (homeCompany && companiesBySlug.has(homeCompany)) return redirect(res, `/c/${homeCompany}`), true;
      return '/home.html';
    }
    if (rel === '/login' || rel === '/signup') return '/login.html';
    if (rel === '/account') return '/account.html';
    if (rel === '/admin' || rel === '/admin/') return redirect(res, '/account'), true;
    const m = rel.match(/^\/c\/([a-z0-9-]{1,40})(\/admin)?\/?$/);
    if (m) {
      if (!companiesBySlug.has(m[1])) return '/not-found.html';
      return m[2] ? '/admin/index.html' : '/index.html';
    }
    return null;
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
    const page = pageFor(req, res, rel);
    if (page === true) return; // redirected
    const status = page === '/not-found.html' ? 404 : 200;
    const noindex = page && page !== '/home.html' && page !== '/index.html';
    if (page) rel = page;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      const ext = path.extname(file);
      // Pages, styles and scripts are revalidated on every load (cheap 304s), so an update
      // shows up immediately instead of mixing new HTML with a cached old stylesheet.
      const revalidate = ext === '.html' || ext === '.css' || ext === '.js' || ext === '.svg';
      const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=300',
        ETag: etag,
      };
      if (noindex || rel.startsWith('/admin')) headers['X-Robots-Tag'] = 'noindex, nofollow';
      if (status === 200 && req.headers['if-none-match'] === etag) {
        delete headers['Content-Type'];
        delete headers['Content-Length'];
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(status, headers);
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

  return {
    handler, store, sessions, users, companies,
    company: (slug) => companiesBySlug.get(slug) ?? null,
    close: () => store.close(),
  };
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const app = await createApp({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    databaseUrl: process.env.DATABASE_URL || undefined,
    adminPassword: process.env.ADMIN_PASSWORD,
    homeCompany: process.env.HOME_COMPANY || null,
    trustProxy: process.env.TRUST_PROXY === '1',
    secureCookies: process.env.COOKIE_SECURE === '1',
  });
  const server = http.createServer(app.handler);
  server.listen(port, host, () => {
    console.log(`Spin running → http://localhost:${port}  (sign in: http://localhost:${port}/login)`);
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
