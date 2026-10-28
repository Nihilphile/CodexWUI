import { mkdir, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 4;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(png|jpg|webp)$/;
const error = (status, message) => Object.assign(new Error(message), { status });

function format(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw error(415, '请选择 PNG、JPEG 或 WebP 图片；其他格式请先转换');
}

// Only opaque IDs from this store may be sent by the browser. Never accept a
// browser-supplied local path or remote URL as an image to give to Codex.
export class ImageStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  location(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw error(400, '图片附件无效，请重新选择');
    return path.join(this.directory, id);
  }
  async upload(req) {
    const contentType = req.headers['content-type']?.split(';')[0];
    if (![...Object.values(TYPES), 'application/octet-stream'].includes(contentType)) throw error(415, '请选择 PNG、JPEG 或 WebP 图片');
    if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES) throw error(413, '单张图片不能超过 10 MiB');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw error(413, '单张图片不能超过 10 MiB');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const extension = format(bytes);
    if (contentType !== 'application/octet-stream' && contentType !== TYPES[extension]) throw error(415, '图片内容与文件类型不一致');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = `${randomUUID()}.${extension}`;
    await writeFile(this.location(id), bytes, { mode: 0o600, flag: 'wx' });
    return { id, url: `/api/images/${id}`, size, type: TYPES[extension] };
  }
  async read(id) {
    const location = this.location(id);
    let file;
    try {
      file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw error(400, '图片文件无效');
      return { bytes: await file.readFile(), type: TYPES[id.split('.').at(-1)] };
    } catch (cause) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(cause.code)) throw error(404, '图片附件不存在，请重新选择');
      throw cause;
    } finally { await file?.close(); }
  }
  async inputs(ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES) throw error(400, '每条消息最多附加 4 张图片');
    return Promise.all(ids.map(async id => {
      await this.read(id);
      return { type: 'localImage', path: this.location(id) };
    }));
  }
}
