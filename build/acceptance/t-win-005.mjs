// T-WIN-005 — Honest uninstall, written-state reactivation and repair.
// Adapter: windows-recovery. Required evidence:
//   written-state-reactivation.json, locked-uninstall.json, residual-scan.json, wrong-case-result.json
// Wrong case: locked config cannot report uninstalled; legitimate written state must reactivate while
// swapped state refuses.
//
// Usage: node t-win-005.mjs <repo> <evidence-dir> <work-dir> --pkg <expanded 2.1.2 package> [--home <dir>]
// Expects the (upgraded) 2.1.2 install from T-WIN-004 to be in place for <home>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, claudeMcpList, header, holdFileLock, identityOf, installerRun, isWindows, killTree, pathsFor, ps, run, sha256File, verdictFile, waitForLine, withDb, writeJson, pathWith, findLauncher, firstLine, nowIso, sidecarsUnder } from './lib.mjs';

const argv = process.argv.slice(2);
const [repo, evidenceDir, work] = argv;
const opt = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
if (!repo || !evidenceDir || !work || !opt('--pkg')) { console.error('usage: t-win-005.mjs <repo> <evidence-dir> <work-dir> --pkg <package> [--home <dir>]'); process.exit(2); }
const TASK = 'T-WIN-005';
const HOME = opt('--home') ? path.resolve(opt('--home')) : os.homedir();
const pkg = path.resolve(opt('--pkg'));
fs.mkdirSync(evidenceDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
const identity = await identityOf(repo);
const registry = JSON.parse(fs.readFileSync(path.join(repo, 'estate/testing/acceptance-tasks.json'), 'utf8'));
const { P, binDir } = await pathsFor(pkg, HOME);
const L = new Ledger(TASK);
const reasons = [];
const userPath = () => (isWindows ? ps(`[Environment]::GetEnvironmentVariable('Path','User')`).stdout.trimEnd() : null);
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : null);
const countRow = (id) => withDb(P.stateDb, (db) => db.prepare(`SELECT COUNT(*) c FROM memories WHERE id = ?`).get(id).c, { readOnly: true });
const uninstall = (args = []) => installerRun(pkg, 'uninstall.mjs', { home: HOME, args });
const install = () => installerRun(pkg, 'install.mjs', { home: HOME });

L.check(fs.existsSync(P.marker), `an install is present at ${P.profile} (${fs.existsSync(P.marker) ? JSON.parse(fs.readFileSync(P.marker, 'utf8')).version : 'none'})`);

// ---------------------------------------------------------------- 1. written state, then an honest uninstall
const now = nowIso();
await withDb(P.stateDb, (db) => db.prepare(`INSERT INTO memories (id,type,subject,content,status,effective_at,source_ids_json,sensitive,supersedes_id,created_at,updated_at) VALUES ('acceptance-written-2','context','acceptance','written before uninstall','active',?,'[]',0,NULL,?,?)`).run(now, now, now));
const stateShaBefore = sha256File(P.stateDb);
const launcherBefore = findLauncher(binDir);
const un = uninstall();
const afterUninstall = {
  line: un.line, profileEntries: listDir(P.profile), pluginsEntries: listDir(path.join(P.profile, 'plugins')), dataEntries: listDir(path.join(P.profile, 'plugins', 'data')), pluginDirEntries: listDir(P.pluginDir),
  settingsGone: !fs.existsSync(P.settings), userConfigGone: !fs.existsSync(P.userConfig), mcpDirGone: !fs.existsSync(P.mcpDir), skillsGone: !fs.existsSync(P.skillsDir),
  launcherGone: launcherBefore.shim ? !fs.existsSync(launcherBefore.shim) : null, stateKept: fs.existsSync(P.stateDb), workspaceKept: fs.existsSync(P.workspace),
  userPathStillHasBinDir: isWindows ? userPath().toLowerCase().split(';').includes(launcherBefore.binDir.toLowerCase()) : null,
};
L.check(/^uninstalled \(memory preserved at /.test(un.line), `uninstall reports preserved memory (${un.line})`);
L.check(JSON.stringify(afterUninstall.profileEntries) === JSON.stringify(['plugins', 'workspace']), `profile residue is exactly plugins + workspace (${afterUninstall.profileEntries})`);
L.check((afterUninstall.pluginDirEntries ?? []).every((e) => ['state', 'backups', 'state_meta', 'library'].includes(e)) && afterUninstall.stateKept, `plugin dir residue is only the preservation set (${afterUninstall.pluginDirEntries})`);
L.check(afterUninstall.settingsGone && afterUninstall.userConfigGone && afterUninstall.mcpDirGone && afterUninstall.skillsGone, 'settings, user-scope registration, mcp/ and skills/ removed');
L.check(afterUninstall.launcherGone !== false, 'launcher removed');
if (isWindows) L.check(afterUninstall.userPathStillHasBinDir === false, 'launcher dir removed from the USER PATH');

// ---------------------------------------------------------------- 2. reactivation by reinstall
const rep = install();
const launcher = findLauncher(binDir);
const rowBack = await countRow('acceptance-written-2');
const verify = run(process.execPath, [path.join('install', 'verify-install.mjs')], { cwd: pkg, env: { PATH: pathWith(launcher.binDir), ...(HOME !== os.homedir() ? { BILL_COACH_HOME: HOME } : {}) }, timeoutMs: 600000 });
const mcp = claudeMcpList(P.profile);
const reactivation = {
  ...header(TASK, identity), writtenRow: 'acceptance-written-2', stateShaBeforeUninstall: stateShaBefore, uninstall: afterUninstall,
  reinstall: { line: rep.line, rowPresent: rowBack === 1, verifyInstall: firstLine(verify.stdout + verify.stderr), clientConnected: mcp.connected, mcpLine: mcp.line, registration: fs.existsSync(P.userConfig) ? JSON.parse(fs.readFileSync(P.userConfig, 'utf8')).mcpServers?.['bill-coach'] ?? null : null, marker: JSON.parse(fs.readFileSync(P.marker, 'utf8')) },
};
L.check(/^repaired \(.*memory preserved\)$/.test(rep.line), `reinstall reports repair with memory preserved (${rep.line})`);
L.check(rowBack === 1, 'the row written before uninstall is live again after reinstall');
L.check(/^ok /.test(reactivation.reinstall.verifyInstall), `verify-install after repair: ${reactivation.reinstall.verifyInstall}`);
L.check(mcp.connected, 'the client re-attaches the repaired registration');

// ---------------------------------------------------------------- 3. wrong cases
const wrong = { ...header(TASK, identity), contract: registry.tasks.find((t) => t.id === TASK).wrongCase, cases: [] };
// (a) swapped state must refuse: a state database of a different schema under the same marker.
{
  uninstall();
  const legit = path.join(work, 'legit-state.sqlite'); fs.copyFileSync(P.stateDb, legit);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(P.stateDb + s)) fs.rmSync(P.stateDb + s);
  await withDb(P.stateDb, (db) => db.prepare(`UPDATE state_meta SET value = '9' WHERE key = 'schema_version'`).run());
  const swappedSha = sha256File(P.stateDb);
  const r = install();
  const refused = r.status !== 0 && /^failed:/.test(r.line) && /schema 9/.test(r.line);
  const untouched = sha256File(P.stateDb) === swappedSha;
  wrong.cases.push({ id: 'swapped-state', injected: 'state database schema_version rewritten to 9 under the preserved 2.1.2 marker, then reinstall', observed: { line: r.line, stateUntouched: untouched }, refused: refused && untouched, verdict: refused && untouched ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(refused && untouched, `wrong case: swapped state refused and left untouched (${r.line})`);
  fs.copyFileSync(legit, P.stateDb);
  const back = install();
  L.check(/^repaired/.test(back.line) && (await countRow('acceptance-written-2')) === 1, `legitimate state reactivates after the swapped state was restored (${back.line})`);
  wrong.cases.push({ id: 'legitimate-reactivation', injected: 'the legitimate state restored', observed: { line: back.line }, refused: /^repaired/.test(back.line), verdict: /^repaired/.test(back.line) ? 'REACTIVATED_AS_REQUIRED' : 'NOT_REACTIVATED' });
}
// (b) locked config cannot report uninstalled.
let locked = { ...header(TASK, identity), lockedFile: P.settings, exercised: false };
if (isWindows) {
  const lock = holdFileLock(P.settings);
  const held = await waitForLine(lock, 'LOCKED');
  const r = uninstall();
  const settingsStillThere = fs.existsSync(P.settings);
  killTree(lock);
  await new Promise((res) => setTimeout(res, 1500));
  const claimedSuccess = /^uninstalled/.test(r.line);
  const honest = !(claimedSuccess && settingsStillThere);
  locked = { ...locked, exercised: held, uninstallLine: r.line, exitStatus: r.status, settingsStillPresentAfter: settingsStillThere, claimedSuccess, honest, stderrHead: r.stderr.slice(0, 400) };
  L.check(held, 'an exclusive handle was held on settings.json during uninstall');
  L.check(honest, `locked config: uninstall did not report unconditional success while settings.json remained (${r.line}; present=${settingsStillThere})`);
  wrong.cases.push({ id: 'locked-config', injected: 'settings.json held open with FileShare.None during uninstall', observed: { line: r.line, settingsStillPresent: settingsStillThere }, refused: honest, verdict: honest ? 'HONEST_AS_REQUIRED' : 'DISHONEST_SUCCESS' });
  // bring the install back to a known state for the final scan
  uninstall(); install();
} else {
  locked = { ...locked, notExercised: 'mandatory file locks require windows' };
  wrong.cases.push({ id: 'locked-config', notExercised: 'requires windows', verdict: 'NOT_EXERCISED' });
}
writeJson(path.join(evidenceDir, 'locked-uninstall.json'), locked);
writeJson(path.join(evidenceDir, 'written-state-reactivation.json'), reactivation);

// ---------------------------------------------------------------- 4. final purge and residual scan
const purge = uninstall(['--purge-data', '--confirm', 'delete bill coach memory']);
// Scoped to THIS profile's plugin dir so unrelated coach processes on a shared host are not counted.
const needle = P.pluginDir.replace(/\\/g, '\\\\');
const procScan = isWindows
  ? ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh|cmd)\\.exe$' -and $_.CommandLine -and $_.CommandLine -like '*${P.pluginDir.replace(/'/g, "''")}*' } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress`).stdout.trim()
  : run('sh', ['-c', `ps -axo pid,command | grep -F '${P.pluginDir}' | grep -vE 'grep|/bin/sh -c' || true`]).stdout.trim();
const residual = {
  ...header(TASK, identity), purge: purge.line,
  profileDirGone: !fs.existsSync(P.profile), launcherGone: !(launcher.shim && fs.existsSync(launcher.shim)), binDirEntries: listDir(launcher.binDir),
  userPathClean: isWindows ? !userPath().toLowerCase().split(';').includes(launcher.binDir.toLowerCase()) : null,
  sidecarsUnderHome: sidecarsUnder(path.join(HOME, '.claude-bill-career-coach')).length,
  stageOrPrevDirs: fs.existsSync(path.dirname(P.pluginDir)) ? fs.readdirSync(path.dirname(P.pluginDir)).filter((n) => /^\.(stage|prev)-/.test(n)) : [],
  coachProcesses: procScan || '[]',
};
L.check(purge.line === 'purged', `purge reports purged (${purge.line})`);
L.check(residual.profileDirGone, 'sealed profile directory gone');
L.check(residual.launcherGone, 'launcher gone');
if (isWindows) L.check(residual.userPathClean, 'USER PATH carries no launcher entry');
L.check(residual.stageOrPrevDirs.length === 0, 'no .stage-/.prev- residue');
L.check(residual.coachProcesses === '[]' || residual.coachProcesses === '' || residual.coachProcesses === 'null', 'no leftover coach/server processes', residual.coachProcesses.slice(0, 200));
writeJson(path.join(evidenceDir, 'residual-scan.json'), residual);
wrong.allRejected = wrong.cases.filter((c) => !c.notExercised).every((c) => c.refused);
wrong.verdict = wrong.allRejected ? 'PASS' : 'FAIL';
writeJson(path.join(evidenceDir, 'wrong-case-result.json'), wrong);

let verdict = L.passed ? 'PASS' : 'FAIL';
if (verdict === 'PASS' && !isWindows) { verdict = 'CAPTURE-INCOMPLETE'; reasons.push('dry run on a non-Windows host: locked-config case not exercised'); }
for (const f of L.fails) reasons.push(`FAIL: ${f.label}`);
verdictFile(evidenceDir, TASK, verdict, reasons);
console.log(`\n${TASK} ${verdict}: ${L.checks.length} checks, ${L.fails.length} failed`);
process.exit(L.passed ? 0 : 1);
