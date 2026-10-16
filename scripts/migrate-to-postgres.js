// Copy local data (data/db.json + data/uploads) into a PostgreSQL database,
// e.g. your Render Postgres, so the hosted game starts with your wheel, gifts,
// images, admin password and spin history.
//
// Usage:
//   DATABASE_URL='postgres://…' node scripts/migrate-to-postgres.js           # refuses if the DB already has a wheel
//   DATABASE_URL='postgres://…' node scripts/migrate-to-postgres.js --force   # overwrite wheel/admin, keep existing spins
//
// Use Render's *External* Database URL when running this from your computer.
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
if (!local.config) {
  console.error(`No local data found in ${dataDir}.`);
  process.exit(1);
}

const target = new PgStore(url);
const remote = await target.init();
if (remote.config && !force) {
  console.error('The database already has a wheel configured. Re-run with --force to overwrite it (existing spins are kept).');
  await target.close();
  process.exit(1);
}

// Wheel + admin account
await target.saveConfig(local);
if (local.admin) await target.saveAdmin(local);

// Spins (skip any that are already there)
const existing = new Set(remote.spins.map((s) => s.id));
let copied = 0;
for (const spin of local.spins) {
  if (existing.has(spin.id)) continue;
  await target.pool.query(
    `INSERT INTO spins (id, at, day, player, name, phone, segment_id, label, is_prize, code, redeemed, redeemed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
    [spin.id, spin.at, spin.day, spin.player, spin.name ?? null, spin.phone ?? null, spin.segmentId, spin.label,
      spin.isPrize, spin.code ?? null, spin.redeemed ?? false, spin.redeemedAt ?? null],
  );
  copied++;
}

// Uploaded images
let images = 0;
for (const name of await source.listUploads()) {
  const file = await source.getUpload(name);
  await target.putUpload(name, MIME[name.split('.').pop()], file.data);
  images++;
}

await target.close();
console.log(`Done: wheel settings${local.admin ? ' + admin password' : ''}, ${copied} spin(s) and ${images} image(s) copied to PostgreSQL.`);
console.log('Restart the web service so it loads the copied data.');
