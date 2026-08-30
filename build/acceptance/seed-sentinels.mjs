// T-WIN-001 wrong case: seed ONE synthetic sentinel from EACH sensitive family into its own
// copy of the scrubbed package, so the scrub check can be shown to trip on every family
// before any install step. Nothing here is real: every sentinel is an obviously synthetic
// value in the SHAPE of the family it stands for.
//
// Usage: node build/acceptance/seed-sentinels.mjs <scrubbed-package-dir> <out-root> [--json <plan-file>]
// Produces <out-root>/<Fn>/package for F1..F7 and a plan naming each seed.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const [SRC, OUT] = argv;
const jsonIdx = argv.indexOf('--json');
const PLAN = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
if (!SRC || !OUT) {
  console.error('usage: seed-sentinels.mjs <scrubbed-package-dir> <out-root> [--json <plan-file>]');
  process.exit(2);
}

const SEEDS = [
  { family: 'F1', name: 'bill-identifiers', where: 'INSTALL.md',
    what: 'a synthetic email, phone and postcode appended to a text file',
    apply: (pkg) => fs.appendFileSync(path.join(pkg, 'INSTALL.md'),
      '\n\nSENTINEL contact: sentinel.person@sentinel-private.test, +44 7700 900123, SW1A 1AA\n') },
  { family: 'F2', name: 'principal-profile', where: 'plugin/coach/principal-profile.json',
    what: 'a principal-profile.json carrying content rather than shape',
    apply: (pkg) => fs.writeFileSync(path.join(pkg, 'plugin/coach/principal-profile.json'),
      JSON.stringify({ version: 'scrubbed', generated: 'scrubbed', atoms: [{ id: 'sentinel-1', text: 'SENTINEL biography atom that must never ship' }] }, null, 2)) },
  { family: 'F3', name: 'sensitivity-atoms', where: 'state-template/coach.sqlite memories',
    what: 'one foreign sensitive memory row',
    apply: (pkg) => {
      const db = new DatabaseSync(path.join(pkg, 'state-template/coach.sqlite'));
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO memories (id, type, subject, content, source_ids_json, created_at, updated_at)
                  VALUES ('memory-sentinel-1', 'context', 'sentinel', 'SENTINEL sensitivity atom', '[]', ?, ?)`).run(now, now);
      db.prepare(`UPDATE memories SET sensitive = 1 WHERE id = 'memory-sentinel-1'`).run();
      db.close();
    } },
  { family: 'F4', name: 'licensed-deal-rows', where: 'library/library.sqlite market_deals',
    what: 'one foreign market_deals row',
    apply: (pkg) => {
      const db = new DatabaseSync(path.join(pkg, 'library/library.sqlite'));
      db.prepare(`INSERT INTO market_deals (deal_id, company) VALUES ('deal-sentinel-1', 'Sentinel Ventures Ltd')`).run();
      db.close();
    } },
  { family: 'F5', name: 'private-doctrine', where: 'plugin/coach/method.md',
    what: 'a doctrine file that is no longer a placeholder',
    apply: (pkg) => fs.writeFileSync(path.join(pkg, 'plugin/coach/method.md'),
      '# method\n\nSENTINEL doctrine fragment. This body is not a placeholder and must never reach a public tree.\n') },
  { family: 'F6', name: 'db-bytes', where: 'state-template/coach.sqlite freed pages',
    what: 'a banned term written then deleted without VACUUM so its bytes survive in a freed page',
    apply: (pkg) => {
      const db = new DatabaseSync(path.join(pkg, 'state-template/coach.sqlite'));
      const now = new Date().toISOString();
      db.prepare('PRAGMA secure_delete = OFF').run();
      const filler = 'PitchBook sentinel byte residue '.repeat(200);
      for (let i = 0; i < 20; i += 1) {
        db.prepare(`INSERT INTO memories (id, type, subject, content, source_ids_json, created_at, updated_at)
                    VALUES (?, 'context', 'sentinel', ?, '[]', ?, ?)`).run(`memory-bytes-${i}`, filler, now, now);
      }
      db.prepare(`DELETE FROM memories WHERE id LIKE 'memory-bytes-%'`).run();
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
      db.close();
      for (const side of ['-wal', '-shm']) {
        const p = path.join(pkg, `state-template/coach.sqlite${side}`);
        if (fs.existsSync(p)) fs.rmSync(p);
      }
    } },
  { family: 'F7', name: 'private-key-material', where: 'install/.deploy_key',
    what: 'a synthetic OpenSSH private-key block',
    apply: (pkg) => fs.writeFileSync(path.join(pkg, 'install/.deploy_key'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nU0VOVElORUwgS0VZIE1BVEVSSUFMIC0gTk9UIEEgUkVBTCBLRVk=\n-----END OPENSSH PRIVATE KEY-----\n') },
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const plan = [];
for (const seed of SEEDS) {
  const dst = path.join(OUT, seed.family, 'package');
  fs.cpSync(SRC, dst, { recursive: true, filter: (s) => !/\.sqlite-(wal|shm|journal)$/.test(s) });
  seed.apply(dst);
  // A write to a WAL-mode database leaves -wal/-shm sidecars; checkpoint and remove them so
  // the only difference from the clean package is the one sentinel this family seeds.
  for (const db of ['state-template/coach.sqlite', 'library/library.sqlite']) {
    const p = path.join(dst, db);
    if (fs.existsSync(`${p}-wal`)) {
      const h = new DatabaseSync(p);
      h.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
      h.close();
    }
    for (const side of ['-wal', '-shm', '-journal']) if (fs.existsSync(p + side)) fs.rmSync(p + side);
  }
  plan.push({ family: seed.family, name: seed.name, where: seed.where, what: seed.what, packageDir: dst });
  console.log(`seeded ${seed.family} ${seed.name}: ${seed.what}`);
}
if (PLAN) {
  fs.mkdirSync(path.dirname(path.resolve(PLAN)), { recursive: true });
  fs.writeFileSync(PLAN, `${JSON.stringify({ schema: 'bill-coach.scrub-sentinel-plan/v1', source: path.resolve(SRC), seeds: plan }, null, 2)}\n`);
}
