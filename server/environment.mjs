// New names take precedence; existing startup scripts keep their limits.
export function appEnv(env, suffix) {
  return env[`CODEXWUI_${suffix}`] ?? env[`CODEXWEB_${suffix}`];
}
