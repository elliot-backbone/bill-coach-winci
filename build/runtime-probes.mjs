#!/usr/bin/env node
// Second-layer probes: the tools and paths the other suites never touch —
// the funnel writes, the hardcoded commands, evidence assembly, the search
// index, transaction atomicity, and whether sensitive material stays put.
//
// Usage: node runtime-probes.mjs <package-dir>
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
async function probe(name, fn) {
  console.log(`\n== ${name} ==`);
  try { await fn(); } catch (err) { check(false, `section "${name}" ran to completion`, err.message); }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-runtime-'));
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
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'runtime-probes', version: '1' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const iso = (d = 0) => new Date(Date.now() + d * 86_400_000).toISOString();

// get past onboarding
let s = await call('start_coach', { user_message: 'setup', now: iso() });
await call('save_coaching_state', {
  session_id: s.data.session_id, expected_session_version: s.data.session_version,
  onboarding: { status: 'complete' }, session: { status: 'active', evidence_ids: [], open_questions: [] },
});
await call('end_coach', { session_id: s.data.session_id, expected_session_version: 2, judgment: 'x', next_move: 'y' });
let sess = (await call('start_coach', { user_message: 'work', now: iso() })).data;
let ver = sess.session_version;
const bump = (r) => { if (Number.isInteger(r?.data?.session_version)) ver = r.data.session_version; return r; };

// ---------------------------------------------------------------- funnel writes
await probe('Funnel writes (update_state)', async () => {
  // A create that is missing a required field has to say which field, and what the
  // allowed values are. "internal error in update_state" left the coach stuck.
  const incomplete = await call('update_state', {
    target: 'roles:new', session_id: sess.session_id, provenance: 'bill-said: he applied on Tuesday',
    fields: { company: 'Northwind Robotics', source: 'direct' },
  });
  const msg = JSON.stringify(incomplete.data);
  check(!incomplete.ok, 'an incomplete create is refused');
  check(/lane/.test(msg) && !/internal error/.test(msg),
    'the refusal names the missing field instead of "internal error"', msg.slice(0, 250));

  const created = await call('update_state', {
    target: 'roles:new', session_id: sess.session_id, provenance: 'bill-said: he applied on Tuesday',
    fields: { company: 'Northwind Robotics', lane: 'core-ft', source: 'direct', not_a_column: 'Head of Sales' },
  });
  check(created.ok, 'a new role can be created through the documented roles:new path', JSON.stringify(created.data).slice(0, 250));
  note(`fields that are not columns: ${JSON.stringify(created.data?.ignored_fields ?? 'none reported')}`);
  const roleId = created.data?.id ?? created.data?.role_id ?? created.data?.target?.split(':')?.[1];
  note(`created role id: ${roleId ?? '(not returned)'}`);

  if (roleId) {
    const touched = await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'bill-said: spoke to the founder',
      fields: { action: 'touch' },
    });
    check(touched.ok, 'a touchpoint can be recorded', JSON.stringify(touched.data).slice(0, 250));

    await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'bill-said: yes, go on that one',
      fields: { bill_fit: { verdict: 'go' } },
    });
    const moved = await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'bill-said: he sent the application',
      fields: { action: 'transition', to_phase: 'P1' },
    });
    check(moved.ok, 'a legal phase move is applied', JSON.stringify(moved.data).slice(0, 250));

    // The funnel's whole safety design is these guards. Their messages are written to
    // tell the coach what to record first — they have to actually arrive.
    const skipped = await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'bill-said: straight to offer',
      fields: { action: 'transition', to_phase: 'P4' },
    });
    const skipMsg = JSON.stringify(skipped.data);
    check(!skipped.ok, 'skipping phases is refused');
    check(!/internal error/.test(skipMsg) && skipMsg.length > 40,
      'the refusal explains what is missing, in words the coach can act on', skipMsg.slice(0, 250));
    note(`skip-ahead refusal: ${skipMsg.slice(0, 200)}`);

    const badPhase = await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'bill-said: whatever',
      fields: { action: 'transition', to_phase: 'in_process' },
    });
    check(/unknown phase/.test(JSON.stringify(badPhase.data)), 'an invented phase name is named as such',
      JSON.stringify(badPhase.data).slice(0, 200));

    const noProv = await call('update_state', {
      target: `roles:${roleId}`, session_id: sess.session_id, provenance: 'coach reckons it is a strong fit',
      fields: { bill_fit: { verdict: 'no-go' } },
    });
    check(/judgment|say-so|bill-said/i.test(JSON.stringify(noProv.data)),
      'a judgment field without bill-said provenance is refused', JSON.stringify(noProv.data).slice(0, 250));

    const ghost = await call('update_state', {
      target: 'roles:no-such-role', session_id: sess.session_id, provenance: 'bill-said: whatever',
      fields: { title: 'x' },
    });
    check(!ghost.ok || ghost.data?.error, 'writing to a non-existent record is refused', JSON.stringify(ghost.data).slice(0, 250));

    const badTable = await call('update_state', {
      target: 'memories:ctrl', session_id: sess.session_id, provenance: 'bill-said: whatever', fields: { subject: 'x' },
    });
    check(!badTable.ok || badTable.data?.error, 'update_state cannot reach tables outside the funnel',
      JSON.stringify(badTable.data).slice(0, 250));
  }

  // Whatever was written must be findable.
  const found = await call('search_state', { query: 'Northwind' });
  check(JSON.stringify(found.data).includes('Northwind'), 'a funnel row is findable through search_state',
    JSON.stringify(found.data).slice(0, 250));
});

// ---------------------------------------------------------------- the index
await probe('Search index consistency', async () => {
  bump(await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'idx-probe', type: 'company', subject: 'Zephyr Dynamics',
      content: 'Indexing probe: Zephyr Dynamics raised a seed round.', source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  }));
  const hit = await call('inspect_memory', { query: 'Zephyr', limit: 5 });
  check(JSON.stringify(hit.data).includes('idx-probe'), 'a new memory is immediately readable');

  bump(await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'withdraw', id: 'idx-probe', type: 'company', subject: 'Zephyr Dynamics',
      content: 'x', source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  }));
  const gone = await call('inspect_memory', { query: 'Zephyr', limit: 5 });
  check(!JSON.stringify(gone.data?.memories ?? []).includes('idx-probe'),
    'a withdrawn memory stops appearing in the default view', JSON.stringify(gone.data).slice(0, 200));
  const all = await call('inspect_memory', { query: 'Zephyr', limit: 5, status: 'all' });
  check(JSON.stringify(all.data).includes('idx-probe'), 'a withdrawn memory is still reachable with status:all',
    JSON.stringify(all.data).slice(0, 200));
});

// ---------------------------------------------------------------- atomicity
await probe('Transaction atomicity', async () => {
  const before = await call('inspect_memory', { query: 'atomic', limit: 10, status: 'all' });
  const beforeCount = (before.data?.memories ?? []).length;
  const mixed = await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'atomic-good', type: 'context', subject: 'atomic probe good',
      content: 'valid row in a batch that also contains an invalid one', source_ids: [], confirmed: true, sensitive: false }],
    metrics: [{ action: 'upsert', id: 'atomic-bad', name: 'atomic probe metric', value_text: '1',
      scope: 'test', as_of: 'not a date', staleness_class: 'fast', source_ids: [] }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  bump(mixed);
  const after = await call('inspect_memory', { query: 'atomic', limit: 10, status: 'all' });
  const afterCount = (after.data?.memories ?? []).length;
  note(`batch with one bad row: memories went ${beforeCount} -> ${afterCount}, conflicts ${JSON.stringify(mixed.data?.conflicts ?? [])}`);
  check((mixed.data?.conflicts ?? []).length > 0, 'the bad row in a mixed batch is reported');
  check(afterCount > beforeCount, 'the good row in a mixed batch is not thrown away with it');

  const dupe = await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [
      { action: 'upsert', id: 'dupe-id', type: 'context', subject: 'first', content: 'first write', source_ids: [], confirmed: true, sensitive: false },
      { action: 'upsert', id: 'dupe-id', type: 'context', subject: 'second', content: 'second write', source_ids: [], confirmed: true, sensitive: false },
    ],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  bump(dupe);
  const which = await call('inspect_memory', { query: 'dupe-id', limit: 5, status: 'all' });
  note(`the same id twice in one batch resolves to: ${JSON.stringify((which.data?.memories ?? []).map((m) => m.subject))}`);
  check(dupe.ok, 'the same id twice in one batch does not error the whole save');
});

// ---------------------------------------------------------------- sensitive
await probe('Sensitive material', async () => {
  const unconfirmed = await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'sens-unconfirmed', type: 'person', subject: 'health note',
      content: 'SENSITIVEPROBE unconfirmed', source_ids: [], confirmed: false, sensitive: true }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  bump(unconfirmed);
  check((unconfirmed.data?.conflicts ?? []).some((c) => c.type === 'sensitive_requires_confirmation'),
    'sensitive material cannot be stored unconfirmed', JSON.stringify(unconfirmed.data).slice(0, 250));
  const leaked = await call('inspect_memory', { query: 'SENSITIVEPROBE', limit: 5, status: 'all' });
  check(!JSON.stringify(leaked.data).includes('SENSITIVEPROBE'), 'the refused sensitive row was not stored anyway',
    JSON.stringify(leaked.data).slice(0, 200));

  const confirmed = await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'sens-confirmed', type: 'person', subject: 'sensitive but confirmed',
      content: 'CONFIRMEDSENSITIVE content', source_ids: [], confirmed: true, sensitive: true }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  bump(confirmed);
  check(confirmed.ok && !(confirmed.data?.conflicts ?? []).length, 'sensitive material stores once confirmed');
  const marked = await call('inspect_memory', { query: 'sens-confirmed', limit: 5 });
  check(JSON.stringify(marked.data).includes('"sensitive":1') || JSON.stringify(marked.data).includes('"sensitive":true'),
    'stored sensitive rows keep their sensitive flag', JSON.stringify(marked.data).slice(0, 200));
});

// ---------------------------------------------------------------- commands
await probe('The hardcoded commands', async () => {
  for (const command of ['memory', 'pipeline', 'changes']) {
    const r = await call('bill_command', { command, session_id: sess.session_id });
    check(r.ok, `bill_command "${command}" runs`, JSON.stringify(r.data).slice(0, 200));
  }
  for (const command of ['recall', 'sources']) {
    const r = await call('bill_command', { command, session_id: sess.session_id, subject: 'Northwind' });
    check(r.ok, `bill_command "${command}" runs with a subject`, JSON.stringify(r.data).slice(0, 200));
    const bare = await call('bill_command', { command, session_id: sess.session_id });
    note(`"${command}" with no subject: ${bare.ok ? 'accepted' : 'refused'} ${JSON.stringify(bare.data).slice(0, 120)}`);
  }
  const forgetNothing = await call('bill_command', { command: 'forget', session_id: sess.session_id, subject: 'nothing-matches-this-string-at-all' });
  note(`"forget" with no match: ${JSON.stringify(forgetNothing.data).slice(0, 160)}`);

  bump(await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'forget-me', type: 'context', subject: 'FORGETTABLE thing',
      content: 'FORGETTABLE content to be deleted', source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  }));
  const forgot = await call('bill_command', { command: 'forget', session_id: sess.session_id, subject: 'FORGETTABLE' });
  check(forgot.ok, 'bill_command "forget" runs against a real record', JSON.stringify(forgot.data).slice(0, 200));
  const stillThere = await call('inspect_memory', { query: 'FORGETTABLE', limit: 5 });
  check(!JSON.stringify(stillThere.data?.memories ?? []).includes('forget-me'),
    'a forgotten record stops surfacing', JSON.stringify(stillThere.data).slice(0, 200));
});

// ---------------------------------------------------------------- evidence
await probe('Evidence assembly (get_context)', async () => {
  const ctx = await call('get_context', { question: 'what do we know about Northwind Robotics', session_id: sess.session_id });
  check(ctx.ok, 'get_context returns a briefing', JSON.stringify(ctx.data).slice(0, 200));
  const blob = JSON.stringify(ctx.data);
  check(blob.length > 50, 'the briefing is not empty', blob.slice(0, 200));
  const empty = await call('get_context', { question: 'zzzz nothing matches this at all zzzz', session_id: sess.session_id });
  check(empty.ok, 'get_context on a question with no evidence still answers cleanly', JSON.stringify(empty.data).slice(0, 200));
  note(`empty-question briefing keys: ${Object.keys(empty.data ?? {}).join(', ')}`);
});

// ---------------------------------------------------------------- fidelity
await probe('Round-trip fidelity', async () => {
  const nasty = 'Ünïcödé 👍 "quoted" \'single\' \\backslash\\ \n newline \t tab — em dash • bullet 中文';
  bump(await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'fidelity-probe', type: 'context', subject: 'fidelity',
      content: nasty, source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  }));
  const back = await call('inspect_memory', { query: 'fidelity-probe', limit: 3 });
  const stored = (back.data?.memories ?? [])[0]?.content ?? '';
  check(stored === nasty, 'content survives the round trip byte for byte',
    `stored ${JSON.stringify(stored).slice(0, 120)}`);

  const tooLong = await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'oversize-probe', type: 'context', subject: 'oversize',
      content: 'A'.repeat(19_000), source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  });
  check(!tooLong.ok, 'content past the 10k ceiling is refused rather than silently truncated',
    JSON.stringify(tooLong.data).slice(0, 200));
  check(/maxLength|10000|too long/i.test(JSON.stringify(tooLong.data)), 'the refusal names the limit',
    JSON.stringify(tooLong.data).slice(0, 200));

  const long = 'A'.repeat(9_000);
  bump(await call('save_coaching_state', {
    session_id: sess.session_id, expected_session_version: ver,
    memories: [{ action: 'upsert', id: 'long-probe', type: 'context', subject: 'long content',
      content: long, source_ids: [], confirmed: true, sensitive: false }],
    session: { status: 'active', evidence_ids: [], open_questions: [] },
  }));
  const backLong = await call('inspect_memory', { query: 'long-probe', limit: 3 });
  const storedLong = (backLong.data?.memories ?? [])[0]?.content ?? '';
  check(storedLong.length === long.length, 'long content is not truncated in storage',
    `stored ${storedLong.length} of ${long.length}`);
});

child.kill();
console.log('');
if (notes.length) { console.log('observations:'); for (const n of notes) console.log(`  - ${n}`); console.log(''); }
if (stderr.trim()) console.log(`stderr:\n${stderr.trim().slice(0, 600)}\n`);
console.log(failures === 0 ? 'RUNTIME PROBES PASSED' : `RUNTIME PROBES FAILED: ${failures}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
