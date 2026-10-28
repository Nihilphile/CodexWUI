import { createInterface } from 'node:readline';
import { BTW_TOOLS, readBtwProject } from './btw.mjs';

// Forks cannot replace dynamicTools. Expose the same project-bounded readers
// through a dedicated local MCP server, with every inherited server disabled.
const [root] = process.argv.slice(2);
if (!root) throw new Error('Missing BTW project root');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let frameBytes = 0;
process.stdin.on('data', chunk => {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
    frameBytes += end - offset;
    if (frameBytes > 1024 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
    if (newline < 0) break;
    frameBytes = 0; offset = newline + 1;
  }
});
for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
  if (message.id === undefined) continue;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'CodexWeb BTW', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: BTW_TOOLS.map(({ type, ...tool }) => tool) };
    else if (message.method === 'resources/list') result = { resources: [] };
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (message.method === 'prompts/list') result = { prompts: [] };
    else if (message.method === 'tools/call') {
      try {
        const content = await readBtwProject(root, message.params?.name, message.params?.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(content) }] };
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }); }
}
