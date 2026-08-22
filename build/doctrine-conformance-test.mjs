#!/usr/bin/env node
// Does the coach's own doctrine describe a machine that exists?
//
// Every instruction surface tells the model to call specific tools, write specific
// tables and set specific fields. Each of those is a promise. This reads the promises
// out of the doctrine and checks them against the live tool schemas and the live
// database. A promise with nothing behind it is a defect: the coach follows the
// instruction, the call fails or silently does nothing, and Bill sees amnesia.
//
// Usage: node doctrine-conformance-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 400)}`); }
};
const section = (s) => console.log(`\n== ${s} ==`);

// ---- what the machine actually offers --------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-conform-'));
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dataDir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dataDir, 'library', 'library.sqlite'));

const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
  env: { ...process.env, BILL_COACH_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '', id = 1;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* */ }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = id++;
  const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 15000);
  pending.set(myId, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
});
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } });
const tools = (await rpc('tools/list', {}))?.result?.tools ?? [];
const toolNames = new Set(tools.map((t) => t.name));
const saveTool = tools.find((t) => t.name === 'save_coaching_state');
const saveFields = new Set(Object.keys(saveTool?.inputSchema?.properties ?? {}));
// Wait for the server to actually exit: it holds the database until then, and a read
// opened in the gap fails on a lock. (The runtime learned this lesson in 1.2.5.)
await new Promise((res) => { child.once('close', res); child.kill(); setTimeout(res, 3000); });

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(path.join(dataDir, 'state', 'coach.sqlite'), { readOnly: true });
db.exec('PRAGMA busy_timeout = 10000');
const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
// Some doctrine tables live in the library, not the state store — market_deals is the
// licensed deal baseline. Checking only one database invents failures that are not real.
const lib = new DatabaseSync(path.join(dataDir, 'library', 'library.sqlite'), { readOnly: true });
lib.exec('PRAGMA busy_timeout = 10000');
for (const r of lib.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) tables.add(r.name);
lib.close();
// And the runtime's own declared search surface is authoritative for what is reachable.
const searchable = (fs.readFileSync(path.join(pkg, 'plugin/runtime/statesearch.mjs'), 'utf8')
  .match(/const SEARCHABLE[^=]*=\s*(?:new Set\()?\[([\s\S]*?)\]/) ?? [, ''])[1]
  .split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
for (const name of searchable) tables.add(name);
const columnsOf = (t) => new Set(db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name));

console.log(`tools:  ${[...toolNames].sort().join(', ')}`);
console.log(`tables: ${[...tables].filter((t) => !t.startsWith('state_fts')).sort().join(', ')}`);
console.log(`save_coaching_state accepts: ${[...saveFields].sort().join(', ')}`);

// ---- what the doctrine promises --------------------------------------------
const surfaces = [];
for (const dir of ['plugin/coach', 'plugin/lenses', 'plugin/skills/coach']) {
  const abs = path.join(pkg, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (name.endsWith('.md')) surfaces.push({ rel: `${dir}/${name}`, text: fs.readFileSync(path.join(abs, name), 'utf8') });
  }
}
console.log(`doctrine surfaces read: ${surfaces.length}`);

const hits = (re, mapper) => {
  const out = new Map();
  for (const { rel, text } of surfaces) {
    for (const m of text.matchAll(re)) {
      for (const value of mapper(m)) {
        if (!value) continue;
        if (!out.has(value)) out.set(value, new Set());
        out.get(value).add(rel);
      }
    }
  }
  return out;
};

section('Tools the doctrine tells the coach to call');
const toolRefs = hits(/\b([a-z_]+)\(/g, (m) => [m[1]]);
for (const [name, where] of [...toolRefs].sort()) {
  // Only judge names that look like this system's tools.
  if (!/^(start_coach|end_coach|save_coaching_state|get_context|search_library|search_state|inspect_memory|update_state|sync_source|bill_command)$/.test(name)) continue;
  check(toolNames.has(name), `${name}() exists`, `referenced by ${[...where].join(', ')}`);
}
const unknownToolish = [...toolRefs].filter(([n]) => /^(save_|update_|search_|inspect_|record_|write_|log_)/.test(n) && !toolNames.has(n));
for (const [name, where] of unknownToolish) {
  check(false, `${name}() is referenced but no such tool exists`, `referenced by ${[...where].join(', ')}`);
}

section('save_coaching_state payloads the doctrine names');
const saveRefs = hits(/save_coaching_state[.(]\s*([a-z_]+)/g, (m) => [m[1]]);
for (const [field, where] of [...saveRefs].sort()) {
  check(saveFields.has(field), `save_coaching_state accepts "${field}"`, `named by ${[...where].join(', ')}`);
}

section('Tables the doctrine tells the coach to read or write');
const tableRefs = hits(/tables:\s*\[([^\]]*)\]/g, (m) => m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')));
const searchStateRefs = hits(/search_state\(([a-z_,\s]+)\)/g, (m) => m[1].split(',').map((s) => s.trim()));
for (const [name, where] of [...new Map([...tableRefs, ...searchStateRefs])].sort()) {
  if (!name || name.length < 3 || /^(tables|filters|query|limit)$/.test(name)) continue;
  check(tables.has(name) || saveFields.has(name),
    `"${name}" is reachable (a table, or a save_coaching_state field)`, `named by ${[...where].join(', ')}`);
}

section('Record fields the doctrine tells the coach to set');
const FIELD_CLAIMS = [
  ['roles', 'bill_fit_json', /bill_fit/],
  ['roles', 'thesis_fit_json', /thesis_fit/],
  ['roles', 'next_action', /next_action/],
  ['interactions', 'commitments_theirs_json', /commitments_theirs/],
  ['offers', 'status', /offers?.*status|status.*offer/i],
  ['learnings', 'category', /learnings?\(category/],
  ['contacts', 'relationship', /contacts table:/],
];
for (const [table, column, pattern] of FIELD_CLAIMS) {
  const named = surfaces.filter((s) => pattern.test(s.text)).map((s) => s.rel);
  if (!named.length) continue;
  check(tables.has(table) && columnsOf(table).has(column),
    `${table}.${column} exists for the doctrine that names it`, `named by ${named.join(', ')}`);
}

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'DOCTRINE CONFORMANCE PASSED' : `DOCTRINE CONFORMANCE FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
