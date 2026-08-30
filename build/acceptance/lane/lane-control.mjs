// Controller (runs on the operator's Mac): dispatch lanes, find their tmate lines, relay sign-in,
// watch, collect. Every action is appended to control/<run>.jsonl as it happens.
//
//   node lane-control.mjs dispatch --plan <dir> --adapters-ref <sha> [--cap 220] [--minutes 45]
//   node lane-control.mjs ssh-lines --plan <dir>            → prints each lane's run id + ssh line when available
//   node lane-control.mjs signin --run <id>                 → opens the login flow on the lane over tmate, prints the URL
//   node lane-control.mjs code --run <id> --code <one-time> → injects the operator's code (never logged)
//   node lane-control.mjs watch --plan <dir>                → status of every lane
//   node lane-control.mjs collect --plan <dir> --out <dir>  → downloads every lane artifact, verifies manifests
//   node lane-control.mjs kill --run <id>                   → deletes keep-open on the lane (or cancels the run)

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'elliot-backbone/bill-coach-package';
const WORKFLOW = 'windows-live-capture.yml';
const REF = 'acceptance/2.1.2-candidate';
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
const gh = (args, input) => { const r = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${r.stderr || r.stdout}`); return r.stdout; };
const plan = opt('--plan');
const state = plan ? path.join(plan, 'control.json') : null;
const load = () => (state && fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : { lanes: {} });
const save = (s) => fs.writeFileSync(state, `${JSON.stringify(s, null, 2)}\n`);
const log = (ev) => plan && fs.appendFileSync(path.join(plan, 'control.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ...ev })}\n`);

if (cmd === 'dispatch') {
  const s = load();
  const manifests = fs.readdirSync(plan).filter((f) => /^lane-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const f of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(plan, f), 'utf8'));
    const before = new Set(gh(['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--limit', '20', '--json', 'databaseId', '-q', '.[].databaseId']).split('\n').filter(Boolean));
    gh(['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', REF, '-f', `lane_manifest=${JSON.stringify(m)}`, '-f', `adapters_ref=${opt('--adapters-ref')}`, '-f', `cap_turns=${opt('--cap', String(m.cap))}`, '-f', `minutes=${opt('--minutes', '45')}`]);
    let runId = null;
    for (let i = 0; i < 12 && !runId; i += 1) { spawnSync('sleep', ['5']); const now = gh(['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--limit', '20', '--json', 'databaseId', '-q', '.[].databaseId']).split('\n').filter(Boolean); runId = now.find((id) => !before.has(id)) ?? null; }
    s.lanes[m.lane] = { runId, manifest: f, dispatchedAt: new Date().toISOString(), estTurns: m.estTurns };
    log({ event: 'dispatched', lane: m.lane, runId }); save(s);
    console.log(`lane ${m.lane}: run ${runId ?? '?'} (${m.units.length} units, est ${m.estTurns} turns)`);
  }
} else if (cmd === 'ssh-lines') {
  const s = load();
  for (const [lane, l] of Object.entries(s.lanes)) {
    if (!l.runId) { console.log(`lane ${lane}: no run id`); continue; }
    try {
      const jobs = JSON.parse(gh(['run', 'view', l.runId, '--repo', REPO, '--json', 'status,conclusion,jobs']));
      const step = jobs.jobs?.[0]?.steps?.find((x) => /Publish the connection string/.test(x.name));
      if (step?.conclusion === 'success') {
        const tmp = fs.mkdtempSync(path.join(plan, 'ssh-'));
        try { gh(['run', 'download', l.runId, '--repo', REPO, '--name', `lane-ssh-${l.runId}-1`, '--dir', tmp]); const line = fs.readFileSync(path.join(tmp, 'tmate-ssh.txt'), 'utf8').trim(); l.ssh = line; console.log(`lane ${lane}: ${line}`); } catch (e) { console.log(`lane ${lane}: ssh artifact not yet available (${e.message.split('\n')[0]})`); }
        fs.rmSync(tmp, { recursive: true, force: true });
      } else console.log(`lane ${lane}: ${jobs.status} (${jobs.jobs?.[0]?.steps?.filter((x) => x.status === 'completed').length ?? 0} steps done)`);
    } catch (e) { console.log(`lane ${lane}: ${e.message.split('\n')[0]}`); }
  }
  save(s);
} else if (cmd === 'watch') {
  const s = load();
  for (const [lane, l] of Object.entries(s.lanes)) {
    if (!l.runId) continue;
    const j = JSON.parse(gh(['run', 'view', l.runId, '--repo', REPO, '--json', 'status,conclusion,jobs']));
    const steps = j.jobs?.[0]?.steps ?? [];
    const current = steps.find((x) => x.status === 'in_progress')?.name ?? steps.filter((x) => x.status === 'completed').at(-1)?.name;
    console.log(`lane ${lane} run ${l.runId}: ${j.status}${j.conclusion ? '/' + j.conclusion : ''} — ${current ?? ''}`);
  }
} else if (cmd === 'collect') {
  const s = load(); const out = opt('--out'); fs.mkdirSync(out, { recursive: true });
  for (const [lane, l] of Object.entries(s.lanes)) {
    if (!l.runId) continue;
    const dir = path.join(out, `lane-${lane}`); fs.mkdirSync(dir, { recursive: true });
    try { gh(['run', 'download', l.runId, '--repo', REPO, '--name', `lane-${l.runId}-1`, '--dir', dir]); } catch (e) { console.log(`lane ${lane}: ${e.message.split('\n')[0]}`); continue; }
    const manifest = path.join(dir, 'capture-manifest.sha256');
    let verified = 0; let bad = 0;
    if (fs.existsSync(manifest)) for (const line of fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter(Boolean)) { const [h, rel] = line.split('  '); if (rel === 'capture-manifest.sha256') continue; const f = path.join(dir, rel); if (fs.existsSync(f) && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === h) verified += 1; else bad += 1; }
    l.collected = { dir, verified, bad, at: new Date().toISOString() }; log({ event: 'collected', lane, verified, bad });
    console.log(`lane ${lane}: ${verified} files verified, ${bad} mismatched`);
  }
  save(s);
} else if (cmd === 'kill') {
  gh(['run', 'cancel', opt('--run'), '--repo', REPO]); console.log('cancelled');
} else {
  console.log('usage: lane-control.mjs dispatch|ssh-lines|watch|collect|kill …  (signin/code are done interactively over the tmate line with tmate-drive.py)');
}
