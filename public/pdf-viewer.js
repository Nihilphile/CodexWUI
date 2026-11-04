// Only trusted local reader code executes here; PDF actions/scripts are not run.
const $ = id => document.getElementById(id);
const status = $('status'), canvas = $('page'), viewport = $('viewport');
const query = new URLSearchParams(window.location.search);
const project = query.get('project'), path = query.get('path');
let pdf, loadingTask, renderTask, generation = 0, pageNumber = 1, zoom = null;
let queue = Promise.resolve(), closed = false, resizeTimer, passwordCallback;
const report = (message, failed = false) => { status.textContent = message; status.classList.toggle('failed', failed); };

function controls() {
  $('previous').disabled = !pdf || pageNumber <= 1;
  $('next').disabled = !pdf || pageNumber >= pdf.numPages;
  for (const id of ['page-number', 'zoom-in', 'zoom-out', 'fit-width']) $(id).disabled = !pdf;
  $('page-number').value = String(pageNumber);
}
function render() {
  if (!pdf || closed) return;
  const version = ++generation;
  renderTask?.cancel();
  controls();
  queue = queue.catch(() => {}).then(async () => {
    if (version !== generation || closed) return;
    report(`正在绘制第 ${pageNumber} 页…`);
    const page = await pdf.getPage(pageNumber);
    if (version !== generation || closed) return;
    try {
      const natural = page.getViewport({ scale: 1 });
      const fit = Math.max(0.1, (viewport.clientWidth - 16) / natural.width);
      const scale = zoom ?? fit;
      const view = page.getViewport({ scale });
      // Bound backing pixels on high-density phones and unusually large pages.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 16000 / view.width, 16000 / view.height, Math.sqrt(12_000_000 / (view.width * view.height)));
      canvas.width = Math.max(1, Math.floor(view.width * ratio));
      canvas.height = Math.max(1, Math.floor(view.height * ratio));
      canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
      canvas.hidden = false;
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (version !== generation || closed) return;
      $('fit-width').textContent = zoom === null ? '适应宽度' : `${Math.round(scale * 100)}% · 适宽`;
      report(`第 ${pageNumber} / ${pdf.numPages} 页`);
    } finally { renderTask = null; page.cleanup(); }
  }).catch(error => {
    if (version !== generation || closed || error.name === 'RenderingCancelledException') return;
    report(`PDF 显示失败：${error.message}。可用“浏览器打开”或下载查看。`, true);
  });
}
function changePage(number) {
  if (!pdf || !Number.isSafeInteger(number) || number < 1 || number > pdf.numPages) { controls(); return; }
  pageNumber = number; viewport.scrollTop = 0; viewport.scrollLeft = 0; render();
}
$('previous').onclick = () => changePage(pageNumber - 1);
$('next').onclick = () => changePage(pageNumber + 1);
$('page-form').onsubmit = event => { event.preventDefault(); changePage(Number($('page-number').value)); };
$('fit-width').onclick = () => { zoom = null; render(); };
async function changeZoom(factor) {
  if (!pdf) return;
  const page = await pdf.getPage(pageNumber);
  if (closed) return;
  const fit = Math.max(0.1, (viewport.clientWidth - 16) / page.getViewport({ scale: 1 }).width);
  zoom = Math.max(0.1, Math.min(5, (zoom ?? fit) * factor)); render();
}
$('zoom-in').onclick = () => { void changeZoom(1.25).catch(error => report(error.message, true)); };
$('zoom-out').onclick = () => { void changeZoom(0.8).catch(error => report(error.message, true)); };
$('password-form').onsubmit = event => {
  event.preventDefault();
  const password = $('password').value; $('password').value = ''; $('password-form').hidden = true;
  passwordCallback?.(password);
};
const observer = new ResizeObserver(() => {
  clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (zoom === null) render(); }, 120);
});
observer.observe(viewport);
window.addEventListener('pagehide', () => {
  closed = true; generation++; clearTimeout(resizeTimer); observer.disconnect(); renderTask?.cancel();
  void loadingTask?.destroy().catch(() => {}); canvas.width = canvas.height = 0;
}, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted && closed) window.location.reload(); });

try {
  if (!project || !path) throw new Error('文件链接缺少项目或路径');
  const url = window.CodexFileLinks.content(project, path);
  $('browser-file').href = window.CodexFileLinks.browser(url + '&browser=1'); $('browser-file').hidden = false;
  $('download-file').href = url + '&download=1'; $('download-file').hidden = false;
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  if (!closed) {
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    loadingTask = pdfjs.getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
      isEvalSupported: false, enableXfa: false });
    loadingTask.onProgress = ({ loaded, total }) => { if (!pdf && !closed) report(total ? `正在读取 PDF… ${Math.min(100, Math.round(loaded / total * 100))}%` : '正在读取 PDF…'); };
    loadingTask.onPassword = (update, reason) => {
      passwordCallback = update; $('password-form').hidden = false;
      report(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重试。' : '这个 PDF 需要密码。');
      $('password').focus();
    };
    pdf = await loadingTask.promise;
    if (!closed) {
      $('page-count').textContent = `/ ${pdf.numPages}`; $('page-number').max = String(pdf.numPages);
      document.title = `${path.split('/').pop()} · PDF`; render();
    }
  }
} catch (error) {
  if (!closed) report(`PDF 加载失败：${error.message}。可用“浏览器打开”或下载查看。`, true);
}
