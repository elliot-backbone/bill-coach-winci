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
const putRole = (id, company) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO roles (id, company, lane, phase, source, as_of, thesis_fit_json, bill_fit_json,
              their_side_json, investor_names_json, created_at, updated_at)
              VALUES (?, ?, 'core-ft', 'P0', 'deliverable regression fixture', ?, '{}', '{}', '{}', '[]', ?, ?)
              ON CONFLICT(id) DO UPDATE SET company=excluded.company, updated_at=excluded.updated_at`)
    .run(id, company, now.slice(0, 10), now, now);
};

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

putRole('role-x', 'Prep Brief Regression One');
putRole('role-y', 'Prep Brief Regression Two');
save([{kind:'prep_brief', title:'Northwind', body:'BRIEF A', role_id:'role-x'},
      {kind:'prep_brief', title:'Other', body:'BRIEF B', role_id:'role-y'}]);
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='prep_brief' AND status='live'").get().n===2,
   'two companies each keep their own live prep brief');

// A measured capture saved a Northwind offer review with its role, then saved the fuller
// Northwind review without role_id. Scope-exact version lookup treated both as version 1 and
// left two live heads. When the later title names exactly one company that already has a live
// artefact of this kind, omission of role_id means "same chain", not "start a global chain".
putRole('role-deliv-northwind', 'Northwind Regression Robotics');
save([{kind:'offer_review', title:'Northwind Regression Robotics — partial offer review',
  body:'NORTHWIND PARTIAL', role_id:'role-deliv-northwind'}]);
const partial = db.prepare("SELECT * FROM deliverables WHERE kind='offer_review' AND role_id='role-deliv-northwind'").get();
save([{kind:'offer_review', title:'Northwind Regression Robotics — complete offer review',
  body:'NORTHWIND COMPLETE'}]);
rows = db.prepare("SELECT * FROM deliverables WHERE kind='offer_review' AND role_id='role-deliv-northwind' ORDER BY version").all();
ok(rows.length===2 && rows[0].version===1 && rows[1].version===2,
   'a later unscoped title that uniquely names the company adopts its role and advances the chain');
ok(rows[0]?.id===partial.id && rows[0]?.status==='retired' && rows[1]?.status==='live',
   'scope adoption retires the measured partial head and leaves exactly one live company head');
ok(rows[1]?.supersedes===rows[0]?.id && rows[1]?.role_id==='role-deliv-northwind',
   'the adopted revision points to its predecessor and carries the company role');
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='offer_review' AND role_id IS NULL AND title LIKE 'Northwind Regression Robotics%'").get().n===0,
   'the omitted role does not fork a second global Northwind chain');

// The omission can happen in the other order too: first a company-named artefact is saved
// without role_id, then a later save supplies it. Even an identical body needs a new scoped
// row here, because the scope correction is what links and retires the global predecessor.
putRole('role-deliv-reverse', 'Reverse Order Systems');
save([{kind:'debrief', title:'Reverse Order Systems — founder debrief', body:'REVERSE ORDER BODY'}]);
const reverseGlobal = db.prepare("SELECT * FROM deliverables WHERE kind='debrief' AND role_id IS NULL").get();
save([{kind:'debrief', title:'Reverse Order Systems — founder debrief', body:'REVERSE ORDER BODY',
  role_id:'role-deliv-reverse'}]);
const reverse = db.prepare("SELECT * FROM deliverables WHERE kind='debrief' ORDER BY version").all();
ok(reverse.length===2 && reverse[0].id===reverseGlobal.id && reverse[0].status==='retired',
   'a later explicit role retires the uniquely company-named global predecessor');
ok(reverse[1].role_id==='role-deliv-reverse' && reverse[1].version===2 && reverse[1].status==='live',
   'reverse adoption creates the scoped version 2 even when its body is unchanged');
ok(reverse[1].supersedes===reverse[0].id,
   'the reverse-adopted scoped row links directly to the former global head');
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='debrief' AND status='live'").get().n===1,
   'reverse adoption leaves one live debrief head, not parallel global and scoped heads');

// Global work is real work too. A reusable introduction must coexist with a company reply,
// and revising that generic introduction must advance only the NULL-role chain.
save([{kind:'outreach', title:'Intro note — what Bill actually does', body:'GENERIC INTRO V1'},
      {kind:'outreach', title:'Northwind Regression Robotics — reply to offer', body:'NORTHWIND REPLY', role_id:'role-deliv-northwind'}]);
save([{kind:'outreach', title:'Intro note — what Bill actually does', body:'GENERIC INTRO V2'}]);
const outreach = db.prepare("SELECT * FROM deliverables WHERE kind='outreach' ORDER BY role_id IS NOT NULL, version").all();
ok(outreach.length===3 && outreach.filter(d=>d.status==='live').length===2,
   'a generic/global outreach chain coexists with the role-scoped company outreach');
const globalOutreach = outreach.filter(d=>d.role_id===null);
ok(globalOutreach.length===2 && globalOutreach[0].status==='retired' && globalOutreach[1].version===2,
   'revising genuinely generic work versions only the global chain');
const companyOutreach = outreach.find(d=>d.role_id==='role-deliv-northwind');
ok(companyOutreach?.status==='live' && companyOutreach?.version===1 && companyOutreach?.supersedes===null,
   'a later scoped outreach does not retire or inherit from a generic global introduction');

// Company matching is boundary-aware: a company name appearing merely as letters inside a
// word ("Ion" inside "negotiation") is no match and must not silently acquire that role.
putRole('role-deliv-ion', 'Ion');
save([{kind:'negotiation_plan', title:'Ion — negotiation plan', body:'ION PLAN', role_id:'role-deliv-ion'}]);
save([{kind:'negotiation_plan', title:'Negotiation principles for any offer', body:'GLOBAL PLAN'}]);
const plans = db.prepare("SELECT * FROM deliverables WHERE kind='negotiation_plan' AND status='live'").all();
ok(plans.length===2 && plans.some(d=>d.role_id==='role-deliv-ion') && plans.some(d=>d.role_id===null),
   'a no-match title stays global instead of silently adopting a substring match');

// When a title names two existing company scopes, guessing would merge the wrong histories.
// "Ambi Regression Labs" deliberately contains the other complete company name too.
putRole('role-deliv-ambi', 'Ambi Regression');
putRole('role-deliv-ambi-labs', 'Ambi Regression Labs');
save([{kind:'offer_review', title:'Ambi Regression — offer review', body:'AMBI OFFER', role_id:'role-deliv-ambi'},
      {kind:'offer_review', title:'Ambi Regression Labs — offer review', body:'AMBI LABS OFFER', role_id:'role-deliv-ambi-labs'}]);
save([{kind:'offer_review', title:'Ambi Regression Labs — comparison offer review', body:'AMBIGUOUS OFFER'}]);
const ambiguous = db.prepare("SELECT * FROM deliverables WHERE kind='offer_review' AND title LIKE 'Ambi Regression Labs — comparison%'").get();
ok(ambiguous?.role_id===null && ambiguous?.status==='live',
   'an ambiguous company title stays unscoped rather than guessing a role');
ok(db.prepare("SELECT COUNT(*) n FROM deliverables WHERE kind='offer_review' AND status='live' AND role_id IN ('role-deliv-ambi','role-deliv-ambi-labs')").get().n===2,
   'ambiguity retires neither of the two possible company heads');

// Forward ambiguity is decided from the whole roster, not merely the subset that already has
// this kind saved. Only Labs has a content head here, but the new comparison title names both
// roster companies, so the accident of save order must not assign the comparison to Labs.
putRole('role-deliv-forward-ambi', 'Forward Ambi');
putRole('role-deliv-forward-ambi-labs', 'Forward Ambi Labs');
save([{kind:'content', title:'Forward Ambi Labs — company post', body:'LABS POST',
  role_id:'role-deliv-forward-ambi-labs'}]);
save([{kind:'content', title:'Forward Ambi Labs and Forward Ambi — comparison post', body:'COMPARISON POST'}]);
const forwardAmbiguous = db.prepare("SELECT * FROM deliverables WHERE kind='content' ORDER BY role_id IS NOT NULL").all();
ok(forwardAmbiguous.length===2 && forwardAmbiguous.every(d=>d.status==='live'),
   'forward ambiguity checks companies without an existing same-kind head and retires neither artefact');
ok(forwardAmbiguous.some(d=>d.role_id===null && d.version===1)
   && forwardAmbiguous.some(d=>d.role_id==='role-deliv-forward-ambi-labs' && d.version===1),
   'a two-company comparison stays global when only one named company has a scoped chain');

// Reverse adoption also refuses a global title that names both the explicit company and a
// second company. The explicit role does not make a comparative artefact cease to be global.
putRole('role-deliv-ambi-reverse', 'Ambi Reverse');
putRole('role-deliv-ambi-reverse-labs', 'Ambi Reverse Labs');
save([{kind:'weekly_review', title:'Ambi Reverse Labs — comparison weekly review', body:'COMPARISON REVIEW'}]);
save([{kind:'weekly_review', title:'Ambi Reverse Labs — company weekly review', body:'COMPANY REVIEW',
  role_id:'role-deliv-ambi-reverse-labs'}]);
const reverseAmbiguous = db.prepare("SELECT * FROM deliverables WHERE kind='weekly_review' ORDER BY role_id IS NOT NULL").all();
ok(reverseAmbiguous.length===2 && reverseAmbiguous.every(d=>d.status==='live'),
   'reverse ambiguity keeps both the comparative global and explicit company review live');
ok(reverseAmbiguous.some(d=>d.role_id===null && d.version===1)
   && reverseAmbiguous.some(d=>d.role_id==='role-deliv-ambi-reverse-labs' && d.version===1 && d.supersedes===null),
   'an ambiguous global title is not silently adopted into the later explicit role');

// An upgraded database can already contain the exact fork this repair prevents: one scoped and
// one NULL-role live head for the same company. Seed that legacy state directly, then prove the
// next explicit save heals it atomically instead of versioning one side and leaving the twin live.
putRole('role-deliv-legacy-twin', 'Legacy Twin Regression');
const legacyNow = new Date().toISOString();
const seedLegacy = db.prepare(`INSERT INTO deliverables
  (id,kind,title,body,version,supersedes,change_note,status,role_id,session_id,created_at,updated_at)
  VALUES (?,?,?,?,1,NULL,NULL,'live',?,?,?,?)`);
seedLegacy.run('deliv-legacy-scoped', 'positioning_one_pager',
  'Legacy Twin Regression — positioning', 'SCOPED LEGACY BODY', 'role-deliv-legacy-twin', sid, legacyNow, legacyNow);
seedLegacy.run('deliv-legacy-global', 'positioning_one_pager',
  'Legacy Twin Regression — fuller positioning', 'GLOBAL LEGACY BODY', null, sid, legacyNow, legacyNow);
save([{kind:'positioning_one_pager', title:'Legacy Twin Regression — corrected positioning',
  body:'SCOPED LEGACY BODY', role_id:'role-deliv-legacy-twin'}]);
const healed = db.prepare("SELECT * FROM deliverables WHERE kind='positioning_one_pager' ORDER BY id").all();
const healedHead = healed.find(d=>d.status==='live');
ok(healed.length===3 && healed.filter(d=>d.status==='live').length===1,
   'a later scoped save retires both pre-existing legacy twin heads and leaves one live head');
ok(healedHead?.role_id==='role-deliv-legacy-twin' && healedHead?.version===2,
   'legacy reconciliation leaves a scoped next version based on the greatest prior version');
ok(healedHead?.supersedes==='deliv-legacy-scoped',
   'legacy reconciliation prefers the scoped predecessor while retaining the global row as retired history');
ok(healed.every(d=>d.id===healedHead.id || d.status==='retired'),
   'the legacy global history is preserved but no stale NULL-role twin remains live');

const bad = save([{kind:'cv', title:'x', body:'   '}]);
ok((bad.conflicts||[]).some(c=>c.table==='deliverables'), 'an empty body is refused and reported, not silently dropped');
const beforeBogusRole = db.prepare("SELECT COUNT(*) n FROM deliverables").get().n;
const bogusRole = save([{kind:'prep_brief', title:'Ghost company brief', body:'GHOST BODY',
  role_id:'role-does-not-exist'}]);
ok((bogusRole.conflicts||[]).some(c=>c.type==='unknown_role' && c.table==='deliverables'
   && c.role_id==='role-does-not-exist'),
   'an explicit nonexistent role is refused with a deliverables conflict');
ok(db.prepare("SELECT COUNT(*) n FROM deliverables").get().n===beforeBogusRole
   && !db.prepare("SELECT id FROM deliverables WHERE role_id='role-does-not-exist'").get(),
   'a refused nonexistent role leaves no orphan deliverable behind');
ok(db.prepare("SELECT COUNT(*) n FROM state_fts WHERE tbl='deliverables'").get().n>0, 'deliverables are searchable');

const lib = new DatabaseSync(`${H}/library/library.sqlite`, { readOnly: true });
const ctx = ctxMod.getContext(db, lib, { session_id: sid, question: 'cv' });
const live = (ctx?.deliverables ?? []);
const liveCount = db.prepare("SELECT COUNT(*) n FROM deliverables WHERE status='live'").get().n;
ok(live.length===liveCount, `start_coach preloads every live artefact (${live.length})`);
ok(live.some(d=>d.kind==='cv' && d.body.includes('VERSION TWO')), 'the preload carries the current CV, not the retired one');
db.close();
console.log(fails? `\nFAILED ${fails}` : '\nDELIVERABLE STORE PASSED');
process.exit(fails?1:0);
