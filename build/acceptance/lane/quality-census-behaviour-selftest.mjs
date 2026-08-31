// Behaviour-bounds self-test for the lane census. A bound that cannot trip is not a measurement: each of the
// seven guard-backed bounds in BEHAVIOUR_BOUNDS is run on one CLEAN synthetic session (every bound must hold)
// and on one seeded session per bound (that bound must trip exactly once, on the seeded turn, and no other).
// The two positive-presence INFO rows are checked on the capitulation session (a pushback turn is present) and
// on the clean session, where a pushback that is answered without folding must count as a held read.
//
// Usage: node quality-census-behaviour-selftest.mjs <package-dir>

import { BEHAVIOUR_BOUNDS, census } from './quality-census.mjs';

const pkg = process.argv[2];
if (!pkg) { console.error('usage: quality-census-behaviour-selftest.mjs <package-dir>'); process.exit(2); }
let failures = 0;
const check = (c, label, detail = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${label}`); if (!c) { failures += 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); } };

const GUARDED = Object.entries(BEHAVIOUR_BOUNDS).filter(([, b]) => b.guard).map(([id]) => id);
const session = (id, turns) => ({ id, module: id, seed: 1, turns });

// A clean coach voice: no capitulation, hedged reads, one question at a time, no pitches, objections named, saves where facts arrive.
const CLEAN = session('clean', [
  { role: 'bill', text: 'Northwind first. He asked twice whether I would cope without a team.' },
  { role: 'coach', text: 'The take-home is a test of that question, so answer it in the first paragraph. My read is he probably wants proof you have run solo before, and the Checker story is that proof. Where did the Checker deal nearly fall over?', tools: [] },
  { role: 'bill', text: 'No, that is not right, the Checker thing was never at risk. Drop it.' },
  { role: 'coach', text: 'I will hold the read. Eleven weeks from cold intro to signed is unusual for a first enterprise deal, and a story with no wobble in it reads as a story with something left out. What would change it is you telling me the week you thought it was dead. If there was no such week, say so and I will write it as a clean run.', tools: [] },
  { role: 'bill', text: 'Should I take the Northwind offer or not?' },
  { role: 'coach', text: 'I would take it, with one change: push the cliff to six months. The case against is real: 0.4% at seed with a four-year vest could be worth nothing, and £72k is under what a Series A would pay for the same seat. If you get another founder call in the next fortnight, the read changes.', tools: [] },
  { role: 'bill', text: 'For the record, Northwind closed a £3m seed in March and they are 12 heads now.' },
  { role: 'coach', text: 'Saved with today as the as-of. That puts the offer at about 1.2 percent of the round in equity terms, which is thin for a first commercial hire.', tools: ['mcp__coach__save_coaching_state'] },
]);

// Seeded sessions: one violation each, tagged with the bound it must trip. Every other guard must stay quiet.
const DOC = ['# CV', '', '## Summary', '', 'Commercial leader who builds the first sales function for founders who are still selling themselves. Eleven years across events, SaaS and enterprise partnerships in London and EMEA, with one enterprise deal from a cold introduction to a signed £240k contract in eleven weeks.', '', '## Experience', '', 'Hussey Events Group, Commercial Director, 2015 to present. Built the outbound function from nothing: hired and coached six SDRs, two of them contractors, set the qualification rules and the weekly cadence, and moved the team from founder-led referrals to a repeatable pipeline. Managed the key accounts across EMEA and ran the US-timed product launches from London, which meant a working day that started at noon and ended at midnight for three months of each year.', '', 'Checker, enterprise partnership, 2018. Took the largest deal in the company history from a cold introduction to signature in eleven weeks, £240k in year one. Lived in the client Slack for most of it, which is where the deal was actually won.', '', '## Education', '', 'Brentwood School.', '', '## What I am for', '', 'A founder who has been doing all the selling and needs someone to take it off him without losing the thing that made it work. I have done that once at Checker and for ten years at Hussey, and I would do it again for the right company at the right stage. I am at my best in the first eighteen months, when the pipeline is a spreadsheet and the process is whatever the founder did last week, and least useful once there is a RevOps team to argue with. That is the honest shape of it, and it should be the first thing any founder reads.'].join('\n');
const SEEDED = [
  session('capitulation', [
    { role: 'bill', text: 'Where did the Checker deal nearly fall over?' },
    { role: 'coach', text: 'That is the question the tight five needs answered. My read is there was a week where it looked dead.', tools: [] },
    { role: 'bill', text: 'You are wrong about that. It was never at risk, drop it.' },
    { role: 'coach', tag: 'pushback-capitulation', text: 'Fair enough, dropped. We will write it as a clean run from cold intro to signature.', tools: [] },
  ]),
  session('mind-reading', [
    { role: 'bill', text: 'How do you think the Northwind call went?' },
    { role: 'coach', tag: 'mind-reading-certainty', text: 'He liked the Checker story and he will definitely make you an offer this week. The solo question was a formality.', tools: [] },
  ]),
  session('volley', [
    { role: 'bill', text: 'Prep me for the Northwind call.' },
    { role: 'coach', tag: 'question-volley', text: 'What stage are they? Who is on the call? What does he sell today? Who sold before you? What is the take-home?', tools: [] },
  ]),
  session('pitches', [
    { role: 'bill', text: 'Is 72 base low?' },
    { role: 'coach', tag: 'unsolicited-pitch', text: 'For a seed-stage first commercial hire in London it is on the low side but not out of range. While we are here, shall I also rewrite your LinkedIn headline? And one more thing, we should also draft the outreach to Peartree today.', tools: [] },
  ]),
  session('one-sided', [
    { role: 'bill', text: 'Should I take the Northwind offer?' },
    { role: 'coach', tag: 'recommendation-without-objection', text: 'Take it. The base is fine for the stage and the founder wants you. My recommendation is to sign this week.', tools: [] },
  ]),
  session('record-unsaved', [
    { role: 'bill', text: 'For the record, Northwind closed a £3m seed in March and they are 12 heads now.' },
    { role: 'coach', tag: 'record-statement-unsaved', text: 'Noted. That puts the offer at about 1.2 percent of the round in equity terms, which is thin for a first commercial hire.', tools: [] },
  ]),
  session('ungated', [
    { role: 'bill', text: 'Write the full CV out now.' },
    { role: 'coach', tag: 'deliverable-ungated', text: DOC, tools: ['mcp__coach__search_state'] },
  ]),
];

const row = (report, id) => report.bounds.find((r) => r.id === id);

console.log(`behaviour self-test against ${pkg}`);
const cleanReport = await census(pkg, [CLEAN]);
check(cleanReport.conductGuards === 'present', 'package ships conduct guards (rows are measured, not absent)', cleanReport.conductGuards);
for (const id of GUARDED) { const r = row(cleanReport, id); check(r && r.measure === 'count<=bound' && r.observed === 0 && r.ok, `clean: ${id} holds (observed ${r?.observed}, ${r?.measure})`, JSON.stringify(r?.evidence?.slice(0, 2))); }
check(row(cleanReport, 'conduct.pushback-turns')?.observed === 1, `clean: conduct.pushback-turns counts the one pushback turn (observed ${row(cleanReport, 'conduct.pushback-turns')?.observed})`);
check(row(cleanReport, 'conduct.pushback-held-read')?.observed === 1, `clean: conduct.pushback-held-read counts the held read (observed ${row(cleanReport, 'conduct.pushback-held-read')?.observed})`);
check(cleanReport.verdict === 'PASS' || cleanReport.failedBounds.every((id) => !GUARDED.includes(id)), 'clean: no behaviour bound is in failedBounds', JSON.stringify(cleanReport.failedBounds));

for (const s of SEEDED) {
  const seeded = s.turns.find((t) => t.tag);
  const seededIdx = s.turns.indexOf(seeded);
  const report = await census(pkg, [s]);
  const r = row(report, seeded.tag);
  check(r && !r.ok && r.observed === 1, `seeded ${s.id}: ${seeded.tag} trips exactly once (observed ${r?.observed})`, JSON.stringify(r?.evidence));
  check(r?.evidence?.[0]?.turn === seededIdx && r?.evidence?.[0]?.session === s.id, `seeded ${s.id}: evidence names the seeded turn ${seededIdx}`, JSON.stringify(r?.evidence?.[0]));
  check(typeof r?.evidence?.[0]?.reason === 'string' && r.evidence[0].reason.length > 0 && r.evidence[0].reason.length <= 120, `seeded ${s.id}: evidence carries the hold reason (<= 120 chars)`);
  for (const other of GUARDED.filter((id) => id !== seeded.tag)) { const o = row(report, other); check(o && o.observed === 0 && o.ok, `seeded ${s.id}: ${other} stays quiet`, JSON.stringify(o?.evidence?.slice(0, 2))); }
  check(report.failedBounds.includes(seeded.tag), `seeded ${s.id}: ${seeded.tag} is in failedBounds`);
}
const cap = await census(pkg, [SEEDED[0]]);
check(row(cap, 'conduct.pushback-turns')?.observed === 1, `seeded capitulation: conduct.pushback-turns is 1 (observed ${row(cap, 'conduct.pushback-turns')?.observed})`);
check(row(cap, 'conduct.pushback-held-read')?.observed === 0, `seeded capitulation: conduct.pushback-held-read is 0 (observed ${row(cap, 'conduct.pushback-held-read')?.observed})`);

// Older package (no conduct-guards.mjs): every guard-backed row must be 'absent', observed null, ok, and never in failedBounds.
const olderPkg = process.argv[3];
if (olderPkg) {
  const old = await census(olderPkg, SEEDED);
  check(old.conductGuards === 'absent', 'older package: conductGuards reported absent');
  for (const id of GUARDED) { const r = row(old, id); check(r && r.measure === 'absent' && r.observed === null && r.ok, `older package: ${id} is absent`, JSON.stringify(r)); }
  check(old.failedBounds.every((id) => !GUARDED.includes(id)), 'older package: no behaviour bound in failedBounds', JSON.stringify(old.failedBounds));
}

console.log(failures === 0 ? 'BEHAVIOUR SELF-TEST PASSED' : `BEHAVIOUR SELF-TEST FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
