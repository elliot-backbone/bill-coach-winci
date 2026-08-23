// Negotiation, content, and the two derivative modules.
//
// MEASURED 2026-08-22:
//   · the negotiation plan was the strongest artefact the product produced, 15,110 characters
//     with exact words for each branch, and not one line of it was ever practised.
//   · the content module asked SIX questions, fewer than any other, then wrote three posts —
//     for the one module whose entire input is what Bill thinks. He had already said he hates
//     the idea of posting.
//   · the one-pager and outreach produced finished artefacts on a profile where the tight five
//     had two of eight slots covered. They inherited the thinness and presented it as finished.
//
// Usage: node downstream-modules-test.mjs <package> <installed-home>

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
for (const t of ['positions_held', 'rehearsal_rounds', 'narrative_coverage']) db.exec(`DELETE FROM ${t}`);
db.exec("DELETE FROM deliverables WHERE kind IN ('negotiation_plan','positioning_one_pager')");

const { saveCoachingState } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'memory.mjs')).href);
let sid = db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1").get()?.id;
if (!sid) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
              VALUES ('sess-down',?,?,'active','[]','[]',1)`).run(now, now);
  sid = 'sess-down';
}
const save = (payload) => saveCoachingState(db, {
  session_id: sid,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid).version,
  ...payload,
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'down-'));
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
const longReply = `Here it is. ${'This is the shape of it and what I would do about it now. '.repeat(22)}`;

// ---- negotiation -----------------------------------------------------------
console.log('negotiation');
save({ deliverables: [{ kind: 'negotiation_plan', title: 'Northwind counter', body: 'Open at 78. If they hold, ask for the review at six months.' }] });
let r = stop(transcript('How do I go back on the Northwind offer?', longReply));
ok(r.decision === 'block' && /has been rehearsed/.test(r.reason ?? ''),
  'a written plan that has never been practised blocks the module winding up');
ok(/number on the table/.test(r.reason ?? ''), 'and it says why reading the words is not the same thing');

save({ rehearsal_rounds: [{ topic: 'the counter', question: 'They say 72 is the ceiling. What do you say?',
  source: 'negotiation', his_answer: 'I would say I understand', verdict: 'holding' }] });
r = stop(transcript('How do I go back on the Northwind offer?', longReply));
ok(!/has been rehearsed/.test(r.reason ?? ''), 'once a branch is rehearsed, the module may close');

// ---- content ---------------------------------------------------------------
console.log('\ncontent');
r = stop(transcript('Write me some LinkedIn posts.', longReply));
ok(r.decision === 'block' && /position/.test(r.reason ?? ''),
  'posts drafted with no position on file are blocked');
ok(/status update/.test(r.reason ?? ''), 'and it defines what a real position is');

const noEvidence = save({ positions_held: [{ position: 'Selling is about listening', evidence: '' }] });
ok((noEvidence.conflicts || []).some((c) => c.table === 'positions_held'),
  'a position with no evidence is refused: a slogan is not a position');

save({ positions_held: [{
  position: 'Most first sales hires fail because the founder never actually stopped selling',
  evidence: 'watched it happen at three companies he sold into, and did it himself at Checker',
  who_disagrees: 'founders who think the problem was the hire',
  public_ok: false,
}] });
r = stop(transcript('Write me some LinkedIn posts.', longReply));
ok(r.decision === 'block' && /never publishes/.test(r.reason ?? ''),
  'a position he will not put his name to does not unlock drafting');

save({ positions_held: [{
  position: 'Most first sales hires fail because the founder never actually stopped selling',
  evidence: 'watched it happen at three companies he sold into, and did it himself at Checker',
  public_ok: true,
}] });
r = stop(transcript('Write me some LinkedIn posts.', longReply));
ok(!/status update/.test(r.reason ?? ''), 'with a position he will stand behind, drafting is allowed');

// ---- the derivative modules ------------------------------------------------
console.log('\nderivatives');
r = stop(transcript('I need a one-pager I can send to an intro.', longReply));
ok(r.decision === 'block' && /8 slots covered/.test(r.reason ?? ''),
  'the one-pager is blocked while the tight five is incomplete');
ok(/offer to carry on with it now/.test(r.reason ?? ''), 'and the block is an agenda, not a refusal');

const SLOTS = ['childhood', 'family_and_money', 'schooling', 'first_work',
  'professional_sequence', 'cost_and_doubt', 'turning_point', 'present_want'];
save({ narrative_coverage: SLOTS.map((s) => ({ slot: s, scene: `a scene for ${s}`, age_or_date: '1994' })) });
r = stop(transcript('I need a one-pager I can send to an intro.', longReply));
ok(!/8 slots covered/.test(r.reason ?? ''), 'with the interview complete, the one-pager may be written');

r = stop(transcript('I want to reach out cold to a few of them.', longReply));
ok(r.decision === 'block' && /no positioning one-pager/.test(r.reason ?? ''),
  'outreach is blocked while no one-pager is live');

save({ deliverables: [{ kind: 'positioning_one_pager', title: 'What Bill is for', body: 'The finished page.' }] });
r = stop(transcript('I want to reach out cold to a few of them.', longReply));
ok(!/no positioning one-pager/.test(r.reason ?? ''), 'with the one-pager live, outreach may be written');

fs.rmSync(dir, { recursive: true, force: true });
db.close();
console.log(fails ? `\nDOWNSTREAM MODULE TESTS FAILED: ${fails}` : '\nDOWNSTREAM MODULE TESTS PASSED');
process.exit(fails ? 1 : 0);
