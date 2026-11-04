import { realpath, open, opendir, stat, link, copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CARD_PREFIX, isStudyCardHTML } from './studycard-html.mjs';

export const TEXT_LIMIT = 1024 * 1024;
const DIRECTORY_LIMIT = 5000;
const activeUploads = new Set();
const failure = (status, message) => Object.assign(new Error(message), { status });
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
}
function safeRelative(input) {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0') || path.isAbsolute(input) || input.split('/').includes('..')) throw failure(400, '无效的项目相对路径');
  return input === '.' ? '' : path.normalize(input).replace(/^\.\/?$/, '');
}
function readableError(error) {
  if (error.status) return error;
  if (error.code === 'ENOENT') return failure(404, '文件或目录已不存在，请刷新目录');
  if (['EACCES', 'EPERM'].includes(error.code)) return failure(403, '没有读取这个文件或目录的权限');
  if (['ELOOP', 'ENOTDIR'].includes(error.code)) return failure(400, '路径已改变或符号链接无效，请刷新目录');
  if (['ENOSPC', 'EDQUOT'].includes(error.code)) return failure(507, '存储空间不足，无法上传文件');
  return failure(500, '无法读取文件或目录');
}
async function resolve(root, relative) {
  const normalized = safeRelative(relative);
  // Project paths were canonicalized at registration. Do not silently follow
  // a project root that has subsequently been replaced by a symlink.
  if (await realpath(root) !== root) throw failure(409, '项目根目录已改变，请重新添加项目');
  const target = await realpath(path.join(root, normalized));
  if (!inside(root, target)) throw failure(403, '符号链接目标超出了项目目录');
  return { target, relative: normalized };
}
async function openInside(root, relative, directory = false) {
  const resolved = await resolve(root, relative);
  const handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
  try {
    // Verify the descriptor, not only the earlier path lookup, before returning
    // bytes. This also catches ancestor symlink swaps while an agent is working.
    const actual = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!inside(root, actual)) throw failure(403, '路径已移到项目之外，请刷新目录');
    return { ...resolved, handle };
  } catch (error) { await handle.close(); throw error; }
}

export async function listDirectory(root, relative = '') {
  let opened;
  try {
    opened = await openInside(root, relative, true);
    const descriptorPath = `/proc/self/fd/${opened.handle.fd}`;
    const directory = await opendir(descriptorPath);
    const entries = [];
    let truncated = false;
    for await (const entry of directory) {
      if (activeUploads.has(entry.name)) continue;
      if (entries.length >= DIRECTORY_LIMIT) { truncated = true; break; }
      const item = { name: entry.name, path: path.posix.join(opened.relative, entry.name),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', symlink: entry.isSymbolicLink() };
      if (item.symlink) {
        try {
          const target = await realpath(path.join(descriptorPath, entry.name));
          if (!inside(root, target)) { item.blocked = true; item.reason = '链接目标在项目之外'; }
          else { const info = await stat(target); item.type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'; }
        } catch { item.blocked = true; item.reason = '链接目标不可访问'; }
      }
      if (item.type === 'other' && !item.blocked) { item.blocked = true; item.reason = '不支持打开特殊文件'; }
      entries.push(item);
    }
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: opened.relative, entries, truncated, limit: DIRECTORY_LIMIT };
  } catch (error) { throw readableError(error); }
  finally { await opened?.handle.close(); }
}

function uploadName(header) {
  let name;
  try { name = decodeURIComponent(header || ''); } catch { throw failure(400, '文件名无效'); }
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/u.test(name) || Buffer.byteLength(name) > 255) throw failure(400, '文件名无效');
  return name;
}
function collisionName(name, number) {
  if (!number) return name;
  // Reserve suffix space without splitting a Unicode character or losing a normal extension.
  const extension = Buffer.byteLength(path.extname(name)) <= 80 ? path.extname(name) : '';
  const suffix = ` (${number})${extension}`;
  const stem = [...name.slice(0, extension ? -extension.length : undefined)];
  while (Buffer.byteLength(stem.join('') + suffix) > 255) stem.pop();
  return stem.join('') + suffix;
}

export async function uploadProjectFile(root, relative, req, maxBytes) {
  let directory, file, partial, temporary, owned = false, complete = false;
  try {
    const name = uploadName(req.headers['x-file-name']);
    const tooLarge = () => failure(413, `单个文件不能超过 ${maxBytes / (1024 * 1024)} MiB`);
    if (Number(req.headers['content-length']) > maxBytes) throw tooLarge();
    directory = await openInside(root, relative, true);
    const descriptor = `/proc/self/fd/${directory.handle.fd}`;
    temporary = `.codexwui-upload-${randomUUID()}.part`;
    partial = path.join(descriptor, temporary);
    file = await open(partial, 'wx', 0o600); owned = true; activeUploads.add(temporary);
    let size = 0;
    // Keep the socket usable for a 413 response even when Content-Length was omitted.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge();
      await file.writeFile(chunk);
    }
    const info = await file.stat();
    await file.close(); file = null;
    // Pin writes to the opened directory and reject a target moved/replaced during upload.
    const current = await resolve(root, relative);
    if (current.target !== directory.target || await realpath(descriptor) !== directory.target) throw failure(409, '上传目录已改变，请刷新后重试');
    let copy = false;
    for (let number = 0; number < 1000; number++) {
      const finalName = collisionName(name, number), destination = path.join(descriptor, finalName);
      try {
        if (!copy) {
          try { await link(partial, destination); }
          catch (error) {
            // Android shared storage can reject hard links. Exclusive copy still
            // preserves existing files, including dangling symlinks and directories.
            if (!['EACCES', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
            copy = true;
          }
        }
        if (copy) await copyFile(partial, destination, constants.COPYFILE_EXCL);
        complete = true;
        return { name: finalName, path: path.posix.join(directory.relative, finalName), size, modifiedAt: info.mtime.toISOString(), renamed: finalName !== name };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw failure(409, '同名文件过多，请修改文件名后重试');
  } catch (error) { throw readableError(error); }
  finally {
    await file?.close().catch(() => {});
    if (owned) await unlink(partial).catch(() => {});
    activeUploads.delete(temporary);
    await directory?.handle.close();
    if (!complete) req.resume();
  }
}

export async function readTextFile(root, relative) {
  let opened;
  try {
    opened = await openInside(root, relative);
    const info = await opened.handle.stat();
    if (!info.isFile()) throw failure(400, '只能预览普通文件');
    const result = { path: opened.relative, size: info.size, modifiedAt: info.mtime.toISOString(), limit: TEXT_LIMIT };
    // Read one lookahead byte to distinguish EOF from a truncated preview.
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const truncated = count > TEXT_LIMIT;
    const bytes = buffer.subarray(0, Math.min(count, TEXT_LIMIT));
    if (bytes.some(byte => byte === 0 || byte < 9 || (byte > 13 && byte < 32))) return { ...result, kind: 'binary', truncated, reason: '二进制文件不支持文本预览' };
    let text;
    try {
      // Streaming decoding intentionally leaves a trailing incomplete UTF-8
      // character out of a truncated preview rather than inventing replacement text.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
    } catch { return { ...result, kind: 'unsupportedEncoding', truncated, reason: '不是有效的 UTF-8 文本，暂不支持此编码' }; }
    return { ...result, kind: 'text', text, truncated, bytesRead: bytes.length };
  } catch (error) { throw readableError(error); }
  finally { await opened?.handle.close(); }
}

// Links from agents may use absolute paths or ../ within a document. Normalize
// them before applying the same descriptor-based project boundary checks.
async function linkedPath(root, input) {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) throw failure(400, '无效的文件路径');
  let target = path.resolve(root, input);
  // proot can expose the same Termux directory through two absolute paths.
  // Accept an alias only after confirming its real target is in this project.
  if (path.isAbsolute(input) && !inside(root, target)) {
    try { target = await realpath(target); } catch { /* Report the project boundary below. */ }
  }
  if (!inside(root, target)) throw failure(403, '文件不在当前项目目录中，请切换或添加它所属的项目');
  return path.relative(root, target);
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export async function openFileContent(root, input) {
  let opened;
  try {
    opened = await openInside(root, await linkedPath(root, input));
    const info = await opened.handle.stat();
    if (!info.isFile()) throw failure(400, '只能预览普通文件');
    const extension = path.extname(opened.relative).toLowerCase();
    return { ...opened, size: info.size, modifiedAt: info.mtime.toISOString(),
      type: IMAGE_TYPES[extension] || (extension === '.pdf' ? 'application/pdf' : 'text/plain; charset=utf-8'),
      kind: IMAGE_TYPES[extension] ? 'image' : extension === '.pdf' ? 'pdf' : 'text' };
  } catch (error) { await opened?.handle.close(); throw readableError(error); }
}

export async function readFilePreview(root, input) {
  const file = await openFileContent(root, input);
  const metadata = { path: file.relative, size: file.size, modifiedAt: file.modifiedAt, kind: file.kind };
  let studycard = false;
  try {
    if (file.relative.startsWith('StudyCard/') && /\.html$/i.test(file.relative)) {
      const buffer = Buffer.alloc(Buffer.byteLength(CARD_PREFIX));
      await file.handle.read(buffer, 0, buffer.length, 0);
      studycard = isStudyCardHTML(buffer.toString('utf8'));
    }
  } finally { await file.handle.close(); }
  if (file.kind !== 'text') return metadata;
  const result = await readTextFile(root, file.relative);
  if (result.kind === 'text' && /\.(md|markdown)$/i.test(file.relative)) result.kind = 'markdown';
  if (result.kind === 'text' && /\.html?$/i.test(file.relative)) result.kind = studycard ? 'studycard' : 'html';
  return result;
}

// Single byte ranges are enough for PDF.js and native browser readers.
export function fileByteRange(size, header) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) throw failure(416, '无效的文件范围');
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(value => value !== null && !Number.isSafeInteger(value))) throw failure(416, '无效的文件范围');
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start > end || start >= size) throw failure(416, '无效的文件范围');
  return { start, end };
}
