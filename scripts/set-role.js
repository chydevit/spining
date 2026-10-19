// Change an account's role from the command line (e.g. promote to superadmin).
// Usage: node scripts/set-role.js you@example.com <superadmin|admin|staff|user>
//        DATABASE_URL=postgres://... node scripts/set-role.js you@example.com superadmin
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from '../src/storage/index.js';
import { normalizeEmail, ROLES, validateRole } from '../src/tenancy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

const email = normalizeEmail(process.argv[2]);
const targetRole = String(process.argv[3] ?? '').trim().toLowerCase();

if (!email || !targetRole) {
  console.error(`Usage: node scripts/set-role.js you@example.com <${ROLES.join('|')}>`);
  process.exit(1);
}

const role = validateRole(targetRole);
if (!role) {
  console.error(`Invalid role "${targetRole}". Allowed roles: ${ROLES.join(', ')}.`);
  process.exit(1);
}

const store = createStorage({ dataDir, databaseUrl: process.env.DATABASE_URL });
const db = await store.init();
const user = db.users.find((u) => u.email === email);
if (!user) {
  console.error(`No account with the email ${email}.`);
  await store.close();
  process.exit(1);
}

const oldRole = user.role || 'admin';
user.role = role;
user.changedAt = new Date().toISOString();
await store.saveUser(user);
await store.close();

console.log(`Updated ${email}: ${oldRole} → ${role} (${store.kind}). Restart the server if it's currently running.`);
