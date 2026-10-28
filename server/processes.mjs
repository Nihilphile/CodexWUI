import { readFileSync, readdirSync } from 'node:fs';

// /proc identities include start time: a recycled PID is never ours to signal.
export function readProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], parent: Number(fields[1]),
      group: Number(fields[2]), session: Number(fields[3]), start: fields[19],
      // VmRSS is already in KiB and avoids assuming an Android page size.
      rssKb: Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) };
  } catch { return null; } // Processes may exit between directory and file reads.
}

export class ProcessInventory {
  constructor(rootPid, root = readProcess(rootPid), { adopter = null, reap = null } = {}) {
    this.rootPid = rootPid;
    if (!root && !adopter) throw new Error('无法读取 Codex 进程身份，无法安全管理子进程');
    // With kernel adoption, even a launcher that exits before its identity can
    // be sampled leaves descendants under the guardian. Do not guess its PID.
    this.root = root || { pid: rootPid, start: null, session: null };
    this.known = root ? new Map([[rootPid, root.start]]) : new Map();
    Object.assign(this, { adopter, reap });
  }
  scan() {
    const processes = new Map();
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const value = readProcess(Number(name));
      if (value) processes.set(value.pid, value);
    }
    const owned = new Set();
    for (const [pid, start] of this.known) {
      if (processes.get(pid)?.start === start) owned.add(pid);
      else this.known.delete(pid);
    }
    // Catch same-session orphans even if their immediate parent already exited.
    const rootNow = processes.get(this.rootPid);
    const sameSession = this.root.session === this.rootPid && (!rootNow || rootNow.start === this.root.start);
    const adopting = this.adopter && processes.get(this.adopter.pid)?.start === this.adopter.start;
    let changed;
    do {
      changed = false;
      for (const value of processes.values()) {
        if (!owned.has(value.pid) && (owned.has(value.parent) || (sameSession && value.session === this.root.session) ||
          (adopting && value.parent === this.adopter.pid))) {
          owned.add(value.pid); this.known.set(value.pid, value.start); changed = true;
        }
      }
    } while (changed);
    for (const pid of owned) {
      const value = processes.get(pid);
      if (adopting && value.parent === this.adopter.pid && pid !== this.rootPid && value.state === 'Z') this.reap?.(pid);
    }
    return [...owned].map(pid => processes.get(pid)).filter(value => !['Z', 'X'].includes(value.state));
  }
  signal(values, signal) {
    // Children first, allowing a still-running parent to reap exited children.
    for (const value of [...values].reverse()) {
      if (readProcess(value.pid)?.start !== value.start) continue;
      try { process.kill(value.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

export async function reapProcesses(inventory) {
  for (const [signal, duration] of [[null, 500], ['SIGTERM', 700], ['SIGKILL', 700]]) {
    const deadline = Date.now() + duration;
    do {
      const values = inventory.scan();
      if (!values.length) break;
      if (signal) inventory.signal(values, signal);
      await new Promise(resolve => setTimeout(resolve, 70));
    } while (Date.now() < deadline);
  }
  return inventory.scan();
}
