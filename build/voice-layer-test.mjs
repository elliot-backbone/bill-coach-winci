#!/usr/bin/env node
// Bill voice reachability and cadence-gate regression.
// Usage: node voice-layer-test.mjs <package-dir>

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = path.resolve(process.argv[2]);
let failures = 0;
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`);
  if (!condition) {
    failures += 1;
    if (detail) console.log(`       ${String(detail).slice(0, 500)}`);
  }
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-voice-'));
fs.mkdirSync(path.join(temp, 'state'), { recursive: true });
fs.mkdirSync(path.join(temp, 'library'), { recursive: true });
fs.copyFileSync(path.join(pkg, 'state-template', 'coach.sqlite'), path.join(temp, 'state', 'coach.sqlite'));
fs.copyFileSync(path.join(pkg, 'library', 'library.sqlite'), path.join(temp, 'library', 'library.sqlite'));

console.log(`package:  ${pkg}`);
console.log(`platform: ${process.platform} / node ${process.versions.node}\n`);

async function openServer() {
  const child = spawn(process.execPath, [path.join(pkg, 'plugin', 'runtime', 'server.mjs')], {
    env: { ...process.env, BILL_COACH_DATA_DIR: temp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  let id = 1;
  const pending = new Map();
  child.stderr.on('data', (data) => { stderr += String(data); });
  child.stdout.on('data', (data) => {
    buffer += String(data);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const item = pending.get(message.id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(message.id);
          item.resolve(message);
        }
      } catch { /* protocol test reports timeouts with stderr */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const callId = id++;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`MCP timeout for ${method}: ${stderr}`));
    }, 10_000);
    pending.set(callId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: callId, method, params })}\n`);
  });
  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'voice-test', version: '1' },
  });
  return {
    child,
    async tool(name, args) {
      const response = await rpc('tools/call', { name, arguments: args });
      const raw = response?.result?.content?.[0]?.text ?? '';
      try { return JSON.parse(raw); } catch { return { parse_error: raw, response }; }
    },
    close() {
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already closed */ }
    },
  };
}

const gate = await import(pathToFileURL(path.join(pkg, 'plugin', 'runtime', 'gate.mjs')).href);
const style = await import(pathToFileURL(path.join(pkg, 'plugin', 'runtime', 'style.mjs')).href);
const authorityPath = path.join(pkg, 'plugin', 'authorities', 'bill-voice-covenant.v1.json');
const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
const systemPrompt = fs.readFileSync(path.join(pkg, 'plugin', 'coach', 'system-prompt.md'), 'utf8');

// ---------------------------------------------------------------- canonical text and all delivery paths
console.log('== one hashed covenant reaches Coach before startup and throughout the session ==');
check(authority.version === gate.VOICE_CONTRACT_VERSION, 'runtime version derives from the authority');
check(authority.sha256 === gate.VOICE_CONTRACT_SHA256, 'runtime hash derives from the authority');
check(authority.text === gate.VOICE_CONTRACT, 'runtime text derives from the authority');
check(gate.assertVoiceContractSurface(systemPrompt), 'protected system prompt is an exact rendered surface');
let driftRefused = false;
try { gate.assertVoiceContractSurface(systemPrompt.replace('affable', 'agreeable'), 'tampered fixture'); } catch { driftRefused = true; }
check(driftRefused, 'a drifted pre-token surface fails closed');

const targetWords = ['best interests at heart, always', 'human', 'affable', 'pleasing', 'easygoing',
  'engaging', 'passionate', 'literate', 'probing', 'challenging', 'honest', 'unemotional',
  'accretive', 'incremental', 'occasionally intimidating'];
for (const word of targetWords) {
  check(authority.text.toLowerCase().includes(word), `covenant names ${word}`);
}
check(/warm in relationship|warmth is the baseline/i.test(authority.text), 'warm relationship survives hard judgment');
check(/never pressure, menace, contempt or cross-examination/i.test(authority.text), 'intimidation is bounded by care');
check(/preserve every claim, hard truth and needed question/i.test(authority.text), 'style cannot replace substance');

const launcher = fs.readFileSync(path.join(pkg, 'launcher', 'coach.mjs'), 'utf8');
const serverSource = fs.readFileSync(path.join(pkg, 'plugin', 'runtime', 'server.mjs'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(pkg, 'plugin', 'runtime', 'lifecycle.mjs'), 'utf8');
check(/--append-system-prompt-file/.test(launcher), 'launcher appends the protected prompt before the first token');
check(/assertVoiceContractSurface/.test(launcher), 'launcher validates covenant parity before spawn');
check(/assertVoiceContractSurface/.test(serverSource), 'server independently validates covenant parity');
check(/approvedGateReplies/.test(serverSource) && /MAX_GATE_PRIORS = 20/.test(serverSource),
  'ongoing approved-reply cache has an explicit bound');
const onboardingPaneBlock = lifecycleSource.match(/const ONBOARDING_PANES = \[([\s\S]*?)\n\];\nconst PANE_COUNT/);
check((onboardingPaneBlock?.[1].match(/\n\s*walkthrough:/g) ?? []).length === 7,
  'runtime onboarding has seven interactive panes');
check(/onboarding status "pane_\$\{PANE_COUNT\}"/.test(lifecycleSource) && !/onboarding status "pane_9"/.test(lifecycleSource),
  'final interactive checkpoint derives pane_7 from runtime PANE_COUNT');

const mcp = await openServer();
let orientation = {};
try {
  orientation = await mcp.tool('start_coach', { user_message: 'hello', now: new Date().toISOString() });
  check(JSON.stringify(orientation.voice_contract) === JSON.stringify({
    version: authority.version, sha256: authority.sha256, text: authority.text,
  }), 'start_coach returns the exact versioned covenant');
  // 1.13.2: the static doctrine (conduct, panel review, principal, commands,
  // doctrine binding) moved to the system prompt's STATIC DOCTRINE block —
  // ~13.8 KB off every start_coach result. The result carries a binding pointer,
  // and the rendered block must carry the substance verbatim (parity with the
  // lifecycle exports is asserted by static-doctrine-parity-test.mjs).
  check(typeof orientation.static_doctrine === 'string' && /system prompt/.test(orientation.static_doctrine),
    'start_coach points to the system-prompt static doctrine');
  check(orientation.conduct === undefined && orientation.panel_review === undefined,
    'start_coach no longer re-ships the static doctrine blocks');
  const sysPrompt = fs.readFileSync(path.join(pkg, 'plugin', 'coach', 'system-prompt.md'), 'utf8');
  check(/CONDUCT — these are requirements to REASON WITH/.test(sysPrompt),
    'system prompt carries the substantive conduct layer');
  check(/LEVEL ONE/.test(sysPrompt) && /LEVEL THREE/.test(sysPrompt) && /veto/.test(sysPrompt),
    'system prompt carries the three-level review with its veto');

  const a1 = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'Call Maya today. Ask whether Thursday still works.',
  });
  check(a1.decision === 'emit', 'a clean reply emits');
  // 1.13.2: a clean emit returns the draft's sha256 instead of echoing text and
  // covenant back (the covenant is guaranteed pre-token by the launcher's
  // assertVoiceContractSurface). Holds still carry the covenant for the rewrite.
  check(a1.text === undefined && typeof a1.text_sha256 === 'string' && a1.text_sha256.length === 64,
    'a clean emit returns a sha256 binding instead of an echo');
  const heldProbe = await mcp.tool('review_draft', {
    session_id: orientation.session_id, draft: 'This is not just a weak story, but a false one.',
  });
  check(heldProbe.decision === 'hold'
      && JSON.stringify(heldProbe.voice_contract) === JSON.stringify(orientation.voice_contract),
    'a held result still returns the same covenant');
  check(a1.voice_diversity.response.session_word_counts.length === 1,
    'first approved reply starts one session-local history');

  const b1 = await mcp.tool('review_draft', {
    session_id: 'voice-isolation-b',
    draft: 'Write the plain answer first. Keep the supporting detail behind it.',
  });
  check(b1.voice_diversity.response.session_word_counts.length === 1,
    'a second session cannot inherit the first session history');

  await mcp.tool('review_draft', {
    session_id: 'voice-prior-order',
    draft: 'Keep the evidence beside the claim.',
  });
  const ordered = await mcp.tool('review_draft', {
    session_id: 'voice-prior-order',
    priors: ['Older approved context belongs before this cached reply.'],
    draft: 'Ask what changed in the room.',
  });
  check(ordered.voice_diversity.response.session_word_counts.length === 3
      && ordered.voice_diversity.response.session_word_counts[0] === 8,
  'caller-supplied older priors precede the automatic recent cache');

  const a2 = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'The founder\'s silence is data. What changed after Tuesday?',
  });
  check(a2.voice_diversity.response.session_word_counts.length === 2,
    'approved prior text reaches the next review automatically');

  const held = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'I\'ll check.',
  });
  check(held.decision === 'hold', 'a narrating draft is held');
  const afterHeld = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'Name the number you would accept before the next call.',
  });
  check(afterHeld.voice_diversity.response.session_word_counts.length === 3,
    'held text is never appended to approved history');

  await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'Call Maya today. Ask whether Thursday still works.',
  });
  const afterDuplicate = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'Use the figure from Tuesday and leave the deck at home.',
  });
  check(afterDuplicate.voice_diversity.response.session_word_counts.length === 4,
    'an exact returned reply is deduplicated in the cache');

  const absent1 = await mcp.tool('review_draft', { draft: 'Ask once. Then listen.' });
  const absent2 = await mcp.tool('review_draft', { draft: 'Say the number plainly.' });
  check(absent1.voice_diversity.response.session_word_counts.length === 1
      && absent2.voice_diversity.response.session_word_counts.length === 1,
  'missing session_id fails conservative: no implicit history is shared');

  let bounded;
  for (let i = 0; i < 24; i += 1) {
    bounded = await mcp.tool('review_draft', {
      session_id: 'voice-bound-session',
      draft: `Ask Maya about item ${i + 1}. Keep the answer plain and wait.`,
    });
  }
  check(bounded.voice_diversity.response.session_word_counts.length <= 21,
    'twenty cached priors plus the current reply is the hard history bound');

  const ended = await mcp.tool('end_coach', {
    session_id: orientation.session_id,
    expected_session_version: orientation.session_version,
    judgment: 'Voice cache lifecycle fixture complete.',
    next_move: 'Close the isolated fixture.',
    commitments: [],
  });
  check(!ended.error, 'fixture session closes successfully', ended.error);
  const afterEnd = await mcp.tool('review_draft', {
    session_id: orientation.session_id,
    draft: 'Keep the next answer short.',
  });
  check(afterEnd.voice_diversity.response.session_word_counts.length === 1,
    'successful end_coach clears only that session cache');
} finally {
  mcp.close();
}

// lifecycle.mjs only answers a hook when import.meta.url matches argv[1]
// exactly; a non-canonical path (/tmp symlink on macOS, RUNNER~1 8.3 short
// names on Windows runners) makes it exit silently. Canonicalize first.
const hook = spawnSync(process.execPath, [path.join(fs.realpathSync(pkg), 'plugin', 'runtime', 'lifecycle.mjs'), 'hook-post-compact'], {
  env: { ...process.env, BILL_COACH_DATA_DIR: temp }, input: '{}\n', encoding: 'utf8', timeout: 10_000,
});
let postCompact = {};
try { postCompact = JSON.parse(hook.stdout || '{}'); } catch { /* checked below */ }
check(/call start_coach now/i.test(postCompact?.hookSpecificOutput?.additionalContext ?? ''),
  'post-compaction recovery unconditionally reloads start_coach and its covenant');

// ---------------------------------------------------------------- independent within/across diversity axes
console.log('\n== within-reply and across-session cadence are independently load-bearing ==');
const uniformSentence = 'You take the meeting, and you ask the founder one clear question before you make the next call.';
const uniformReply = Array.from({ length: 12 }, () => uniformSentence).join(' ');
const uniform = style.measureVoiceDiversity(uniformReply);
check(uniform.within_reply.verdict === 'hold', 'same-shape sentences hold on the within-reply axis');
check(uniform.across_session.verdict === 'pass', 'within-only failure does not fabricate session history');
check(uniform.sentence.word_counts.length === 12 && uniform.clause.word_counts.length >= 24,
  'raw sentence and finite-clause distributions are retained');
check(uniform.scaffolding.comma_and_clause_construction_count === 12,
  'comma-and finite-clause construction is measured');

const outlierReply = `${Array.from({ length: 10 }, () => uniformSentence).join(' ')} `
  + 'Although one unusually long sentence now carries an extended qualification about timing, evidence, relationships, the founder, the board and the number Bill can honestly defend in the room, the other ten sentences keep exactly the same shape.';
check(style.measureVoiceDiversity(outlierReply).within_reply.verdict === 'hold',
  'one long outlier cannot launder ten uniform sentences');

const forced = Array.from({ length: 8 }, (_, index) => index % 2
  ? 'Because the evidence from Tuesday remains incomplete, you should ask the founder what changed in the room, write down the exact answer, compare it with the number already on file, and decide only when you can name the risk you are accepting.'
  : 'Ask now.').join(' ');
check(style.measureVoiceDiversity(forced).verdict !== 'pass',
  'mechanical short/long alternation is not rewarded as healthy variety');

const stanza = Array.from({ length: 3 }, (_, index) => [
  `Yours: the claim for round ${index + 1} is clear enough to test.`,
  `Mine: the evidence under round ${index + 1} still needs one dated result.`,
  `On file: the founder asked for a number in round ${index + 1}.`,
  `The challenge: answer that question without rebuilding the whole story for round ${index + 1}.`,
].join('\n')).join('\n');
check(style.measureVoiceDiversity(stanza).within_reply.verdict === 'hold',
  'repeated Yours/Mine/On file/The challenge stanza holds even when lengths vary');

const sessionParagraphs = [
  'Two things deserve a straight answer. The founder conversation showed that your commercial claim interests them, although the proof underneath it is still too loose for the next room.',
  'The useful move is to call Maya before lunch. Ask which result changed her view, listen all the way through the answer, and write down the exact phrase she uses when she describes the risk. That gives us evidence instead of theatre.',
  'Rather than polishing the old paragraph, bring the Tuesday number forward. It is awkward because the sample is small; it is still the only claim that survived a real question from the board.',
  'There is a case against moving now. You could expose the gap before the relationship is ready, and the cleaner line may sound narrower than the story you prefer. That cost is worth paying when the alternative asks them to believe more than you know.',
  'What would make you change your mind? Name it before the call, then judge the answer against that standard instead of negotiating with yourself afterwards. Write the answer down while the language is still yours.',
];
const sessionReplies = ['Maya', 'Jon', 'Sara'].map((name) => sessionParagraphs.join('\n\n').replaceAll('Maya', name));
const firstShape = style.measureVoiceDiversity(sessionReplies[0]);
const thirdShape = style.measureVoiceDiversity(sessionReplies[2], { priors: sessionReplies.slice(0, 2) });
check(firstShape.within_reply.verdict !== 'hold', 'session fixture is not failed by its individual construction');
check(thirdShape.across_session.verdict === 'hold', 'three substantial templated replies hold on session shape alone');
check(thirdShape.within_reply.verdict !== 'hold', 'session-axis hold does not depend on an intra-reply failure');

const longTail = 'Behind that call sits one practical decision. The board wants a claim it can repeat without qualification, while you need a role whose scope is real on day one. Bring the dated revenue result, the founder’s exact question and the boundary you will hold. Leave the broad promise outside the room. If the evidence changes, change the judgment quickly; if it does not, keep the line steady and let the other side decide whether it can meet you there.';
const longSessionReplies = sessionReplies.map((reply) => `${reply}\n\n${longTail}`);
const cvGamedPriors = Array.from({ length: 9 }, (_, index) => longSessionReplies[index % 3]);
cvGamedPriors.splice(4, 0, 'Send it.');
const cvGamed = style.measureVoiceDiversity(longSessionReplies[0], { priors: cvGamedPriors });
check(cvGamed.across_session.verdict === 'hold'
      && cvGamed.session_signals.some((signal) => signal.id === 'response_depth_saturation'),
  'one tiny reply cannot game the rolling long-response saturation');

const shortReplies = ['Send it.', 'Ask Maya once, then wait.', 'The number is too low. Decline it.',
  'Use Tuesday’s figure.', 'Keep the meeting. Drop the deck.', 'Yes. That claim has evidence.'];
check(style.measureVoiceDiversity(shortReplies.at(-1), { priors: shortReplies.slice(0, -1) }).across_session.verdict !== 'hold',
  'six genuinely short direct answers do not trip the session hold');

const hardTruth = `Call Maya today and tell her the number does not work for you. Keep it warm; this is a negotiation with someone you respect, not a performance of toughness.

She may dislike hearing it. That discomfort is real, but a comforting fiction would leave you carrying a role whose scope and price never matched. You owe both of you the cleaner answer.

What changed after Tuesday's call, and which fact would make you revise the judgment? If nothing changed, send the line before lunch. Then stop explaining and let her respond.`;
check(style.measureVoiceDiversity(hardTruth).within_reply.verdict !== 'hold',
  'warm hard-truth fixture is not flattened by the cadence gate');
check(/number does not work|comforting fiction/.test(hardTruth) && /Keep it warm/.test(hardTruth),
  'affability accompanies rather than overrides the hard truth');

const exemplarText = fs.readFileSync(path.join(pkg, 'plugin', 'coach', 'onboarding-exemplars.md'), 'utf8');
const panes = exemplarText.split(/(?=^## EXEMPLAR: PANE \d+)/m).slice(1);
const exemplarHolds = panes.filter((pane) => style.measureVoiceDiversity(pane).verdict === 'hold');
const scrubbedExemplars = /^# onboarding-exemplars\.md \(scrubbed\)$/m.test(exemplarText);
if (scrubbedExemplars) {
  check(panes.length === 0 && /Placeholder content for CI/.test(exemplarText),
    'public scrub intentionally omits private exemplars without weakening covenant tests');
} else {
  check(panes.length === 8 && exemplarHolds.length === 0,
    'seven approved onboarding panes plus the Finish showcase calibrate below hold', `${exemplarHolds.length} held`);
}

const heldAgain = gate.emissionGate(uniformReply, { attempt: 2 });
check(heldAgain.decision === 'hold' && !heldAgain.text,
  'attempt 2 cannot silently emit unresolved multi-scale uniformity');
const persistentBlock = gate.emissionGate('This is not just a weak story, but a false one.', { attempt: 2 });
check(persistentBlock.decision === 'hold', 'attempt 2 never waives any remaining blocking construction');
const cleanDraft = 'Call Maya today. Ask whether Thursday still works.';
const cleanGate = gate.emissionGate(cleanDraft);
// 1.13.2: the byte-for-byte guarantee is now carried as a sha256 of the submitted
// draft — the caller prints its own submission, so the bytes cannot drift.
const cleanSha = createHash('sha256').update(cleanDraft).digest('hex');
check(cleanGate.decision === 'emit' && cleanGate.text === undefined && cleanGate.text_sha256 === cleanSha,
  'an approved gate result binds the submitted text byte-for-byte via sha256');

// ---------------------------------------------------------------- identity and packaging hygiene
console.log('\n== Bill-only source and scrubbed-package hygiene ==');
const runtimeSources = fs.readdirSync(path.join(pkg, 'plugin', 'runtime'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => fs.readFileSync(path.join(pkg, 'plugin', 'runtime', name), 'utf8')).join('\n');
const aiAuthority = fs.readFileSync(path.join(pkg, 'plugin', 'authorities', 'ai-writing-signs-register.v1.json'), 'utf8');
check(!/DAN['’]S/.test(`${runtimeSources}\n${aiAuthority}`), 'no uppercase cross-product DAN’S label remains');
check(!/"dan_own_writing"/.test(aiAuthority), 'external Dan corpus reference-point object is removed');
check(!/reference_points_only/.test(aiAuthority), 'external reference-point corpus block is removed');
check(fs.readFileSync(path.join(pkg, 'plugin', 'runtime', 'gate.mjs'), 'utf8').includes('bill-voice-covenant.v1.json'),
  'runtime reads the non-personal authority, not scrubbed coach prose');
const buildDir = path.dirname(fileURLToPath(import.meta.url));
const scrubber = fs.readFileSync(path.join(buildDir, 'make-test-package.mjs'), 'utf8');
check(/name === 'system-prompt\.md'/.test(scrubber), 'privacy scrub preserves the protected non-personal prompt');
check(/bill-voice-covenant\.v1\.json/.test(fs.readFileSync(path.join(buildDir, 'verify-package.mjs'), 'utf8')),
  'package verification requires the canonical authority');

console.log('\n== existing tool reachability safeguards remain ==');
check(!/'--strict-mcp-config'/.test(launcher), 'launcher does not suppress the working user-scope MCP path');
check(!/'--mcp-config'/.test(launcher), 'launcher does not race the opening prompt with async MCP config');
check(/registrationPresent/.test(launcher), 'launcher refuses an unregistered Coach runtime');
check(/serverAnswers|initialize/.test(launcher), 'launcher handshakes before handing over to Claude Code');

fs.rmSync(temp, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'VOICE LAYER TESTS PASSED' : `VOICE LAYER TESTS FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
