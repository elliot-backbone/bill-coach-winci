// T-WIN-003 — Claude Code client attachment through the installed route.
// Adapter: native-claude-client. Required evidence:
//   claude-identity.json, mcp-list.txt, tool-set.json, registration-route.json, wrong-case-result.json
// Wrong case: a healthy direct server with detached client, source-tree registration, wrong tool
// count or connector bleed must fail.
//
// The client itself must be the observer: a healthy direct server proves nothing about attachment.
// `claude mcp list` needs no sign-in. Client-visible tool enumeration is attempted through the
// launcher's own flag path with MCP debug logging; if the client cannot enumerate tools without a
// sign-in the adapter says so and the task cannot be PASS.
//
// Usage: node t-win-003.mjs <repo> <evidence-dir> <work-dir> [--home <dir>]
// Requires the T-WIN-002 install to be in place for <home>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, claudeIdentity, claudeMcpList, header, identityOf, isWindows, mcpProbe, pathsFor, run, sha256File, verdictFile, writeJson, resolveOnPath, installerRun } from './lib.mjs';

const argv = process.argv.slice(2);
const [repo, evidenceDir, work] = argv;
const homeOpt = argv.indexOf('--home') >= 0 ? argv[argv.indexOf('--home') + 1] : null;
if (!repo || !evidenceDir || !work) { console.error('usage: t-win-003.mjs <repo> <evidence-dir> <work-dir> [--home <dir>]'); process.exit(2); }
const TASK = 'T-WIN-003';
const HOME = homeOpt ? path.resolve(homeOpt) : os.homedir();
fs.mkdirSync(evidenceDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
const identity = await identityOf(repo);
const registry = JSON.parse(fs.readFileSync(path.join(repo, 'estate/testing/acceptance-tasks.json'), 'utf8'));
const pkgOpt = argv.indexOf('--pkg') >= 0 ? argv[argv.indexOf('--pkg') + 1] : null;
const pkgRoot = pkgOpt ? path.resolve(pkgOpt) : path.join(path.dirname(work), 'w2', 'coach', 'package');
if (!fs.existsSync(path.join(pkgRoot, 'manifest.json'))) { console.error(`expanded package not found at ${pkgRoot}; pass --pkg`); process.exit(2); }
const { P, EXPECTED_TOOLS } = await pathsFor(pkgRoot, HOME);
const L = new Ledger(TASK);
const reasons = [];
const same = (a, b) => { try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); } catch { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } };

// ---------------------------------------------------------------- 1. claude identity
const ci = claudeIdentity();
const npmRoot = run(isWindows ? 'cmd.exe' : 'npm', isWindows ? ['/c', 'npm root -g'] : ['root', '-g'], { timeoutMs: 60000 }).stdout.trim();
let pkgJson = null; try { pkgJson = JSON.parse(fs.readFileSync(path.join(npmRoot, '@anthropic-ai', 'claude-code', 'package.json'), 'utf8')); } catch { /* not npm-installed */ }
writeJson(path.join(evidenceDir, 'claude-identity.json'), { ...header(TASK, identity), claude: ci, npmPackage: pkgJson ? { name: pkgJson.name, version: pkgJson.version } : null, npmRoot, minimumFloorRule: 'readable semantic version only; no package-defined minimum is compared' });
L.check(ci.readable, `claude ${ci.version} at ${ci.bin}`);

// ---------------------------------------------------------------- 2. registration route
L.check(fs.existsSync(P.marker), `an install is present at ${P.profile}`);
const userDoc = JSON.parse(fs.readFileSync(P.userConfig, 'utf8'));
const sealedMcp = JSON.parse(fs.readFileSync(P.mcpConfig, 'utf8'));
const settings = JSON.parse(fs.readFileSync(P.settings, 'utf8'));
const entry = userDoc.mcpServers?.['bill-coach'] ?? null;
const serverArg = entry?.args?.[0] ?? '';
const dataDirArg = entry?.env?.BILL_COACH_DATA_DIR ?? '';
const underProfile = (p) => p && path.resolve(p).toLowerCase().startsWith(path.resolve(P.profile).toLowerCase());
const route = {
  ...header(TASK, identity),
  userConfigPath: P.userConfig, sealedConfigPath: P.mcpConfig, settingsPath: P.settings,
  entry, mcpServerNames: Object.keys(userDoc.mcpServers ?? {}),
  serverArgIsInstalledRoute: same(serverArg, P.serverEntry), dataDirIsInstalledRoute: same(dataDirArg, P.pluginDir),
  serverArgUnderSealedProfile: underProfile(serverArg), serverArgUnderRepo: serverArg.toLowerCase().startsWith(path.resolve(repo).toLowerCase()),
  serverArgUnderWork: serverArg.toLowerCase().startsWith(path.resolve(pkgRoot).toLowerCase()),
  sealedEntryEqualsUserEntry: JSON.stringify(sealedMcp.mcpServers?.['bill-coach']) === JSON.stringify(entry),
  pluginMcpJsonPresent: fs.existsSync(path.join(P.pluginDir, '.mcp.json')),
  settings: { disableClaudeAiConnectors: settings.disableClaudeAiConnectors ?? null, enabledPlugins: settings.enabledPlugins ?? null, allow: settings.permissions?.allow ?? null, deny: settings.permissions?.deny ?? null, model: settings.model ?? null },
  workspaceTrust: userDoc.projects ? Object.keys(userDoc.projects) : [],
  configDirAsLauncherSetsIt: P.profile,
};
L.check(Boolean(entry), 'user-scope registration mcpServers.bill-coach exists in the sealed profile .claude.json');
L.check(route.serverArgIsInstalledRoute && route.dataDirIsInstalledRoute, 'registration points at the INSTALLED runtime and data dir (not a source tree)');
L.check(!route.serverArgUnderRepo && !route.serverArgUnderWork, 'registration does not point into the repository checkout or the expanded archive');
L.check(route.mcpServerNames.length === 1 && route.mcpServerNames[0] === 'bill-coach', `bill-coach is the only registered server (${route.mcpServerNames.join(',')})`);
L.check(!route.pluginMcpJsonPresent, 'plugin declares no competing .mcp.json');
L.check(route.sealedEntryEqualsUserEntry, 'sealed mcp/coach-mcp.json entry equals the user-scope entry');
L.check(route.settings.disableClaudeAiConnectors === true, 'sealed settings disable claude.ai connectors');
L.check((route.settings.allow ?? []).some((a) => /mcp__(plugin_bill-career-coach_)?bill-coach/.test(a)), 'sealed permissions pre-approve the bill-coach tool prefix');
writeJson(path.join(evidenceDir, 'registration-route.json'), route);

// ---------------------------------------------------------------- 3. the client observes the server
const list = claudeMcpList(P.profile);
fs.writeFileSync(path.join(evidenceDir, 'mcp-list.txt'), `# CLAUDE_CONFIG_DIR=${P.profile}\n# claude ${ci.version} (${ci.bin})\n# exit ${list.status}\n# captured ${new Date().toISOString()}\n${list.text}\n`);
L.check(list.sees, 'claude mcp list names bill-coach');
L.check(list.connected, `claude mcp list reports bill-coach connected (${list.line})`, list.text.slice(0, 300));
L.check(list.otherServers.length === 0, 'no other server attaches to the sealed profile', list.otherServers.join(' | '));

// ---------------------------------------------------------------- 4. tool set: direct (installed route) and client-visible
const direct = await mcpProbe(P.serverEntry, P.pluginDir);
const expected = [...EXPECTED_TOOLS].sort();
const directEqual = JSON.stringify(direct.tools) === JSON.stringify(expected);
L.check(direct.ok && directEqual, `direct installed-route server exposes exactly the 16 expected tools (${direct.toolCount})`, direct.error);

// Client-visible enumeration: the launcher's flag path with MCP debug logging, bounded. No sign-in is
// available on the runner, so the turn itself fails; what matters is what the client logged about
// the server and its tools before that point.
const debugDir = path.join(P.profile, 'debug');
const beforeLogs = new Set(fs.existsSync(debugDir) ? fs.readdirSync(debugDir) : []);
const clientArgs = ['--debug', '--setting-sources', 'user', '-p', 'reply OK'];
const clientRun = isWindows
  ? run('cmd.exe', ['/c', `claude ${clientArgs.join(' ')}`], { cwd: P.workspace, env: { CLAUDE_CONFIG_DIR: P.profile, CI: '1' }, timeoutMs: 120000, input: '' })
  : run(resolveOnPath('claude') ?? 'claude', clientArgs, { cwd: P.workspace, env: { CLAUDE_CONFIG_DIR: P.profile, CI: '1' }, timeoutMs: 120000, input: '' });
const newLogs = (fs.existsSync(debugDir) ? fs.readdirSync(debugDir) : []).filter((f) => !beforeLogs.has(f) && f !== 'latest');
let logText = '';
for (const f of newLogs) { try { logText += `\n=== ${f} ===\n${fs.readFileSync(path.join(debugDir, f), 'utf8')}`; } catch { /* skip */ } }
const combined = `${clientRun.stdout}\n${clientRun.stderr}\n${logText}`;
const clientToolNames = [...new Set([...combined.matchAll(/mcp__(?:plugin_bill-career-coach_)?bill-coach__([a-z_]+)/g)].map((m) => m[1]))].sort();
const mcpLines = combined.split(/\r?\n/).filter((l) => /bill-coach/i.test(l) && /(tool|connect|server|spawn|ENOENT|error)/i.test(l)).map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 240)).slice(0, 60);
const clientCountMatch = combined.match(/bill-coach[^\n]*?(\d+)\s+tools?/i);
const poolMatch = combined.match(/Dynamic tool loading: (\d+)\/(\d+)/);
const clientVisible = clientToolNames.length ? 'ENUMERATED' : (clientCountMatch ? 'COUNT_ONLY' : 'UNAVAILABLE_WITHOUT_SIGN_IN');
const toolSet = {
  ...header(TASK, identity),
  expected, direct: { ok: direct.ok, tools: direct.tools, count: direct.toolCount, serverInfo: direct.serverInfo, equalsExpected: directEqual },
  client: { method: `claude ${clientArgs.join(' ')} with CLAUDE_CONFIG_DIR=<sealed profile>`, exitStatus: clientRun.status, timedOut: clientRun.timedOut, enumeration: clientVisible, tools: clientToolNames, count: clientToolNames.length || (clientCountMatch ? Number(clientCountMatch[1]) : null), equalsExpected: JSON.stringify(clientToolNames) === JSON.stringify(expected), clientToolPool: poolMatch ? { deferredIncluded: Number(poolMatch[1]), total: Number(poolMatch[2]), note: 'client-side tool pool size logged before the sign-in wall; not a per-server enumeration' } : null, connectedByClient: /Successfully connected \(transport: stdio\)/.test(combined) && /hasTools":true/.test(combined), evidenceLines: mcpLines, debugLogs: newLogs },
  setEquality: { directVsExpected: directEqual, clientVsExpected: JSON.stringify(clientToolNames) === JSON.stringify(expected), clientVsDirect: JSON.stringify(clientToolNames) === JSON.stringify(direct.tools) },
};
writeJson(path.join(evidenceDir, 'tool-set.json'), toolSet);
if (clientVisible === 'ENUMERATED') L.check(toolSet.setEquality.clientVsExpected, `client-visible tool set equals the 16 expected tools (${clientToolNames.length})`);
else { reasons.push(`client-visible tool enumeration ${clientVisible}: the client proved attachment (mcp list connected) but could not enumerate tool names without a sign-in`); console.log(`  ..   client-visible tool enumeration: ${clientVisible}`); }

// ---------------------------------------------------------------- 5. wrong cases (probe config dirs; the sealed profile is never touched)
const wrong = { ...header(TASK, identity), contract: registry.tasks.find((t) => t.id === TASK).wrongCase, cases: [] };
const probeDir = (name, servers) => {
  const d = path.join(work, 'probe', name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  return d;
};
// (a) detached client: direct server healthy, client registration points at a path that cannot start.
{
  const bogus = path.join(work, 'nowhere', 'server.mjs');
  const d = probeDir('detached', { 'bill-coach': { type: 'stdio', command: 'node', args: [bogus], env: { BILL_COACH_DATA_DIR: P.pluginDir } } });
  const l = claudeMcpList(d);
  const refused = direct.ok && !l.connected;
  wrong.cases.push({ id: 'detached-client', injected: 'registration whose server path does not exist while the real installed server is healthy', observed: { directHealthy: direct.ok, clientSees: l.sees, clientConnected: l.connected, line: l.line }, refused, verdict: refused ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(refused, 'wrong case: healthy direct server with a detached client is reported as not connected');
}
// (b) source-tree registration: the route check must flag a registration into the expanded archive even if it connects.
{
  const srcServer = path.join(pkgRoot, 'plugin', 'runtime', 'server.mjs');
  const d = probeDir('source-tree', { 'bill-coach': { type: 'stdio', command: 'node', args: [srcServer], env: { BILL_COACH_DATA_DIR: P.pluginDir } } });
  const doc = JSON.parse(fs.readFileSync(path.join(d, '.claude.json'), 'utf8'));
  const arg = doc.mcpServers['bill-coach'].args[0];
  const flagged = !same(arg, P.serverEntry);
  const l = claudeMcpList(d);
  wrong.cases.push({ id: 'source-tree-registration', injected: 'registration pointing at the expanded archive runtime instead of the installed runtime', observed: { clientConnected: l.connected, routeFlaggedAsNotInstalled: flagged }, refused: flagged, verdict: flagged ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(flagged, `wrong case: source-tree registration is flagged by the route check (client connected=${l.connected}, which is exactly why the route check exists)`);
}
// (c) wrong tool count: a runtime copy with one tool renamed must fail set equality, and the installer must refuse that payload.
{
  const copyRoot = path.join(work, 'tool-tamper'); fs.rmSync(copyRoot, { recursive: true, force: true });
  fs.cpSync(P.pluginDir, copyRoot, { recursive: true, filter: (s) => { const rel = path.relative(P.pluginDir, s); return !/\.sqlite-(wal|shm|journal)$/.test(rel) && !/^(backups|tmp)([\\/]|$)/.test(rel); } });
  const serverCopy = path.join(copyRoot, 'runtime', 'server.mjs');
  const src = fs.readFileSync(serverCopy, 'utf8');
  fs.writeFileSync(serverCopy, src.replace("name: 'bill_command'", "name: 'bill_command_renamed'"));
  const tampered = await mcpProbe(serverCopy, copyRoot);
  const mismatch = tampered.ok && JSON.stringify(tampered.tools) !== JSON.stringify(expected);
  // the installer's own validation refuses the same tampering in a package copy
  const pkgCopy = path.join(work, 'tool-tamper-pkg'); fs.rmSync(pkgCopy, { recursive: true, force: true }); fs.cpSync(pkgRoot, pkgCopy, { recursive: true });
  fs.writeFileSync(path.join(pkgCopy, 'plugin', 'runtime', 'server.mjs'), src.replace("name: 'bill_command'", "name: 'bill_command_renamed'"));
  const h = path.join(work, 'sandbox-tool'); fs.mkdirSync(h, { recursive: true });
  const inst = installerRun(pkgCopy, 'install.mjs', { home: h, extraEnv: isWindows ? { LOCALAPPDATA: path.join(h, 'AppData', 'Local') } : {} });
  const installerRefused = /^failed:/.test(inst.line);
  wrong.cases.push({ id: 'wrong-tool-count', injected: "runtime copy with 'bill_command' renamed (16 tools, wrong set) and the same tampering as a package payload", observed: { tamperedTools: tampered.tools, setMismatchDetected: mismatch, installer: inst.line, installerRefused }, refused: mismatch && installerRefused, verdict: mismatch && installerRefused ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(mismatch && installerRefused, `wrong case: wrong tool set detected by set equality and refused by the installer (${inst.line})`);
  fs.rmSync(copyRoot, { recursive: true, force: true }); fs.rmSync(pkgCopy, { recursive: true, force: true });
}
// (d) connector bleed: a second server in the config must be flagged by the exclusivity check.
{
  const rogue = path.join(work, 'rogue.mjs');
  fs.writeFileSync(rogue, "process.stdin.on('data', (d) => { for (const line of String(d).split('\\n').filter(Boolean)) { const m = JSON.parse(line); if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rogue', version: '0' } } : { tools: [] } }) + '\\n'); } });\n");
  const d = probeDir('bleed', { 'bill-coach': entry, 'rogue-connector': { type: 'stdio', command: 'node', args: [rogue] } });
  const l = claudeMcpList(d);
  const names = Object.keys(JSON.parse(fs.readFileSync(path.join(d, '.claude.json'), 'utf8')).mcpServers);
  const flagged = names.length !== 1 || l.otherServers.length > 0;
  wrong.cases.push({ id: 'connector-bleed', injected: 'an unrelated stdio server registered beside bill-coach', observed: { registered: names, clientOtherServers: l.otherServers }, refused: flagged, verdict: flagged ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED' });
  L.check(flagged, 'wrong case: connector bleed flagged (a second server is visible)');
}
wrong.allRejected = wrong.cases.every((c) => c.refused);
wrong.verdict = wrong.allRejected ? 'PASS' : 'FAIL';
writeJson(path.join(evidenceDir, 'wrong-case-result.json'), wrong);
if (fs.existsSync(path.join(work, 'sandbox-tool', '.claude-bill-career-coach'))) installerRun(pkgRoot, 'uninstall.mjs', { home: path.join(work, 'sandbox-tool'), args: ['--purge-data', '--confirm', 'delete bill coach memory'] });

// ---------------------------------------------------------------- verdict
let verdict = L.passed ? 'PASS' : 'FAIL';
if (verdict === 'PASS' && clientVisible !== 'ENUMERATED') verdict = 'CAPTURE-INCOMPLETE';
if (verdict === 'PASS' && !isWindows) { verdict = 'CAPTURE-INCOMPLETE'; reasons.push('dry run on a non-Windows host'); }
for (const f of L.fails) reasons.push(`FAIL: ${f.label}`);
verdictFile(evidenceDir, TASK, verdict, reasons);
console.log(`\n${TASK} ${verdict}: ${L.checks.length} checks, ${L.fails.length} failed`);
process.exit(L.passed ? 0 : 1);
