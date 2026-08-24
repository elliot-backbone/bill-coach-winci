// The debrief, and the compounding rule.
//
// Regression: a shallow synthetic debrief said only "went fine, they liked one example" and
// omitted the evidence every downstream module needs. Learnings, voice deltas, funnel movement
// and the next brief all eat from here, while the source material decays quickly.
//
// OPERATOR RULING 2026-08-23: a company opportunity is a SEQUENCE of meetings. A prep brief
// written without the previous meeting's debrief throws away the only advantage he has going
// into the next round, and the walkthrough has promised the opposite since the first build.
//
// Usage: node debrief-module-test.mjs <package> <installed-home>

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
db.exec('DELETE FROM debrief_capture');
db.exec("DELETE FROM interactions WHERE id LIKE 'test-int-%'");

const { saveCoachingState } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'memory.mjs')).href);
let sid = db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1").get()?.id;
if (!sid) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
              VALUES ('sess-db',?,?,'active','[]','[]',1)`).run(now, now);
  sid = 'sess-db';
}
// The scrubbed package ships with an EMPTY roles table, so inventing an id here produced a
// foreign key failure on Windows while passing locally against the real roster. Create the role
// when there is not one, the way a real session would.
let roleId = db.prepare('SELECT id FROM roles LIMIT 1').get()?.id;
if (!roleId) {
  const now = new Date().toISOString();
  roleId = 'role-test-debrief';
  db.prepare(`INSERT INTO roles (id, company, lane, phase, source, as_of, thesis_fit_json, bill_fit_json,
              their_side_json, investor_names_json, created_at, updated_at)
              VALUES (?, 'Northwind Robotics', 'core-ft', 'P0', 'test fixture', ?, '{}', '{}', '{}', '[]', ?, ?)`)
    .run(roleId, now.slice(0, 10), now, now);
}
const save = (payload) => saveCoachingState(db, {
  session_id: sid,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid).version,
  ...payload,
});

const SLOTS = ['what_was_asked', 'what_he_said', 'where_it_stalled', 'their_language',
  'signals_read', 'commitments_made', 'what_he_would_do_differently'];

// ---- 1. capture ------------------------------------------------------------
console.log('capture');
save({ debrief_capture: [{
  role_id: roleId, slot: 'what_was_asked',
  detail: 'Whether he would be fine with no team under him at first',
  verbatim: "So you'd be on your own for a while — is that actually alright with you?",
  who: 'the founder', asked_twice: true,
}] });
const first = db.prepare('SELECT * FROM debrief_capture').get();
ok(first && first.role_id === roleId, 'a captured moment is stored against the company');
ok(first.asked_twice === 1, 'a question asked twice is marked as such');
ok(first.verbatim?.includes('on your own'), 'their exact words are kept, not a paraphrase');

const bad = save({ debrief_capture: [{ role_id: roleId, slot: 'what_he_said', detail: '   ' }] });
ok((bad.conflicts || []).some((c) => c.table === 'debrief_capture'), 'an empty capture is refused and reported');

// ---- 2. the debrief document is gated on capture ---------------------------
console.log('\nthe debrief document');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
function transcript(ask, reply) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bill-coach__review_draft', input: {} }] } }));
  lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }));
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
  const f = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}
const stop = (f) => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'runtime', 'lifecycle.mjs'), 'hook-stop', PLUGIN], {
    input: JSON.stringify({ transcript_path: f }), env: { ...process.env, BILL_COACH_DATA_DIR: DATA }, encoding: 'utf8',
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
};
const writeUp = `Here is the debrief. ${'What happened, what it tells us, and what comes next for this one. '.repeat(20)}`;

let r = stop(transcript('Northwind call done. Went fine.', writeUp));
ok(r.decision === 'block' && /of 7 slots/.test(r.reason ?? ''),
  'writing up the debrief on one captured slot is blocked, and it says how many are missing');
ok(/went fine/.test(r.reason ?? ''), 'and it names the vibe answer it should refuse to accept');

save({ debrief_capture: SLOTS.slice(1, 6).map((s) => ({ role_id: roleId, slot: s, detail: `something real about ${s}` })) });
r = stop(transcript('Northwind call done.', writeUp));
ok(!/of 7 slots/.test(r.reason ?? ''), 'with six of seven captured, the write-up is allowed');

// ---- 3. the compounding rule ----------------------------------------------
console.log('\ncompounding across meetings');
const now = new Date().toISOString();
db.prepare(`INSERT INTO interactions (id, role_id, kind, occurred_at, participants_json, review_json,
            commitments_theirs_json, created_at, updated_at)
            VALUES ('test-int-1', ?, 'call', ?, '[]', '{}', '[]', ?, ?)`).run(roleId, now, now, now);

r = stop(transcript('I have got a second call with Northwind on Thursday. Prep me.', writeUp));
ok(r.decision === 'block' && /no debrief on file/.test(r.reason ?? ''),
  'a prep brief is blocked while an earlier meeting has never been debriefed');
ok(/as though this were the first/.test(r.reason ?? ''), 'and it says why that matters');

save({ debrief_capture: [{ role_id: roleId, interaction_id: 'test-int-1', slot: 'what_was_asked',
  detail: 'the no-team question again', verbatim: 'and you are sure about that?' }] });
r = stop(transcript('I have got a second call with Northwind on Thursday. Prep me.', writeUp));
ok(!/no debrief on file/.test(r.reason ?? ''), 'once that meeting is debriefed, the brief may be written');

// ---- 4. orientation carries the sequence ----------------------------------
console.log('\norientation');
const ctxMod = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'context.mjs')).href);
const lib = new DatabaseSync(path.join(DATA, 'library', 'library.sqlite'), { readOnly: true });
const ctx = ctxMod.getContext(db, lib, { session_id: sid, question: 'northwind' });
const meetings = ctx.company_meetings ?? [];
ok(meetings.length >= 1, 'start_coach carries the meeting sequence');
ok(meetings[0].debriefed === true, 'and says which meetings have been debriefed');
ok(Array.isArray(meetings[0].asked_twice), 'and surfaces what they asked twice, which is the decision criterion');
lib.close();

fs.rmSync(dir, { recursive: true, force: true });
db.exec("DELETE FROM interactions WHERE id LIKE 'test-int-%'");
db.close();
console.log(fails ? `\nDEBRIEF MODULE TESTS FAILED: ${fails}` : '\nDEBRIEF MODULE TESTS PASSED');
process.exit(fails ? 1 : 0);
