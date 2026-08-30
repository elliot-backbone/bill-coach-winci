// MCP tap: tee every JSON-RPC line between Claude Code and the Coach server, both directions, to a
// per-turn JSONL file. Injected with NODE_OPTIONS=--import <this file> into the environment Claude Code
// spawns its MCP servers with. It activates ONLY inside the Coach server process (argv[1] names
// server.mjs under the installed data dir) — in any other node process (Claude Code itself, hooks,
// suites) it is a no-op. It never alters bytes; it copies them. Path from MCP_TAP_LOG.
import fs from 'node:fs';
import path from 'node:path';

const entry = process.argv[1] ? String(process.argv[1]).replace(/\\/g, '/') : '';
const log = process.env.MCP_TAP_LOG;
if (log && /\/runtime\/server\.mjs$/.test(entry)) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const write = (dir, line) => {
    try { fs.appendFileSync(log, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, dir, line: line.length > 200000 ? `${line.slice(0, 200000)}…[truncated ${line.length}]` : line })}\n`); } catch { /* never break the server */ }
  };
  let inBuf = '';
  process.stdin.on('data', (d) => { inBuf += String(d); let i; while ((i = inBuf.indexOf('\n')) >= 0) { const l = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1); if (l.trim()) write('client->server', l); } });
  const origWrite = process.stdout.write.bind(process.stdout);
  let outBuf = '';
  process.stdout.write = (chunk, ...rest) => {
    outBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i; while ((i = outBuf.indexOf('\n')) >= 0) { const l = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1); if (l.trim()) write('server->client', l); }
    return origWrite(chunk, ...rest);
  };
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { write('server-stderr', typeof chunk === 'string' ? chunk : chunk.toString('utf8')); return origErr(chunk, ...rest); };
  process.on('exit', (code) => write('server-exit', String(code)));
}
