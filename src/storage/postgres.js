// PostgreSQL storage (used when DATABASE_URL is set, e.g. Render Postgres).
//
// The app keeps a working copy of everything in memory (it is small) and writes each
// change through to Postgres, so data survives restarts, redeploys and Render's
// ephemeral filesystem. Run a single app instance per database.
import crypto from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spins (
  id          uuid PRIMARY KEY,
  at          timestamptz NOT NULL,
  day         text NOT NULL,
  player      text NOT NULL,
  name        text,
  phone       text,
  segment_id  text NOT NULL,
  label       text NOT NULL,
  is_prize    boolean NOT NULL,
  code        text UNIQUE,
  redeemed    boolean NOT NULL DEFAULT false,
  redeemed_at timestamptz
);
CREATE INDEX IF NOT EXISTS spins_at_idx ON spins (at);
CREATE INDEX IF NOT EXISTS spins_phone_idx ON spins (phone);
CREATE TABLE IF NOT EXISTS uploads (
  name       text PRIMARY KEY,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** Render's internal URLs (host without dots) need no TLS; external ones do. */
function sslFor(url) {
  const mode = process.env.DATABASE_SSL;
  if (mode === '0' || mode === 'false') return false;
  if (mode === '1' || mode === 'true') return { rejectUnauthorized: false };
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || !host.includes('.')) return false;
  } catch { /* fall through */ }
  return { rejectUnauthorized: false };
}

/** Says what is wrong with a malformed DATABASE_URL without revealing the password. */
function describeBadUrl(url) {
  const problems = [];
  if (!url.trim()) return 'it is empty';
  if (url !== url.trim()) problems.push('it has spaces or line breaks at the start or end');
  const v = url.trim();
  if (/^["']/.test(v)) problems.push('it is wrapped in quotes');
  if (/^[A-Z_]+=/.test(v)) problems.push(`it starts with "${v.split('=')[0]}="`);
  if (/\s/.test(v)) problems.push('it contains spaces or line breaks');
  const scheme = v.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1];
  if (!scheme) problems.push('it does not start with postgresql://');
  else if (!/^postgres(ql)?$/i.test(scheme)) problems.push(`it starts with "${scheme}://"`);
  const host = v.split('@').pop().split(/[/?]/)[0];
  if (v.includes('@')) problems.push(`host part is "${host}"`);
  else problems.push('it has no "@" (USER:PASSWORD@HOST)');
  return `${problems.join('; ')}; length ${v.length}`;
}

export class PgStore {
  kind = 'postgres';

  constructor(databaseUrl, { log = console.log } = {}) {
    this.url = databaseUrl;
    this.log = log;
  }

  async connect() {
    let pg;
    try {
      pg = (await import('pg')).default;
    } catch {
      throw new Error('DATABASE_URL is set but the "pg" package is missing. Run `npm install`.');
    }
    // A malformed URL never gets better by retrying: fail at once, without printing the password.
    try {
      const u = new URL(this.url);
      if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) throw new Error();
    } catch {
      throw new Error(
        `DATABASE_URL is not a valid PostgreSQL URL (${describeBadUrl(this.url)}). ` +
        'Expected postgresql://USER:PASSWORD@HOST/DATABASE. Copy it again from the database page in Render.'
      );
    }
    const makePool = (ssl) => {
      const pool = new pg.Pool({ connectionString: this.url, ssl, max: 5, idleTimeoutMillis: 30_000 });
      pool.on('error', (err) => this.log('[db] idle client error:', err.message));
      return pool;
    };
    let ssl = sslFor(this.url);
    this.pool = makePool(ssl);

    // The database may still be starting (e.g. right after a Render deploy): retry for ~60s.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        return;
      } catch (err) {
        // A server without TLS (e.g. a local/private Postgres): retry in plain mode unless TLS was required.
        if (ssl && /does not support SSL/i.test(err.message) && !process.env.DATABASE_SSL) {
          this.log('[db] server has no TLS; connecting without it');
          await this.pool.end().catch(() => {});
          ssl = false;
          this.pool = makePool(ssl);
          continue;
        }
        if (attempt >= 20) throw err;
        this.log(`[db] waiting for database (${err.code ?? err.message})…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async init() {
    await this.connect();
    await this.pool.query(SCHEMA);
    const state = await this.pool.query('SELECT key, value FROM app_state');
    const byKey = Object.fromEntries(state.rows.map((r) => [r.key, r.value]));
    const spins = await this.pool.query('SELECT * FROM spins ORDER BY at, id');
    return {
      version: 1,
      config: byKey.config?.config ?? null,
      configUpdatedAt: byKey.config?.updatedAt ?? null,
      admin: byKey.admin ?? null,
      spins: spins.rows.map((r) => ({
        id: r.id,
        at: iso(r.at),
        day: r.day,
        player: r.player,
        name: r.name,
        phone: r.phone,
        segmentId: r.segment_id,
        label: r.label,
        isPrize: r.is_prize,
        code: r.code,
        redeemed: r.redeemed,
        redeemedAt: iso(r.redeemed_at),
      })),
    };
  }

  async putState(client, key, value) {
    await client.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  saveConfig(db) {
    return this.putState(this.pool, 'config', { config: db.config, updatedAt: db.configUpdatedAt });
  }

  saveAdmin(db) {
    return this.putState(this.pool, 'admin', db.admin);
  }

  /** Record a spin and the matching stock change atomically. */
  async addSpin(spin, db) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO spins (id, at, day, player, name, phone, segment_id, label, is_prize, code, redeemed, redeemed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [spin.id, spin.at, spin.day, spin.player, spin.name ?? null, spin.phone ?? null, spin.segmentId,
          spin.label, spin.isPrize, spin.code, spin.redeemed, spin.redeemedAt ?? null],
      );
      await this.putState(client, 'config', { config: db.config, updatedAt: db.configUpdatedAt });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async updateSpin(spin) {
    await this.pool.query('UPDATE spins SET redeemed = $2, redeemed_at = $3 WHERE id = $1', [spin.id, spin.redeemed, spin.redeemedAt ?? null]);
  }

  async clearSpins() {
    await this.pool.query('DELETE FROM spins');
  }

  async deleteSpinsByDay(day) {
    await this.pool.query('DELETE FROM spins WHERE day = $1', [day]);
  }

  // ----- uploads (stored in the database: Render's disk is wiped on deploy) -----
  async putUpload(name, mime, buf) {
    await this.pool.query('INSERT INTO uploads (name, mime, data) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING', [name, mime, buf]);
  }

  async getUpload(name) {
    const r = await this.pool.query('SELECT mime, data FROM uploads WHERE name = $1', [name]);
    return r.rows[0] ? { mime: r.rows[0].mime, data: r.rows[0].data } : null;
  }

  async pruneUploads(used, olderThan) {
    await this.pool.query('DELETE FROM uploads WHERE created_at < $1 AND NOT (name = ANY($2::text[]))', [new Date(olderThan), [...used]]);
  }

  async listUploads() {
    const r = await this.pool.query('SELECT name FROM uploads');
    return r.rows.map((x) => x.name);
  }

  // ----- admin sessions (only a hash of each token is stored) -----
  static hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async loadSessions() {
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    const r = await this.pool.query('SELECT token_hash, expires_at FROM admin_sessions');
    return r.rows.map((x) => ({ hash: x.token_hash, expiresAt: new Date(x.expires_at).getTime() }));
  }

  async saveSession(hash, expiresAt) {
    await this.pool.query(
      `INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [hash, new Date(expiresAt)],
    );
  }

  async deleteSession(hash) {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hash]);
  }

  async deleteAllSessions() {
    await this.pool.query('DELETE FROM admin_sessions');
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close() {
    await this.pool?.end();
  }
}
