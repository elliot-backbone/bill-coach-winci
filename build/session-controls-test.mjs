#!/usr/bin/env node
// The controls Bill actually touches: start_coach, end_coach, and what happens
// when he never ends anything and just closes the window.
//
// Usage: node session-controls-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const notes = [];
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
};
const note = (line) => { notes.push(line); console.log(`  ·    ${line}`); };
const section = (s) => console.log(`\n== ${s} ==`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-controls-'));
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dataDir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dataDir, 'library', 'library.sqlite'));
console.log(`data dir: ${dataDir}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}`);

function startServer() {
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
  const ready = async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'controls', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  const stop = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once('close', res); child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} setTimeout(res, 200); }, 2000);
  });
  return { rpc, call, ready, stop, pid: child.pid, stderrText: () => stderr };
}

const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

// ---------------------------------------------------------------- onboarding out of the way
section('Getting past onboarding');
let s = startServer();
await s.ready();
{
  const a = await s.call('start_coach', { user_message: 'hello', now: iso() });
  check(a.ok, 'first ever start_coach opens onboarding', JSON.stringify(a.data).slice(0, 150));
  check(a.data?.mode === 'onboarding', `mode is onboarding (got ${a.data?.mode})`);
  const done = await s.call('save_coaching_state', {
    session_id: a.data.session_id, expected_session_version: a.data.session_version,
    onboarding: { status: 'complete', confirmed_picture: 'controls test picture' },
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  check(done.ok, 'onboarding can be completed');
  await s.call('end_coach', {
    session_id: a.data.session_id, expected_session_version: done.data?.session_version ?? 2,
    judgment: 'onboarding done', next_move: 'start work',
  });
}

// ---------------------------------------------------------------- a real working session
section('A working session: every surface written');
let sessionOne = null;
{
  const b = await s.call('start_coach', { user_message: 'lets work on the pipeline', now: iso() });
  check(b.ok && b.data?.mode !== 'onboarding', `second session is ordinary work (mode ${b.data?.mode})`);
  sessionOne = b.data.session_id;
  let v = b.data.session_version;

  const wrote = await s.call('save_coaching_state', {
    session_id: sessionOne, expected_session_version: v,
    memories: [{ action: 'upsert', id: 'ctrl-memory', type: 'company', subject: 'Northwind Robotics',
      content: 'Series A, twelve people, founder is the only seller today.',
      source_ids: [], confirmed: true, sensitive: false }],
    metrics: [{ action: 'upsert', id: 'ctrl-metric', name: 'live conversations', value_text: '6',
      scope: 'pipeline', as_of: iso(), staleness_class: 'fast', source_ids: [] }],
    decisions: [{ action: 'upsert', id: 'ctrl-decision', decision: 'Target seed-stage B2B only',
      reason: 'His commercial range lands hardest where there is no sales function yet', made_at: iso(), source_ids: [] }],
    commitments: [{ action: 'upsert', id: 'ctrl-commitment', owner: 'Bill',
      commitment: 'Send the Northwind follow-up', due_at: iso(2), source_ids: [] }],
    session: { status: 'active', situation: 'Working the pipeline', evidence_ids: [], open_questions: ['Is Northwind funded?'] },
  });
  check(wrote.ok, 'a session can write memory, metric, decision and commitment together', JSON.stringify(wrote.data).slice(0, 250));
  check(!(wrote.data?.conflicts ?? []).length, 'no conflicts on a well-formed write', JSON.stringify(wrote.data?.conflicts));

  const ended = await s.call('end_coach', {
    session_id: sessionOne, expected_session_version: wrote.data.session_version,
    judgment: 'Northwind is the strongest live thread', next_move: 'Send the follow-up, then chase the intro',
  });
  check(ended.ok, 'end_coach closes the session', JSON.stringify(ended.data).slice(0, 200));
}

// ---------------------------------------------------------------- surfaces on return
section('What the next session can see');
await s.stop();
s = startServer();
await s.ready();
{
  const c = await s.call('start_coach', { user_message: 'where are we with Northwind', now: iso() });
  check(c.ok, 'start_coach opens after a clean restart');
  const blob = JSON.stringify(c.data);
  check(blob.includes('Northwind Robotics'), 'the memory written last session surfaces');
  check(blob.includes('ctrl-commitment') || blob.includes('Northwind follow-up'), 'the open commitment surfaces');
  check(blob.includes('live conversations'), 'the metric surfaces');
  check(blob.includes('Target seed-stage B2B only'), 'the decision surfaces');
  check(blob.includes('Northwind is the strongest live thread'), 'last session\'s judgment surfaces');
  check(blob.includes('Send the follow-up'), 'last session\'s next move surfaces');
  check(c.data?.session_id !== sessionOne, 'a genuinely new session is opened after a clean end');
  await s.call('end_coach', { session_id: c.data.session_id, expected_session_version: c.data.session_version, judgment: 'x', next_move: 'y' });
}

// ---------------------------------------------------------------- mid-session checkpoint
section('Restart from the last checkpoint (no end_coach yet)');
let abandoned = null;
{
  const d = await s.call('start_coach', { user_message: 'quick one about Northwind', now: iso() });
  abandoned = d.data.session_id;
  const mid = await s.call('save_coaching_state', {
    session_id: abandoned, expected_session_version: d.data.session_version,
    memories: [{ action: 'upsert', id: 'ctrl-midsession', type: 'context', subject: 'mid-session note',
      content: 'Checkpointed before the window closed.', source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', situation: 'Half way through the Northwind question', evidence_ids: [], open_questions: [] },
  });
  check(mid.ok, 'a mid-session checkpoint is accepted');

  // Bill closes the window. No end_coach, no clean shutdown: the process is killed.
  process.kill(s.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
}

s = startServer();
await s.ready();
{
  const e = await s.call('start_coach', { user_message: 'back again', now: iso() });
  check(e.ok, 'start_coach recovers after the window was closed mid-session', JSON.stringify(e.data).slice(0, 200));
  const blob = JSON.stringify(e.data);
  check(blob.includes('Checkpointed before the window closed'), 'the mid-session checkpoint survived');
  note(`session after an abrupt close: ${e.data?.session_id === abandoned ? 'RESUMED the same session' : 'opened a NEW session'} (mode ${e.data?.mode})`);
  check(blob.includes('Half way through the Northwind question') || e.data?.session_id === abandoned,
    'the unfinished situation is still reachable', blob.slice(0, 250));

  // Whatever the answer above, the old session must not be left active alongside a
  // new one: two active sessions is how version conflicts start appearing forever.
  const dump = await s.call('bill_command', { command: 'memory', session_id: e.data.session_id });
  const activeCount = (JSON.stringify(dump.data).match(/"status":"active"/g) ?? []).length;
  note(`rows reported active in the full dump: ${activeCount}`);
  await s.call('end_coach', { session_id: e.data.session_id, expected_session_version: e.data.session_version, judgment: 'x', next_move: 'y' });
}

// ---------------------------------------------------------------- never-ended sessions
section('Sessions that were never ended');
{
  // Three windows opened and abandoned without end_coach, the way a week of
  // interrupted sessions actually looks.
  for (let i = 0; i < 3; i += 1) {
    const r = await s.call('start_coach', { user_message: `abandoned ${i}`, now: iso() });
    await s.call('save_coaching_state', {
      session_id: r.data.session_id, expected_session_version: r.data.session_version,
      session: { status: 'active', situation: `abandoned session ${i}`, evidence_ids: [], open_questions: [] },
    });
    await s.stop();
    s = startServer();
    await s.ready();
  }
  const f = await s.call('start_coach', { user_message: 'right, where were we', now: iso() });
  check(f.ok, 'start_coach still works after repeated abandoned sessions', JSON.stringify(f.data).slice(0, 200));
  const recent = JSON.stringify(f.data?.recent_sessions ?? f.data);
  note(`recent_sessions carried into orientation: ${(recent.match(/"id"/g) ?? []).length}`);
  const stillActive = await s.call('search_state', { query: 'abandoned' });
  note(`search_state finds abandoned sessions: ${JSON.stringify(stillActive.data).slice(0, 120)}`);
  await s.call('end_coach', { session_id: f.data.session_id, expected_session_version: f.data.session_version, judgment: 'x', next_move: 'y' });
}

// ---------------------------------------------------------------- end_coach discipline
section('end_coach refuses to lose things');
{
  const g = await s.call('start_coach', { user_message: 'last one', now: iso() });
  const twice = await s.call('end_coach', {
    session_id: g.data.session_id, expected_session_version: g.data.session_version, judgment: 'a', next_move: 'b',
  });
  check(twice.ok, 'end_coach closes a session');
  const again = await s.call('end_coach', {
    session_id: g.data.session_id, expected_session_version: (twice.data?.session_version ?? 1), judgment: 'a', next_move: 'b',
  });
  check(!again.ok || again.data?.error || (again.data?.conflicts ?? []).length > 0,
    'ending an already-closed session is refused, not silently repeated', JSON.stringify(again.data).slice(0, 200));

  const writeAfterClose = await s.call('save_coaching_state', {
    session_id: g.data.session_id, expected_session_version: (twice.data?.session_version ?? 1),
    memories: [{ action: 'upsert', id: 'ctrl-after-close', type: 'context', subject: 'after close',
      content: 'written after end_coach', source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'closed', evidence_ids: [], open_questions: [] },
  });
  note(`writing to a closed session is ${writeAfterClose.ok && !(writeAfterClose.data?.conflicts ?? []).length ? 'ACCEPTED' : 'refused'}`);
}

await s.stop();
console.log('');
if (notes.length) { console.log('observations:'); for (const n of notes) console.log(`  - ${n}`); console.log(''); }
console.log(failures === 0 ? 'SESSION CONTROL TESTS PASSED' : `SESSION CONTROL TESTS FAILED: ${failures}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
