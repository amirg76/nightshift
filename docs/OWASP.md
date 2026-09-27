# nightshift and the OWASP Top 10 for Agentic Applications (2026)

What each part of nightshift does about each risk — and, as plainly, what it does not. "Detects" means a human
gets an alert; "reduces" means the risk is smaller, not gone; "—" means out of scope.

The list is the OWASP GenAI Security Project's
[Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/).
nightshift is a harness for **one** agent (Claude Code) running unattended on **your** machine; most of its value
is in the risks where "nobody was watching" is the multiplier.

| # | Risk | nightshift | How |
|---|---|---|---|
| ASI01 | Agent Goal Hijack | **reduces · detects** | It cannot stop an agent from being steered by what it reads. It limits what a steered agent can do (guard), makes a hijack that rewrites the agent's own rules fail the run (post-run tamper check, `agent-commit` drill), and `expect` fails a run whose output shows the work was not done. |
| ASI02 | Tool Misuse & Exploitation | **reduces** | guard denies destructive commands, download→execute in any form it can see, payments, `git push` and push aliases, destructive git. Text-level: see SECURITY.md for what it cannot see. |
| ASI03 | Identity & Privilege Abuse | **reduces** | Secret files (keys, `.env*`, cloud and package-registry credentials) are denied to every tool in every mode. Unattended runs may not commit, because a commit is what the tamper gate treats as a human's approval. Money is always a human gate. |
| ASI04 | Agentic Supply Chain | **reduces** | Zero runtime dependencies. The files that define the agent — rules, prompts, hook config, harness config — are a protected set: changed without a commit, nothing runs. |
| ASI05 | Unexpected Code Execution | **reduces** | guard denies download→execute, `iex`, LOLBin downloaders and executors. It does not see code the agent writes to a file and runs through a language runtime; that is the sandbox's job. |
| ASI06 | Memory & Context Poisoning | **detects** | Persistent context (`CLAUDE.md`, prompts, anything you list as protected) cannot change unattended: edits are denied, shell writes are denied, and a change that slips past both fails the run at the post-run check. |
| ASI07 | Insecure Inter-Agent Communication | — | Single agent. |
| ASI08 | Cascading Failures | **reduces · detects** | Circuit breaker (a job that fails 3 times stops), project-wide lock, fail-closed on any missing precondition, network gate, and a harness that turns its own crashes into counted failures (INCIDENTS.md #4). |
| ASI09 | Human-Agent Trust Exploitation | **reduces** | What the human sees is written by the harness, not the agent: the status page is built only from harness lines, and agent output lives in a separate file it never reads — an agent cannot print its way to "all clear". |
| ASI10 | Rogue Agents | **detects** | The trust ledger measures which model actually passes its checks and bans on a rolling window; `expect` checks for evidence of work; the monthly fire drill proves that every alert path still fires. |

The fire drill injects the failure behind most rows above (`nightshift drill`, nine scenarios) and is the
part that keeps this table true over time.
