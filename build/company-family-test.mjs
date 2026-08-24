// The company family: facts and their evidence tiers, the P0 guard the doctrine always
// claimed, and rehearsal's inverted gate.
//
// MEASURED 2026-08-22/23:
//   · funnel-doctrine.md has always said P0 promotion needs "company facts sourced + as-of,
//     2 sources on funding". The code checked only that Bill said go. Nothing counted sources,
//     so a company could enter the funnel on facts nobody had sourced.
//   · the rehearsal module produced 5,458 characters, the least of any module in the product,
//     for the one thing whose entire purpose is repetition under pressure.
//
// Usage: node company-family-test.mjs <package> <installed-home>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const PKG = process.argv[2];
const HOME = process.argv[3];
const PLUGIN = path.join(PKG, 'plugin');
const DATA = path.join(HOME, '.claude-bill-career-coach', 'plugins', 'data', 'bill-career-coach-skills-dir');
let fails = 0;
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) fails += 1; };

const db = new DatabaseSync(path.join(DATA, 'state', 'coach.sqlite'));
db.exec('PRAGMA busy_timeout = 10000');
db.exec('DELETE FROM facts');
db.exec('DELETE FROM rehearsal_rounds');

const { saveCoachingState } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'memory.mjs')).href);
const funnel = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'funnel.mjs')).href);
let sid = db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1").get()?.id;
if (!sid) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
              VALUES ('sess-fam',?,?,'active','[]','[]',1)`).run(now, now);
  sid = 'sess-fam';
}
const save = (payload) => saveCoachingState(db, {
  session_id: sid,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid).version,
  ...payload,
});

// ---- 1. facts are just facts -----------------------------------------------
// OPERATOR RULING 2026-08-23: no hierarchy of validity. This section used to assert a
// single/corroborated grade and a promotion gate built on it — the confirmed/proposed idea
// rebuilt under a different word after it had already been removed once. What remains is the
// part that was always useful: a fact says where it came from and when it was true, so Bill
// can check it, and he can correct any of it at any time.
console.log('facts');
// The scrubbed package ships an EMPTY roles table, so this creates what it needs rather than
// assuming Bill's roster is present. Asserting "a role exists" tested the fixture, not the code.
function makeRole(id, company) {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO roles (id, company, lane, phase, source, as_of, thesis_fit_json,
              bill_fit_json, their_side_json, investor_names_json, created_at, updated_at)
              VALUES (?, ?, 'core-ft', 'P0', 'test fixture', ?, '{}', '{}', '{}', '[]', ?, ?)`)
    .run(id, company, now.slice(0, 10), now, now);
  return id;
}
const roleId = db.prepare("SELECT id FROM roles WHERE phase='P0' LIMIT 1").get()?.id
  ?? makeRole('role-fam-a', 'Northwind Robotics');
ok(!!roleId, 'a P0 role is available to test against');

save({ facts: [{ role_id: roleId, kind: 'funding', claim: 'raised $4m seed', as_of: '2026-01', source: 'their website' }] });
let f = db.prepare("SELECT * FROM facts WHERE role_id = ? AND kind='funding'").get(roleId);
ok(!!f, 'a fact is stored');
ok(f.source === 'their website' && f.as_of === '2026-01', 'with where it came from and when it was true');
ok(!('confidence' in f), 'and with no grade attached to it');

const noSource = save({ facts: [{ role_id: roleId, kind: 'product', claim: 'sells to logistics', as_of: '2026-08' }] });
ok(!(noSource.conflicts || []).some((c) => c.table === 'facts'),
  'a fact without a source is accepted: unknown provenance is not a lesser fact');

const noDate = save({ facts: [{ role_id: roleId, kind: 'product', claim: 'no date given', source: 'a call' }] });
ok((noDate.conflicts || []).some((c) => c.table === 'facts'),
  'an as-of date is still required, because staleness is worth seeing');

// ---- 2. promotion turns on Bill's verdict, nothing else -------------------
console.log('\npromotion');
const bare = db.prepare("SELECT id, company FROM roles WHERE phase='P0' AND id != ? LIMIT 1").get(roleId)
  ?? { id: makeRole('role-fam-b', 'Deadend Systems'), company: 'Deadend Systems' };
if (bare) {
  db.prepare(`UPDATE roles SET bill_fit_json = json('{"verdict":"go"}') WHERE id = ?`).run(bare.id);
  let threw = '';
  try {
    funnel.transitionPhase(db, bare.id, 'P1', 'bill-said', sid);
  } catch (e) { threw = e.message; }
  ok(threw === '', "with Bill's go recorded, promotion goes through and nothing else is demanded");
} else {
  ok(false, 'needed a second P0 role to test promotion');
}

// ---- 3. rehearsal, and the gate that blocks stopping ----------------------
console.log('\nrehearsal, inverted gate');
save({ rehearsal_rounds: [{
  topic: 'why you left Northwind', question: 'So why did you actually leave?',
  escalation: 1, his_answer: 'It was time for a change', verdict: 'weak',
  what_was_weak: 'no reason given, sounds evasive', source: 'debrief',
}] });
let rows = db.prepare('SELECT * FROM rehearsal_rounds').all();
ok(rows.length === 1 && rows[0].round === 1, 'the first attempt is round 1');

save({ rehearsal_rounds: [{
  topic: 'why you left Northwind', question: 'So why did you actually leave?',
  escalation: 2, his_answer: 'The business had stopped teaching me anything', verdict: 'holding',
}] });
rows = db.prepare('SELECT * FROM rehearsal_rounds ORDER BY round').all();
ok(rows.length === 2 && rows[1].round === 2, 'a second attempt is a new round, not an overwrite');
ok(rows[0].his_answer === 'It was time for a change', 'the weak first attempt is still readable');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reh-'));
function transcript(ask, reply) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bill-coach__review_draft', input: {} }] } }));
  lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }));
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
  const fp = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(fp, lines.join('\n'));
  return fp;
}
const stop = (fp) => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'runtime', 'lifecycle.mjs'), 'hook-stop', PLUGIN], {
    input: JSON.stringify({ transcript_path: fp }), env: { ...process.env, BILL_COACH_DATA_DIR: DATA }, encoding: 'utf8',
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
};
const windingUp = `Good work on that. ${'You are in much better shape on this than you were an hour ago. '.repeat(8)}`;

// Make the latest verdict weak again, so something genuinely stands unresolved.
save({ rehearsal_rounds: [{
  topic: 'why you left Northwind', question: 'So why did you actually leave?',
  escalation: 3, his_answer: 'I mean, it was complicated', verdict: 'weak', what_was_weak: 'retreated again',
}] });
let r = stop(transcript('Can we rehearse the leaving question?', windingUp));
ok(r.decision === 'block' && /still rated weak/.test(r.reason ?? ''),
  'winding up with a weak answer outstanding is blocked');
ok(/hostile version/.test(r.reason ?? ''), 'and it escalates rather than repeating the same round');

r = stop(transcript('Can we rehearse the leaving question?', 'Right, again. Why did you leave Northwind?'));
ok(!/still rated weak/.test(r.reason ?? ''), 'putting it to him again is never blocked');

save({ rehearsal_rounds: [{
  topic: 'why you left Northwind', question: 'So why did you actually leave?',
  escalation: 3, his_answer: 'I had learned everything that business could teach me and I wanted a harder problem',
  verdict: 'strong',
}] });
r = stop(transcript('Can we rehearse the leaving question?', windingUp));
ok(!/still rated weak/.test(r.reason ?? ''), 'once the latest verdict is strong, the module may close');

fs.rmSync(dir, { recursive: true, force: true });
db.close();
console.log(fails ? `\nCOMPANY FAMILY TESTS FAILED: ${fails}` : '\nCOMPANY FAMILY TESTS PASSED');
process.exit(fails ? 1 : 0);
