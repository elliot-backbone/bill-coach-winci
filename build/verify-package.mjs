#!/usr/bin/env node
// Bill Jennings Coach — package verification gate. Run against the assembled package
// BEFORE manifest generation and zipping. Hard-fails on any miss.
// Usage: node build/verify-package.mjs <package-dir>

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PKG = process.argv[2] ? path.resolve(process.argv[2]) : '/tmp/bill-build/package';
let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label) => { console.log(`  FAIL ${label}`); failures += 1; };
const check = (cond, label) => (cond ? ok(label) : bad(label));

console.log(`verifying ${PKG}`);

// ---- 1. file inventory ------------------------------------------------------
const REQUIRED = [
  'INSTALL.md', 'install/install.mjs', 'install/uninstall.mjs', 'install/upgrade.mjs',
  'install/verify-install.mjs',
  'launcher/coach.mjs', 'launcher/sealed-settings.template.json', 'launcher/sealed-mcp.template.json',
  'library/library.sqlite', 'state-template/coach.sqlite', 'state-template/package.json',
  // plugin/.mcp.json removed in 1.5.3: the plugin declaring its own server was the
  // registration path that does not attach on Windows. User scope is now the only one.
  'plugin/.claude-plugin/plugin.json', 'plugin/hooks/hooks.json',
  'plugin/skills/coach/SKILL.md',
  'plugin/runtime/server.mjs', 'plugin/runtime/lifecycle.mjs', 'plugin/runtime/memory.mjs',
  'plugin/runtime/funnel.mjs', 'plugin/runtime/statesearch.mjs', 'plugin/runtime/onboarding.mjs',
  'plugin/runtime/library.mjs', 'plugin/runtime/context.mjs', 'plugin/runtime/sources.mjs',
  'plugin/coach/identity.md', 'plugin/coach/principal.md', 'plugin/coach/principal-profile.json',
  'plugin/coach/method.md', 'plugin/coach/funnel-doctrine.md', 'plugin/coach/sourcing.md',
  'plugin/coach/narrative.md', 'plugin/coach/deliverables.md', 'plugin/coach/voice.md',
  'plugin/coach/writing-voice.md', 'plugin/coach/onboarding.md', 'plugin/coach/onboarding-exemplars.md',
  'plugin/coach/system-prompt.md',
  'plugin/lenses/company-read.md', 'plugin/lenses/founder-read.md', 'plugin/lenses/market.md',
  'plugin/lenses/negotiation.md', 'plugin/lenses/content.md',
];
for (const f of REQUIRED) check(existsSync(path.join(PKG, f)), `file ${f}`);

// ---- 2. identity hygiene ----------------------------------------------------
const CODE_AND_CONTENT = REQUIRED.filter((f) => f.endsWith('.mjs') || f.endsWith('.md') || f.endsWith('.json'));
let mitchellHits = [];
let careerCoachHits = [];
for (const f of CODE_AND_CONTENT) {
  const p = path.join(PKG, f);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, 'utf8');
  if (/mitchell|lava\b/i.test(s)) mitchellHits.push(f);
  if (/career coach/i.test(s) && !f.startsWith('install') && f !== 'plugin/.claude-plugin/plugin.json') {
    // "career coach" tolerated only in internal identity strings (package name), never prose
    const prose = s.replace(/bill-career-coach[a-z-]*/g, '').replace(/[Nn]ever \\?["“']?career coach\\?["”']?/g, '');
    if (/career coach/i.test(prose)) careerCoachHits.push(f);
  }
}
// The non-negotiables reach the model only if the launcher actually passes them, and only
// before the first token. MEASURED 2026-08-22: without this the skill was never invoked in a
// whole live run and the first-output rule never reached the model at all.
{
  const launcher = readFileSync(path.join(PKG, 'launcher/coach.mjs'), 'utf8');
  check(/--append-system-prompt-file/.test(launcher), 'launcher passes the system prompt file');
  check(/system-prompt\.md/.test(launcher), 'launcher points at coach/system-prompt.md');
  const sp = readFileSync(path.join(PKG, 'plugin/coach/system-prompt.md'), 'utf8');
  check(/FIRST OUTPUT/i.test(sp), 'system prompt carries the first-output rule');
  check(/REVIEW BEFORE YOU SEND/i.test(sp), 'system prompt carries the review requirement');
  check(/NEVER FLATTER/i.test(sp), 'system prompt carries the anti-sycophancy rule');
  // 4000 was the budget when this prompt carried three rules. It now carries six, and the
  // three added on 2026-08-22/23 were each earned by a measured failure: an artefact produced
  // and never saved, a module that inherited Bill's opening frame instead of running its
  // method, and a reply handing him a menu instead of a recommendation. Raised deliberately
  // rather than dropping a load-bearing rule to fit a number. It still has to stay SHORT:
  // this arrives before the first token of every turn, and a prompt nobody finishes is a
  // prompt nobody follows.
  // 1.13.2: the STATIC DOCTRINE block (13.8 KB, formerly re-shipped in every
  // start_coach result) now lives here deliberately; budget raised to cover it.
  check(sp.length < 21000, `system prompt stays within budget (${sp.length} chars, budget 21000)`);
  check(sp.includes('STATIC DOCTRINE BEGIN'), 'system prompt carries the rendered STATIC DOCTRINE block');
}

check(mitchellHits.length === 0, `no Mitchell/Lava references (${mitchellHits.join(', ') || 'clean'})`);
check(careerCoachHits.length === 0, `no "career coach" in Bill-facing prose (${careerCoachHits.join(', ') || 'clean'})`);

// ---- 3. state template ------------------------------------------------------
try {
  const st = new DatabaseSync(path.join(PKG, 'state-template', 'coach.sqlite'), { readOnly: true });
  const tables = st.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
  for (const t of ['roles', 'role_events', 'interactions', 'offers', 'contacts', 'learnings', 'voice_deltas', 'investor_roster', 'sourcing_runs', 'onboarding', 'memories', 'metrics', 'commitments', 'sessions']) {
    check(tables.includes(t), `state table ${t}`);
  }
  check(st.prepare('SELECT COUNT(*) AS n FROM investor_roster').get().n === 31, 'roster = 31 investors');
  const census = st.prepare(`SELECT COUNT(*) AS n FROM roles WHERE phase = 'P0' AND source = 'market-data-baseline'`).get().n;
  check(census >= 40, `day-one census seeded (${census} P0 roles)`);
  const ob = st.prepare('SELECT status FROM onboarding WHERE singleton = 1').get();
  check(ob?.status === 'not_started', 'onboarding not_started');
  const paneCheck = st.prepare(`SELECT sql FROM sqlite_master WHERE name = 'onboarding'`).get().sql;
  check(paneCheck.includes("'pane_7'") && !paneCheck.includes("'pane_8'"), 'onboarding CHECK = 7 panes');
  const seeds = st.prepare(`SELECT COUNT(*) AS n FROM memories WHERE id LIKE 'bj-%'`).get().n;
  check(seeds >= 50, `bj-* person atoms seeded (${seeds})`);
  const sens = st.prepare(`SELECT COUNT(*) AS n FROM memories WHERE sensitive = 1`).get().n;
  check(sens >= 4 && sens <= 10, `sensitive register sized sanely (${sens})`);
  st.close();
} catch (err) { bad(`state template: ${err.message}`); }

// ---- 4. library -------------------------------------------------------------
try {
  const lib = new DatabaseSync(path.join(PKG, 'library', 'library.sqlite'), { readOnly: true });
  check(lib.prepare('SELECT COUNT(*) AS n FROM market_deals').get().n === 1504, 'market_deals = 1504');
  check(lib.prepare('SELECT COUNT(*) AS n FROM doctrine').get().n === 1480, 'doctrine units = 1480');
  const billDocs = lib.prepare(`SELECT COUNT(*) AS n FROM documents WHERE id LIKE 'bill-doctrine:%'`).get().n;
  check(billDocs === 12, `bill career corpus docs = 12 (${billDocs})`);
  const leak = lib.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE lower(text) LIKE '%astroforge%' OR lower(text) LIKE '%lendtable%'`).get().n;
  check(leak === 0, 'library leak check clean');
  const fts = lib.prepare(`SELECT COUNT(*) AS n FROM market_deals_fts WHERE market_deals_fts MATCH '"Intropy"'`).get().n;
  check(fts >= 1, 'market FTS answers');
  lib.close();
} catch (err) { bad(`library: ${err.message}`); }

// ---- 5. runtime syntax + tool surface --------------------------------------
try {
  const server = readFileSync(path.join(PKG, 'plugin/runtime/server.mjs'), 'utf8');
  for (const t of ['start_coach', 'get_context', 'search_library', 'save_coaching_state', 'inspect_memory', 'sync_source', 'end_coach', 'search_state', 'update_state', 'bill_command']) {
    check(server.includes(`name: '${t}'`), `tool registered: ${t}`);
  }
  const lifecycle = readFileSync(path.join(PKG, 'plugin/runtime/lifecycle.mjs'), 'utf8');
  check(lifecycle.includes('BILL_CONTRACT'), 'BILL_CONTRACT present');
  check(lifecycle.includes('unclosed-work') || lifecycle.includes('UNCLOSED-WORK'), 'unclosed-work guard present');
  check(lifecycle.includes('Kazanjy'), 'citation guard tokens rebuilt');
  const launcher = readFileSync(path.join(PKG, 'launcher/coach.mjs'), 'utf8');
  check(launcher.includes("'WebSearch,WebFetch'") || launcher.includes('WebSearch'), 'web tool posture in launcher');
  const installer = readFileSync(path.join(PKG, 'install/install.mjs'), 'utf8');
  check(installer.includes("LAUNCHER_NAME = 'coach'"), "launcher command = coach");
  check(installer.includes('assertNoCoachCollision'), 'PATH collision guard');
} catch (err) { bad(`runtime: ${err.message}`); }

// ---- 6. cross-platform install layer ---------------------------------------
// These are the Windows assumptions that cannot be exercised from macOS, so we
// assert their presence statically instead. Each check maps to one real failure
// mode on Windows.
try {
  const inst = readFileSync(path.join(PKG, 'install/install.mjs'), 'utf8');
  const launcher = readFileSync(path.join(PKG, 'launcher/coach.mjs'), 'utf8');
  const upgrade = readFileSync(path.join(PKG, 'install/upgrade.mjs'), 'utf8');
  const installMd = readFileSync(path.join(PKG, 'INSTALL.md'), 'utf8');

  check(/IS_WINDOWS\s*=\s*process\.platform === 'win32'/.test(inst), 'platform flag defined');
  check(inst.includes('PATHEXT'), 'install: PATHEXT-aware command resolution');
  check(launcher.includes('PATHEXT'), 'launcher: PATHEXT-aware claude resolution');
  // A directory symlink needs elevation on Windows; a junction does not.
  check(inst.includes("'junction'"), 'install: junction used for skills entry');
  check(!/fs\.symlinkSync\(/.test(inst.replace(/fs\.symlinkSync\(target, linkPath[^\n]*\n/, '')),
    'install: no raw symlinkSync outside the platform helper');
  // Node refuses to exec .cmd without a shell (CVE-2024-27980).
  check(/shell:\s*true/.test(inst) && /shell:\s*true/.test(launcher), 'shell:true for .cmd binaries');
  // ...and with shell:true, argv must be quoted or "start coach" splits in two.
  // Quoting must happen in our code, and the args array must NOT be passed
  // alongside shell:true — Node 24 deprecates that combination (DEP0190).
  check(launcher.includes('shellCommandFor'), 'launcher: argv quoted into one shell command string');
  check(inst.includes('shellCommandFor') && inst.includes('spawnSyncCompat'), 'install: DEP0190-safe shell invocation');
  check(!/shell:\s*true[^)]*\},\s*\[/.test(launcher), 'launcher: no args array alongside shell:true');
  // Node 22.13 has no FTS5; every entry point must check the capability, not just the version.
  for (const [name, src] of [['install', inst], ['launcher', launcher]]) {
    check(/USING fts5/.test(src), `${name}: probes for SQLite FTS5 support`);
  }
  check(inst.includes("MIN_NODE = '24.0.0'"), 'install: minimum Node is 24 (FTS5 floor)');
  // On Windows the launcher must land in our own per-user dir, never in a
  // writable system directory that happens to precede claude on PATH.
  check(/if \(IS_WINDOWS\)[\s\S]{0,400}?fallback/.test(inst), 'install: Windows launcher dir is the dedicated per-user dir');
  check(inst.includes('@echo off') && inst.includes('%~dp0'), 'install: relocatable .cmd shim');
  check(inst.includes('SetEnvironmentVariable'), 'install: PATH via Environment API, not setx');
  check(!inst.includes('setx '), 'install: setx avoided (truncates PATH at 1024 chars)');
  check(/chmodIfPosix/.test(inst) && /chmodIfPosix/.test(upgrade), 'chmod guarded on both install paths');
  check(!/fs\.chmodSync/.test(upgrade), 'upgrade: no raw chmodSync');
  check(installMd.includes('Expand-Archive') && installMd.includes('powershell.exe'), 'INSTALL.md: Windows steps present');
  check(installMd.includes('NEW PowerShell window'), 'INSTALL.md: warns PATH needs a fresh window');
} catch (err) { bad(`cross-platform layer: ${err.message}`); }

// ---- 7. Windows-facing vocabulary -------------------------------------------
// Bill is on Windows. "Terminal" only exists by default on Windows 11, and
// "your terminal" is Unix vernacular he will not recognise; PowerShell is the
// one console named the same on Windows 10 and 11. Guard the wording so a
// future doc rebuild cannot quietly reintroduce Mac/Unix phrasing.
try {
  const guideName = 'docs/Coach--Product-Guide--';
  const docs = readdirSync(path.join(PKG, 'docs'));
  const guideMd = docs.find((f) => f.startsWith('Coach--Product-Guide--') && f.endsWith('.md'));
  check(Boolean(guideMd), `product guide present (${guideName}*.md)`);
  if (guideMd) {
    const g = readFileSync(path.join(PKG, 'docs', guideMd), 'utf8');
    const macWords = /\bmacOS\b|\byour Mac\b|every Mac\b|Cmd ?\+|Spotlight|\bFinder\b|in the Dock|Keep in Dock/i;
    check(!macWords.test(g), `guide free of Mac vocabulary${macWords.test(g) ? ` (${(g.match(macWords) || [])[0]})` : ''}`);
    check(g.includes('PowerShell'), 'guide names PowerShell');
    // One mention of Terminal is allowed: the Windows 11 aside.
    const terminalHits = (g.match(/\bterminal\b/gi) || []).length;
    check(terminalHits <= 1, `guide avoids Unix "terminal" vernacular (${terminalHits} mention(s), 1 allowed)`);
    check(/Windows 11/.test(g), 'guide covers the Windows 11 Terminal alias');
    check(/Ctrl \+ V/.test(g) && !/Cmd \+ V/.test(g), 'guide uses Ctrl+V for paste');
  }
} catch (err) { bad(`windows vocabulary: ${err.message}`); }

// ---- 8. Bill's control commands ---------------------------------------------
// "forget" queried memories.name/value_text, which do not exist on that table,
// so every forget failed. "correct" assumed a correction shape the schema does
// not require and threw on target.split(). Both are user-facing promises.
try {
  const srv = readFileSync(path.join(PKG, 'plugin/runtime/server.mjs'), 'utf8');
  // Strip comments first: the fix documents the old column names, and the
  // regression check must not trip over its own explanation.
  const code = srv.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const forgetBlock = (code.match(/command === 'forget'[\s\S]{0,700}/) || [''])[0];
  check(/lower\(subject\) LIKE/.test(forgetBlock) && /lower\(content\) LIKE/.test(forgetBlock),
    'forget queries the columns that exist (subject/content)');
  check(!/lower\(name\)|value_text/.test(forgetBlock), 'forget does not reference name/value_text');
  const correctBlock = (code.match(/command === 'correct'[\s\S]{0,900}/) || [''])[0];
  check(/typeof target !== 'string'/.test(correctBlock), 'correct validates its correction shape before use');
} catch (err) { bad(`control commands: ${err.message}`); }

// ---- 9. sealed permissions --------------------------------------------------
// Coach IS its MCP server. If the server is not pre-approved, Bill is prompted
// to grant permission for every coach tool on first launch — for a non-technical
// user that reads as the product being broken. Plugin-provided servers use the
// mcp__plugin_<plugin>_<server> prefix.
try {
  const sealed = JSON.parse(readFileSync(path.join(PKG, 'launcher/sealed-settings.template.json'), 'utf8'));
  const allow = sealed.permissions?.allow ?? [];
  check(allow.includes('mcp__plugin_bill-career-coach_bill-coach'), 'coach MCP server pre-approved (plugin form)');
  check(allow.includes('mcp__bill-coach'), 'coach MCP server pre-approved (direct mcp-config form)');
  check((sealed.permissions?.deny ?? []).includes('Bash'), 'Bash still denied');
} catch (err) { bad(`sealed permissions: ${err.message}`); }

// ---- 10. removed pipeline seeds ---------------------------------------------
// Flowstate was a seeded pipeline example that Coach pitched to Bill as a live
// opportunity. Removed at Elliot's instruction in 1.2.3. Check the databases at
// byte level, not just row level: a DELETE without VACUUM leaves the text in
// free pages, where it is still recoverable from the shipped file.
try {
  const REMOVED = ['flowstate'];
  for (const term of REMOVED) {
    for (const rel of ['state-template/coach.sqlite', 'state-template/coach.sqlite-shm', 'library/library.sqlite']) {
      const f = path.join(PKG, rel);
      if (!existsSync(f)) continue;
      const buf = readFileSync(f);
      const found = buf.includes(Buffer.from(term, 'utf8')) || buf.includes(Buffer.from(term, 'utf16le'));
      check(!found, `"${term}" absent from ${rel} (byte level)`);
    }
    const profile = readFileSync(path.join(PKG, 'plugin/coach/principal-profile.json'), 'utf8');
    check(!new RegExp(term, 'i').test(profile), `"${term}" absent from principal-profile.json`);
  }
} catch (err) { bad(`removed seeds: ${err.message}`); }

console.log(failures === 0 ? 'VERIFY PASSED' : `VERIFY FAILED: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
