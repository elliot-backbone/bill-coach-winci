#!/usr/bin/env node
// The voice layer is delivered by reasoning, not by a regex gate.
//
// Enforcement lives in the three-level panel the model runs before replying, so what a
// deterministic test can honestly assert is that the layer REACHES the model on every
// session, unconditionally, and that the reference authorities it reasons against are
// present and loadable. Whether the reasoning worked is measured, not asserted — the
// numbers are printed for a human to read, and no threshold is enforced here, because a
// style threshold that fails a build teaches dodging the detector rather than writing better.
//
// Usage: node voice-layer-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
};
const note = (l) => console.log(`  ·    ${l}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-voice-'));
fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dir, 'library', 'library.sqlite'));

console.log(`package:  ${pkg}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}\n`);

// ---------------------------------------------------------------- delivered every session
console.log('== the voice layer reaches the model unconditionally ==');
const orientation = await (async () => {
  const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
    env: { ...process.env, BILL_COACH_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
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
  const rpc = (method, params) => new Promise((res) => {
    const n = id++; pending.set(n, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'voice', version: '1' } });
  const r = await rpc('tools/call', { name: 'start_coach', arguments: { user_message: 'hello', now: new Date().toISOString() } });
  child.kill();
  await new Promise((res) => setTimeout(res, 300));
  const text = r?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return {}; }
})();

check(typeof orientation.conduct === 'string' && orientation.conduct.length > 400,
  'conduct is carried in the start_coach result', String(orientation.conduct).slice(0, 120));
check(/ORDER OF OPERATIONS/.test(orientation.conduct ?? ''), 'it states what-before-how');
check(/REASON WITH/.test(orientation.conduct ?? ''), 'it frames the principles as reasoning requirements, not tests');
check(/NEVER FLATTER/.test(orientation.conduct ?? ''), 'it carries the anti-sycophancy requirement');
check(/CALIBRATED CONFIDENCE/.test(orientation.conduct ?? ''), 'it carries the honest-confidence requirement');
check(/ASK BEFORE ASSERTING/.test(orientation.conduct ?? ''), 'it carries the ask-before-asserting requirement');
check(typeof orientation.panel_review === 'string' && orientation.panel_review.length > 800,
  'the panel review is carried too', String(orientation.panel_review).slice(0, 120));
for (const level of ['LEVEL ONE', 'LEVEL TWO', 'LEVEL THREE']) {
  check((orientation.panel_review ?? '').includes(level), `the panel has ${level.toLowerCase()}`);
}
check(/veto/.test(orientation.panel_review ?? ''), 'level three holds a veto');
check(/onboarding-exemplars/.test(orientation.panel_review ?? ''), 'the approved voice is named as the reference register');

// ---------------------------------------------------------------- reference authorities
console.log('\n== the authorities the panel reasons against are present ==');
for (const rel of ['plugin/authorities/style-prohibition-register.v1.json',
                   'plugin/authorities/ai-writing-signs-register.v1.json']) {
  check(fs.existsSync(path.join(pkg, rel)), `${rel.split('/').pop()} ships`);
}
const m = await import(path.join(pkg, 'plugin', 'runtime', 'style.mjs'));
check(m.STYLE_RULE_COUNT >= 49, `both registers load (${m.STYLE_RULE_COUNT} rules) for measurement`);

// ---------------------------------------------------------------- measurement, not a gate
console.log('\n== measurement (reported, never enforced) ==');
const exemplars = m.checkReply(fs.readFileSync(path.join(pkg, 'plugin', 'coach', 'onboarding-exemplars.md'), 'utf8'));
const eb = exemplars.filter((v) => v.severity === 'block').length;
note(`approved walkthrough panes: ${eb} block-severity, ${exemplars.length - eb} flag`);
note('these numbers exist to be read by a person, not to fail a build');

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'VOICE LAYER TESTS PASSED' : `VOICE LAYER TESTS FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
