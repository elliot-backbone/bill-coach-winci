// Ingest adapter evidence into the candidate's acceptance harness as external attempts.
// One task per executor identity; the evaluator is a different actor in a different job.
//
// Usage: node ingest.mjs <repo> <run-dir> <evidence-root> <actor-prefix> <task-id>...
// Each <evidence-root>/<task-id>/ must hold the task's required files plus adapter-verdict.json.

import fs from 'node:fs';
import path from 'node:path';
import { run, writeJson } from './lib.mjs';

const [repo, runDir, evidenceRoot, actorPrefix, ...tasks] = process.argv.slice(2);
if (!repo || !runDir || !evidenceRoot || !actorPrefix || tasks.length === 0) { console.error('usage: ingest.mjs <repo> <run-dir> <evidence-root> <actor-prefix> <task-id>...'); process.exit(2); }
const acc = path.join(repo, 'estate', 'testing', 'acceptance.mjs');
const report = { schema: 'bill-coach.acceptance-ingest/v1', runDir: path.resolve(runDir), tasks: {} };
let failed = 0;
for (const task of tasks) {
  const dir = path.join(evidenceRoot, task);
  const verdictFile = path.join(dir, 'adapter-verdict.json');
  if (!fs.existsSync(verdictFile)) { report.tasks[task] = { error: 'adapter-verdict.json missing; nothing ingested' }; failed += 1; continue; }
  const v = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
  const actor = `${actorPrefix}-${task}`;
  const r = run(process.execPath, [acc, 'record-external', '--run-dir', runDir, '--task', task, '--actor', actor, '--evidence-dir', dir, '--verdict', v.verdict], { cwd: repo, timeoutMs: 300000 });
  let result = null; try { result = JSON.parse(r.stdout); } catch { /* error text below */ }
  report.tasks[task] = { actor, verdict: v.verdict, reasons: v.reasons, exit: r.status, targetIdentityDigest: result?.targetIdentityDigest ?? null, evidenceManifestSha256: result?.evidenceManifestSha256 ?? null, error: r.status === 0 ? null : (r.stderr || r.stdout).slice(0, 500) };
  console.log(`${task}: ${v.verdict} -> record-external exit ${r.status}${result?.targetIdentityDigest ? ` identity ${result.targetIdentityDigest.slice(0, 12)}…` : ''}`);
  if (r.status !== 0 && r.status !== 1) failed += 1; // exit 1 = recorded with a non-PASS verdict; 2 = harness error
}
writeJson(path.join(runDir, 'ingest-report.json'), report);
process.exit(failed ? 1 : 0);
