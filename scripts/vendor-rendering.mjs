import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const vendor = new URL('public/vendor/', root);
await mkdir(new URL('katex/', vendor), { recursive: true });
await copyFile(new URL('node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', root), new URL('markdown-it.min.js', vendor));
await copyFile(new URL('node_modules/markdown-it/LICENSE', root), new URL('markdown-it.LICENSE', vendor));
for (const name of ['katex.min.js', 'katex.min.css']) {
  await copyFile(new URL(`node_modules/katex/dist/${name}`, root), new URL(`katex/${name}`, vendor));
}
await cp(new URL('node_modules/katex/dist/fonts/', root), new URL('katex/fonts/', vendor), { recursive: true });
await copyFile(new URL('node_modules/katex/LICENSE', root), new URL('katex/LICENSE', vendor));
for (const name of ['markdown-it', 'katex']) {
  const info = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), 'utf8'));
  console.log(`Vendored ${name} ${info.version}`);
}
