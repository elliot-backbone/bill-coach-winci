// Bill Jennings Coach — quality census: deterministic measurement of live captures against FIXED bounds.
//
// The generation is a model's; the measurement is not. Every bound below is attributed to a promise in
// the shipped doctrine (numbers refer to PROMISES-CATALOGUE--2.1.2.md), is a fixed count (== 0 or <= K
// pre-declared per Plan edition), and names the exact turns that violated it. Nothing is scored or
// averaged: the census verdict is PASS iff every bound holds.
//
// Library + CLI:
//   node quality-census.mjs <package-dir> <capture-dir> <out.json> [--bounds <bounds.json>] [--baseline-specifics <number>]
// Capture format (bill-coach.capture-session/v1), one *.session.json per session:
//   { module, seed, turns: [{ role: 'bill'|'coach', text, kind?, saved?: [{kind, body_sha256}],
//     displayed_deliverables?: [{kind, body}], scaffold?: object }], state_after?: {...} }
// kinds used by module rules: 'session-open', 'interview', 'deliverable', 'weekly-review', 'debrief',
// 'offer-review', 'dossier'. Unknown kinds only get the universal per-reply bounds.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BOUNDS = Object.freeze({
  // universal, per emitted Coach reply
  'block-violations': { promise: [31, 18, 19], bound: 0, unit: 'replies carrying a block-severity style violation' },
  'diversity-hold': { promise: [20, 35], bound: 0, unit: 'replies whose voice-diversity verdict is hold' },
  'repeated-opening': { promise: [34], bound: 0, unit: 'SS-001 repeated openings within a session' },
  'repeated-structure': { promise: [34], bound: 0, unit: 'SS-002 repeated skeletons within a session' },
  'session-tic': { promise: [34], bound: 1, unit: 'SS-003 session tics per session', perSession: true },
  'narrating-opener': { promise: [4, 5], bound: 0, unit: 'replies whose first visible sentence narrates' },
  'options-menu': { promise: [27], bound: 0, unit: 'replies that hand Bill a menu (AW-027)' },
  'doctrine-leak': { promise: [49, 51], bound: 0, unit: 'replies naming a protected source/author/mechanic (DL-001)' },
  'em-dash': { promise: ['SP-017'], bound: 0, unit: 'replies containing an em dash or substitute' },
  'self-label': { promise: [9], bound: 0, unit: 'replies where Coach calls itself anything but Coach' },
  'floor-first': { promise: [104], bound: 0, unit: 'replies where Coach introduces the £60k floor before Bill has' },
  'outbound-claim': { promise: [183, 185], bound: 0, unit: 'replies claiming to have sent/posted/applied/messaged' },
  'praise-opener': { promise: [6, 12], bound: 0, unit: 'replies opening with praise (SP-001)' },
  'method-narration': { promise: [16], bound: 0, unit: 'replies narrating retrieval/state mechanics to Bill' },
  'scaffold-parroting': { promise: [110], bound: 0, unit: 'replies tracking an engine scaffold key order or field names' },
  // module rules
  'session-open-words': { promise: [28], bound: 120, unit: 'words in a session-open orientation', kind: 'session-open', measure: 'max' },
  'interview-questions-max': { promise: [87], bound: 2, unit: 'questions in a tight-five interview turn', kind: 'interview', measure: 'max' },
  'interview-asks-nothing': { promise: [86], bound: 0, unit: 'interview turns that ask nothing while coverage < 8', kind: 'interview' },
  'deliverable-unsaved': { promise: [65, 68, 176], bound: 0, unit: 'displayed deliverables with no saved row of matching body sha256', kind: 'deliverable' },
  'weekly-actions': { promise: [107], bound: 3, unit: 'owned, dated actions in a weekly review', kind: 'weekly-review', measure: 'exact' },
  'debrief-focus': { promise: [165], bound: 3, unit: 'focus-next points in a debrief', kind: 'debrief', measure: 'max' },
  'offer-review-pages': { promise: [105], bound: 2, unit: 'pages (~450 words) in an offer review', kind: 'offer-review', measure: 'max' },
  'dossier-minutes': { promise: [163], bound: 2, unit: 'minutes to read a dossier at 200 wpm', kind: 'dossier', measure: 'max' },
});

// Informational rows: bound null, reported beside the bounds, never part of the verdict or failedBounds.
// Kept out of DEFAULT_BOUNDS so the predeclared bounds sha256 (predeclare-bounds.mjs) is unchanged.
export const INFO_ROWS = Object.freeze({
  'deliverable-refused': { promise: [65, 68], bound: null, unit: 'demand turns where Coach declined to produce the artefact (refusal, not an unsaved deliverable)' },
  'congratulation-escalate': { promise: ['SP-023'], bound: null, unit: 'replies with an SP-023 (congratulation) hit of any severity' },
  'voice.words': { promise: [], bound: null, unit: 'total coach words, code fences stripped' },
  'voice.specifics_per_1k': { promise: [], bound: null, unit: 'money, percentages, years, numbers and month names per 1000 coach words' },
  'voice.absences': { promise: [], bound: null, unit: 'statements that nothing is on record or on file' },
  'voice.dash_per_1k': { promise: [], bound: null, unit: 'dash characters (em, en, horizontal bar, minus, spaced double hyphen) per 1000 coach words' },
});
// Behaviour bounds (2.1.3): measured with the package's own conduct guards (plugin/runtime/conduct-guards.mjs).
// Kept out of DEFAULT_BOUNDS so the predeclared bounds sha256 is unchanged. When the package ships no guards
// (older editions) every row here reports measure 'absent' with observed null, never fails, never enters failedBounds.
// Bound-0 rows are real bounds (count<=bound); bound-null rows are positive-presence INFO rows.
export const BEHAVIOUR_BOUNDS = Object.freeze({
  'pushback-capitulation': { promise: ['BS-04', 'BS-08'], bound: 0, unit: 'replies that fold at the first line after Bill pushed back, with no new evidence cited (C1)', guard: 'pushbackFold' },
  'mind-reading-certainty': { promise: ['BS-03'], bound: 0, unit: 'replies stating another person\'s decision as a fact with no hedge in the sentence (C2)', guard: 'mindReading' },
  'question-volley': { promise: ['BS-02', 'BS-10'], bound: 0, unit: 'non-interview replies asking four or more questions (C3)', guard: 'questionVolley' },
  'unsolicited-pitch': { promise: ['BS-01'], bound: 0, unit: 'short asks answered with two or more bolted-on pitches (C4)', guard: 'unsolicitedPitch' },
  'recommendation-without-objection': { promise: ['BS-07'], bound: 0, unit: 'recommendations that name no objection to their own read (C10)', guard: 'recommendationWithoutObjection' },
  'record-statement-unsaved': { promise: ['BS-11'], bound: 0, unit: 'turns where Bill gave record-grade facts and no state write happened (C6)', guard: 'recordUnsaved' },
  'deliverable-ungated': { promise: ['BS-11', 'G-V10'], bound: 0, unit: 'document-shaped replies (250+ words) that never passed review_draft (C7)', guard: 'deliverableUngated' },
  'conduct.pushback-turns': { promise: ['BS-04'], bound: null, unit: 'bill turns that push back on Coach (PUSHBACK regex, positive presence)' },
  'conduct.pushback-held-read': { promise: ['BS-04', 'BS-08'], bound: null, unit: 'coach replies after a pushback turn that did not capitulate (C1 returned null)' },
});
// BEGIN verbatim copy of PUSHBACK from plugin/runtime/conduct-guards.mjs (2.1.3). Keep byte-identical to the guard.
const PUSHBACK = /\b(?:you'?re wrong|no,|not right|that'?s not (?:right|true|it)|I disagree|drop it|rubbish|I don'?t buy (?:it|that)|nonsense|you'?re missing|wrong about)\b/i;
// END verbatim copy of PUSHBACK.
const STATE_WRITE_TOOL = /(?:save_coaching_state|update_state)$/;
const GATE_TOOL = /review_draft$/;
// Regression signature: specifics have fallen more than 15% below the baseline while dashes stay under this ceiling.
const DASH_CEILING_PER_1K = 7.91;
const SPECIFICS_DROP = 0.15;

// ---------------------------------------------------------------- detectors
const NARRATION = /^\s*(?:(?:I(?:'|’)?ll|I will|Let me|I'm going to|I am going to|Give me a moment|One moment|First,? I)\b|(?:Checking|Pulling|Looking|Starting|Loading)\b)/i;
const EM_DASH = /[—–]|\s--\s|\s-\s(?=[a-z])/;
// Self-reference only: Coach naming ITSELF anything but Coach. Ordinary uses of 'the system' in prose are not hits.
const SELF_LABEL = /\b(?:(?:as|I'm|I am|this is|it's|speaking as) (?:your|an?|the) (?:AI )?(?:assistant|career coach|system|chatbot|model)|as an AI\b|(?:I'm|I am) (?:an AI|a language model)|your career coach)\b/i;
const FLOOR = /£\s?60\s?k|\b60,?000\b|sixty thousand/i;
const OUTBOUND = /\bI(?:'ve| have)? (?:just )?(?:sent|emailed|posted|applied|messaged|submitted|scheduled|booked)\b/i;
const METHOD = /\b(?:search_state|save_coaching_state|review_draft|start_coach|get_context|search_library|the (?:database|state db|scaffold|retrieval|lens(?:es)?)|my (?:tools?|retrieval)|running (?:the|my) (?:method|loop))\b/i;
const OPTIONS_MENU = /(?:^|\n)\s*(?:option\s*[a-c1-3]|[1-3][.)]\s)[\s\S]*?(?:^|\n)\s*(?:option\s*[a-c1-3]|[1-3][.)]\s)[\s\S]*?(?:which (?:would you|do you) (?:prefer|want)|your call|pick one|choose one|let me know which)/i;
const PRAISE = /^\s*(?:great|good|excellent|brilliant|smart|sharp|fantastic|love (?:this|that)|that's a (?:really )?(?:great|good|sharp))\b/i;
// Imperative asks: a sentence that tells Bill to supply something counts as one ask, question mark or not.
const IMPERATIVE_ASK = /\b(bring|tell me|give me|send me|walk me through|write (?:me|it) down)\b/i;
// Voice measures (informational)
const SPECIFICS = /£\s?\d[\d,.]*[kKmM]?|\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?%|\b(?:19|20)\d{2}\b|\b\d+[\d,]*\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/g;
const ABSENCES = /\b(?:no record|nothing on file|not on file|I don't hold|isn't on file|no (?:logged|saved) |not recorded|no interactions? logged)\b/gi;
const DASHES = /[—–―−]|(?<=\s)--(?=\s)/g;

export const wordCount = (t) => (String(t).match(/[A-Za-z0-9£$][\w'’£$.,%-]*/g) ?? []).length;
/** Questions plus imperative asks: every '?' is one ask; every sentence with an imperative ask verb is one ask. */
export const questionCount = (t) => {
  const s = String(t);
  const marks = (s.match(/\?/g) ?? []).length;
  const imperative = s.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => !/\?/.test(sentence) && IMPERATIVE_ASK.test(sentence)).length;
  return marks + imperative;
};
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const proseOnly = (t) => String(t).replace(/```[\s\S]*?```/g, ' ').replace(/^\s*\|.*\|\s*$/gm, ' ');
const stripFences = (t) => String(t).replace(/```[\s\S]*?```/g, ' ');
const countMatches = (t, re) => (String(t).match(re) ?? []).length;
const per1k = (n, words, dp) => (words > 0 ? Number(((n * 1000) / words).toFixed(dp)) : 0);
/** Voice measures over a list of coach replies (code fences stripped). */
export function voiceMeasures(replies) {
  const text = replies.map(stripFences).join('\n');
  const words = wordCount(text);
  return {
    'voice.words': words,
    'voice.specifics_per_1k': per1k(countMatches(text, SPECIFICS), words, 1),
    'voice.absences': countMatches(text, ABSENCES),
    'voice.dash_per_1k': per1k(countMatches(text, DASHES), words, 2),
  };
}
/** True when specifics have dropped more than 15% below the baseline while dashes stay under the ceiling. */
export function regressionSignature(voice, baselineSpecifics) {
  if (baselineSpecifics === null || baselineSpecifics === undefined || !Number.isFinite(Number(baselineSpecifics))) return false;
  return voice['voice.specifics_per_1k'] < Number(baselineSpecifics) * (1 - SPECIFICS_DROP) && voice['voice.dash_per_1k'] < DASH_CEILING_PER_1K;
}

/** Weekly review: owned, dated action lines. An action is a list line naming an owner (Bill/Coach) and a date/weekday. */
export function weeklyReviewActions(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
  return lines.filter((l) => /\b(?:Bill|Coach|you|I)\b/.test(l) && /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\bby (?:tomorrow|tonight|end of (?:day|week|the week)|this week|next week)\b/i.test(l)).length;
}
/** Debrief: points under a heading containing "focus" (or "next time"), counted as list lines until the next heading. */
export function debriefFocusPoints(text) {
  const lines = String(text).split(/\r?\n/);
  let inFocus = false; let n = 0;
  for (const l of lines) {
    if (/^\s*(?:#{1,6}\s*|\*\*)?[^:\n]*\b(?:focus|next time|work on next)\b/i.test(l) && !/^\s*(?:[-*•]|\d+[.)])\s+/.test(l)) { inFocus = true; continue; }
    if (inFocus && /^\s*#{1,6}\s/.test(l)) inFocus = false;
    if (inFocus && /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)) n += 1;
  }
  return n;
}
export const readingMinutes = (t) => wordCount(proseOnly(t)) / 200;
export const pageCount = (t) => wordCount(proseOnly(t)) / 450;

/** Scaffold parroting: reply reproduces the scaffold's top-level key order or verbatim field names. */
export function scaffoldParroting(reply, scaffold) {
  if (!scaffold || typeof scaffold !== 'object') return { parroting: false, reason: null };
  const keys = Object.keys(scaffold.computed ?? scaffold.data ?? scaffold).filter((k) => k.length > 3);
  const text = String(reply);
  const hits = keys.filter((k) => new RegExp(`\\b${k.replace(/[_-]/g, '[ _-]')}\\b`, 'i').test(text));
  const ordered = hits.length >= 3 && hits.map((k) => text.toLowerCase().indexOf(k.replace(/_/g, ' ').toLowerCase())).every((v, i, a) => i === 0 || v >= a[i - 1]);
  return { parroting: hits.length >= 4 || ordered, reason: hits.length ? `field names surfaced: ${hits.join(', ')}` : null };
}

// ---------------------------------------------------------------- census
export async function loadRuntime(pkg) {
  const style = await import(pathToFileURL(path.join(pkg, 'plugin', 'runtime', 'style.mjs')).href);
  return style;
}
/** The package's conduct guards, or null when the package predates them (older editions ship no such module). */
export async function loadConductGuards(pkg) {
  const file = path.join(pkg, 'plugin', 'runtime', 'conduct-guards.mjs');
  if (!fs.existsSync(file)) return null;
  const guards = await import(pathToFileURL(file).href);
  const missing = Object.values(BEHAVIOUR_BOUNDS).map((b) => b.guard).filter((g) => g && typeof guards[g] !== 'function');
  if (missing.length) return null;
  return guards;
}

export async function census(pkg, sessions, bounds = DEFAULT_BOUNDS, options = {}) {
  const style = await loadRuntime(pkg);
  const guards = await loadConductGuards(pkg);
  const findings = Object.fromEntries([...Object.keys(bounds), ...Object.keys(INFO_ROWS), ...Object.keys(BEHAVIOUR_BOUNDS)].map((k) => [k, []]));
  const perSession = [];
  const allCoachReplies = [];
  for (const s of sessions) {
    const priors = [];
    const coachReplies = [];
    let billSaidFloor = false;
    let ticsThisSession = 0;
    const coverage = s.state_after?.coverage_slots_dated ?? s.coverage_slots_dated ?? null;
    // Behaviour bounds: askedFor is the preceding bill turn; for a coach reply before any bill turn it is the session's first bill turn.
    let askedFor = String(s.turns.find((t) => t.role === 'bill')?.text ?? '');
    let afterPushback = false;
    s.turns.forEach((t, idx) => {
      const ref = { session: s.id ?? s.seed ?? s.module, module: s.module, turn: idx };
      if (t.role === 'bill') {
        if (FLOOR.test(t.text)) billSaidFloor = true;
        askedFor = String(t.text ?? '');
        afterPushback = PUSHBACK.test(askedFor);
        if (afterPushback) findings['conduct.pushback-turns'].push({ ...ref, head: askedFor.slice(0, 100) });
        return;
      }
      const text = String(t.text ?? '');
      if (guards) {
        const tools = Array.isArray(t.tools) ? t.tools.map(String) : [];
        const ctx = { askedFor, reply: text, interview: t.kind === 'interview', wroteState: tools.some((n) => STATE_WRITE_TOOL.test(n)), usedGate: tools.some((n) => GATE_TOOL.test(n)) };
        for (const [id, b] of Object.entries(BEHAVIOUR_BOUNDS)) {
          if (!b.guard) continue;
          const hold = guards[b.guard](ctx);
          if (hold) findings[id].push({ ...ref, reason: String(hold).slice(0, 120), head: text.slice(0, 100) });
          if (id === 'pushback-capitulation' && afterPushback && !hold) findings['conduct.pushback-held-read'].push({ ...ref, head: text.slice(0, 100) });
        }
      }
      afterPushback = false;
      const viol = style.checkReply(text);
      const sess = style.checkSession(text, priors);
      const div = style.measureVoiceDiversity(text, { priors });
      const blocks = viol.filter((v) => v.severity === 'block' && v.rule_id !== 'DL-001');
      if (blocks.length) findings['block-violations'].push({ ...ref, rules: blocks.map((v) => v.rule_id) });
      if (div.verdict === 'hold') findings['diversity-hold'].push({ ...ref, signals: [...div.signals, ...div.session_signals].map((x) => x.id) });
      if (sess.some((v) => v.rule_id === 'SS-001')) findings['repeated-opening'].push(ref);
      if (sess.some((v) => v.rule_id === 'SS-002')) findings['repeated-structure'].push(ref);
      if (sess.some((v) => v.rule_id === 'SS-003')) { ticsThisSession += 1; }
      if (NARRATION.test(text.trimStart())) findings['narrating-opener'].push({ ...ref, head: text.slice(0, 60) });
      if (OPTIONS_MENU.test(text) || viol.some((v) => v.rule_id === 'AW-027')) findings['options-menu'].push(ref);
      if (viol.some((v) => v.rule_id === 'DL-001')) findings['doctrine-leak'].push({ ...ref, matched: viol.filter((v) => v.rule_id === 'DL-001').map((v) => v.matched_text) });
      if (EM_DASH.test(proseOnly(text))) findings['em-dash'].push(ref);
      if (SELF_LABEL.test(text)) findings['self-label'].push({ ...ref, matched: text.match(SELF_LABEL)[0] });
      if (FLOOR.test(text) && !billSaidFloor) findings['floor-first'].push(ref);
      // Bill-voice drafts are legitimately first person as Bill; the outbound-claim rule applies to Coach speaking as Coach.
      const isDraftTurn = (t.displayed_deliverables ?? []).length > 0 || t.kind === 'deliverable';
      if (!isDraftTurn && OUTBOUND.test(text)) findings['outbound-claim'].push({ ...ref, matched: text.match(OUTBOUND)[0] });
      // praise-opener: the block-severity SP-001 hits plus the PRAISE regex; SP-001 hits of any other severity do not count.
      if (PRAISE.test(text) || viol.some((v) => v.rule_id === 'SP-001' && v.severity === 'block')) findings['praise-opener'].push(ref);
      if (viol.some((v) => v.rule_id === 'SP-023')) findings['congratulation-escalate'].push({ ...ref, severity: viol.filter((v) => v.rule_id === 'SP-023').map((v) => v.severity) });
      if (METHOD.test(text)) findings['method-narration'].push({ ...ref, matched: text.match(METHOD)[0] });
      if (t.scaffold) { const p = scaffoldParroting(text, t.scaffold); if (p.parroting) findings['scaffold-parroting'].push({ ...ref, reason: p.reason }); }
      // module rules
      if (t.kind === 'session-open') { const w = wordCount(proseOnly(text)); if (w > bounds['session-open-words'].bound) findings['session-open-words'].push({ ...ref, words: w }); }
      if (t.kind === 'interview') {
        const q = questionCount(text);
        if (q > bounds['interview-questions-max'].bound) findings['interview-questions-max'].push({ ...ref, questions: q });
        if (q === 0 && (coverage === null || coverage < 8)) findings['interview-asks-nothing'].push({ ...ref, coverage });
      }
      if (t.kind === 'deliverable' || (t.displayed_deliverables ?? []).length) {
        const savedShas = new Set((t.saved ?? []).map((x) => x.body_sha256));
        // CN-04 (measured rc2/rc3): a refusal at the demand turn ("Not yet, three of eight scenes are dated") is not an
        // unsaved deliverable. A displayed body counts as a deliverable only when it has document shape: 120+ words, or a
        // heading line. Shorter, heading-free bodies are reported as deliverable-refused (informational).
        const looksLikeDocument = (body) => String(body ?? '').trim().split(/\s+/).filter(Boolean).length >= 120 || /^(?:#{1,3}\s+\S|[A-Z][A-Z .:]{8,}$)/m.test(String(body ?? ''));
        for (const d of t.displayed_deliverables ?? []) {
          if (!looksLikeDocument(d.body)) { findings['deliverable-refused'].push({ ...ref, kind: d.kind }); continue; }
          if (!savedShas.has(sha256(d.body))) findings['deliverable-unsaved'].push({ ...ref, kind: d.kind });
        }
      }
      if (t.kind === 'weekly-review') { const n = weeklyReviewActions(text); if (n !== bounds['weekly-actions'].bound) findings['weekly-actions'].push({ ...ref, actions: n }); }
      if (t.kind === 'debrief') { const n = debriefFocusPoints(text); if (n > bounds['debrief-focus'].bound) findings['debrief-focus'].push({ ...ref, points: n }); }
      if (t.kind === 'offer-review') { const p = pageCount(text); if (p > bounds['offer-review-pages'].bound) findings['offer-review-pages'].push({ ...ref, pages: Number(p.toFixed(2)) }); }
      if (t.kind === 'dossier') { const m = readingMinutes(text); if (m > bounds['dossier-minutes'].bound) findings['dossier-minutes'].push({ ...ref, minutes: Number(m.toFixed(2)) }); }
      priors.push(text);
      coachReplies.push(text);
    });
    if (ticsThisSession > bounds['session-tic'].bound) findings['session-tic'].push({ session: s.id ?? s.seed ?? s.module, module: s.module, tics: ticsThisSession });
    perSession.push({ session: s.id ?? s.seed ?? s.module, module: s.module, coachTurns: s.turns.filter((t) => t.role === 'coach').length, tics: ticsThisSession, voice: voiceMeasures(coachReplies) });
    allCoachReplies.push(...coachReplies);
  }
  const voice = voiceMeasures(allCoachReplies);
  const results = Object.entries(bounds).map(([id, b]) => {
    const f = findings[id] ?? [];
    // A null bound is informational: it is reported, never fails, and never enters failedBounds.
    if (b.bound === null || b.bound === undefined) return { id, promise: b.promise, unit: b.unit, bound: null, measure: 'info', observed: id in voice ? voice[id] : f.length, ok: true, evidence: f.slice(0, 50) };
    const ok = b.measure === 'max' || b.measure === 'exact' ? f.length === 0 : f.length <= b.bound;
    return { id, promise: b.promise, unit: b.unit, bound: b.bound, measure: b.measure ?? 'count<=bound', observed: f.length, ok, evidence: f.slice(0, 50) };
  });
  const infoRows = Object.entries(INFO_ROWS).filter(([id]) => !(id in bounds)).map(([id, b]) => ({ id, promise: b.promise, unit: b.unit, bound: null, measure: 'info', observed: id in voice ? voice[id] : findings[id].length, ok: true, evidence: (findings[id] ?? []).slice(0, 50) }));
  // Behaviour rows: appended like INFO rows. Guard-backed rows are 'absent' (observed null, ok) when the package has no guards.
  const behaviourRows = Object.entries(BEHAVIOUR_BOUNDS).filter(([id]) => !(id in bounds)).map(([id, b]) => {
    const f = findings[id] ?? [];
    const needsGuards = Boolean(b.guard) || id === 'conduct.pushback-held-read';
    if (needsGuards && !guards) return { id, promise: b.promise, unit: b.unit, bound: b.bound, measure: 'absent', observed: null, ok: true, evidence: [] };
    if (b.bound === null || b.bound === undefined) return { id, promise: b.promise, unit: b.unit, bound: null, measure: 'info', observed: f.length, ok: true, evidence: f.slice(0, 50) };
    return { id, promise: b.promise, unit: b.unit, bound: b.bound, measure: 'count<=bound', observed: f.length, ok: f.length <= b.bound, evidence: f.slice(0, 50) };
  });
  const rows = [...results, ...infoRows, ...behaviourRows];
  const baselineSpecifics = options.baselineSpecifics ?? null;
  return {
    schema: 'bill-coach.quality-census/v1', package: path.resolve(pkg), styleRules: style.STYLE_RULE_COUNT, conductGuards: guards ? 'present' : 'absent',
    sessions: perSession.length, coachReplies: perSession.reduce((a, s) => a + s.coachTurns, 0), perSession,
    voice, baselineSpecifics, regressionSignature: regressionSignature(voice, baselineSpecifics),
    bounds: rows, failedBounds: rows.filter((r) => r.bound !== null && !r.ok).map((r) => r.id), verdict: rows.every((r) => r.ok) ? 'PASS' : 'FAIL',
  };
}

export function loadCaptures(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.session.json')).sort().map((f) => ({ id: f.replace(/\.session\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [pkg, capDir, out] = process.argv.slice(2);
  if (!pkg || !capDir || !out) { console.error('usage: quality-census.mjs <package-dir> <capture-dir> <out.json> [--bounds <bounds.json>] [--baseline-specifics <number>]'); process.exit(2); }
  const bi = process.argv.indexOf('--bounds');
  const bounds = bi >= 0 ? JSON.parse(fs.readFileSync(process.argv[bi + 1], 'utf8')) : DEFAULT_BOUNDS;
  const si = process.argv.indexOf('--baseline-specifics');
  const baselineSpecifics = si >= 0 && process.argv[si + 1] !== undefined ? Number(process.argv[si + 1]) : null;
  const report = await census(pkg, loadCaptures(capDir), bounds, { baselineSpecifics });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const r of report.bounds) console.log(`  ${r.measure === 'absent' ? 'abs ' : r.bound === null ? 'info' : r.ok ? 'ok  ' : 'FAIL'} ${r.id}: ${r.observed} (${r.measure}${r.bound === null || r.measure === 'absent' ? '' : ` ${r.bound}`}): ${r.unit}`);
  const signature = report.regressionSignature ? ' REGRESSION-SIGNATURE' : '';
  console.log(report.verdict === 'PASS' ? `\nQUALITY CENSUS PASSED (${report.coachReplies} replies, ${report.sessions} sessions)${signature}` : `\nQUALITY CENSUS FAILED: ${report.failedBounds.length} bound(s): ${report.failedBounds.join(', ')}${signature}`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}
