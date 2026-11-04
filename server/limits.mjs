import { appEnv } from './environment.mjs';

function positive(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} 必须是正整数`);
  return number;
}

export function resourceLimits(env = process.env) {
  return {
    maxProcesses: positive(appEnv(env, 'MAX_PROCESSES'), 48, 'CODEXWUI_MAX_PROCESSES'),
    maxRssMb: positive(appEnv(env, 'MAX_RSS_MB'), 4096, 'CODEXWUI_MAX_RSS_MB'),
    maxActiveTurns: positive(appEnv(env, 'MAX_ACTIVE_TURNS'), 2, 'CODEXWUI_MAX_ACTIVE_TURNS'),
    idleMs: positive(appEnv(env, 'IDLE_MINUTES'), 5, 'CODEXWUI_IDLE_MINUTES') * 60000,
  };
}

export function validateResourceLimits(value) {
  for (const key of ['maxProcesses', 'maxRssMb', 'maxActiveTurns', 'idleMs']) {
    if (!Number.isSafeInteger(value?.[key]) || value[key] < 1 || !Number.isSafeInteger(value[key] * 1024)) throw new Error(`${key} 必须是有效的正整数`);
  }
  return Object.fromEntries(['maxProcesses', 'maxRssMb', 'maxActiveTurns', 'idleMs'].map(key => [key, value[key]]));
}
