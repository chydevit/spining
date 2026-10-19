// JSON-file storage, used when no DATABASE_URL is set (local use and tests).
// Writes are atomic (write temp file, then rename) and serialised so saves never interleave.
// Uploaded images live in <dataDir>/uploads. Sign-in sessions are kept in memory only.
//
// File format (version 2): { version, users: [...], companies: [{ ..., config, spins: [...] }], uploads: { name: companyId } }
// A version-1 file (one game: { config, spins, admin }) is converted on first load.
import fs from 'node:fs';
import path from 'node:path';
import { legacyToTenancy } from '../tenancy.js';

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

  /** Returns { users, companies } (each company carries its spins). */
  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    const raw = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;

    if (raw && !raw.companies) {
      // Version 1 → 2: the single game becomes the first company.
      this.data = { version: 2, users: [], companies: [], uploads: {} };
      if (raw.config && raw.admin) {
        const { user, company } = legacyToTenancy(raw);
        company.spins = raw.spins ?? [];
        this.data.users.push(user);
        this.data.companies.push(company);
        for (const name of await this.listUploads()) this.data.uploads[name] = company.id;
      }
      fs.copyFileSync(this.file, `${this.file}.v1-backup`);
      this.writeNow();
    } else {
      this.data = raw ?? { version: 2, users: [], companies: [], uploads: {} };
    }
    this.data.uploads ??= {};
    for (const c of this.data.companies) c.spins ??= [];

    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'admin@pharmkulen.local').toLowerCase();
    for (let i = 0; i < this.data.users.length; i++) {
      const u = this.data.users[i];
      if (!u.role) {
        u.role = (u.email && u.email.toLowerCase() === superAdminEmail) || i === 0 ? 'superadmin' : 'admin';
      }
    }
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

  // The server mutates the same objects returned by init(), so saving is just writing the file.
  saveUser() { return this.write(); }
  deleteUser(user) {
    const idx = this.data.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) this.data.users.splice(idx, 1);
    return this.write();
  }
  saveCompany() { return this.write(); }
  saveConfig() { return this.write(); }
  addSpin() { return this.write(); }
  updateSpin() { return this.write(); }
  clearSpins() { return this.write(); }
  deleteSpinsByDay() { return this.write(); }


  async deleteCompany(company) {
    for (const [name, owner] of Object.entries(this.data.uploads)) {
      if (owner !== company.id) continue;
      delete this.data.uploads[name];
      await fs.promises.unlink(path.join(this.uploadsDir, name)).catch(() => {});
    }
    return this.write();
  }

  // ----- uploads -----
  async putUpload(name, mime, buf, companyId) {
    await fs.promises.writeFile(path.join(this.uploadsDir, name), buf);
    this.data.uploads[name] = companyId;
    await this.write();
  }

  async getUpload(name) {
    if (!UPLOAD_NAME.test(name)) return null;
    try {
      return { data: await fs.promises.readFile(path.join(this.uploadsDir, name)) };
    } catch {
      return null;
    }
  }

  /** Delete this company's uploads that are no longer used and older than `olderThan`. */
  async pruneUploads(companyId, used, olderThan) {
    let changed = false;
    for (const [name, owner] of Object.entries(this.data.uploads)) {
      if (owner !== companyId || used.has(name)) continue;
      const p = path.join(this.uploadsDir, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && st.mtimeMs >= olderThan) continue;
      await fs.promises.unlink(p).catch(() => {});
      delete this.data.uploads[name];
      changed = true;
    }
    if (changed) await this.write();
  }

  async listUploads() {
    const files = await fs.promises.readdir(this.uploadsDir).catch(() => []);
    return files.filter((f) => UPLOAD_NAME.test(f));
  }

  uploadOwner(name) {
    return this.data.uploads[name] ?? null;
  }

  // ----- sessions (memory only for file storage) -----
  async loadSessions() { return []; }
  async saveSession() {}
  async deleteSession() {}
  async deleteUserSessions() {}
  async deleteAllSessions() {}

  async ping() { return true; }
  async close() { await this.pending; }
}
