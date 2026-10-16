// Picks the storage backend: PostgreSQL when DATABASE_URL is set, otherwise a JSON file.
import { FileStore } from './file.js';
import { PgStore } from './postgres.js';

export function createStorage({ dataDir, databaseUrl, log } = {}) {
  return databaseUrl ? new PgStore(databaseUrl, { log }) : new FileStore(dataDir);
}

export { FileStore, PgStore };
