// Admin authentication: scrypt password hashing, in-memory sessions and login throttling.
import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(password, record) {
  if (!record || typeof password !== 'string') return false;
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}

export function generatePassword() {
  // 16 chars from an unambiguous alphabet.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/**
 * Admin sessions. Tokens live only in the user's HttpOnly cookie; we keep a SHA-256
 * hash of each token. With a `persist` backend (Postgres) sessions survive restarts.
 */
export class SessionManager {
  constructor(persist = null, log = console.error) {
    this.sessions = new Map(); // tokenHash -> { expiresAt, savedAt }
    this.persist = persist;
    this.log = log;
  }

  static hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  load(list = []) {
    for (const { hash, expiresAt } of list) {
      if (expiresAt > Date.now()) this.sessions.set(hash, { expiresAt, savedAt: Date.now() });
    }
  }

  background(promise) {
    promise?.catch?.((err) => this.log('[sessions] could not persist:', err.message));
  }

  create() {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = SessionManager.hash(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(hash, { expiresAt, savedAt: Date.now() });
    this.background(this.persist?.saveSession(hash, expiresAt));
    return token;
  }

  validate(token) {
    if (!token) return false;
    const hash = SessionManager.hash(token);
    const session = this.sessions.get(hash);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(hash);
      this.background(this.persist?.deleteSession(hash));
      return false;
    }
    // Sliding expiry (written back at most every 15 minutes).
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    if (Date.now() - session.savedAt > 15 * 60 * 1000) {
      session.savedAt = Date.now();
      this.background(this.persist?.saveSession(hash, session.expiresAt));
    }
    return true;
  }

  destroy(token) {
    if (!token) return;
    const hash = SessionManager.hash(token);
    this.sessions.delete(hash);
    this.background(this.persist?.deleteSession(hash));
  }

  async destroyAll() {
    this.sessions.clear();
    await this.persist?.deleteAllSessions();
  }
}

// Simple fixed-window limiter keyed by IP.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (this.hits.size > 10_000) this.prune(now);
    return { allowed: entry.count <= this.max, retryAfterMs: entry.resetAt - now };
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) if (entry.resetAt < now) this.hits.delete(key);
  }
}
