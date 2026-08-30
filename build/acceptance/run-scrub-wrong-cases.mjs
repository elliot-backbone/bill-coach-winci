// T-WIN-001 wrong-case runner. For every seeded family copy, run the SAME scrub check the
// workflow ran on the clean package and require (a) a non-zero exit and (b) at least one
// failing check attributed to that family. A scrubber that is present but not on the
// executed path cannot produce this evidence, which is the point.
//
// Usage: node build/acceptance/run-scrub-wrong-cases.mjs <sentinel-plan.json> <scrub-check.mjs> <out.json>

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [PLAN, SCRUB, OUT] = process.argv.slice(2);
if (!PLAN || !SCRUB || !OUT) {
  console.error('usage: run-scrub-wrong-cases.mjs <sentinel-plan.json> <scrub-check.mjs> <out.json>');
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const scrubSha256 = crypto.createHash('sha256').update(fs.readFileSync(SCRUB)).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-wrong-'));
const results = [];
let allTripped = true;
for (const seed of plan.seeds) {
  const jsonOut = path.join(tmp, `${seed.family}.json`);
  const r = spawnSync(process.execPath, [SCRUB, seed.packageDir, '--json', jsonOut], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(jsonOut, 'utf8')); } catch { /* no report */ }
  const familyFails = report ? report.checks.filter((c) => !c.ok && c.family === seed.family) : [];
  const tripped = r.status !== 0 && familyFails.length > 0;
  if (!tripped) allTripped = false;
  results.push({
    family: seed.family, name: seed.name, seeded: seed.what, where: seed.where,
    exitCode: r.status, totalFails: report?.fails ?? null,
    familyFails: familyFails.map((c) => c.label),
    tripped,
    verdict: tripped ? 'REJECTED_AS_REQUIRED' : 'NOT_REJECTED',
  });
  console.log(`${tripped ? 'ok  ' : 'FAIL'} ${seed.family} ${seed.name}: exit ${r.status}, ${familyFails.length} family-attributed failures`);
}
const out = {
  schema: 'bill-coach.scrub-wrong-case/v1',
  contract: 'One sentinel from every sensitive family must fail before installation; a copied but uncalled scrubber is failure.',
  scrubCheckSha256: scrubSha256,
  families: results.length,
  allFamiliesTripped: allTripped,
  results,
  verdict: allTripped ? 'PASS' : 'FAIL',
};
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(allTripped ? `\nALL ${results.length} FAMILIES TRIPPED` : '\nWRONG CASE FAILED: a family did not trip');
process.exit(allTripped ? 0 : 1);
