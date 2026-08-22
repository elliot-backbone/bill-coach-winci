#!/usr/bin/env node
// Full coaching-session exercise, model-free and deterministic.
//
// The model runs on Anthropic's servers, so coaching *quality* is not platform
// dependent. What IS platform dependent is everything underneath: SQLite reads
// and writes, the FTS5 index, file locking, and whether state survives the
// process exiting. This drives the real MCP runtime through a realistic session,
// restarts the server, and checks the writes are still there — the sequence most
// likely to expose Windows file-locking behaviour.
//
// Usage: node session-test.mjs <package-dir>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
};

// One data dir reused across two server lifetimes, like a real install.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-session-'));
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(dataDir, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(dataDir, 'library', 'library.sqlite'));
console.log(`data dir: ${dataDir}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}`);

function startServer() {
  const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
    env: { ...process.env, BILL_COACH_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let id = 1;
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* non-protocol line */ }
    }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const myId = id++;
    const timer = setTimeout(() => rej(new Error(`timeout on ${method}`)), 20000);
    pending.set(myId, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    if (r?.result?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return parsed ?? text;
  };
  // Resolve only once the process is truly gone: on Windows its handles keep
  // the state database locked until then.
  const stop = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once('close', res);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} setTimeout(res, 200); }, 2000);
  });
  return { rpc, call, stop, stderrText: () => stderr };
}

// ---------------------------------------------------------------- session one
console.log('\n== session 1: a working session ==');
let s = startServer();
let sessionId = null;
let version = null;
try {
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-test', version: '1' } });

  const started = await s.call('start_coach', { user_message: 'right, where are we', now: new Date().toISOString() });
  sessionId = started.session_id;
  version = started.session_version;
  check(Boolean(sessionId), `start_coach opened a session (mode ${started.mode})`);
  check(Number.isInteger(version), `session version is an integer (${version})`);

  const ctx = await s.call('get_context', { session_id: sessionId, question: 'what should I focus on next' });
  check(Boolean(ctx), 'get_context returned a briefing');

  // Exercises the FTS5 index, which is the thing Node 22 could not even load.
  const lib = await s.call('search_library', { query: 'sales founder', limit: 5 });
  check(lib !== null && lib !== undefined, 'search_library ran an FTS query');

  const st = await s.call('search_state', { query: 'role', limit: 5 });
  check(st !== null && st !== undefined, 'search_state queried the funnel tables');

  const mem = await s.call('inspect_memory', { limit: 5 });
  check(mem !== null && mem !== undefined, 'inspect_memory read the memory store');

  // A durable write: move onboarding forward and record session narrative.
  const saved = await s.call('save_coaching_state', {
    session_id: sessionId,
    expected_session_version: version,
    onboarding: { status: 'pane_2' },
    session: {
      status: 'active',
      situation: 'platform verification session',
      evidence_ids: [],
      open_questions: [],
    },
  });
  check(Boolean(saved), 'save_coaching_state committed a write');
  if (saved && Number.isInteger(saved.session_version)) version = saved.session_version;

  const cmd = await s.call('bill_command', { command: 'pipeline', session_id: sessionId });
  check(Boolean(cmd), 'bill_command handled "pipeline"');

  const ended = await s.call('end_coach', {
    session_id: sessionId,
    expected_session_version: version,
    judgment: 'platform verification only',
    next_move: 'none',
  });
  check(Boolean(ended), 'end_coach closed the session cleanly');
} catch (err) {
  check(false, 'session 1 completed without error', `${err.message}\n${s.stderrText().slice(0, 400)}`);
} finally {
  await s.stop();
}

// ------------------------------------------------- restart: does state persist
console.log('\n== restart: state must survive the process exiting ==');
// A stale lock or an unflushed WAL shows up here rather than in session 1.
const walPath = path.join(dataDir, 'state', 'coach.sqlite-wal');
console.log(`  wal present after shutdown: ${fs.existsSync(walPath)}`);

s = startServer();
try {
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-test', version: '1' } });
  const restarted = await s.call('start_coach', { user_message: 'back again', now: new Date().toISOString() });
  check(Boolean(restarted.session_id), 'second session opens against the same database');
  check(restarted.session_id !== sessionId, 'a genuinely new session id was issued');
  // The onboarding write from session 1 must still be there.
  const onboarding = JSON.stringify(restarted).includes('pane_2');
  check(onboarding, 'onboarding progress written in session 1 survived the restart',
    `mode=${restarted.mode}`);

  const mem2 = await s.call('inspect_memory', { limit: 5 });
  check(mem2 !== null && mem2 !== undefined, 'memory store readable after restart');

  await s.call('end_coach', {
    session_id: restarted.session_id,
    expected_session_version: restarted.session_version,
    judgment: 'platform verification only',
    next_move: 'none',
  });
  check(true, 'second session closed cleanly');
} catch (err) {
  check(false, 'session 2 completed without error', `${err.message}\n${s.stderrText().slice(0, 400)}`);
} finally {
  await s.stop();
}

// ---------------------------------- session 3: LIFE AFTER ONBOARDING
// The 1.2.3 regression lived exactly here. start_coach takes a different branch
// once onboarding is complete (lexical recall over all memories instead of the
// seed baseline), and that branch was never executed by any test: this script
// only ever advanced onboarding to pane_2, so every session it opened stayed in
// onboarding mode. Completing onboarding is what makes this a real gate.
console.log('\n== session 3: the first ordinary session after onboarding ==');
s = startServer();
try {
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-test', version: '1' } });

  const finishing = await s.call('start_coach', { user_message: 'let us finish up', now: new Date().toISOString() });
  let v = finishing.session_version;
  const complete = await s.call('save_coaching_state', {
    session_id: finishing.session_id,
    expected_session_version: v,
    onboarding: { status: 'complete', confirmed_picture: 'platform verification picture' },
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  check(Boolean(complete), 'onboarding marked complete');
  if (complete && Number.isInteger(complete.session_version)) v = complete.session_version;

  const wrote = await s.call('save_coaching_state', {
    session_id: finishing.session_id,
    expected_session_version: v,
    memories: [{
      action: 'upsert', id: 'platform-durability-probe', type: 'context',
      subject: 'platform durability probe',
      content: 'written before onboarding completed; must be recalled by the next session',
      source_ids: [], confirmed: true, sensitive: false,
    }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  check(Boolean(wrote), 'memory written in the final onboarding session');
  if (wrote && Number.isInteger(wrote.session_version)) v = wrote.session_version;

  await s.call('end_coach', {
    session_id: finishing.session_id, expected_session_version: v,
    judgment: 'platform verification only', next_move: 'none',
  });
} catch (err) {
  check(false, 'onboarding could be completed', `${err.message}\n${s.stderrText().slice(0, 400)}`);
} finally {
  await s.stop();
}

s = startServer();
try {
  await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-test', version: '1' } });
  const after = await s.call('start_coach', {
    user_message: 'remind me about the durability probe we wrote down',
    now: new Date().toISOString(),
  });
  check(Boolean(after?.session_id), 'start_coach works after onboarding is complete');
  const blob = JSON.stringify(after ?? {});
  check(!/"mode":"onboarding"/.test(blob), 'the session is an ordinary one, not onboarding again', `mode=${after?.mode}`);
  check(blob.includes('durability probe'), 'a memory written before completion is recalled after it',
    `mode=${after?.mode}`);
  await s.call('end_coach', {
    session_id: after.session_id, expected_session_version: after.session_version,
    judgment: 'platform verification only', next_move: 'none',
  });
} catch (err) {
  check(false, 'first post-onboarding session completed without error',
    `${err.message}\n${s.stderrText().slice(0, 400)}`);
} finally {
  await s.stop();
}

// ------------------------------------------------- cleanup must not hit EBUSY
console.log('\n== cleanup ==');
let removed = false;
for (let i = 0; i < 12 && !removed; i += 1) {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); removed = true; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125); }
}
check(removed, 'data directory removable after both sessions (no lingering file locks)');

console.log('');
console.log(failures === 0 ? `SESSION TESTS PASSED` : `SESSION TESTS FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
