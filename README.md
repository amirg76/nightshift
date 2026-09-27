# nightshift

[![test](https://github.com/amirg76/nightshift/actions/workflows/test.yml/badge.svg)](https://github.com/amirg76/nightshift/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

**Run Claude Code unattended. Know when it goes wrong.**

On 18 August 2026 a scheduled Claude Code system I run started sending every routine task to its most
expensive model. Its own cost-saving mechanism had inverted. The log said so every morning. I found out on
20 September — 33 days later, by accident.

Nothing crashed. Every run exited 0. That is how unattended agents fail: they do not break, they drift, and
nobody is there to notice. nightshift is the harness I built around that system, extracted with the parts
that would have caught it — and then hardened by its own first deployment, which failed silently twice
before it worked. All five incidents, with numbers, are in [INCIDENTS.md](INCIDENTS.md).

## What is in the box

One Node package, zero dependencies, one JSON config. Every part exists because of a specific failure.

| part | what it does | the failure it answers |
|---|---|---|
| **preflight** | Refuses to run if a protected file (rules, prompts, hook config) is modified, staged, deleted or new since the last commit. | Tampering — or you edited the rules and forgot (#2). |
| **guard** (hook) | `PreToolUse` hook: denies destructive commands, secret files, download→execute, payments, `git push`. With nobody present it also denies writing protected files by any tool, and commits. | A steered agent with nobody watching. |
| **run** | Wraps a scheduled job: pause switch → config check → preflight → network wait → breaker → lock → `claude -p` → `expect` → post-run tamper check. | Silent crashes (#4), empty successes (#5), an agent that commits its own rule change. |
| **circuit** | A job that fails 3 times in a row stops until a human resets it. | A broken job burning quota in a daily loop. |
| **trust** | A ledger of which model has *proven* it can do which class of task. Routes to the cheapest proven model, samples its output, bans on a rolling window. | Cost routing that silently inverts (#1). |
| **alert** | Idempotent alerts in `ALERTS.md` that clear themselves on recovery; optional push to your phone via [ntfy](https://ntfy.sh). | Flags written only to logs (#1, #2), alerts that outlive their cause (#3). |
| **drill** | Monthly fire drill: injects nine failure modes into a sandbox and proves each alert fires *and* clears. | Nothing ever tested the alert path itself (#1). |
| **page** | A self-contained status page, rebuilt after every run; optionally published to GitHub Pages. | "I have no easy way to see what it's doing." |

## Quick start

Requires Node 20+, git, and the [Claude Code](https://code.claude.com/docs) CLI.

```bash
git clone https://github.com/amirg76/nightshift
cd nightshift && npm test && npm link      # npm link puts a "nightshift" command on your PATH
cd your-project && nightshift init         # config + .gitignore + guard hook in .claude/settings.json
```

No `npm link`? Every `nightshift …` below is `node /path/to/nightshift/bin/nightshift.mjs …`.
`init` merges into an existing `.claude/settings.json` and never removes anything.

Edit `nightshift.config.json` — what is protected, and your jobs:

```json
{
  "protected": ["CLAUDE.md", ".claude/", "prompts/", "nightshift.config.json"],
  "alerts": { "file": "ALERTS.md", "ntfyFile": "../.ntfy-topic" },
  "jobs": {
    "daily-digest": {
      "prompt": "prompts/daily-digest.md", "model": "sonnet", "maxTurns": 40, "retry": true,
      "expect": "digest written|nothing new"
    }
  }
}
```

A job takes a prompt file (`prompt`) or inline text (`promptText`); optionally a working directory for
`claude` (`cwd` — protected files and the tamper checks always refer to the project root, not to `cwd`), `timeoutMinutes`, and — strongly recommended — **`expect`**, a pattern the run's output must
contain. Exit 0 only means `claude` did not crash; `expect` is how the harness knows the work was done (#5).
The ntfy topic name is a shared secret: keep it in a file outside git, as above.

Commit what `init` touched — the tamper gate compares protected files against the last commit — then
schedule one command:

```bash
nightshift run daily-digest
```

- **cron / launchd:** `0 6 * * * cd /your/project && /path/to/nightshift/bin/nightshift.mjs run daily-digest`
- **Windows Task Scheduler:** program `node`, arguments `C:\path\nightshift\bin\nightshift.mjs run daily-digest`, start in your project.

Then check it once, the way it will really run — trigger the scheduled task now instead of waiting for
tomorrow, and read `.nightshift/agent.log`. That is how incident #5 was found.

## Where you stand

```
$ nightshift status
gate:   clean
jobs:   all circuits closed
alerts: none
trust:  no banned models
drill:  PASS 3 day(s) ago
```

| file | holds |
|---|---|
| `ALERTS.md` | what a human must act on — nothing else |
| `.nightshift/log.txt` | harness lines only; the status page is built from it |
| `.nightshift/agent.log` | everything `claude` printed |
| `.nightshift/failures.txt`, `security-log.txt` | failed runs; every guard denial |

| exit | meaning |
|---|---|
| 0 | ok, or skipped on purpose (paused, breaker open) |
| 1 | stopped before launch (config, tamper gate, network, lock), or `claude` itself exited 1 |
| 65 | `claude` exited 0 but the output did not match `expect` |
| 66 | protected files were changed or committed during the run |
| 70 | the harness itself failed mid-run |
| 127 | `claude` could not be started |

```
nightshift init [dir] · status · run <job> [--retry] · preflight · drill [--push] · page
nightshift circuit report | reset <job>
nightshift trust report | route <class> | record <class> <model> pass|fail [note] | reset <class> <model> [reason]
nightshift alert list | clear <key> [--id=x]
```

Kill switch: create `.nightshift/PAUSE`; every job skips until you delete it. One `claude` at a time per
project — jobs share quota and often files — and a lock older than `lock.staleMinutes` (60) is reclaimed.

## The fire drill

```bash
nightshift drill          # monthly; --push also sends a [DRILL] message to your phone
```

It builds a sandbox (its own git repo and state under `.nightshift/drill/`, never your live state) and injects:
tampered rules · a new file in a protected directory · an agent that rewrites its rules **and commits them** ·
three failing runs · every model banned · the harness crashing mid-run · a corrupt state file · a broken
config · an unreachable API host. Each must raise its alert and clear it again. A failed drill is itself an
alert — *the alert path is broken, do not trust silence* — and `status` flags a drill older than 35 days.

`0 7 1 * * cd /your/project && /path/to/nightshift/bin/nightshift.mjs drill --push`

## The status page

After every run and drill nightshift rebuilds one HTML file — days running, runs, failures, open alerts, gate,
last drill, model trust, recent harness events. No scripts, no external assets, light and dark. It is built
from harness lines only: agent output never appears, so an agent cannot print its way to "all clear".

```json
"page": { "publish": { "repo": "https://github.com/you/your-repo.git", "branch": "gh-pages" } }
```

With `publish`, the page is pushed to a branch that GitHub Pages serves — a live, public record that the
system runs. A published page redacts absolute paths; a failed publish is an alert like any other. This is the
one thing nightshift pushes, only when you configure it, and only to that branch.

## Security

Two kinds of control, not equally strong. The **structural** ones — tamper gate, post-run tamper check,
separate agent log, fail-closed preconditions, a validated command line — do not depend on reading command
text. The **guard** is a text matcher: it stops a careless or lightly-steered agent, not one actively evading it
through shell expansion, encodings or a language runtime. Use nightshift *with* Claude Code's sandbox, not
instead of it. Details and the pre-release review: [SECURITY.md](SECURITY.md). Mapping to the OWASP Agentic
Top 10: [docs/OWASP.md](docs/OWASP.md).

## Design rules

1. **Fail closed.** No git, no commits, bad config, corrupt state, no network, an exception → nothing runs, and you are told.
2. **Loud, not logged.** Anything a human must act on is a line in `ALERTS.md`, optionally on your phone. Logs are for forensics.
3. **Alerts clear themselves.** A stale alert trains you to ignore the next real one.
4. **Exit 0 is not success.** Require evidence of the work (`expect`).
5. **No human present, stricter rules.** The guard reads the permission mode; interactive sessions may edit the rules, unattended ones may not.
6. **Test the watchdog on its own failures.** The drill injects harness failures, not only job failures.
7. **State is a replayable ledger.** `trust.ndjson` is append-only; fix a rule and history is re-judged.

## Status

`0.2.0` — running a real daily job under Windows Task Scheduler since September 2026, extracted from a system
that has run three scheduled Claude Code jobs a day since July. `npm test` runs 57 tests on Linux, macOS and
Windows with Node 20, 22 and the newest LTS — on every push and every Monday, so a change in the platform
shows up here first. What changed and why:
[CHANGELOG.md](CHANGELOG.md).

Not a cloud scheduler (it runs next to your files), not a sandbox, not a framework — fourteen small files. Read them.

MIT.
