// The migration must preserve existing memory. Prove it on a synthetic pre-1.3
// database with populated rows, without embedding a principal's record in the fixture.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const [oldPkg, newPkg] = process.argv.slice(2);
let failures = 0;
const check = (c, l, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) { failures++; if (d) console.log(`       ${String(d).slice(0, 300)}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-migrate-'));
const db1 = path.join(dir, 'coach.sqlite');
fs.copyFileSync(path.join(oldPkg, 'state-template', 'coach.sqlite'), db1);

// Put synthetic content in the old shape, including a row in the table being renamed.
{
  const db = new DatabaseSync(db1);
  db.exec('PRAGMA busy_timeout = 10000');
  const now = new Date().toISOString();
  check(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='people'`).get().n === 1, 'the pre-1.3 database has a people table');
  db.prepare(`INSERT INTO people (id,name,role,strengths_json,focus_areas_json,working_model,confirmed,source_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('principal-test', 'Test Principal', 'principal', JSON.stringify(['closing']), JSON.stringify(['commercial lead']),
      'terse', 1, JSON.stringify(['bill-said']), now, now);
  db.prepare(`INSERT INTO memories (id,type,subject,content,source_ids_json,confirmed,sensitive,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('pre-migration-memory', 'context', 'survives', 'this row must exist after the migration', '[]', 1, 0, now, now);
  db.close();
}

// Absolute paths are not valid ESM specifiers on Windows; the URL form is.
const { MIGRATIONS, assertCoachStopped, snapshotSqlite } = await import(pathToFileURL(path.join(newPkg, 'install', 'upgrade.mjs')).href);
check(typeof MIGRATIONS[2] === 'function', 'a migration to schema 2 is registered');

{
  const db = new DatabaseSync(db1);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('BEGIN');
  MIGRATIONS[2](db);
  db.exec('COMMIT');
  const has = (n) => db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`).get(n).n;
  check(has('principal_profile') === 1, 'principal_profile exists after the migration');
  check(has('people') === 0, 'people is gone');
  const row = db.prepare(`SELECT id,name,confirmed,working_model FROM principal_profile`).all();
  check(row.length === 1 && row[0].id === 'principal-test', 'the existing row carried across', JSON.stringify(row));
  check(row[0].working_model === 'terse', 'its content is untouched', JSON.stringify(row));
  const mem = db.prepare(`SELECT COUNT(*) n FROM memories WHERE id='pre-migration-memory'`).get().n;
  check(mem === 1, 'unrelated memory survived');
  // Idempotence: an upgrade that runs twice must not explode.
  db.exec('BEGIN'); MIGRATIONS[2](db); db.exec('COMMIT');
  check(db.prepare(`SELECT COUNT(*) n FROM principal_profile`).get().n === 1, 'running the migration twice changes nothing');
  db.close();
}

// Migration 3: the confidence tier is deleted, and the rows survive it.
{
  const db = new DatabaseSync(db1);
  db.exec('PRAGMA busy_timeout = 10000');
  const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  check(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('memories') WHERE name='confirmed'`).get().n === 1,
    'the pre-1.3.1 database still has a confirmed column');
  db.exec('BEGIN'); MIGRATIONS[3](db); db.exec('COMMIT');
  check(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('memories') WHERE name='confirmed'`).get().n === 0,
    'confirmed is gone from memories');
  check(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('principal_profile') WHERE name='confirmed'`).get().n === 0,
    'confirmed is gone from principal_profile');
  check(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n === before, 'no memory was lost dropping the column');
  check(db.prepare('SELECT COUNT(*) AS n FROM principal_profile').get().n === 1, 'the principal row survived');
  db.exec('BEGIN'); MIGRATIONS[3](db); db.exec('COMMIT');
  check(true, 'running migration 3 twice changes nothing');
  db.close();
}

// And on an EMPTY people table it seeds the model.
{
  const db2 = path.join(dir, 'empty.sqlite');
  fs.copyFileSync(path.join(oldPkg, 'state-template', 'coach.sqlite'), db2);
  const db = new DatabaseSync(db2);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('BEGIN'); MIGRATIONS[2](db); db.exec('COMMIT');
  const rows = db.prepare(`SELECT id,name,confirmed FROM principal_profile`).all();
  check(rows.length === 1, 'an empty table is seeded with the principal model', JSON.stringify(rows));
  check(rows[0].name === 'Bill Jennings', 'the private package seeds its principal model', JSON.stringify(rows));
  db.close();
}

// Upgrading from a version that ALREADY has every directory the new one has. Every other
// upgrade test starts from an older package missing the new directories, so the swap renames
// onto nothing and passes. MEASURED 2026-08-22: `authorities` was added to plugin/ and left
// out of CODE_ENTRIES; 1.2.4 -> 1.4.0 passed, 1.4.0 -> 1.4.1 failed ENOTEMPTY on the swap.
{
  console.log('\n== upgrading onto an install that already has every directory ==');
  const { CODE_ENTRIES } = await import(pathToFileURL(path.join(newPkg, 'install', 'install.mjs')).href);
  const pluginDir = path.join(newPkg, 'plugin');
  const shipped = fs.readdirSync(pluginDir).filter((n) => n !== '.DS_Store');
  const missing = shipped.filter((n) => !CODE_ENTRIES.includes(n));
  check(missing.length === 0,
    'every top-level plugin directory is listed in CODE_ENTRIES',
    `not listed, so the upgrade swap would fail ENOTEMPTY: ${missing.join(', ')}`);
}

// An OLDER install is legitimately missing whatever directories the new version added, and
// that is an upgrade rather than damage. MEASURED 2026-08-22: after `authorities` was added to
// CODE_ENTRIES, performInstall checked completeness BEFORE version and sent every 1.2.4
// install into the repair path, where the schema guard correctly refused it. The upgrade that
// carries the migrations could not run at all, and the installer reported a hard failure.
{
  console.log('\n== routing: stale install goes to upgrade, not repair ==');
  const install = await import(pathToFileURL(path.join(newPkg, 'install', 'install.mjs')).href);
  const src = fs.readFileSync(path.join(newPkg, 'install', 'install.mjs'), 'utf8');
  const versionCheck = src.indexOf('versionCompare(marker.version, manifest.version) === 0');
  const completeCheck = src.indexOf('missingInstallParts(P)', src.indexOf('performInstall'));
  check(versionCheck !== -1 && completeCheck !== -1 && versionCheck < completeCheck,
    'performInstall compares the version before it judges completeness',
    'completeness first means a stale install is read as damage and never upgrades');
  check(typeof install.missingInstallParts === 'function', 'missingInstallParts is still exported for the repair path');
}

// A byte copy of a WAL database is not a database backup. Keep a committed row
// deliberately resident in the WAL while the new snapshot helper runs, then prove
// the snapshot sees it. This is the state a real Coach process commonly leaves.
{
  console.log('\n== WAL-safe state snapshot ==');
  const live = path.join(dir, 'wal-live.sqlite');
  const saved = path.join(dir, 'wal-snapshot.sqlite');
  const writer = new DatabaseSync(live);
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE durable (value TEXT);');
  writer.prepare('INSERT INTO durable (value) VALUES (?)').run('committed in WAL');
  check(fs.existsSync(`${live}-wal`) && fs.statSync(`${live}-wal`).size > 0,
    'fixture has committed pages resident in a WAL');
  await snapshotSqlite(live, saved);
  const copy = new DatabaseSync(saved, { readOnly: true });
  check(copy.prepare('SELECT value FROM durable').get()?.value === 'committed in WAL',
    'online SQLite snapshot includes the committed WAL row');
  check(String(Object.values(copy.prepare('PRAGMA journal_mode').get() || {})[0]).toLowerCase() === 'delete',
    'snapshot is normalized to one standalone SQLite file');
  copy.close();
  check(!['-wal', '-shm', '-journal'].some((suffix) => fs.existsSync(`${saved}${suffix}`)),
    'standalone snapshot has no volatile SQLite sidecars');
  writer.close();
}

// sessions.status cannot distinguish a recoverable interrupted session from a
// live process. The upgrader checks the process tree for the exact installed
// server/prompt paths, and ignores its own PID.
{
  console.log('\n== running Coach safety gate ==');
  const P = {
    pluginDir: path.join(dir, 'profile', 'plugin'),
    serverEntry: path.join(dir, 'profile', 'plugin', 'runtime', 'server.mjs'),
  };
  let refusal = '';
  try {
    assertCoachStopped(P, [{ pid: 424242, command: `node "${P.serverEntry}"` }]);
  } catch (err) {
    refusal = err.message;
  }
  check(/Coach is still running/.test(refusal), 'upgrade refuses an evidenced live Coach process', refusal);
  let selfPassed = true;
  try {
    assertCoachStopped(P, [{ pid: process.pid, command: `node "${P.serverEntry}"` }]);
  } catch {
    selfPassed = false;
  }
  check(selfPassed, 'the process check does not identify the upgrader itself as Coach');
}

function priorVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999`;
  return `${Math.max(0, major - 1)}.999.999`;
}

function packageFiles(root) {
  const found = [];
  const walk = (abs, rel = '') => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`test package contains a symlink: ${nextRel}`);
      if (entry.isDirectory()) walk(nextAbs, nextRel);
      else if (nextRel !== 'manifest.json' && !/\.sqlite-(wal|shm|journal)$/.test(nextRel)) found.push(nextRel);
    }
  };
  walk(root);
  return found.sort();
}

// The working tree is intentionally ahead of its final release manifest while
// this suite is developed. Rehash a disposable package copy so the actual CLI
// validation path is exercised without altering the product manifest.
function writeCoherentManifest(root, version) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const prior = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  manifest.version = version;
  manifest.files = packageFiles(root).map((rel) => {
    const abs = path.join(root, ...rel.split('/'));
    const stat = fs.statSync(abs);
    const entry = {
      path: rel,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      size: stat.size,
    };
    if (prior.get(rel)?.executable === true || (stat.mode & 0o111) !== 0) entry.executable = true;
    return entry;
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function fakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\necho 2.1.238 (Claude Code)\r\n');
  } else {
    const target = path.join(binDir, 'claude');
    fs.writeFileSync(target, '#!/bin/sh\nprintf "%s\\n" "2.1.238 (Claude Code)"\n', { mode: 0o755 });
  }
}

function testPath(binDir) {
  if (process.platform !== 'win32') {
    return [binDir, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
  }
  const win = process.env.SystemRoot || 'C:\\Windows';
  return [
    binDir,
    path.dirname(process.execPath),
    path.join(win, 'System32'),
    path.join(win, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter);
}

// Actual distribution path, not direct migration calls: install a coherent prior
// release into a disposable home, add durable rows/auth/trust/a runtime-synced
// document, invoke the newer installer, then run the historical uninstall ->
// newer-upgrade recovery route that used to fail before it could recreate mcp/.
{
  console.log('\n== full installed-profile upgrade and uninstall recovery ==');
  const e2e = path.join(dir, 'upgrade-e2e');
  const packageCopy = path.join(e2e, 'package');
  const home = path.join(e2e, 'home');
  const bin = path.join(e2e, 'fake-bin');
  fs.cpSync(newPkg, packageCopy, { recursive: true, preserveTimestamps: true });
  fakeClaude(bin);

  const sourceManifest = JSON.parse(fs.readFileSync(path.join(newPkg, 'manifest.json'), 'utf8'));
  const finalVersion = sourceManifest.version;
  const oldVersion = priorVersion(finalVersion);
  writeCoherentManifest(packageCopy, oldVersion);

  const env = {
    ...process.env,
    BILL_COACH_HOME: home,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    SHELL: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    PATH: testPath(bin),
  };
  const run = (relative, args = []) => spawnSync(process.execPath, [path.join(packageCopy, relative), ...args], {
    cwd: packageCopy,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const detail = (result) => `status=${result.status}; stdout=${String(result.stdout).trim()}; stderr=${String(result.stderr).trim()}`;

  let liveState = null;
  try {
    const installed = run('install/install.mjs');
    check(installed.status === 0 && String(installed.stdout).trim() === 'installed',
      `prior release ${oldVersion} installs through the real CLI`, detail(installed));
    if (installed.status !== 0) throw new Error(`prior install failed: ${detail(installed)}`);

    const profile = path.join(home, '.claude-bill-career-coach');
    const data = path.join(profile, 'plugins', 'data', 'bill-career-coach-skills-dir');
    const statePath = path.join(data, 'state', 'coach.sqlite');
    const libraryPath = path.join(data, 'library', 'library.sqlite');
    const markerPath = path.join(data, 'state_meta', 'app.json');
    const userConfigPath = path.join(profile, '.claude.json');
    const now = '2030-01-02T03:04:05.000Z';

    const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
    userConfig.auth_trust_fixture = { account: 'synthetic-account', trusted: true };
    userConfig.mcpServers['unrelated-fixture'] = { command: 'synthetic-command', args: ['--fixture'] };
    fs.writeFileSync(userConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`);

    liveState = new DatabaseSync(statePath);
    liveState.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE;');
    liveState.prepare(`INSERT INTO memories
      (id,type,subject,content,status,effective_at,source_ids_json,sensitive,supersedes_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('upgrade-memory-fixture', 'context', 'upgrade preservation', 'durable memory survives', 'active', now, '[]', 0, null, now, now);
    liveState.prepare(`INSERT INTO sessions
      (id,started_at,updated_at,status,situation,judgment,evidence_ids_json,open_questions_json,next_move,closed_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('upgrade-session-fixture', now, now, 'closed', 'synthetic situation', 'synthetic judgment', '[]', '[]', 'synthetic next move', now, 2);
    liveState.prepare(`INSERT INTO deliverables
      (id,kind,title,body,version,supersedes,change_note,status,role_id,session_id,created_at,updated_at,origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('upgrade-deliverable-fixture', 'other', 'Synthetic deliverable', 'This durable artefact must survive.', 1,
        null, 'upgrade fixture', 'live', null, 'upgrade-session-fixture', now, now, 'user');
    liveState.prepare(`UPDATE onboarding SET status='pane_3', corrections=?, updated_at=? WHERE singleton=1`)
      .run('synthetic onboarding correction', now);
    liveState.exec('COMMIT');
    check(fs.existsSync(`${statePath}-wal`) && fs.statSync(`${statePath}-wal`).size > 0,
      'full-path fixture leaves durable state committed in WAL');

    {
      const library = new DatabaseSync(libraryPath);
      const text = 'Synthetic runtime-synced source retained across a library replacement.';
      const sha = crypto.createHash('sha256').update(text).digest('hex');
      library.prepare(`INSERT INTO documents
        (id,kind,title,author,occurred_at,captured_at,authority_rank,authority_scope,media_type,language,
         source_group,external_id,parent_id,raw_content,extracted_text,content_sha256,status,attributes_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('upgrade-sync-document-fixture', 'note', 'Synthetic synced note', 'Fixture', now, now, 1, 'general',
          'text/plain', 'en', 'sync:test', 'upgrade-sync-document-fixture', null, null, text, sha, 'active', '{}');
      library.prepare(`INSERT INTO chunks
        (document_id,sequence,heading,speaker,started_at,ended_at,text,token_count,content_sha256,attributes_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('upgrade-sync-document-fixture', 0, null, null, null, null, text, 9, sha, '{}');
      library.close();
    }

    writeCoherentManifest(packageCopy, finalVersion);
    const upgraded = run('install/install.mjs');
    check(upgraded.status === 0 && String(upgraded.stdout).trim() === 'upgraded',
      `newer release ${finalVersion} upgrades through performInstall`, detail(upgraded));
    if (upgraded.status !== 0) throw new Error(`upgrade failed: ${detail(upgraded)}`);
    liveState.close();
    liveState = null;

    const state = new DatabaseSync(statePath, { readOnly: true });
    check(state.prepare(`SELECT content FROM memories WHERE id='upgrade-memory-fixture'`).get()?.content === 'durable memory survives',
      'upgrade preserves the durable memory row');
    check(state.prepare(`SELECT judgment FROM sessions WHERE id='upgrade-session-fixture'`).get()?.judgment === 'synthetic judgment',
      'upgrade preserves the session row');
    check(state.prepare(`SELECT body FROM deliverables WHERE id='upgrade-deliverable-fixture'`).get()?.body === 'This durable artefact must survive.',
      'upgrade preserves the deliverable row');
    check(state.prepare(`SELECT status,corrections FROM onboarding WHERE singleton=1`).get()?.corrections === 'synthetic onboarding correction',
      'upgrade preserves onboarding progress and corrections');
    state.close();

    const backups = fs.readdirSync(path.join(data, 'backups')).filter((name) => /^coach-v.+\.sqlite$/.test(name));
    check(backups.length >= 1, 'upgrade creates a state backup through SQLite');
    const backup = new DatabaseSync(path.join(data, 'backups', backups[0]), { readOnly: true });
    check(backup.prepare(`SELECT COUNT(*) n FROM memories WHERE id='upgrade-memory-fixture'`).get().n === 1,
      'state backup contains the row that was resident in WAL');
    backup.close();

    const afterConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
    check(afterConfig.auth_trust_fixture?.trusted === true, 'upgrade preserves top-level auth/trust state');
    check(afterConfig.mcpServers?.['unrelated-fixture']?.command === 'synthetic-command',
      'upgrade preserves an unrelated user-scope MCP registration');
    check(Boolean(afterConfig.mcpServers?.['bill-coach']), 'upgrade refreshes Bill Coach MCP registration');
    check(JSON.parse(fs.readFileSync(markerPath, 'utf8')).version === finalVersion,
      `installed marker advances to ${finalVersion}`);

    const libraryAfter = new DatabaseSync(libraryPath, { readOnly: true });
    check(libraryAfter.prepare(`SELECT COUNT(*) n FROM documents WHERE id='upgrade-sync-document-fixture'`).get().n === 1,
      'upgrade merges forward a runtime-synced library document');
    check(libraryAfter.prepare(`SELECT COUNT(*) n FROM chunks WHERE document_id='upgrade-sync-document-fixture'`).get().n === 1,
      'upgrade merges the runtime-synced document chunks');
    libraryAfter.close();

    // Recreate the historical sequence precisely: an OLD marker survives the
    // state-preserving uninstall, while mcp/, skills/ and settings disappear.
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.version = oldVersion;
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    const uninstalled = run('install/uninstall.mjs');
    check(uninstalled.status === 0 && /^uninstalled \(memory preserved at /.test(String(uninstalled.stdout).trim()),
      'historical uninstall preserves the old-version data estate', detail(uninstalled));
    check(!fs.existsSync(path.join(profile, 'mcp')) && !fs.existsSync(path.join(profile, 'skills')),
      'historical uninstall fixture has removed mcp/ and skills/');
    check(fs.existsSync(statePath) && fs.existsSync(markerPath), 'state and old marker remain after uninstall');

    const recovered = run('install/install.mjs');
    check(recovered.status === 0 && String(recovered.stdout).trim() === 'upgraded',
      'newer installer repairs the uninstalled old-version profile through its upgrade path', detail(recovered));
    if (recovered.status !== 0) throw new Error(`uninstall recovery failed: ${detail(recovered)}`);
    check(fs.existsSync(path.join(profile, 'mcp', 'coach-mcp.json')), 'uninstall recovery recreates the MCP directory and config');
    const skill = path.join(profile, 'skills', 'bill-career-coach');
    let skillTarget = '';
    try { skillTarget = fs.realpathSync(skill); } catch { /* check below reports it */ }
    let expectedSkillTarget = '';
    try { expectedSkillTarget = fs.realpathSync(data); } catch { /* check below reports it */ }
    const sameSkillTarget = process.platform === 'win32'
      ? skillTarget.toLowerCase() === expectedSkillTarget.toLowerCase()
      : skillTarget === expectedSkillTarget;
    check(sameSkillTarget, 'uninstall recovery recreates the traversable skills link', skillTarget);
    const recoveredConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
    check(Boolean(recoveredConfig.mcpServers?.['bill-coach']), 'uninstall recovery recreates user-scope MCP registration');
    const recoveredState = new DatabaseSync(statePath, { readOnly: true });
    check(recoveredState.prepare(`SELECT COUNT(*) n FROM memories WHERE id='upgrade-memory-fixture'`).get().n === 1,
      'uninstall recovery preserves durable memory');
    check(recoveredState.prepare(`SELECT COUNT(*) n FROM deliverables WHERE id='upgrade-deliverable-fixture'`).get().n === 1,
      'uninstall recovery preserves the durable deliverable');
    recoveredState.close();
    const recoveredLibrary = new DatabaseSync(libraryPath, { readOnly: true });
    check(recoveredLibrary.prepare(`SELECT COUNT(*) n FROM documents WHERE id='upgrade-sync-document-fixture'`).get().n === 1,
      'uninstall recovery preserves runtime-synced library material');
    recoveredLibrary.close();

    // Now exercise the schema-changing path from the actual frozen 1.2.4
    // installed shape. Its package fixture is intentionally not treated as a
    // releasable archive; the on-disk profile is assembled exactly from its
    // plugin, library and schema-1 state template, then the current installer
    // owns the complete upgrade transaction.
    const legacyHome = path.join(e2e, 'legacy-home');
    const legacyProfile = path.join(legacyHome, '.claude-bill-career-coach');
    const legacyData = path.join(legacyProfile, 'plugins', 'data', 'bill-career-coach-skills-dir');
    const legacyStatePath = path.join(legacyData, 'state', 'coach.sqlite');
    const legacyMarkerPath = path.join(legacyData, 'state_meta', 'app.json');
    fs.mkdirSync(path.dirname(legacyData), { recursive: true });
    fs.cpSync(path.join(oldPkg, 'plugin'), legacyData, { recursive: true, preserveTimestamps: true });
    fs.mkdirSync(path.join(legacyData, 'library'), { recursive: true });
    fs.copyFileSync(path.join(oldPkg, 'library', 'library.sqlite'), path.join(legacyData, 'library', 'library.sqlite'));
    for (const sub of ['state', 'state_meta', 'backups', 'tmp']) fs.mkdirSync(path.join(legacyData, sub), { recursive: true });
    fs.copyFileSync(path.join(oldPkg, 'state-template', 'coach.sqlite'), legacyStatePath);
    for (const sub of ['workspace', 'mcp', 'skills']) fs.mkdirSync(path.join(legacyProfile, sub), { recursive: true });
    fs.writeFileSync(path.join(legacyProfile, 'settings.json'), '{}\n');
    fs.writeFileSync(path.join(legacyProfile, 'mcp', 'coach-mcp.json'), '{"mcpServers":{}}\n');
    fs.writeFileSync(path.join(legacyProfile, '.claude.json'), `${JSON.stringify({
      auth_trust_fixture: { account: 'legacy-synthetic-account', trusted: true },
      mcpServers: { 'unrelated-legacy-fixture': { command: 'synthetic-command' } },
    }, null, 2)}\n`);
    fs.symlinkSync(legacyData, path.join(legacyProfile, 'skills', 'bill-career-coach'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(legacyMarkerPath, `${JSON.stringify({
      name: 'bill-career-coach', version: '1.2.4', schema_version: 1, installed_at: now,
    }, null, 2)}\n`);

    {
      const legacyState = new DatabaseSync(legacyStatePath);
      legacyState.prepare(`INSERT INTO memories
        (id,type,subject,content,status,effective_at,source_ids_json,confirmed,sensitive,supersedes_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('legacy-memory-fixture', 'context', 'legacy upgrade preservation', 'schema-one memory survives',
          'active', now, '[]', 1, 0, null, now, now);
      legacyState.prepare(`INSERT INTO sessions
        (id,started_at,updated_at,status,situation,judgment,evidence_ids_json,open_questions_json,next_move,closed_at,version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('legacy-session-fixture', now, now, 'closed', 'legacy situation', 'legacy judgment', '[]', '[]', 'legacy next move', now, 1);
      legacyState.prepare(`UPDATE onboarding SET status='pane_2', corrections=?, updated_at=? WHERE singleton=1`)
        .run('legacy synthetic correction', now);
      legacyState.close();
    }
    check(fs.existsSync(path.join(legacyData, '.mcp.json')), 'legacy installed shape contains the retired plugin MCP registration');

    const legacyEnv = {
      ...env,
      BILL_COACH_HOME: legacyHome,
      HOME: legacyHome,
      USERPROFILE: legacyHome,
      LOCALAPPDATA: path.join(legacyHome, 'AppData', 'Local'),
    };
    const legacyUpgrade = spawnSync(process.execPath, [path.join(packageCopy, 'install', 'install.mjs')], {
      cwd: packageCopy,
      env: legacyEnv,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    check(legacyUpgrade.status === 0 && String(legacyUpgrade.stdout).trim() === 'upgraded',
      'actual schema-1 installed profile upgrades through the current performInstall path', detail(legacyUpgrade));
    if (legacyUpgrade.status !== 0) throw new Error(`legacy schema upgrade failed: ${detail(legacyUpgrade)}`);

    const migratedLegacy = new DatabaseSync(legacyStatePath, { readOnly: true });
    check(Number(migratedLegacy.prepare(`SELECT value FROM state_meta WHERE key='schema_version'`).get()?.value) === sourceManifest.schema_version,
      `legacy state advances atomically to schema ${sourceManifest.schema_version}`);
    check(migratedLegacy.prepare(`SELECT content FROM memories WHERE id='legacy-memory-fixture'`).get()?.content === 'schema-one memory survives',
      'schema-changing upgrade preserves legacy memory');
    check(migratedLegacy.prepare(`SELECT judgment FROM sessions WHERE id='legacy-session-fixture'`).get()?.judgment === 'legacy judgment',
      'schema-changing upgrade preserves legacy session history');
    check(migratedLegacy.prepare(`SELECT corrections FROM onboarding WHERE singleton=1`).get()?.corrections === 'legacy synthetic correction',
      'schema-changing upgrade preserves legacy onboarding progress');
    migratedLegacy.close();
    const legacyConfig = JSON.parse(fs.readFileSync(path.join(legacyProfile, '.claude.json'), 'utf8'));
    check(legacyConfig.auth_trust_fixture?.trusted === true, 'schema-changing upgrade preserves legacy auth/trust state');
    check(legacyConfig.mcpServers?.['unrelated-legacy-fixture']?.command === 'synthetic-command',
      'schema-changing upgrade preserves unrelated legacy MCP registration');
    check(!fs.existsSync(path.join(legacyData, '.mcp.json')), 'upgrade removes the retired duplicate plugin MCP registration');
    check(JSON.parse(fs.readFileSync(legacyMarkerPath, 'utf8')).version === finalVersion,
      `legacy installed marker advances to ${finalVersion}`);
  } catch (err) {
    check(false, 'full installed-profile upgrade scenario completes', err?.stack || err);
  } finally {
    try { liveState?.close(); } catch { /* already closed */ }
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'MIGRATION TESTS PASSED' : `MIGRATION TESTS FAILED: ${failures}`);
process.exit(failures ? 1 : 0);
