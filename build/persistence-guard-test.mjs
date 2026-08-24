// The Stop hook must block a turn that produced an artefact and did not save it, and must stay
// silent everywhere else. A guard that fires on ordinary coaching becomes noise, and noise
// teaches the model to route around the guard instead of doing the thing.
//
// Usage: node persistence-guard-test.mjs <package>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PKG = process.argv[2];
const PLUGIN = path.join(PKG, 'plugin');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
let fails = 0;
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) fails += 1; };

const LONG = 'x '.repeat(900);
// Shaped like the transcripts Claude Code actually writes: every tool call is followed by a
// `user` entry carrying its tool_result. A fixture without those passed while the reader was
// blind to any turn containing a tool, which is every real turn.
function transcript({ ask, reply, tools }) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  for (const t of tools) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: t.name, input: t.input ?? {} }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}

function stop(file) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'runtime', 'lifecycle.mjs'), 'hook-stop', PLUGIN], {
    input: JSON.stringify({ transcript_path: file }),
    env: { ...process.env, BILL_COACH_DATA_DIR: process.argv[3] },
    encoding: 'utf8',
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}

const gate = { name: 'mcp__bill-coach__review_draft', input: {} };
const saved = { name: 'mcp__bill-coach__save_coaching_state', input: { deliverables: [{ kind: 'cv', title: 'CV', body: 'text' }] } };
const savedNoDeliv = { name: 'mcp__bill-coach__save_coaching_state', input: { learnings: [{ learning: 'x' }] } };

let r = stop(transcript({ ask: 'Write my CV out in full.', reply: LONG, tools: [gate] }));
ok(r.decision === 'block' && /did not save it/.test(r.reason ?? ''), 'an artefact produced and not saved is blocked');

r = stop(transcript({ ask: 'Write my CV out in full.', reply: LONG, tools: [gate, saved] }));
ok(r.decision !== 'block', 'the same turn with the save passes');

r = stop(transcript({ ask: 'Write my CV out in full.', reply: LONG, tools: [gate, savedNoDeliv] }));
ok(r.decision === 'block', 'saving only learnings does not count as saving the artefact');

r = stop(transcript({ ask: 'Write my CV out in full.', reply: 'Before I do that — what were the actual numbers at Northwind?', tools: [gate] }));
ok(r.decision !== 'block', 'a clarifying question is not an artefact and passes');

r = stop(transcript({ ask: 'How did the call go, do you think?', reply: LONG, tools: [gate] }));
ok(r.decision !== 'block', 'ordinary long coaching with no artefact asked for passes');

r = stop(transcript({ ask: 'Can you redo the LinkedIn about section?', reply: LONG, tools: [gate] }));
ok(r.decision === 'block', 'the trigger recognises LinkedIn as well as CV');

r = stop(transcript({ ask: 'Give me the weekly review.', reply: LONG, tools: [gate] }));
ok(r.decision === 'block', 'the trigger recognises the weekly review');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nPERSISTENCE GUARD FAILED: ${fails}` : '\nPERSISTENCE GUARD PASSED');
process.exit(fails ? 1 : 0);
