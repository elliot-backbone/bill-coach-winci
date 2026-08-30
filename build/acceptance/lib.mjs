// Shared helpers for the Bill Jennings Coach 2.1.2 Windows acceptance adapters (T-WIN-002..005).
//
// Everything here is evidence plumbing: run a command with bounded time and captured output,
// hash files, drive the MCP server over stdio, capture the exact target identity through the
// candidate's own acceptance harness, and write JSON. The adapters are Node so they can be
// dry-run on macOS in a sandbox home; the parts that only exist on Windows (user PATH in the
// registry, mandatory file locks, CIM fingerprint, junctions) are guarded by `isWindows` and
// reported as not exercised elsewhere, never faked.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const isWindows = process.platform === 'win32';
export const nowIso = () => new Date().toISOString();

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
export function sha256File(p) { return sha256(fs.readFileSync(p)); }
export function sha256Text(s) { return sha256(Buffer.from(String(s), 'utf8')); }

/** Relative-path -> sha256 map over a directory (files only, sorted, POSIX separators). */
export function hashTree(root, { skip = () => false } = {}) {
  const out = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (skip(rel, e)) continue;
      if (e.isSymbolicLink()) { out[rel] = { kind: 'link', target: fs.readlinkSync(p) }; continue; }
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[rel] = { kind: 'file', sha256: sha256File(p), size: fs.statSync(p).size };
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Bounded synchronous command. Output is captured, never printed, so private material stays out of logs. */
export function run(cmd, args, { cwd, env, timeoutMs = 120000, input, shell = false } = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, env: { ...process.env, ...(env ?? {}) }, encoding: 'utf8', timeout: timeoutMs, input, shell,
    maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return {
    cmd: [cmd, ...args].join(' '), status: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT',
    error: r.error ? String(r.error.message) : null,
    stdout: r.stdout ?? '', stderr: r.stderr ?? '', durationMs: Date.now() - started,
  };
}

/** The installer contract is one stdout line; stderr carries Node warnings. */
export function firstLine(s) { return String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ''; }
export function lastLine(s) { const ls = String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); return ls[ls.length - 1] ?? ''; }

/** Only ok/FAIL tally lines and banners from a suite log — never the suite's data output. */
export function tallyLines(s) {
  return String(s ?? '').split(/\r?\n/).filter((l) => /^\s*(ok|FAIL)\s/.test(l) || /(PASSED|FAILED|ERROR)/.test(l)).map((l) => l.trimEnd());
}

/** SHA-256 via PowerShell Get-FileHash (pwsh first, then Windows PowerShell). Returns lowercase hex or null. */
export function psFileHash(file) {
  if (!isWindows) return null;
  const script = `(Get-FileHash -LiteralPath '${file.replace(/'/g, "''")}' -Algorithm SHA256).Hash`;
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const r = run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 180000 });
    const m = (r.stdout || '').match(/[0-9A-Fa-f]{64}/);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Read the persisted USER PATH exactly as stored (Windows only). */
export function readUserPath() {
  if (!isWindows) return null;
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.Write([Environment]::GetEnvironmentVariable('Path','User'))"], { timeoutMs: 60000 });
  return r.stdout ?? '';
}
/** Set the persisted USER PATH byte-exactly, passing the value through a file so no shell quoting touches it. */
export function setUserPath(value) {
  if (!isWindows) return false;
  const f = path.join(os.tmpdir(), `user-path-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(f, value, 'utf8');
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('Path', [IO.File]::ReadAllText('${f.replace(/'/g, "''")}'), 'User')`], { timeoutMs: 60000 });
  fs.rmSync(f, { force: true });
  return r.status === 0;
}

/** PowerShell, Windows only. Returns the run() record. */
export function ps(script, opts = {}) {
  if (!isWindows) return { status: null, stdout: '', stderr: 'not windows', notExercised: 'requires windows' };
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);
}

/** Start a PowerShell that holds an exclusive (FileShare.None) handle on a file until killed. Windows only. */
export function holdFileLock(file) {
  if (!isWindows) return null;
  const script = `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output 'LOCKED'; [Console]::Out.Flush(); while($true){Start-Sleep -Seconds 1}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return child;
}
export async function waitForLine(child, needle, timeoutMs = 15000) {
  if (!child) return false;
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes(needle)) { clearTimeout(t); resolve(true); } });
    child.on('exit', () => { clearTimeout(t); resolve(false); });
  });
}
export function killTree(child) {
  if (!child) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- claude + node identity
export function resolveOnPath(name) {
  const exts = isWindows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      const P = path.join(dir, name + ext);
      if (fs.existsSync(P) && fs.statSync(P).isFile()) return P;
    }
  }
  return null;
}
export function claudeIdentity() {
  const bin = resolveOnPath('claude');
  if (!bin) return { bin: null, version: null, readable: false };
  const r = isWindows ? run('cmd.exe', ['/c', 'claude --version'], { timeoutMs: 30000 }) : run(bin, ['--version'], { timeoutMs: 30000 });
  const m = (r.stdout + r.stderr).match(/(\d+\.\d+\.\d+)/);
  return { bin, binSha256: sha256File(bin), version: m ? m[1] : null, readable: Boolean(m), raw: (r.stdout + r.stderr).trim().slice(0, 200), minimumFloorEnforced: false };
}
export function nodeIdentity() {
  return { bin: process.execPath, binSha256: sha256File(process.execPath), version: process.versions.node, major: Number(process.versions.node.split('.')[0]), sqlite: process.versions.sqlite ?? null };
}

/** Windows image fingerprint (E01). On other platforms, the equivalent uname facts. */
export function fingerprint() {
  const base = { platform: process.platform, arch: process.arch, release: os.release(), hostname: os.hostname(), cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576), locale: Intl.DateTimeFormat().resolvedOptions().locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, userProfile: os.homedir(), tmp: os.tmpdir(), runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null };
  if (!isWindows) return base;
  const r = ps(`$o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_ComputerSystem; $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"; $u=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System').EnableLUA; $av=(Get-MpComputerStatus -ErrorAction SilentlyContinue); [pscustomobject]@{ caption=$o.Caption; version=$o.Version; build=$o.BuildNumber; arch=$o.OSArchitecture; ps=$PSVersionTable.PSVersion.ToString(); model=$c.Model; manufacturer=$c.Manufacturer; virtual=($c.Model -match 'Virtual'); fs=$d.FileSystem; freeGB=[math]::Round($d.FreeSpace/1GB,1); uac=$u; defenderRealtime=$av.RealTimeProtectionEnabled; controlledFolderAccess=(Get-MpPreference -ErrorAction SilentlyContinue).EnableControlledFolderAccess; pathext=$env:PATHEXT; userPathLength=([Environment]::GetEnvironmentVariable('Path','User')).Length; longPathsEnabled=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem').LongPathsEnabled } | ConvertTo-Json -Compress`, { timeoutMs: 60000 });
  let win = null;
  try { win = JSON.parse(r.stdout.trim()); } catch { win = { raw: r.stdout.slice(0, 500), err: r.stderr.slice(0, 300) }; }
  return { ...base, windows: win };
}

// ---------------------------------------------------------------- package + harness imports
export async function importInstaller(pkgRoot) {
  return import(pathToFileURL(path.join(pkgRoot, 'install', 'install.mjs')).href);
}
export async function importHarness(repo) {
  return import(pathToFileURL(path.join(repo, 'estate', 'testing', 'acceptance.mjs')).href);
}
/** Exact target identity via the candidate's own harness. */
export async function identityOf(repo) {
  const h = await importHarness(repo);
  const loaded = h.loadRegistry(path.join(repo, 'estate', 'testing', 'acceptance-tasks.json'));
  const basis = h.captureBasis(repo, loaded.registry, loaded.registryPath);
  const digest = h.targetIdentityDigest(basis);
  return {
    targetIdentityDigest: digest, planHash: basis.planHash, registryRawSha256: basis.registryRawSha256,
    authorityDigest: basis.authorityDigest, gitHead: basis.gitHead, gitTree: basis.gitTree,
    gitStatusSha256: basis.gitStatusSha256, gitWorktreeDigest: basis.gitWorktreeDigest,
    archiveSha256: basis.archiveSha256, packageManifestSha256: basis.packageManifestSha256, release: basis.release,
  };
}

/** Installer/uninstaller run with the one-line contract. `home` isolates via BILL_COACH_HOME when not the real home. */
export function installerRun(pkgRoot, script, { home, args = [], extraEnv = {}, timeoutMs = 600000 } = {}) {
  const env = { ...extraEnv };
  if (home && home !== os.homedir()) env.BILL_COACH_HOME = home;
  const r = run(process.execPath, [path.join('install', script), ...args], { cwd: pkgRoot, env, timeoutMs });
  return { ...r, line: lastLine(r.stdout) };
}

export async function pathsFor(pkgRoot, home) {
  const m = await importInstaller(pkgRoot);
  return { P: m.coachPaths(home), binDir: m.defaultLauncherDir(home), EXPECTED_TOOLS: m.EXPECTED_TOOLS, m };
}

/** Find the launcher the installer wrote (Windows: fixed dir; POSIX: first PATH dir holding it, else default). */
export function findLauncher(binDirDefault) {
  const name = isWindows ? 'coach.cmd' : 'coach';
  for (const dir of [binDirDefault, ...(process.env.PATH || '').split(path.delimiter)]) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { shim: p, binDir: dir };
  }
  return { shim: null, binDir: binDirDefault };
}

export function pathWith(binDir) { return `${binDir}${path.delimiter}${process.env.PATH || ''}`; }

// ---------------------------------------------------------------- MCP over stdio
/** initialize -> notifications/initialized -> tools/list against a server entry. */
export function mcpProbe(serverPath, dataDir, { timeoutMs = 20000, nodeBin = process.execPath } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(nodeBin, [serverPath], { env: { ...process.env, BILL_COACH_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = ''; let done = false;
    const result = { serverPath, dataDir, ok: false, serverInfo: null, protocolVersion: null, tools: [], toolCount: 0, protocolClean: true, error: null, durationMs: 0 };
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      result.durationMs = Date.now() - started;
      for (const line of out.split(/\r?\n/).filter(Boolean)) {
        let msg; try { msg = JSON.parse(line); } catch { result.protocolClean = false; continue; }
        if (msg.id === 1 && msg.result) { result.serverInfo = msg.result.serverInfo ?? null; result.protocolVersion = msg.result.protocolVersion ?? null; }
        if (msg.id === 2 && msg.result) { result.tools = (msg.result.tools ?? []).map((t) => t.name).sort(); result.toolCount = result.tools.length; }
        if (msg.error) result.error = JSON.stringify(msg.error).slice(0, 300);
      }
      result.ok = Boolean(result.serverInfo) && result.toolCount > 0 && result.protocolClean;
      result.stderrHead = err.slice(0, 300);
      resolve(result);
    };
    const timer = setTimeout(() => { result.error = 'timeout'; killTree(child); finish(); }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      if (/"id":\s*2/.test(out) && out.endsWith('\n')) { try { child.stdin.end(); } catch { /* closed */ } }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', finish);
    child.on('error', (e) => { result.error = String(e.message); finish(); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance-adapter', version: '2.1.2' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}

/** `claude mcp list` as the client sees the given config dir. Needs no sign-in. */
export function claudeMcpList(configDir, { timeoutMs = 120000 } = {}) {
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const r = isWindows
    ? run('cmd.exe', ['/c', 'claude mcp list'], { env, timeoutMs })
    : run(resolveOnPath('claude') ?? 'claude', ['mcp', 'list'], { env, timeoutMs });
  const text = `${r.stdout}\n${r.stderr}`;
  const line = text.split(/\r?\n/).find((l) => /bill-coach/.test(l)) ?? '';
  return {
    status: r.status, text: text.trim(), line: line.trim(),
    sees: /bill-coach/.test(text),
    connected: /bill-coach.*(Connected|✔|✓)/.test(text) && !/bill-coach.*(Failed|✗|✘|Disconnected)/.test(text),
    otherServers: text.split(/\r?\n/).filter((l) => /^\s*[\w.-]+:\s/.test(l) && !/bill-coach/.test(l) && !/Checking|health/i.test(l)).map((l) => l.trim()),
  };
}

// ---------------------------------------------------------------- sqlite helpers
export async function sqlite() { return (await import('node:sqlite')).DatabaseSync; }
export async function withDb(file, fn, { readOnly = false } = {}) {
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file, { readOnly });
  try { return await fn(db); } finally { db.close(); }
}
export function sidecarsUnder(root) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (/\.sqlite-(wal|shm|journal)$/.test(e.name)) found.push(p);
    }
  };
  walk(root);
  return found;
}

/** Evidence-record header shared by every file an adapter writes. */
export function header(taskId, identity, extra = {}) {
  return {
    schema: `bill-coach.acceptance-evidence/${taskId}/v1`, taskId, capturedAt: nowIso(),
    venue: isWindows ? 'github-windows-private' : `dry-run:${process.platform}`,
    target: identity ? { targetIdentityDigest: identity.targetIdentityDigest, archiveSha256: identity.archiveSha256, planHash: identity.planHash, gitHead: identity.gitHead, authorityDigest: identity.authorityDigest } : null,
    workflow: { repository: process.env.GITHUB_REPOSITORY ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, sha: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF ?? null, job: process.env.GITHUB_JOB ?? null },
    ...extra,
  };
}

export function verdictFile(evidenceDir, taskId, verdict, reasons) {
  return writeJson(path.join(evidenceDir, 'adapter-verdict.json'), { schema: 'bill-coach.adapter-verdict/v1', taskId, verdict, reasons, decidedAt: nowIso() });
}

/** Simple assertion ledger. */
export class Ledger {
  constructor(name) { this.name = name; this.checks = []; }
  check(ok, label, detail = '') { this.checks.push({ ok: Boolean(ok), label, detail: ok ? '' : String(detail).slice(0, 400) }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); return Boolean(ok); }
  get fails() { return this.checks.filter((c) => !c.ok); }
  get passed() { return this.fails.length === 0; }
  summary() { return { checks: this.checks.length, fails: this.fails.length, failed: this.fails.map((c) => c.label) }; }
}
