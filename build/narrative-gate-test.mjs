// The tight-five coverage gate, the green flag library, and the response-shape rules.
//
// Regression: a shallow run mined the opening work anecdote and drafted story one by turn two
// without asking about childhood. The long-form biographical method already said "do NOT open
// at his career", but it lost to the first sentence in the chat. This fixture proves the guard
// without carrying a principal's real anecdote or interview record.
//
// Usage: node narrative-gate-test.mjs <package> <installed-home>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const PKG = process.argv[2];
const HOME = process.argv[3];
const DATA = path.join(HOME, '.claude-bill-career-coach', 'plugins', 'data', 'bill-career-coach-skills-dir');
const PLUGIN = path.join(PKG, 'plugin');
let fails = 0;
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) fails += 1; };

// Reset the state this test asserts on. Without it a second run sees the coverage and the
// ranks left by the first, and three assertions pass or fail depending on run order.
{
  const d = new DatabaseSync(path.join(DATA, 'state', 'coach.sqlite'));
  d.exec('PRAGMA busy_timeout = 10000');
  d.exec('DELETE FROM narrative_coverage');
  d.exec('UPDATE green_flags SET current_rank = base_rank, times_surfaced = 0, times_landed = 0, rank_reason = NULL');
  d.close();
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narr-'));
const DRAFT = 'I grew up around it. I was eleven when I first went. I remember the noise of it. '
  + 'I did that for ten years. I learned what it costs. I would not change it. '.repeat(12);

// Tool results come back as `user` entries. A fixture that omits them is not the shape the
// client writes, and it is what let a blind reader pass every one of these assertions.
function transcript(ask, reply, tools = []) {
  const lines = [JSON.stringify({ type: 'user', message: { content: ask } })];
  for (const n of tools) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: n, input: {} }] } }));
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
    env: { ...process.env, BILL_COACH_DATA_DIR: DATA }, encoding: 'utf8',
  });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}
const GATE = 'mcp__bill-coach__review_draft';

// The unclosed-work guard is LIVE since 1.13.2 (it was dead code before — a
// use-after-close threw on every invocation). These fixtures exercise the
// NARRATIVE guards over a home whose earlier suites moved the funnel, so satisfy
// the learning rule up front rather than letting an unrelated guard block.
{
  const seedDb = new DatabaseSync(path.join(DATA, 'state', 'coach.sqlite'));
  seedDb.exec('PRAGMA busy_timeout = 10000');
  const now = new Date().toISOString();
  seedDb.prepare(`INSERT OR REPLACE INTO learnings (id, category, learning, evidence, source_kind, source_id, fed_into_json, occurred_at, created_at)
                  VALUES ('learn-narr-fixture', 'process', 'fixture learning satisfying the unclosed-work guard', 'fixture', 'session', 'sess-fixture', '[]', ?, ?)`)
    .run(now, now);
  seedDb.close();
}

// ---- 1. the gate ----------------------------------------------------------
console.log('the coverage gate');
let r = stop(transcript('Do the tight five.', DRAFT, [GATE]));
ok(r.decision === 'block' && /before the interview has happened/.test(r.reason ?? ''),
  'drafting a narrative with no coverage on file is blocked');
ok(/childhood/.test(r.reason ?? '') && /8 slots/.test(r.reason ?? ''),
  'the block names the missing slots and the bar');

r = stop(transcript('Do the tight five.', 'Where did you grow up, and what did your dad do?', [GATE]));
ok(r.decision !== 'block', 'asking questions is never blocked, however thin the coverage');

r = stop(transcript('Write my CV.', DRAFT, [GATE]));
ok(r.decision !== 'block' || !/before the interview has happened/.test(r.reason ?? ''),
  'the narrative gate does not fire on other modules');

// ---- 2. coverage counts only when dated -----------------------------------
console.log('\ncoverage accounting');
const db = new DatabaseSync(path.join(DATA, 'state', 'coach.sqlite'));
db.exec('PRAGMA busy_timeout = 10000');
db.exec('DELETE FROM narrative_coverage');
const { saveCoachingState } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'memory.mjs')).href);
const sid = db.prepare("SELECT id, version FROM sessions WHERE status='active' ORDER BY updated_at DESC LIMIT 1").get()
  ?? (() => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
                VALUES ('sess-narr',?,?,'active','[]','[]',1)`).run(now, now);
    return { id: 'sess-narr', version: 1 };
  })();
const save = (rows) => saveCoachingState(db, {
  session_id: sid.id,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid.id).version,
  narrative_coverage: rows,
});

save([{ slot: 'childhood', scene: 'Grew up in the shadow of the ground', age_or_date: null }]);
r = stop(transcript('Do the tight five.', DRAFT, [GATE]));
ok(r.decision === 'block' && /childhood/.test(r.reason ?? ''),
  'an undated scene does not count toward coverage');

const SLOTS = ['childhood', 'family_and_money', 'schooling', 'first_work',
  'professional_sequence', 'cost_and_doubt', 'turning_point', 'present_want'];
save(SLOTS.map((s) => ({ slot: s, scene: `a scene for ${s}`, age_or_date: '1994', named_detail: 'Barnsley' })));
r = stop(transcript('Do the tight five.', DRAFT, [GATE]));
ok(r.decision !== 'block', 'with all eight slots dated, drafting is allowed');

const bad = saveCoachingState(db, {
  session_id: sid.id,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid.id).version,
  narrative_coverage: [{ slot: 'childhood', scene: '   ' }],
});
ok((bad.conflicts || []).some((c) => c.table === 'narrative_coverage'), 'an empty scene is refused and reported');

// ---- 3. the flag library --------------------------------------------------
console.log('\nthe green flag library');
const flags = db.prepare('SELECT * FROM green_flags ORDER BY current_rank').all();
ok(flags.length >= 12, `the library ships populated (${flags.length} flags)`);
ok(flags.filter((f) => f.polarity === 'green').length >= 9, 'at least nine green flags');
ok(flags.filter((f) => f.polarity === 'red').length >= 3, 'the red flags ship too');
ok(new Set(flags.map((f) => f.dimension)).size >= 6, 'balanced across dimensions, not four repeated');
ok(flags.every((f) => f.behaviour && f.evidence && f.question), 'every flag carries a behaviour, its evidence and the question that surfaces it');
ok(flags.some((f) => /adviser guide/i.test(f.source)) && flags.some((f) => /corpus/i.test(f.source)),
  'flags are sourced from both the adviser guide and the reading corpus');

const before = db.prepare("SELECT current_rank FROM green_flags WHERE name='makes_others_good'").get().current_rank;
saveCoachingState(db, {
  session_id: sid.id,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid.id).version,
  green_flags: [{ name: 'makes_others_good', current_rank: 1, surfaced: true, landed: true, rank_reason: 'synthetic early-stage commercial lead search' }],
});
const after = db.prepare("SELECT * FROM green_flags WHERE name='makes_others_good'").get();
ok(after.current_rank === 1 && before !== 1, 'a flag can be re-ranked for the conversation in hand');
ok(after.times_surfaced === 1 && after.times_landed === 1, 'surfacing and landing are counted');
ok(after.rank_reason === 'synthetic early-stage commercial lead search', 'the supplied reason for the rank is recorded exactly');

const unknown = saveCoachingState(db, {
  session_id: sid.id,
  expected_session_version: db.prepare('SELECT version FROM sessions WHERE id=?').get(sid.id).version,
  green_flags: [{ name: 'invented_flag', current_rank: 1 }],
});
ok((unknown.conflicts || []).some((c) => c.table === 'green_flags'),
  'a session cannot invent a flag; the library is doctrine');

// ---- 4. orientation carries both ------------------------------------------
console.log('\norientation');
const ctxMod = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'context.mjs')).href);
const lib = new DatabaseSync(path.join(DATA, 'library', 'library.sqlite'), { readOnly: true });
const ctx = ctxMod.getContext(db, lib, { session_id: sid.id, question: 'tight five' });
ok((ctx.green_flags ?? []).length >= 12, 'start_coach carries the ranked flag library');
ok(ctx.green_flags[0].current_rank <= ctx.green_flags[1].current_rank, 'carried in rank order');
ok(ctx.narrative_coverage && ctx.narrative_coverage.slots_total === 8, 'start_coach carries the coverage count');
ok(ctx.narrative_coverage.ready_to_draft === true, 'and says plainly whether drafting is allowed');
lib.close(); db.close();

// ---- 5. response shape ----------------------------------------------------
console.log('\nresponse shape');
const { checkReply } = await import(pathToFileURL(path.join(PLUGIN, 'runtime', 'style.mjs')).href);
const hits = (t, id) => checkReply(t).some((v) => v.rule_id === id);
const filler = 'The pipeline has moved since last week and the shape of it matters here. '.repeat(20);
ok(hits(`Option A: go back with a number. Option B: hold.\n${filler}`, 'AW-027'), 'a labelled options menu is blocked');
ok(hits(`There are three options here worth weighing.\n${filler}`, 'AW-027'), 'offering three routes is blocked');
ok(hits(`You could either go back on base or push on equity.\n${filler}`, 'AW-027'), 'either/or framing is blocked');
ok(hits(`Which would you prefer, the first or the second?\n${filler}`, 'AW-027'), 'handing him the choice is blocked');
ok(!hits(`Go back on base at seventy-eight. The case against that is real, and here it is.\n${filler}`, 'AW-027'),
  'one recommendation, argued against itself, passes');
ok(!checkReply(filler).some((v) => v.rule_id === 'AW-028'), 'the withdrawn buried-ask rule no longer fires');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\nNARRATIVE GATE TESTS FAILED: ${fails}` : '\nNARRATIVE GATE TESTS PASSED');
process.exit(fails ? 1 : 0);
