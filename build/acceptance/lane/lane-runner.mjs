// Lane sequencer: executes a lane manifest unit by unit, ONE PROCESS PER UNIT (unit-runner.mjs), which
// in turn runs ONE PROCESS PER TURN. Nothing accumulates in memory; every event is appended to disk as
// it happens (progress.jsonl, receipts.jsonl, errors.jsonl), so a cancelled lane still yields
// everything up to the cut. Resumable: units already marked done in progress.jsonl are skipped.
//
// Usage: node lane-runner.mjs <manifest.json> <lane-dir> --profile <sealed profile> --package <expanded pkg>
//        [--claude <bin>] [--cap <turns>] [--resume]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [manifestPath, laneDir] = argv;
const opt = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
if (!manifestPath || !laneDir || !opt('--profile') || !opt('--package')) { console.error('usage: lane-runner.mjs <manifest> <lane-dir> --profile <dir> --package <dir> [--claude bin] [--cap n] [--resume]'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const cap = Number(opt('--cap', manifest.cap ?? 220));
fs.mkdirSync(laneDir, { recursive: true });
const append = (file, obj) => fs.appendFileSync(path.join(laneDir, file), `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
const turnsSoFar = () => (fs.existsSync(path.join(laneDir, 'turns.count')) ? fs.readFileSync(path.join(laneDir, 'turns.count'), 'utf8').split('\n').filter(Boolean).length : 0);
const done = new Set();
if (argv.includes('--resume') && fs.existsSync(path.join(laneDir, 'progress.jsonl'))) {
  for (const l of fs.readFileSync(path.join(laneDir, 'progress.jsonl'), 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); if (e.event === 'unit-done') done.add(e.unitKey); }
}
append('progress.jsonl', { event: 'lane-start', lane: manifest.lane, of: manifest.of, units: manifest.units.length, cap, resume: argv.includes('--resume'), skipping: [...done] });
let ok = 0; let failed = 0; let skipped = 0; let capped = false;
manifest.units.forEach((u, i) => {
  const unitKey = `${u.kind}-${u.id}-s${u.seed}`;
  if (done.has(unitKey)) { skipped += 1; return; }
  if (capped) { append('progress.jsonl', { event: 'unit-skipped-cap', unitKey }); skipped += 1; return; }
  if (turnsSoFar() + (u.estTurns ?? 0) > cap) { capped = true; append('errors.jsonl', { class: 'CAP_REACHED', unitKey, turnsSoFar: turnsSoFar(), estTurns: u.estTurns, cap, hint: 'raise --cap or add lanes; nothing after this unit ran' }); append('progress.jsonl', { event: 'unit-skipped-cap', unitKey }); skipped += 1; return; }
  append('progress.jsonl', { event: 'unit-start', unitKey, index: i, estTurns: u.estTurns });
  const started = Date.now();
  // 240 min per unit, not 90: a hard-mode module is 290+ turns at a measured median of
  // 23.5s/turn (worst lane 38s) — 1.9 to 3.1 hours. The 90-minute limit would have
  // killed every hard module two-thirds done and reported it as a unit failure.
  const r = spawnSync(process.execPath, [path.join(HERE, 'unit-runner.mjs'), manifestPath, String(i), laneDir, '--profile', opt('--profile'), '--package', opt('--package'), ...(opt('--claude') ? ['--claude', opt('--claude')] : []), '--cap', String(cap)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 240 * 60 * 1000, windowsHide: true });
  fs.appendFileSync(path.join(laneDir, 'lane-runner.log'), `\n=== ${unitKey} exit ${r.status} ${r.signal ?? ''} ===\n${r.stdout}\n${r.stderr}\n`);
  const durationMs = Date.now() - started;
  if (r.status === 0) { ok += 1; append('progress.jsonl', { event: 'unit-done', unitKey, durationMs, turnsSoFar: turnsSoFar() }); }
  else if (r.status === 3) { capped = true; failed += 1; append('progress.jsonl', { event: 'unit-capped', unitKey, durationMs }); }
  else { failed += 1; append('progress.jsonl', { event: 'unit-failed', unitKey, exit: r.status, signal: r.signal, durationMs }); append('errors.jsonl', { class: r.error?.code === 'ETIMEDOUT' ? 'UNIT_TIMEOUT' : 'UNIT_FAILED', unitKey, exit: r.status, signal: r.signal, stderrTail: (r.stderr || '').split('\n').filter(Boolean).slice(-15), hint: 'see turns/<unitKey>/error.json and lane-runner.log' }); }
  console.log(`[lane ${manifest.lane}] ${unitKey}: ${r.status === 0 ? 'ok' : `exit ${r.status}`} (${Math.round(durationMs / 1000)}s; turns so far ${turnsSoFar()}/${cap})`);
});
const summary = { schema: 'bill-coach.lane-summary/v1', lane: manifest.lane, of: manifest.of, units: manifest.units.length, ok, failed, skipped, capped, turns: turnsSoFar(), cap, endedAt: new Date().toISOString() };
fs.writeFileSync(path.join(laneDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
append('progress.jsonl', { event: 'lane-end', ...summary });
console.log(JSON.stringify(summary));
process.exit(failed && !ok ? 1 : 0);
