# nightshift

**Run Claude Code unattended. Know when it goes wrong.**

On 18 August 2026 a scheduled Claude Code system I run started sending every routine task to its most
expensive model. Its own safety mechanism had inverted. The log said so every morning. I found out on
20 September — 33 days later, by accident.

Nothing was broken in the usual sense. Every run exited 0. That is the failure mode of unattended agents:
they do not crash, they drift, and nobody is there to notice. `nightshift` is the harness I built around
that system, extracted after the incident with the parts that would have caught it. The full story, with
numbers, is in [INCIDENTS.md](INCIDENTS.md).

## What is in the box

Six small Node scripts, zero dependencies, one JSON config. Each one exists because of a specific failure.

| part | what it does | the failure it answers |
|---|---|---|
| **preflight** | Refuses to run if a protected file (rules, prompts, hook config) differs from the last commit. | Tampering — or you edited the rules and forgot. |
| **guard** (hook) | Deny-by-default `PreToolUse` hook: destructive commands, secret reads, download-and-run, payments, `git push`. Stricter when no human is present. | Prompt injection with nobody watching. |
| **circuit** | A job that fails 3 times in a row is stopped until a human resets it. | A broken job burning quota in a daily loop. |
| **trust** | A ledger of which model has *proven* it can do which class of task. Routes to the cheapest proven model; samples its output for review. Bans on a rolling window. | Cost routing that silently inverts (incident #1). |
| **alert** | Idempotent alerts in `ALERTS.md` that clear themselves on recovery. Optional push to your phone via ntfy. | Flags written only to logs (incidents #1, #2, #3). |
| **run** | The wrapper for a scheduled job: pause switch → preflight → network wait → circuit → lock → `claude -p` → retry → breaker. | Morning runs before DNS is up; overlapping runs; crash leftovers. |

## Quick start

```bash
git clone https://github.com/amirg76/nightshift
cd nightshift && npm test && npm link      # npm link puts a global "nightshift" command on your PATH
cd your-project
nightshift init                            # config + .gitignore + guard hook in .claude/settings.json
```

(No `npm link`? Every `nightshift …` below is `node /path/to/nightshift/bin/nightshift.mjs …`.)

`init` merges into an existing `.claude/settings.json` and never removes anything. Then edit
`nightshift.config.json`: list your protected files and your jobs. For phone alerts, the ntfy topic name is a
shared secret — put it in a file outside git (`"ntfyFile": "../.ntfy-topic"`) rather than inline.

```json
{
  "protected": ["CLAUDE.md", ".claude/", "prompts/", "nightshift.config.json"],
  "alerts": { "file": "ALERTS.md", "ntfy": "https://ntfy.sh/your-private-topic" },
  "jobs": {
    "daily-digest": { "prompt": "prompts/daily-digest.md", "model": "sonnet", "maxTurns": 40, "retry": true }
  }
}
```

Commit the three files `init` touched (the tamper gate compares protected files against the last commit;
with no commit it refuses to run and says so). Then schedule one command:

```bash
nightshift run daily-digest
```

- **cron / launchd:** `0 6 * * * cd /your/project && /path/to/nightshift/bin/nightshift.mjs run daily-digest`
- **Windows Task Scheduler:** action = `node`, arguments = `E:\path\nightshift\bin\nightshift.mjs run daily-digest`, start in = your project.

`init` wires the guard hook for you. If you prefer to do it by hand, this is what it adds to
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell|Read|Glob|Grep|Write|Edit|MultiEdit|NotebookEdit", "hooks": [
        { "type": "command", "command": "node /path/nightshift/hooks/guard.mjs", "timeout": 10 }
      ] }
    ]
  }
}
```

One screen tells you where you stand:

```
$ nightshift status
root:   /your/project
gate:   clean
jobs:   daily-digest 0/3
alerts: none
trust:  no banned models
```

## Day-to-day commands

```
nightshift init
nightshift status
nightshift run <job> [--retry]
nightshift preflight
nightshift circuit report | reset <job>
nightshift trust report | route <class> | record <class> <model> pass|fail [note] | reset <class> <model> [reason]
nightshift alert list | clear <key> [--id=x]
```

Kill switch: create the file `.nightshift/PAUSE`. Every job skips until you delete it.

One `claude` at a time per project: jobs share the same quota and often the same files, so the lock is
project-wide, not per job. A lock older than `lock.staleMinutes` (default 60) is treated as a crash
leftover and reclaimed.

## The fire drill

Incident #1 lived for 33 days because nothing ever tested the alert itself. So:

```bash
nightshift drill          # monthly; add --push to also test the phone
```

It builds a sandbox (its own git repo and state, under `.nightshift/drill/`), injects every failure mode —
tampered rules, three failing runs, every model banned, a corrupt state file, a broken config, an
unreachable API host — and checks that each alert is raised **and** clears again. Live state is never
touched. A drill that fails raises a real alert: *the alert path itself is broken*. `status` shows when the
alert path was last proven, and flags it overdue after 35 days.

- **cron:** `0 7 1 * * cd /your/project && /path/to/nightshift/bin/nightshift.mjs drill --push`

## The status page

After every run and every drill, nightshift rebuilds one self-contained HTML file: days running, runs,
failures, open alerts, gate state, last drill, model trust, and the last 25 harness events. Harness lines
only — the agent's output and prompt contents never appear. No scripts, no external assets, dark and light.

```json
"page": { "auto": true, "out": "docs/status.html", "publishCmd": "git -C docs add status.html && git -C docs commit -qm status && git -C docs push -q" }
```

`out` is where the file goes (default `.nightshift/status.html`); `publishCmd` is an optional command run
after each build — for example pushing a `docs/` folder that GitHub Pages serves. nightshift itself never
pushes anything; that command is yours.

## Design rules

1. **Fail closed.** No git, no config, no network, an exception → the run does not start.
2. **Loud, not logged.** Anything a human must act on is a line in `ALERTS.md`, optionally pushed to a phone. Logs are for forensics.
3. **Alerts clear themselves.** A stale alert trains you to ignore the next real one.
4. **No human present = stricter rules.** The guard reads the permission mode. Interactive sessions may edit the rules; unattended ones may not.
5. **Verify with code where you can.** Zero tokens, 100% coverage. Save model judgement for what needs it.
6. **State is a replayable ledger.** `trust.ndjson` is append-only; `trust.json` is derived. Fix a rule and history is re-judged.

## What it is not

- Not a cloud scheduler. It runs on your machine, next to your files. (Anthropic's cloud Routines run on a fresh clone and cannot see local state; the hook and the trust ledger still apply there.)
- Not a sandbox. The guard is a policy layer on top of Claude Code's own permissions, aimed at the unattended case. Use it with Claude Code's sandbox, not instead of it.
- Not a framework. Six files. Read them.

## Status

`v0.1` — extracted from a private system that has run three scheduled jobs a day since July 2026 (191 runs at
extraction). `npm test` runs 34 tests (seven of them pin holes a pre-release review found) on Linux with Node 20 and 22 on every push; the full Linux,
macOS and Windows matrix passed and runs on demand and on version tags. Roadmap, in order: a static status page, and a mapping of each part to the
OWASP Agentic Top 10.

MIT.
