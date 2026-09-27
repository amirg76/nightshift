// run.mjs — wraps one unattended Claude Code job. In order:
//   PAUSE switch → config check → preflight (tamper gate) → network wait → circuit breaker → lock
//   → claude -p (prompt on stdin, output to agent.log) → expect → post-run tamper check → optional retry
//   → log brackets → failure marker → feed the breaker → unlock → status page.
// Every step that stops a run says so in .nightshift/log.txt; the ones a human must act on raise an alert.
//
// Two files, on purpose: log.txt holds harness lines only (the status page is built from it); agent.log holds
// whatever claude printed. An agent that prints a line shaped like a harness line ("ALERT CLEARED…") cannot
// forge the page, because the page never reads agent.log.
import { existsSync, statSync, writeFileSync, unlinkSync, appendFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findRoot, loadConfig, stateDir, nowIso, log } from './paths.mjs';
import * as preflight from './preflight.mjs';
import * as netwait from './netwait.mjs';
import * as circuit from './circuit.mjs';
import * as alert from './alert.mjs';

export const AGENT_LOG = 'agent.log';
const failures = (root, line) => { try { appendFileSync(join(stateDir(root), 'failures.txt'), `[${nowIso()}] ${line}\n`); } catch { } };

// Exit codes a scheduler (and a human) can tell apart.
export const EXIT = { OK: 0, FAILED: 1, NO_PROMPT: 2, EXPECT: 65, TAMPER: 66, HARNESS: 70, SPAWN: 127 };

function acquireLock(lock, job, staleMinutes) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(lock, 'wx'); writeFileSync(fd, `${nowIso()} ${job}\n`); closeSync(fd); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') return false;
      let age = 0; try { age = (Date.now() - statSync(lock).mtimeMs) / 60000; } catch { return false; }
      if (age < staleMinutes) return false;
      try { unlinkSync(lock); } catch { return false; } // stale → remove once, then retry the exclusive create
    }
  }
  return false;
}

// Everything that ends up on a command line is validated first. On Windows the line goes through cmd.exe,
// where even a quoted %VAR% expands; a strict shape per field leaves nothing for the shell to interpret.
const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'dontAsk', 'default', 'plan', 'auto'];
export function validateSpec(spec, cfg) {
  const errs = [];
  if (!spec.prompt && !spec.promptText) errs.push('no prompt or promptText');
  if (spec.model !== undefined && !/^[A-Za-z0-9._:\[\]-]{1,80}$/.test(spec.model)) errs.push(`model "${spec.model}" has characters a model name never has`);
  if (spec.maxTurns !== undefined && !(Number.isInteger(spec.maxTurns) && spec.maxTurns >= 1 && spec.maxTurns <= 1000)) errs.push('maxTurns must be an integer 1–1000');
  if (spec.timeoutMinutes !== undefined && !(spec.timeoutMinutes > 0 && spec.timeoutMinutes <= 720)) errs.push('timeoutMinutes must be 1–720');
  if (!PERMISSION_MODES.includes(cfg.claude.permissionMode)) errs.push(`claude.permissionMode "${cfg.claude.permissionMode}" is not a Claude Code permission mode`);
  if (spec.expect !== undefined) { try { new RegExp(spec.expect); } catch (e) { errs.push(`expect is not a valid pattern: ${e.message}`); } }
  return errs;
}

function launch(root, cfg, job, spec) {
  const out = join(stateDir(root), AGENT_LOG);
  const bin = process.env.NIGHTSHIFT_CLAUDE_BIN || cfg.claude.bin;
  // Fault injection for the fire drill: proves an unexpected crash inside a run is loud (INCIDENTS.md #4).
  if (process.env.NIGHTSHIFT_FAULT === 'launch') throw new Error('injected fault (NIGHTSHIFT_FAULT=launch)');
  // promptText wins; only a file-based job has a path to resolve (INCIDENTS.md #4).
  const prompt = spec.promptText || `Read the file ${resolve(root, spec.prompt)} and execute its instructions exactly. Use the real system date (ISO) for any dated filename.`;
  // The prompt goes on STDIN, never on the command line: on Windows the shell split it and claude ran with no
  // request (INCIDENTS.md #5). What remains on the line is validated flags and numbers.
  const args = ['-p', '--model', spec.model || 'sonnet', '--max-turns', String(spec.maxTurns || 40), '--permission-mode', cfg.claude.permissionMode];
  appendFileSync(out, `\n==== ${job} ${nowIso()} ====\n`);
  const fd = openSync(out, 'a');
  try {
    const isScript = /\.(m?js|cjs)$/.test(bin);
    // jobs.<job>.cwd: where claude runs (its CLAUDE.md, .claude/ and .mcp.json come from there). State and the
    // tamper gate stay at the project root.
    const cwd = spec.cwd ? resolve(root, spec.cwd) : root;
    const opts = { cwd, input: prompt, stdio: ['pipe', fd, fd], timeout: (spec.timeoutMinutes || 45) * 60000 };
    let r;
    if (isScript) r = spawnSync(process.execPath, [bin, ...args], opts);
    else if (process.platform === 'win32') {
      // Windows shims (claude.cmd) need a shell, and the shell splits on spaces — including inside the binary's
      // own path ("C:\Program Files\..."). Build one quoted command line instead of letting Node join an args
      // array unescaped.
      const q = s => /[\s"&|<>^%()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;
      r = spawnSync([bin, ...args].map(q).join(' '), { ...opts, shell: true });
    } else r = spawnSync(bin, args, opts);
    if (r.error) { log(root, `${job} SPAWN ERROR ${r.error.message}`); return EXIT.SPAWN; }
    return r.status ?? EXIT.FAILED;
  } finally { closeSync(fd); }
}

// jobs.<job>.expect: a pattern this run's output must match — exit 0 only means claude did not crash
// (INCIDENTS.md #5). The pattern is user config and the text is agent output, so the match runs in a child
// process with a time limit (no catastrophic-backtracking hang inside the lock) over the last 256 KB only.
function expectMet(root, spec, fromByte) {
  if (!spec.expect) return { ok: true };
  const buf = readFileSync(join(stateDir(root), AGENT_LOG)).subarray(fromByte);
  const text = buf.subarray(Math.max(0, buf.length - 256 * 1024)).toString('utf8');
  const code = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const{re,text}=JSON.parse(d);process.exit(new RegExp(re,"i").test(text)?0:1)})';
  const r = spawnSync(process.execPath, ['-e', code], { input: JSON.stringify({ re: spec.expect, text }), timeout: 3000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, why: r.status === 1 ? `output did not match /${spec.expect}/` : `expect /${spec.expect}/ took over 3s (pattern too slow) — treated as not met` };
}

const head = root => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// After the agent has finished: were protected files changed (left dirty) or changed-and-committed? Both fail the
// run now, instead of waiting for tomorrow's preflight — and the committed case is the one preflight could never
// see, because a commit is what it treats as approval. This check does not depend on reading command text.
function tamperedDuringRun(root, cfg, before) {
  const dirty = preflight.dirtyProtected(root, cfg);
  if (dirty.length) return `protected files changed during the run: ${dirty.join(', ')}`;
  const after = head(root);
  // Fail closed: if HEAD could not be read on either side, the committed case cannot be ruled out.
  if (!before || !after) return `git HEAD could not be read ${!before ? 'before' : 'after'} the run — cannot prove the rules were untouched`;
  if (before !== after) {
    try {
      const touched = execFileSync('git', ['diff', '--name-only', before, after, '--', ...cfg.protected], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (touched) return `protected files were COMMITTED during the run: ${touched.split('\n').join(', ')}`;
    } catch { return 'history changed during the run and could not be compared'; }
  }
  return null;
}

export async function runJob(root, job, override = {}) {
  let cfg;
  try { cfg = loadConfig(root); }
  catch (e) { log(root, `${job} ABORT config: ${e.message}`); alert.rawAdd(root, 'config', `${e.message} — no job will run until it parses. **Fix:** repair nightshift.config.json`); return EXIT.FAILED; }
  const spec = { ...(cfg.jobs[job] || {}), ...override };
  const state = stateDir(root);

  // 1. Global kill switch: a file named PAUSE halts all autonomy until removed.
  if (existsSync(join(state, 'PAUSE'))) { log(root, `${job} SKIP paused`); return EXIT.OK; }

  // 2. Config shape.
  const errs = validateSpec(spec, cfg);
  if (errs.length) {
    log(root, `${job} ABORT invalid job config: ${errs.join('; ')}`);
    alert.rawAdd(root, 'config', `job "${job}" is misconfigured: ${errs.join('; ')} **Fix:** edit nightshift.config.json`);
    return errs[0] === 'no prompt or promptText' ? EXIT.NO_PROMPT : EXIT.FAILED;
  }

  // 3. Tamper gate.
  const pf = await preflight.run(root);
  if (!pf.ok) { log(root, `${job} ABORT preflight`); return EXIT.FAILED; }

  // 4. Network gate.
  const net = await netwait.wait(root);
  if (!net.ok) { log(root, `${job} ABORT no-network`); failures(root, `${job} FAILED no-network`); await alert.add(root, 'netwait', { id: job, vars: { job } }); return EXIT.FAILED; }
  alert.clear(root, 'netwait', job);

  // 5. Circuit breaker. A corrupt state file counts as open (fail closed) and is a human alert.
  const c = circuit.check(root, job);
  if (c.corrupt) { await alert.add(root, 'state', { vars: { reason: c.reason } }); log(root, `${job} SKIP circuit-state-corrupt`); return EXIT.FAILED; }
  if (c.open) { log(root, `${job} SKIP circuit-open (reset with: nightshift circuit reset ${job})`); return EXIT.OK; }

  // 6. Lock. One claude at a time per project (jobs share quota and often share files). O_EXCL create, so two
  // runs starting together cannot both pass; a stale lock (crash leftover) is removed once.
  const lock = join(state, 'lock');
  if (!acquireLock(lock, job, cfg.lock.staleMinutes)) { log(root, `${job} SKIP lock-held`); return EXIT.FAILED; }

  let exit = EXIT.FAILED;
  try {
    log(root, `==== ${job} START ====`);
    // Anything that throws between START and END is a failed run like any other: logged, counted by the
    // breaker, alerted at the threshold. An exception must never skip the bookkeeping (INCIDENTS.md #4).
    try {
      const agentLog = join(state, AGENT_LOG);
      const attempt = () => {
        const before = head(root);
        const from = existsSync(agentLog) ? statSync(agentLog).size : 0;
        let code = launch(root, cfg, job, spec);
        const tamper = tamperedDuringRun(root, cfg, before);
        if (tamper) { log(root, `${job} TAMPER ${tamper}`); return { code: EXIT.TAMPER, tamper }; }
        if (code === EXIT.OK) { const e = expectMet(root, spec, from); if (!e.ok) { log(root, `${job} EXPECT not met: ${e.why}`); code = EXIT.EXPECT; } }
        return { code };
      };
      let r = attempt();
      // A tampered run is never retried: retrying would only give the agent a second go.
      if (r.code !== EXIT.OK && !r.tamper && spec.retry) {
        log(root, `${job} RETRY after exit=${r.code}`);
        await netwait.wait(root);
        r = attempt();
      }
      exit = r.code;
      if (r.tamper) await alert.add(root, 'tamper', { id: job, vars: { job, what: r.tamper } });
    } catch (e) {
      exit = EXIT.HARNESS;
      log(root, `${job} HARNESS ERROR ${e.message}`);
    }
    log(root, `==== ${job} END exit=${exit} ====`);
    if (exit !== EXIT.OK) failures(root, `${job} FAILED exit=${exit}`);
    if (exit === EXIT.OK) circuit.pass(root, job); else await circuit.fail(root, job);
  } finally {
    try { unlinkSync(lock); } catch { }
  }
  if (cfg.page?.auto) await (await import('./page.mjs')).buildQuietly(root);
  return exit;
}

export async function main(argv) {
  const [job, ...rest] = argv;
  if (!job) { console.error('usage: nightshift run <job> [--prompt=file] [--model=x] [--max-turns=n] [--retry]'); return 2; }
  const root = findRoot();
  const o = {};
  for (const a of rest) {
    if (a.startsWith('--prompt=')) o.prompt = a.slice(9);
    else if (a.startsWith('--model=')) o.model = a.slice(8);
    else if (a.startsWith('--max-turns=')) o.maxTurns = Number(a.slice(12));
    else if (a === '--retry') o.retry = true;
  }
  const exit = await runJob(root, job, o);
  const tail = readFileSync(join(stateDir(root), 'log.txt'), 'utf8').trim().split('\n').slice(-3).join('\n');
  console.log(tail);
  return exit;
}
