# bill-coach-winci

Windows execution gate for the Coach installer and runtime. Private on purpose.

## Why this exists

Coach ships to a Windows machine but is built on a Mac. Everything that only exists
on Windows was going untested: `cmd.exe` running the launcher shim, PATHEXT
resolution finding `claude.cmd`, the USER PATH written to the registry and read back
by a fresh process, directory junctions created without elevation, and SQLite file
locking across a server restart.

Version 1.2.3 shipped with a defect that made every session after onboarding fail.
It was not a Windows defect — but nothing caught it, because no test ever completed
onboarding and opened an ordinary session. `build/session-test.mjs` now does exactly
that, and `build/windows-smoke-test.ps1` runs it on a real Windows runner.

## What runs

`.github/workflows/windows-smoke.yml` on `windows-latest`, on every push to `main`
and on demand. It installs Node 24 and Claude Code, then runs the smoke test:

- install → the sealed profile, junction, `coach.cmd` shim and registry PATH entry
- a fresh process resolving `coach` through PATHEXT
- `verify-install.mjs`
- a full model-free coaching session: reads, an FTS5 query, durable writes, a server
  restart, then **onboarding completed and the first ordinary session opened** — the
  sequence that broke in 1.2.3
- re-install → `already current` (idempotent)
- uninstall → memory and workspace preserved
- re-install over that → `repaired (...; memory preserved)`, launcher and junction back
- purge → nothing left behind

The runner is ephemeral, so the PATH and registry changes die with the VM.

## What is in test-package.zip

A scrubbed copy of the real package, built by `make-test-package.mjs` in the private
build tree. All code is byte-identical to what ships; `library.sqlite`, the state
template and every `plugin/coach/*` and `plugin/lenses/*` file are emptied, and
`docs/` is a placeholder. Table structure is preserved so the integrity checks,
schema gate and MCP probe all still run for real.

**Never commit the real package.** It contains a personal briefing, seeded memory and
a licensed dataset.

## Refreshing the package after a build

    node build/make-test-package.mjs <real-package-dir> /tmp/testpkg
    cd /tmp/testpkg && zip -r -X /path/to/this/repo/test-package.zip package
