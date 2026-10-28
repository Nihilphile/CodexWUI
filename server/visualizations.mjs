import { mkdir, open, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openFileContent } from './files.mjs';

export const VISUALIZE_SERVER = 'codexweb_visualize';
export const TEXT_BYTES = 1024 * 1024;
export const IMAGE_BYTES = 10 * 1024 * 1024;
export const STATE_BYTES = 64 * 1024;
export const VISUALIZE_INSTRUCTIONS = '[CodexWeb visualization instructions]\n本轮运行于 CodexWeb，已提供本地 MCP 服务器 codexweb_visualize 的 visualize 工具。需要在回答中直接展示交互 HTML、Markdown 文档或图片时调用它；调用过程在界面隐藏，产物显示在调用位置。参数 type 为 html/markdown/image；HTML、Markdown 用 content 或项目内 path，图片用项目内 path；可选 title。HTML 使用自包含 CSS/JS 和数据，不依赖 CDN、网络或 localStorage。若工具由 functions.exec 包装，可从 ALL_TOOLS 搜索 codexweb_visualize 后调用对应 tools 方法。正常解释仍用普通回复，不重复输出已发布的源码。仅在可视化有帮助或用户请求时调用。\n[/CodexWeb visualization instructions]';
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const worker = fileURLToPath(new URL('./visualize-mcp.mjs', import.meta.url));

// Thread-local configuration: existing tools and global config are untouched.
export function visualizationConfig(cwd, dataDir) {
  return { [`mcp_servers.${VISUALIZE_SERVER}`]: {
    command: process.execPath, args: [worker, path.resolve(dataDir, 'visualizations'), cwd],
    enabled: true, startup_timeout_sec: 15, tool_timeout_sec: 30,
  } };
}

export const VISUALIZE_TOOL = {
  name: 'visualize', title: '展示交互内容',
  description: 'Display HTML, Markdown or an image directly inside the CodexWeb conversation. The tool call itself is hidden; the published content appears in its place. Call this when an interactive explanation, calculator, simulation, formatted document or image helps the user. For HTML/Markdown supply content OR a project file path; images require path. HTML must be self-contained (inline CSS/JS, embedded data); network requests, external scripts, parent-page access and localStorage are unavailable. Use window.codexVisualize.getState()/setState(JSON) for optional persistent controls and sendMessage(text) to put a follow-up into the composer. Await the codexvisualizeready event before reading restored state. Keep explanatory text in normal assistant messages. Do not repeat the HTML in your answer. Revisions should call visualize again to publish a new immutable version.',
  inputSchema: {
    type: 'object', properties: {
      type: { type: 'string', enum: ['html', 'markdown', 'md', 'image'] },
      title: { type: 'string', maxLength: 200 },
      content: { type: 'string', description: 'Complete HTML or Markdown source. Mutually exclusive with path.' },
      path: { type: 'string', description: 'Project-relative or absolute in-project file path. Required for images.' },
    }, required: ['type'], additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export function isVisualization(item) {
  return item?.type === 'mcpToolCall' && item.server === VISUALIZE_SERVER && item.tool === 'visualize';
}

// Avoid broadcasting large HTML arguments or losing the result to live-cache
// truncation. The model's own tool history remains managed by Codex.
export function visualizationItem(item) {
  if (!isVisualization(item)) return item;
  const { type, title } = item.arguments || {};
  return { ...item, arguments: { type, title } };
}
export function visualizationTurns(turns = []) {
  return turns.map(turn => ({ ...turn, items: turn.items?.map(visualizationItem) }));
}

async function boundedRead(handle, limit) {
  const info = await handle.stat();
  if (!info.isFile()) throw fail(400, '只能发布普通文件');
  if (info.size > limit) throw fail(413, '展示内容超过大小限制');
  const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
  let count = 0;
  while (count < bytes.length) {
    const result = await handle.read(bytes, count, bytes.length - count, count);
    if (!result.bytesRead) break;
    count += result.bytesRead;
  }
  if (count > limit || count > info.size) throw fail(409, '文件在读取时发生变化，请重新发布');
  return bytes.subarray(0, count);
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  // SVG is only served as an image with a restrictive CSP, never as HTML.
  if (/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg[\s>]/i.test(bytes.toString('utf8', 0, 4096))) return 'image/svg+xml';
  throw fail(415, '图片仅支持 PNG、JPEG、WebP、GIF 或 SVG');
}

export class VisualizationStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  location(id, suffix) {
    if (!ID.test(id || '')) throw fail(400, '展示内容标识无效');
    return path.join(this.directory, `${id}.${suffix}`);
  }
  async publish(root, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['type', 'title', 'content', 'path'].includes(key))) throw fail(400, '展示参数无效');
    const type = input.type === 'md' ? 'markdown' : input.type;
    if (!['html', 'markdown', 'image'].includes(type)) throw fail(400, '不支持的展示类型');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw fail(400, '标题过长或无效');
    const hasContent = typeof input.content === 'string', hasPath = typeof input.path === 'string' && input.path.length > 0;
    if (hasContent === hasPath || (type === 'image' && !hasPath) || (input.content !== undefined && !hasContent) || (input.path !== undefined && !hasPath)) throw fail(400, '请提供 content 或 path 中的一项；图片需要 path');
    const limit = type === 'image' ? IMAGE_BYTES : TEXT_BYTES;
    let bytes, sourcePath;
    if (hasPath) {
      const file = await openFileContent(root, input.path);
      try { bytes = await boundedRead(file.handle, limit); sourcePath = file.relative; }
      finally { await file.handle.close(); }
    } else {
      if (Buffer.byteLength(input.content) > limit) throw fail(413, 'HTML / Markdown 最多 1 MiB');
      bytes = Buffer.from(input.content);
    }
    if (!bytes.length) throw fail(400, '展示内容不能为空');
    let mimeType;
    if (type === 'image') mimeType = imageType(bytes);
    else {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw fail(415, 'HTML / Markdown 需要 UTF-8 编码'); }
      mimeType = type === 'html' ? 'text/html' : 'text/markdown';
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const record = { id, type, title: input.title?.trim() || ({ html: '交互内容', markdown: '文档', image: '图片' })[type], root, sourcePath, mimeType, size: bytes.length, createdAt: Date.now() };
    await writeFile(this.location(id, 'bin'), bytes, { mode: 0o600, flag: 'wx' });
    try { await writeFile(this.location(id, 'json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
    catch (error) { await unlink(this.location(id, 'bin')).catch(() => {}); throw error; }
    return { artifactId: id, type, title: record.title, status: 'ready' };
  }
  async record(id) {
    let handle;
    try {
      handle = await open(this.location(id, 'json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const record = JSON.parse((await boundedRead(handle, 16384)).toString('utf8'));
      if (record.id !== id || !['html', 'markdown', 'image'].includes(record.type) || typeof record.root !== 'string' || !Number.isInteger(record.size) || record.size < 1 || record.size > (record.type === 'image' ? IMAGE_BYTES : TEXT_BYTES)) throw fail(500, '展示记录无效');
      return record;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw fail(404, '展示内容已不存在');
      throw error;
    } finally { await handle?.close(); }
  }
  async bytes(record) {
    const handle = await open(this.location(record.id, 'bin'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await boundedRead(handle, record.type === 'image' ? IMAGE_BYTES : TEXT_BYTES);
      if (bytes.length !== record.size) throw fail(409, '展示快照已损坏');
      return bytes;
    } finally { await handle.close(); }
  }
  async state(id) {
    let handle;
    try {
      handle = await open(this.location(id, 'state'), constants.O_RDONLY | constants.O_NOFOLLOW);
      return JSON.parse((await boundedRead(handle, STATE_BYTES)).toString('utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async saveState(id, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > STATE_BYTES) throw fail(413, '组件状态最多 64 KiB');
    const target = this.location(id, 'state'), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
    try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
  }
}
