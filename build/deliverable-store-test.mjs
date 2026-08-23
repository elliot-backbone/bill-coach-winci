// The deliverable store: does the artefact survive the session, and does refining it keep the
// version that came before.
//
// MEASURED 2026-08-22, running all fourteen declared deliverables end to end against a live
// model: Coach produced the CV, the tight five, the LinkedIn copy and the one-pager, showed
// them to Bill, and persisted none of them. There was no table to hold an artefact, so the
// doctrine routed the LESSONS into learnings and the artefact was lost with the session. A CV
// session stored fourteen learnings and zero CV.
//
// Usage: node deliverable-store-test.mjs <installed-home> <package>

const S = process.argv[3] ? process.argv[3].replace(/\/package$/, '') : '.';
const H = `${process.argv[2]}/.claude-bill-career-coach/plugins/data/bill-career-coach-skills-dir`;
const { DatabaseSync } = await import('node:sqlite');
const { pathToFileURL } = await import('node:url');
const { saveCoachingState } = await import(pathToFileURL(`${process.argv[3]}/plugin/runtime/memory.mjs`).href);
const ctxMod = await import(pathToFileURL(`${process.argv[3]}/plugin/runtime/context.mjs`).href);
const db = new DatabaseSync(`${H}/state/coach.sqlite`);
db.exec('PRAGMA busy_timeout = 10000');
// A freshly installed profile has no session row; make one rather than failing on its absence.
let sid = db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1").get()?.id;
if (!sid) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (id,started_at,updated_at,status,evidence_ids_json,open_questions_json,version)
              VALUES ('sess-deliv',?,?,'active','[]','[]',1)`).run(now, now);
  sid = 'sess-deliv';
}
const save = (d) => saveCoachingState(db, { session_id: sid, expected_session_version: db.prepare("SELECT version FROM sessions WHERE id=?").get(sid).version, deliverables: d });
db.exec("DELETE FROM deliverables; DELETE FROM state_fts WHERE tbl='deliverables';");
let fails=0; const ok=(c,l)=>{console.log(`  ${c?'ok  ':'FAIL'} ${l}`); if(!c)fails++;};

save([{kind:'cv', title:'CV — core full-time', body:'VERSION ONE BODY'}]);
let rows = db.prepare("SELECT * FROM deliverables WHERE kind='cv' ORDER BY version").all();
ok(rows.length===1 && rows[0].version===1 && rows[0].status==='live', 'first save creates version 1, live');

save([{kind:'cv', title:'CV — core full-time', body:'VERSION ONE BODY'}]);
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='cv'").get().n===1, 'an identical body does not create a second version');

save([{kind:'cv', title:'CV — core full-time', body:'VERSION TWO BODY', change_note:'Bill cut the SDR line'}]);
rows = db.prepare("SELECT * FROM deliverables WHERE kind='cv' ORDER BY version").all();
ok(rows.length===2, 'a changed body creates a new version');
ok(rows[0].status==='retired' && rows[1].status==='live', 'exactly one live head; the old version is kept, not deleted');
ok(rows[1].supersedes===rows[0].id, 'the new version chains to what it replaced');
ok(rows[0].body==='VERSION ONE BODY', 'the earlier text is still readable in full');
ok(rows[1].change_note==='Bill cut the SDR line', 'the reason for the revision is recorded');

save([{kind:'prep_brief', title:'Northwind', body:'BRIEF A', role_id:'role-x'},
      {kind:'prep_brief', title:'Other', body:'BRIEF B', role_id:'role-y'}]);
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='prep_brief' AND status='live'").get().n===2,
   'two companies each keep their own live prep brief');

const bad = save([{kind:'cv', title:'x', body:'   '}]);
ok((bad.conflicts||[]).some(c=>c.table==='deliverables'), 'an empty body is refused and reported, not silently dropped');
ok(db.prepare("SELECT COUNT(*) n FROM state_fts WHERE tbl='deliverables'").get().n>0, 'deliverables are searchable');

const lib = new DatabaseSync(`${H}/library/library.sqlite`, { readOnly: true });
const ctx = ctxMod.getContext(db, lib, { session_id: sid, question: 'cv' });
const live = (ctx?.deliverables ?? []);
ok(live.length===3, `start_coach preloads the live artefacts (${live.length})`);
ok(live.some(d=>d.kind==='cv' && d.body.includes('VERSION TWO')), 'the preload carries the current CV, not the retired one');
db.close();
console.log(fails? `\nFAILED ${fails}` : '\nDELIVERABLE STORE PASSED');
process.exit(fails?1:0);
