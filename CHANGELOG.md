# Changelog

## 0.2.0 — 2026-09-27 · first public release

Deployed on a real daily job for the first time, then reviewed end to end before going public. Two incidents
and two reviews shaped this release.

### Fixed — incidents on the first deployment (INCIDENTS.md)
- **#4** An inline-prompt job crashed one second after start, every day for four days, and the crash skipped
  all bookkeeping. Any exception inside a run is now a counted, alerted failure (exit 70); the fire drill
  injects one.
- **#5** On Windows the prompt reached `claude` in fragments; it answered "I don't see a request" and exited 0.
  The prompt now goes on stdin, and `expect` requires evidence of the work in the output (exit 65).

### Security — pre-release review (SECURITY.md)
- An unattended agent could rewrite its own rules through the shell and commit them, so the tamper gate saw a
  clean tree. The run now checks protected files after the agent finishes — dirty or committed — and fails
  with a `tamper` alert (exit 66, never retried). The guard also denies shell writes to protected files and
  git history changes when no human is present (`allowAgentCommits` to opt out per project).
- Agent output shared a file with harness lines, so an agent could forge lines on the status page. Agent
  output now goes to `agent.log`, which the page never reads.
- The tamper gate missed a new, untracked file in a protected directory (`git diff` ignores untracked files).
  It now uses `git status`.
- Download→execute was only caught with a literal pipe. Unattended, a download plus any execution in the same
  command is now denied (`;`, newlines, `chmod +x`, `./file`); with a human present only the piped form is, so
  `curl …/health && node build.mjs` keeps working.
  Push through a git alias, `git -C … push`, `find -delete`, `rm -fr`, and secret files read through the shell
  (`.npmrc`, `.netrc`, `credentials`, …) are denied. One secret list serves every tool.
- The guard failed open on an unreadable config; it now falls back to the default protected list and logs it.
- `expect` patterns run in a child process with a 3-second limit over the last 256 KB, so a
  catastrophic-backtracking pattern cannot hang a run inside the lock.
- Job config that reaches the command line (model, turns, timeout, permission mode) is validated first; on
  Windows even a quoted `%VAR%` expands.
- An `ntfyFile` is sent only if it holds a topic name or an https topic URL — never arbitrary file content.

### Added
- `page.publish`: push the status page to a GitHub Pages branch after every run and drill; a published page
  redacts absolute paths; a failed publish is an alert. (Replaces the shell hook `publishCmd`.)
- Fire drill: `new-file` and `agent-commit` scenarios — nine in total.
- `docs/OWASP.md`: what each part does about each OWASP Agentic Top 10 risk, and what it does not.
- CI runs Linux on every push and the full Linux/macOS/Windows matrix on demand and on tags.

## 0.1.0 — 2026-09-20

Extracted from a private system that had run three scheduled Claude Code jobs a day since July 2026:
tamper gate, guard hook, circuit breaker, trust ledger, alerts with ntfy push, run wrapper, `init`, fire drill,
status page.
