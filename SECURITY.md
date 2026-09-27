# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the **Security** tab → *Report a vulnerability*). Do not
open a public issue for a bypass. You will get an answer within a week.

## What nightshift protects, and where it stops

nightshift has two kinds of controls, and they are not equally strong.

**Structural — they do not depend on reading command text:**

- **Tamper gate** (`preflight`): a protected file that is modified, staged, deleted or *new and untracked*
  stops every run until a human commits it.
- **Post-run tamper check** (`run`): after the agent finishes, protected files that are dirty — or that were
  **committed during the run** — fail the run (exit 66), raise a `tamper` alert, and are never retried. This
  closes the gap where an agent rewrites its own rules and commits the change so the tamper gate sees a
  clean tree.
- **Separate logs**: harness lines go to `log.txt`, agent output to `agent.log`. The status page is built
  only from `log.txt`, so an agent cannot forge "ALERT CLEARED" on it.
- **Fail closed**: missing git, no commits, an unreadable config, a corrupt state file, an unreachable API
  host, or an exception inside the harness — each stops the run and is visible.
- **Fail closed on unreadable history**: if git HEAD cannot be read before or after a run, the run fails —
  a commit to the rules cannot be ruled out.
- **Validated command line**: every value that reaches `claude`'s command line is checked against a strict
  shape first; the prompt itself goes on stdin.

**Textual — `hooks/guard.mjs`:** a `PreToolUse` hook that matches the command or path the agent submits. It
stops a careless or lightly-steered agent. It does **not** stop an agent that is actively evading it, and it
cannot:

- see through shell expansion (`F=-rf; rm $F`), encodings (`echo … | base64 -d | sh`), quote splitting
  (`cat .e''nv`), or aliases defined outside the command it is shown;
- see what a language runtime does (`node -e`, `python -c`, a script the agent wrote a moment earlier);
- judge general data flow — sending an arbitrary file to an arbitrary host is not recognisable from text.

The boundaries that hold against an adversarial agent are below nightshift: Claude Code's sandbox, network
allow-lists, file-system permissions, and credentials the agent never had. Use nightshift **with** them.

## Pre-release review (v0.2.0)

Before this repository went public, an independent code review and security review ran against the whole
tree, reproducing each finding by running it. Everything they found is fixed and pinned by a test in
`test/security-review.test.mjs`, `test/review-fixes.test.mjs`, `test/incident4.test.mjs` and
`test/incident5.test.mjs`. The list is in [CHANGELOG.md](CHANGELOG.md).
