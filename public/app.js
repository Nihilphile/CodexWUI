const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = {
  projects: [], project: null, threads: new Map(), ordered: [], nextThreads: null,
  active: null, connected: false, connectionError: null, approvals: new Map(), inspector: 'files',
  skills: [], events: [], eventCounter: 0, drafts: new Map(), sendBusy: new Set(),
  openDetails: new Set(), git: null, diffStaged: false, filter: '',
  models: [],
  uploadLimits: null,
  sidebarCollapsed: window.innerWidth <= 760,
};
const COMMANDS = [
  ['config', '调整全局限制、默认模型与文件展开形式'],
  ['plugin', '管理已安装插件的全局开关'],
  ['reload', '重启后端并自动刷新，停止运行中的任务'],
  ['new', '在当前项目新建会话'], ['resume', '打开项目与历史会话'],
  ['stop', '停止任务并清理后台'], ['cleanup', '清理空闲会话的后台进程'], ['compact', '压缩当前会话上下文'],
  ['skills', '选择当前项目可用的技能'], ['status', '查看当前会话状态'],
  ['model', '选择当前会话的模型、推理强度与权限'],
  ['btw', '打开独立侧聊，可联网搜索'],
  ['StudyCard', '开启当前会话的知识卡片自动归档'],
  ['StudyCard --stop', '关闭归档，下一轮提示 agent 停用'],
  ['StudyCard --status', '查看知识卡片开关与保存目录'],
  ['files', '浏览项目目录和文件原文'], ['agents', '打开子代理面板'], ['diff', '打开 Git diff'],
  ['help', '查看快捷命令与运行中发送说明'],
];
const SLASH_QUERY = /^\/([\w:-]*(?:[ \t]+--[\w-]*)?[ \t]*)$/;
function builtinCommandName(value) {
  const name = value.match(/^\/([\w-]+)(?=\s|$)/)?.[1];
  return name && (name.toLowerCase() === 'plugins' || COMMANDS.some(([command]) => command.split(/\s/)[0].toLowerCase() === name.toLowerCase())) ? name : null;
}
let suggestionMode = null;
let toastTimer;
let renderTimer;
const dirtyRegions = new Set();
let selectedSkills = [];
let resolvingSlashSkill = false;
let selectedImages = [];
let threadRequest = 0;
let projectRequest = 0;
let activeRecovery = null;
let lastStreamSequence = 0;
let lastStreamReceivedAt = Date.now();
let streamNeedsBaseline = true;
let events;
const STREAM_RECOVERY_MS = 10000;
let creatingThread = null;
let modelDialogThread = null;
let modelDialogAuthority = 'default';
let modelRecovery = null;
const turnActionsBusy = new Set(), turnActionIds = new Map();
try { for (const [key, value] of JSON.parse(sessionStorage.getItem('codex-turn-actions') || '[]')) turnActionIds.set(key, value); } catch {}
let pendingSubmissions = new Map();
try { pendingSubmissions = new Map(JSON.parse(sessionStorage.getItem('codex-pending-sends') || '[]')); } catch {}
try { state.drafts = new Map(JSON.parse(sessionStorage.getItem('codex-drafts') || '[]')); } catch {}
let usageDialogThread = null;
const AUTHORITY_LABELS = { default: '默认', 'read-only': '只读', workspace: '工作区', full: '完全访问' };
const AUTHORITY_DESCRIPTIONS = { default: '使用本机 Codex 权限与审批配置。', 'read-only': '只读沙箱；需要额外权限时询问。', workspace: '允许写入工作区；需要额外权限时询问。', full: '不限制文件与网络访问，命令执行不请求审批。' };
let steerEditor = null;
let memoryUsage = null;
let memoryPending = false;
let memoryFailed = false;
const btw = new window.CodexBtwPanel($('btw-view'), { api, markdown, escape, notify: toast, renderItem, getUploadLimit: () => state.uploadLimits?.fileBytes,
  mountMessages: (root, entries, context) => visualizations.render(root, entries, context),
  bringBack: (id, text) => {
    if (state.active !== id || state.sendBusy.has(id)) { toast('请等待主会话消息发送完成'); return; }
    const addition = `BTW 讨论结论：\n${text}`;
    $('prompt').value = [$('prompt').value, addition].filter(Boolean).join('\n\n');
    saveDraft(); sizePrompt(); closeInspector(); $('prompt').focus(); toast('已放入主输入框，检查后发送');
  },
});
const reloadStatus = document.createElement('div');
reloadStatus.className = 'reload-status'; reloadStatus.hidden = true; reloadStatus.setAttribute('role', 'status'); document.body.append(reloadStatus);
const serviceReload = new window.CodexServiceReload({
  fetch: (...args) => fetch(...args), refresh: () => window.location.reload(),
  status: (message, failed) => { document.querySelectorAll('main, aside, dialog').forEach(element => { element.inert = serviceReload.running; }); reloadStatus.hidden = false; reloadStatus.textContent = message; reloadStatus.classList.toggle('failed', Boolean(failed)); renderHeader(); },
  save: () => {
    saveDraft();
    const drafts = [...state.drafts].map(([key, draft]) => [key, { ...draft, text: /^\/reload$/i.test(draft.text.trim()) ? '' : draft.text,
      images: draft.images.map(image => image.id ? image : { ...image, error: '上传因重启中断，请移除后重选' }) }]);
    btw.rememberDraft();
    const btwAttachments = [...btw.attachments].map(([key, items]) => [key, items.map(item => item.id ? item : { ...item, error: '上传因重启中断，请移除后重选' })]);
    sessionStorage.setItem('codex-reload-drafts', JSON.stringify({ drafts, btw: [...btw.drafts], btwAttachments, btwSelected: [...btw.selected] }));
  },
});
try {
  const saved = JSON.parse(sessionStorage.getItem('codex-reload-drafts') || 'null');
  if (saved) { state.drafts = new Map(saved.drafts); btw.drafts = new Map(saved.btw); btw.attachments = new Map(saved.btwAttachments || []); btw.selected = new Map(saved.btwSelected || []); sessionStorage.removeItem('codex-reload-drafts'); }
} catch { sessionStorage.removeItem('codex-reload-drafts'); }
const files = new window.CodexFilePanel($('files-view'), { api, notify: toast, getUploadLimit: () => state.uploadLimits?.fileBytes, onReload: () => serviceReload.run() });
const terminalPanel = new window.CodexTerminalPanel($('terminal-view'), { api, notify: toast });
const configPanel = new window.CodexConfigPanel({ api, notify: toast, changed: snapshot => {
  state.webConfig = snapshot;
  files.setExpandMode(snapshot.settings.fileExpandMode);
  state.uploadLimits = { ...state.uploadLimits, fileBytes: snapshot.settings.maxFileMb * 1024 * 1024 };
  files.renderUpload();
  $('attach-file').title = `添加文件 · 单个最多 ${snapshot.settings.maxFileMb} MiB`;
  if (memoryUsage) memoryUsage.limits = { ...memoryUsage.limits, maxRssMb: snapshot.settings.maxRssMb };
  scheduleRender();
} });
$('open-config').onclick = () => { void configPanel.open(); };
const pluginPanel = new window.CodexPluginPanel({ api, project: () => state.project });
const accountQuota = new window.CodexAccountQuota({ api });
let skillRequest = 0;
const visualizations = new window.CodexVisualizations({ api, markdown: (text, env) => window.CodexMarkdown(text, env),
  bringBack: (id, text) => {
    if (state.active !== id || current()?.meta.parentThreadId || current()?.meta.canAcceptDirectInput === false || state.sendBusy.has(id)) { toast('请在所属主会话中使用此操作'); return; }
    $('prompt').value = [$('prompt').value, text].filter(Boolean).join('\n\n');
    saveDraft(); sizePrompt(); $('prompt').focus(); toast('已放入输入框，检查后发送');
  },
});
const mainWindow = new window.CodexTurnWindow({
  scroller: $('message-scroll'), root: $('messages'), button: $('more-turns'),
  key: () => state.active, read: id => state.threads.get(id), loadOlder: moreTurns,
  changed: () => scheduleRender(['messages']), fail: error => toast(error.message),
});

function renderMemory() {
  accountQuota.setConnected(state.connected);
  accountQuota.render();
  const limit = state.webConfig?.settings.maxRssMb ?? memoryUsage?.limits?.maxRssMb;
  const maximum = Number.isFinite(limit) && limit > 0 ? String(Number((limit / 1024).toFixed(1))) : '--';
  const fresh = state.connected && !memoryFailed && Number.isFinite(memoryUsage?.rssMb) &&
    memoryUsage.rssMb >= 0 && Number.isFinite(memoryUsage.sampledAt) &&
    Date.now() - memoryUsage.sampledAt <= 15000;
  $('memory-usage').textContent = `RAM ${fresh ? (memoryUsage.rssMb / 1024).toFixed(1) : '--'}/${maximum}G`;
  $('memory-usage').title = `CodexWUI、守护进程及工具的合计内存（RSS，GiB）。${fresh ? '每 5 秒更新' : '暂无最新数据'}`;
}

async function refreshMemory() {
  if (document.hidden || memoryPending) return;
  memoryPending = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/resources', { signal: controller.signal });
    if (!response.ok) throw new Error('内存数据暂不可用');
    memoryUsage = await response.json(); memoryFailed = false;
  } catch { memoryFailed = true; }
  finally { clearTimeout(timeout); memoryPending = false; renderMemory(); }
}

async function api(url, data, options = {}) {
  const response = await fetch(url, { ...(data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }), ...options });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), result, { status: response.status });
  return result;
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function guard(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => toast(error.message)); }
function thread(id) {
  if (!state.threads.has(id)) state.threads.set(id, { meta: { id }, turns: new Map(), children: new Map(), activeTurnId: null, queue: { entries: [] }, steers: { entries: [], version: -1 }, sendingSteers: new Map(), loaded: false });
  return state.threads.get(id);
}
function current() { return state.active ? thread(state.active) : null; }
function title(t) { return t?.meta.name || t?.meta.preview || t?.meta.agentNickname || '新会话'; }
function statusText(t) {
  if (t && [...state.approvals.values()].some(a => a.params.threadId === t.meta.id)) return '等待回复';
  if (t?.activeTurnId || t?.meta.status?.type === 'active') return '执行中';
  if (t?.meta.status?.type === 'systemError') return '异常';
  return '就绪';
}
function relativeTime(timestamp) {
  if (!timestamp) return '刚刚';
  const delta = Date.now() / 1000 - timestamp;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return new Date(timestamp * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function markdown(text = '') { return window.CodexMarkdown(text, { project: state.project }); }
function updateLayout() {
  const collapsed = state.sidebarCollapsed, inspectorOpen = !$('inspector').hidden;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  document.body.classList.toggle('inspector-open', inspectorOpen);
  $('sidebar').hidden = collapsed;
  $('sidebar').classList.toggle('open', !collapsed);
  $('scrim').hidden = collapsed || window.innerWidth > 760;
  $('inspector-scrim').hidden = !inspectorOpen || collapsed || window.innerWidth > 1100;
  $('open-sidebar').setAttribute('aria-expanded', String(!collapsed));
  $('open-sidebar').setAttribute('aria-label', collapsed ? '展开会话列表' : '收起会话列表');
  $('open-sidebar').title = collapsed ? '展开会话列表' : '收起会话列表';
  $('toggle-inspector').setAttribute('aria-expanded', String(inspectorOpen));
  $('toggle-inspector').setAttribute('aria-label', inspectorOpen ? '收起右侧面板' : '打开右侧面板');
}
function openSidebar(open = true) {
  if (open && window.innerWidth <= 1100 && !$('inspector').hidden) closeInspector();
  state.sidebarCollapsed = !open; updateLayout();
  if (!open && $('sidebar').contains(document.activeElement)) $('open-sidebar').focus();
}
function dismissMobileSidebar() { if (window.innerWidth <= 760) openSidebar(false); }
function openInspector(view = state.inspector, btwQuestion) {
  if (view !== 'files') files.expand(false);
  if (view !== 'terminal') terminalPanel.hide();
  state.inspector = view;
  $('inspector').hidden = false;
  updateLayout();
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    $(button.dataset.view + '-view').hidden = !active;
  });
  if (view === 'files') files.show();
  else if (view === 'terminal') void terminalPanel.show();
  else if (view === 'btw') {
    btw.setParent(state.active, !current()?.meta.parentThreadId && current()?.meta.canAcceptDirectInput !== false);
    guard(() => btw.show(state.active, btwQuestion))();
  }
  else if (view === 'agents') guard(loadAgents)(); else guard(loadGit)();
}
const inspectorTabs = document.querySelector('.inspector-tabs');
inspectorTabs.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-view]');
  if (!tab || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const tabs = [...inspectorTabs.querySelectorAll('[data-view]')];
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const next = tabs[Math.max(0, Math.min(tabs.length - 1, tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1)))];
    tabs.forEach(button => { button.tabIndex = button === next ? 0 : -1; });
    next.focus(); next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); openInspector(tab.dataset.view);
    if (tab.dataset.view === 'files') files.setTabFocus(files.current?.active || '', true);
    else $(tab.dataset.view + '-view').focus();
  }
});
function closeInspector() { files.expand(false); terminalPanel.hide(); $('inspector').hidden = true; updateLayout(); }
function saveDraft() {
  state.drafts.set(state.active || `new:${state.project}`, { text: $('prompt').value, skills: selectedSkills, images: selectedImages });
  persistDrafts();
}
function persistDrafts() { try { sessionStorage.setItem('codex-drafts', JSON.stringify([...state.drafts])); } catch {} }
function persistSubmissions() { try { sessionStorage.setItem('codex-pending-sends', JSON.stringify([...pendingSubmissions])); } catch {} }
function persistTurnActions() { try { sessionStorage.setItem('codex-turn-actions', JSON.stringify([...turnActionIds])); } catch {} }
function restoreDraft() {
  const draft = state.drafts.get(state.active || `new:${state.project}`);
  $('prompt').value = draft?.text || ''; selectedSkills = draft?.skills || [];
  selectedImages = draft?.images || [];
  renderSkillChips(); renderImages(); sizePrompt();
}
function renderImages() {
  const container = $('image-attachments');
  container.hidden = !selectedImages.length;
  container.innerHTML = window.CodexAttachments.html(selectedImages, escape, state.sendBusy.has(state.active));
  renderHeader();
}
async function attachImages(files, kind = 'image') {
  if ($(kind === 'file' ? 'attach-file' : 'attach-image').disabled) return;
  window.CodexAttachments.add(files, kind, selectedImages, { maxFileBytes: state.uploadLimits?.fileBytes, notify: toast, changed: () => { saveDraft(); renderImages(); } });
}
function imageSource(input) {
  if (input.type === 'localImage') {
    const id = input.path?.split('/').at(-1);
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(png|jpg|webp)$/.test(id || '')) return `/api/images/${id}`;
  }
  if (input.type === 'image' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.url || '')) return input.url;
  return null;
}
function renderProjects() {
  $('project-select').innerHTML = state.projects.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
  $('project-select').value = state.project || '';
  const project = state.projects.find(p => p.id === state.project);
  files.setProject(project);
  terminalPanel.setProject(project);
  $('project-path').textContent = project?.path || '';
  $('project-path').title = project?.path || '';
}
function renderSidebar() {
  const filtered = state.ordered.filter(id => title(thread(id)).toLowerCase().includes(state.filter));
  $('thread-list').innerHTML = filtered.length ? filtered.map(id => {
    const t = thread(id); const status = statusText(t);
    const dot = status === '执行中' ? 'busy' : status === '等待回复' ? 'waiting' : status === '异常' ? 'failed' : '';
    return `<button class="thread-entry ${state.active === id ? 'selected' : ''}" data-thread="${escape(id)}"><span class="status-dot ${dot}"></span><span class="thread-entry-text"><span class="thread-entry-title">${escape(title(t))}</span><span class="thread-entry-meta">${status !== '就绪' ? `${status} · ` : ''}${relativeTime(t.meta.updatedAt)}</span></span></button>`;
  }).join('') : '<div class="empty-state">这里还没有会话<br>开始一个新的任务吧</div>';
  $('more-threads').hidden = !state.nextThreads;
}
function renderHeader() {
  const t = current(); const project = state.projects.find(p => p.id === state.project);
  $('turn-count').textContent = t?.turnCount == null ? '' : ` · 第 ${t.turnCount} 轮`;
  $('thread-title').textContent = t ? title(t) : '开始一段新的工作';
  $('breadcrumb').textContent = `${project?.name || '本地工作台'}${t?.meta.parentThreadId ? ' / 子代理' : ' / 会话'}${t?.studycard?.enabled ? ' · StudyCard 已开启' : ''}`;
  $('back-parent').hidden = !t?.meta.parentThreadId;
  $('back-parent').dataset.thread = t?.meta.parentThreadId || '';
  $('thread-status').textContent = state.connected ? statusText(t) : '未连接';
  const modelText = [t?.meta.model || '默认', t?.meta.reasoningEffort || '默认', AUTHORITY_LABELS[(t ? t.authority : state.webConfig?.settings.defaultAuthority) || 'default'] || '默认'].join(' / ');
  $('model-label').textContent = `${modelText}${t?.pendingModel && t.activeTurnId ? ' · 下轮' : ''} ▾`;
  $('model-label').title = `Model / Reasoning / Authority：${modelText} — /model 设置当前会话`;
  const busy = [...state.threads.values()].filter(v => v.meta.cwd === project?.path && (v.activeTurnId || v.meta.status?.type === 'active'));
  $('parallel-note').hidden = busy.length < 2;
  $('parallel-note').textContent = `${busy.length} 个会话正在并行执行，共享项目目录，请留意对同一文件的修改。`;
  $('connection-label').textContent = state.connected ? 'Codex 已连接' : '正在重连';
  $('connection-dot').className = `status-dot ${state.connected ? 'online' : ''}`;
  $('connection-banner').hidden = state.connected;
  $('connection-banner').textContent = state.connectionError || '连接暂不可用。重新连接后会恢复视图；若 Codex 进程已退出，请重启服务。';
  renderMemory();
  renderUsage();
  const readOnly = Boolean(t?.meta.parentThreadId || t?.meta.canAcceptDirectInput === false);
  $('model-label').disabled = !state.connected || readOnly;
  const running = Boolean(t?.activeTurnId);
  const sending = resolvingSlashSkill || state.sendBusy.has(state.active);
  $('readonly-note').hidden = !readOnly;
  $('prompt').disabled = readOnly || sending;
  $('attach-image').disabled = readOnly || sending || selectedImages.filter(item => item.kind !== 'file').length >= 4;
  $('attach-file').disabled = readOnly || sending || !state.uploadLimits || selectedImages.filter(item => item.kind === 'file').length >= 4;
  $('skill-menu').disabled = $('command-menu').disabled = readOnly || sending;
  const reloadCommand = /^\/(?:reload|config)$/i.test($('prompt').value.trimStart().split(/\r?\n/)[0].trim());
  $('send').disabled = serviceReload.running || (!reloadCommand && (!state.connected || readOnly || sending || selectedImages.some(image => !image.id)));
  $('send-mode').hidden = !running || readOnly;
  $('stop-turn').hidden = !running || readOnly;
  const command = builtinCommandName($('prompt').value.trimStart());
  $('send').textContent = command ? `执行 /${command}` : running ? ($('send-mode').value === 'queue' ? '排队 ＋' : '引导 ↑') : '发送 ↑';
  $('prompt').placeholder = readOnly ? '从父会话查看和协调子代理' : running ? '补充方向，或加入下一轮消息…' : '描述你想完成的工作…  / 命令  $ 技能';
}
function usagePercent(usage) {
  const used = usage?.last?.totalTokens, capacity = usage?.modelContextWindow;
  return Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(capacity) && capacity > 0 ? Math.round(used / capacity * 100) : null;
}
function tokenNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  return value >= 1000000 ? `${Number((value / 1000000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
}
function renderUsage() {
  const t = current(), u = t?.usage, pct = usagePercent(u);
  $('context-strip').hidden = !t;
  $('context-strip').classList.toggle('high', pct !== null && pct >= 80);
  $('context-fill').style.width = `${Math.min(100, pct ?? 0)}%`;
  $('context-label').textContent = u?.compacting && state.connected ? '正在压缩…' : pct === null ? '上下文 —' : `上下文已用 ${pct}%`;
  $('context-status').textContent = !state.connected ? '离线 · 上次回报' : u?.compacting ? '正在压缩上下文' : t?.compactedFrom != null && pct !== null && pct < t.compactedFrom ? `已压缩 · ${t.compactedFrom}% → ${pct}%` : pct >= 80 ? '上下文占用较高' : '';
  if (!$('usage-dialog').open || !usageDialogThread) return;
  const detail = thread(usageDialogThread), usage = detail.usage, percent = usagePercent(usage);
  $('usage-thread').textContent = `${title(detail)} · 仅此会话，不合并子代理或 BTW`;
  $('usage-context').textContent = `${tokenNumber(usage?.last?.totalTokens)} / ${tokenNumber(usage?.modelContextWindow)}${percent === null ? '' : ` · ${percent}%`}`;
  $('usage-progress').value = Math.min(100, percent ?? 0); $('usage-progress').hidden = percent === null;
  $('usage-freshness').textContent = usage?.updatedAt ? `${state.connected ? '最近回报' : '离线快照'} ${new Date(usage.updatedAt).toLocaleString()}。按最近一次请求总 token 与引擎回报窗口计算，不含未发送草稿；压缩阈值由 Codex 决定。` : '尚无引擎用量回报。完成一次请求后更新。';
  for (const [id, key] of [['input', 'inputTokens'], ['cached', 'cachedInputTokens'], ['output', 'outputTokens'], ['reasoning', 'reasoningOutputTokens'], ['total', 'totalTokens']]) {
    const value = usage?.total?.[key], element = $(`usage-${id}`);
    element.textContent = tokenNumber(value); element.title = Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '暂无数据';
  }
  const readOnly = detail.meta.parentThreadId || detail.meta.canAcceptDirectInput === false;
  $('usage-compact').disabled = !state.connected || Boolean(readOnly || detail.activeTurnId || usage?.compacting || detail.compactPending);
  $('usage-compact').textContent = usage?.compacting || detail.compactPending ? '正在压缩…' : '压缩上下文';
  $('usage-compact-note').textContent = readOnly ? '请在父会话协调子代理的上下文。' : detail.activeTurnId ? '当前任务结束后可手动压缩上下文。' : '压缩会用摘要替代较早内容，部分细节可能不再保留。';
}
function uploadedFileName(text) {
  const prefix = '用户上传的文件（可使用本机工具读取）：';
  if (typeof text !== 'string' || !text.startsWith(prefix)) return null;
  try {
    const file = JSON.parse(text.slice(prefix.length));
    if (typeof file.name !== 'string' || !file.name || typeof file.path !== 'string') return null;
    const id = file.path.split('/').at(-1);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}--/.test(id) || id.slice(38) !== file.name) return null;
    return file.name;
  } catch { return null; }
}
function renderItem(item) {
  if (item.type === 'userMessage') {
    const content = (item.content || []).map(c => {
      if (c.type === 'text' && /^\[(CodexWUI|CodexWeb) (StudyCard|visualization) instructions\]\n[\s\S]*\n\[\/\1 \2 instructions\]$/.test(c.text)) return '';
      if (c.type === 'image' || c.type === 'localImage') {
        const source = imageSource(c);
        return source ? `<a href="${escape(source)}" target="_blank" rel="noopener noreferrer"><img class="message-image" src="${escape(source)}" alt="已发送的图片" loading="lazy"></a>` : '<p>图片附件（此历史图片无法预览）</p>';
      }
      const fileName = c.type === 'text' ? uploadedFileName(c.text) : null;
      if (fileName) return `<p class="message-file">📎 文件：${escape(fileName)}</p>`;
      return markdown(c.type === 'text' ? c.text : c.type === 'skill' ? `$${c.name}` : `[${c.type}]`);
    }).join('');
    return `<article class="message user"><div class="message-label">你</div><div class="prose">${content}</div></article>`;
  }
  if (item.type === 'agentMessage' || item.type === 'plan') return `<article class="message assistant"><div class="message-label"><span class="agent-avatar">⌘</span> CODEX${item.type === 'plan' ? ' · 计划' : ''}</div><div class="prose">${markdown(item.text || '')}</div></article>`;
  const names = { commandExecution: '执行命令', fileChange: '修改文件', mcpToolCall: 'MCP 工具', dynamicToolCall: '调用工具', collabAgentToolCall: '协作子代理', webSearch: '搜索', reasoning: '思考', contextCompaction: '压缩上下文', imageView: '查看图片', imageGeneration: '生成图片' };
  const label = names[item.type] || item.type || '活动';
  let detail = '';
  let summary = label;
  if (item.type === 'commandExecution') { summary = item.command || label; detail = item.aggregatedOutput || '等待输出…'; }
  else if (item.type === 'reasoning') detail = [...(item.summary || []), ...(item.content || [])].join('\n');
  else if (item.type === 'fileChange') detail = (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n\n');
  else if (item.type === 'collabAgentToolCall') { summary = `${label} · ${item.tool}`; detail = item.prompt || JSON.stringify(item.agentsStates || {}, null, 2); }
  else if (item.type === 'mcpToolCall') { summary = `${item.server} / ${item.tool}`; detail = JSON.stringify(item.result || item.error || item.arguments || {}, null, 2); }
  else detail = JSON.stringify(item, null, 2);
  if (item.type === 'reasoning' && !detail) return '';
  const status = ({ inProgress: '执行中', completed: '完成', failed: '失败', declined: '已拒绝' })[item.status] || item.status || '';
  return `<details class="tool-card" data-detail="${escape(item.id)}" ${state.openDetails.has(item.id) ? 'open' : ''}><summary><span class="tool-state">${escape(status)}</span>${escape(summary).slice(0, 250)}</summary><pre class="tool-output">${escape(detail)}</pre></details>`;
}
function renderMessages() {
  const t = current();
  mainWindow.commit(state.active, () => {
    if (!t || !t.turns.size) {
      visualizations.render($('messages'), [], state.active);
      $('messages').innerHTML = `<div class="welcome"><div class="welcome-mark">⌘</div><div class="eyebrow">YOUR LOCAL WORKSPACE</div><h2>${t?.loading ? '正在读取会话…' : '把想法，变成下一步。'}</h2><p>从一个问题、一项改动，或一段尚未完成的工作开始。<br>Codex 就在你的本机项目中。</p><div class="starter-list"><button class="starter" data-starter="先阅读这个项目，简要说明它的结构和运行方式。">了解这个项目 <span>↗</span></button><button class="starter" data-starter="检查当前 Git diff，指出需要留意的问题，先不要修改文件。">审阅当前改动 <span>↗</span></button><button class="starter" data-starter="帮我规划下一步实现；遇到独立研究问题时，可以派发子代理。">规划下一步工作 <span>↗</span></button></div></div>`;
    } else {
      const entries = [];
      for (const turn of mainWindow.visible(state.active, t.turns)) {
        if (entries.length) entries.push({ key: `${state.active}:${turn.id}:divider`, html: '<hr class="turn-divider">' });
        for (const item of turn.items.values()) {
          const key = `${state.active}:${turn.id}:${item.id}`;
          if (window.CodexVisualizations.matches(item)) entries.push({ key, item });
          else { const html = renderItem(item); if (html) entries.push({ key, html }); }
        }
        const error = turnFooter(t, turn);
        const card = t.studycard?.results?.find(result => result.turnId === turn.id);
        const project = state.projects.find(project => project.path === t.meta.cwd);
        const saved = card?.status === 'saved' && project ? `<div class="input-note">StudyCard 已保存 · <a href="/file-preview.html?${escape(new URLSearchParams({ project: project.id, path: card.path }).toString())}" target="_blank" rel="noopener noreferrer">${escape(card.path)}</a>${card.warning ? ` · ${escape(card.warning)}` : ''}</div>` : card?.status === 'error' ? `<div class="turn-error">StudyCard 未归档：${escape(card.error)}</div>` : '';
        if (error || saved) entries.push({ key: `${state.active}:${turn.id}:footer`, html: `<div>${error + saved}</div>` });
      }
      for (const entry of (t.recovery || []).filter(entry => !entry.turnId && ['unknown', 'rejected'].includes(entry.state))) {
        const attrs = `data-recovery-id="${escape(entry.id)}" data-action-thread="${escape(state.active)}"`;
        entries.push({ key: `${state.active}:unsent:${entry.id}`, html: `<div class="turn-failure"><p>${escape(entry.state === 'unknown' ? '发送结果待确认，请先检查会话历史。' : entry.failure?.summary || '这条消息尚未发送，内容已保留。')}</p><div class="turn-actions"><button data-turn-action="check" ${attrs}>检查发送结果</button><button data-turn-action="resend" ${attrs} ${turnActionsBusy.has(state.active) ? 'disabled' : ''}>${entry.state === 'unknown' ? '重新发送…' : '重试发送'}</button><button data-turn-action="edit" ${attrs}>编辑后发送</button></div></div>` });
      }
      if (t.activeTurnId) entries.push({ key: `${state.active}:running`, html: '<div class="running-line"><span class="status-dot busy"></span>Codex 正在工作</div>' });
      visualizations.render($('messages'), entries, state.active);
    }
  });
}
function turnFooter(t, turn) {
  const id = t.meta.id;
  const readOnly = t.meta.parentThreadId || t.meta.canAcceptDirectInput === false;
  const disabled = !state.connected || turnActionsBusy.has(id) ? 'disabled' : '';
  const attrs = `data-action-thread="${escape(id)}" data-action-turn="${escape(turn.id)}"`;
  const mode = turn.recoveryMode || ([...turn.items.values()].length && [...turn.items.values()].every(item => item.type === 'userMessage') ? 'retry' : 'continue');
  let html = '';
  if (turn.retrying && turn.status === 'inProgress') html += '<div class="turn-retrying" role="status">连接暂时受阻，Codex 正在重试…</div>';
  if (turn.status === 'failed' || turn.status === 'interrupted') {
    const failure = turn.failure;
    const newer = t.lastTurnId && t.lastTurnId !== turn.id;
    const recovered = turn.recoveredBy || t.recovery?.some(entry => entry.sourceTurnId === turn.id && entry.turnId);
    const uncertain = t.recovery?.some(entry => entry.sourceTurnId === turn.id && ['preparing', 'dispatching', 'unknown'].includes(entry.state));
    const busy = t.activeTurnId || state.sendBusy.has(id) || newer || recovered || uncertain;
    html += `<div class="turn-failure"><p>${escape(turn.status === 'interrupted' ? '任务已停止，可以继续未完成的工作。' : failure?.summary || '本轮未完成，原消息已保留。')}</p>${recovered ? '<p>已发起恢复。</p>' : ''}${!readOnly ? `<div class="turn-actions"><button data-turn-action="${mode}" ${attrs} ${disabled || busy ? 'disabled' : ''}>${mode === 'retry' ? '重试这条消息' : '继续未完成任务'}</button><button data-turn-action="model" data-recovery-mode="${mode}" ${attrs} ${disabled || busy ? 'disabled' : ''}>换模型${mode === 'retry' ? '重试' : '继续'}</button><button data-turn-action="edit" ${attrs} ${disabled}>${newer ? '分叉并编辑' : '编辑后发送'}</button></div>` : ''}${failure?.details || turn.error ? `<details><summary>查看详情</summary><pre>${escape(failure?.details || turn.error?.message || JSON.stringify(turn.error)).slice(0, 24000)}</pre></details>` : ''}</div>`;
  }
  if (!readOnly && turn.status !== 'inProgress') html += `<div class="turn-actions"><button data-turn-action="fork" ${attrs} ${disabled}>⑂ 从此处分叉</button></div>`;
  return html ? `<div class="turn-footer">${html}</div>` : '';
}

async function refreshTurnCount(id) {
  const t = thread(id);
  if (t.countPending) { t.countAgain = true; return; }
  t.countPending = true;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(id)}/turn-count`);
    t.turnCount = result.count; t.lastTurnId = result.lastTurnId;
    if (state.active === id) scheduleRender();
  } catch {} finally {
    t.countPending = false;
    if (t.countAgain) { t.countAgain = false; void refreshTurnCount(id); }
  }
}

async function performTurnAction(id, action, target = {}, settings = {}) {
  if (turnActionsBusy.has(id)) return;
  const key = JSON.stringify([id, action, target, settings]);
  if (!turnActionIds.has(key)) { turnActionIds.set(key, crypto.randomUUID()); persistTurnActions(); }
  turnActionsBusy.add(id); scheduleRender();
  try {
    const result = await api(`/api/threads/${encodeURIComponent(id)}/${action === 'fork' ? 'fork' : 'recover'}`, {
      ...target, action, actionId: turnActionIds.get(key), ...settings,
    });
    if (result.recovery) thread(id).recovery = result.recovery;
    if (action === 'fork') {
      const t = thread(result.thread.id); t.meta = result.thread; t.authority = result.authority;
      if (!state.ordered.includes(t.meta.id)) state.ordered.unshift(t.meta.id);
      await selectThread(t.meta.id);
    } else if (action !== 'edit') await hydrateThread(id, { preserveHistory: true });
    turnActionIds.delete(key); persistTurnActions();
    return result;
  } catch (error) {
    if (error.status && !error.deliveryUnknown && !error.retrySameOperation) { turnActionIds.delete(key); persistTurnActions(); }
    if (state.active === id) await hydrateThread(id, { preserveHistory: true }).catch(() => {});
    throw error;
  } finally { turnActionsBusy.delete(id); scheduleRender(); }
}

async function turnAction(button) {
  const id = button.dataset.actionThread;
  const target = button.dataset.actionTurn ? { turnId: button.dataset.actionTurn } : { recoveryId: button.dataset.recoveryId };
  const action = button.dataset.turnAction;
  if (action === 'model') { await showModelPicker({ id, target, action: button.dataset.recoveryMode }); return; }
  if (action === 'edit') {
    if (state.active !== id || $('prompt').value.trim() || selectedImages.length || selectedSkills.length) throw new Error('请先处理输入框中的草稿，再恢复这条消息');
    const result = await performTurnAction(id, 'edit', target);
    if (!result) return;
    if (state.active !== id || $('prompt').value.trim() || selectedImages.length || selectedSkills.length) throw new Error('输入框已有新草稿，恢复内容未覆盖它');
    if (!result.latest) await performTurnAction(id, 'fork', { ...target, before: true });
    else if (state.active !== id) return;
    $('prompt').value = result.input.text; selectedSkills = result.input.skills || [];
    selectedImages = [...(result.input.images || []).map(image => ({ key: crypto.randomUUID(), id: image, name: '图片', kind: 'image', url: `/api/images/${image}` })),
      ...(result.input.files || []).map(file => ({ key: crypto.randomUUID(), id: file, name: file.slice(38), kind: 'file' }))];
    saveDraft(); renderSkillChips(); renderImages(); sizePrompt(); $('prompt').focus();
    return;
  }
  if (action === 'resend') {
    const record = thread(id).recovery?.find(entry => entry.id === target.recoveryId);
    if (record?.state === 'unknown' && !window.confirm('上次发送结果尚未确认。再次发送可能重复执行任务。已检查历史，仍要重新发送吗？')) return;
    await performTurnAction(id, action, target, { confirmDuplicate: true });
    return;
  }
  await performTurnAction(id, action, target);
}
function renderApprovals() {
  const requests = [...state.approvals.values()].filter(a => a.params.threadId === state.active);
  const signature = JSON.stringify(requests);
  if ($('approval-list').dataset.signature === signature) return;
  $('approval-list').dataset.signature = signature;
  $('approval-list').innerHTML = requests.map(a => {
    const p = a.params;
    if (a.method === 'item/tool/requestUserInput') return `<form class="approval" data-input-request="${escape(a.id)}"><h3>Codex 需要你的回答</h3>${p.questions.map(q => `<label>${escape(q.header || '')}<p>${escape(q.question)}</p>${q.options?.length ? `<select data-answer-options="${escape(q.id)}"><option value="">选择建议答案，或在下方输入</option>${q.options.map(o => `<option value="${escape(o.label)}">${escape(o.label)}${o.description ? ` — ${escape(o.description)}` : ''}</option>`).join('')}</select>` : ''}<input data-answer="${escape(q.id)}" placeholder="你的回答" type="${q.isSecret ? 'password' : 'text'}" autocomplete="off"></label>`).join('')}<div class="approval-actions"><button class="accept" type="submit">提交回答</button></div></form>`;
    const available = p.availableDecisions;
    return `<div class="approval"><h3>${a.method.includes('permissions') ? '权限请求' : a.method.includes('fileChange') ? '文件修改审批' : '命令执行审批'}</h3><p>${escape(p.reason || '请检查这次操作')}</p><pre>${escape(p.command || JSON.stringify(p.permissions || p, null, 2))}</pre><div class="approval-actions">${!available || available.includes('accept') ? `<button class="accept" data-approval="${escape(a.id)}" data-decision="accept">允许本次</button>` : ''}${!available || available.includes('decline') ? `<button data-approval="${escape(a.id)}" data-decision="decline">拒绝</button>` : ''}${available?.includes('cancel') ? `<button data-approval="${escape(a.id)}" data-decision="cancel">取消任务</button>` : ''}</div></div>`;
  }).join('');
}
function renderQueue() {
  const q = current()?.queue;
  const html = window.CodexQueue.html(q, state.active, escape);
  window.CodexQueue.mount($('queue-list'), html);
}
function setSteers(id, snapshot) {
  const t = thread(id);
  if (snapshot && (snapshot.instance !== t.steers.instance || snapshot.version >= t.steers.version)) t.steers = snapshot;
}
function renderSteers() {
  const t = current();
  const entries = t ? [...t.steers.entries, ...[...t.sendingSteers.values()].filter(entry => !t.steers.entries.some(other => other.id === entry.id))] : [];
  const received = new Set(t ? [...t.turns.values()].flatMap(turn => [...turn.items.values()].filter(item => item.type === 'userMessage').map(item => item.clientId)) : []);
  $('steer-list').innerHTML = entries.filter(entry => !received.has(entry.id)).map(entry => {
    const canEdit = ['staged', 'editing', 'failed'].includes(entry.status);
    const label = ({ staging: '正在暂存…', staged: '待发送 · 等待当前执行轮次结束', editing: '正在编辑 · 已暂停发送', submitting: '正在提交 · 无法撤回', accepted: '已提交 · 等待 Codex 接收', failed: '未提交 · 内容已保留', unknown: '提交结果待确认 · 请勿重复发送' })[entry.status];
    const attrs = `data-steer-id="${escape(entry.id)}" data-steer-revision="${entry.revision}"`;
    return `<article class="pending-steer" data-pending-steer="${escape(entry.id)}"><div class="pending-steer-label">预引导 · <span data-steer-status="${escape(entry.id)}">${escape(label)}</span></div><div class="pending-steer-text">${escape(entry.text)}</div>${entry.skills?.length ? `<div class="pending-steer-skills">${entry.skills.map(skill => escape('$' + skill.name)).join(' ')}</div>` : ''}${window.CodexAttachments.pending(entry, escape)}${entry.error ? `<p class="error-text">${escape(entry.error)}</p>` : ''}<div class="pending-steer-actions">${canEdit ? `<button type="button" data-steer-action="edit" ${attrs}>修改</button><button type="button" data-steer-action="remove" ${attrs}>${entry.status === 'failed' ? '移除' : '撤回'}</button>` : ''}${entry.status === 'staged' ? `<button type="button" data-steer-action="send" ${attrs}>立即引导</button>` : ''}<button type="button" data-steer-action="copy" ${attrs}>复制文字</button></div></article>`;
  }).join('');
}
function renderSteerEditor() {
  const entry = steerEditor?.entry;
  $('steer-edit-attachments').innerHTML = entry ? (entry.files || []).map((id, index) => `<button type="button" data-edit-remove-file="${index}">📎 ${escape(id.slice(38))} ×</button>`).join('') + (entry.skills || []).map((skill, index) => `<button type="button" data-edit-remove-skill="${index}" class="skill-chip">$${escape(skill.name)} ×</button>`).join('') + (entry.images || []).map((id, index) => `<button type="button" data-edit-remove-image="${index}" aria-label="移除引导图片"><img src="/api/images/${encodeURIComponent(id)}" alt="引导图片"> ×</button>`).join('') : '';
}
async function steerAction(button) {
  const id = state.active; const action = button.dataset.steerAction;
  const entry = current()?.steers.entries.find(entry => entry.id === button.dataset.steerId) || current()?.sendingSteers.get(button.dataset.steerId);
  if (!entry) throw new Error('引导消息状态已变化，请稍后重试');
  if (action === 'copy') { await navigator.clipboard.writeText(entry.text); toast('已复制引导文字'); return; }
  button.disabled = true;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(id)}/steer-${action}`, { id: entry.id, revision: Number(button.dataset.steerRevision) });
    setSteers(id, result.steers);
    if (action === 'edit') {
      steerEditor = { threadId: id, entry: result.entry };
      $('steer-text').value = result.entry.text;
      $('steer-error').textContent = ''; renderSteerEditor();
      $('steer-dialog').showModal(); $('steer-text').focus();
    }
    if (action === 'remove') toast('已撤回，这条内容不会提交给 Codex');
  } catch (error) {
    // A loop boundary or another tab may have won the race. Never fake a recall.
    guard(() => hydrateThread(id))(); throw error;
  } finally { button.disabled = false; renderSteers(); }
}
async function closeSteerEditor() {
  if (!steerEditor || $('save-steer').disabled) return;
  const { threadId, entry } = steerEditor;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/steer-cancel-edit`, { id: entry.id, revision: entry.revision });
    setSteers(threadId, result.steers);
  } catch (error) { toast(error.message); }
  finally { steerEditor = null; $('steer-dialog').close(); renderSteers(); }
}
function agentRunning(child) {
  const loaded = thread(child.id);
  if (loaded.activeTurnId) return true;
  const status = loaded.meta.status?.type || child.status?.type;
  if (status === 'active') return true;
  if (status === 'idle' || status === 'systemError') return false;
  return ['running', 'pendingInit'].includes(child.collabStatus);
}
function agentRecency(child) {
  const metadata = thread(child.id).meta;
  return Math.max(metadata.lastCompletedAt || 0, child.lastCompletedAt || 0) || metadata.updatedAt || child.updatedAt || child.createdAt || 0;
}
function renderAgents() {
  const t = current(); const children = t ? [...t.children.values()] : [];
  children.sort((a, b) => Number(agentRunning(b)) - Number(agentRunning(a)) || agentRecency(b) - agentRecency(a) || a.id.localeCompare(b.id));
  $('agent-count').textContent = children.length;
  $('agent-summary').textContent = children.length ? `${children.length} 个子代理` : '';
  $('more-agents').hidden = !t?.nextChildren;
  $('agents-list').innerHTML = children.length ? children.map(c => {
    const loaded = thread(c.id);
    const busy = agentRunning(c);
    const status = busy ? '执行中' : ({ completed: '完成', errored: '异常', interrupted: '已中断', shutdown: '已结束', notFound: '暂不可用' })[c.collabStatus] || (loaded.meta.status?.type === 'systemError' ? '异常' : loaded.meta.status?.type === 'idle' ? '空闲' : '历史记录');
    return `<article class="agent-card"><header><span class="status-dot ${busy ? 'busy' : ''}"></span><strong>${escape(c.agentNickname || c.name || '子代理')}</strong><span class="agent-role">${escape(c.agentRole || 'agent')}</span></header><p>${escape((c.preview || c.prompt || c.message || '查看会话了解任务进展').slice(0, 500))}</p><footer><span>${status}</span><button data-thread="${escape(c.id)}">查看会话 ↗</button></footer></article>`;
  }).join('') : '<div class="empty-state"><div class="empty-symbol">⑂</div>暂时没有子代理<br>当 Codex 派发任务时，会在这里显示。<br>你也可以在消息中明确请求使用子代理。</div>';
}
function scheduleRender(regions = ['sidebar', 'header', 'messages', 'approvals', 'queue', 'steers', 'agents', 'parent']) {
  for (const region of regions) dirtyRegions.add(region);
  if (renderTimer || document.hidden) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (document.hidden) return;
    const pending = new Set(dirtyRegions); dirtyRegions.clear();
    if (pending.has('sidebar')) renderSidebar();
    if (pending.has('header')) renderHeader();
    if (pending.has('messages')) renderMessages();
    if (pending.has('approvals')) renderApprovals();
    if (pending.has('queue')) renderQueue();
    if (pending.has('steers')) renderSteers();
    if (pending.has('agents')) renderAgents();
    if (pending.has('parent')) btw.setParent(state.active, !current()?.meta.parentThreadId && current()?.meta.canAcceptDirectInput !== false);
  }, 90);
}
function renderEvent(message) {
  const p = message.params || {}, id = p.threadId || p.thread?.id;
  if (typeof p.delta === 'string') {
    if (id === state.active) scheduleRender(['messages']);
    return;
  }
  if (id && id !== state.active) {
    if (message.method !== 'thread/tokenUsage/updated') scheduleRender(['sidebar', 'header', 'agents']);
    return;
  }
  const regions = { 'web/queue': ['queue'], 'web/steers': ['steers'], 'thread/tokenUsage/updated': ['header'] }[message.method];
  scheduleRender(regions);
}
function mergeTurn(t, raw, older = false) {
  const existing = t.turns.get(raw.id);
  if (older && existing) return;
  const turn = existing || { id: raw.id, items: new Map() };
  if (!(turn.status && turn.status !== 'inProgress' && raw.status === 'inProgress')) {
    turn.status = raw.status; turn.error = raw.error;
    for (const key of ['failure', 'retrying', 'recoveryMode', 'recoveredBy']) if (raw[key] !== undefined) turn[key] = raw[key];
    turn.startedAt = raw.startedAt ?? turn.startedAt;
    turn.completedAt = raw.completedAt ?? turn.completedAt;
    for (const item of raw.items || []) turn.items.set(item.id, item);
  }
  t.turns.set(raw.id, turn);
}
function invalidateCardFiles(t) {
  const project = state.projects.find(project => project.path === t.meta.cwd);
  const model = project && files.projects.get(project.id);
  if (!model) return;
  for (const dir of model.dirs.values()) dir.entries = null;
  if (files.current === model && !model.active && !$('inspector').hidden && state.inspector === 'files') void files.show();
}
function reduce(message) {
  if (btw.ingest(message, true, state.events.at(-1)?.n || 0)) {
    state.ordered = state.ordered.filter(id => !btw.owns(id)); return true;
  }
  const p = message.params || {};
  if (message.method === 'web/approval') { state.approvals.set(String(p.id), p); return; }
  if (message.method === 'serverRequest/resolved') { state.approvals.delete(String(p.requestId)); return; }
  const id = p.threadId || p.thread?.id;
  if (!id) return;
  const t = thread(id);
  if (message.method === 'web/authority') { t.authority = p.authority; t.pendingModel = p.pending; return; }
  if (message.method === 'thread/tokenUsage/updated') {
    if (p.tokenUsage?.last && p.tokenUsage?.total) t.usage = { ...t.usage, ...p.tokenUsage, updatedAt: Date.now() };
    return;
  }
  if (p.item?.type === 'contextCompaction') {
    t.usage ||= {};
    if (message.method === 'item/started') { t.compactedFrom = usagePercent(t.usage); t.usage.compacting = true; }
    if (message.method === 'item/completed') { t.usage.compacting = false; t.compactPending = false; }
  }
  if (/^(?:item\/|turn\/|thread\/status\/)/.test(message.method)) t.lastStreamAt = Date.now();
  if (message.method === 'web/studycard') {
    const wasEnabled = t.studycard?.enabled;
    const oldResults = t.studycard?.results || [];
    const newResults = (p.studycard.results || []).filter(result => !oldResults.some(old => old.turnId === result.turnId));
    t.studycard = p.studycard;
    if ((!wasEnabled && t.studycard.enabled) || newResults.some(result => result.status === 'saved')) invalidateCardFiles(t);
    for (const result of newResults) toast(result.status === 'saved' ? `StudyCard 已保存 · ${result.path}${result.warning ? '\n' + result.warning : ''}` : `StudyCard 未归档：${result.error}`);
    return;
  }
  if (message.method === 'web/studycardError') { toast(p.error); return; }
  if (['turn/started', 'turn/completed', 'thread/status/changed'].includes(message.method)) t.activitySequence = state.events.at(-1)?.n || 0;
  if (message.method === 'thread/settings/updated') {
    t.meta.model = p.threadSettings.model;
    t.meta.reasoningEffort = p.threadSettings.effort;
    t.pendingModel = Boolean(t.activeTurnId);
    return;
  }
  if (p.thread) {
    t.meta = { ...t.meta, ...p.thread };
    const project = state.projects.find(v => v.id === state.project);
    if (!t.meta.parentThreadId && t.meta.cwd === project?.path && !state.ordered.includes(id)) state.ordered.unshift(id);
    if (t.meta.parentThreadId) thread(t.meta.parentThreadId).children.set(id, t.meta);
  }
  if (message.method === 'thread/status/changed') {
    t.meta.status = p.status;
    if (t.meta.parentThreadId) {
      const parent = thread(t.meta.parentThreadId);
      parent.children.set(id, { ...parent.children.get(id), ...t.meta });
    }
  }
  if (message.method === 'web/queue') { t.queue = p.queue; return; }
  if (message.method === 'web/steers') { setSteers(id, p.steers); return; }
  if (message.method === 'web/unsupportedRequest') toast(`暂不支持此交互：${p.requestMethod}`);
  const turnId = p.turnId || p.turn?.id;
  if (!turnId) return;
  if (!t.turns.has(turnId)) t.turns.set(turnId, { id: turnId, items: new Map(), status: 'inProgress' });
  const turn = t.turns.get(turnId);
  if (message.method === 'error') { turn.retrying = Boolean(p.willRetry); turn.failure = p.failure; }
  if (['turn/started', 'turn/completed'].includes(message.method) && state.active === id) void refreshTurnCount(id);
  if (message.method === 'turn/started') { t.activeTurnId = turnId; t.pendingModel = false; t.compactedFrom = null; t.meta.status = { type: 'active' }; t.meta.updatedAt = Date.now() / 1000; }
  if (message.method === 'turn/completed') { t.compactPending = false; if (t.usage) t.usage.compacting = false; }
  if (message.method === 'turn/completed') {
    turn.retrying = false; turn.failure = p.turn.failure; turn.recoveryMode = p.turn.recoveryMode;
    turn.status = p.turn.status; turn.error = p.turn.error;
    for (const item of p.turn.items || []) turn.items.set(item.id, item);
    if (t.activeTurnId === turnId) t.activeTurnId = null;
    t.meta.status = { type: 'idle' };
    turn.completedAt = p.turn.completedAt ?? turn.completedAt ?? Date.now() / 1000;
    t.meta.lastCompletedAt = Math.max(t.meta.lastCompletedAt || 0, turn.completedAt);
    if (state.active !== id) toast(`${title(t).slice(0, 30)} · ${p.turn.status === 'completed' ? '已完成' : '已结束'}`);
  }
  if (['turn/started', 'turn/completed'].includes(message.method) && t.meta.parentThreadId) {
    const parent = thread(t.meta.parentThreadId);
    parent.children.set(id, { ...parent.children.get(id), ...t.meta,
      collabStatus: message.method === 'turn/started' ? 'running' : ({ failed: 'errored', interrupted: 'interrupted' })[p.turn.status] || 'completed' });
  }
  if (p.item) {
    turn.items.set(p.item.id, p.item);
    if (p.item.type === 'userMessage' && !t.meta.preview) t.meta.preview = p.item.content?.find(c => c.type === 'text')?.text?.slice(0, 150) || '';
    if (p.item.type === 'collabAgentToolCall') {
      for (const childId of p.item.receiverThreadIds || []) {
        const agentState = p.item.agentsStates?.[childId] || {};
        t.children.set(childId, { ...t.children.get(childId), id: childId, prompt: p.item.prompt, collabStatus: agentState.status, message: agentState.message, parentThreadId: id });
      }
      if (state.active === id) debouncedAgents();
    }
  }
  if (p.itemId && typeof p.delta === 'string' && !message.method.includes('reasoning')) {
    const item = turn.items.get(p.itemId) || { id: p.itemId, type: message.method.includes('commandExecution') ? 'commandExecution' : 'agentMessage' };
    const key = message.method.includes('outputDelta') ? 'aggregatedOutput' : 'text';
    item[key] = ((item[key] || '') + p.delta).slice(-250000); turn.items.set(item.id, item);
  }
}

async function loadThreads(more = false) {
  const token = ++threadRequest; const project = state.project;
  if (!project) return;
  const result = await api(`/api/threads?project=${encodeURIComponent(project)}${more && state.nextThreads ? `&cursor=${encodeURIComponent(state.nextThreads)}` : ''}`);
  if (token !== threadRequest || project !== state.project) return;
  const ids = [];
  for (const metadata of result.data.filter(metadata => !btw.owns(metadata.id))) { const t = thread(metadata.id); t.meta = { ...t.meta, ...metadata }; ids.push(metadata.id); }
  const local = state.ordered.filter(id => !btw.owns(id) && thread(id).meta.cwd === state.projects.find(p => p.id === project)?.path && thread(id).activeTurnId);
  state.ordered = [...new Set(more ? [...state.ordered, ...ids] : [...local, ...ids])];
  state.nextThreads = result.nextCursor;
  renderSidebar();
}
async function chooseProject(id) {
  saveDraft(); state.project = id; state.active = null; state.ordered = []; state.nextThreads = null; state.skills = []; state.git = null;
  localStorage.setItem('codex-project', id);
  restoreDraft(); renderProjects(); scheduleRender();
  if (!$('inspector').hidden && state.inspector === 'files') files.show();
  const token = ++projectRequest;
  await loadThreads();
  if (token !== projectRequest) return;
  const remembered = localStorage.getItem(`codex-thread:${id}`);
  if (remembered && state.ordered.includes(remembered)) await selectThread(remembered);
  if (!$('inspector').hidden && state.inspector === 'git') await loadGit();
}
async function selectThread(id) {
  if (activeRecovery) { activeRecovery.controller.abort(); activeRecovery = null; }
  saveDraft(); state.active = id; localStorage.setItem(`codex-thread:${state.project}`, id);
  restoreDraft(); dismissMobileSidebar(); hideSuggestions();
  btw.setParent(id, true);
  if (!$('inspector').hidden && state.inspector === 'btw') guard(() => btw.load(id))();
  const t = thread(id); t.loading = true;
  scheduleRender();
  await hydrateThread(id, { preserveHistory: t.loaded });
  if (state.active === id) { $('message-scroll').scrollTop = $('message-scroll').scrollHeight; await loadAgents(); }
}
async function hydrateThread(id, { preserveHistory = false, signal } = {}) {
  const t = thread(id);
  const token = t.hydration = (t.hydration || 0) + 1;
  try {
    const snapshot = await api(`/api/threads/${encodeURIComponent(id)}`, undefined, { signal });
    const history = snapshot.history;
    if (token !== t.hydration || signal?.aborted || (preserveHistory && state.active !== id)) return;
    t.meta = snapshot.thread;
    t.authority = snapshot.authority || 'default';
    if (snapshot.pendingAuthority) t.pendingModel = true;
    t.usage = snapshot.usage || {};
    t.recovery = snapshot.recovery || [];
    if (!preserveHistory) t.turns = new Map();
    const page = [...history.data].reverse();
    const order = window.CodexTurnWindow.historyOrder(t.turns, [...page, ...(snapshot.live?.turns || [])]);
    for (const turn of page) mergeTurn(t, turn);
    if (!preserveHistory || !t.loaded) t.nextTurns = history.nextCursor;
    t.activeTurnId = history.data.find(turn => turn.status === 'inProgress')?.id || null;
    if (snapshot.live) {
      for (const turn of snapshot.live.turns) mergeTurn(t, turn);
      t.activeTurnId = snapshot.live.activeTurnId;
      if (snapshot.live.status) t.meta.status = snapshot.live.status;
    }
    t.turns = new Map(order.map(id => [id, t.turns.get(id)]));
    t.queue = snapshot.queue;
    t.studycard = snapshot.studycard;
    setSteers(id, snapshot.steers);
    for (const [key, request] of state.approvals) if (request.params.threadId === id) state.approvals.delete(key);
    for (const request of snapshot.approvals) state.approvals.set(String(request.id), request);
    for (const event of state.events) if (event.n > snapshot.eventSequence && (event.message.params?.threadId === id || event.message.params?.thread?.id === id || event.message.method === 'web/approval')) reduce(event.message);
    t.loaded = true; t.lastSnapshotAt = Date.now();
    void refreshTurnCount(id);
    if (streamNeedsBaseline) { lastStreamSequence = Math.max(lastStreamSequence, snapshot.eventSequence || 0); streamNeedsBaseline = false; }
    return snapshot;
  } finally { if (token === t.hydration) { t.loading = false; scheduleRender(); } }
}

// SSE remains the fast path. A quiet active thread gets a bounded snapshot read
// so a silently stalled connection cannot leave its output frozen indefinitely.
function recoverActiveThread(force = false) {
  const id = state.active, t = current();
  if (!id || document.hidden || serviceReload.running || t.loading) return;
  if (activeRecovery?.id === id && !activeRecovery.controller.signal.aborted) return activeRecovery.promise;
  if (activeRecovery) { activeRecovery.controller.abort(); activeRecovery = null; }
  if (!force && (!(t.activeTurnId || t.meta.status?.type === 'active') ||
    Date.now() - Math.max(t.lastStreamAt || 0, t.lastSnapshotAt || 0, t.lastRecoveryAt || 0) < STREAM_RECOVERY_MS)) return;
  const controller = new AbortController(), request = { id, controller };
  activeRecovery = request; t.lastRecoveryAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 8000);
  request.promise = hydrateThread(id, { preserveHistory: true, signal: controller.signal }).then(snapshot => {
    if (!snapshot || controller.signal.aborted || serviceReload.running || state.active !== id) return;
    state.connected = true; state.connectionError = null;
    if (snapshot.eventSequence > lastStreamSequence && Date.now() - lastStreamReceivedAt >= STREAM_RECOVERY_MS) connectEvents();
    scheduleRender();
  }).catch(() => {
    // Keep the visible conversation and draft during an outage; the next poll,
    // foreground transition or native EventSource reconnect can retry.
  }).finally(() => {
    clearTimeout(timeout);
    if (activeRecovery === request) activeRecovery = null;
  });
  return request.promise;
}
async function moreTurns(id = state.active) {
  const t = state.threads.get(id); if (!t?.nextTurns) return;
  const result = await api(`/api/threads/${id}/turns?cursor=${encodeURIComponent(t.nextTurns)}`);
  const existing = t.turns; t.turns = new Map();
  for (const turn of [...result.data].reverse()) mergeTurn(t, turn);
  for (const [key, value] of existing) t.turns.set(key, value);
  t.nextTurns = result.nextCursor;
}
async function newThread({ carryDraft = false } = {}) {
  if (creatingThread) return creatingThread;
  if (!state.project) return;
  $('new-thread').disabled = true;
  const originalLabel = $('new-thread').innerHTML;
  $('new-thread').textContent = '正在创建会话…';
  creatingThread = createThread({ carryDraft });
  try { return await creatingThread; }
  finally { creatingThread = null; $('new-thread').disabled = false; $('new-thread').innerHTML = originalLabel; }
}
async function createThread({ carryDraft }) {
  const result = await api('/api/threads', { project: state.project });
  const t = thread(result.thread.id); t.meta = result.thread; t.authority = result.authority || 'default'; t.loaded = true;
  t.turnCount = 0;
  if (!state.ordered.includes(t.meta.id)) state.ordered.unshift(t.meta.id);
  saveDraft();
  const draftKey = `new:${state.project}`;
  const draft = carryDraft && !state.active ? state.drafts.get(draftKey) : null;
  state.active = t.meta.id;
  if (draft) { state.drafts.set(t.meta.id, draft); state.drafts.delete(draftKey); }
  restoreDraft();
  localStorage.setItem(`codex-thread:${state.project}`, state.active);
  dismissMobileSidebar(); scheduleRender(); $('prompt').focus();
  return t;
}
let agentRefresh;
function debouncedAgents() { clearTimeout(agentRefresh); agentRefresh = setTimeout(() => guard(loadAgents)(), 800); }
async function loadAgents(more = false) {
  const id = state.active; if (!id) { renderAgents(); return; }
  const t = thread(id);
  const sequence = state.events.at(-1)?.n || 0;
  const result = await api(`/api/threads/${id}/children${more && t.nextChildren ? `?cursor=${encodeURIComponent(t.nextChildren)}` : ''}`);
  for (const child of result.data) {
    const loaded = thread(child.id);
    const lastCompletedAt = Math.max(loaded.meta.lastCompletedAt || 0, child.lastCompletedAt || 0) || null;
    const status = loaded.activitySequence > sequence ? loaded.meta.status : child.status;
    loaded.meta = { ...loaded.meta, ...child, lastCompletedAt, status };
    t.children.set(child.id, { ...t.children.get(child.id), ...loaded.meta });
  }
  t.nextChildren = result.nextCursor;
  if (state.active === id) renderAgents();
}
async function loadGit() {
  const project = state.project; if (!project) return;
  $('git-body').innerHTML = '<div class="empty-state">正在读取工作区…</div>';
  const result = await api(`/api/git/status?project=${encodeURIComponent(project)}`);
  if (project !== state.project) return;
  state.git = result;
  if (!result.available) { $('git-body').innerHTML = `<div class="empty-state"><div class="empty-symbol">±</div>${escape(result.reason)}</div>`; return; }
  $('git-body').innerHTML = `<div class="git-info">⑂ ${escape(result.branch)} <span>${result.files.length} 个改动</span></div><div class="git-root">${escape(result.root)}</div>${result.files.map(f => `<div class="git-file"><span class="git-code">${escape(f.status)}</span><span>${escape(f.path)}</span></div>`).join('') || '<div class="empty-state">工作区干净，没有改动。</div>'}<div class="diff-tabs"><button data-staged="false" class="${!state.diffStaged ? 'active' : ''}">未暂存</button><button data-staged="true" class="${state.diffStaged ? 'active' : ''}">已暂存</button></div><div id="diff-body"></div><p class="muted">未跟踪文件只列出名称；二进制文件不展示正文。</p>`;
  await loadDiff();
}
async function loadDiff() {
  const project = state.project; const staged = state.diffStaged;
  const result = await api(`/api/git/diff?project=${encodeURIComponent(project)}&staged=${staged}`);
  if (project !== state.project || staged !== state.diffStaged || !$('diff-body')) return;
  document.querySelectorAll('[data-staged]').forEach(b => b.classList.toggle('active', b.dataset.staged === String(staged)));
  $('diff-body').innerHTML = result.diff ? `<pre class="diff">${result.diff.split('\n').map(line => `<span class="diff-line ${line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}">${escape(line)}</span>`).join('')}</pre>${result.truncated ? '<p class="error-text">Diff 过大，只展示前面部分。</p>' : ''}` : '<div class="empty-state">这个区域没有 diff。</div>';
}
async function loadSkills(refresh = false) {
  if (!state.project) return;
  const project = state.project;
  const request = ++skillRequest;
  const result = await api(`/api/skills?project=${encodeURIComponent(project)}${refresh ? '&refresh=true' : ''}`);
  if (project === state.project && request === skillRequest) {
    state.skills = result.skills;
    selectedSkills = selectedSkills.filter(selected => state.skills.some(skill => skill.path === selected.path && skill.name === selected.name));
    renderSkillChips(); saveDraft();
  }
}
function renderSkillChips() {
  $('skill-chips').innerHTML = selectedSkills.map((s, i) => `<button type="button" class="skill-chip" data-remove-skill="${i}">$${escape(s.name)} ×</button>`).join('');
}
function hideSuggestions() {
  suggestionMode = null;
  $('suggestions').hidden = true;
  $('command-menu').setAttribute('aria-expanded', 'false');
}
function suggestions() {
  const value = $('prompt').value;
  const firstLine = value.split(/\r?\n/)[0];
  const onFirstLine = $('prompt').selectionStart <= firstLine.length;
  const explicitSkill = onFirstLine && firstLine.match(/^\/skill[:：][ \t]*([\w:-]*)$/i);
  const slash = onFirstLine && firstLine.match(SLASH_QUERY);
  const skill = value.slice(0, $('prompt').selectionStart).match(/(?:^|\s)\$([^\s]*)$/);
  if (explicitSkill || slash) {
    suggestionMode = 'commands';
    const query = (explicitSkill ? explicitSkill[1] : slash[1]).toLowerCase();
    const commands = explicitSkill ? '' : COMMANDS.filter(([name]) => name.toLowerCase().startsWith(query)).map(([name, desc]) => `<button type="button" class="suggestion" data-command="${name}"><strong>/${name}</strong><span>${desc}</span></button>`).join('');
    const skills = state.skills.filter(s => s.name.toLowerCase().startsWith(query)).slice(0, 30).map(s => `<button type="button" class="suggestion" data-skill="${escape(s.path)}"><strong>/skill：${escape(s.name)}</strong><span>${escape((s.description || '').slice(0, 220))}</span></button>`).join('');
    $('suggestions').innerHTML = commands + skills || '<div class="empty-state">没有匹配的命令或技能</div>';
  } else if (skill || suggestionMode === 'skills') {
    suggestionMode = 'skills';
    const query = (skill?.[1] || '').toLowerCase();
    const matches = state.skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query)).slice(0, 30);
    $('suggestions').innerHTML = matches.map(s => `<button type="button" class="suggestion" data-skill="${escape(s.path)}"><strong>$${escape(s.name)}</strong><span>${escape((s.description || '').slice(0, 220))}</span></button>`).join('') || '<div class="empty-state">没有匹配的可用技能</div>';
  } else { hideSuggestions(); return; }
  $('suggestions').hidden = false;
  $('command-menu').setAttribute('aria-expanded', String(suggestionMode === 'commands'));
}
async function showSkills() {
  hideSuggestions();
  await loadSkills(); suggestionMode = 'skills'; suggestions(); $('prompt').focus();
}
async function showCommands() {
  const input = $('prompt');
  let firstLine = input.value.split(/\r?\n/)[0];
  if (!SLASH_QUERY.test(firstLine) && !/^\/skill[:：][ \t]*[\w:-]*$/i.test(firstLine)) {
    input.value = input.value ? `/\n${input.value}` : '/'; firstLine = '/';
  }
  input.focus(); input.setSelectionRange(firstLine.length, firstLine.length);
  saveDraft(); sizePrompt(); suggestions();
  await loadSkills();
  if (suggestionMode) suggestions();
}
function selectSkill(path) {
  const skill = state.skills.find(s => s.path === path); if (!skill) return;
  if (!selectedSkills.some(s => s.path === path)) selectedSkills.push({ name: skill.name, path: skill.path });
  const input = $('prompt'); const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(?:^|\s)\$([^\s]*)$/);
  const firstLine = input.value.split(/\r?\n/)[0];
  if (suggestionMode === 'commands' && (SLASH_QUERY.test(firstLine) || /^\/skill[:：][ \t]*[\w:-]*$/i.test(firstLine))) {
    input.value = `$${skill.name} ` + input.value.slice(firstLine.length);
    input.setSelectionRange(skill.name.length + 2, skill.name.length + 2);
  } else if (match) input.value = before.slice(0, before.lastIndexOf('$')) + `$${skill.name} ` + input.value.slice(input.selectionStart);
  else input.value += `${input.value && !input.value.endsWith(' ') ? ' ' : ''}$${skill.name} `;
  hideSuggestions(); renderSkillChips(); input.focus(); saveDraft(); sizePrompt();
}
function renderReasoningOptions(preferred) {
  const model = state.models.find(m => m.model === $('model-select').value);
  $('model-description').textContent = model?.description || '';
  const options = model?.supportedReasoningEfforts || [];
  $('reasoning-select').disabled = !options.length;
  $('reasoning-select').innerHTML = options.length ? options.map(option => `<option value="${escape(option.reasoningEffort)}">${escape(option.reasoningEffort)}${option.reasoningEffort === model.defaultReasoningEffort ? ' · 默认' : ''}</option>`).join('') : '<option value="">由模型决定</option>';
  if (options.length) $('reasoning-select').value = options.some(o => o.reasoningEffort === preferred) ? preferred : options.some(o => o.reasoningEffort === model.defaultReasoningEffort) ? model.defaultReasoningEffort : options[0].reasoningEffort;
  renderReasoningDescription();
  $('save-model').disabled = !model;
}
function renderReasoningDescription() {
  const model = state.models.find(m => m.model === $('model-select').value);
  $('reasoning-description').textContent = model?.supportedReasoningEfforts?.find(option => option.reasoningEffort === $('reasoning-select').value)?.description || '';
}
async function showModelPicker(recover = null) {
  if (!['retry', 'continue'].includes(recover?.action)) recover = null;
  if (current()?.meta.parentThreadId || current()?.meta.canAcceptDirectInput === false) throw new Error('子代理会话在这里仅供查看');
  const selectedThread = recover?.id || state.active;
  const result = await api('/api/models');
  if (!result.models.length) throw new Error('Codex 没有返回可选模型');
  state.models = result.models;
  const t = selectedThread ? thread(selectedThread) : await newThread({ carryDraft: true });
  if (!t) throw new Error('请先选择一个项目');
  modelDialogThread = t.meta.id;
  modelRecovery = recover;
  modelDialogAuthority = t.authority || 'default';
  $('authority-select').value = modelDialogAuthority;
  $('authority-select').disabled = Boolean(recover);
  $('authority-description').textContent = AUTHORITY_DESCRIPTIONS[modelDialogAuthority];
  $('model-error').textContent = '';
  $('model-scope').textContent = `会话：${title(t).slice(0, 70)}。${t.activeTurnId ? '当前任务继续使用原设置，新设置从下一轮（含 Follow-up）生效。' : '新设置从下一条消息生效，仅影响此会话。'}`;
  $('model-select').innerHTML = '<option value="" disabled>请选择模型</option>' + state.models.map(m => `<option value="${escape(m.model)}">${escape(m.displayName || m.model)}${m.displayName && m.displayName !== m.model ? ` (${escape(m.model)})` : ''}</option>`).join('');
  $('model-select').value = state.models.some(m => m.model === t.meta.model) ? t.meta.model : '';
  renderReasoningOptions(t.meta.reasoningEffort);
  $('save-model').textContent = recover ? (recover.action === 'retry' ? '换模型并重试' : '换模型并继续') : '保存到当前会话';
  $('model-dialog').showModal();
}
async function runCommand(command) {
  hideSuggestions();
  if (/^config$/i.test(command)) { await configPanel.open(); return; }
  if (/^plugins?$/i.test(command)) { await pluginPanel.open(); return; }
  if (/^reload$/i.test(command)) { await serviceReload.run(); return; }
  if (/^studycard(?:\s|$)/i.test(command)) {
    const match = command.match(/^studycard(?:\s+(--stop|--status))?$/i);
    if (!match) throw new Error('用法：/StudyCard · /StudyCard --stop · /StudyCard --status');
    if (current()?.meta.parentThreadId || current()?.meta.canAcceptDirectInput === false) throw new Error('请从主会话使用 StudyCard');
    const t = current() || (match[1] ? null : await newThread({ carryDraft: true }));
    if (!t) throw new Error('请先选择一个会话');
    const action = match[1]?.toLowerCase();
    const url = `/api/threads/${encodeURIComponent(t.meta.id)}/studycard`;
    const result = await api(url, action === '--status' ? undefined : { enabled: action !== '--stop' });
    t.studycard = result.studycard;
    if (action !== '--status') invalidateCardFiles(t);
    toast(`StudyCard ${t.studycard.enabled ? '已开启' : '已关闭'} · 当前会话\n保存目录：${t.meta.cwd}/StudyCard${action === '--status' ? (t.studycard.closePending ? '\n下一轮将注入关闭提示' : '') : '\n从下一轮生效，正在生成的回答沿用本轮状态'}${!t.studycard.enabled && t.studycard.closePending && action !== '--status' ? '\n下一轮将注入一次关闭提示' : ''}`);
    scheduleRender(); return;
  }
  if (/^btw(?:\s|$)/i.test(command)) {
    if (!state.active) throw new Error('请先选择一个主会话');
    btw.setParent(state.active, !current()?.meta.parentThreadId && current()?.meta.canAcceptDirectInput !== false);
    const question = command.replace(/^btw\s*/i, '');
    openInspector('btw', question);
    return;
  }
  if (command === 'new') await newThread();
  else if (command === 'resume') openSidebar();
  else if (command === 'skills') await showSkills();
  else if (command === 'model') await showModelPicker();
  else if (command === 'files') openInspector('files');
  else if (command === 'agents' || command === 'diff') openInspector(command === 'diff' ? 'git' : 'agents');
  else if (command === 'help') toast('/new /resume /stop /cleanup /compact /model /config /plugin /skills /status /files /agents /diff /btw /reload /help\n/StudyCard 开启归档 · /StudyCard --stop 关闭 · /StudyCard --status 查看状态\n运行中选择引导（steer）或排队（follow-up）。输入 /技能名 或 $技能名 调用技能。');
  else if (command === 'status') {
    const usage = await api('/api/resources');
    const resourceText = `运行会话 ${usage.activeTurns}/${usage.limits.maxActiveTurns}\n后台进程 ${usage.processes ?? '未采样'}/${usage.limits.maxProcesses} · 内存 ${usage.rssMb ?? '未采样'}/${usage.limits.maxRssMb} MiB\n孤儿进程回收：${usage.orphanProtection ? '已启用' : '未启用，可运行 npm run setup'} `;
    toast((current() ? `${title(current())}\n${statusText(current())}\n${current().meta.cwd || ''}\n${current().meta.model || '默认模型'} · ${current().meta.reasoningEffort || '默认 reasoning'}\n` : '') + resourceText);
  }
  else if (command === 'stop' || command === 'compact' || command === 'cleanup') {
    if (!state.active) throw new Error('请先选择一个会话');
    await api(`/api/threads/${state.active}/${command}`, {});
    if (command === 'compact') toast('已请求压缩上下文');
    if (command === 'cleanup') toast('后台进程已清理，会话历史保留');
  } else throw new Error('这个 Web 客户端暂不支持该命令。输入 / 查看可用命令。');
}
function sizePrompt() { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 160)}px`; }
async function executeCommand(command, remaining) {
  const key = state.active || `new:${state.project}`;
  const original = $('prompt').value;
  $('prompt').value = remaining; saveDraft(); sizePrompt(); renderHeader();
  const consumed = state.drafts.get(key);
  try { await runCommand(command); }
  catch (error) {
    if (state.drafts.get(key) === consumed) {
      state.drafts.set(key, { ...consumed, text: original });
      if ((state.active || `new:${state.project}`) === key && $('prompt').value === remaining) { $('prompt').value = original; sizePrompt(); renderHeader(); }
    }
    throw error;
  }
}
async function sendMessage(event) {
  event.preventDefault();
  if (serviceReload.running || resolvingSlashSkill) return;
  if ($('send').disabled && !/^\/(?:reload|config)$/i.test($('prompt').value.trimStart().split(/\r?\n/)[0].trim())) return;
  let value = $('prompt').value.trim(); if (!value && !selectedImages.length) return;
  const explicitSkill = value.match(/^\/skill[:：][ \t]*([\w:-]+)(?=\s|$)/i);
  const slashSkill = explicitSkill || value.match(/^\/([\w:-]+)(?=\s|$)/);
  const builtin = !explicitSkill && builtinCommandName(value);
  if (slashSkill && !builtin) {
    const project = state.project, active = state.active;
    resolvingSlashSkill = true; renderHeader();
    try {
      await loadSkills();
      if (project !== state.project || active !== state.active) return;
      const matches = state.skills.filter(s => s.name === slashSkill[1]);
      if (matches.length > 1 && !selectedSkills.some(s => s.name === slashSkill[1])) throw new Error(`技能 ${slashSkill[1]} 有多个来源，请从菜单选择`);
      if (explicitSkill && !matches.length) throw new Error(`未找到技能 ${slashSkill[1]}，请输入 / 或 $ 选择可用技能`);
      if (matches.length) value = explicitSkill ? `$${matches[0].name}${value.slice(explicitSkill[0].length)}` : `$${value.slice(1)}`;
    } finally { resolvingSlashSkill = false; renderHeader(); }
  }
  if (value.startsWith('/')) {
    const firstLine = value.split(/\r?\n/)[0].trim();
    const standalone = Boolean(builtinCommandName(firstLine));
    const remaining = standalone ? $('prompt').value.replace(/^\s*\/[^\r\n]*(?:\r?\n|$)/, '') : '';
    await executeCommand((standalone ? firstLine : value).slice(1).trim(), remaining);
    return;
  }
  let id = state.active;
  const skills = [...selectedSkills];
  const images = [...selectedImages];
  const originalDraft = state.active || `new:${state.project}`;
  if (!id) { const t = await newThread(); id = t.meta.id; $('prompt').value = value; selectedSkills = skills; selectedImages = images; saveDraft(); renderImages(); }
  if (state.sendBusy.has(id)) return;
  const t = thread(id); state.sendBusy.add(id); renderImages();
  const expectedTurnId = t.activeTurnId;
  const mode = expectedTurnId ? $('send-mode').value : 'send';
  let clientUserMessageId = mode === 'steer' ? crypto.randomUUID() : undefined;
  if (mode === 'steer') {
    t.sendingSteers.set(clientUserMessageId, { id: clientUserMessageId, text: value, skills, images: images.filter(image => image.kind !== 'file').map(image => image.id), files: images.filter(image => image.kind === 'file').map(image => image.id), status: 'staging' });
    renderSteers();
  }
  try {
    // Typed $names are resolved too; choosing a menu item disambiguates duplicates.
    if (/\$[\w-]/.test(value)) {
      await loadSkills();
      for (const match of value.matchAll(/(?:^|\s)\$([\w:-]+)/g)) {
        if (skills.some(s => s.name === match[1])) continue;
        const found = state.skills.filter(s => s.name === match[1]);
        if (found.length > 1) throw new Error(`技能 ${match[1]} 有多个来源，请从菜单选择`);
        if (found.length === 1) skills.push({ name: found[0].name, path: found[0].path });
      }
    }
    const payload = { text: value, skills, images: images.filter(image => image.kind !== 'file').map(image => image.id), files: images.filter(image => image.kind === 'file').map(image => image.id), expectedTurnId };
    if (mode === 'send') {
      const signature = JSON.stringify(payload);
      const previous = pendingSubmissions.get(id);
      clientUserMessageId = previous?.signature === signature ? previous.id : crypto.randomUUID();
      pendingSubmissions.set(id, { id: clientUserMessageId, signature }); persistSubmissions();
    }
    const result = await api(`/api/threads/${id}/${mode}`, { ...payload, clientUserMessageId });
    if (mode === 'send') { pendingSubmissions.delete(id); persistSubmissions(); }
    if (result.recovery) t.recovery = result.recovery;
    if (mode === 'steer') setSteers(id, result.steers);
    state.drafts.delete(id);
    if (originalDraft !== id) state.drafts.delete(originalDraft);
    persistDrafts();
    if (state.active === id) { $('prompt').value = ''; selectedSkills = []; selectedImages = []; renderSkillChips(); renderImages(); hideSuggestions(); sizePrompt(); }
    if (mode === 'queue') toast('已加入后续消息队列');
    if (mode === 'steer') toast('已加入预引导，提交前可以修改或撤回');
  } catch (error) {
    if (mode === 'send' && error.status && !error.deliveryUnknown) { pendingSubmissions.delete(id); persistSubmissions(); }
    if (mode === 'send') await hydrateThread(id, { preserveHistory: true }).catch(() => {});
    throw error;
  } finally { if (clientUserMessageId) t.sendingSteers.delete(clientUserMessageId); state.sendBusy.delete(id); renderImages(); renderSteers(); scheduleRender(); }
}

document.addEventListener('click', guard(async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.turnAction) { await turnAction(button); return; }
  if (button.dataset.thread) await selectThread(button.dataset.thread);
  if (button.dataset.view) openInspector(button.dataset.view);
  if (button.dataset.starter) { $('prompt').value = button.dataset.starter; sizePrompt(); $('prompt').focus(); }
  if (button.dataset.staged) { state.diffStaged = button.dataset.staged === 'true'; await loadDiff(); }
  if (button.dataset.approval) await api('/api/approvals', { id: button.dataset.approval, decision: button.dataset.decision });
  if (button.dataset.command) await executeCommand(button.dataset.command, $('prompt').value.replace(/^\s*\/[^\r\n]*(?:\r?\n|$)/, ''));
  if (button.dataset.skill) selectSkill(button.dataset.skill);
  if (button.dataset.steerAction) await steerAction(button);
  if (button.dataset.editRemoveSkill !== undefined && steerEditor) { steerEditor.entry.skills.splice(Number(button.dataset.editRemoveSkill), 1); renderSteerEditor(); }
  if (button.dataset.editRemoveFile !== undefined && steerEditor) { steerEditor.entry.files.splice(Number(button.dataset.editRemoveFile), 1); renderSteerEditor(); }
  if (button.dataset.editRemoveImage !== undefined && steerEditor) { steerEditor.entry.images.splice(Number(button.dataset.editRemoveImage), 1); renderSteerEditor(); }
  if (button.dataset.removeImage) {
    const index = selectedImages.findIndex(image => String(image.key) === button.dataset.removeImage);
    if (index >= 0) selectedImages.splice(index, 1);
    saveDraft(); renderImages();
  }
  if (button.dataset.removeSkill !== undefined) {
    const [removed] = selectedSkills.splice(Number(button.dataset.removeSkill), 1);
    if (removed) $('prompt').value = $('prompt').value.split(`$${removed.name}`).join('');
    renderSkillChips(); saveDraft();
  }
  if (button.dataset.queueAction) {
    const id = button.dataset.scope;
    const result = await window.CodexQueue.action(button, (action, input) => api(`/api/threads/${id}/${action}`, input));
    thread(id).queue = result;
    if (state.active === id) renderQueue();
  }
  if (button.dataset.suggestPath) $('project-input').value = button.dataset.suggestPath;
}));
document.addEventListener('toggle', event => {
  const key = event.target.dataset?.detail;
  if (key) { if (event.target.open) state.openDetails.add(key); else state.openDetails.delete(key); }
}, true);
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-input-request]'); if (!form) return;
  event.preventDefault();
  guard(async () => {
    const answers = {};
    for (const input of form.querySelectorAll('[data-answer]')) {
      const select = [...form.querySelectorAll('[data-answer-options]')].find(s => s.dataset.answerOptions === input.dataset.answer);
      const value = input.value.trim() || select?.value;
      if (!value) throw new Error('请回答所有问题');
      answers[input.dataset.answer] = [value];
    }
    await api('/api/approvals', { id: form.dataset.inputRequest, answers });
  })();
});
$('open-sidebar').onclick = () => openSidebar(state.sidebarCollapsed);
$('close-sidebar').onclick = $('scrim').onclick = () => openSidebar(false);
$('toggle-inspector').onclick = () => $('inspector').hidden ? openInspector() : closeInspector();
$('close-inspector').onclick = $('inspector-scrim').onclick = closeInspector;
$('project-select').onchange = guard(event => chooseProject(event.target.value));
$('new-thread').onclick = guard(newThread);
$('refresh-threads').onclick = guard(() => loadThreads());
$('more-threads').onclick = guard(() => loadThreads(true));
$('refresh-agents').onclick = guard(() => loadAgents());
$('more-agents').onclick = guard(() => loadAgents(true));
$('refresh-git').onclick = guard(loadGit);
$('thread-search').oninput = event => { state.filter = event.target.value.toLowerCase(); renderSidebar(); };
$('send-mode').onchange = renderHeader;
$('composer').onsubmit = guard(sendMessage);
$('stop-turn').onclick = guard(() => runCommand('stop'));
$('command-menu').onclick = guard(showCommands);
$('suggestions').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideSuggestions(); $('prompt').focus(); }
});
document.addEventListener('pointerdown', event => { if (!$('suggestions').hidden && !event.target.closest('#suggestions, #command-menu, #skill-menu, #prompt')) hideSuggestions(); });
$('skill-menu').onclick = guard(showSkills);
$('attach-file').onclick = () => $('file-input').click();
$('file-input').onchange = guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
  await attachImages(files, 'file');
});
$('attach-image').onclick = () => $('image-input').click();
$('image-input').onchange = guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
  await attachImages(files);
});
window.CodexAttachments.bind($('composer'), $('prompt'), (files, kind) => guard(() => attachImages(files, kind))());
$('model-label').onclick = guard(showModelPicker);
$('context-usage').onclick = () => { usageDialogThread = state.active; $('usage-error').textContent = ''; $('usage-dialog').showModal(); renderUsage(); };
$('close-usage-dialog').onclick = () => $('usage-dialog').close();
$('usage-compact').onclick = async () => {
  const id = usageDialogThread; if (!id || $('usage-compact').disabled) return;
  const t = thread(id); t.compactPending = true; $('usage-error').textContent = ''; renderUsage();
  try { await api(`/api/threads/${encodeURIComponent(id)}/compact`, {}); toast('已请求压缩上下文'); }
  catch (error) { $('usage-error').textContent = error.message; }
  finally { t.compactPending = false; renderUsage(); }
};
$('close-steer-dialog').onclick = guard(closeSteerEditor);
$('steer-dialog').addEventListener('cancel', event => { event.preventDefault(); guard(closeSteerEditor)(); });
$('steer-form').onsubmit = async event => {
  event.preventDefault();
  if (!steerEditor || $('save-steer').disabled) return;
  $('save-steer').disabled = true; $('steer-error').textContent = '';
  const { threadId, entry } = steerEditor;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}/steer-update`, {
      id: entry.id, revision: entry.revision, text: $('steer-text').value.trim(), skills: entry.skills, images: entry.images, files: entry.files,
    });
    setSteers(threadId, result.steers); steerEditor = null; $('steer-dialog').close(); renderSteers();
  } catch (error) { $('steer-error').textContent = error.message; }
  finally { $('save-steer').disabled = false; }
};
$('close-model-dialog').onclick = () => $('model-dialog').close();
$('model-select').onchange = () => renderReasoningOptions();
$('authority-select').onchange = () => { $('authority-description').textContent = AUTHORITY_DESCRIPTIONS[$('authority-select').value]; };
$('reasoning-select').onchange = renderReasoningDescription;
$('model-form').onsubmit = async event => {
  event.preventDefault();
  const id = modelDialogThread;
  if (!id || $('save-model').disabled) return;
  $('save-model').disabled = true; $('model-error').textContent = '';
  try {
    if (modelRecovery) {
      await performTurnAction(id, modelRecovery.action, modelRecovery.target, { model: $('model-select').value, effort: $('reasoning-select').disabled ? null : $('reasoning-select').value });
      $('model-dialog').close(); modelRecovery = null;
      toast('已使用所选模型恢复任务，后续消息沿用此模型');
      return;
    }
    const result = await api(`/api/threads/${encodeURIComponent(id)}/model`, {
      model: $('model-select').value,
      effort: $('reasoning-select').disabled ? null : $('reasoning-select').value,
      ...($('authority-select').value !== modelDialogAuthority ? { authority: $('authority-select').value } : {}),
    });
    const t = thread(id); t.meta = { ...t.meta, ...result.thread }; t.authority = result.authority || 'default'; t.pendingModel = Boolean(t.activeTurnId);
    $('model-dialog').close(); scheduleRender();
    toast('模型、推理强度与权限已保存，从下一轮消息生效');
  } catch (error) { $('model-error').textContent = error.message; }
  finally { $('save-model').disabled = false; }
};
$('prompt').oninput = () => {
  sizePrompt(); saveDraft(); suggestions(); renderHeader();
  const firstLine = $('prompt').value.split(/\r?\n/)[0];
  if ((SLASH_QUERY.test(firstLine) || /^\/skill[:：][ \t]*[\w:-]*$/i.test(firstLine) || /\$[^\s]*$/.test($('prompt').value)) && !state.skills.length) guard(async () => { await loadSkills(); if (suggestionMode) suggestions(); })();
};
$('prompt').onkeydown = event => {
  if (event.key === 'Escape') hideSuggestions();
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
};
$('add-project').onclick = guard(async () => {
  $('project-error').textContent = ''; $('project-dialog').showModal(); $('project-input').focus();
  try {
    const result = await api('/api/history/projects');
    $('project-suggestions').innerHTML = result.paths.map(p => `<button type="button" data-suggest-path="${escape(p)}">${escape(p)}</button>`).join('');
  } catch { $('project-suggestions').textContent = ''; }
});
$('close-project-dialog').onclick = () => $('project-dialog').close();
$('project-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const { project } = await api('/api/projects', { path: $('project-input').value });
    if (!state.projects.some(p => p.id === project.id)) state.projects.push(project);
    $('project-dialog').close(); await chooseProject(project.id);
  } catch (error) { $('project-error').textContent = error.message; }
};
window.addEventListener('resize', updateLayout);
updateLayout();

function receiveEvent(event) {
  if (serviceReload.running) return;
  const message = JSON.parse(event.data);
  if (message.method === 'account/updated' || message.method === 'account/rateLimits/updated') accountQuota.invalidate();
  if (message.method === 'web/plugins' || message.method === 'skills/changed') {
    state.skills = []; skillRequest++;
    guard(async () => { await loadSkills(true); if (suggestionMode) suggestions(); })();
  }
  if (message.method === 'web/config') { configPanel.sync(message.params); return; }
  if (message.method === 'web/sync' && message.params.config) configPanel.sync(message.params.config);
  lastStreamReceivedAt = Date.now();
  lastStreamSequence = Math.max(lastStreamSequence, Number(event.lastEventId) || 0);
  if (message.method === 'web/sync') {
    streamNeedsBaseline = true; lastStreamSequence = 0;
    for (const record of message.params.btwSessions || []) btw.register(record);
    state.connected = message.params.connected;
    state.connectionError = message.params.error || null;
    state.approvals = new Map(message.params.approvals.map(a => [String(a.id), a]));
    for (const live of message.params.live) { const t = thread(live.id); t.activeTurnId = live.activeTurnId; if (live.status) t.meta.status = live.status; }
    if (state.active && state.connected) { void recoverActiveThread(true); guard(() => btw.load(state.active))(); }
    if (state.project && state.connected) guard(() => loadThreads())();
  } else if (message.method === 'web/connection') {
    for (const record of message.params.btwSessions || []) btw.register(record);
    state.connected = message.params.connected;
    state.connectionError = message.params.error || null;
    if (state.connected && state.active) void recoverActiveThread(true);
    if (state.connected && state.project) guard(() => loadThreads())();
  } else {
    state.events.push({ n: Number(event.lastEventId) || ++state.eventCounter, message });
    if (state.events.length > 2000) state.events.shift();
    if (!reduce(message)) renderEvent(message);
    return;
  }
  scheduleRender();
}
function connectEvents() {
  events?.close();
  const source = events = new EventSource('/api/events');
  streamNeedsBaseline = true;
  lastStreamReceivedAt = Date.now();
  source.onmessage = event => { if (source === events) receiveEvent(event); };
  source.onerror = () => { if (source === events) { state.connected = false; scheduleRender(); } };
}
function refreshVisibleThread() {
  if (document.hidden || serviceReload.running) return;
  scheduleRender(); btw.requestRender();
  void refreshMemory();
  void accountQuota.refresh();
  void recoverActiveThread(true);
  if (state.active && state.connected && current()?.children.size) guard(loadAgents)();
}
connectEvents();
document.addEventListener('visibilitychange', refreshVisibleThread);
window.addEventListener('focus', refreshVisibleThread);
window.addEventListener('pageshow', refreshVisibleThread);
window.addEventListener('online', refreshVisibleThread);
setInterval(() => { void recoverActiveThread(); }, 5000);
setInterval(() => { if (!document.hidden && state.connected && state.active && current()?.children.size) guard(loadAgents)(); }, 8000);
setInterval(() => { void refreshMemory(); }, 5000);
setInterval(() => { accountQuota.render(); void accountQuota.refresh(); }, 60000);

guard(async () => {
  const result = await api('/api/bootstrap');
  for (const record of result.btwSessions || []) btw.register(record);
  state.projects = result.projects; state.connected = result.connected;
  state.uploadLimits = result.uploadLimits;
  files.setUploadAvailable(result.features?.workspaceUpload === true);
  terminalPanel.setAvailable(result.features?.terminals === true);
  if (result.config) configPanel.sync(result.config);
  $('attach-file').title = state.uploadLimits ? `添加文件 · 单个最多 ${state.uploadLimits.fileBytes / (1024 * 1024)} MiB` : '请重启后端以读取上传限制';
  state.connectionError = result.error || null;
  memoryUsage = result.resources || null;
  state.approvals = new Map(result.approvals.map(a => [String(a.id), a]));
  for (const live of result.live) { const t = thread(live.id); t.activeTurnId = live.activeTurnId; if (live.status) t.meta.status = live.status; }
  const saved = localStorage.getItem('codex-project');
  const project = state.projects.find(p => p.id === saved) || state.projects[0];
  if (project) {
    state.project = project.id; renderProjects(); restoreDraft();
    if (state.connected) await chooseProject(project.id);
  }
  scheduleRender();
})();
