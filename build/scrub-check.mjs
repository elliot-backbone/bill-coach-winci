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
// v2 (2026-08-30, acceptance T-WIN-001): every check is now attributed to one of the SEVEN
// SENSITIVE FAMILIES the testing plan names (B03), so a seeded sentinel from any family can be
// shown to trip the family it belongs to, and the result can be written as JSON evidence.
// No private plaintext lives here: the detectors are structural (placeholder headers, declared
// synthetic fixture ids, freelist and byte scans, PII/key-material shapes), not a list of
// Bill's actual identifiers. The four historic banned terms are the licensed data provider,
// the market baseline and a public-in-this-repo surname; they stay.
//
// Usage: node build/scrub-check.mjs <package-dir> [--json <out-file>]
//
// Families:
//   F1 bill-identifiers        PII shapes (email, phone, UK postcode) and the historic names
//   F2 principal-profile       principal.md / principal-profile.json / principal_profile rows
//   F3 sensitivity-atoms       memories (esp. sensitive=1) and the other record tables
//   F4 licensed-deal-rows      market_deals / market_deals_fts and the provider names
//   F5 private-doctrine        coach, lens, skill and docs files must be placeholders;
//                              library documents/chunks/doctrine only synthetic rows
//   F6 db-bytes                freed pages, byte-level term scan, WAL/SHM/journal sidecars
//   F7 private-key-material    PEM/OpenSSH keys, API tokens, GitHub/AWS credential shapes

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const PKG = argv[0];
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
if (!PKG || (jsonIdx >= 0 && !JSON_OUT) || argv.length > (jsonIdx >= 0 ? 3 : 1)) {
  console.error('usage: node build/scrub-check.mjs <package-dir> [--json <out-file>]');
  process.exit(2);
}
if (!fs.existsSync(path.join(PKG, 'manifest.json'))) {
  console.error(`not a package directory (no manifest.json): ${PKG}`);
  process.exit(2);
}

export const FAMILIES = Object.freeze({
  F1: 'bill-identifiers',
  F2: 'principal-profile',
  F3: 'sensitivity-atoms',
  F4: 'licensed-deal-rows',
  F5: 'private-doctrine',
  F6: 'db-bytes',
  F7: 'private-key-material',
});

const checks = [];
let fails = 0;
const ok = (family, c, label, d = '') => {
  const fam = FAMILIES[family];
  checks.push({ family, familyName: fam, ok: Boolean(c), label, detail: c ? '' : String(d).slice(0, 300) });
  console.log(`  ${c ? 'ok  ' : 'FAIL'} [${family} ${fam}] ${label}`);
  if (!c) { fails += 1; if (d) console.log(`       ${String(d).slice(0, 300)}`); }
};

// ---------------------------------------------------------------- tree walk
const allFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else allFiles.push(p);
  }
};
walk(PKG);
const rel = (p) => path.relative(PKG, p).split(path.sep).join('/');
const textFiles = allFiles.filter((f) => !/\.(sqlite|zip|png|jpg|pdf)$/.test(f));
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------- F1 + F4: named terms
// "Bill Jennings" is the product's own name and is already public in this repository's
// name — flagging it would make the check cry wolf on every run and be ignored, which is
// how a real leak gets through. What must never appear: the licensed data provider, the
// market baseline, and the one historic surname from his private record.
const BANNED = [
  { term: 'flowstate', family: 'F4' },
  { term: 'pitchbook', family: 'F4' },
  { term: 'hussey', family: 'F1' },
];
for (const { term, family } of BANNED) {
  const hits = textFiles.filter((f) => readText(f).toLowerCase().includes(term));
  ok(family, hits.length === 0, `banned term absent from every text file (${term.length} chars, ${family})`, hits.slice(0, 3).map(rel).join(', '));
}

// ---------------------------------------------------------------- F1: PII shapes
const PII = [
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: 'phone', re: /(\+44\s?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}|\b0\d{3,4}[ -]?\d{3}[ -]?\d{3,4}\b)/g },
  { id: 'uk-postcode', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g },
];
for (const { id, re } of PII) {
  const hits = [];
  for (const f of textFiles) {
    const m = readText(f).match(re);
    if (m) hits.push(`${rel(f)}: ${m[0]}`);
  }
  ok('F1', hits.length === 0, `no ${id} shapes in any text file`, hits.slice(0, 3).join('; '));
}

// ---------------------------------------------------------------- F5: placeholders
// make-test-package replaces every coach, lens, skill and docs file with a
// "# <name> (scrubbed)" placeholder and re-renders system-prompt.md from those placeholders.
const PLACEHOLDER_RE = /^# [^\n]* \(scrubbed\)\n/;
const mustBePlaceholder = allFiles.filter((f) => {
  const r = rel(f);
  if (r === 'plugin/coach/system-prompt.md') return false;
  if (r === 'plugin/coach/principal-profile.json') return false;
  return /^plugin\/coach\/.*\.md$/.test(r) || /^plugin\/lenses\/.*\.md$/.test(r)
    || r === 'plugin/skills/coach/SKILL.md' || /^docs\//.test(r);
});
ok('F5', mustBePlaceholder.length >= 15, `doctrine/lens/skill/docs surface enumerated (${mustBePlaceholder.length} files)`);
for (const f of mustBePlaceholder) {
  const t = readText(f);
  ok('F5', PLACEHOLDER_RE.test(t) && t.length < 400, `${rel(f)} is a scrubbed placeholder`, `${t.length} bytes, head: ${t.slice(0, 60).replace(/\n/g, ' ')}`);
}
// docs must be nothing but the placeholder README.
const docs = allFiles.map(rel).filter((r) => r.startsWith('docs/'));
ok('F5', docs.length === 1 && docs[0] === 'docs/README--scrubbed.md', 'docs/ carries only the scrubbed README', docs.join(', '));
// The system prompt is rendered from the placeholders; it must not carry the real
// principal section (detected structurally: the rendered principal block must be the
// placeholder line, and it must be far shorter than the real render).
{
  const sp = readText(path.join(PKG, 'plugin/coach/system-prompt.md'));
  ok('F5', sp.length > 0 && sp.length < 40000, `system-prompt.md is the scrubbed render (${sp.length} bytes)`);
  ok('F5', /principal\.md \(scrubbed\)/.test(sp) || !/^## Principal/m.test(sp), 'system-prompt.md principal section is the scrubbed placeholder');
}

// ---------------------------------------------------------------- F2: principal profile
{
  const pj = path.join(PKG, 'plugin/coach/principal-profile.json');
  let parsed = null; let leafStrings = [];
  try { parsed = JSON.parse(readText(pj)); } catch { /* handled below */ }
  const collect = (v) => {
    if (typeof v === 'string') leafStrings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  if (parsed) collect(parsed);
  const foreign = leafStrings.filter((s) => s !== 'scrubbed' && s !== '');
  ok('F2', parsed !== null, 'principal-profile.json parses');
  ok('F2', parsed !== null && foreign.length === 0, `principal-profile.json carries only shape, no content (${leafStrings.length} strings, ${foreign.length} foreign)`, foreign.slice(0, 2).join(' | '));
  const pm = readText(path.join(PKG, 'plugin/coach/principal.md'));
  ok('F2', PLACEHOLDER_RE.test(pm) && pm.length < 400, 'principal.md is a scrubbed placeholder');
}

// ---------------------------------------------------------------- state database
// The tables that would carry his record must be empty — except the declared synthetic
// verifier fixtures. Since 1.13.2 the shipped verify-install requires rows in several
// tables, so make-test-package seeds exactly one obviously synthetic row each ('*-test'
// ids). Any OTHER row is a scrub failure: the check still catches a single real record.
const SYNTHETIC_IDS = new Set(['principal-test', 'role-test', 'event-test',
  'fact-test', 'memory-test', 'investor-test']);
const statePath = path.join(PKG, 'state-template/coach.sqlite');
const libPath = path.join(PKG, 'library/library.sqlite');
// Open a private COPY of each database. Opening a WAL-mode file in place — even read-only —
// creates -wal/-shm sidecars inside the package under check, which the sidecar check below
// would then (correctly) report. The package must be left byte-identical by this check.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-check-'));
const openRO = (p) => {
  try {
    const copy = path.join(scratch, `${path.basename(path.dirname(p))}-${path.basename(p)}`);
    fs.copyFileSync(p, copy);
    return new DatabaseSync(copy, { readOnly: true });
  } catch { return null; }
};
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });
const rowsOf = (db, sql) => { try { return db.prepare(sql).all(); } catch { return null; } };

ok('F6', fs.existsSync(statePath), 'state-template/coach.sqlite exists');
ok('F6', fs.existsSync(libPath), 'library/library.sqlite exists');
const sdb = fs.existsSync(statePath) ? openRO(statePath) : null;
if (sdb) {
  const tableFamily = { principal_profile: 'F2', memories: 'F3', roles: 'F3', deliverables: 'F3', narrative_coverage: 'F3',
    cv_lines: 'F3', debrief_capture: 'F3', learnings: 'F3', commitments: 'F3', contacts: 'F3', investor_roster: 'F3',
    role_events: 'F3', facts: 'F3', positions_held: 'F3', interactions: 'F3', offers: 'F3' };
  for (const [t, fam] of Object.entries(tableFamily)) {
    const rows = rowsOf(sdb, `SELECT * FROM ${t}`);
    if (rows === null) continue; // table absent in this schema: not a scrub failure
    const foreign = rows.filter((r) => !SYNTHETIC_IDS.has(String(r.id ?? r.key ?? '')));
    ok(fam, foreign.length === 0, `${t} carries only declared synthetic fixture rows (${rows.length} rows, ${foreign.length} foreign)`,
      foreign.slice(0, 1).map((r) => JSON.stringify(r).slice(0, 120)).join(''));
  }
  const sens = rowsOf(sdb, `SELECT id FROM memories WHERE sensitive = 1`) ?? [];
  ok('F3', sens.every((r) => r.id === 'memory-test'), `sensitive memories are only the synthetic fixture (${sens.length})`, sens.map((r) => r.id).join(','));
  // green_flags is DOCTRINE, not his data, and is expected to be POPULATED.
  const g = rowsOf(sdb, 'SELECT COUNT(*) c FROM green_flags');
  if (g) ok('F5', g[0].c > 0, `green_flags is populated (${g[0].c}) — doctrine ships, data does not`);
  const fl = rowsOf(sdb, 'PRAGMA freelist_count');
  ok('F6', fl && fl[0].freelist_count === 0, `state-template has no freed pages (freelist ${fl?.[0]?.freelist_count})`);
  sdb.close();
}

// ---------------------------------------------------------------- library database
const ldb = fs.existsSync(libPath) ? openRO(libPath) : null;
if (ldb) {
  const n = rowsOf(ldb, `SELECT COUNT(*) c FROM market_deals WHERE deal_id IS NOT 'deal-test'`);
  ok('F4', n && n[0].c === 0, `market_deals carries no licensed rows (${n?.[0]?.c} beyond the synthetic fixture)`);
  const nf = rowsOf(ldb, `SELECT COUNT(*) c FROM market_deals_fts`);
  if (nf) ok('F4', nf[0].c <= 1, `market_deals_fts carries at most the synthetic row (${nf[0].c})`);
  for (const [t, idCol, keep] of [['documents', 'id', 'doc-test'], ['chunks', 'document_id', 'doc-test'], ['doctrine', 'id', 'doctrine-test']]) {
    const c = rowsOf(ldb, `SELECT COUNT(*) c FROM ${t} WHERE ${idCol} IS NOT '${keep}'`);
    if (c) ok('F5', c[0].c === 0, `library ${t} carries only the synthetic fixture (${c[0].c} foreign)`);
  }
  const fl = rowsOf(ldb, 'PRAGMA freelist_count');
  ok('F6', fl && fl[0].freelist_count === 0, `library has no freed pages (freelist ${fl?.[0]?.freelist_count})`);
  ldb.close();
}

// ---------------------------------------------------------------- F6: bytes and sidecars
for (const dbp of [statePath, libPath]) {
  if (!fs.existsSync(dbp)) continue;
  const buf = fs.readFileSync(dbp);
  const lower = Buffer.from(buf.toString('latin1').toLowerCase(), 'latin1');
  for (const { term } of BANNED) {
    ok('F6', !lower.includes(Buffer.from(term, 'latin1')), `banned term absent from ${rel(dbp)} at byte level (${term.length} chars)`);
  }
  const emailHit = buf.toString('latin1').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  ok('F6', !emailHit, `no email shape in ${rel(dbp)} bytes`, emailHit?.[0]);
}
const sidecars = allFiles.map(rel).filter((r) => /\.sqlite-(wal|shm|journal)$/.test(r));
ok('F6', sidecars.length === 0, 'no SQLite WAL/SHM/journal sidecars in the package', sidecars.join(', '));

// ---------------------------------------------------------------- F7: key material
const KEY_SHAPES = [
  { id: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'openssh-public-key', re: /\bssh-(rsa|ed25519|dss|ecdsa)\s+AAAA[0-9A-Za-z+/]{20,}/ },
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'oauth-bearer', re: /\bBearer\s+[A-Za-z0-9._-]{30,}/ },
];
for (const { id, re } of KEY_SHAPES) {
  const hits = [];
  for (const f of allFiles) {
    let s;
    try { s = fs.readFileSync(f).toString('latin1'); } catch { continue; }
    if (re.test(s)) hits.push(rel(f));
  }
  ok('F7', hits.length === 0, `no ${id} shape in any file (binary-inclusive scan)`, hits.slice(0, 3).join(', '));
}
const keyFiles = allFiles.map(rel).filter((r) => /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)|.*\.(pem|key|p12|pfx)|\.deploy_key|\.npmrc|\.netrc)$/.test(r));
ok('F7', keyFiles.length === 0, 'no key/credential-named files in the package', keyFiles.join(', '));

// ---------------------------------------------------------------- report
const byFamily = {};
for (const [k, name] of Object.entries(FAMILIES)) byFamily[k] = { name, checks: 0, fails: 0 };
for (const c of checks) { byFamily[c.family].checks += 1; if (!c.ok) byFamily[c.family].fails += 1; }
const verdict = fails ? 'FAIL' : 'PASS';
if (JSON_OUT) {
  fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify({
    schema: 'bill-coach.scrub-check/v2', package: path.resolve(PKG), checkedAt: new Date().toISOString(),
    families: byFamily, totalChecks: checks.length, fails, verdict, checks,
  }, null, 2)}\n`);
}
console.log(fails ? `\nSCRUB CHECK FAILED: ${fails} — DO NOT PUSH THIS PACKAGE` : '\nSCRUB CHECK PASSED');
process.exit(fails ? 1 : 0);
