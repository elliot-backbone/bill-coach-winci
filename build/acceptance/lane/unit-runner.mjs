// Unit runner: executes ONE unit (a module capture or a card) as a sequence of separate `claude -p`
// processes, writing everything to disk the moment it exists. Never holds transcripts in memory
// beyond the current turn. Every turn produces:
//   turns/<unit>/turn-NN.request.json   what was sent (lane, argv, cwd, env keys, prompt sha256)
//   turns/<unit>/turn-NN.prompt.txt     the prompt bytes (Bill's turn or the persona)
//   turns/<unit>/turn-NN.stream.jsonl   Claude Code's full stream-json event log (API-level: every
//                                       assistant event, tool_use, tool_result, usage, cost)
//   turns/<unit>/turn-NN.reply.txt      the final attempt's reply text (what the lane records as the coach reply)
//   turns/<unit>/turn-NN.as-read.txt    every attempt's reply text in order, joined by a blank line: what Bill
//                                       actually read (a Stop-hook block does not hide streamed text; rc4, 2026-08-31)
//   turns/<unit>/turn-NN.stdout / .stderr
//   turns/<unit>/turn-NN.meta.json      exit, signal, timing, usage, model, tool calls, session id
//   diag/mcp/<unit>-turn-NN.jsonl       every JSON-RPC line between Claude Code and server.mjs (tap)
//   diag/claude-debug/<unit>-turn-NN/   the profile's debug logs written during this turn
//   state/<unit>/turn-NN.{before,after}.sqlite  VACUUM INTO snapshots of the live state
//   state/<unit>/turn-NN.delta.json     row-count deltas and new rows in the tables that matter
//   receipts.jsonl (lane-level, appended per turn), errors.jsonl (appended per failure)
//
// Usage: node unit-runner.mjs <manifest.json> <unit-index> <lane-dir> --profile <sealed profile> --package <expanded pkg> [--claude <bin>] [--cap n]

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MODULES, billPersona, HARD_ROTATION, BEAT_REPEATS } from './bill-sim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const argv = process.argv.slice(2);
const [manifestPath, unitIndexStr, laneDir] = argv;
const opt = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
const PROFILE = path.resolve(opt('--profile'));
const PKG = path.resolve(opt('--package'));
const CLAUDE = opt('--claude', IS_WIN ? 'claude.cmd' : 'claude');
const cap = Number(opt('--cap', 220));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const unit = manifest.units[Number(unitIndexStr)];
if (!unit) { console.error('no such unit'); process.exit(2); }
const unitKey = `${unit.kind}-${unit.id}-s${unit.seed}`;
const DATA = path.join(PROFILE, 'plugins', 'data', 'bill-career-coach-skills-dir');
const STATE_DB = path.join(DATA, 'state', 'coach.sqlite');
const SYSTEM_PROMPT = path.join(DATA, 'coach', 'system-prompt.md');
const dirs = { turns: path.join(laneDir, 'turns', unitKey), state: path.join(laneDir, 'state', unitKey), mcp: path.join(laneDir, 'diag', 'mcp'), debug: path.join(laneDir, 'diag', 'claude-debug'), work: path.join(laneDir, 'work', unitKey) };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const append = (file, obj) => fs.appendFileSync(path.join(laneDir, file), `${JSON.stringify({ t: now(), unitKey, ...obj })}\n`);
const turnsSoFar = () => (fs.existsSync(path.join(laneDir, 'turns.count')) ? fs.readFileSync(path.join(laneDir, 'turns.count'), 'utf8').split('\n').filter(Boolean).length : 0);
const NO_MCP = path.join(dirs.work, 'no-mcp.json'); fs.writeFileSync(NO_MCP, '{"mcpServers":{}}');
const coachCwd = path.join(dirs.work, 'coach'); const billCwd = path.join(dirs.work, 'bill');
fs.mkdirSync(coachCwd, { recursive: true }); fs.mkdirSync(billCwd, { recursive: true });

// ---------------------------------------------------------------- errors, detailed
function fail(cls, message, extra = {}) {
  const err = { schema: 'bill-coach.lane-error/v1', class: cls, message, unitKey, at: now(), ...extra, hint: HINTS[cls] ?? 'see the paths above' };
  fs.writeFileSync(path.join(dirs.turns, 'error.json'), `${JSON.stringify(err, null, 2)}\n`);
  append('errors.jsonl', err);
  console.error(`[${unitKey}] ${cls}: ${message}`);
  return err;
}
const HINTS = {
  AUTH: 'the sealed profile is not signed in: attach to the lane and run the sign-in relay (protocol §3.4)',
  CAP_REACHED: 'turn cap reached for this lane; raise --cap or add lanes',
  MODE_MISMATCH: 'the plan was sharded for more turns than this runner will produce: dispatch with hard=1 (workflow input), or re-shard the plan without HARD',
  CLAUDE_START: 'claude could not be spawned: check PATH/PATHEXT and that claude.cmd resolves in cmd.exe',
  CLAUDE_EXIT: 'claude exited non-zero: read turn-NN.stderr and diag/claude-debug/<unit>-turn-NN; MCP traffic is in diag/mcp',
  TIMEOUT: 'the turn exceeded its timeout; the process was killed; the stream so far is in turn-NN.stream.jsonl',
  NO_RESULT: 'stream ended without a result event: usually an auth wall, a hook block loop, or an MCP failure — inspect stream.jsonl and diag',
  STATE_SNAPSHOT: 'could not snapshot the state db; a server child may still hold it — see diag/processes',
  CARD_SETUP: 'card setup SQL failed against the live schema; the card is recorded as CAPTURE-INCOMPLETE',
  STATE_RESTORE: 'could not restore the pre-card state; subsequent cards may see contaminated state',
  GATE_FAILED_CLOSED: 'the emission gate held the reply after four retries; the unit refuses to accept an unverified reply (same rule as full-capture.mjs)',
  NUDGE_REPEATED: 'the gate held twice with the same reason; a repeated hold is terminal and the reply already emitted stands (recorded, not failed)',
  SESSION_CLOSE: 'could not close the active session row(s) at unit end; the next unit may inherit an open session and the stale-episode save nudge can fire in it',
};

// ---------------------------------------------------------------- environment (mirrors launcher/coach.mjs §8)
function sealedEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_WORKFLOWS: '1', CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_GROWTHBOOK: '1', CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '10000', CLAUDE_DISABLE_ADOPT: '1', CLAUDE_CODE_DISABLE_ARTIFACT: '1', CI: '1', ...extra };
  // Windows: the inherited key is `Path`; a plain-object spread keeps that case, so find it case-insensitively
  // and write back under the SAME key (a second `PATH` key would shadow it with a near-empty value).
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const nodeDir = path.dirname(process.execPath);
  const entries = String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
  if (!entries.includes(nodeDir)) env[pathKey] = [nodeDir, ...entries].join(path.delimiter);
  for (const k of Object.keys(env)) if (k !== pathKey && k.toUpperCase() === 'PATH') delete env[k];
  return env;
}
const REDACT = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
// ---------------------------------------------------------------- Stop-hook emulation
// THE STOP HOOK DOES NOT FIRE IN PRINT MODE (estate/build/full-capture.mjs, verified 2026-08-23; re-verified
// here on Windows and macOS under Claude Code 2.1.251: stream-json shows SessionStart only). Bill's launcher
// opens an interactive session where it does fire. So, exactly as the estate's harness does, every coach turn
// runs `lifecycle.mjs hook-stop <DATA>` against the transcript Claude Code just wrote, and a block is fed back
// as the next turn with the gate-retry marker, up to MAX_GATE_RETRIES. Every hold is recorded.
const GATE_RETRY_MARKER = '<bill-coach-gate-retry>';
const MAX_GATE_RETRIES = 4;
function findTranscript(sessionId) {
  if (!sessionId) return null;
  const root = path.join(PROFILE, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
// stopHookActive mirrors Claude Code production: false on the first Stop of a turn, true once the hook has
// already blocked and the model is answering the block (a retry). lifecycle.mjs reads stop_hook_active.
function runStopHook(transcriptPath, tag, stopHookActive = false) {
  const r = spawnSync(process.execPath, [path.join(DATA, 'runtime', 'lifecycle.mjs'), 'hook-stop', DATA], { input: JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: Boolean(stopHookActive) }), env: { ...process.env, BILL_COACH_DATA_DIR: DATA }, encoding: 'utf8', timeout: 120000, windowsHide: true });
  fs.writeFileSync(path.join(dirs.turns, `${tag}.hook-stop.json`), JSON.stringify({ transcriptPath, stopHookActive: Boolean(stopHookActive), exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2));
  if (r.error || r.status !== 0) return { error: r.error?.message ?? String(r.stderr || '').trim().slice(0, 300) };
  try { const out = JSON.parse(r.stdout || '{}'); return { block: out.decision === 'block' ? out.reason : null }; } catch (e) { return { error: `invalid hook JSON: ${e.message}` }; }
}
/** A coach turn as Bill would experience it: the raw turn, then the gate, then any retries the gate forces. */
const normaliseReason = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
/** Keep the transcript Claude Code wrote for this attempt next to the turn files (every coach attempt, retries included). */
function keepTranscript(sessionId, tag) {
  const transcript = findTranscript(sessionId);
  if (!transcript) return null;
  try { fs.copyFileSync(transcript, path.join(dirs.turns, `${tag}.transcript.jsonl`)); } catch (e) { append('errors.jsonl', { class: 'TRANSCRIPT_COPY', tag, message: e.message }); }
  return transcript;
}
// AS-READ (measured 2026-08-31, rc4): in Claude Code a Stop-hook block does not hide the text the model already
// streamed; the model continues and appends a corrected reply, so what Bill reads is the concatenation of every
// attempt. `reply` stays the final attempt (what the lane has always recorded); `replyAsRead` is every attempt's
// text in order, and `attemptCount` how many there were.
function coachTurn({ prompt, cwd, cont, label }) {
  let r = claudeTurn({ lane: 'coach', prompt, cwd, cont, label });
  const holds = [];
  const attempts = [{ tag: r.meta?.tag ?? null, reply: r.reply ?? '' }];
  let previousReason = null;
  for (let attempt = 0; r.ok; attempt += 1) {
    const transcript = keepTranscript(r.meta.sessionId, r.meta.tag);
    if (!transcript) { holds.push({ attempt, note: 'transcript not found; gate not run', sessionId: r.meta.sessionId }); break; }
    const g = runStopHook(transcript, r.meta.tag, attempt > 0);
    if (g.error) { holds.push({ attempt, error: g.error }); break; }
    if (!g.block) break;
    const reason = normaliseReason(g.block);
    if (previousReason !== null && reason === previousReason) {
      // A hold identical to the previous hold is terminal: the model is not going to answer it differently.
      // Record it, do not fail the turn, and let the reply already emitted stand.
      holds.push({ attempt, reason: g.block.slice(0, 400), repeated: true });
      fail('NUDGE_REPEATED', `gate repeated the same hold at attempt ${attempt}`, { tag: r.meta.tag, reason: g.block.slice(0, 300) });
      break;
    }
    previousReason = reason;
    holds.push({ attempt, reason: g.block.slice(0, 400) });
    if (attempt >= MAX_GATE_RETRIES) { r = { ...r, ok: false, gateFailedClosed: true }; fail('GATE_FAILED_CLOSED', `held after ${MAX_GATE_RETRIES} retries`, { tag: r.meta.tag, lastReason: g.block.slice(0, 300) }); break; }
    r = claudeTurn({ lane: 'coach', prompt: `${GATE_RETRY_MARKER}\n${g.block}`, cwd, cont: true, label: `${label}-after-gate-${attempt + 1}` });
    attempts.push({ tag: r.meta?.tag ?? null, reply: r.reply ?? '' });
  }
  if (!r.ok && r.meta?.sessionId) keepTranscript(r.meta.sessionId, r.meta.tag);
  r.holds = holds;
  r.replyAsRead = attempts.map((a) => a.reply).filter(Boolean).join('\n\n');
  r.attemptCount = attempts.length;
  fs.writeFileSync(path.join(dirs.turns, `${r.meta.tag}.as-read.txt`), r.replyAsRead);
  fs.writeFileSync(path.join(dirs.turns, `${r.meta.tag}.gate.json`), JSON.stringify({ label, holds, finalTag: r.meta.tag, attempts: attempts.map((a) => a.tag), attemptCount: r.attemptCount, asReadSha256: sha(r.replyAsRead), asReadBytes: Buffer.byteLength(r.replyAsRead), gateFailedClosed: Boolean(r.gateFailedClosed) }, null, 2));
  return r;
}

const redactedEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, REDACT.test(k) ? '<redacted>' : v]));

// ---------------------------------------------------------------- state snapshots
function snapshot(label) {
  const file = path.join(dirs.state, `${label}.sqlite`);
  try {
    const db = new DatabaseSync(STATE_DB);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    db.close();
    return { file, sha256: sha(fs.readFileSync(file)) };
  } catch (e) { fail('STATE_SNAPSHOT', e.message, { label }); return { file: null, error: e.message }; }
}
const WATCH = ['roles', 'role_events', 'interactions', 'offers', 'facts', 'memories', 'deliverables', 'learnings', 'commitments', 'narrative_coverage', 'cv_lines', 'debrief_capture', 'voice_deltas', 'sessions', 'settings', 'onboarding', 'positions_held', 'rehearsal_rounds'];
function rowDelta(beforeFile, afterFile) {
  if (!beforeFile || !afterFile) return null;
  const out = {};
  const b = new DatabaseSync(beforeFile, { readOnly: true }); const a = new DatabaseSync(afterFile, { readOnly: true });
  for (const t of WATCH) {
    try {
      const nb = b.prepare(`SELECT COUNT(*) c, COALESCE(MAX(rowid),0) m FROM "${t}"`).get(); const na = a.prepare(`SELECT COUNT(*) c FROM "${t}"`).get();
      const rows = a.prepare(`SELECT * FROM "${t}" WHERE rowid > ?`).all(nb.m);
      out[t] = { before: nb.c, after: na.c, newRows: rows.slice(0, 50) };
    } catch { /* table absent */ }
  }
  b.close(); a.close();
  return out;
}
// SESSION CLOSE AT UNIT END. In production one sitting is one session: the launcher opens it and it is closed when
// Bill leaves. The lane runs many units against one state DB with no launcher between them, so the session row
// unit N opened is still 'active' when unit N+1 starts; twenty minutes past its last checkpoint the product's
// stale-episode save nudge fires inside unit N+1, and the model's answer to the nudge replaces the coaching reply
// in the capture. Closing every active row at unit end keeps each unit one session, as production has it.
// Only columns that exist are set (PRAGMA first): status and updated_at always do, closed_at may not.
function closeActiveSessions(where) {
  let db = null;
  try {
    db = new DatabaseSync(STATE_DB);
    const cols = new Set(db.prepare('PRAGMA table_info("sessions")').all().map((c) => String(c.name)));
    if (!cols.has('status')) { const out = { where, closed: 0, note: 'sessions has no status column' }; append('receipts.jsonl', { kind: 'session-close', ...out }); return out; }
    const active = Number(db.prepare(`SELECT COUNT(*) n FROM sessions WHERE status = 'active'`).get()?.n ?? 0);
    if (active === 0) { const out = { where, closed: 0, at: now() }; append('receipts.jsonl', { kind: 'session-close', ...out }); return out; }
    const ts = now();
    const sets = ["status = 'closed'"]; const params = [];
    if (cols.has('closed_at')) { sets.push('closed_at = COALESCE(closed_at, ?)'); params.push(ts); }
    if (cols.has('updated_at')) { sets.push('updated_at = ?'); params.push(ts); }
    const res = db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE status = 'active'`).run(...params);
    const out = { where, closed: Number(res?.changes ?? active), at: ts, columnsSet: sets.map((x) => x.split(' ')[0]) };
    append('receipts.jsonl', { kind: 'session-close', ...out });
    return out;
  } catch (e) { fail('SESSION_CLOSE', e.message, { where }); return { where, error: e.message }; } finally { try { db?.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------- one claude turn = one process
let turnNo = 0;
// H8 (2.1.3 re-test): SessionStart and PostCompact hooks do not fire in `claude -p` (measured 2026-08-31: no hook
// context in any lane transcript), so the session-start contract the product injects at every interactive
// session start never reached the model in the lanes. Reproduce it the way the launcher would: run the hook
// once per unit and append its additionalContext to the system prompt file the coach lane already passes.
let SESSION_START_FILE = null;
function sessionStartPromptFile() {
  if (SESSION_START_FILE !== null) return SESSION_START_FILE;
  SESSION_START_FILE = false;
  try {
    const hook = spawnSync(process.execPath, [path.join(DATA, 'runtime', 'lifecycle.mjs'), 'hook-session-start'], { input: '{}', env: { ...process.env, BILL_COACH_DATA_DIR: DATA }, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const out = JSON.parse(hook.stdout || '{}');
    const context = out?.hookSpecificOutput?.additionalContext;
    fs.writeFileSync(path.join(dirs.turns, 'session-start.hook.json'), JSON.stringify({ exit: hook.status, stdout: hook.stdout, stderr: hook.stderr }, null, 2));
    if (typeof context === 'string' && context.trim()) {
      const base = fs.existsSync(SYSTEM_PROMPT) ? fs.readFileSync(SYSTEM_PROMPT, 'utf8') : '';
      const combined = path.join(dirs.turns, 'system-prompt.with-session-start.md');
      fs.writeFileSync(combined, `${base}\n\n${context}\n`);
      // Continuation turns: production injects the SessionStart context once; the "Begin by calling start_coach"
      // intent is its last paragraph. Measured rc5b: re-appending it on every -p process made retries re-open the
      // session and print the board. Continuation turns keep the boundary act, the law and the duties only.
      const paras = context.trim().split(/\n\n+/); const withoutIntent = paras.filter((x) => !/start_coach/.test(x)).join('\n\n');
      const combinedCont = path.join(dirs.turns, 'system-prompt.with-session-start.cont.md');
      fs.writeFileSync(combinedCont, `${base}\n\n${withoutIntent}\n`);
      SESSION_START_FILE = { first: combined, cont: combinedCont };
    }
  } catch (e) { fs.writeFileSync(path.join(dirs.turns, 'session-start.hook.json'), JSON.stringify({ error: e.message })); }
  return SESSION_START_FILE;
}
function claudeTurn({ lane, prompt, cwd, cont = false, label }) {
  turnNo += 1;
  const tag = `turn-${String(turnNo).padStart(2, '0')}`;
  if (turnsSoFar() >= cap) { fail('CAP_REACHED', `cap ${cap} reached before ${tag}`, { turn: tag }); process.exit(3); }
  fs.appendFileSync(path.join(laneDir, 'turns.count'), `${unitKey} ${tag} ${lane} ${now()}\n`);
  const base = path.join(dirs.turns, tag);
  fs.writeFileSync(`${base}.prompt.txt`, prompt);
  const mcpLog = path.join(dirs.mcp, `${unitKey}-${tag}.jsonl`);
  const args = lane === 'coach'
    ? ['-p', '--setting-sources', 'user', '--tools', 'WebSearch,WebFetch', ...((() => { const f = sessionStartPromptFile(); const pick = f ? (cont ? f.cont : f.first) : (fs.existsSync(SYSTEM_PROMPT) ? SYSTEM_PROMPT : null); return pick ? ['--append-system-prompt-file', pick] : []; })()), '--output-format', 'stream-json', '--verbose', '--debug', ...(cont ? ['--continue'] : [])]
    : ['-p', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', NO_MCP, '--output-format', 'stream-json', '--verbose'];
  const env = sealedEnv({ NODE_OPTIONS: `--import ${JSON.stringify(new URL('mcp-tap.mjs', import.meta.url).href)}`.replace(/"/g, ''), MCP_TAP_LOG: mcpLog });
  const before = snapshot(`${tag}.before`);
  const debugBefore = new Set(fs.existsSync(path.join(PROFILE, 'debug')) ? fs.readdirSync(path.join(PROFILE, 'debug')) : []);
  fs.writeFileSync(`${base}.request.json`, JSON.stringify({ schema: 'bill-coach.turn-request/v1', unitKey, tag, lane, label, cwd, argv: [CLAUDE, ...args], promptSha256: sha(prompt), promptBytes: Buffer.byteLength(prompt), envRedacted: redactedEnv({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, NODE_OPTIONS: env.NODE_OPTIONS, MCP_TAP_LOG: env.MCP_TAP_LOG, PATH: env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH')] }), startedAt: now(), stateBefore: before.sha256 }, null, 2));
  const started = Date.now();
  // Windows: claude is claude.cmd; Node refuses .cmd without a shell, and shell:true concatenates argv
  // unquoted (DEP0190). Hand cmd.exe one quoted command line, prompt via stdin (never on the command line).
  const q = (s) => (/[\s"&|<>^()]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const r = IS_WIN
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[q(CLAUDE), ...args.map(q)].join(' ')}"`], { cwd, env, input: prompt, encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024, windowsVerbatimArguments: true, windowsHide: true })
    : spawnSync(CLAUDE, args, { cwd, env, input: prompt, encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Date.now() - started;
  fs.writeFileSync(`${base}.stdout`, r.stdout ?? ''); fs.writeFileSync(`${base}.stderr`, r.stderr ?? '');
  // stream-json → structured meta
  const events = []; let result = null; let init = null; const toolCalls = []; const toolResults = [];
  const reviewDrafts = []; // every `draft` submitted to review_draft this turn, in stream order (the last one is what the gate verified)
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue; let ev; try { ev = JSON.parse(line); } catch { continue; }
    events.push(ev);
    if (ev.type === 'system' && ev.subtype === 'init') init = ev;
    if (ev.type === 'result') result = ev;
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) for (const c of ev.message.content) if (c.type === 'tool_use') { toolCalls.push({ id: c.id, name: c.name, input: c.input }); if (/review_draft$/.test(String(c.name)) && typeof c.input?.draft === 'string') reviewDrafts.push(c.input.draft); }
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) for (const c of ev.message.content) if (c.type === 'tool_result') toolResults.push({ tool_use_id: c.tool_use_id, is_error: c.is_error ?? false, contentHead: JSON.stringify(c.content).slice(0, 600) });
  }
  fs.writeFileSync(`${base}.stream.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  const reply = result?.result ?? '';
  fs.writeFileSync(`${base}.reply.txt`, reply);
  const debugDir = path.join(dirs.debug, `${unitKey}-${tag}`); fs.mkdirSync(debugDir, { recursive: true });
  if (fs.existsSync(path.join(PROFILE, 'debug'))) for (const f of fs.readdirSync(path.join(PROFILE, 'debug'))) if (!debugBefore.has(f) || f === 'latest') { try { fs.copyFileSync(path.join(PROFILE, 'debug', f), path.join(debugDir, f)); } catch { /* skip */ } }
  const after = snapshot(`${tag}.after`);
  let delta = null; try { delta = rowDelta(before.file, after.file); } catch (e) { delta = { error: e.message }; }
  fs.writeFileSync(path.join(dirs.state, `${tag}.delta.json`), `${JSON.stringify(delta, null, 2)}\n`);
  const meta = { schema: 'bill-coach.turn-meta/v1', unitKey, tag, lane, label, exit: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT', spawnError: r.error ? String(r.error.message) : null, durationMs, replySha256: sha(reply), replyBytes: Buffer.byteLength(reply), events: events.length, initTools: init?.tools ?? null, initMcpServers: init?.mcp_servers ?? null, model: init?.model ?? result?.modelUsage ? Object.keys(result?.modelUsage ?? {}) : null, sessionId: result?.session_id ?? init?.session_id ?? null, stopReason: result?.stop_reason ?? null, isError: result?.is_error ?? null, numTurns: result?.num_turns ?? null, usage: result?.usage ?? null, totalCostUsd: result?.total_cost_usd ?? null, durationApiMs: result?.duration_api_ms ?? null, toolCalls, toolResults, reviewDrafts, mcpLog: fs.existsSync(mcpLog) ? { file: mcpLog, lines: fs.readFileSync(mcpLog, 'utf8').split('\n').filter(Boolean).length } : null, stateBefore: before.sha256, stateAfter: after.sha256, stateChanged: before.sha256 !== after.sha256, endedAt: now() };
  fs.writeFileSync(`${base}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  append('receipts.jsonl', { tag, lane, label, exit: r.status, durationMs, replySha256: meta.replySha256, cost: meta.totalCostUsd, tools: toolCalls.map((t) => t.name), stateChanged: meta.stateChanged });
  if (r.error && r.error.code !== 'ETIMEDOUT') { fail('CLAUDE_START', r.error.message, { tag }); return { ok: false, reply, meta }; }
  if (meta.timedOut) { fail('TIMEOUT', `${tag} exceeded 600s`, { tag }); return { ok: false, reply, meta }; }
  if (/not logged in|please run \/login|authentication_error|invalid api key/i.test(`${r.stdout}\n${r.stderr}`)) { fail('AUTH', 'claude reports not logged in', { tag, stderrTail: String(r.stderr).split('\n').slice(-5) }); return { ok: false, reply, meta, auth: false }; }
  if (r.status !== 0) { fail('CLAUDE_EXIT', `${tag} exit ${r.status}`, { tag, stderrTail: String(r.stderr).split('\n').filter(Boolean).slice(-15) }); return { ok: false, reply, meta }; }
  if (!result) { fail('NO_RESULT', `${tag} produced no result event`, { tag, events: events.map((e) => e.type).slice(-10) }); return { ok: false, reply, meta }; }
  return { ok: true, reply, meta };
}

// ---------------------------------------------------------------- module unit (the estate's capture method, one process per turn)
async function runModule() {
  const mod = MODULES.find((m) => m.key === unit.id);
  if (!mod) { fail('CARD_SETUP', `unknown module ${unit.id}`); process.exit(1); }
  const profileJson = fs.existsSync(path.join(DATA, 'coach', 'principal-profile.json')) ? fs.readFileSync(path.join(DATA, 'coach', 'principal-profile.json'), 'utf8') : '{}';
  // 2026-09-01 (operator): every module runs at least MIN_EXCHANGES, so no module is
  // shallower than 24 turns (turns = 2 + 2*exchanges). Before this every module except two
  // ran TWO exchanges — six turns — which is why the census kept reporting that the module
  // lanes barely exercise the conduct half. The planner uses the identical floor.
  const MIN_EXCHANGES = Number(process.env.MIN_EXCHANGES || 11);
  const configured = unit.id === 'TIGHT_FIVE' ? Number(process.env.DEEP_TIGHT_FIVE || 12)
    : unit.id === 'CV_COACHED' ? Number(process.env.DEEP_CV_COACHED || 11)
    : Number(process.env.EXCHANGES || 0);
  const exchanges = process.env.HARD !== '0'
    ? Math.max(configured, MIN_EXCHANGES, HARD_ROTATION.length * BEAT_REPEATS)
    : Math.max(configured, MIN_EXCHANGES);
  // R12: a HARD-sharded plan dispatched without HARD=1 silently runs soft — the exact
  // silent-no-op class the estate already paid for once. The manifest's estTurns came
  // from shard-plan via the SAME formula, so a runner computing fewer turns than the
  // plan promises is in a different mode than the plan was balanced (and paid) for.
  const plannedTurns = Number(unit.estTurns ?? 0);
  if (plannedTurns > 2 + 2 * exchanges) {
    fail('MODE_MISMATCH', `manifest estTurns ${plannedTurns} exceeds this runner's ${2 + 2 * exchanges}; was the plan sharded with HARD=1 while this dispatch runs soft?`, { plannedTurns, computed: 2 + 2 * exchanges });
    process.exit(2);
  }
  let transcript = ''; const turns = [];
  // asRead: { text, attempts } for coach turns (coachTurn's replyAsRead/attemptCount); undefined for Bill's turns.
  const push = (who, text, meta, holds, asRead) => { turns.push({ who, text, meta, holds, asRead }); transcript += `${who.toUpperCase()}: ${text}\n\n`; fs.writeFileSync(path.join(dirs.turns, 'transcript.md'), transcript); };
  const asReadOf = (r) => ({ text: r.replyAsRead ?? r.reply ?? '', attempts: r.attemptCount ?? 1 });
  // Pushback beat: on every third exchange (i % 3 === 1) in the modules where Coach makes claims and numbers Bill
  // can dispute, the simulated Bill pushes back with no new evidence. The census measures whether Coach folds (C1).
  const PUSHBACK_MODULES = new Set(['NEGOTIATION_MODULE', 'OFFER_REVIEW', 'CV_COACHED', 'DEBRIEF_REVIEW']);
  // HARD MODE (operator, 2026-09-01: "Bill extremely challenging in each run, push Coach to
  // its limits of reasoning and style"). With HARD=1 every exchange carries a beat from the
  // rotation, so each of the twelve pressures lands at least once in a 24-turn module and no
  // two consecutive turns apply the same one; the seed offset varies the order across runs.
  // Off, the original sparse pushback stands.
  const HARD = process.env.HARD !== '0';
  const beatFor = (i) => {
    if (HARD) return HARD_ROTATION[(i + (unit.seed ?? 0)) % HARD_ROTATION.length];
    return PUSHBACK_MODULES.has(mod.key) && i % 3 === 1 ? 'pushback' : null;
  };
  // Operator: every beat fires at least BEAT_REPEATS times per module. The rotation is 24
  // beats long, so the module needs 24 * BEAT_REPEATS exchanges for the set to land evenly.
  // Consecutive turns never share a pressure because the rotation walks the whole set first.
  const hardExchanges = HARD_ROTATION.length * BEAT_REPEATS;
  let r = coachTurn({ prompt: mod.open, cwd: coachCwd, cont: false, label: `${mod.key}-01-open` });
  push('bill', mod.open); push('coach', r.reply, r.meta, r.holds, asReadOf(r)); if (!r.ok) return finishModule(mod, turns, false);
  for (let i = 0; i < exchanges; i += 1) {
    const beat = beatFor(i);
    const b = claudeTurn({ lane: 'bill', prompt: billPersona(transcript, mod.brief, profileJson.slice(0, 6000), beat), cwd: billCwd, label: `${mod.key}-bill-${i + 1}${beat ? `-${beat}` : ''}` });
    const billText = b.reply.trim(); if (!b.ok || !billText) { push('bill', billText || '(empty)', { ...b.meta, beat }); return finishModule(mod, turns, false); }
    push('bill', billText, { beat });
    r = coachTurn({ prompt: billText, cwd: coachCwd, cont: true, label: `${mod.key}-${String(i + 2).padStart(2, '0')}` });
    push('coach', r.reply, r.meta, r.holds, asReadOf(r)); if (!r.ok) return finishModule(mod, turns, false);
  }
  r = coachTurn({ prompt: mod.demand, cwd: coachCwd, cont: true, label: `${mod.key}-99-deliverable` });
  push('bill', mod.demand); push('coach', r.reply, { ...r.meta, deliverable: true }, r.holds, asReadOf(r));
  return finishModule(mod, turns, r.ok);
}
/** Dated coverage slots, read from the newest state snapshot this unit took (VACUUM INTO copies under dirs.state). */
function coverageSlotsDated() {
  const files = fs.readdirSync(dirs.state).filter((f) => f.endsWith('.sqlite')).map((f) => path.join(dirs.state, f));
  if (!files.length) return null;
  const newest = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m || (a.f < b.f ? 1 : -1))[0].f;
  let db = null;
  try {
    db = new DatabaseSync(newest, { readOnly: true });
    const cols = db.prepare('PRAGMA table_info("narrative_coverage")').all().map((c) => String(c.name));
    if (!cols.length) return null;
    // Prefer a column that names a date; fall back to a timestamp column ending in "at".
    const dateCol = cols.find((c) => /dated/i.test(c)) ?? cols.find((c) => /date/i.test(c)) ?? cols.find((c) => /at$/i.test(c));
    if (!dateCol) return null;
    const hasSlot = cols.includes('slot');
    const where = [`"${dateCol}" IS NOT NULL`, `TRIM(CAST("${dateCol}" AS TEXT)) <> ''`, ...(hasSlot ? ['"slot" IS NOT NULL'] : [])].join(' AND ');
    const row = db.prepare(`SELECT COUNT(*) n FROM "narrative_coverage" WHERE ${where}`).get();
    return Number(row?.n ?? 0);
  } catch (e) { append('errors.jsonl', { class: 'COVERAGE_COUNT', file: newest, message: e.message }); return null; } finally { try { db?.close(); } catch { /* already closed */ } }
}
/** The body Bill was shown: the draft the gate verified (last review_draft call of the turn), else the reply text, marked ungated. */
function displayedDeliverable(mod, t) {
  const drafts = t.meta?.reviewDrafts ?? [];
  if (drafts.length) return { kind: mod.key.toLowerCase(), body: drafts[drafts.length - 1] };
  return { kind: mod.key.toLowerCase(), body: t.text, ungated: true };
}
function finishModule(mod, turns, complete) {
  const sessionClose = closeActiveSessions('module-end'); // one unit is one session (see closeActiveSessions)
  const wrote = {}; // new rows across the unit, from per-turn deltas
  for (const f of fs.readdirSync(dirs.state).filter((x) => x.endsWith('.delta.json')).sort()) { const d = JSON.parse(fs.readFileSync(path.join(dirs.state, f), 'utf8')) || {}; for (const [t, v] of Object.entries(d)) if (v?.newRows?.length) wrote[t] = [...(wrote[t] ?? []), ...v.newRows]; }
  const session = { schema: 'bill-coach.capture-session/v1', id: unitKey, module: mod.key, title: mod.title, seed: unit.seed, complete, turns: turns.map((t) => ({ role: t.who, text: t.text, text_as_read: t.who === 'coach' ? (t.asRead?.text ?? t.text) : undefined, attempts: t.who === 'coach' ? (t.asRead?.attempts ?? 1) : undefined, kind: t.meta?.deliverable ? 'deliverable' : (mod.key === 'TIGHT_FIVE' && t.who === 'coach' ? 'interview' : undefined), beat: t.meta?.beat ?? undefined, saved: (wrote.deliverables ?? []).map((r) => ({ kind: r.kind, body_sha256: r.body_sha256 ?? (r.body ? sha(r.body) : null) })).filter((r) => r.body_sha256), displayed_deliverables: t.meta?.deliverable ? [displayedDeliverable(mod, t)] : undefined, cost: t.meta?.totalCostUsd, tools: t.meta?.toolCalls?.map((x) => x.name), gateHolds: t.holds?.filter((h) => h.reason).length ?? 0, gateNotes: t.holds?.filter((h) => h.note || h.error) ?? [] })), wrote_tables: Object.fromEntries(Object.entries(wrote).map(([k, v]) => [k, v.length])), coverage_slots_dated: coverageSlotsDated(), session_close: sessionClose };
  fs.mkdirSync(path.join(laneDir, 'captures'), { recursive: true });
  fs.writeFileSync(path.join(laneDir, 'captures', `${unitKey}.session.json`), `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(dirs.turns, 'wrote.json'), `${JSON.stringify(wrote, null, 2)}\n`);
  return complete ? 0 : 1;
}

// ---------------------------------------------------------------- card unit
const MONEY = /£\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b|\b\d{2,3},\d{3}\b/g; const PCT = /\b\d+(?:\.\d+)?\s?%/g; const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b/g;
function tokens(text) { return [...new Set([...(text.match(MONEY) ?? []), ...(text.match(PCT) ?? []), ...(text.match(DATE) ?? [])].map((t) => t.replace(/\s+/g, '').toLowerCase()))]; }
function stateTextBag(file) {
  const db = new DatabaseSync(file, { readOnly: true }); let bag = '';
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`).all().map((r) => r.name)) { try { for (const row of db.prepare(`SELECT * FROM "${t}"`).all()) bag += `\n${Object.values(row).filter((v) => typeof v === 'string').join(' ')}`; } catch { /* skip */ } }
  db.close(); return bag.toLowerCase().replace(/\s+/g, '');
}
function evaluateChecks(card, replies, ctx) {
  return card.checks.map((ch) => {
    const reply = replies[(ch.turn ?? replies.length) - 1] ?? '';
    if (ch.kind === 'text') { const subject = ch.exclude_lines ? reply.split('\n').filter((l) => !new RegExp(ch.exclude_lines, 'i').test(l)).join('\n') : reply; const n = (subject.match(new RegExp(ch.re, 'gim')) ?? []).length; const ok = (ch.min === undefined || n >= ch.min) && (ch.max === undefined || n <= ch.max); return { label: ch.label, kind: 'text', turn: ch.turn ?? replies.length, matches: n, min: ch.min, max: ch.max, ok }; }
    if (ch.kind === 'sql') { try { const db = new DatabaseSync(STATE_DB, { readOnly: true }); const row = db.prepare(ch.query.replace('{{card_started_at}}', ctx.startedAt)).get(); db.close(); const ok = ch.expect.n !== undefined ? row.n === ch.expect.n : ch.expect.n_min !== undefined ? row.n >= ch.expect.n_min : true; return { label: ch.label, kind: 'sql', row, expect: ch.expect, ok }; } catch (e) { return { label: ch.label, kind: 'sql', error: e.message, ok: false }; } }
    if (ch.kind === 'provenance') { const bag = ctx.bag + ctx.billText.toLowerCase().replace(/\s+/g, ''); const untraceable = tokens(reply).filter((t) => !bag.includes(t.replace('£', '£')) && !bag.includes(t.replace(/[£,]/g, ''))); return { label: ch.label, kind: 'provenance', tokens: tokens(reply), untraceable, ok: untraceable.length <= (ch.max ?? 0) }; }
    return { label: ch.label, ok: false, error: 'unknown check kind' };
  });
}
async function runCard() {
  // Decks merge: every cards-*.json beside this file (v1 quality deck, v2 behavioural deck). Ids are unique across decks.
  const deck = { cards: fs.readdirSync(HERE).filter((f) => /^cards-.*\.json$/.test(f)).sort().flatMap((f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')).cards ?? []) };
  const card = deck.cards.find((c) => c.id === unit.id);
  if (!card) { fail('CARD_SETUP', `unknown card ${unit.id}`); process.exit(1); }
  const startedAt = now();
  const pre = snapshot('card-pre');
  const setupOk = (() => { try { const db = new DatabaseSync(STATE_DB); for (const s of card.setup?.sql ?? []) db.exec(s); db.close(); return true; } catch (e) { fail('CARD_SETUP', e.message); return false; } })();
  const out = { schema: 'bill-coach.card-result/v1', card: card.id, family: card.family, title: card.title, promise: card.promise, seed: unit.seed, startedAt, setupOk, turns: [], checks: [], wrongCase: null, verdict: 'CAPTURE-INCOMPLETE' };
  const write = () => { fs.mkdirSync(path.join(laneDir, 'evidence', 'T-QUAL-004'), { recursive: true }); fs.writeFileSync(path.join(laneDir, 'evidence', 'T-QUAL-004', `card-${card.id}-s${unit.seed}.json`), `${JSON.stringify(out, null, 2)}\n`); };
  write();
  if (setupOk) {
    const replies = []; let billText = '';
    for (let i = 0; i < card.bill_turns.length; i += 1) {
      const r = coachTurn({ prompt: card.bill_turns[i], cwd: coachCwd, cont: i > 0, label: `${card.id}-${i + 1}` });
      billText += `\n${card.bill_turns[i]}`; replies.push(r.reply); out.turns.push({ bill: card.bill_turns[i], replySha256: r.meta.replySha256, ok: r.ok, cost: r.meta.totalCostUsd, tools: r.meta.toolCalls.map((t) => t.name), text_as_read: r.replyAsRead ?? r.reply ?? '', attempts: r.attemptCount ?? 1, asReadSha256: sha(r.replyAsRead ?? r.reply ?? '') }); write();
      if (!r.ok) { out.verdict = 'CAPTURE-INCOMPLETE'; write(); break; }
      if (i === card.bill_turns.length - 1) {
        const bag = stateTextBag(pre.file ?? STATE_DB);
        out.checks = evaluateChecks(card, replies, { startedAt, bag, billText });
        out.verdict = out.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
        write();
      }
    }
    // wrong case
    const wc = card.wrong_case;
    if (wc) {
      if (wc.synthetic_reply) {
        const synth = replies.slice(); synth[(wc.turn ?? synth.length) - 1] = wc.synthetic_reply;
        const checks = evaluateChecks(card, synth.length ? synth : [wc.synthetic_reply], { startedAt, bag: stateTextBag(pre.file ?? STATE_DB), billText });
        const anyFail = checks.some((c) => !c.ok);
        out.wrongCase = { mode: 'synthetic-reply', expect: wc.expect, checks, rejected: anyFail, verdict: anyFail ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' };
      } else if (wc.bill_turns) {
        try { const db = new DatabaseSync(STATE_DB); for (const s of wc.sql ?? []) db.exec(s); db.close(); } catch (e) { fail('CARD_SETUP', `wrong-case sql: ${e.message}`); }
        const wreplies = []; let wbill = '';
        for (let i = 0; i < wc.bill_turns.length; i += 1) { const r = coachTurn({ prompt: wc.bill_turns[i], cwd: path.join(dirs.work, 'coach-wrong'), cont: i > 0, label: `${card.id}-wrong-${i + 1}` }); wbill += `\n${wc.bill_turns[i]}`; wreplies.push(r.reply); if (!r.ok) break; }
        const checks = evaluateChecks(card, wreplies, { startedAt, bag: stateTextBag(pre.file ?? STATE_DB), billText: wbill });
        out.wrongCase = { mode: 'alternative-scenario', expect: wc.expect, note: wc.note, checks, exercised: true, differsFromMain: JSON.stringify(checks.map((c) => c.ok)) !== JSON.stringify(out.checks.map((c) => c.ok)) };
      }
      write();
    }
  }
  // one unit is one session (see closeActiveSessions): close what this card opened before the restore, and again
  // after it, since the restored pre-card state may itself carry an active session row from an earlier unit.
  out.sessionClose = { beforeRestore: closeActiveSessions('card-end'), afterRestore: null };
  write();
  // restore the pre-card state so cards do not contaminate each other
  if (pre.file) { let restored = false; for (let i = 0; i < 12 && !restored; i += 1) { try { for (const s of ['-wal', '-shm']) if (fs.existsSync(STATE_DB + s)) fs.rmSync(STATE_DB + s); fs.copyFileSync(pre.file, STATE_DB); restored = true; } catch { await new Promise((res) => setTimeout(res, 500)); } } if (!restored) fail('STATE_RESTORE', 'pre-card state could not be restored'); out.stateRestored = restored; if (restored) out.sessionClose.afterRestore = closeActiveSessions('card-post-restore'); write(); }
  return out.verdict === 'PASS' ? 0 : 1;
}

fs.mkdirSync(path.join(dirs.work, 'coach-wrong'), { recursive: true });
const code = unit.kind === 'module' ? await runModule() : await runCard();
process.exit(code);
