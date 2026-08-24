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
  proposed_text: 'Got inside Northwind\'s own Slack and rebuilt our case in their CFO\'s format',
  rationale: 'his own story turns on this and the current line hides it',
  evidence_refs: ['case-northwind-2018', 'deliv-tight-five-v4'],
  challenge_asked: 'a founder will ask what you actually did in there',
} ] });
const l2 = db.prepare('SELECT * FROM cv_lines WHERE line_no = 2').get();
ok(l2.proposed_text?.includes('Slack'), 'a proposal with evidence is accepted');
ok(JSON.parse(l2.evidence_refs_json).length === 2, 'the evidence is recorded with it');
ok(l2.challenge_asked?.includes('founder'), 'the defend-it challenge is recorded');

// ---- 3. his ruling is what makes a line final -----------------------------
console.log('\nhis ruling');
save({ cv_lines: [{ line_no: 2, current_text: 'Managed key accounts across EMEA',
  bill_ruling: 'amended', final_text: 'Lived in Northwind\'s Slack and rewrote our case in their CFO\'s own format',
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
const gateTool = { name: 'mcp__bill-coach__review_draft', input: {} };
function savedArtifactTool(kind, body, {
  id = `save-${kind}`, title = 'Bill document', error = false, conflict = false, omitResult = false,
} = {}) {
  return {
    id,
    omitResult,
    name: 'mcp__bill-coach__save_coaching_state',
    input: { deliverables: [{ kind, title, body }] },
    result: error
      ? { content: JSON.stringify({ error: 'fixture write failed' }), is_error: true }
      : conflict
        ? { content: JSON.stringify({
          session_id: 'sess-cv', session_version: 100, changed: {},
          conflicts: [{ type: 'session_version', expected: 98, actual: 99 }],
        }) }
      : { content: JSON.stringify({
        session_id: 'sess-cv', session_version: 99,
        changed: { deliverables: ['deliv-fixture'] }, conflicts: [],
      }) },
  };
}
function pushTool(lines, tool, fallbackId) {
  const id = tool.id ?? fallbackId;
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{
    type: 'tool_use', id, name: tool.name, input: tool.input ?? {},
  }] } }));
  if (tool.omitResult) return;
  const result = tool.result ?? { content: 'ok' };
  lines.push(JSON.stringify({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: id, content: result.content,
    ...(result.is_error ? { is_error: true } : {}),
  }] } }));
}
function transcript(ask, reply, tools = [gateTool]) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  for (const [i, tool] of tools.entries()) {
    pushTool(lines, tool, `tool-${i}`);
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
  const f = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}
function retryTranscript(ask, failedReply, retryReason, correctedReply) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  pushTool(lines, gateTool, 'old');
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: failedReply }] } }));
  lines.push(JSON.stringify({ type: 'user', message: { content: `<bill-coach-gate-retry>\n${retryReason}` } }));
  pushTool(lines, gateTool, 'new');
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: correctedReply }] } }));
  const f = path.join(dir, `t${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
}
function narratedTranscript(ask, narration, reply) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: narration }] } }));
  pushTool(lines, gateTool, 'narrated');
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
ok(/current_text/.test(r.reason ?? '') && /challenge_asked/.test(r.reason ?? ''),
  'the repair requires the supplied line and sceptical-reader challenge to be recorded');
ok(/deliverables/.test(r.reason ?? '') && /retires/.test(r.reason ?? '') && /review_draft/.test(r.reason ?? ''),
  'the corrected whole document must replace the refused version and pass the gate');
ok(/review_draft FIRST[\s\S]*save that exact corrected artifact/.test(r.reason ?? ''),
  'the repair order is review first, exact artifact save second, print last');
ok(!/did not save it/.test(r.reason ?? ''),
  'the generic persistence guard never tells Coach to save the refused whole document');

// A ruling belongs to the exact source line and proposal Bill saw. Additive work on that
// unchanged pass may retain it, but a materially revised pass must reopen the line and the
// whole-document gate must observe that reopening.
console.log('\nmaterial revisions reopen rulings');
save({ cv_lines: [
  { line_no: 1, current_text: 'Built and led a team of 6 SDRs', bill_ruling: 'amended',
    final_text: 'Built the SDR function from nothing: four permanent, two contract',
    challenge_asked: 'Were all six permanent, and what did you build rather than inherit?' },
  { line_no: 3, current_text: 'Results-driven sales leader', bill_ruling: 'rejected',
    challenge_asked: 'What result would a sceptical founder be able to verify?' },
  { line_no: 4, current_text: 'Owned launch operations across the portfolio',
    proposed_text: 'Ran launch operations across a portfolio of events',
    rationale: 'Uses the concrete work instead of an ownership abstraction',
    evidence_refs: ['deliv-launch-story-v1'],
    challenge_asked: 'Which launches, and what changed because you ran them?',
    challenge_answer: 'The US-timed launches ran from London without missing a handoff.',
    bill_ruling: 'accepted', final_text: 'Ran launch operations across a portfolio of events' },
] });

save({ cv_lines: [{
  line_no: 4, current_text: 'Owned launch operations across the portfolio',
  challenge_answer: 'I ran the operating rhythm and fixed the handoffs across time zones.',
}] });
let revised = db.prepare('SELECT * FROM cv_lines WHERE surface = ? AND line_no = 4').get('cv');
ok(revised.bill_ruling === 'accepted'
  && revised.final_text === 'Ran launch operations across a portfolio of events'
  && revised.challenge_answer.includes('time zones'),
  'an additive challenge update on the unchanged line and proposal preserves Bill\'s ruling');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('cv', wholeCv)]));
ok(r.decision !== 'block',
  'the fully ruled ledger releases a successfully reviewed and saved whole CV before revision');

save({ cv_lines: [{
  line_no: 4, current_text: 'Oversaw several launches for the events portfolio',
  proposed_text: 'Ran five US-timed launches from London without a missed handoff',
  rationale: 'The newly supplied source and evidence make the claim specific',
  evidence_refs: ['deliv-launch-story-v2'],
  challenge_asked: 'Can Bill defend the number five and the no-missed-handoff claim?',
}] });
revised = db.prepare('SELECT * FROM cv_lines WHERE surface = ? AND line_no = 4').get('cv');
ok(revised.current_text.includes('Oversaw several launches')
  && revised.proposed_text.includes('five US-timed launches')
  && revised.bill_ruling === null && revised.final_text === null,
  'a materially changed current line and proposal without a new ruling reopens the pass');
r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('cv', wholeCv)]));
ok(r.decision === 'block' && /no ruling from Bill/.test(r.reason ?? ''),
  'the whole-document gate blocks after a material revision reopens a previously accepted line');

// Restore the deliberately incomplete three-line ledger used by the remaining gate cases.
db.exec('DELETE FROM cv_lines');
save({ cv_lines: [
  { line_no: 1, section: 'Experience', current_text: 'Built and led a team of 6 SDRs' },
  { line_no: 2, section: 'Experience', current_text: 'Managed key accounts across EMEA',
    proposed_text: 'Got inside Northwind\'s own Slack and rebuilt our case in their CFO\'s format',
    rationale: 'his own story turns on this and the current line hides it',
    evidence_refs: ['case-northwind-2018', 'deliv-tight-five-v4'],
    challenge_asked: 'a founder will ask what you actually did in there',
    challenge_answer: 'I rebuilt the numbers in his format so he could lift it into his board pack',
    bill_ruling: 'amended',
    final_text: 'Lived in Northwind\'s Slack and rewrote our case in their CFO\'s own format' },
  { line_no: 3, section: 'Summary', current_text: 'Results-driven sales leader' },
] });

r = stop(retryTranscript('Tune my CV for the core full-time lane.',
  'I can help with that.', 'The previous reply was held; repair it.', wholeCv));
ok(r.decision === 'block' && /no ruling from Bill/.test(r.reason ?? ''),
  'a tagged gate retry keeps Bill\'s original CV ask active');

r = stop(retryTranscript('Tune my CV for the core full-time lane.',
  wholeCv, 'The previous reply was held; repair it.',
  'Line one says "Built and led a team of 6 SDRs". How many were permanent, and what did you personally build?'));
ok(!/no ruling from Bill/.test(r.reason ?? '') && !/did not save it/.test(r.reason ?? ''),
  'a tagged retry reads only the corrected reply, never the refused whole document behind it');

r = stop(narratedTranscript('Tune my CV for the core full-time lane.', "I'll pull up your CV first.", wholeCv));
ok(/opened by narrating/.test(r.reason ?? '') && /no ruling from Bill/.test(r.reason ?? ''),
  'an opening narration hold accumulates with the substantive CV hold');

r = stop(transcript('Tune my CV.', 'Line two says "managed key accounts across EMEA". What did you actually do on the biggest one?'));
ok(!/no ruling from Bill/.test(r.reason ?? ''), 'working on a single line is never blocked');

save({ cv_lines: [
  { line_no: 1, current_text: 'Built and led a team of 6 SDRs', bill_ruling: 'amended', final_text: 'Built the SDR function from nothing: four permanent, two contract' },
  { line_no: 3, current_text: 'Results-driven sales leader', bill_ruling: 'rejected' },
] });
r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('cv', wholeCv)]));
ok(/do not carry both current_text and challenge_asked/.test(r.reason ?? ''),
  'rulings alone do not pass when their challenges were never recorded');

save({ cv_lines: [
  { line_no: 1, current_text: 'Built and led a team of 6 SDRs', challenge_asked: 'Were all six permanent, and what did you build rather than inherit?' },
  { line_no: 3, current_text: 'Results-driven sales leader', challenge_asked: 'What result would a sceptical founder be able to verify?' },
] });
const differentCv = wholeCv.replace('Seasoned commercial leader', 'Invented commercial operator');
r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('cv', differentCv)]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a successful save of a different same-kind draft does not persist the presented CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('linkedin', wholeCv)]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a successful save under the wrong deliverable kind does not persist the CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool,
  savedArtifactTool('cv', wholeCv, { id: 'save-error', error: true })]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a matching save tool_use whose tool_result is an error does not persist the CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool,
  savedArtifactTool('cv', wholeCv, { id: 'save-no-result', omitResult: true })]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a save tool_use with no matching tool_result does not persist the CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool,
  savedArtifactTool('cv', wholeCv, { id: 'save-conflict', conflict: true })]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a non-error optimistic-version conflict that changed nothing does not persist the CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool,
  savedArtifactTool('cv', wholeCv.slice(0, Math.floor(wholeCv.length * 0.6)), { id: 'save-partial' })]));
ok(/no successful matching save/.test(r.reason ?? ''),
  'a substantial-looking but partial saved body does not persist the whole CV');

r = stop(transcript('Tune my CV.', wholeCv, [gateTool, savedArtifactTool('cv', wholeCv)]));
ok(r.decision !== 'block',
  'with every line ruled and challenged, an exact successful CV save releases the document');

r = stop(transcript('Tune my CV.', `Here is the corrected CV.\n\n${wholeCv}`,
  [gateTool, savedArtifactTool('cv', wholeCv)]));
ok(r.decision !== 'block',
  'a short handoff around the exact successfully saved artifact is allowed');

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
  { line_no: 1, surface: 'headline', current_text: 'Sales Leader | Revenue Growth | SaaS', bill_ruling: 'accepted', challenge_asked: 'What would make this headline distinctively yours?' },
  { line_no: 2, surface: 'about', current_text: 'Results-driven leader with a passion for growth', bill_ruling: 'amended', final_text: 'I build the function, not just the number.', challenge_asked: 'Which result proves you build the function?' },
] });
r = stop(transcript('Rewrite my LinkedIn.', wholeProfile,
  [gateTool, savedArtifactTool('linkedin', wholeProfile, { id: 'save-linkedin', title: 'Bill LinkedIn' })]));
ok(r.decision !== 'block',
  'with the profile lines ruled and challenged, an exact successful LinkedIn save releases it');

r = stop(transcript('Tune my CV.', wholeCv));
ok(r.decision === 'block' && /CV/.test(r.reason ?? '') && !/LinkedIn/.test(r.reason ?? ''),
  'the unruled CV line still blocks the CV, so the two surfaces do not mask each other');

fs.rmSync(dir, { recursive: true, force: true });
db.close();
console.log(fails ? `\nCV MODULE TESTS FAILED: ${fails}` : '\nCV MODULE TESTS PASSED');
process.exit(fails ? 1 : 0);
