import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

if (process.argv.includes('--worker')) {
  process.on('SIGTERM', () => {});
  process.stdout.write('ready\n');
  setInterval(() => {}, 1000);
} else {
  const mode = globalThis.fixtureMode;
  process.on('SIGTERM', () => {});
  const workers = [];
  const manifest = () => writeFileSync(globalThis.fixtureManifest, JSON.stringify({ pid: process.pid, workers }));
  manifest();
  if (['detached', 'limit', 'turn-timeout', 'root-exit'].includes(mode)) {
    for (let i = 0; i < (mode === 'limit' ? 4 : 1); i++) {
      const worker = spawn(process.execPath, [process.argv[1], '--worker'], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      workers.push(worker.pid); manifest();
      await new Promise(resolve => worker.stdout.once('data', resolve));
      worker.stdout.destroy(); worker.unref();
    }
  }
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (mode === 'turn-timeout' && message.method === 'turn/start') return;
    if (message.id !== undefined && mode !== 'hang') {
      process.stdout.write(JSON.stringify({ id: message.id, result: {
        pid: process.pid, workers, ...(mode === 'oversized' ? { text: 'x'.repeat(9 * 1024 * 1024) } : {}),
      } }) + '\n');
    }
    if (message.method === 'fixture/exit') setTimeout(() => process.exit(0), 20);
  });
  // Intentionally survive EOF to exercise the actual escalation path.
  setInterval(() => {}, 1000);
}
