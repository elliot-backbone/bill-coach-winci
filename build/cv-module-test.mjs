// The CV module: HIS document, worked over with him, one line at a time.
//
// MEASURED 2026-08-22: asked to tune the CV, Coach ran ten questions and emitted a finished CV
// of its own composition — including the one line Bill had just told it was shaky, "Built and
// led a team of 6 SDRs", where two were contractors. Its own doctrine says the CV is coached
// and not ghost-written. A document he did not write, carrying claims he has not defended, is
// ghost-writing with extra steps.
//
// Usage: node cv-module-test.mjs <package> <installed-home>

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
db.exec('DELETE FROM cv_lines');
const { saveCoachingState } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'memory.mjs')).href);
let sid = db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1").get()?.id;
if (!sid) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
              VALUES ('sess-cv',?,?,'active','[]','[]',1)`).run(now, now);
  sid = 'sess-cv';
}
const save = (payload) => saveCoachingState(db, {
  session_id: sid,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid).version,
  ...payload,
});

// ---- 1. his document goes in as his ---------------------------------------
console.log('ingest');
save({ cv_lines: [
  { line_no: 1, section: 'Experience', current_text: 'Built and led a team of 6 SDRs' },
  { line_no: 2, section: 'Experience', current_text: 'Managed key accounts across EMEA' },
  { line_no: 3, section: 'Summary', current_text: 'Results-driven sales leader' },
] });
ok(db.prepare('SELECT COUNT(*) n FROM cv_lines').get().n === 3, 'his lines are ingested as supplied');
ok(db.prepare('SELECT COUNT(*) n FROM cv_lines WHERE bill_ruling IS NULL').get().n === 3,
  'nothing arrives pre-ruled');

// ---- 2. a proposal must rest on the record --------------------------------
console.log('\nproposals need evidence');
const bare = save({ cv_lines: [{ line_no: 2, current_text: 'Managed key accounts across EMEA',
  proposed_text: 'Something better', evidence_refs: [] }] });
ok((bare.conflicts || []).some((c) => c.table === 'cv_lines'),
  'a proposal with no evidence is refused, not silently written');
ok(!db.prepare('SELECT proposed_text FROM cv_lines WHERE line_no = 2').get().proposed_text,
  'and nothing was written');

save({ cv_lines: [{
  line_no: 2, current_text: 'Managed key accounts across EMEA',
  proposed_text: 'Got inside Checker\'s own Slack and rebuilt our case in their CFO\'s format',
  rationale: 'his own story turns on this and the current line hides it',
  evidence_refs: ['cover-checker-2018', 'deliv-tight-five-v4'],
  challenge_asked: 'a founder will ask what you actually did in there',
} ] });
const l2 = db.prepare('SELECT * FROM cv_lines WHERE line_no = 2').get();
ok(l2.proposed_text?.includes('Slack'), 'a proposal with evidence is accepted');
ok(JSON.parse(l2.evidence_refs_json).length === 2, 'the evidence is recorded with it');
ok(l2.challenge_asked?.includes('founder'), 'the defend-it challenge is recorded');

// ---- 3. his ruling is what makes a line final -----------------------------
console.log('\nhis ruling');
save({ cv_lines: [{ line_no: 2, current_text: 'Managed key accounts across EMEA',
  bill_ruling: 'amended', final_text: 'Lived in Checker\'s Slack and rewrote our case in their CFO\'s own format',
  challenge_answer: 'I rebuilt the numbers in his format so he could lift it into his board pack' }] });
const ruled = db.prepare('SELECT * FROM cv_lines WHERE line_no = 2').get();
ok(ruled.bill_ruling === 'amended' && ruled.final_text.includes('board pack') === false,
  'his amendment is stored as the final text');
ok(ruled.challenge_answer?.includes('board pack'), 'what he said in his defence is kept');
ok(db.prepare('SELECT COUNT(*) n FROM cv_lines').get().n === 3,
  'updating a line does not create a second row for the same position');

// ---- 4. the gates ---------------------------------------------------------
console.log('\ngates');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
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
// Sized like a real CV. The first version of this fixture was 1,269 characters and the gate
// correctly ignored it: a 1,200-character reply is a section, not a document. The threshold is
// 1,500, and a real two-page CV runs 2,500 to 4,000.
const wholeCv = `## Summary\n\n${'Seasoned commercial leader with a decade of results across events and media. '.repeat(14)}\n\n`
  + `## Experience\n\n${'Led teams, grew revenue, built the process from nothing and ran it. '.repeat(20)}\n\n`
  + `## Skills\n\n${'Enterprise closing, team building, launch operations, forecasting. '.repeat(8)}\n\n`
  + `## Education\n\n${'Brentwood School, then straight into the business. '.repeat(6)}`;

let r = stop(transcript('Tune my CV for the core full-time lane.', wholeCv));
ok(r.decision === 'block' && /no ruling from Bill/.test(r.reason ?? ''),
  'a whole CV is blocked while lines are unruled, and says how many');

r = stop(transcript('Tune my CV.', 'Line two says "managed key accounts across EMEA". What did you actually do on the biggest one?'));
ok(!/no ruling from Bill/.test(r.reason ?? ''), 'working on a single line is never blocked');

save({ cv_lines: [
  { line_no: 1, current_text: 'Built and led a team of 6 SDRs', bill_ruling: 'amended', final_text: 'Built the SDR function from nothing: four permanent, two contract' },
  { line_no: 3, current_text: 'Results-driven sales leader', bill_ruling: 'rejected' },
] });
r = stop(transcript('Tune my CV.', wholeCv));
ok(!/no ruling from Bill/.test(r.reason ?? ''), 'with every line ruled, the whole CV may be presented');

db.exec('DELETE FROM cv_lines');
r = stop(transcript('Tune my CV.', wholeCv));
ok(r.decision === 'block' && /not on file/.test(r.reason ?? ''),
  'presenting a CV when his document was never supplied is blocked');

// ---- 5. LinkedIn shares the ledger without sharing the gate ---------------
console.log('\nlinkedin');
db.exec('DELETE FROM cv_lines');
save({ cv_lines: [
  { line_no: 1, surface: 'cv', current_text: 'Built and led a team of 6 SDRs' },
  { line_no: 1, surface: 'headline', current_text: 'Sales Leader | Revenue Growth | SaaS' },
  { line_no: 2, surface: 'about', current_text: 'Results-driven leader with a passion for growth' },
] });
ok(db.prepare("SELECT COUNT(*) n FROM cv_lines WHERE surface='cv'").get().n === 1
  && db.prepare("SELECT COUNT(*) n FROM cv_lines WHERE surface IN ('headline','about')").get().n === 2,
  'CV and LinkedIn lines live in one ledger, separated by surface');

const wholeProfile = `## Headline\n\n${'Commercial leader who builds the function, not just the number. '.repeat(10)}\n\n`
  + `## About\n\n${'A decade running launches and closing enterprise deals in events and media. '.repeat(18)}\n\n`
  + `## Experience\n\n${'Built the SDR function, ran US-timed launches from London for ten years. '.repeat(12)}`;

r = stop(transcript('Rewrite my LinkedIn headline and about section.', wholeProfile));
ok(r.decision === 'block' && /LinkedIn profile/.test(r.reason ?? ''),
  'a whole profile is blocked while its lines are unruled');
ok(/carries over/.test(r.reason ?? '') || /already given/.test(r.reason ?? ''),
  'and it is told to carry over rulings he has already given on the CV');

save({ cv_lines: [
  { line_no: 1, surface: 'headline', current_text: 'Sales Leader | Revenue Growth | SaaS', bill_ruling: 'accepted' },
  { line_no: 2, surface: 'about', current_text: 'Results-driven leader with a passion for growth', bill_ruling: 'amended', final_text: 'I build the function, not just the number.' },
] });
r = stop(transcript('Rewrite my LinkedIn.', wholeProfile));
ok(!/no ruling from Bill/.test(r.reason ?? ''), 'with the profile lines ruled, the profile may be presented');

r = stop(transcript('Tune my CV.', wholeCv));
ok(r.decision === 'block' && /CV/.test(r.reason ?? '') && !/LinkedIn/.test(r.reason ?? ''),
  'the unruled CV line still blocks the CV, so the two surfaces do not mask each other');

fs.rmSync(dir, { recursive: true, force: true });
db.close();
console.log(fails ? `\nCV MODULE TESTS FAILED: ${fails}` : '\nCV MODULE TESTS PASSED');
process.exit(fails ? 1 : 0);
