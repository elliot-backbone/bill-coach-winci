#!/usr/bin/env node
// The parroting detector (Design V2 §3.3 control 1): flags replies that track a
// scaffold's key order or surface its field names / computed strings. This file
// carries BOTH the detector and its fixtures — a control with a wrong case that
// must fire and a right case that must not.
// Usage: node parrot-detector-test.mjs   (self-testing; also exports detect)

export function detectParroting(reply, scaffold) {
  const findings = [];
  const text = String(reply);
  // 1. Label leakage: scaffold structural names must never surface.
  const LABELS = ['judgment_points', 'wide_scan', 'params_echo', 'gate_rule_text',
    'rule_reasoning', 'computed', 'absences', 'scaffold', 'src:', 'st:', 'calc'];
  for (const l of LABELS) {
    if (text.includes(l)) findings.push({ kind: 'label-leak', label: l });
  }
  // 2. Verbatim lift: any scaffold string value >= 60 chars appearing verbatim.
  const strings = [];
  (function walk(o) {
    if (typeof o === 'string') { if (o.length >= 60) strings.push(o); }
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  })(scaffold);
  for (const s of strings) {
    if (text.includes(s.slice(0, 60))) findings.push({ kind: 'verbatim-lift', head: s.slice(0, 40) });
  }
  // 3. Order tracking: the reply's paragraph sequence following the scaffold's
  // top-level data key order. Correlate first-mention positions.
  const keys = Object.keys(scaffold.data ?? {});
  const positions = keys
    .map((k) => ({ k, at: text.toLowerCase().indexOf(k.replace(/_/g, ' ')) }))
    .filter((p) => p.at >= 0);
  if (positions.length >= 3) {
    let inOrder = 0;
    for (let i = 1; i < positions.length; i += 1) if (positions[i].at > positions[i - 1].at) inOrder += 1;
    if (inOrder === positions.length - 1) findings.push({ kind: 'order-tracking', keys: positions.map((p) => p.k) });
  }
  return { parroting: findings.length > 0, findings };
}

// ---------------------------------------------------------------- fixtures
import { fileURLToPath } from 'node:url';
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  let fails = 0;
  const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}`); if (!c) fails += 1; };
  const scaffold = {
    data: {
      funnel_state: { rows: 3 },
      nudge_candidates: [{ company: 'Kestrel', days: 6 }],
      stall_candidates: [{ company: 'Brightloom', days: 12, note: 'no touch since the LinkedIn post went up and the founder widened the search publicly' }],
    },
    computed: { week_counts: { value: { moved: 2 } } },
    judgment_points: [{ id: 'stalls', question: 'which are stalled' }],
  };
  const parroted = 'Funnel state: three rows. Nudge candidates: Kestrel at six days. Stall candidates: Brightloom — no touch since the LinkedIn post went up and the founder widened the search publicly. Per the judgment_points, which are stalled is your call.';
  const recomposed = 'Brightloom worries me more than the quiet ones do — twelve days of silence right after Mira advertised the seat is a timing signal, and I would call her before doing anything else this week. Kestrel just needs the nudge we drafted. Everything else moved.';
  const r1 = detectParroting(parroted, scaffold);
  ok(r1.parroting && r1.findings.some((f) => f.kind === 'label-leak'), 'parroted fixture flags (label leak)');
  ok(r1.findings.some((f) => f.kind === 'verbatim-lift'), 'parroted fixture flags (verbatim lift)');
  ok(r1.findings.some((f) => f.kind === 'order-tracking'), 'parroted fixture flags (order tracking)');
  const r2 = detectParroting(recomposed, scaffold);
  ok(!r2.parroting, `recomposed fixture passes clean (${JSON.stringify(r2.findings)})`);
  console.log(fails === 0 ? 'PARROT DETECTOR TESTS PASSED' : `PARROT DETECTOR TESTS FAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
