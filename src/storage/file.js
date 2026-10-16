// JSON-file storage, used when no DATABASE_URL is set (local use and tests).
// Writes are atomic (write temp file, then rename) and serialised so saves never interleave.
// Uploaded images live in <dataDir>/uploads. Admin sessions are kept in memory only.
import fs from 'node:fs';
import path from 'node:path';

const UPLOAD_NAME = /^[a-f0-9]{24}\.(png|jpg|webp)$/;

export class FileStore {
  kind = 'file';

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.pending = Promise.resolve();
    this.data = null;
  }

  /** Returns { config, configUpdatedAt, spins, admin } — config/admin are null on first run. */
  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.data = { version: 1, config: null, configUpdatedAt: null, spins: [], admin: null };
    }
    this.data.spins ??= [];
    return this.data;
  }

  writeNow() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Every change rewrites the whole file; errors are passed to the caller.
  write() {
    const next = this.pending.then(() => this.writeNow());
    this.pending = next.catch(() => {});
    return next;
  }

  saveConfig() { return this.write(); }
  saveAdmin() { return this.write(); }
  addSpin() { return this.write(); }
  updateSpin() { return this.write(); }
  clearSpins() { return this.write(); }
  deleteSpinsByDay() { return this.write(); }

  // ----- uploads -----
  async putUpload(name, mime, buf) {
    await fs.promises.writeFile(path.join(this.uploadsDir, name), buf);
  }

  async getUpload(name) {
    if (!UPLOAD_NAME.test(name)) return null;
    try {
      return { data: await fs.promises.readFile(path.join(this.uploadsDir, name)) };
    } catch {
      return null;
    }
  }

  async pruneUploads(used, olderThan) {
    const files = await fs.promises.readdir(this.uploadsDir).catch(() => []);
    for (const f of files) {
      if (used.has(f) || !UPLOAD_NAME.test(f)) continue;
      const p = path.join(this.uploadsDir, f);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && st.mtimeMs < olderThan) await fs.promises.unlink(p).catch(() => {});
    }
  }

  async listUploads() {
    const files = await fs.promises.readdir(this.uploadsDir).catch(() => []);
    return files.filter((f) => UPLOAD_NAME.test(f));
  }

  // ----- sessions (memory only for file storage) -----
  async loadSessions() { return []; }
  async saveSession() {}
  async deleteSession() {}
  async deleteAllSessions() {}

  async ping() { return true; }
  async close() { await this.pending; }
}
