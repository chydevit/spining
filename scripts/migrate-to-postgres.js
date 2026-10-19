// Copy local data (data/db.json + data/uploads) into a PostgreSQL database, e.g. your Render
// Postgres: accounts, companies (settings), spins and uploaded images.
//
// Usage:
//   DATABASE_URL='postgres://…' node scripts/migrate-to-postgres.js           # refuses if a company link already exists there
//   DATABASE_URL='postgres://…' node scripts/migrate-to-postgres.js --force   # overwrite those companies' settings; keep their spins
//
// Use Render's *External* Database URL when running this from your computer.
// An old single-game data file is converted to the company format first (see src/storage/file.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore, PgStore } from '../src/storage/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const url = process.env.DATABASE_URL;
const force = process.argv.includes('--force');
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

if (!url) {
  console.error('Set DATABASE_URL to the target PostgreSQL database first.');
  process.exit(1);
}

const source = new FileStore(dataDir);
const local = await source.init();
if (!local.companies.length) {
  console.error(`No companies found in ${dataDir}.`);
  process.exit(1);
}

const target = new PgStore(url);
const remote = await target.init();
const clash = local.companies.filter((c) => remote.companies.some((r) => r.slug === c.slug && r.id !== c.id));
if (clash.length && !force) {
  console.error(`The database already has: ${clash.map((c) => c.slug).join(', ')}. Re-run with --force to overwrite their settings (spins are kept).`);
  await target.close();
  process.exit(1);
}

// Accounts: match by email so an existing account keeps its id (and its sign-ins).
const userIds = new Map();
for (const u of local.users) {
  const existing = remote.users.find((r) => r.email === u.email);
  const user = existing ? { ...existing, name: u.name, password: u.password } : u;
  await target.saveUser(user);
  userIds.set(u.id, user.id);
}

let spins = 0;
for (const c of local.companies) {
  const existing = remote.companies.find((r) => r.slug === c.slug);
  const company = { ...c, id: existing?.id ?? c.id, ownerId: userIds.get(c.ownerId) ?? c.ownerId };
  await target.saveCompany(company);
  const have = new Set((existing?.spins ?? []).map((s) => s.id));
  for (const s of c.spins) {
    if (have.has(s.id)) continue;
    await target.pool.query(
      `INSERT INTO spins (id, company_id, at, day, player, name, phone, segment_id, label, is_prize, code, redeemed, redeemed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [s.id, company.id, s.at, s.day, s.player, s.name ?? null, s.phone ?? null, s.segmentId, s.label,
        s.isPrize, s.code ?? null, s.redeemed ?? false, s.redeemedAt ?? null],
    );
    spins++;
  }
  // Images belong to the company that uploaded them.
  for (const name of await source.listUploads()) {
    if (source.uploadOwner(name) !== c.id) continue;
    const file = await source.getUpload(name);
    await target.putUpload(name, MIME[name.split('.').pop()], file.data, company.id);
  }
}

await target.close();
console.log(`Done: ${local.users.length} account(s), ${local.companies.length} company(ies) and ${spins} spin(s) copied to PostgreSQL.`);
console.log('Restart the web service so it loads the copied data.');
