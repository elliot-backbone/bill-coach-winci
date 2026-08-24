// Does the package in THIS PUBLIC REPO contain any of Bill's real data?
//
// AUDITED 2026-08-23: the handover claimed verify-package.mjs "proves the scrub", and that
// script had ZERO call sites anywhere. The one control standing between a public repository
// and a private individual's record was never run. A control nothing calls is not a control.
//
// verify-package itself cannot serve here: on a scrubbed package its DATA assertions
// legitimately fail (there is no data), so it exits non-zero and would fail the job for the
// wrong reason. This asserts the inverse — that the data is ABSENT — and fails loudly if any
// of it is present.
//
// Usage: node build/scrub-check.mjs <package-dir>

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PKG = process.argv[2];
let fails = 0;
const ok = (c, l, d = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`);
  if (!c) { fails += 1; if (d) console.log(`       ${String(d).slice(0, 300)}`); }
};

// 1. Named individuals and the licensed provider must not appear anywhere in the tree.
// WHAT IS ACTUALLY SENSITIVE, and what is not. "Bill Jennings" is the product's own name and
// is already public in this repository's name — flagging it would make the check cry wolf on
// every run and be ignored, which is how a real leak gets through. What must never appear:
// the licensed data provider, the market baseline, and anything from his private record.
const BANNED = ['flowstate', 'PitchBook', 'pitchbook', 'Hussey'];
const textFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!/\.(sqlite|zip|png|jpg|pdf)$/.test(e.name)) textFiles.push(p);
  }
};
walk(PKG);
for (const term of BANNED) {
  const hits = textFiles.filter((f) => {
    try { return fs.readFileSync(f, 'utf8').includes(term); } catch { return false; }
  });
  ok(hits.length === 0, `"${term}" absent from every text file`, hits.slice(0, 3).join(', '));
}

// 2. Byte-level check of the databases, because a scrubbed row can survive in freed pages.
for (const db of ['state-template/coach.sqlite', 'library/library.sqlite']) {
  const p = path.join(PKG, db);
  if (!fs.existsSync(p)) { ok(false, `${db} exists`); continue; }
  const buf = fs.readFileSync(p);
  for (const term of BANNED) {
    ok(!buf.includes(Buffer.from(term)), `"${term}" absent from ${db} at byte level`);
  }
}

// 3. The tables that would carry his record must be empty — except the declared
// synthetic verifier fixtures. Since 1.13.2 the shipped verify-install requires
// rows in several tables, so make-test-package seeds exactly one obviously
// synthetic row each ('*-test' ids). Any OTHER row is a scrub failure: the check
// still catches a single real record.
const SYNTHETIC_IDS = new Set(['principal-test', 'role-test', 'event-test',
  'fact-test', 'memory-test', 'investor-test']);
const state = path.join(PKG, 'state-template/coach.sqlite');
if (fs.existsSync(state)) {
  const db = new DatabaseSync(state, { readOnly: true });
  for (const t of ['memories', 'roles', 'deliverables', 'narrative_coverage', 'cv_lines',
    'debrief_capture', 'learnings', 'commitments', 'contacts', 'investor_roster']) {
    try {
      const rows = db.prepare(`SELECT * FROM ${t}`).all();
      const foreign = rows.filter((r) => !SYNTHETIC_IDS.has(String(r.id ?? r.key ?? '')));
      ok(foreign.length === 0, `${t} carries only declared synthetic fixture rows (${rows.length} rows, ${foreign.length} foreign)`);
    } catch { /* table absent in an older schema: not a scrub failure */ }
  }
  // green_flags is DOCTRINE, not his data, and is expected to be POPULATED.
  try {
    const g = db.prepare('SELECT COUNT(*) c FROM green_flags').get().c;
    ok(g > 0, `green_flags is populated (${g}) — doctrine ships, data does not`);
  } catch { /* pre-schema-5 */ }
  db.close();
}

// 4. The market baseline is licensed and must not ship.
const lib = path.join(PKG, 'library/library.sqlite');
if (fs.existsSync(lib)) {
  const db = new DatabaseSync(lib, { readOnly: true });
  try {
    // The licensed baseline must be absent; the single declared synthetic verifier
    // fixture row ('deal-test') is permitted. Any other row is licensed data.
    const n = db.prepare(`SELECT COUNT(*) c FROM market_deals WHERE deal_id IS NOT 'deal-test'`).get().c;
    ok(n === 0, `market_deals carries no licensed rows (${n} beyond the synthetic fixture)`);
  } catch { /* table absent */ }
  db.close();
}

console.log(fails ? `\nSCRUB CHECK FAILED: ${fails} — DO NOT PUSH THIS PACKAGE` : '\nSCRUB CHECK PASSED');
process.exit(fails ? 1 : 0);
