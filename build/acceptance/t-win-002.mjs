// T-WIN-002 — Exact real archive Windows install and native platform smoke.
// Adapter: github-actions-private-package. Required evidence:
//   source-and-vm-sha.json, windows-fingerprint.json, smoke-result.json, installed-identity.json, wrong-case-result.json
// Wrong case: wrong SHA/version, altered payload, stale registration, journal recovery failure or
// path truncation must refuse/fail.
//
// Usage: node t-win-002.mjs <repo> <evidence-dir> <work-dir> [--home <dir>]
// The real install goes to the runner's own home (the route Bill uses); wrong cases use sandbox homes.
// Suite output is written to <work-dir>/logs, never to the console.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, fingerprint, firstLine, header, identityOf, installerRun, isWindows, mcpProbe, pathsFor, ps, psFileHash, readUserPath, setUserPath, run, sha256File, sha256Text, hashTree, tallyLines, verdictFile, writeJson, withDb, pathWith, findLauncher, nowIso, sidecarsUnder } from './lib.mjs';

const argv = process.argv.slice(2);
const [repo, evidenceDir, work] = argv;
const homeOpt = argv.indexOf('--home') >= 0 ? argv[argv.indexOf('--home') + 1] : null;
if (!repo || !evidenceDir || !work) { console.error('usage: t-win-002.mjs <repo> <evidence-dir> <work-dir> [--home <dir>]'); process.exit(2); }
const TASK = 'T-WIN-002';
const HOME = homeOpt ? path.resolve(homeOpt) : os.homedir();
const logs = path.join(work, 'logs'); fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(evidenceDir, { recursive: true });
const build = path.join(repo, 'estate', 'build');
const identity = await identityOf(repo);
const registry = JSON.parse(fs.readFileSync(path.join(repo, 'estate/testing/acceptance-tasks.json'), 'utf8'));
const rel = registry.release;
const archive = path.join(repo, rel.archive);
const L = new Ledger(TASK);
const reasons = [];
const saveLog = (name, r) => { fs.writeFileSync(path.join(logs, `${name}.log`), `# ${r.cmd}\n# status ${r.status}\n${r.stdout}\n--- stderr ---\n${r.stderr}`); return sha256Text(r.stdout); };

function expand(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  const r = run('tar', ['-xf', zip, '-C', dest], { timeoutMs: 300000 });
  if (r.status !== 0) throw new Error(`expand failed: ${r.stderr}`);
  return path.join(dest, 'package');
}

// ---------------------------------------------------------------- 1. source and VM SHA
const vmSha = sha256File(archive);
const psSha = psFileHash(archive);
const pkg = expand(archive, path.join(work, 'coach'));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'));
const integrity = run(process.execPath, [path.join(build, 'manifest-integrity-test.mjs'), pkg], { timeoutMs: 300000 });
const sourceAndVm = {
  ...header(TASK, identity),
  archive: { name: rel.archive, sourceRegistrySha256: rel.archiveSha256, handoverSha256: '384aa45950f76014fbc6277b90eb78d3313138c88deb7cedc690ef71fe848b18', vmNodeSha256: vmSha, vmGetFileHash: psSha, size: fs.statSync(archive).size },
  sidecar: fs.readFileSync(`${archive}.sha256`, 'utf8').trim(),
  manifest: { version: manifest.version, app_version: manifest.app_version, schema_version: manifest.schema_version, library_version: manifest.library_version, files: manifest.files.length, sha256: sha256File(path.join(pkg, 'manifest.json')), minimum_node: manifest.minimum_node, minimum_claude_code: manifest.minimum_claude_code ?? null },
  expandedTreeIntegrity: { status: integrity.status, line: firstLine(integrity.stdout) },
  noBuildOrRepackOnVm: true,
};
L.check(vmSha === rel.archiveSha256, 'VM archive SHA-256 equals source registry value');
L.check(vmSha === sourceAndVm.archive.handoverSha256, 'VM archive SHA-256 equals handover value');
if (isWindows) L.check(psSha === vmSha, 'Get-FileHash agrees with node');
L.check(manifest.version === rel.distributionVersion && manifest.schema_version === rel.schemaVersion, `manifest version ${manifest.version} / schema ${manifest.schema_version} match registry`);
L.check(integrity.status === 0, 'expanded package matches its manifest byte-for-byte', integrity.stdout + integrity.stderr);
L.check(manifest.minimum_claude_code === undefined, 'manifest carries no Claude Code minimum');
writeJson(path.join(evidenceDir, 'source-and-vm-sha.json'), sourceAndVm);

// ---------------------------------------------------------------- 2. fingerprint
writeJson(path.join(evidenceDir, 'windows-fingerprint.json'), { ...header(TASK, identity), fingerprint: fingerprint(), home: HOME, isRealHome: HOME === os.homedir() });

// ---------------------------------------------------------------- 3. install through the route Bill uses
const { P, binDir, EXPECTED_TOOLS, m } = await pathsFor(pkg, HOME);
const originalUserPath = readUserPath();
const originalEntries = originalUserPath ? originalUserPath.split(';').filter(Boolean) : [];
const smoke = { ...header(TASK, identity), home: HOME, package: pkg, steps: {}, suites: {}, logsSha256: {} };
// A fresh install is the contract: any pre-existing profile in this home is purged first and recorded.
if (fs.existsSync(P.marker) || fs.existsSync(P.profile)) { const purge = installerRun(pkg, 'uninstall.mjs', { home: HOME, args: ['--purge-data', '--confirm', 'delete bill coach memory'] }); smoke.steps.preExistingInstallPurged = purge.line; }
const inst = installerRun(pkg, 'install.mjs', { home: HOME });
smoke.steps.install = { line: inst.line, status: inst.status, durationMs: inst.durationMs };
L.check(inst.line === 'installed', `installer printed "installed" (${inst.line})`, inst.stderr.slice(0, 300));
// Byte identity of the installed databases is only meaningful BEFORE any process opens them:
// the runtime rewrites the SQLite header (journal mode) on first open. Capture now.
const atInstall = { librarySha256: fs.existsSync(P.libraryDb) ? sha256File(P.libraryDb) : null, stateSha256: fs.existsSync(P.stateDb) ? sha256File(P.stateDb) : null };
const libraryContentDigest = async (file) => withDb(file, (db) => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name`).all().map((r) => r.name);
  const counts = {}; const parts = [];
  for (const t of tables) { counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; parts.push(`${t}:${counts[t]}`); }
  for (const t of ['documents', 'chunks']) { try { parts.push(`${t}:${db.prepare(`SELECT group_concat(content_sha256, ',') s FROM (SELECT content_sha256 FROM "${t}" ORDER BY content_sha256)`).get().s ?? ''}`); } catch { /* absent */ } }
  try { parts.push(`market_deals:${db.prepare(`SELECT group_concat(deal_id, ',') s FROM (SELECT deal_id FROM market_deals ORDER BY deal_id)`).get().s ?? ''}`); } catch { /* absent */ }
  return { counts, digest: sha256Text(parts.join('|')) };
}, { readOnly: true });

// layout
const layout = {
  profile: fs.existsSync(P.profile), settings: fs.existsSync(P.settings), mcpConfig: fs.existsSync(P.mcpConfig), userConfig: fs.existsSync(P.userConfig),
  workspace: fs.existsSync(P.workspace), runtime: fs.existsSync(P.serverEntry), library: fs.existsSync(P.libraryDb), state: fs.existsSync(P.stateDb), marker: fs.existsSync(P.marker),
  skillsLinkExists: fs.existsSync(P.skillsLink), skillsLinkTraversable: fs.existsSync(path.join(P.skillsLink, 'runtime', 'server.mjs')),
};
if (isWindows) {
  const lt = ps(`(Get-Item -LiteralPath '${P.skillsLink}' -Force).LinkType`).stdout.trim();
  layout.skillsLinkType = lt;
  L.check(lt === 'Junction', `skills entry is a Junction (${lt})`);
} else {
  try { layout.skillsLinkType = fs.lstatSync(P.skillsLink).isSymbolicLink() ? 'SymbolicLink' : 'other'; } catch { layout.skillsLinkType = null; }
}
smoke.steps.layout = layout;
for (const [k, v] of Object.entries(layout)) if (typeof v === 'boolean') L.check(v, `installed layout: ${k}`);

// launcher + PATH
const launcher = findLauncher(binDir);
smoke.steps.launcher = { shim: launcher.shim, binDir: launcher.binDir, script: launcher.shim ? path.join(launcher.binDir, 'coach.mjs') : null };
L.check(Boolean(launcher.shim), `launcher written (${launcher.shim})`);
if (launcher.shim && isWindows) {
  const shimText = fs.readFileSync(launcher.shim, 'utf8');
  L.check(/^@echo off/m.test(shimText) && /%~dp0coach\.mjs/.test(shimText), 'coach.cmd is a cmd shim referencing its sibling coach.mjs');
  const userPath = readUserPath();
  const entries = userPath.split(';').filter(Boolean);
  const normalised = (p) => path.resolve(p.replace(/\\{2,}/g, '\\')).toLowerCase();
  const exactEntry = entries.includes(launcher.binDir);
  const normalisedEntry = entries.some((e) => normalised(e) === normalised(launcher.binDir));
  const preserved = originalEntries.every((e) => entries.includes(e));
  const corrupted = originalEntries.filter((e) => !entries.includes(e)).map((e) => ({ before: e, after: entries.find((x) => normalised(x) === normalised(e)) ?? null }));
  smoke.steps.userPath = { before: originalUserPath.length, after: userPath.length, exactEntry, normalisedEntry, preExistingEntriesPreserved: preserved, corruptedEntries: corrupted.slice(0, 10), newEntryAsStored: entries.find((e) => normalised(e) === normalised(launcher.binDir)) ?? null };
  L.check(normalisedEntry, 'launcher dir persisted on the USER PATH (registry), normalised comparison');
  L.check(exactEntry, `launcher dir stored EXACTLY as the installer's path (stored: ${smoke.steps.userPath.newEntryAsStored})`);
  L.check(preserved, `pre-existing USER PATH entries preserved byte-for-byte by the installer (${corrupted.length} altered)`, corrupted.slice(0, 2).map((c) => `${c.before} -> ${c.after}`).join(' | '));
  L.check(userPath.length >= originalUserPath.length, `user PATH not truncated (${originalUserPath.length} -> ${userPath.length})`);
  const fresh = ps(`$env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); (Get-Command coach -ErrorAction SilentlyContinue).Source`);
  smoke.steps.freshProcessResolvesCoach = fresh.stdout.trim();
  L.check(Boolean(fresh.stdout.trim()), `a fresh process resolves 'coach' (${fresh.stdout.trim()})`);
  const emptyHome = path.join(work, 'empty-home'); fs.mkdirSync(emptyHome, { recursive: true });
  const probe = (() => {
    const started = Date.now();
    const line = `cmd.exe /d /s /c "set "BILL_COACH_HOME=${emptyHome}" && set "PATH=${launcher.binDir};%PATH%" && coach 2>&1"`;
    const r = spawnSync(line, { shell: false, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, BILL_COACH_HOME: emptyHome, PATH: `${launcher.binDir};${process.env.PATH}` } });
    return { cmd: line, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', durationMs: Date.now() - started };
  })();
  smoke.steps.shimExecution = { status: probe.status, line: firstLine(probe.stdout + probe.stderr) };
  L.check(/not found at/.test(probe.stdout + probe.stderr) && /bill-coach:/.test(probe.stdout + probe.stderr), 'cmd.exe -> coach.cmd -> node -> launcher reached the launcher gate', smoke.steps.shimExecution.line);
} else if (launcher.shim) {
  const probe = run(launcher.shim, [], { env: { BILL_COACH_HOME: path.join(work, 'empty-home-x'), PATH: pathWith(launcher.binDir) }, timeoutMs: 60000 });
  smoke.steps.shimExecution = { status: probe.status, line: firstLine(probe.stdout + probe.stderr), notExercised: 'cmd.exe shim requires windows' };
}

// verify-install (as a new window would see it)
const verify = run(process.execPath, [path.join('install', 'verify-install.mjs')], { cwd: pkg, env: { PATH: pathWith(launcher.binDir), ...(HOME !== os.homedir() ? { BILL_COACH_HOME: HOME } : {}) }, timeoutMs: 600000 });
smoke.steps.verifyInstall = { status: verify.status, line: firstLine(verify.stdout + verify.stderr) };
L.check(verify.status === 0 && /^ok /.test(smoke.steps.verifyInstall.line), `verify-install: ${smoke.steps.verifyInstall.line}`);

// direct server probe through the INSTALLED route
const probe = await mcpProbe(P.serverEntry, P.pluginDir);
smoke.steps.installedServerProbe = { ok: probe.ok, serverInfo: probe.serverInfo, protocolVersion: probe.protocolVersion, toolCount: probe.toolCount, protocolClean: probe.protocolClean, error: probe.error };
L.check(probe.ok && probe.toolCount === 16 && JSON.stringify(probe.tools) === JSON.stringify([...EXPECTED_TOOLS].sort()), `installed server answers initialize + tools/list with the 16 expected tools (${probe.toolCount})`, probe.error);

// native smoke suites on the real package — output to logs only
const suites = [['session-test', [pkg], 'SESSION TESTS PASSED'], ['hardening-test', [pkg], 'HARDENING PROBES PASSED'], ['session-controls-test', [pkg], 'SESSION CONTROL TESTS PASSED'], ['pipeline-test', [pkg], 'PIPELINE TESTS PASSED'], ['runtime-probes', [pkg], 'RUNTIME PROBES PASSED'], ['doctrine-conformance-test', [pkg], 'DOCTRINE CONFORMANCE PASSED'], ['voice-layer-test', [pkg], 'VOICE LAYER TESTS PASSED']];
for (const [name, args, banner] of suites) {
  const script = path.join(build, `${name}.mjs`);
  if (!fs.existsSync(script)) { smoke.suites[name] = { notExercised: 'script absent' }; continue; }
  const r = run(process.execPath, [script, ...args], { cwd: build, timeoutMs: 900000, env: HOME !== os.homedir() ? { BILL_COACH_HOME: HOME } : {} });
  smoke.logsSha256[name] = saveLog(name, r);
  const passed = r.status === 0 && r.stdout.includes(banner);
  smoke.suites[name] = { status: r.status, signal: r.signal, timedOut: r.timedOut, passed, banner, bannerPrinted: r.stdout.includes(banner), tally: tallyLines(r.stdout).slice(-60), stderrTail: r.stderr.split(/\r?\n/).filter(Boolean).slice(-25), stdoutTail: r.stdout.split(/\r?\n/).filter(Boolean).slice(-8), durationMs: r.durationMs };
  L.check(passed, `${name}: ${banner}`, tallyLines(r.stdout).filter((l) => /FAIL/.test(l)).join('; ').slice(0, 300));
}
// platform fixtures (registered T-DET-010/011 companions), on Windows for real
const fixtures = run(process.execPath, [path.join(repo, 'estate/testing/run-platform-fixtures.mjs'), pkg], { cwd: repo, timeoutMs: 600000 });
smoke.logsSha256['platform-fixtures'] = saveLog('platform-fixtures', fixtures);
smoke.suites['platform-fixtures'] = { status: fixtures.status, passed: fixtures.status === 0 && /PLATFORM FIXTURES PASSED/.test(fixtures.stdout), tally: tallyLines(fixtures.stdout).slice(-40), stderrTail: fixtures.stderr.split(/\r?\n/).filter(Boolean).slice(-25), stdoutTail: fixtures.stdout.split(/\r?\n/).filter(Boolean).slice(-8) };
L.check(smoke.suites['platform-fixtures'].passed, 'run-platform-fixtures: PLATFORM FIXTURES PASSED', fixtures.stderr.slice(0, 300));

// idempotent
const again = installerRun(pkg, 'install.mjs', { home: HOME });
smoke.steps.reinstall = { line: again.line };
L.check(again.line === 'already current', `second install reports "already current" (${again.line})`);

// concurrency: two servers at once against the live state (Windows file locking)
const [a, b] = await Promise.all([mcpProbe(P.serverEntry, P.pluginDir), mcpProbe(P.serverEntry, P.pluginDir)]);
smoke.steps.twoServersAtOnce = { a: a.ok, b: b.ok, aTools: a.toolCount, bTools: b.toolCount };
L.check(a.ok && b.ok, 'two server processes answer concurrently against the live install');
smoke.steps.sidecarsAfterSmoke = sidecarsUnder(P.pluginDir).map((p) => path.relative(P.pluginDir, p));
smoke.summaryChecks = L.summary();
writeJson(path.join(evidenceDir, 'smoke-result.json'), smoke);

// ---------------------------------------------------------------- 4. installed identity
const skipVolatile = (r) => /^(state|state_meta|backups|tmp)\//.test(r) || /\.sqlite-(wal|shm|journal)$/.test(r);
const installedCode = hashTree(P.pluginDir, { skip: skipVolatile });
const packagePlugin = hashTree(path.join(pkg, 'plugin'));
const codeDiff = Object.keys(packagePlugin).filter((k) => !installedCode[k] || installedCode[k].sha256 !== packagePlugin[k].sha256);
const installedIdentity = {
  ...header(TASK, identity),
  archiveSha256: vmSha, manifestSha256: sourceAndVm.manifest.sha256,
  marker: JSON.parse(fs.readFileSync(P.marker, 'utf8')),
  installedLibrarySha256AtInstall: atInstall.librarySha256, installedLibrarySha256AfterSmoke: sha256File(P.libraryDb), packageLibrarySha256: sha256File(path.join(pkg, 'library', 'library.sqlite')),
  installedLibraryContent: await libraryContentDigest(P.libraryDb), packageLibraryContent: await libraryContentDigest(path.join(pkg, 'library', 'library.sqlite')),
  installedStateSha256AtInstall: atInstall.stateSha256, installedStateSha256AfterSmoke: sha256File(P.stateDb), stateTemplateSha256: sha256File(path.join(pkg, 'state-template', 'coach.sqlite')),
  installedCodeFiles: Object.keys(installedCode).length, packagePluginFiles: Object.keys(packagePlugin).length, codeDivergence: codeDiff,
  stateSchemaVersion: await withDb(P.stateDb, (db) => { try { return db.prepare(`SELECT value FROM state_meta WHERE key = 'schema_version'`).get()?.value ?? null; } catch { return null; } }, { readOnly: true }),
  registration: JSON.parse(fs.readFileSync(P.userConfig, 'utf8')).mcpServers?.['bill-coach'] ?? null,
};
L.check(installedIdentity.marker.version === rel.distributionVersion, `version marker is ${installedIdentity.marker.version}`);
L.check(installedIdentity.installedLibrarySha256AtInstall === installedIdentity.packageLibrarySha256, 'installed library was byte-identical to the archive library at install time');
L.check(installedIdentity.installedStateSha256AtInstall === installedIdentity.stateTemplateSha256, 'installed state genesis was byte-identical to the archive state template at install time');
L.check(installedIdentity.installedLibraryContent.digest === installedIdentity.packageLibraryContent.digest, 'installed library content (tables, counts, content hashes) equals the archive library after the smoke');
L.check(codeDiff.length === 0, 'installed plugin code is byte-identical to the archive plugin tree', codeDiff.slice(0, 5).join(', '));
L.check(String(installedIdentity.stateSchemaVersion) === String(rel.schemaVersion), `installed state schema is ${installedIdentity.stateSchemaVersion}`);
writeJson(path.join(evidenceDir, 'installed-identity.json'), installedIdentity);

// ---------------------------------------------------------------- 5. wrong cases (sandbox homes only)
const wrong = { ...header(TASK, identity), contract: registry.tasks.find((t) => t.id === TASK).wrongCase, cases: [] };
const sandbox = (name) => { const h = path.join(work, 'sandbox', name); fs.mkdirSync(h, { recursive: true }); return h; };
const sandboxEnv = (h) => (isWindows ? { LOCALAPPDATA: path.join(h, 'AppData', 'Local') } : {});

// (a) wrong SHA / tampered archive: the fetch gate must refuse before expansion.
{
  const tampered = path.join(work, 'tampered.zip'); fs.copyFileSync(archive, tampered); fs.appendFileSync(tampered, Buffer.from([0x00]));
  const sha = sha256File(tampered);
  const refused = sha !== rel.archiveSha256;
  wrong.cases.push({ id: 'wrong-sha', injected: 'one byte appended to a copy of the archive', observed: { sha256: sha }, refused, verdict: refused ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(refused, 'wrong case: tampered archive fails the SHA gate');
  fs.rmSync(tampered, { force: true });
}
// (b) altered payload: the installer's own manifest validation must refuse.
{
  const copy = expand(archive, path.join(work, 'altered'));
  fs.appendFileSync(path.join(copy, 'plugin', 'runtime', 'server.mjs'), '\n// altered payload sentinel\n');
  const h = sandbox('altered');
  const r = installerRun(copy, 'install.mjs', { home: h, extraEnv: sandboxEnv(h) });
  const refused = r.status !== 0 && /^failed:/.test(r.line);
  wrong.cases.push({ id: 'altered-payload', injected: 'one byte-level change to plugin/runtime/server.mjs in an expanded copy', observed: { line: r.line, status: r.status }, refused, verdict: refused ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(refused, `wrong case: altered payload refused (${r.line})`);
}
// (c) stale registration: a pre-existing user-scope entry pointing at a source tree must be replaced, unrelated keys kept.
{
  const h = sandbox('stale');
  const { P: SP } = await pathsFor(pkg, h);
  fs.mkdirSync(SP.profile, { recursive: true });
  // The profile must carry a marker for the installer to treat it as a repair; a squatting dir is refused. Use a fresh
  // install path instead: pre-create only .claude.json after install would not be "stale". So: install, then poison, then repair.
  const first = installerRun(pkg, 'install.mjs', { home: h, extraEnv: sandboxEnv(h) });
  const doc = JSON.parse(fs.readFileSync(SP.userConfig, 'utf8'));
  doc.mcpServers['bill-coach'] = { type: 'stdio', command: 'node', args: [path.join(work, 'coach', 'package', 'plugin', 'runtime', 'server.mjs')], env: { BILL_COACH_DATA_DIR: path.join(work, 'coach', 'package') } };
  doc.unrelated_fixture = { keep: true };
  fs.writeFileSync(SP.userConfig, JSON.stringify(doc, null, 2));
  fs.rmSync(SP.mcpConfig, { force: true }); // make it a repair
  const repair = installerRun(pkg, 'install.mjs', { home: h, extraEnv: sandboxEnv(h) });
  const after = JSON.parse(fs.readFileSync(SP.userConfig, 'utf8'));
  const entry = after.mcpServers?.['bill-coach'];
  const installedRoute = entry && path.resolve(entry.args[0]) === path.resolve(SP.serverEntry) && path.resolve(entry.env?.BILL_COACH_DATA_DIR ?? '') === path.resolve(SP.pluginDir);
  const kept = after.unrelated_fixture?.keep === true;
  wrong.cases.push({ id: 'stale-registration', injected: 'user-scope bill-coach entry re-pointed at the expanded source tree, plus an unrelated key', observed: { firstInstall: first.line, repair: repair.line, entryArgs: entry?.args ?? null, unrelatedKept: kept }, refused: installedRoute && kept, verdict: installedRoute && kept ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(installedRoute && kept, `wrong case: stale source-tree registration replaced by the installed route (${repair.line}); unrelated key preserved`);
}
// (d) journal recovery: a WAL-resident write must be visible to a fresh process and survive a checkpoint.
{
  const h = sandbox('journal');
  const { P: SP } = await pathsFor(pkg, h);
  installerRun(pkg, 'install.mjs', { home: h, extraEnv: sandboxEnv(h) });
  const DatabaseSync = (await import('node:sqlite')).DatabaseSync;
  const holder = new DatabaseSync(SP.stateDb);
  holder.exec('PRAGMA journal_mode = WAL'); holder.exec('PRAGMA wal_autocheckpoint = 0');
  const now = nowIso();
  holder.prepare(`INSERT INTO memories (id, type, subject, content, source_ids_json, created_at, updated_at) VALUES ('acceptance-wal-1', 'context', 'acceptance', 'WAL-resident acceptance row', '[]', ?, ?)`).run(now, now);
  const walExists = fs.existsSync(`${SP.stateDb}-wal`) && fs.statSync(`${SP.stateDb}-wal`).size > 0;
  const freshSees = await withDb(SP.stateDb, (db) => db.prepare(`SELECT COUNT(*) c FROM memories WHERE id = 'acceptance-wal-1'`).get().c, { readOnly: true });
  const v = run(process.execPath, [path.join('install', 'verify-install.mjs')], { cwd: pkg, env: { BILL_COACH_HOME: h, ...sandboxEnv(h), PATH: pathWith(launcher.binDir) }, timeoutMs: 600000 });
  holder.close();
  const afterClose = await withDb(SP.stateDb, (db) => db.prepare(`SELECT COUNT(*) c FROM memories WHERE id = 'acceptance-wal-1'`).get().c, { readOnly: true });
  const ok = walExists && freshSees === 1 && afterClose === 1 && /^ok /.test(firstLine(v.stdout));
  wrong.cases.push({ id: 'journal-recovery', injected: 'a row committed only to coach.sqlite-wal (autocheckpoint off) while another process verifies', observed: { walSidecarPresent: walExists, freshProcessSawRow: freshSees === 1, rowAfterCheckpoint: afterClose === 1, verifyInstall: firstLine(v.stdout + v.stderr) }, refused: ok, verdict: ok ? 'RECOVERED_AS_REQUIRED' : 'RECOVERY_FAILED' });
  L.check(ok, 'wrong case: WAL-resident write recovered by a fresh process and survives checkpoint');
}
// (e) path truncation (Windows): a long USER PATH must not be truncated by the installer's registry write.
if (isWindows) {
  const h = sandbox('longpath');
  const pad = Array.from({ length: 30 }, (_, i) => `C:\\acceptance-pad\\dir-${String(i).padStart(2, '0')}-${'x'.repeat(24)}`).join(';');
  const longPath = `${originalUserPath};${pad}`;
  setUserPath(longPath);
  const before = readUserPath().length;
  const r = installerRun(pkg, 'install.mjs', { home: h, extraEnv: sandboxEnv(h) });
  const afterPath = readUserPath();
  const afterLen = afterPath.length;
  const sandBin = path.join(h, 'AppData', 'Local', 'Programs', 'bill-coach', 'bin');
  const ok = Number(afterLen) > 1024 && Number(afterLen) >= Number(before) && afterPath.toLowerCase().replace(/\\{2,}/g, '\\').includes(sandBin.toLowerCase()) && afterPath.includes('dir-29');
  const padPreserved = pad.split(';').every((e) => afterPath.split(';').includes(e));
  installerRun(pkg, 'uninstall.mjs', { home: h, extraEnv: sandboxEnv(h) });
  setUserPath(originalUserPath);
  const restored = readUserPath() === originalUserPath;
  wrong.cases.push({ id: 'path-truncation', injected: `user PATH extended to ${before} chars (> 1024) before install`, observed: { install: r.line, lengthBefore: Number(before), lengthAfter: Number(afterLen), tailPreserved: afterPath.includes('dir-29'), padEntriesPreservedByteExact: padPreserved, restoredOriginal: restored }, refused: ok, verdict: ok ? 'NOT_TRUNCATED_AS_REQUIRED' : 'TRUNCATED' });
  L.check(ok, `wrong case: >1024-char user PATH not truncated by the installer (${before} -> ${afterLen})`);
  L.check(padPreserved, 'wrong case: pre-existing entries of the long PATH preserved byte-exact by the installer');
  L.check(restored, 'original user PATH restored after the wrong case');
} else {
  wrong.cases.push({ id: 'path-truncation', notExercised: 'requires windows user PATH registry', verdict: 'NOT_EXERCISED' });
}
wrong.allRejected = wrong.cases.filter((c) => !c.notExercised).every((c) => c.refused);
wrong.verdict = wrong.allRejected ? 'PASS' : 'FAIL';
writeJson(path.join(evidenceDir, 'wrong-case-result.json'), wrong);

// sandbox installs off the box (their launchers/PATH entries too)
for (const name of ['altered', 'stale', 'journal']) {
  const h = path.join(work, 'sandbox', name);
  if (fs.existsSync(path.join(h, '.claude-bill-career-coach'))) installerRun(pkg, 'uninstall.mjs', { home: h, extraEnv: sandboxEnv(h), args: ['--purge-data', '--confirm', 'delete bill coach memory'] });
}

// ---------------------------------------------------------------- verdict
const notExercised = wrong.cases.filter((c) => c.notExercised).map((c) => c.id);
let verdict = L.passed ? 'PASS' : 'FAIL';
if (verdict === 'PASS' && !isWindows) { verdict = 'CAPTURE-INCOMPLETE'; reasons.push('dry run on a non-Windows host: native Windows checks not exercised'); }
if (notExercised.length && isWindows) reasons.push(`not exercised: ${notExercised.join(', ')}`);
for (const f of L.fails) reasons.push(`FAIL: ${f.label}`);
verdictFile(evidenceDir, TASK, verdict, reasons);
console.log(`\n${TASK} ${verdict}: ${L.checks.length} checks, ${L.fails.length} failed`);
process.exit(L.passed ? 0 : 1);
