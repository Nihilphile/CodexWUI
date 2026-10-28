import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function git(cwd, args, maxBuffer = 3 * 1024 * 1024) {
  const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

export function parseStatus(raw) {
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const status = parts[i].slice(0, 2);
    const file = { status, path: parts[i].slice(3) };
    if (/[RC]/.test(status)) file.originalPath = parts[++i];
    files.push(file);
  }
  return files;
}

export async function gitStatus(cwd) {
  let root;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, reason: '当前环境未安装 Git' };
    if (/not a git repository/i.test(error.stderr || '')) return { available: false, reason: '这个项目不是 Git 仓库' };
    throw error;
  }
  const [raw, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '(detached HEAD)'),
  ]);
  return { available: true, root, branch: branch.trim(), files: parseStatus(raw) };
}

export async function gitDiff(cwd, staged = false, path) {
  // Status reports the entire repository, so diff must use the same root even
  // when the selected project is a subdirectory of that repository.
  cwd = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const args = ['-c', 'color.ui=false', 'diff', '--no-ext-diff', '--no-textconv'];
  if (staged) args.push('--cached');
  args.push('--');
  if (path) args.push(path);
  try { return { diff: await git(cwd, args), staged, truncated: false }; }
  catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { diff: error.stdout || '', staged, truncated: true };
    }
    throw error;
  }
}
