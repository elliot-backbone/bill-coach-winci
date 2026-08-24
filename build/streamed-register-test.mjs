#!/usr/bin/env node
// The streamed-reply register guard (1.14) is the control that replaced the
// every-reply tool gate for conversational turns. A control nothing calls is not
// a control: this drives lifecycle.mjs hook-stop with synthetic transcripts and
// proves the guard blocks a mannered streamed reply, passes a clean one, defers
// to the tool gate, and stays out of onboarding.
// Usage: node streamed-register-test.mjs <installed-home> <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.argv[2];
const PKG = process.argv[3];
if (!HOME || !PKG) { console.error('usage: node streamed-register-test.mjs <installed-home> <package-dir>'); process.exit(2); }
const PLUGIN = path.join(HOME, '.claude-bill-career-coach', 'plugins', 'data', 'bill-career-coach-skills-dir');

let fails = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) { fails += 1; if (d) console.log(`       ${String(d).slice(0, 300)}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-streamed-'));
function transcript(ask, replies, tools = []) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  for (const r of replies.slice(0, -1)) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: r }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: 'go on' } }));
  }
  for (const n of tools) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tX', name: n, input: {} }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tX', content: 'ok' }] } }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: replies[replies.length - 1] }] } }));
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}
function stop(file) {
  const r = spawnSync(process.execPath, [fs.realpathSync(path.join(PLUGIN, 'runtime', 'lifecycle.mjs')), 'hook-stop', PLUGIN], {
    input: JSON.stringify({ transcript_path: file }), env: { ...process.env, BILL_COACH_DATA_DIR: PLUGIN }, encoding: 'utf8', timeout: 30_000,
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { raw: r.stdout, err: r.stderr }; }
}

const CLEAN = 'Call Maya today and ask whether Thursday still works. Her reply settles the venue question, and everything else in the plan holds as we left it.';
const MANNERED = 'This is not just a plan, but a commitment. No hesitation, no delay. It is crucial, pivotal and vital. This is not just a step, but a leap. No doubts, no second thoughts.';

console.log('streamed-register guard');
let r = stop(transcript('What should I do about Maya?', [MANNERED]));
ok(r.decision === 'block' && /register gate/.test(r.reason ?? ''), 'a mannered streamed reply is held with register reasons', JSON.stringify(r).slice(0, 200));
r = stop(transcript('What should I do about Maya?', [CLEAN]));
ok(r.decision !== 'block' || !/register gate/.test(r.reason ?? ''), 'a clean streamed reply passes', JSON.stringify(r).slice(0, 200));
r = stop(transcript('Write my negotiation plan.', [MANNERED], ['mcp__bill-coach__review_draft']));
ok(r.decision !== 'block' || !/register gate/.test(r.reason ?? ''), 'a gated turn is never re-judged by the streamed guard');
r = stop(transcript('Say it again.', [CLEAN, CLEAN, CLEAN]));
ok(r.decision === 'block' && /register gate/.test(r.reason ?? ''), 'cross-reply repetition is caught via transcript priors', JSON.stringify(r).slice(0, 200));

console.log(fails === 0 ? 'STREAMED REGISTER TESTS PASSED' : `STREAMED REGISTER TESTS FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
