import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function installShutdownHandlers(app) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      const result = await app.close();
      if (result?.error) { console.error(result.error); process.exitCode = 1; }
    } catch (error) { console.error(`关闭失败：${error.message}`); process.exitCode = 1; }
    process.exit(process.exitCode || 0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
}

// The installed Termux `codex` launcher establishes DNS/TLS/binary bindings
// through proot. Calling it from an already traced Codex shell nests proot,
// making thread creation stall. Reuse the current bindings in that case.
export function resolveCodexBinary({ env = process.env, platform = process.platform, read = readFileSync, exists = existsSync } = {}) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  if (platform !== 'android') return 'codex';
  try {
    const status = read('/proc/self/status', 'utf8');
    const tracer = status.match(/^TracerPid:\s*(\d+)/m)?.[1];
    const prefix = env.PREFIX || '/data/data/com.termux/files/usr';
    const native = path.join(prefix, 'bin/codex-native');
    if (tracer && tracer !== '0' && read(`/proc/${tracer}/comm`, 'utf8').trim() === 'proot' && exists('/etc/resolv.conf') && exists(native)) return native;
  } catch { /* The normal launcher is also the safe fallback. */ }
  return 'codex';
}
