import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}--[^/\\\x00-\x1f\x7f]{1,180}$/u;
const error = (status, message) => Object.assign(new Error(message), { status });

export function fileUploadLimit(env = process.env) {
  const mb = env.CODEXWEB_MAX_FILE_MB === undefined ? MAX_FILE_BYTES / (1024 * 1024) : Number(env.CODEXWEB_MAX_FILE_MB);
  if (!Number.isSafeInteger(mb) || mb < 1 || !Number.isSafeInteger(mb * 1024 * 1024)) throw new Error('CODEXWEB_MAX_FILE_MB 必须是有效的正整数（MiB）');
  return mb * 1024 * 1024;
}

export class AttachmentStore {
  constructor(directory, { maxBytes = fileUploadLimit() } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('文件上传上限必须是正整数字节数');
    this.directory = path.resolve(directory); this.maxBytes = maxBytes;
  }
  location(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw error(400, '文件附件无效，请重新选择');
    return path.join(this.directory, id);
  }
  async upload(req) {
    const maxBytes = this.maxBytes; // Keep one limit for the entire upload, including config changes.
    let name;
    try { name = decodeURIComponent(req.headers['x-file-name'] || 'file'); }
    catch { throw error(400, '文件名无效'); }
    name = name.replace(/[/\\\x00-\x1f\x7f]/g, '_');
    // Leave space for the UUID on filesystems with a 255-byte component limit.
    while (Buffer.byteLength(name) > 180) name = [...name].slice(0, -1).join('');
    if (!name || name === '.' || name === '..') name = 'file';
    const tooLarge = () => error(413, `单个文件不能超过 ${maxBytes / (1024 * 1024)} MiB`);
    if (Number(req.headers['content-length']) > maxBytes) { req.resume(); throw tooLarge(); }
    let size = 0;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = `${randomUUID()}--${name}`;
    // Partial files do not match attachment IDs and are published only at EOF.
    const partial = path.join(this.directory, `.${id}.upload`);
    let file, owned = false, complete = false;
    try {
      file = await open(partial, 'wx', 0o600); owned = true;
      // Keep the HTTP request usable so a chunked oversized upload can receive
      // a 413 response instead of having its socket destroyed by iterator.return.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBytes) throw tooLarge();
        await file.writeFile(chunk);
      }
      await file.close(); file = null;
      await rename(partial, this.location(id)); complete = true;
      return { id, name, size };
    } finally {
      await file?.close().catch(() => {});
      if (owned && !complete) await unlink(partial).catch(() => {});
      if (!complete) req.resume();
    }
  }
  async inputs(ids = []) {
    if (!Array.isArray(ids) || ids.length > 4) throw error(400, '每条消息最多附加 4 个文件');
    return Promise.all(ids.map(async id => {
      const location = this.location(id);
      let file;
      try {
        file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (!info.isFile() || info.size > this.maxBytes) throw error(400, '文件附件无效');
      } catch (cause) {
        if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(cause.code)) throw error(404, '文件附件不存在，请重新选择');
        throw cause;
      } finally { await file?.close(); }
      return { type: 'text', text: `用户上传的文件（可使用本机工具读取）：${JSON.stringify({ name: id.slice(38), path: location })}`, text_elements: [] };
    }));
  }
}
