// Windows VM preflight for the Bill Jennings Coach 2.1.2 candidate (handover packet §6).
// Runs from the exact candidate checkout and stops on any identity difference.
//
// Usage: node preflight.mjs <repo> <evidence-root> --expect-identity <digest> --expect-archive <sha>
//        [--expect-plan <hash>] [--expect-status <sha>] [--basis <commit>]

import fs from 'node:fs';
import path from 'node:path';
import { Ledger, claudeIdentity, fingerprint, identityOf, isWindows, nodeIdentity, psFileHash, run, sha256File, sidecarsUnder, writeJson, nowIso } from './lib.mjs';

const argv = process.argv.slice(2);
const [repo, evidenceRoot] = argv;
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
if (!repo || !evidenceRoot) { console.error('usage: preflight.mjs <repo> <evidence-root> --expect-identity <digest> --expect-archive <sha> ...'); process.exit(2); }
const expect = { identity: opt('--expect-identity'), archive: opt('--expect-archive'), plan: opt('--expect-plan'), status: opt('--expect-status'), basis: opt('--basis') };

const L = new Ledger('preflight');
const out = { schema: 'bill-coach.windows-preflight/v1', capturedAt: nowIso(), repo: path.resolve(repo), platform: process.platform, expected: expect, steps: {} };
const git = (args) => run('git', args, { cwd: repo, timeoutMs: 60000 });

// unzip for verify-release-identity: on Windows it lives in Git for Windows' usr\bin.
if (isWindows) {
  for (const c of ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\mingw64\\bin']) if (fs.existsSync(c)) process.env.PATH = `${c};${process.env.PATH}`;
}

// 1. git status / HEAD
const status = git(['status', '--short', '--branch']);
const porcelain = git(['status', '--porcelain=v1', '--untracked-files=all']);
const head = git(['rev-parse', 'HEAD']).stdout.trim();
out.steps.git = { head, statusShortBranch: status.stdout.trim(), porcelainLines: porcelain.stdout.split(/\r?\n/).filter(Boolean).length, autocrlf: git(['config', '--get', 'core.autocrlf']).stdout.trim() || '(unset)' };
L.check(head.length === 40, `git rev-parse HEAD (${head})`);
if (expect.basis) L.check(head === expect.basis, `HEAD equals git basis ${expect.basis}`, head);
L.check(out.steps.git.autocrlf !== 'true', 'core.autocrlf is not true (byte-exact worktree)', out.steps.git.autocrlf);

// 2. archive + sidecar
const registry = JSON.parse(fs.readFileSync(path.join(repo, 'estate/testing/acceptance-tasks.json'), 'utf8'));
const rel = registry.release;
const archive = path.join(repo, rel.archive);
const archiveSha = fs.existsSync(archive) ? sha256File(archive) : null;
const sidecar = fs.existsSync(`${archive}.sha256`) ? fs.readFileSync(`${archive}.sha256`, 'utf8') : null;
out.steps.archive = { path: archive, sha256: archiveSha, size: fs.existsSync(archive) ? fs.statSync(archive).size : null, sidecar: sidecar?.trim() ?? null, registryArchiveSha256: rel.archiveSha256 };
L.check(archiveSha === rel.archiveSha256, 'archive SHA-256 equals registry release.archiveSha256', archiveSha);
if (expect.archive) L.check(archiveSha === expect.archive, 'archive SHA-256 equals expected handover value', archiveSha);
L.check(sidecar === `${rel.archiveSha256}  ${rel.archive}\n`, 'checksum sidecar is exact shasum form');
if (isWindows) {
  const gh = psFileHash(archive);
  out.steps.archive.getFileHash = gh;
  L.check(gh === archiveSha, `PowerShell Get-FileHash agrees with node hash (${gh})`);
}

// 3. node + claude
out.steps.node = nodeIdentity();
out.steps.claude = claudeIdentity();
L.check(out.steps.node.major >= 24, `Node major >= 24 (${out.steps.node.version})`);
L.check(out.steps.claude.readable, `Claude Code returns a readable semantic version (${out.steps.claude.version}) — no minimum floor compared`, out.steps.claude.raw);

// 4. harness validate / self-tests / release plan / release identity
const acc = path.join(repo, 'estate/testing/acceptance.mjs');
const validate = run(process.execPath, [acc, 'validate'], { cwd: repo, timeoutMs: 120000 });
let validateJson = null; try { validateJson = JSON.parse(validate.stdout); } catch { /* reported below */ }
out.steps.validate = { status: validate.status, planHash: validateJson?.planHash ?? null, taskCount: validateJson?.taskCount ?? null, edition: validateJson?.edition ?? null, stderr: validate.stderr.slice(0, 300) };
L.check(validate.status === 0 && validateJson?.ok === true, `acceptance.mjs validate ok (plan ${validateJson?.planHash?.slice(0, 12)}…)`, validate.stderr);
if (expect.plan) L.check(validateJson?.planHash === expect.plan, 'semantic plan hash equals expected', validateJson?.planHash);
const selfTest = run(process.execPath, ['--test', '--test-reporter=tap', path.join(repo, 'estate/testing/acceptance.test.mjs')], { cwd: repo, timeoutMs: 300000 });
const passM = selfTest.stdout.match(/^# pass (\d+)/m); const failM = selfTest.stdout.match(/^# fail (\d+)/m);
out.steps.selfTests = { status: selfTest.status, pass: passM ? Number(passM[1]) : null, fail: failM ? Number(failM[1]) : null };
L.check(selfTest.status === 0 && out.steps.selfTests.fail === 0, `harness self-tests pass (${out.steps.selfTests.pass} pass / ${out.steps.selfTests.fail} fail)`);
const plan = run(process.execPath, [acc, 'plan', '--profile', 'release'], { cwd: repo, timeoutMs: 120000 });
out.steps.releasePlan = { status: plan.status, head: plan.stdout.slice(0, 600) };
L.check(plan.status === 0, 'plan --profile release compiles');
const vri = run(process.execPath, [path.join(repo, 'estate/testing/verify-release-identity.mjs')], { cwd: repo, timeoutMs: 600000 });
const kv = Object.fromEntries(vri.stdout.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=')));
out.steps.releaseIdentity = { status: vri.status, stdout: vri.stdout.trim(), stderr: vri.stderr.trim().slice(0, 500), parsed: kv };
L.check(vri.status === 0 && /RELEASE IDENTITY PASSED/.test(vri.stdout), 'verify-release-identity: RELEASE IDENTITY PASSED', vri.stderr || vri.stdout);
L.check(kv.source_status === 'WORKTREE_CANDIDATE', 'source_status is WORKTREE_CANDIDATE', kv.source_status);
L.check(kv.zip_entries === '57' && kv.manifest_entries === '56', '57 ZIP entries / 56 manifest entries', `${kv.zip_entries}/${kv.manifest_entries}`);

// 5. exact target identity through the harness
let identity = null;
try { identity = await identityOf(repo); } catch (err) { out.steps.identityError = String(err.message); }
out.steps.identity = identity;
L.check(identity !== null, 'target identity computed by the candidate harness');
if (identity && expect.identity) L.check(identity.targetIdentityDigest === expect.identity, `target identity digest equals handover ${expect.identity.slice(0, 12)}…`, identity.targetIdentityDigest);
if (identity && expect.status) L.check(identity.gitStatusSha256 === expect.status, 'git status digest equals source Mac worktree', identity.gitStatusSha256);

// 6. sidecars
const side = sidecarsUnder(path.join(repo, 'estate/package'));
out.steps.sidecars = side;
L.check(side.length === 0, 'no SQLite WAL/SHM/journal sidecars in the source package tree', side.join(', '));

out.fingerprint = fingerprint();
out.summary = L.summary();
out.verdict = L.passed ? 'PASS' : 'STALE_OR_FAIL';
writeJson(path.join(evidenceRoot, 'preflight.json'), out);
console.log(`\nPREFLIGHT ${out.verdict}: ${out.summary.checks} checks, ${out.summary.fails} failed`);
process.exit(L.passed ? 0 : 1);
