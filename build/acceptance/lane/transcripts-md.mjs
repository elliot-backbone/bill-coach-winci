// Render every captured conversation to Markdown, one file per session plus an index, from
//   (a) lane directories produced by lane-runner/unit-runner (turns/<unit>/turn-NN.*), and
//   (b) estate full-capture output directories (modules/*.json), for older conversations.
// Each session file carries: the module/card, seed, lane/run ids, every Bill and Coach turn in order,
// the tools Coach called on that turn, cost and duration, and the state-table deltas the turn wrote.
//
// Usage: node transcripts-md.mjs --out <dir> [--lane <lane-dir>]... [--capture <full-capture-out-dir>]...

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const out = argv[argv.indexOf('--out') + 1];
if (!out) { console.error('usage: transcripts-md.mjs --out <dir> [--lane <dir>]... [--capture <dir>]...'); process.exit(2); }
const lanes = argv.map((a, i) => (a === '--lane' ? argv[i + 1] : null)).filter(Boolean);
const captures = argv.map((a, i) => (a === '--capture' ? argv[i + 1] : null)).filter(Boolean);
fs.mkdirSync(out, { recursive: true });
const index = [];
const esc = (s) => String(s ?? '').replace(/\r\n/g, '\n');

function renderLane(laneDir) {
  const prov = fs.existsSync(path.join(laneDir, 'provision.json')) ? JSON.parse(fs.readFileSync(path.join(laneDir, 'provision.json'), 'utf8')) : {};
  const manifest = fs.existsSync(path.join(laneDir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(laneDir, 'manifest.json'), 'utf8')) : {};
  const turnsRoot = path.join(laneDir, 'turns');
  if (!fs.existsSync(turnsRoot)) return;
  for (const unit of fs.readdirSync(turnsRoot).sort()) {
    const dir = path.join(turnsRoot, unit);
    const metas = fs.readdirSync(dir).filter((f) => /^turn-\d+\.meta\.json$/.test(f)).sort();
    if (!metas.length) continue;
    const lines = [`# ${unit}`, '', `Lane ${manifest.lane ?? '?'} of ${manifest.of ?? '?'} · run ${prov.runId ?? '?'} · image ${prov.image ?? '?'} ${prov.imageVersion ?? ''} · Claude Code ${prov.claude ?? '?'} · identity ${String(prov.identity ?? '').slice(0, 12)}…`, ''];
    let totalCost = 0; let totalMs = 0;
    for (const m of metas) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, m), 'utf8'));
      const tag = meta.tag;
      const prompt = fs.existsSync(path.join(dir, `${tag}.prompt.txt`)) ? fs.readFileSync(path.join(dir, `${tag}.prompt.txt`), 'utf8') : '';
      const reply = fs.existsSync(path.join(dir, `${tag}.reply.txt`)) ? fs.readFileSync(path.join(dir, `${tag}.reply.txt`), 'utf8') : '';
      const deltaFile = path.join(laneDir, 'state', unit, `${tag}.delta.json`);
      const delta = fs.existsSync(deltaFile) ? JSON.parse(fs.readFileSync(deltaFile, 'utf8')) : null;
      totalCost += meta.totalCostUsd ?? 0; totalMs += meta.durationMs ?? 0;
      if (meta.lane === 'bill') {
        lines.push(`## ${tag} · simulated Bill (persona turn, ${meta.durationMs ?? '?'} ms, $${(meta.totalCostUsd ?? 0).toFixed(4)})`, '', '> persona prompt omitted (see turn file); Bill said:', '', esc(reply) || '_(empty)_', '');
      } else {
        lines.push(`## ${tag} · BILL → COACH${meta.label ? ` (${meta.label})` : ''}`, '', '**Bill:**', '', esc(prompt), '', `**Coach** (${meta.durationMs ?? '?'} ms, $${(meta.totalCostUsd ?? 0).toFixed(4)}, exit ${meta.exit}${meta.stopReason ? `, ${meta.stopReason}` : ''}):`, '', esc(reply) || '_(no reply — see error.json)_', '');
        if (meta.toolCalls?.length) lines.push(`_Tools called:_ ${meta.toolCalls.map((t) => `\`${t.name}\``).join(', ')}`, '');
        if (delta) { const changed = Object.entries(delta).filter(([, v]) => v && v.after !== v.before).map(([t, v]) => `${t} ${v.before}→${v.after}`); if (changed.length) lines.push(`_State written:_ ${changed.join(', ')}`, ''); }
      }
    }
    if (fs.existsSync(path.join(dir, 'error.json'))) { const e = JSON.parse(fs.readFileSync(path.join(dir, 'error.json'), 'utf8')); lines.push(`> **Error ${e.class}:** ${e.message} — ${e.hint}`, ''); }
    const cardFile = path.join(laneDir, 'evidence', 'T-QUAL-004', `card-${unit.replace(/^card-/, '').replace(/-s(\d+)$/, '-s$1')}.json`);
    if (unit.startsWith('card-') && fs.existsSync(cardFile)) { const c = JSON.parse(fs.readFileSync(cardFile, 'utf8')); lines.push(`### Card ${c.card} · ${c.title} → **${c.verdict}**`, '', ...c.checks.map((k) => `- ${k.ok ? '✅' : '❌'} ${k.label}${k.matches !== undefined ? ` (matches ${k.matches})` : ''}${k.untraceable?.length ? ` (untraceable: ${k.untraceable.join(', ')})` : ''}`), c.wrongCase ? `- wrong case (${c.wrongCase.mode}): ${c.wrongCase.verdict ?? (c.wrongCase.differsFromMain ? 'exercised, outcome differs' : 'exercised')}` : '', ''); }
    lines.push(`---`, `Total: ${metas.length} turns · ${Math.round(totalMs / 1000)} s · $${totalCost.toFixed(4)}`, '');
    const file = path.join(out, `lane${manifest.lane ?? 'X'}--${unit}.md`);
    fs.writeFileSync(file, lines.join('\n'));
    index.push({ file: path.basename(file), source: 'lane', lane: manifest.lane, unit, turns: metas.length, cost: totalCost });
  }
}

function renderCapture(capDir) {
  const modDir = path.join(capDir, 'modules');
  if (!fs.existsSync(modDir)) return;
  const label = path.basename(capDir);
  for (const f of fs.readdirSync(modDir).filter((x) => x.endsWith('.json')).sort()) {
    const mod = JSON.parse(fs.readFileSync(path.join(modDir, f), 'utf8'));
    const lines = [`# ${mod.key} · ${mod.title ?? ''}`, '', `Source: estate capture \`${label}/modules/${f}\` (prior run; diagnostic lineage, not release proof)`, '', `_Brief:_ ${mod.brief ?? ''}`, ''];
    let n = 0;
    for (const t of mod.turns ?? []) {
      n += 1;
      if (t.who === 'Bill') lines.push(`## turn ${n} · BILL`, '', esc(t.text), '');
      else lines.push(`## turn ${n} · COACH${t.deliverable ? ' (deliverable)' : ''}${t.secs ? ` (${t.secs} s)` : ''}`, '', esc(t.text), '', ...(t.blocks?.length ? [`_Gate blocks on this turn:_ ${t.blocks.length}`, ''] : []));
    }
    if (mod.wrote && Object.keys(mod.wrote).length) lines.push(`---`, `_Rows written by this module:_ ${Object.entries(mod.wrote).map(([k, v]) => `${k} +${Array.isArray(v) ? v.length : v}`).join(', ')}`, '');
    const file = path.join(out, `estate--${label}--${f.replace(/\.json$/, '')}.md`);
    fs.writeFileSync(file, lines.join('\n'));
    index.push({ file: path.basename(file), source: `estate:${label}`, unit: mod.key, turns: (mod.turns ?? []).length });
  }
}

for (const l of lanes) renderLane(l);
for (const c of captures) renderCapture(c);
const idx = ['# Bill Coach — conversation transcripts', '', `Rendered ${new Date().toISOString()} · ${index.length} sessions`, '', '| file | source | unit | turns | cost |', '|---|---|---|---|---|', ...index.map((r) => `| [${r.file}](${r.file}) | ${r.source} | ${r.unit} | ${r.turns} | ${r.cost !== undefined ? `$${r.cost.toFixed(4)}` : '' } |`), '', 'Every file is the full conversation in order: what Bill (or the simulated Bill) said, what Coach replied, the tools Coach called, cost and timing, and the state tables the turn wrote. Card sessions end with the card verdict and its wrong case.', ''];
fs.writeFileSync(path.join(out, 'INDEX.md'), idx.join('\n'));
console.log(`${index.length} transcripts → ${out}`);
