// Shard plan: assign capture units (module×seed, card×seed) across N lanes, balanced by estimated
// turns, with a fixed cap per lane. Deterministic: same inputs → same plan. Emits one manifest per
// lane plus an index; each manifest is what a lane executes, unit by unit, as separate processes.
//
// Usage: node shard-plan.mjs --lanes 6 --seeds 1,2,3 --modules all|A,B --cards all|K,H --cap 220 --out <dir>
//        [--deck cards-v1.json] [--first-pass]   (first-pass = 1 seed, K/H/P/N families)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
const lanes = Number(opt('--lanes', 1));
const seeds = String(opt('--seeds', '1')).split(',').map(Number);
const cap = Number(opt('--cap', 220));
const out = opt('--out');
const deckPath = opt('--deck', path.join(path.dirname(new URL(import.meta.url).pathname), 'cards-v1.json'));
if (!out) { console.error('usage: shard-plan.mjs --lanes N --seeds 1,2 --modules all --cards all --cap 220 --out <dir>'); process.exit(2); }

// The fourteen modules (keys and turn budgets mirror estate/build/full-capture.mjs: opener + 2
// exchanges + demand = 4 coach turns + 2 bill turns; TIGHT_FIVE 30 exchanges; CV_COACHED 10).
export const MODULES = ['TIGHT_FIVE', 'CV_COACHED', 'LINKEDIN_LANDING_PAGE', 'CONTENT_PRODUCTION', 'POSITIONING_ONE_PAGER', 'DISCOVERY_PIPELINES', 'OUTREACH_MESSAGES', 'MEETING_RESEARCH_BRIEF', 'REHEARSAL', 'DEBRIEF_REVIEW', 'OFFER_REVIEW', 'NEGOTIATION_MODULE', 'WEEKLY_REVIEW', 'THREAD_PULL'];
// 2026-09-01 (operator): MINIMUM 24 TURNS PER MODULE. turnsForModule is 2 + 2*exchanges
// (coach opener + demand, then a bill+coach pair per exchange), so 11 exchanges is the floor
// that reaches 24. Before this every module except two ran TWO exchanges — six turns — which
// is why the census kept reporting that the module lanes barely exercise the conduct half.
const MIN_EXCHANGES = Number(process.env.MIN_EXCHANGES || 11);
const EXCHANGES = { TIGHT_FIVE: Number(process.env.DEEP_TIGHT_FIVE || 12), CV_COACHED: Number(process.env.DEEP_CV_COACHED || 11) };
const exchangesFor = (m) => Math.max(EXCHANGES[m] ?? 0, MIN_EXCHANGES);
const turnsForModule = (m) => 2 + 2 * exchangesFor(m); // coach opener+demand + (bill+coach) per exchange

const wantModules = opt('--modules', 'all') === 'all' ? MODULES : String(opt('--modules')).split(',');
const here = path.dirname(new URL(import.meta.url).pathname);
const deck = opt('--deck', null)
  ? JSON.parse(fs.readFileSync(deckPath, 'utf8'))
  : { cards: fs.readdirSync(here).filter((f) => /^cards-.*\.json$/.test(f)).sort().flatMap((f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')).cards ?? []) };
const wantFamilies = opt('--cards', 'all');
const cards = wantFamilies === 'none' ? [] : deck.cards.filter((c) => wantFamilies === 'all' || String(wantFamilies).split(',').includes(c.family));

const units = [];
for (const seed of seeds) {
  for (const m of wantModules) units.push({ kind: 'module', id: m, seed, estTurns: turnsForModule(m) });
  for (const c of cards) units.push({ kind: 'card', id: c.id, seed, estTurns: (c.bill_turns.length + (c.wrong_case?.bill_turns?.length ?? 0)) });
}
// balance: largest-first onto the lightest lane
units.sort((a, b) => b.estTurns - a.estTurns);
const plans = Array.from({ length: lanes }, (_, i) => ({ lane: i + 1, units: [], estTurns: 0 }));
for (const u of units) { const l = plans.reduce((a, b) => (a.estTurns <= b.estTurns ? a : b)); l.units.push(u); l.estTurns += u.estTurns; }
for (const p of plans) p.units.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) || a.seed - b.seed : a.kind === 'card' ? 1 : -1));

fs.mkdirSync(out, { recursive: true });
const index = { schema: 'bill-coach.shard-plan/v1', createdAt: new Date().toISOString(), lanes, seeds, cap, modules: wantModules, cardFamilies: [...new Set(cards.map((c) => c.family))], cardCount: cards.length, unitCount: units.length, estTurnsTotal: units.reduce((a, u) => a + u.estTurns, 0), lanesSummary: plans.map((p) => ({ lane: p.lane, units: p.units.length, estTurns: p.estTurns, overCap: p.estTurns > cap })), deckSha256: fs.existsSync(deckPath) ? crypto.createHash('sha256').update(fs.readFileSync(deckPath)).digest('hex') : null };
for (const p of plans) {
  const manifest = { schema: 'bill-coach.lane-manifest/v1', lane: p.lane, of: lanes, cap, seeds, units: p.units, estTurns: p.estTurns, deckSha256: index.deckSha256, createdAt: index.createdAt };
  fs.writeFileSync(path.join(out, `lane-${p.lane}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}
fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify(index.lanesSummary));
if (index.lanesSummary.some((l) => l.overCap)) { console.error(`a lane exceeds cap ${cap}; add lanes or reduce seeds`); process.exit(1); }
