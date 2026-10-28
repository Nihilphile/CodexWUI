import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';

const help = `agentctl <工作区或线程 ID> <操作> [参数]
操作：list observe call stop create fork btw
示例：agentctl '~/codex:1' call --message-file ./prompt.md
      agentctl 1 call --message '调整方向' --steer
      agentctl '~/codex' create --model MODEL --reasoning high
      agentctl 1 observe --message-id MESSAGE_ID
参数：--message TEXT | --message-file PATH（二选一，UTF-8，最多 200000 字符 / 800000 字节）
      --steer  --model MODEL  --reasoning LEVEL  --reply-to MESSAGE_ID
      --message-id MESSAGE_ID  --cursor CURSOR
      --url http://127.0.0.1:4310  --timeout 15000（毫秒）
默认 follow-up：空闲开始，忙时排队。stop 将待发送消息转为未发出。
call 只等待持久化收件；observe 获取一次快照。CLI 不启动服务、不自动重试。
短 ID 以当前工作目录解析。调用来源读取 CODEX_THREAD_ID；同一本机用户为信任边界。
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, message: { type: 'string' }, 'message-file': { type: 'string' },
    steer: { type: 'boolean' }, model: { type: 'string' }, reasoning: { type: 'string' },
    'message-id': { type: 'string' }, 'reply-to': { type: 'string' }, cursor: { type: 'string' },
    url: { type: 'string' }, timeout: { type: 'string' },
  } });
  if (values.help) { console.log(help); }
  else {
    if (positionals.length !== 2) throw new Error('需要目标和操作；运行 agentctl --help 查看用法');
    const [target, operation] = positionals;
    if (!['list', 'observe', 'call', 'stop', 'create', 'fork', 'btw'].includes(operation)) throw new Error('不支持的操作；不能替其他 agent 创建子代理');
    if (values.message !== undefined && values['message-file'] !== undefined) throw new Error('message 和 message-file 必须二选一');
    let message = values.message, file;
    if (values['message-file'] !== undefined) {
      file = path.resolve(values['message-file']);
      const info = await stat(file);
      if (!info.isFile() || info.size > 800000) throw new Error('消息文件必须是普通文件且不超过 800000 字节');
      const bytes = await readFile(file);
      if (bytes.length > 800000) throw new Error('消息文件过大');
      message = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    if (message !== undefined && (!message.trim() || message.length > 200000)) throw new Error('消息为空或超过 200000 字符；不会截断');
    if (operation === 'call' && message === undefined) throw new Error('call 需要 message 或 message-file');
    const base = new URL(values.url || process.env.AGENTCTL_URL || `http://127.0.0.1:${process.env.PORT || 4310}`);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('服务地址必须是本机 http://127.0.0.1:PORT 或 localhost');
    const timeout = Number(values.timeout || 15000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('timeout 必须为 1–120000 毫秒');
    const response = await fetch(new URL('/api/agents', base), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({ target, operation, cwd: process.cwd(), caller_thread_id: process.env.CODEX_THREAD_ID || undefined,
        message, message_file: file, steer: values.steer, model: values.model, reasoning: values.reasoning,
        message_id: values['message-id'], reply_to: values['reply-to'], cursor: values.cursor }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  const uncertain = error.name === 'TimeoutError' || error.message === 'fetch failed';
  console.error(JSON.stringify({ error: uncertain ? '服务不可达或请求超时。请检查 CodexWeb；操作可能已收件，先 observe，勿盲目重发。' : error.message }));
  process.exitCode = 1;
}
