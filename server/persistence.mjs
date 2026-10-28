import { readFile, writeFile, rename } from 'node:fs/promises';

export class JsonFile {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); this.error = null; }
  async read(fallback) {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  write(value) {
    const data = JSON.stringify(value);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await writeFile(this.file + '.tmp', data, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
      this.error = null;
    });
    this.pending.catch(error => { this.error = error; });
    return this.pending;
  }
  async flush() { await this.pending; }
}
