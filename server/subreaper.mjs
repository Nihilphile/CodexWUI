import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const subreaperPath = fileURLToPath(new URL(`../.data/runtime/subreaper-${process.platform}-${process.arch}.node`, import.meta.url));

export function loadSubreaper() {
  try { return require(subreaperPath); }
  catch { return null; }
}
