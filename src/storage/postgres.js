// PostgreSQL storage (used when DATABASE_URL is set, e.g. Render Postgres).
//
// The app keeps a working copy of everything in memory (it is small) and writes each
// change through to Postgres, so data survives restarts, redeploys and Render's
// ephemeral filesystem. Run a single app instance per database.
//
// Tables: users, companies (settings as JSON), spins, uploads and admin_sessions, all tied to a
// company or user. A database from the single-company version is moved over automatically.
import { legacyToTenancy } from '../tenancy.js';

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
CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL,
  password   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz
);
CREATE TABLE IF NOT EXISTS companies (
  id                uuid PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  owner_id          uuid NOT NULL REFERENCES users (id),
  brand             text NOT NULL DEFAULT 'generic',
  config            jsonb NOT NULL,
  config_updated_at text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE spins ADD COLUMN IF NOT EXISTS company_id uuid;
CREATE INDEX IF NOT EXISTS spins_company_idx ON spins (company_id, at);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
`;


const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

const rowToSpin = (r) => ({
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
});

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
    await this.migrateLegacy();

    const users = await this.pool.query('SELECT * FROM users ORDER BY created_at');
    const companies = await this.pool.query('SELECT * FROM companies ORDER BY created_at');
    const spins = await this.pool.query('SELECT * FROM spins WHERE company_id IS NOT NULL ORDER BY at, id');
    const byCompany = new Map(companies.rows.map((c) => [c.id, []]));
    for (const r of spins.rows) byCompany.get(r.company_id)?.push(rowToSpin(r));
    const owners = await this.pool.query('SELECT name, company_id FROM uploads WHERE company_id IS NOT NULL');
    this.uploadOwners = new Map(owners.rows.map((r) => [r.name, r.company_id]));

    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'admin@pharmkulen.local').toLowerCase();
    return {
      users: users.rows.map((u, i) => ({
        id: u.id, email: u.email, name: u.name, password: u.password,
        role: u.role || ((u.email && u.email.toLowerCase() === superAdminEmail) || i === 0 ? 'superadmin' : 'admin'),
        createdAt: iso(u.created_at), changedAt: iso(u.changed_at),
      })),
      companies: companies.rows.map((c) => ({
        id: c.id, slug: c.slug, name: c.name, ownerId: c.owner_id, brand: c.brand,
        config: c.config, configUpdatedAt: c.config_updated_at, createdAt: iso(c.created_at), spins: byCompany.get(c.id),
      })),
    };
  }

  /** One-time move from the single-company tables (app_state config + admin) to users/companies. */
  async migrateLegacy() {
    const done = await this.pool.query("SELECT 1 FROM app_state WHERE key = 'migrated_v2'");
    if (done.rowCount) return;
    const state = await this.pool.query("SELECT key, value FROM app_state WHERE key IN ('config', 'admin')");
    const byKey = Object.fromEntries(state.rows.map((r) => [r.key, r.value]));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (byKey.config?.config && byKey.admin?.password) {
        const { user, company } = legacyToTenancy({ config: byKey.config.config, configUpdatedAt: byKey.config.updatedAt, admin: byKey.admin });
        await this.upsertUser(client, user);
        await this.upsertCompany(client, company);
        await client.query('UPDATE spins SET company_id = $1 WHERE company_id IS NULL', [company.id]);
        await client.query('UPDATE uploads SET company_id = $1 WHERE company_id IS NULL', [company.id]);
        this.log(`[db] moved the existing game to company "${company.slug}" (owner ${user.email})`);
      }
      await client.query('DELETE FROM admin_sessions WHERE user_id IS NULL');
      await client.query("INSERT INTO app_state (key, value) VALUES ('migrated_v2', 'true') ON CONFLICT (key) DO NOTHING");
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ----- users -----
  async upsertUser(client, u) {
    await client.query(
      `INSERT INTO users (id, email, name, password, role, created_at, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, password = EXCLUDED.password, role = EXCLUDED.role, changed_at = EXCLUDED.changed_at`,
      [u.id, u.email, u.name, JSON.stringify(u.password), u.role ?? 'admin', u.createdAt, u.changedAt ?? null],
    );
  }

  saveUser(user) {
    return this.upsertUser(this.pool, user);
  }

  async deleteUser(user) {
    await this.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  }


  // ----- companies -----
  async upsertCompany(client, c) {
    await client.query(
      `INSERT INTO companies (id, slug, name, owner_id, brand, config, config_updated_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, owner_id = EXCLUDED.owner_id,
         brand = EXCLUDED.brand, config = EXCLUDED.config, config_updated_at = EXCLUDED.config_updated_at`,
      [c.id, c.slug, c.name, c.ownerId, c.brand, JSON.stringify(c.config), c.configUpdatedAt ?? null, c.createdAt],
    );
  }

  saveCompany(company) {
    return this.upsertCompany(this.pool, company);
  }

  async saveConfig(company) {
    await this.pool.query('UPDATE companies SET config = $2, config_updated_at = $3 WHERE id = $1',
      [company.id, JSON.stringify(company.config), company.configUpdatedAt ?? null]);
  }

  deleteCompany(company) {
    return this.transaction(async (client) => {
      await client.query('DELETE FROM spins WHERE company_id = $1', [company.id]);
      await client.query('DELETE FROM uploads WHERE company_id = $1', [company.id]);
      await client.query('DELETE FROM companies WHERE id = $1', [company.id]);
      for (const [name, owner] of this.uploadOwners) if (owner === company.id) this.uploadOwners.delete(name);
    });
  }

  // ----- spins -----
  /** Record a spin and the matching stock change atomically. */
  addSpin(spin, company) {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO spins (id, company_id, at, day, player, name, phone, segment_id, label, is_prize, code, redeemed, redeemed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [spin.id, company.id, spin.at, spin.day, spin.player, spin.name ?? null, spin.phone ?? null, spin.segmentId,
          spin.label, spin.isPrize, spin.code, spin.redeemed, spin.redeemedAt ?? null],
      );
      await client.query('UPDATE companies SET config = $2 WHERE id = $1', [company.id, JSON.stringify(company.config)]);
    });
  }

  async updateSpin(spin, company) {
    await this.pool.query('UPDATE spins SET redeemed = $3, redeemed_at = $4 WHERE id = $1 AND company_id = $2',
      [spin.id, company.id, spin.redeemed, spin.redeemedAt ?? null]);
  }

  async clearSpins(company) {
    await this.pool.query('DELETE FROM spins WHERE company_id = $1', [company.id]);
  }

  async deleteSpinsByDay(day, company) {
    await this.pool.query('DELETE FROM spins WHERE company_id = $1 AND day = $2', [company.id, day]);
  }

  // ----- uploads (stored in the database: Render's disk is wiped on deploy) -----
  async putUpload(name, mime, buf, companyId) {
    await this.pool.query('INSERT INTO uploads (name, mime, data, company_id) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
      [name, mime, buf, companyId]);
    this.uploadOwners.set(name, companyId);
  }

  async getUpload(name) {
    const r = await this.pool.query('SELECT mime, data FROM uploads WHERE name = $1', [name]);
    return r.rows[0] ? { mime: r.rows[0].mime, data: r.rows[0].data } : null;
  }

  async pruneUploads(companyId, used, olderThan) {
    const r = await this.pool.query(
      'DELETE FROM uploads WHERE company_id = $1 AND created_at < $2 AND NOT (name = ANY($3::text[])) RETURNING name',
      [companyId, new Date(olderThan), [...used]],
    );
    for (const row of r.rows) this.uploadOwners.delete(row.name);
  }

  async listUploads() {
    const r = await this.pool.query('SELECT name FROM uploads');
    return r.rows.map((x) => x.name);
  }

  uploadOwner(name) {
    return this.uploadOwners.get(name) ?? null;
  }

  // ----- sign-in sessions (only a hash of each token is stored) -----
  async loadSessions() {
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at < now() OR user_id IS NULL');
    const r = await this.pool.query('SELECT token_hash, expires_at, user_id FROM admin_sessions');
    return r.rows.map((x) => ({ hash: x.token_hash, expiresAt: new Date(x.expires_at).getTime(), userId: x.user_id }));
  }

  async saveSession(hash, expiresAt, userId) {
    await this.pool.query(
      `INSERT INTO admin_sessions (token_hash, expires_at, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [hash, new Date(expiresAt), userId],
    );
  }

  async deleteSession(hash) {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hash]);
  }

  async deleteUserSessions(userId, exceptHash = null) {
    await this.pool.query('DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [userId, exceptHash]);
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
