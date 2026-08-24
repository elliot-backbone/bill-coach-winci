#!/usr/bin/env node
// Module-engine wrong-case suite (Design V2 §3.3): >=2 independent wrong cases
// per contract clause, fail-closed absences, budget trim behavior, gate truth,
// and the hook pre-pass. Runs on scratch copies; never touches the package.
// Usage: node engines-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG = path.resolve(process.argv[2] ?? '.');
let fails = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) { fails += 1; if (d) console.log(`       ${String(d).slice(0, 240)}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-engines-'));
const statePath = path.join(dir, 'coach.sqlite');
fs.copyFileSync(path.join(PKG, 'state-template', 'coach.sqlite'), statePath);
const state = new DatabaseSync(statePath); state.exec('PRAGMA busy_timeout=5000');
const library = new DatabaseSync(path.join(PKG, 'library', 'library.sqlite'), { readOnly: true });
const eng = (n) => import(pathToFileURL(path.join(PKG, 'plugin', 'runtime', 'engines', n)).href);
const { prepareOfferReview } = await eng('offer-review.mjs');
const { prepareWeeklyCatchup } = await eng('weekly-catchup.mjs');
const { prepareDebriefReview } = await eng('debrief-review.mjs');
const { checkGates, scaffold } = await eng('shared.mjs');

const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const role = state.prepare(`SELECT id, company FROM roles LIMIT 1`).get();

console.log('== offer_review ==');
// Floor-relative bases: the scrubbed public template carries a SYNTHETIC floor,
// the private one carries the real one — the tests must hold on both.
const floorRow = JSON.parse(state.prepare(`SELECT value_json FROM settings WHERE key = 'comp_floor'`).get().value_json);
const FLOOR = floorRow.amount;
state.prepare(`INSERT INTO offers (id, role_id, received_at, terms_json, status, created_at, updated_at)
               VALUES ('off-1', ?, ?, ?, 'reviewing', ?, ?)`)
  .run(role.id, daysAgo(2), JSON.stringify({ base: FLOOR - 5000, equity_pct: 0.4 }), now, now);
let o = prepareOfferReview(state, library, { role_id: role.id });
ok(o.computed.floor_check?.value?.breach === true, 'wrong case 1: base below floor flags breach');
ok(o.judgment_points.some((j) => j.id === 'movable-vs-wall'), 'movable-vs-wall is a judgment point, never computed');
state.prepare(`INSERT INTO offers (id, role_id, received_at, terms_json, status, created_at, updated_at)
               VALUES ('off-2', ?, ?, ?, 'negotiating', ?, ?)`)
  .run(role.id, daysAgo(1), JSON.stringify({ base: FLOOR + 2000, equity_pct: 0.5 }), now, now);
o = prepareOfferReview(state, library, { role_id: role.id });
ok(o.data.offers.length === 2 && o.data.offers[0].id === 'off-1', 'wrong case 2: a counter is a NEW row; the first offer survives, received_at ordered');
ok(o.computed.floor_check?.value?.breach === false, 'wrong case 3: base above floor does not flag');
ok(prepareOfferReview(state, library, { role_id: 'role-none' }).gates.blocked === true, 'wrong case 4: unknown role blocks, never fabricates');
// floor absent => judgment point, never a default (fresh copy without the row)
const bare = path.join(dir, 'bare.sqlite');
fs.copyFileSync(path.join(PKG, 'state-template', 'coach.sqlite'), bare);
const stateBare = new DatabaseSync(bare); stateBare.exec('PRAGMA busy_timeout=5000');
stateBare.prepare(`DELETE FROM settings WHERE key = 'comp_floor'`).run();
const ob = prepareOfferReview(stateBare, library, { role_id: role.id });
ok(!ob.computed.floor_check && ob.judgment_points.some((j) => j.id === 'floor-unconfirmed')
   && ob.absences.some((a) => a.what === 'comp floor'), 'wrong case 5: missing floor is an absence + judgment point, never an assumed 60k');
stateBare.close();

console.log('== weekly_catchup ==');
let w = prepareWeeklyCatchup(state, library, { since: daysAgo(7) });
ok(!w.data.stall_candidates.length || w.judgment_points.some((j) => j.id === 'stalls'), 'stall labels only ever appear as candidates');
state.prepare(`UPDATE roles SET phase = 'P2', last_touch_at = ? WHERE id = ?`).run(daysAgo(1), role.id);
w = prepareWeeklyCatchup(state, library, { since: daysAgo(7) });
ok(!w.data.stall_candidates.some((s) => s.id === role.id), 'wrong case 1: a role touched yesterday never surfaces as a stall candidate');
state.prepare(`UPDATE roles SET last_touch_at = ? WHERE id = ?`).run(daysAgo(15), role.id);
w = prepareWeeklyCatchup(state, library, { since: daysAgo(7) });
ok(w.data.stall_candidates.some((s) => s.id === role.id), 'a 15-day-quiet P2 role IS proposed (as candidate)');
state.prepare(`INSERT INTO interactions (id, role_id, kind, occurred_at, participants_json, created_at, updated_at)
               VALUES ('int-out', ?, 'outreach', ?, '[]', ?, ?)`).run(role.id, daysAgo(6), now, now);
w = prepareWeeklyCatchup(state, library, { since: daysAgo(7) });
ok(w.data.nudge_candidates.some((n) => n.id === 'int-out')
   && w.judgment_points.find((j) => j.id === 'nudges')?.rule_reasoning?.includes('no subsequent recorded'),
  'wrong case 2: the nudge is a candidate naming the no-reply/not-recorded conflation');
const wEmpty = prepareWeeklyCatchup(state, library, { since: new Date(Date.now() + 86_400_000).toISOString() });
ok(wEmpty.computed.week_counts.value.moved === 0 && !wEmpty.data.moved.length, 'wrong case 3: an empty week renders honestly, nothing invented');

console.log('== debrief_review ==');
state.prepare(`INSERT INTO interactions (id, role_id, kind, round_number, occurred_at, participants_json, created_at, updated_at)
               VALUES ('int-d1', ?, 'interview', 2, ?, '[]', ?, ?)`).run(role.id, daysAgo(1), now, now);
for (const [i, slot] of ['what_was_asked', 'what_he_said'].entries()) {
  state.prepare(`INSERT INTO debrief_capture (id, role_id, interaction_id, slot, detail, created_at)
                 VALUES (?, ?, 'int-d1', ?, 'x', ?)`).run(`cap-${i}`, role.id, slot, now);
}
let d = prepareDebriefReview(state, library, { role_id: role.id, interaction_id: 'int-d1' });
ok(d.gates.blocked === true && d.computed.slot_status.value.empty.length === 5, 'wrong case 1: 5 empty slots blocks the document');
for (const [i, slot] of ['where_it_stalled', 'their_language', 'signals_read'].entries()) {
  state.prepare(`INSERT INTO debrief_capture (id, role_id, interaction_id, slot, detail, created_at)
                 VALUES (?, ?, 'int-d1', ?, 'y', ?)`).run(`cap2-${i}`, role.id, slot, now);
}
d = prepareDebriefReview(state, library, { role_id: role.id, interaction_id: 'int-d1' });
ok(d.gates.blocked === false, '2 empty slots unblocks');
ok(d.data.transcript_stats === null && d.absences.some((a) => a.what === 'transcript stats'), 'wrong case 2: no pre-pass stats = honest absence, never computed from nothing');
ok(prepareDebriefReview(state, library, { role_id: role.id, interaction_id: 'int-none' }).gates.blocked === true, 'unknown interaction blocks');

console.log('== hook pre-pass ==');
const plugin = path.join(dir, 'plugin');
fs.mkdirSync(path.join(plugin, 'state'), { recursive: true });
fs.cpSync(path.join(PKG, 'plugin'), plugin, { recursive: true });
// The test's inserts live in the WAL until checkpointed; copyFileSync copies
// only the main file. Without this, the fixture silently lacks every row the
// test created — measured: the pre-pass case failed on a missing int-d1.
state.exec('PRAGMA wal_checkpoint(TRUNCATE)');
fs.copyFileSync(statePath, path.join(plugin, 'state', 'coach.sqlite'));
// The hook's onboarding-checkpoint guard returns before the pre-pass on a fresh
// template DB — first failing run proved it, and proved the one-speaker case was
// passing for the wrong reason. Complete onboarding so the hook reaches the code
// under test, in BOTH fixture homes.
const completeOnboarding = (dbPath) => {
  const odb = new DatabaseSync(dbPath); odb.exec('PRAGMA busy_timeout=5000');
  odb.prepare(`UPDATE onboarding SET status = 'complete', updated_at = ? WHERE singleton = 1`).run(new Date().toISOString());
  odb.close();
};
completeOnboarding(path.join(plugin, 'state', 'coach.sqlite'));
const mkTurn = (transcriptText) => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: transcriptText } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__bill-coach__save_coaching_state', input: { debrief_capture: [{ interaction_id: 'int-d1', slot: 'what_was_asked', detail: 'z' }] } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Saved. The round read well and the follow-up goes out tonight.' }] } }),
  ];
  const f = path.join(dir, `turn-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.join('\n'));
  return f;
};
const twoSpeaker = Array.from({ length: 12 }, (_, i) => (i % 2 ? `[00:${String(i).padStart(2, '0')}] Bill: I think the number was forty per quarter, is that right?` : `[00:${String(i).padStart(2, '0')}] Asha: Walk me through the funnel you built at the last place.`)).join('\n');
const oneSpeaker = Array.from({ length: 12 }, (_, i) => `[00:${String(i).padStart(2, '0')}] Bill: line ${i}`).join('\n');
const runHook = (f) => spawnSync(process.execPath, [fs.realpathSync(path.join(plugin, 'runtime', 'lifecycle.mjs')), 'hook-stop', plugin], {
  input: JSON.stringify({ transcript_path: f }), env: { ...process.env, BILL_COACH_DATA_DIR: plugin }, encoding: 'utf8', timeout: 30_000,
});
const hookR = runHook(mkTurn(twoSpeaker));
if (hookR.status !== 0 || hookR.stderr) console.log('  ·    hook rc', hookR.status, 'stderr:', String(hookR.stderr).slice(0, 200));
const pdb = new DatabaseSync(path.join(plugin, 'state', 'coach.sqlite'), { readOnly: true });
const rev = JSON.parse(pdb.prepare(`SELECT review_json FROM interactions WHERE id = 'int-d1'`).get()?.review_json ?? '{}');
ok(rev.transcript_stats?.computed_by === 'hook-pre-pass' && Object.keys(rev.transcript_stats.speakers).length === 2,
  'pre-pass writes stats from a 2-speaker transcript', JSON.stringify(rev).slice(0, 160));
pdb.close();
const plugin2 = path.join(dir, 'plugin2');
fs.cpSync(path.join(PKG, 'plugin'), plugin2, { recursive: true });
fs.mkdirSync(path.join(plugin2, 'state'), { recursive: true });
fs.copyFileSync(path.join(PKG, 'state-template', 'coach.sqlite'), path.join(plugin2, 'state', 'coach.sqlite'));
const p2db = new DatabaseSync(path.join(plugin2, 'state', 'coach.sqlite')); p2db.exec('PRAGMA busy_timeout=5000');
p2db.prepare(`INSERT INTO interactions (id, role_id, kind, occurred_at, participants_json, created_at, updated_at)
              VALUES ('int-d1', ?, 'interview', ?, '[]', ?, ?)`).run(role.id, daysAgo(1), now, now);
p2db.close();
completeOnboarding(path.join(plugin2, 'state', 'coach.sqlite'));
spawnSync(process.execPath, [fs.realpathSync(path.join(plugin2, 'runtime', 'lifecycle.mjs')), 'hook-stop', plugin2], {
  input: JSON.stringify({ transcript_path: mkTurn(oneSpeaker) }), env: { ...process.env, BILL_COACH_DATA_DIR: plugin2 }, encoding: 'utf8', timeout: 30_000,
});
const p2check = new DatabaseSync(path.join(plugin2, 'state', 'coach.sqlite'), { readOnly: true });
const rev2 = JSON.parse(p2check.prepare(`SELECT review_json FROM interactions WHERE id = 'int-d1'`).get()?.review_json ?? '{}');
ok(!rev2.transcript_stats, 'wrong case: a one-speaker transcript writes NO stats (fail closed)');
p2check.close();

console.log('== gates + budget ==');
const g0 = checkGates(state, 'positioning_one_pager');
ok(g0.blocked === true, '6-or-fewer coverage slots blocks the one-pager');
const SLOTS = ['childhood', 'family_and_money', 'schooling', 'first_work', 'professional_sequence', 'cost_and_doubt', 'turning_point', 'present_want'];
for (const [i, s] of SLOTS.entries()) {
  state.prepare(`INSERT OR REPLACE INTO narrative_coverage (id, slot, scene, age_or_date, created_at) VALUES (?, ?, 's', '1994', ?)`)
    .run(`nc-${i}`, s, now);
}
ok(checkGates(state, 'positioning_one_pager').blocked === false, '8/8 dated slots unblocks');
ok(checkGates(state, 'outreach').blocked === true, 'outreach still blocked without a live one-pager (two independent conditions)');
const big = scaffold('debrief_review', {}, {
  data: { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'x'.repeat(60) })) },
  computed: {}, gates: { blocked: false, missing: [], facts: [] }, judgment_points: [], absences: [],
});
ok(big.budget.used > big.budget.limit ? big.data.rows.length === 4 && big.absences.some((a) => a.why_missing === 'scaffold budget') : false,
  'over-budget scaffold trims to 4 rows and RECORDS the trim as an absence');

state.close(); library.close();
console.log(fails === 0 ? 'ENGINE TESTS PASSED' : `ENGINE TESTS FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
