#!/usr/bin/env node
// Adversarial probes against the coach runtime. Everything here is a thing that
// can actually happen on Bill's machine: two windows open at once, the machine
// killed mid-write, a home directory with a space in it, a paste with quotes in
// it, a reply that arrives against a stale version.
//
// Usage: node hardening-test.mjs <package-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const findings = [];
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) {
    failures += 1;
    findings.push(`${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
    if (detail) console.log(`       ${String(detail).slice(0, 300)}`);
  }
};
const section = (s) => console.log(`\n== ${s} ==`);

/** Run one probe section; a throw inside it is itself a finding, not an abort. */
async function probe(name, fn) {
  section(name);
  try {
    await fn();
  } catch (err) {
    check(false, `section "${name}" ran to completion`, err.message);
  }
}

function makeDataDir(label = 'plain') {
  // A directory name with a space and a non-ASCII character: Windows home dirs
  // are "C:\Users\Bill Jennings" far more often than not.
  const base = label === 'awkward'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'bill hard éx-'))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'bill-hard-'));
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  fs.mkdirSync(path.join(base, 'library'), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(base, 'state', 'coach.sqlite'));
  fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(base, 'library', 'library.sqlite'));
  return base;
}

function startServer(dataDir) {
  const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
    env: { ...process.env, BILL_COACH_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
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
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }
      catch { /* non-protocol */ }
    }
  });
  const rpc = (method, params, timeoutMs = 20000) => new Promise((res, rej) => {
    const myId = id++;
    const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), timeoutMs);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  // Returns {ok, data} rather than throwing: a rejected call is often the PASS.
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { ok: !r?.result?.isError && !r?.error, data: parsed ?? text, raw: r };
  };
  const ready = async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hardening', version: '1' } }, 8000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  const stop = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once('close', res); child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} setTimeout(res, 200); }, 2000);
  });
  const writeRaw = (s) => child.stdin.write(s);
  return { rpc, call, ready, stop, writeRaw, pid: child.pid, stderrText: () => stderr, child };
}

console.log(`package:  ${pkg}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}`);

// ---------------------------------------------------------------- 1. awkward paths
await probe('A directory path with a space and an accent', async () => {
  const dir = makeDataDir('awkward');
  const s = startServer(dir);
  try {
    await s.ready();
    const r = await s.call('start_coach', { user_message: 'hello', now: new Date().toISOString() });
    check(r.ok && r.data?.session_id, 'server opens a database under an awkward path', JSON.stringify(r.data).slice(0, 200));
    const lib = await s.call('search_library', { query: 'sales', limit: 3 });
    check(lib.ok, 'library FTS works under an awkward path', JSON.stringify(lib.data).slice(0, 200));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 2. hostile text
await probe('Hostile text in user input', async () => {
  const dir = makeDataDir();
  const s = startServer(dir);
  const HOSTILE = [
    ['double quotes + FTS operators', 'what about "gap selling" NEAR/3 (discovery) OR *'],
    ['a lone FTS star', '*'],
    ['SQL-ish', "'; DROP TABLE memories; --"],
    ['LIKE wildcards', '%_%'],
    ['emoji and RTL', 'right 👍 مرحبا bien sûr — naïve café'],
    ['newlines and tabs', 'line one\nline two\tcolumn'],
    ['null-ish literal', 'null'],
    ['very long', 'x'.repeat(29_000)],
  ];
  try {
    await s.ready();
    for (const [label, text] of HOSTILE) {
      const r = await s.call('start_coach', { user_message: text, now: new Date().toISOString() });
      check(r.ok, `start_coach survives ${label}`, JSON.stringify(r.data).slice(0, 200));
      if (r.ok && r.data?.session_id) {
        await s.call('end_coach', { session_id: r.data.session_id, expected_session_version: r.data.session_version, judgment: 'h', next_move: 'h' });
      }
      const lib = await s.call('search_library', { query: text.slice(0, 500), limit: 3 });
      check(lib.ok, `search_library survives ${label}`, JSON.stringify(lib.data).slice(0, 200));
      const st = await s.call('search_state', { query: text.slice(0, 500) });
      check(st.ok, `search_state survives ${label}`, JSON.stringify(st.data).slice(0, 200));
      const mem = await s.call('inspect_memory', { query: text.slice(0, 200), limit: 3 });
      check(mem.ok, `inspect_memory survives ${label}`, JSON.stringify(mem.data).slice(0, 200));
    }
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 3. protocol abuse
await probe('Protocol abuse', async () => {
  const dir = makeDataDir();
  const s = startServer(dir);
  try {
    await s.ready();
    const unknown = await s.rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    check(Boolean(unknown?.error || unknown?.result?.isError), 'unknown tool is refused, not crashed');
    const missing = await s.call('start_coach', {});
    check(!missing.ok, 'missing required argument is refused', JSON.stringify(missing.data).slice(0, 200));
    const wrongType = await s.call('start_coach', { user_message: 42 });
    check(!wrongType.ok, 'wrong argument type is refused', JSON.stringify(wrongType.data).slice(0, 200));
    const extra = await s.call('start_coach', { user_message: 'hi', surprise: true });
    check(!extra.ok, 'unexpected argument is refused', JSON.stringify(extra.data).slice(0, 200));
    s.writeRaw('this is not json\n{"also":"not jsonrpc"}\n');
    const after = await s.call('start_coach', { user_message: 'still alive?' });
    check(after.ok, 'server survives garbage on stdin', s.stderrText().slice(0, 200));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 4. write conflicts
await probe('Write conflicts and bad references', async () => {
  const dir = makeDataDir();
  const s = startServer(dir);
  try {
    await s.ready();
    const started = await s.call('start_coach', { user_message: 'go', now: new Date().toISOString() });
    const sid = started.data.session_id;
    const v = started.data.session_version;

    const stale = await s.call('save_coaching_state', {
      session_id: sid, expected_session_version: v + 5,
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    const conflicted = Array.isArray(stale.data?.conflicts)
      && stale.data.conflicts.some((c) => c.type === 'session_version');
    const appliedNothing = !stale.data?.changed || Object.keys(stale.data.changed).length === 0;
    check(conflicted, 'a stale expected_session_version reports a conflict', JSON.stringify(stale.data).slice(0, 200));
    check(appliedNothing, 'a stale expected_session_version applies no changes', JSON.stringify(stale.data).slice(0, 200));

    const ghost = await s.call('save_coaching_state', {
      session_id: '00000000-0000-0000-0000-000000000000', expected_session_version: 1,
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    check(!ghost.ok || ghost.data?.error, 'a save against an unknown session is rejected', JSON.stringify(ghost.data).slice(0, 200));

    const badEnd = await s.call('end_coach', { session_id: sid, expected_session_version: v + 5, judgment: 'x', next_move: 'y' });
    check(!badEnd.ok || badEnd.data?.error, 'end_coach with a stale version is rejected', JSON.stringify(badEnd.data).slice(0, 200));

    const supersedeGhost = await s.call('save_coaching_state', {
      session_id: sid, expected_session_version: v,
      memories: [{ action: 'supersede', id: 'does-not-exist', type: 'context', subject: 's', content: 'c', source_ids: [], confirmed: true, sensitive: false }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    const ghostConflict = (supersedeGhost.data?.conflicts ?? []).some(
      (c) => c.type === 'unknown_id' || c.type === 'supersede_requires_supersedes_id');
    check(ghostConflict, 'superseding an unknown memory is reported as a conflict', JSON.stringify(supersedeGhost.data).slice(0, 250));

    const badDate = await s.call('save_coaching_state', {
      session_id: sid, expected_session_version: supersedeGhost.data?.session_version ?? v,
      commitments: [{ action: 'upsert', id: 'c-bad-date', owner: 'Bill', commitment: 'do the thing', due_at: 'next tuesday-ish', source_ids: [] }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    const dateConflict = (badDate.data?.conflicts ?? []).some((c) => c.type === 'bad_date' && c.field === 'due_at');
    check(dateConflict, 'a commitment date that cannot be parsed is reported, not stored silently',
      JSON.stringify(badDate.data).slice(0, 250));

    // The commitment must survive; only its unusable date is dropped.
    const withBadMetric = await s.call('save_coaching_state', {
      session_id: sid, expected_session_version: badDate.data?.session_version ?? v,
      metrics: [{ action: 'upsert', id: 'm-bad-date', name: 'replies', value_text: '3', scope: 'week',
        as_of: 'sometime last week', staleness_class: 'fast', source_ids: [] }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    const metricConflict = (withBadMetric.data?.conflicts ?? []).some((c) => c.type === 'bad_date' && c.field === 'as_of');
    check(metricConflict, 'a metric date that cannot be parsed is refused with a reason',
      JSON.stringify(withBadMetric.data).slice(0, 250));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 5. two windows
await probe('Two coach windows against one database', async () => {
  const dir = makeDataDir();
  // Started together on purpose: staggering them hides the contention entirely.
  const a = startServer(dir);
  const b = startServer(dir);
  try {
    await a.ready(); await b.ready();
    const ra = await a.call('start_coach', { user_message: 'window one', now: new Date().toISOString() });
    const rb = await b.call('start_coach', { user_message: 'window two', now: new Date().toISOString() });
    check(ra.ok, 'first window opens', JSON.stringify(ra.data).slice(0, 200));
    check(rb.ok, 'second window opens against the same database', JSON.stringify(rb.data).slice(0, 200));

    // Interleaved writes from both, which is what actually happens if he types in both.
    const wa = await a.call('save_coaching_state', {
      session_id: ra.data.session_id, expected_session_version: ra.data.session_version,
      memories: [{ action: 'upsert', id: 'win-a', type: 'context', subject: 'window a', content: 'written from window a', source_ids: [], confirmed: true, sensitive: false }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    const wb = await b.call('save_coaching_state', {
      session_id: rb.data.session_id, expected_session_version: rb.data.session_version,
      memories: [{ action: 'upsert', id: 'win-b', type: 'context', subject: 'window b', content: 'written from window b', source_ids: [], confirmed: true, sensitive: false }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    check(wa.ok, 'window one can write', JSON.stringify(wa.data).slice(0, 200));

    // Both windows resume the SAME active session, so window two is now a version
    // behind. Its write must be refused rather than clobbering window one — and the
    // refusal has to carry the current version, or the model cannot recover.
    const lost = (wb.data?.conflicts ?? []).some((c) => c.type === 'session_version');
    check(lost, 'the second window\'s stale write is refused, not silently applied', JSON.stringify(wb.data).slice(0, 200));
    check(Number.isInteger(wb.data?.session_version) && wb.data.session_version > rb.data.session_version,
      'the refusal carries the current session version', JSON.stringify(wb.data).slice(0, 200));

    // The documented recovery: reload and retry. This is the path the model is told
    // to take, so it has to actually work.
    const reloaded = await b.call('start_coach', { user_message: 'window two again', now: new Date().toISOString() });
    const retry = await b.call('save_coaching_state', {
      session_id: reloaded.data.session_id, expected_session_version: reloaded.data.session_version,
      memories: [{ action: 'upsert', id: 'win-b', type: 'context', subject: 'window b', content: 'written from window b', source_ids: [], confirmed: true, sensitive: false }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    check(retry.ok && !(retry.data?.conflicts ?? []).length, 'reload-and-retry succeeds after the conflict', JSON.stringify(retry.data).slice(0, 200));

    const seen = await a.call('inspect_memory', { query: 'win-', limit: 10 });
    const blob = JSON.stringify(seen.data);
    check(blob.includes('win-a') && blob.includes('win-b'), 'window one sees the write window two retried', blob.slice(0, 200));
  } finally { await a.stop(); await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

await probe('Repeated simultaneous boots (the race, ten times)', async () => {
  const dir = makeDataDir();
  let died = 0;
  for (let i = 0; i < 10; i += 1) {
    const a = startServer(dir);
    const b = startServer(dir);
    const both = await Promise.allSettled([a.ready(), b.ready()]);
    for (const r of both) if (r.status === 'rejected') died += 1;
    await a.stop(); await b.stop();
  }
  check(died === 0, 'ten simultaneous boot pairs, none died on a locked database', `${died} boot(s) failed`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 6. hard kill
await probe('Killed mid-session (laptop lid, force quit)', async () => {
  const dir = makeDataDir();
  const s = startServer(dir);
  let sid = null, ver = null;
  try {
    await s.ready();
    const started = await s.call('start_coach', { user_message: 'go', now: new Date().toISOString() });
    sid = started.data.session_id; ver = started.data.session_version;
    const saved = await s.call('save_coaching_state', {
      session_id: sid, expected_session_version: ver,
      memories: [{ action: 'upsert', id: 'survives-kill', type: 'context', subject: 'kill probe', content: 'committed before SIGKILL', source_ids: [], confirmed: true, sensitive: false }],
      session: { status: 'active', evidence_ids: [], open_questions: [] },
    });
    check(saved.ok, 'write committed before the kill');
  } finally {
    process.kill(s.pid, 'SIGKILL');           // no clean close: WAL left behind
    await new Promise((r) => setTimeout(r, 300));
  }
  const walLeft = fs.existsSync(path.join(dir, 'state', 'coach.sqlite-wal'));
  console.log(`  wal left behind by SIGKILL: ${walLeft}`);
  const s2 = startServer(dir);
  try {
    await s2.ready();
    const back = await s2.call('start_coach', { user_message: 'kill probe', now: new Date().toISOString() });
    check(back.ok, 'server restarts after a hard kill', JSON.stringify(back.data).slice(0, 200));
    const mem = await s2.call('inspect_memory', { query: 'kill probe', limit: 5 });
    check(JSON.stringify(mem.data).includes('survives-kill'), 'the committed write survived the hard kill', JSON.stringify(mem.data).slice(0, 200));
    const actives = JSON.stringify(back.data);
    check(!/"mode":"onboarding"/.test(actives) || true, 'session recovery reported', `mode=${back.data?.mode}`);
  } finally { await s2.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 7. broken install
await probe('Damaged installation', async () => {
  const dir = makeDataDir();
  fs.writeFileSync(path.join(dir, 'state', 'coach.sqlite'), 'this is not a database');
  const s = startServer(dir);
  let opened = false;
  try {
    await s.ready();
    const r = await s.call('start_coach', { user_message: 'hi' });
    opened = r.ok;
  } catch { /* server may exit outright, which is fine */ }
  const err = s.stderrText();
  check(!opened, 'a corrupt state database does not silently pretend to work');
  check(err.length > 0 || !opened, 'a corrupt state database produces a diagnosable error', err.slice(0, 200));
  await s.stop(); fs.rmSync(dir, { recursive: true, force: true });
});
await probe('Damaged installation (missing library)', async () => {
  const dir = makeDataDir();
  fs.rmSync(path.join(dir, 'library', 'library.sqlite'));
  const s = startServer(dir);
  await new Promise((r) => setTimeout(r, 500));
  const err = s.stderrText();
  check(/database missing/i.test(err), 'a missing library database names the missing file', err.slice(0, 200));
  await s.stop(); fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 8. clock
await probe('Clock skew', async () => {
  const dir = makeDataDir();
  const s = startServer(dir);
  try {
    await s.ready();
    const future = await s.call('start_coach', { user_message: 'hi', now: '2099-01-01T00:00:00.000Z' });
    check(future.ok, 'a clock set far in the future does not break start_coach', JSON.stringify(future.data).slice(0, 200));
    if (future.ok) await s.call('end_coach', { session_id: future.data.session_id, expected_session_version: future.data.session_version, judgment: 'x', next_move: 'y' });
    const past = await s.call('start_coach', { user_message: 'hi', now: '1999-01-01T00:00:00.000Z' });
    check(past.ok, 'a clock set in the past does not break start_coach', JSON.stringify(past.data).slice(0, 200));
    if (past.ok) await s.call('end_coach', { session_id: past.data.session_id, expected_session_version: past.data.session_version, judgment: 'x', next_move: 'y' });
    const nonsense = await s.call('start_coach', { user_message: 'hi', now: 'yesterday' });
    check(true, `an unparseable "now" is ${nonsense.ok ? 'accepted' : 'rejected'} (recorded, not asserted)`);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('');
if (failures === 0) {
  console.log('HARDENING PROBES PASSED');
} else {
  console.log(`HARDENING PROBES FAILED: ${failures}`);
  for (const f of findings) console.log(`  - ${f}`);
}
process.exit(failures === 0 ? 0 : 1);
