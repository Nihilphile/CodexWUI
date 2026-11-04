import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const vendor = new URL('public/vendor/', root);
await mkdir(new URL('mermaid/', vendor), { recursive: true });
await copyFile(new URL('node_modules/mermaid/dist/mermaid.min.js', root), new URL('mermaid/mermaid.min.js', vendor));
await copyFile(new URL('node_modules/mermaid/LICENSE', root), new URL('mermaid/LICENSE', vendor));
await mkdir(new URL('katex/', vendor), { recursive: true });
await copyFile(new URL('node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', root), new URL('markdown-it.min.js', vendor));
await copyFile(new URL('node_modules/markdown-it/LICENSE', root), new URL('markdown-it.LICENSE', vendor));
for (const name of ['katex.min.js', 'katex.min.css']) {
  await copyFile(new URL(`node_modules/katex/dist/${name}`, root), new URL(`katex/${name}`, vendor));
}
await cp(new URL('node_modules/katex/dist/fonts/', root), new URL('katex/fonts/', vendor), { recursive: true });
await copyFile(new URL('node_modules/katex/LICENSE', root), new URL('katex/LICENSE', vendor));
await mkdir(new URL('pdfjs/', vendor), { recursive: true });
for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  // The compatibility build includes polyfills needed by older phone browsers.
  await copyFile(new URL(`node_modules/pdfjs-dist/legacy/build/${name}`, root), new URL(`pdfjs/${name}`, vendor));
}
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(new URL(`node_modules/pdfjs-dist/${directory}/`, root), new URL(`pdfjs/${directory}/`, vendor), { recursive: true });
}
await copyFile(new URL('node_modules/pdfjs-dist/LICENSE', root), new URL('pdfjs/LICENSE', vendor));
await mkdir(new URL('xterm/', vendor), { recursive: true });
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm.LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'addon-fit.LICENSE'],
]) await copyFile(new URL(`node_modules/${source}`, root), new URL(`xterm/${target}`, vendor));
// xterm's viewport and shared scrollbar styles bypass documentOverride.
// Assign their per-response nonce before either style is appended.
const xtermFile = new URL('xterm/xterm.js', vendor);
const xtermSource = await readFile(xtermFile, 'utf8');
const styleCreation = /(?<![\w.$])(?:document|[A-Za-z_$][\w$]*\.mainDocument)\.createElement\("style"\)/g;
if ([...xtermSource.matchAll(styleCreation)].length !== 2) throw new Error('xterm stylesheet creation changed; review the CSP nonce patch');
await writeFile(xtermFile, xtermSource.replace(styleCreation, creation =>
  `Object.assign(${creation},{nonce:document.querySelector('meta[name="terminal-style-nonce"]')?.content||""})`));
for (const name of ['markdown-it', 'katex', 'mermaid', 'pdfjs-dist', '@xterm/xterm', '@xterm/addon-fit']) {
  const info = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8'));
  console.log(`Vendored ${name} ${info.version}`);
}
