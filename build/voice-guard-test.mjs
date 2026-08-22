#!/usr/bin/env node
// The Stop hook is where AI-writing rules stop being advice.
//
// MEASURED 2026-08-22: across two full live simulations, the instruction layer alone did
// not move block-severity violations (0.50 -> 0.58 per 1,000 characters). The hook is the
// only thing that actually removes them, and `claude -p` does not run Stop hooks — so it
// cannot be tested from the live simulation and is tested here instead.
//
// Usage: node voice-guard-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-voice-'));
fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dir, 'library', 'library.sqlite'));

// The onboarding checkpoint guard runs before the voice guard and would mask it, so this
// fixture is a coach that has finished setup — which is when voice actually matters.
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'state', 'coach.sqlite'));
  db.exec('PRAGMA busy_timeout = 10000');
  db.prepare(`UPDATE onboarding SET status = 'complete', updated_at = ? WHERE singleton = 1`).run(new Date().toISOString());
  db.close();
}

/** Drive the real hook exactly as Claude Code does: payload on stdin, decision on stdout. */
function runStopHook(replyText) {
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
  })}\n`);
  const res = spawnSync(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'lifecycle.mjs'), 'hook-stop', dir], {
    input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript }),
    env: { ...process.env, BILL_COACH_DATA_DIR: dir },
    encoding: 'utf8',
  });
  let decision = null;
  try { decision = JSON.parse(String(res.stdout).trim() || 'null'); } catch { /* not a decision */ }
  return { decision, stderr: res.stderr, raw: res.stdout };
}

console.log(`package:  ${pkg}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}\n`);

console.log('== a reply carrying AI hallmarks is blocked ==');
{
  const bad = "Good one to open with — but right now it's a result, not a story. No obstacle, no story. "
    + "That's a positioning fix, not a truth problem.";
  const { decision, stderr } = runStopHook(bad);
  check(decision?.decision === 'block', 'the hook blocks it', `${JSON.stringify(decision)?.slice(0, 200)} ${stderr.slice(0, 200)}`);
  check(/SP-017/.test(decision?.reason ?? ''), 'the reason names the em-dash rule');
  check(/AW-02[46]/.test(decision?.reason ?? ''), 'the reason names the negation rule');
  check(/rewrite/i.test(decision?.reason ?? ''), 'the reason asks for a rewrite of the same substance');
  check(/onboarding-exemplars/.test(decision?.reason ?? ''), 'the reason points at the approved reference register');
  check(!/soften/i.test(decision?.reason ?? '') || /Do not soften/.test(decision?.reason ?? ''),
    'the reason forbids softening the content to satisfy the rule');
}

console.log('\n== a clean reply passes ==');
{
  const good = 'Good one to open with. Right now it reads as a scoreboard. The line about living in their '
    + 'Slack is the part a seed founder leans forward for, because that is how they sell too. '
    + 'Three things I need before I can write it. What was your normal deal size at the time? '
    + 'What nearly killed it, and what did you do that week? Whose idea was the Slack channel?';
  const { decision, stderr } = runStopHook(good);
  check(decision === null || decision?.decision !== 'block', 'the hook lets it through',
    `${JSON.stringify(decision)?.slice(0, 250)} ${stderr.slice(0, 150)}`);
}

console.log('\n== the guard never loops ==');
{
  const bad = "It's a result, not a story. No obstacle, no story.";
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: bad }] } })}\n`);
  const res = spawnSync(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'lifecycle.mjs'), 'hook-stop', dir], {
    input: JSON.stringify({ stop_hook_active: true, transcript_path: transcript }),
    env: { ...process.env, BILL_COACH_DATA_DIR: dir }, encoding: 'utf8',
  });
  check(String(res.stdout).trim() === '', 'a reply already being rewritten is not blocked again', res.stdout.slice(0, 150));
}

console.log('\n== the registers are present and load ==');
{
  const m = await import(path.join(pkg, 'plugin', 'runtime', 'style.mjs'));
  check(m.STYLE_RULE_COUNT >= 49, `both authorities load (${m.STYLE_RULE_COUNT} rules)`);
  const v = m.checkReply("it's a result, not a story. No obstacle, no story. And it's a fix, not a problem.");
  check(v.some((x) => x.rule_id === 'AW-024'), 'the negation pair is caught');
  check(v.some((x) => x.rule_id === 'AW-026'), 'negation density is caught');
  check(m.checkReply('A clean sentence that says one thing and stops.').filter((x) => x.severity === 'block').length === 0,
    'clean prose produces no block-severity violation');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'VOICE GUARD TESTS PASSED' : `VOICE GUARD TESTS FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
