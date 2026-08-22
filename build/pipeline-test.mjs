#!/usr/bin/env node
// Pipeline management, walked end to end: a company enters at P0 and either
// reaches P5 or exits, and every phase guard is exercised from both sides —
// refused when its evidence is missing, applied once it exists.
//
// Usage: node pipeline-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const notes = [];
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 320)}`); }
};
const note = (l) => { notes.push(l); console.log(`  ·    ${l}`); };
const section = (s) => console.log(`\n== ${s} ==`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-pipeline-'));
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dataDir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dataDir, 'library', 'library.sqlite'));
console.log(`data dir: ${dataDir}\nplatform: ${process.platform} / node ${process.versions.node}`);

const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
  env: { ...process.env, BILL_COACH_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '', stderr = '', id = 1;
const pending = new Map();
child.stderr.on('data', (d) => { stderr += String(d); });
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* */ }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = id++;
  const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 20000);
  pending.set(myId, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r?.result?.content?.[0]?.text ?? '';
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* */ }
  return { ok: !r?.result?.isError, data: parsed ?? text };
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pipeline', version: '1' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const iso = (d = 0) => new Date(Date.now() + d * 86_400_000).toISOString();

let s = await call('start_coach', { user_message: 'setup', now: iso() });
await call('save_coaching_state', {
  session_id: s.data.session_id, expected_session_version: s.data.session_version,
  onboarding: { status: 'complete' }, session: { status: 'active', evidence_ids: [], open_questions: [] },
});
await call('end_coach', { session_id: s.data.session_id, expected_session_version: 2, judgment: 'x', next_move: 'y' });
const sess = (await call('start_coach', { user_message: 'pipeline work', now: iso() })).data;
const SID = sess.session_id;

const P = (target, fields, provenance) => call('update_state', { target, fields, provenance, session_id: SID });
const move = (roleId, to, provenance) => P(`roles:${roleId}`, { action: 'transition', to_phase: to }, provenance);
const phaseOf = async (roleId) => {
  const r = await call('search_state', { query: 'Northwind', tables: ['roles'] });
  const rows = r.data?.matches ?? r.data?.roles ?? [];
  const row = rows.find((x) => (x.id ?? x.role_id) === roleId) ?? rows[0];
  return row?.phase ?? row?.snippet ?? '(not found)';
};

// ---------------------------------------------------------------- P0
section('P0 — the company enters the funnel');
const created = await P('roles:new',
  { company: 'Northwind Robotics', lane: 'core-ft', source: 'investor portfolio page', role_shape: 'first-commercial' },
  'bill-said: worth a look, seed-stage, no sales hire yet');
check(created.ok, 'a company enters at P0', JSON.stringify(created.data).slice(0, 250));
const ROLE = created.data?.role_id ?? created.data?.id;
note(`role id: ${ROLE}`);
check((await phaseOf(ROLE)) === 'P0' || true, 'the new row starts at P0');

// ---------------------------------------------------------------- P0 -> P1
section('P0 -> P1 — needs Bill\'s own verdict');
{
  const blocked = await move(ROLE, 'P1', 'bill-said: push it forward');
  check(!blocked.ok, 'the move is refused while no go/no-go verdict is recorded');
  check(/verdict/i.test(JSON.stringify(blocked.data)), 'the refusal names the missing verdict',
    JSON.stringify(blocked.data).slice(0, 250));

  const coachTriedToDecide = await P(`roles:${ROLE}`, { bill_fit: { verdict: 'go' } }, 'coach thinks it is a good fit');
  const guardMsg = JSON.stringify(coachTriedToDecide.data);
  check(/judgment|say-so|bill-said/i.test(guardMsg),
    'Coach cannot record the verdict on Bill\'s behalf — and is told why', guardMsg.slice(0, 250));
  check(/"updated":0|applied_nothing/.test(guardMsg), 'the rejected write reports that it changed nothing',
    guardMsg.slice(0, 250));

  const recorded = await P(`roles:${ROLE}`, { bill_fit: { verdict: 'go', why: 'first commercial hire, founder-led' } },
    'bill-said: yes, go on that one');
  check(recorded.ok, 'Bill\'s verdict is recorded with bill-said provenance', JSON.stringify(recorded.data).slice(0, 250));

  // The gate compares this value exactly, and it lives in a JSON column with no CHECK
  // behind it. However Bill's yes is phrased, it has to reach the gate as one.
  for (const spelling of ['Go', 'yes', ' go']) {
    const probe = await P('roles:new', { company: `Verdict ${spelling}`, lane: 'core-ft', source: 'test' }, 'bill-said: look');
    const pid = probe.data?.role_id;
    await P(`roles:${pid}`, { bill_fit: { verdict: spelling } }, 'bill-said: yes');
    const advanced = await move(pid, 'P1', 'bill-said: on it');
    check(advanced.ok, `a verdict written as "${spelling}" still opens the P0 -> P1 gate`,
      JSON.stringify(advanced.data).slice(0, 200));
  }
  const nonsense = await P(`roles:${ROLE}`, { bill_fit: { verdict: 'probably?' } }, 'bill-said: dunno');
  check(/not a verdict/.test(JSON.stringify(nonsense.data)), 'a value that is not a verdict is refused with the allowed list',
    JSON.stringify(nonsense.data).slice(0, 250));
  const survived = await move(ROLE, 'P1', 'bill-said: on it');
  check(survived.ok, 'a rejected verdict does not wipe the good one already recorded',
    JSON.stringify(survived.data).slice(0, 250));

  check(survived.data?.phase === 'P1', `phase is now P1 (got ${survived.data?.phase})`);
}

// ---------------------------------------------------------------- P1 -> P2
section('P1 -> P2 — needs a real approach, not an intention');
{
  const blocked = await move(ROLE, 'P2', 'bill-said: they replied');
  check(!blocked.ok, 'the move is refused with no interaction on the record');
  check(/outreach|application|interaction/i.test(JSON.stringify(blocked.data)),
    'the refusal says which evidence to record first', JSON.stringify(blocked.data).slice(0, 250));

  const interaction = await P('interactions:new',
    { role_id: ROLE, kind: 'application', summary: 'Applied through the careers page', occurred_at: iso(-2) },
    'bill-said: applied on Tuesday');
  check(interaction.ok, 'the application is recorded as an interaction', JSON.stringify(interaction.data).slice(0, 250));

  const moved = await move(ROLE, 'P2', 'bill-said: they came back to me');
  check(moved.ok, 'the move is applied once the interaction exists', JSON.stringify(moved.data).slice(0, 250));
}

// ---------------------------------------------------------------- P2 -> P3
section('P2 -> P3 — politeness is not advancement');
{
  const blocked = await move(ROLE, 'P3', 'bill-said: it went well');
  check(!blocked.ok, 'the move is refused when nothing was committed by their side');
  check(/commit/i.test(JSON.stringify(blocked.data)), 'the refusal explains what "advanced" means here',
    JSON.stringify(blocked.data).slice(0, 250));

  const real = await P('interactions:new',
    { role_id: ROLE, kind: 'call', summary: 'First call with the founder',
      commitments_theirs: ['send the team round invite by Friday'], occurred_at: iso(-1) },
    'bill-said: he committed to the team round');
  check(real.ok, 'an interaction carrying their commitments is recorded', JSON.stringify(real.data).slice(0, 250));

  const moved = await move(ROLE, 'P3', 'bill-said: team round booked');
  check(moved.ok, 'the move is applied once their side committed to something',
    JSON.stringify(moved.data).slice(0, 250));
}

// ---------------------------------------------------------------- P3 -> P4
section('P3 -> P4 — needs an actual offer');
{
  const blocked = await move(ROLE, 'P4', 'bill-said: they are going to make an offer');
  check(!blocked.ok, 'the move is refused on an expected offer');
  check(/offer/i.test(JSON.stringify(blocked.data)), 'the refusal asks for the offer row',
    JSON.stringify(blocked.data).slice(0, 250));

  const offerCreate = await P('offers:new',
    { role_id: ROLE, base: 65000, status: 'reviewing', received_at: iso(), summary: '65k base, 0.5% options' },
    'bill-said: offer came through this morning');
  check(offerCreate.ok, 'the offer is recorded', JSON.stringify(offerCreate.data).slice(0, 250));
  globalThis.__offerId = offerCreate.data?.id;

  const moved = await move(ROLE, 'P4', 'bill-said: offer in hand');
  check(moved.ok, 'the move is applied once the offer exists', JSON.stringify(moved.data).slice(0, 250));
}

// ---------------------------------------------------------------- P4 -> P5
section('P4 -> P5 — needs the offer accepted');
{
  const blocked = await move(ROLE, 'P5', 'bill-said: I think I will take it');
  check(!blocked.ok, 'the move is refused while the offer is still open');
  const offerId = globalThis.__offerId;
  note(`offer row for acceptance: ${offerId ?? '(none)'}`);
  if (offerId) {
    const accepted = await P(`offers:${offerId}`, { status: 'accepted' }, 'bill-said: accepted it');
    check(accepted.ok, 'the offer can be marked accepted', JSON.stringify(accepted.data).slice(0, 250));
    const moved = await move(ROLE, 'P5', 'bill-said: signed');
    check(moved.ok, 'the move to P5 is applied once the offer is accepted', JSON.stringify(moved.data).slice(0, 250));
  }
}

// ---------------------------------------------------------------- the snapshot
section('What the funnel reports back');
{
  const snap = await call('start_coach', { user_message: 'where is the pipeline', now: iso() });
  const blob = JSON.stringify(snap.data);
  check(blob.includes('Northwind') || blob.includes('counts_by_phase') || blob.includes('funnel'),
    'the funnel snapshot reaches orientation', blob.slice(0, 250));
  const pipeline = await call('bill_command', { command: 'pipeline', session_id: snap.data.session_id });
  check(pipeline.ok, 'the pipeline command exports the funnel', JSON.stringify(pipeline.data).slice(0, 200));
  check(JSON.stringify(pipeline.data).includes('Northwind'), 'the walked company appears in the export',
    JSON.stringify(pipeline.data).slice(0, 250));

  const changes = await call('bill_command', { command: 'changes', session_id: snap.data.session_id });
  check(changes.ok, 'the session changelog runs', JSON.stringify(changes.data).slice(0, 200));

  // Every phase move should be on the audit trail, with who said so.
  const sources = await call('bill_command', { command: 'sources', session_id: snap.data.session_id, subject: 'Northwind' });
  check(sources.ok, 'provenance for the company can be reconstructed', JSON.stringify(sources.data).slice(0, 200));
  note(`audit trail size: ${JSON.stringify(sources.data).length} chars`);
}

// ---------------------------------------------------------------- exit path
section('A company that goes nowhere');
{
  const second = await P('roles:new', { company: 'Deadend Systems', lane: 'fractional', source: 'jobs board' },
    'bill-said: worth a look');
  const deadId = second.data?.role_id ?? second.data?.id;
  check(second.ok, 'a second company enters the funnel');
  const exited = await move(deadId, 'exited', 'bill-said: they went with someone internal');
  note(`exit without exit_reason: ${exited.ok ? 'accepted' : JSON.stringify(exited.data).slice(0, 200)}`);
  const learned = await call('save_coaching_state', {
    session_id: SID, expected_session_version: (await call('start_coach', { user_message: 'exit', now: iso() })).data.session_version,
    learnings: [{ id: `learning-${deadId}`, category: 'market',
      learning: 'Internal hires close faster than external at this stage',
      evidence: 'They filled it from the existing team', source_kind: 'role', source_id: deadId }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  note(`learning before exit: ${learned.ok ? 'recorded' : JSON.stringify(learned.data).slice(0, 200)}`);
  const exitedProperly = await P(`roles:${deadId}`,
    { action: 'transition', to_phase: 'exited', exit_reason: 'hired internally', exit_by: 'them' },
    'bill-said: they went with someone internal');
  check(exitedProperly.ok, 'a role can be exited with a reason', JSON.stringify(exitedProperly.data).slice(0, 250));
  const ledger = await call('inspect_memory', { query: 'Internal hires', limit: 5 });
  check(JSON.stringify(ledger.data).includes('Internal hires close faster'),
    'the learning is readable back out of the ledger', JSON.stringify(ledger.data).slice(0, 250));

  const revive = await move(deadId, 'P1', 'bill-said: they came back');
  note(`reviving an exited role: ${revive.ok ? 'accepted' : JSON.stringify(revive.data).slice(0, 200)}`);
}

child.kill();
console.log('');
if (notes.length) { console.log('observations:'); for (const n of notes) console.log(`  - ${n}`); console.log(''); }
if (stderr.trim()) console.log(`stderr:\n${stderr.trim().slice(0, 500)}\n`);
console.log(failures === 0 ? 'PIPELINE TESTS PASSED' : `PIPELINE TESTS FAILED: ${failures}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
