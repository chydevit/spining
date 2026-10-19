// Reset an account's password from the command line (e.g. if it was forgotten).
// Usage: node scripts/set-password.js you@example.com                        (local data/db.json)
//        DATABASE_URL=postgres://... node scripts/set-password.js you@example.com   (e.g. Render Postgres)
// Then restart the server so it picks up the new password.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createStorage } from '../src/storage/index.js';
import { hashPassword } from '../src/auth.js';
import { MIN_PASSWORD_LENGTH, normalizeEmail } from '../src/tenancy.js';

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

const email = normalizeEmail(process.argv[2]);
if (!email) {
  console.error('Usage: node scripts/set-password.js you@example.com');
  process.exit(1);
}
{
  const peek = createStorage({ dataDir, databaseUrl: process.env.DATABASE_URL });
  const found = (await peek.init()).users.some((u) => u.email === email);
  await peek.close();
  if (!found) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
}
const password = await ask(`New password for ${email}: `);
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
const user = db.users.find((u) => u.email === email);
user.password = hashPassword(password);
user.changedAt = new Date().toISOString();
await store.saveUser(user);
await store.deleteUserSessions(user.id);
await store.close();
console.log(`Password updated for ${email} (${store.kind}). Restart the server so it takes effect.`);
