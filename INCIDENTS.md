# Incidents

Real failures from the private system this harness was extracted from: three Claude Code jobs a day,
scheduled on Windows Task Scheduler, running since 13 July 2026 (191 runs by 20 September). Each entry says
what happened, what caught it, what should have caught it, and what changed. Numbers come from the
system's own append-only logs, not from memory.

## 1. Routing ran inverted for 33 days (2026-08-18 → 2026-09-20)

**What happened.** The trust ledger picks the cheapest model that has proven itself for a class of task, and
bans a model after too many failures. The ban rule counted *lifetime* failures with no denominator and no
decay. One model was banned after 3 failures out of 6 runs — all three the same integrity error in a shared
data file, which would have failed any model that day. The other candidate was banned on its 3rd
lifetime failure; it went on to finish with 4 failures in **52 runs (92% pass rate)**, still banned. With every candidate banned, `route()`
escalated to the most expensive candidate on **28 consecutive runs**. The cost-saving mechanism was
running in reverse, and its own log said so every morning.

**What caught it.** A human, by accident, during an unrelated review 33 days later.

**What should have caught it.** The escalation was flagged — as a line in a run log nobody reads. A flag that
is written only to a log is not a flag.

**What changed.**
- Bans are decided on a rolling window (3 failures in the last 10 runs), never a lifetime counter.
- Rebuilding state replays the whole ledger under current rules, so fixing the rule re-judged history and
  released the wrongly banned model without losing its 52 runs.
- A ban never heals itself; only a human reset ends it (the `record` path accepts any model, so a backfill
  could otherwise roll the window and lift a ban silently).
- Two consecutive escalations raise a human alert; it clears itself when routing recovers.

**Found in review before release.** Promotion to `trusted` still used a lifetime failure count, so a model
demoted once could never earn trust back. Promotion now uses the same rolling window as the ban, and a
test covers the demote → recover cycle.

## 2. Autonomy silently off for two days (2026-07-25 → 26)

**What happened.** The tamper gate refuses to run when a protected file (rules, prompts, hook config)
differs from the last commit. A protected file was edited and not committed. Every scheduled job aborted
for two days. Each abort wrote one line to a log.

**What caught it.** The owner noticed nothing had run.

**What changed.** An abort raises an idempotent alert (one line, not one per run) and the alert clears
itself on the first clean run. The gate itself was right; its voice was wrong.

## 3. A stale alert nobody could trust (2026-08-20 → 2026-09-20)

**What happened.** A data-source health check raised "source dead" on 20 August. The source recovered; the
health check reported 15/15 sources OK on every day of September. The alert was never cleared and was
still present on 20 September — 31 days of a warning that was false.

**Why it matters.** An alert that stays after recovery teaches the human to ignore alerts. The next real one
is then invisible. This is how incident #1 stayed hidden: the owner had already stopped reading.

**What changed.** Every alert has a clear path, and the job that raised it is responsible for clearing it on
recovery. `alert.add` and `alert.clear` are both idempotent so the daily re-run neither floods nor forgets.

## 4. The harness failed silently on its own first deployment (2026-09-24 → 27)

**What happened.** nightshift's first real job was a daily browser scan, configured with an inline prompt
(`promptText`) instead of a prompt file. The run wrapper resolved the prompt-file path unconditionally;
with no file configured that path was undefined and Node threw — every day, one second after `START`,
before `claude` was ever launched. The exception skipped everything that makes a failure visible: no `END`
line, no failure marker, no count toward the circuit breaker, no alert. Task Scheduler recorded exit code
1, where nobody looks. Four scheduled runs, zero scans, all harness gates green.

**What caught it.** A pre-release checklist step: "confirm the real job actually ran through the harness".
The log had four `START` lines and no `END` line.

**What should have caught it.** The harness. It was built to turn silent failures into alerts, and it had a
blind spot exactly where it could not see itself: an exception inside its own run loop. The fire drill
tested every failure mode of the *job*, and none of the *harness*. 27 tests covered file-based prompts;
none covered `promptText`.

**What changed.**
- Only a file-based job resolves a path.
- Any exception between `START` and `END` is a failed run like any other (exit 70): logged with the
  message, a failure marker, counted by the breaker, alerted at the threshold. Every `START` now has an `END`.
- An exception that escapes to the CLI is written to the log and to `ALERTS.md` — the last line of
  defence under a scheduler, where stderr goes nowhere.
- The fire drill gained a `harness-crash` scenario: it injects a crash inside a run and checks all of the
  above. Tests pin the `promptText` path and the crash path.

**The lesson.** A watchdog must be tested on its own failures, not only on the failures it watches for.

## 5. A successful run that did nothing (found 2026-09-27, present since the first deployment)

**What happened.** With incident #4 fixed, the owner suggested triggering the real scheduled task on the
spot instead of waiting for the next morning. It finished in 32 seconds: `END exit=0`, no alert, gates
green. The agent's entire output was: *"I don't see a request in the message — only system information.
How can I help?"*

On Windows `claude` is a `.cmd` shim, so the harness launched it through a shell — and Node joins shell
arguments without escaping. The prompt, which contains spaces, arrived as fragments. Node even prints a
deprecation warning saying so. The same thing had already happened in the pre-release walkthrough four
days earlier ("tell me what to read and I'll continue"), and was ticked as a pass because the exit code
was 0.

**What caught it.** Reading the agent's output instead of the exit code.

**What changed.**
- The prompt is sent on stdin, never on the command line. What remains on the command line is flags and
  numbers; on Windows the harness builds one quoted command line itself (a space in the binary's path,
  like `C:\Program Files\…`, broke it too — found by the new test).
- `jobs.<job>.expect`: a pattern the run's own output must match. Exit 0 without it is a failure (exit 65):
  logged, marked, counted by the breaker. Only the current run's output counts.
- A test launches a stand-in `claude` through a real shim — `.cmd` with a space in its path on Windows,
  an executable script elsewhere — with a prompt full of quotes, `&`, `|`, `%`, `^`, a Windows path and
  Hebrew, and checks it arrives byte for byte.

**Verified.** The scheduled task, triggered the same way as every morning, ran for ten minutes and
collected 28 posts. **The lesson.** Exit 0 means the process did not crash. It does not mean the work was
done. Check the output for evidence of the work.

## Background: 28 job failures in seven weeks (2026-07-23 → 2026-09-06)

Twenty-eight scheduled runs failed across five jobs. They cluster on bad days (23–24 July, 24–25 August,
4–5 September hit three jobs each) rather than on one bad job: no job failed on three consecutive days, so
a breaker with a threshold of three would not have tripped on any of them. That is the point of the
threshold: it stops loops, not bad days.

## Lessons the code now encodes

1. **Fail closed.** No git, no config, no network → the run does not start. An exception is a stop, not a pass.
2. **Loud, not logged.** Anything a human must act on becomes a line in `ALERTS.md` (and, if configured, a push
   to a phone). Logs are for forensics.
3. **Alerts clear themselves.** Otherwise they train the human to ignore them.
4. **Measure with code, judge with models.** Where a check can be code, it is — 100% coverage at zero cost.
5. **Rules replay history.** State is derived from an append-only ledger; a rule fix re-judges the past.
6. **No human present = stricter rules.** The same hook denies more when the permission mode says nobody is
   watching.
