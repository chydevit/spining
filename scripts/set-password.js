// Reset the admin password from the command line (e.g. if it was forgotten).
// Usage: node scripts/set-password.js                    (local data/db.json)
//        DATABASE_URL=postgres://... node scripts/set-password.js   (e.g. Render Postgres)
// Then restart the server so it picks up the new password.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createStorage } from '../src/storage/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => {
      if (!rl.stdoutMuted || s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = await ask('New admin password: ');
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}
const confirm = await ask('Confirm password: ');
if (confirm !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const store = createStorage({ dataDir, databaseUrl: process.env.DATABASE_URL });
const db = await store.init();
db.admin = { ...(db.admin ?? {}), password: hashPassword(password), changedAt: new Date().toISOString() };
await store.saveAdmin(db);
await store.deleteAllSessions();
await store.close();
console.log(`Admin password updated (${store.kind}). Restart the server so it takes effect.`);
