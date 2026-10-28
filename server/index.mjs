import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { prepareReload } from './reload.mjs';
import { readFile, writeFile, mkdir, rename, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { CodexConnection } from './codex.mjs';
import { LiveState } from './state.mjs';
import { gitStatus, gitDiff } from './git.mjs';
import { FollowUpQueue } from './queue.mjs';
import { AgentService, deliveryText } from './agents.mjs';
import { listDirectory, readTextFile, readFilePreview, openFileContent } from './files.mjs';
import { AttachmentStore, fileUploadLimit } from './attachments.mjs';
import { ImageStore, MAX_IMAGE_BYTES } from './images.mjs';
import { BtwSessions } from './btw.mjs';
import { StudyCards } from './studycards.mjs';
import { VisualizationStore, visualizationConfig, visualizationItem, visualizationTurns, VISUALIZE_INSTRUCTIONS } from './visualizations.mjs';
import { PendingSteers } from './steers.mjs';
import { SessionLifecycle } from './lifecycle.mjs';
import { resourceLimits } from './limits.mjs';
import { AppConfig, configLimits } from './config.mjs';
import { installShutdownHandlers } from './runtime.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgentThreadSpawn'];
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const httpError = (status, message) => Object.assign(new Error(message), { status });
const text = (value, name, max = 10000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw httpError(400, `${name} 无效`);
  return value;
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, '需要 JSON 请求');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw httpError(413, '消息过长');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}'); } catch { throw httpError(400, '无效 JSON'); }
}

export async function createApp({ codex, reload = prepareReload, dataDir = process.env.DATA_DIR || path.join(ROOT, '.data'), initialProject = process.cwd(), limits = resourceLimits(), maxFileBytes = fileUploadLimit() } = {}) {
  const serverInstance = randomUUID();
  let reloadRequest = null;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const config = new AppConfig({ dataDir, limits, maxFileBytes });
  await config.load();
  Object.assign(limits, configLimits(config.value));
  codex ||= new CodexConnection({ limits });
  const attachments = new AttachmentStore(path.join(dataDir, 'attachments'), { maxBytes: config.value.maxFileMb * 1024 * 1024 });
  const images = new ImageStore(path.join(dataDir, 'uploads'));
  const visualizations = new VisualizationStore(path.join(dataDir, 'visualizations'));
  let saved = { projects: [] };
  try { saved = JSON.parse(await readFile(path.join(dataDir, 'projects.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取项目记录：${error.message}`); }
  if (!Array.isArray(saved.projects)) throw new Error('项目记录格式错误');
  let projects = saved.projects;
  let saveQueue = Promise.resolve();
  function saveProjects() {
    const contents = JSON.stringify({ projects }, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const temporary = path.join(dataDir, 'projects.json.tmp');
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path.join(dataDir, 'projects.json'));
    });
    return saveQueue;
  }
  async function addProject(input) {
    let expanded = text(input, '目录路径', 4096).trim();
    if (expanded === '~' || expanded.startsWith('~/')) expanded = os.homedir() + expanded.slice(1);
    if (!path.isAbsolute(expanded)) throw httpError(400, '请输入绝对路径，或以 ~/ 开头');
    let cwd;
    try { cwd = await realpath(expanded); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
    catch { throw httpError(400, '目录不存在或无法访问'); }
    let project = projects.find(p => p.path === cwd);
    if (!project) {
      project = { id: Buffer.from(cwd).toString('base64url'), path: cwd, name: path.basename(cwd) || cwd };
      projects.push(project);
      await saveProjects();
    }
    return project;
  }
  if (!projects.length) await addProject(initialProject);
  function projectFor(id) {
    const project = projects.find(p => p.id === id);
    if (!project) throw httpError(404, '项目未添加');
    return project;
  }
  const live = new LiveState();
  const clients = new Set();
  const events = [];
  let eventBytes = 0;
  let sequence = 0;
  const loaded = new Set();
  const loading = new Map();
  const starting = new Set();
  const completionPending = new Map();
  let connectionError = null;
  const skillCache = new Map();
  let modelCatalog = null;
  const agentTimes = new Map();
  async function agentWithCompletion(child) {
    const revision = `${child.updatedAt}:${child.status?.type}`;
    let cached = agentTimes.get(child.id);
    if (cached?.revision !== revision) {
      const completion = codex.request('thread/turns/list', { threadId: child.id, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded' })
        .then(result => Math.max(0, ...result.data.map(turn => turn.completedAt || 0)))
        .catch(() => 0);
      cached = { revision, completion }; agentTimes.set(child.id, cached);
      if (agentTimes.size > 256) agentTimes.delete(agentTimes.keys().next().value);
    }
    const completedAt = await cached.completion;
    const observed = [...(live.threads.get(child.id)?.turns.values() || [])];
    return { ...child, lastCompletedAt: Math.max(completedAt, ...observed.map(turn => turn.completedAt || 0)) || null };
  }
  async function models() {
    if (modelCatalog && Date.now() - modelCatalog.time < 60000) return modelCatalog.data;
    const data = [];
    let cursor = null;
    do {
      const page = await codex.request('model/list', { limit: 100, cursor, includeHidden: false });
      data.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    modelCatalog = { time: Date.now(), data };
    return data;
  }
  const queue = new FollowUpQueue({
    file: path.join(dataDir, "queue.json"),
    busy: id => lifecycle.busy(btw.records.get(id)?.threadId || id),
    run: (id, entry) => {
      const side = btw.records.get(id);
      return side ? btw.send(side.parentId, deliveryText(entry), side.id) : startTurn(id, entry);
    },
    changed: id => {
      const side = btw.records.get(id);
      broadcast({ method: 'web/queue', params: { threadId: side ? side.threadId : id, ...(side ? { sessionId: side.id } : {}), queue: queue.snapshot(id) } });
    },
  });
  const steers = new PendingSteers({
    changed: id => broadcast({ method: 'web/steers', params: { threadId: id, steers: steers.snapshot(id) } }),
    send: (id, entry) => {
      if (!codex.ready) throw httpError(503, 'Codex 未连接，这条引导未提交');
      if (live.get(id).activeTurnId !== entry.expectedTurnId) throw httpError(409, '原任务已结束，这条引导未提交；内容已保留');
      return codex.request('turn/steer', { threadId: id, expectedTurnId: entry.expectedTurnId, clientUserMessageId: entry.clientUserMessageId, input: entry.resolvedInput });
    },
  });

  const queueKey = id => btw.byThread.get(id)?.id || id;
  const settled = id => {
    if (!completionPending.has(id)) return;
    const status = completionPending.get(id); completionPending.delete(id);
    queue.complete(queueKey(id), status);
  };
  const lifecycle = new SessionLifecycle({ codex, live, starting, limits, pause: id => queue.pause(queueKey(id)) });
  const btw = new BtwSessions({ codex, live, lifecycle, starting, dataDir, broadcast, queue, steers, settled,
    parent: async id => {
      if (btw.owns(id)) throw httpError(400, '请从主会话打开 BTW');
      const metadata = await readThread(id);
      if (metadata.parentThreadId || metadata.canAcceptDirectInput === false) throw httpError(409, '请从主会话打开 BTW');
      if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加所属项目');
      return metadata;
    },
  });
  await btw.load();
  await queue.load();
  const agents = new AgentService({ dataDir, codex, queue, btw, lifecycle, live,
    projects: () => projects, addProject,
    createThread: async (cwd, input, sourceId) => {
      let model = input.model, effort = input.reasoning;
      const source = sourceId ? await readThread(sourceId) : null;
      model ??= source?.model || config.value.defaultModel;
      effort ??= input.model ? undefined : source?.reasoningEffort || config.value.defaultEffort;
      if (input.model || input.reasoning || (!sourceId && (model || effort))) {
        const catalog = await models();
        const selected = model ? catalog.find(m => m.model === model) : catalog.find(m => m.isDefault);
        if (!selected) throw httpError(400, '请指定当前模型目录中的模型');
        if (effort && !selected.supportedReasoningEfforts?.some(e => e.reasoningEffort === effort)) throw httpError(400, '模型不支持此推理强度');
        model = selected.model;
      }
      const result = await codex.request(sourceId ? 'thread/fork' : 'thread/start', {
        ...(sourceId ? { threadId: sourceId, excludeTurns: true, deferGoalContinuation: true } : {}),
        cwd, ...(model ? { model } : {}),
        config: { ...visualizationConfig(cwd, dataDir), ...(effort ? { model_reasoning_effort: effort } : {}) },
      });
      loaded.add(result.thread.id); lifecycle.markLoaded(result.thread.id);
      return result.thread;
    },
  });
  await agents.load();
  const studycards = new StudyCards({ dataDir, broadcast });
  await studycards.load();
  codex.dynamicToolHandler = params => btw.tool(params);
  const resources = () => ({ ...(codex.resources || {}), limits,
    activeTurns: [...live.threads].filter(([id, value]) => !value.metadata?.parentThreadId && lifecycle.busy(id)).length,
    cleaning: lifecycle.cleaning.size });

  function broadcast(message) {
    const p = message.params;
    if (p?.item) message = { ...message, params: { ...p, item: visualizationItem(p.item) } };
    if (p?.turn?.items) message = { ...message, params: { ...message.params, turn: visualizationTurns([p.turn])[0] } };
    live.ingest(message);
    const entry = { id: ++sequence, data: message };
    const wire = `id: ${entry.id}\ndata: ${JSON.stringify(entry.data)}\n\n`;
    events.push({ id: entry.id, wire });
    eventBytes += Buffer.byteLength(wire);
    while (events.length > 1500 || eventBytes > 3 * 1024 * 1024) eventBytes -= Buffer.byteLength(events.shift().wire);
    for (const res of clients) {
      if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); clients.delete(res); }
      else res.write(wire);
    }
  }
  const onNotification = message => {
    if (message.method === 'thread/started') agents.own(message.params.thread.id);
    if (['turn/started', 'turn/completed', 'thread/closed'].includes(message.method)) agentTimes.delete(message.params.threadId);
    const request = message.method === 'web/approval' ? message.params : null;
    if (request && btw.owns(request.params?.threadId)) {
      const result = request.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : request.method === 'item/tool/requestUserInput' ? { answers: {} } : { decision: 'decline' };
      codex.respond(request.id, result); return;
    }
    broadcast(message);
    studycards.ingest(message);
    lifecycle.ingest(message);
    steers.ingest(message);
    if (message.method === 'thread/closed' || (message.method === 'thread/status/changed' && message.params.status?.type === 'notLoaded')) loaded.delete(message.params.threadId);
    if (message.method === 'turn/completed') {
      const { threadId, turn } = message.params;
      if (starting.has(threadId)) completionPending.set(threadId, turn.status);
      else queue.complete(queueKey(threadId), turn.status);
    }
  };
  codex.on('notification', onNotification);
  const onConnection = state => {
    connectionError = state.error || null;
    if (!state.connected) { loaded.clear(); loading.clear(); lifecycle.disconnect(); queue.pauseAll(); steers.disconnect(); studycards.disconnect(); }
    broadcast({ method: 'web/connection', params: state });
  };
  codex.on('connection', onConnection);
  const startup = codex.start().catch(error => { connectionError = error.message; });

  async function ensureLoaded(id) {
    if (loaded.has(id) && !lifecycle.loaded.has(id)) loaded.delete(id);
    if (loaded.has(id)) return;
    if (!loading.has(id)) {
      loading.set(id, readThread(id).then(metadata => codex.request('thread/resume', {
        threadId: id, excludeTurns: true,
        ...(projects.some(project => project.path === metadata.cwd) && !metadata.parentThreadId
          ? { config: visualizationConfig(metadata.cwd, dataDir) } : {}),
      }))
        .then(result => {
          loaded.add(id); lifecycle.markLoaded(id); agents.own(id);
          live.get(id).metadata = { ...result.thread, turns: [] };
          return result;
        })
        .finally(() => loading.delete(id)));
    }
    await loading.get(id);
  }
  async function readThread(id) {
    const { thread } = await codex.request('thread/read', { threadId: id, includeTurns: false });
    return thread;
  }
  function requireConnected() {
    if (!codex.ready) throw httpError(503, connectionError || 'Codex 正在连接，请稍后再试');
  }

  async function skillsFor(cwd, refresh = false) {
    if (!skillCache.has(cwd) || refresh) {
      const result = await codex.request('skills/list', { cwds: [cwd], forceReload: refresh });
      const skills = (result.data || []).flatMap(group => group.skills || []).filter(skill => skill.enabled !== false);
      skillCache.set(cwd, skills);
    }
    return skillCache.get(cwd);
  }
  async function turnInput(id, input, metadata = null, { agentDelivery = false } = {}) {
    if (typeof input.text !== 'string' || input.text.length > 200000) throw httpError(400, '消息无效');
    const prompt = input.source ? deliveryText(input) : input.text.trim();
    metadata ||= await readThread(id);
    if ((metadata.parentThreadId && !agentDelivery) || metadata.canAcceptDirectInput === false) throw httpError(409, '子代理会话在这里仅供查看');
    if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加这个会话所属的项目目录');
    const fileInputs = await attachments.inputs(input.files);
    const imageInputs = await images.inputs(input.images);
    if (!prompt && !imageInputs.length && !fileInputs.length) throw httpError(400, '请输入消息或选择附件');
    const items = prompt ? [{ type: 'text', text: prompt, text_elements: [] }] : [];
    if (input.skills?.length) {
      if (!Array.isArray(input.skills) || input.skills.length > 20) throw httpError(400, '技能选择无效');
      const available = await skillsFor(metadata.cwd);
      for (const selected of input.skills) {
        const skill = available.find(s => s.path === selected.path && s.name === selected.name);
        if (!skill) throw httpError(400, '所选技能不存在或已禁用，请重新选择');
        items.push({ type: 'skill', name: skill.name, path: skill.path });
      }
    }
    return [...items, ...imageInputs, ...fileInputs];
  }
  async function startTurn(id, input) {
    if (starting.has(id) || live.get(id).activeTurnId) throw httpError(409, '这个会话正在执行，请使用引导或排队');
    lifecycle.reserve(id);
    let capture;
    try {
      const metadata = await readThread(id);
      const items = await turnInput(id, input, metadata, { agentDelivery: input.agentDelivery });
      await ensureLoaded(id);
      items.push({ type: 'text', text: VISUALIZE_INSTRUCTIONS, text_elements: [] });
      capture = await studycards.prepare(id, metadata.cwd);
      if (capture) items.push(capture.input);
      const result = await codex.request('turn/start', { threadId: id, input: items, ...(input.source ? { clientUserMessageId: input.id } : {}) });
      studycards.accepted(capture, result.turn);
      return result;
    } catch (error) {
      studycards.rejected(capture);
      throw error;
    } finally {
      starting.delete(id);
      if (completionPending.has(id)) {
        const status = completionPending.get(id); completionPending.delete(id);
        queue.complete(id, status);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // KaTeX emits per-token style attributes for fraction/subscript geometry.
    // Permit those attributes; stylesheets and scripts still come from self.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
      if (!allowed.has(req.headers.host)) throw httpError(403, '仅允许 localhost 访问');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;
      const query = url.searchParams;
      // Clicking a link from another app/site is a cross-site navigation. The
      // public HTML shell is safe to open; session APIs must remain same-origin.
      const homepageNavigation = req.method === 'GET' && route === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!homepageNavigation) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw httpError(403, '不允许跨站请求');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, '不允许跨站请求');
      }
      const visualizationRoute = route.match(/^\/api\/visualizations\/([^/]+)(?:\/(content|render|state))?$/);
      if (visualizationRoute) {
        const [, id, action] = visualizationRoute;
        const record = await visualizations.record(id);
        const project = projects.find(project => project.path === record.root);
        if (!project) throw httpError(403, '展示内容所属项目未添加');
        if (req.method === 'GET' && !action) return json(res, {
          id, type: record.type, title: record.title, size: record.size,
          project: project.id, directory: record.sourcePath ? path.dirname(record.sourcePath) : '',
          state: await visualizations.state(id),
          ...(record.type === 'markdown' ? { content: (await visualizations.bytes(record)).toString('utf8') } : {}),
        });
        if (req.method === 'POST' && action === 'state') {
          const input = await body(req);
          await visualizations.saveState(id, input.state);
          return json(res, { ok: true });
        }
        if (req.method === 'GET' && action === 'content' && record.type === 'image') {
          const bytes = await visualizations.bytes(record);
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
          res.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
          return res.end(bytes);
        }
        if (req.method === 'GET' && action === 'render' && record.type === 'html') {
          const source = (await visualizations.bytes(record)).toString('utf8');
          const bridge = await readFile(path.join(ROOT, 'public/visualization-runtime.js'), 'utf8');
          const bootstrap = `<meta name="viewport" content="width=device-width, initial-scale=1"><script>${bridge}</script>`;
          const html = /^\s*<!doctype[^>]*>/i.test(source)
            ? source.replace(/^(\s*<!doctype[^>]*>)/i, (_, doctype) => doctype + bootstrap)
            : '<!doctype html>' + bootstrap + source;
          // This route is the only script-enabled generated-content surface.
          // Opaque origin plus CSP keep it separate from the host and its APIs.
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
          res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(html);
        }
        throw httpError(404, '展示接口不存在');
      }
      if (req.method === 'POST' && route === '/api/reload') {
        await body(req);
        if (!reloadRequest) reloadRequest = reload({ dataDir, port, close }).catch(error => { reloadRequest = null; throw error; });
        const commit = await reloadRequest;
        // Queue the shutdown even if the requesting tab disconnects mid-response.
        setTimeout(commit, 150);
        return json(res, { restarting: true, serverInstance }, 202);
      }
      if (reloadRequest && req.method !== 'GET') throw httpError(503, '服务正在重启，请等待恢复');
      if (route === '/api/config') {
        if (req.method === 'GET') return json(res, config.snapshot());
        if (req.method !== 'POST') throw httpError(405, '不支持的配置操作');
        const input = await body(req);
        if (input.instance !== config.instance) throw httpError(409, '服务已重启，请重新读取设置后再保存');
        const result = await config.update(input.settings, input.revision, {
          validate: async (next, previous) => {
            if (next.defaultModel === previous.defaultModel && next.defaultEffort === previous.defaultEffort) return;
            if (!next.defaultModel) return;
            requireConnected();
            const selected = (await models()).find(model => model.model === next.defaultModel);
            if (!selected) throw httpError(400, '默认模型不在当前 Codex 模型目录中');
            if (next.defaultEffort && !(selected.supportedReasoningEfforts || []).some(option => option.reasoningEffort === next.defaultEffort)) throw httpError(400, '默认模型不支持所选推理强度');
          },
          apply: async (next, previous) => {
            const nextLimits = configLimits(next);
            if (next.maxProcesses !== previous.maxProcesses || next.maxRssMb !== previous.maxRssMb) {
              await startup;
              if (codex.ready) {
                if (!codex.updateLimits) throw httpError(503, '当前 Codex 连接不支持动态资源配置');
                await codex.updateLimits(nextLimits);
              }
            }
            Object.assign(limits, nextLimits);
            attachments.maxBytes = next.maxFileMb * 1024 * 1024;
          },
          changed: snapshot => broadcast({ method: 'web/config', params: snapshot }),
          rollbackFailed: async previous => {
            codex.fail?.(new Error('配置保存失败且无法确认旧预算，已停止 Codex；请重启服务'));
            await codex.close();
            Object.assign(limits, configLimits(previous));
            attachments.maxBytes = previous.maxFileMb * 1024 * 1024;
          },
        });
        return json(res, result);
      }
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        const since = Number(req.headers['last-event-id'] || 0);
        if (since && events.length && since >= events[0].id - 1 && since <= sequence) {
          for (const event of events) if (event.id > since) res.write(event.wire);
        }
        // Always rehydrate after reconnect, even if a bounded replay was possible.
        res.write(`data: ${JSON.stringify({ method: 'web/sync', params: { config: config.snapshot(), connected: codex.ready, error: connectionError, live: live.summary(), approvals: [...codex.approvals.values()], btwSessions: [...btw.records.values()] } })}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && route === '/api/bootstrap') {
        return json(res, { app: 'termux-codex-web', root: ROOT, serverPid: process.pid, serverInstance, config: config.snapshot(), projects, connected: codex.ready, error: connectionError, resources: resources(), uploadLimits: { fileBytes: attachments.maxBytes, imageBytes: MAX_IMAGE_BYTES }, live: live.summary(), approvals: [...codex.approvals.values()], btwSessions: [...btw.records.values()] });
      }
      if (req.method === 'GET' && route === '/api/resources') return json(res, resources());
      if (req.method === 'POST' && route === '/api/attachments') return json(res, await attachments.upload(req), 201);
      if (req.method === 'POST' && route === '/api/images') return json(res, await images.upload(req), 201);
      if (req.method === 'GET' && route.startsWith('/api/images/')) {
        const image = await images.read(decodeURIComponent(route.slice('/api/images/'.length)));
        res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=86400' });
        return res.end(image.bytes);
      }
      if (req.method === 'POST' && route === '/api/projects') {
        const input = await body(req);
        return json(res, { project: await addProject(input.path) });
      }
      if (req.method === 'GET' && route === '/api/git/status') return json(res, await gitStatus(projectFor(query.get('project')).path));
      if (req.method === 'GET' && route === '/api/files/list') return json(res, await listDirectory(projectFor(query.get('project')).path, query.get('path') || ''));
      if (req.method === 'GET' && route === '/api/files/read') return json(res, await readTextFile(projectFor(query.get('project')).path, query.get('path')));
      if (req.method === 'GET' && route === '/api/files/preview') return json(res, await readFilePreview(projectFor(query.get('project')).path, query.get('path')));
      if (req.method === 'GET' && route === '/api/files/content') {
        const file = await openFileContent(projectFor(query.get('project')).path, query.get('path'));
        try {
          // Even a mislabeled SVG/HTML file must not run scripts with app access.
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
          const name = encodeURIComponent(path.basename(file.relative)).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          res.writeHead(200, { 'Content-Type': query.get('download') === '1' ? 'application/octet-stream' : file.type,
            'Content-Length': file.size, 'Cache-Control': 'no-store',
            'Content-Disposition': `${query.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${name}` });
          await pipeline(file.handle.createReadStream({ autoClose: false }), res);
        } finally { await file.handle.close(); }
        return;
      }
      if (req.method === 'GET' && route === '/api/git/diff') {
        const project = projectFor(query.get('project'));
        const file = query.get('path');
        if (file && (path.isAbsolute(file) || file.split('/').includes('..') || file.includes('\0'))) throw httpError(400, '无效文件路径');
        return json(res, await gitDiff(project.path, query.get('staged') === 'true', file));
      }
      if (route.startsWith('/api/')) {
        requireConnected();
        if (req.method === 'POST' && route === '/api/agents') return json(res, await agents.execute(await body(req)));
        const btwMatch = route.match(/^\/api\/btw\/([^/]+)(?:\/(open|send|stop|steer|steer-edit|steer-update|steer-cancel-edit|steer-remove|steer-send|queue|queue-remove|queue-run|queue-edit|queue-update))?$/);
        if (btwMatch) {
          const parentId = decodeURIComponent(btwMatch[1]);
          if (req.method === 'GET' && !btwMatch[2]) return json(res, { ...await btw.snapshot(parentId, query.get('session')), eventSequence: sequence });
          if (req.method === 'POST') {
            const input = await body(req);
            if (btwMatch[2] === 'open') return json(res, { ...await btw.open(parentId), eventSequence: sequence });
            if (btwMatch[2] === 'send') return json(res, await btw.send(parentId, input.text, input.sessionId));
            if (btwMatch[2] === 'stop') return json(res, await btw.stop(parentId, input.sessionId));
            if (btwMatch[2]?.startsWith('steer') || btwMatch[2]?.startsWith('queue')) return json(res, await btw.control(parentId, input.sessionId, btwMatch[2], input));
          }
          throw httpError(405, '不支持的 BTW 操作');
        }
        if (req.method === 'GET' && route === '/api/models') return json(res, { models: await models() });
        if (req.method === 'GET' && route === '/api/threads') {
          const project = projectFor(query.get('project'));
          const result = await codex.request('thread/list', {
            cwd: project.path, limit: 50, cursor: query.get('cursor'), sortKey: 'updated_at', modelProviders: [],
          });
          result.data = result.data.filter(thread => !btw.owns(thread.id));
          return json(res, result);
        }
        if (req.method === 'GET' && route === '/api/skills') {
          return json(res, { skills: await skillsFor(projectFor(query.get('project')).path, query.get('refresh') === 'true') });
        }
        if (req.method === 'GET' && route === '/api/history/projects') {
          const result = await codex.request('thread/list', { limit: 100, cursor: query.get('cursor'), sortKey: 'updated_at', modelProviders: [] });
          return json(res, { paths: [...new Set(result.data.map(t => t.cwd))], nextCursor: result.nextCursor });
        }
        if (req.method === 'POST' && route === '/api/threads') {
          const input = await body(req);
          const project = projectFor(input.project);
          const defaults = config.value;
          const result = await codex.request('thread/start', { cwd: project.path,
            ...(defaults.defaultModel ? { model: defaults.defaultModel } : {}),
            config: { ...visualizationConfig(project.path, dataDir), ...(defaults.defaultEffort ? { model_reasoning_effort: defaults.defaultEffort } : {}) },
          });
          loaded.add(result.thread.id);
          lifecycle.markLoaded(result.thread.id);
          return json(res, result);
        }
        const match = route.match(/^\/api\/threads\/([^/]+)(?:\/(turns|send|stop|cleanup|children|steer|steer-edit|steer-update|steer-cancel-edit|steer-remove|steer-send|queue|queue-remove|queue-run|queue-edit|queue-update|compact|model|studycard))?$/);
        if (match) {
          const id = decodeURIComponent(match[1]);
          const action = match[2];
          if (btw.owns(id)) throw httpError(403, 'BTW 会话只能通过只读侧聊接口操作');
          if (action === 'studycard' && ['GET', 'POST'].includes(req.method)) {
            const metadata = await readThread(id);
            if (metadata.parentThreadId || metadata.canAcceptDirectInput === false) throw httpError(409, '子代理会话在这里仅供查看');
            if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加这个会话所属的项目目录');
            if (req.method === 'GET') return json(res, { studycard: studycards.snapshot(id) });
            const input = await body(req);
            if (typeof input.enabled !== 'boolean') throw httpError(400, 'StudyCard 开关无效');
            return json(res, { studycard: await studycards.set(id, metadata.cwd, input.enabled), appliesTo: 'nextTurn' });
          }
          if (req.method === 'POST' && action === 'model') {
            const input = await body(req);
            const metadata = await readThread(id);
            if (metadata.parentThreadId || metadata.canAcceptDirectInput === false) throw httpError(409, '子代理会话在这里仅供查看');
            if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加这个会话所属的项目目录');
            const model = (await models()).find(m => m.model === input.model);
            if (!model) throw httpError(400, '模型不在当前 Codex 模型目录中，请重新打开选择器');
            const supported = model.supportedReasoningEfforts || [];
            const effort = input.effort ?? model.defaultReasoningEffort;
            if (supported.length && !supported.some(option => option.reasoningEffort === effort)) throw httpError(400, '这个模型不支持所选 reasoning 强度');
            if (!supported.length && input.effort != null) throw httpError(400, '这个模型没有可选择的 reasoning 强度');
            await ensureLoaded(id);
            await codex.request('thread/settings/update', {
              threadId: id, model: model.model, ...(supported.length ? { effort } : {}),
            });
            const updated = await readThread(id);
            return json(res, { thread: updated, appliesTo: 'nextTurn' });
          }
          if (req.method === 'GET' && !action) {
            const thread = await readThread(id);
            let history;
            try { history = await codex.request('thread/turns/list', { threadId: id, limit: 20, sortDirection: 'desc', itemsView: 'full' }); }
            catch (error) {
              if (!loaded.has(id) || live.get(id).turns.size) throw error;
              history = { data: [], nextCursor: null };
            }
            history = { ...history, data: visualizationTurns(history.data) };
            return json(res, { thread, history, eventSequence: sequence, live: live.snapshot(id), queue: queue.snapshot(id), steers: steers.snapshot(id), studycard: studycards.snapshot(id), approvals: [...codex.approvals.values()].filter(a => a.params.threadId === id) });
          }
          if (req.method === 'GET' && action === 'turns') {
            const result = await codex.request('thread/turns/list', { threadId: id, limit: 20, cursor: query.get('cursor'), sortDirection: 'desc', itemsView: 'full' });
            return json(res, { ...result, data: visualizationTurns(result.data) });
          }
          if (req.method === 'GET' && action === 'children') {
            const result = await codex.request('thread/list', {
              ancestorThreadId: id, sourceKinds: SOURCES, modelProviders: [], limit: 100, cursor: query.get('cursor'), sortKey: 'updated_at', sortDirection: 'desc',
            });
            // Read only turn metadata, in small batches; never pull every child's
            // message history just to order its card. Reuse unchanged results.
            const data = [];
            for (let index = 0; index < result.data.length; index += 4) data.push(...await Promise.all(result.data.slice(index, index + 4).map(agentWithCompletion)));
            return json(res, { ...result, data });
          }
          if (req.method === 'POST' && action === 'send') {
            const input = await body(req);
            return json(res, await startTurn(id, { text: input.text, skills: input.skills, images: input.images, files: input.files }));
          }
          if (req.method === 'POST' && action === 'steer') {
            const input = await body(req);
            const resolvedInput = await turnInput(id, input);
            const turnId = live.get(id).activeTurnId;
            if (!turnId || input.expectedTurnId !== turnId) throw httpError(409, '任务状态已变化，请检查后重新发送；草稿已保留');
            if (input.clientUserMessageId !== undefined && !/^[\w-]{1,100}$/.test(text(input.clientUserMessageId, '消息标识', 100))) throw httpError(400, '消息标识无效');
            steers.add(id, { ...input, resolvedInput });
            return json(res, { turnId, steers: steers.snapshot(id) });
          }
          if (req.method === 'POST' && action?.startsWith('steer-')) {
            const input = await body(req);
            text(input.id, '引导标识', 100);
            if (!Number.isInteger(input.revision)) throw httpError(400, '引导版本无效');
            const metadata = await readThread(id);
            if (metadata.parentThreadId || metadata.canAcceptDirectInput === false) throw httpError(409, '子代理会话在这里仅供查看');
            if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加这个会话所属的项目目录');
            let entry;
            if (action === 'steer-edit') entry = steers.beginEdit(id, input.id, input.revision);
            if (action === 'steer-update') {
              const resolvedInput = await turnInput(id, input);
              const pending = steers.get(id, input.id, input.revision);
              entry = steers.update(id, input.id, input.revision, { ...input, resolvedInput }, live.get(id).activeTurnId === pending.expectedTurnId);
            }
            if (action === 'steer-cancel-edit') steers.cancelEdit(id, input.id, input.revision);
            if (action === 'steer-remove') steers.remove(id, input.id, input.revision);
            if (action === 'steer-send') await steers.dispatch(id, input.id, input.revision);
            return json(res, { entry, steers: steers.snapshot(id) });
          }
          if (req.method === 'GET' && action === 'queue') return json(res, queue.snapshot(id));
          if (req.method === 'POST' && action === 'queue') {
            const input = await body(req);
            await turnInput(id, input); // Validate while the browser can still correct the draft.
            const result = queue.add(id, { text: input.text, skills: input.skills || [], images: input.images || [], files: input.files || [] });
            if (!live.get(id).activeTurnId && !starting.has(id)) void queue.drain(id);
            await queue.flush();
            return json(res, result);
          }
          if (req.method === 'POST' && action === 'queue-remove') {
            const input = await body(req);
            queue.remove(id, input.id, input.revision);
            await queue.flush();
            return json(res, queue.snapshot(id));
          }
          if (req.method === 'POST' && ['queue-edit', 'queue-update', 'queue-run'].includes(action)) {
            const input = await body(req);
            let entry;
            if (action === 'queue-edit') entry = queue.edit(id, input.id, input.revision);
            if (action === 'queue-update') queue.update(id, input.id, input.revision, input.text);
            if (action === 'queue-run') {
              queue.resume(id, input.id, input.revision);
              if (!lifecycle.busy(id)) await queue.drain(id);
            }
            await queue.flush();
            return json(res, { ...queue.snapshot(id), entry });
          }
          if (req.method === 'POST' && action === 'compact') {
            await body(req);
            if (live.get(id).activeTurnId) throw httpError(409, '请等待当前任务结束后再压缩');
            const metadata = await readThread(id);
            if (metadata.parentThreadId) throw httpError(409, '子代理会话仅供查看');
            await ensureLoaded(id);
            return json(res, await codex.request('thread/compact/start', { threadId: id }));
          }
          if (req.method === 'POST' && action === 'stop') {
            await body(req);
            queue.pause(id);
            await lifecycle.clean(id, { stop: true });
            await queue.flush();
            return json(res, { ok: true });
          }
          if (req.method === 'POST' && action === 'cleanup') {
            await body(req);
            const metadata = await readThread(id);
            if (metadata.parentThreadId || metadata.canAcceptDirectInput === false) throw httpError(409, '子代理会话在这里仅供查看');
            if (!projects.some(p => p.path === metadata.cwd)) throw httpError(403, '请先添加这个会话所属的项目目录');
            await lifecycle.clean(id, { release: true });
            return json(res, { ok: true });
          }
        }
        if (req.method === 'POST' && route === '/api/approvals') {
          const input = await body(req);
          const request = codex.approvals.get(String(input.id));
          if (!request) throw httpError(409, '请求已处理或过期');
          let result;
          if (request.method === 'item/tool/requestUserInput') {
            const answers = {};
            for (const question of request.params.questions) {
              const answer = input.answers?.[question.id];
              if (!Array.isArray(answer) || !answer.length || answer.some(x => typeof x !== 'string' || x.length > 10000)) throw httpError(400, '请回答所有问题');
              answers[question.id] = { answers: answer };
            }
            result = { answers };
          } else if (request.method === 'item/permissions/requestApproval') {
            if (!['accept', 'decline'].includes(input.decision)) throw httpError(400, '无效选择');
            result = { permissions: input.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
          } else {
            if (!['accept', 'decline', 'cancel'].includes(input.decision)) throw httpError(400, '无效选择');
            const available = request.params.availableDecisions;
            if (available && !available.includes(input.decision)) throw httpError(400, 'Codex 未提供这个选项');
            result = { decision: input.decision };
          }
          codex.respond(input.id, result);
          return json(res, { ok: true });
        }
        throw httpError(404, '接口不存在');
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/btw.js': ['btw.js', 'text/javascript'], '/reload.js': ['reload.js', 'text/javascript'], '/files.js': ['files.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      Object.assign(assets, {
        '/config.js': ['config.js', 'text/javascript'],
        '/config.css': ['config.css', 'text/css'],
        '/file-preview.html': ['file-preview.html', 'text/html'],
        '/file-preview.js': ['file-preview.js', 'text/javascript'],
        '/file-preview.css': ['file-preview.css', 'text/css'],
        '/markdown.js': ['markdown.js', 'text/javascript'],
        '/visualizations.js': ['visualizations.js', 'text/javascript'],
        '/visualizations.css': ['visualizations.css', 'text/css'],
        '/vendor/markdown-it.min.js': ['vendor/markdown-it.min.js', 'text/javascript'],
        '/vendor/katex/katex.min.js': ['vendor/katex/katex.min.js', 'text/javascript'],
        '/vendor/katex/katex.min.css': ['vendor/katex/katex.min.css', 'text/css'],
      });
      const font = route.match(/^\/vendor\/katex\/fonts\/(KaTeX_[A-Za-z0-9_-]+\.(woff2?|ttf))$/);
      const asset = assets[route] || (font && [`vendor/katex/fonts/${font[1]}`, { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' }[font[2]]]);
      if (req.method !== 'GET' || !asset) throw httpError(404, '页面不存在');
      const data = await readFile(path.join(ROOT, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1].startsWith('font/') ? asset[1] : `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (error) {
      if (!res.headersSent) json(res, { error: error.message || '操作失败' }, error.status || 500);
      else res.end();
    }
  });
  server.requestTimeout = 120000;
  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    lifecycle.close();
    steers.close();
    codex.off('notification', onNotification);
    codex.off('connection', onConnection);
    const queueClosed = queue.close();
    for (const res of clients) res.end();
    const httpClosed = new Promise(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    closePromise = Promise.all([codex.close(), httpClosed, studycards.close(), config.queue.catch(() => {}), queueClosed, agents.close()]).then(([result]) => result);
    return closePromise;
  }
  server.on('close', () => { void close(); });
  return { agents, queue, btw, studycards, visualizations, server, codex, startup, live, lifecycle, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
  const app = await createApp();
  app.server.on('error', error => { console.error(`启动失败：${error.message}`); void app.close(); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`Codex Web 已启动：http://localhost:${port}\n仅供本机访问。保持此进程运行；Ctrl+C 停止服务。`));
  installShutdownHandlers(app);
}
