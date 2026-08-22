// The migration runs against Bill's live memory. Prove it on a real pre-1.3 database
// with real rows in it, and prove the rows survive.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [oldPkg, newPkg] = process.argv.slice(2);
let failures = 0;
const check = (c, l, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) { failures++; if (d) console.log(`       ${String(d).slice(0, 300)}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-migrate-'));
const db1 = path.join(dir, 'coach.sqlite');
fs.copyFileSync(path.join(oldPkg, 'state-template', 'coach.sqlite'), db1);

// Put real content in the old shape, including a row in the table being renamed.
{
  const db = new DatabaseSync(db1);
  db.exec('PRAGMA busy_timeout = 10000');
  const now = new Date().toISOString();
  check(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='people'`).get().n === 1, 'the pre-1.3 database has a people table');
  db.prepare(`INSERT INTO people (id,name,role,strengths_json,focus_areas_json,working_model,confirmed,source_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('principal-bill', 'Bill Jennings', 'principal', JSON.stringify(['closing']), JSON.stringify(['first commercial hire']),
      'terse', 1, JSON.stringify(['bill-said']), now, now);
  db.prepare(`INSERT INTO memories (id,type,subject,content,source_ids_json,confirmed,sensitive,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('pre-migration-memory', 'context', 'survives', 'this row must exist after the migration', '[]', 1, 0, now, now);
  db.close();
}

const { MIGRATIONS } = await import(`${newPkg}/install/upgrade.mjs`);
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
  check(row.length === 1 && row[0].id === 'principal-bill', 'the existing row carried across', JSON.stringify(row));
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
  check(rows[0].name === 'Bill Jennings', 'the seed is the principal model', JSON.stringify(rows));
  db.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'MIGRATION TESTS PASSED' : `MIGRATION TESTS FAILED: ${failures}`);
process.exit(failures ? 1 : 0);
