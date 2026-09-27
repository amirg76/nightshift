// run.mjs — wraps one unattended Claude Code job. In order:
//   PAUSE switch → preflight (tamper gate) → network wait → circuit breaker → lock → claude -p
//   → optional single retry → log brackets → failure marker → feed the breaker → unlock.
// Every step that stops a run says so in .nightshift/log.txt, and the ones a human must act on raise an alert.
import { existsSync, statSync, writeFileSync, unlinkSync, appendFileSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRoot, loadConfig, stateDir, nowIso, log } from './paths.mjs';
import * as preflight from './preflight.mjs';
import * as netwait from './netwait.mjs';
import * as circuit from './circuit.mjs';
import * as alert from './alert.mjs';

const failures = (root, line) => { try { appendFileSync(join(stateDir(root), 'failures.txt'), `[${nowIso()}] ${line}\n`); } catch { } };

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

function launch(root, cfg, job, spec) {
  const logFile = join(stateDir(root), 'log.txt');
  const bin = process.env.NIGHTSHIFT_CLAUDE_BIN || cfg.claude.bin;
  // Fault injection for the fire drill: proves an unexpected crash inside a run is loud (INCIDENTS.md #4).
  if (process.env.NIGHTSHIFT_FAULT === 'launch') throw new Error('injected fault (NIGHTSHIFT_FAULT=launch)');
  // promptText wins; only a file-based job has a path to resolve. (Resolving an undefined path here crashed
  // every promptText job for four days — INCIDENTS.md #4.)
  const prompt = spec.promptText || `Read the file ${resolve(root, spec.prompt)} and execute its instructions exactly. Use the real system date (ISO) for any dated filename.`;
  // The prompt goes on STDIN, never on the command line. On Windows `claude` is a .cmd shim that needs a
  // shell, and Node joins shell arguments without escaping: a prompt with spaces arrived as fragments, claude
  // answered "I don't see a request" and exited 0 (INCIDENTS.md #5). Every remaining arg is a flag or a
  // plain number, so the shell has nothing left to split.
  const args = ['-p', '--model', spec.model || 'sonnet', '--max-turns', String(spec.maxTurns || 40), '--permission-mode', cfg.claude.permissionMode];
  const fd = openSync(logFile, 'a');
  try {
    const isScript = /\.(m?js|cjs)$/.test(bin);
    // jobs.<job>.cwd: where claude runs (its CLAUDE.md, .claude/ and .mcp.json come from there). State and the
    // tamper gate stay at the project root. Default: the root itself.
    const cwd = spec.cwd ? resolve(root, spec.cwd) : root;
    const opts = { cwd, input: prompt, stdio: ['pipe', fd, fd], timeout: (spec.timeoutMinutes || 45) * 60000 };
    let r;
    if (isScript) r = spawnSync(process.execPath, [bin, ...args], opts);
    else if (process.platform === 'win32') {
      // Windows shims (claude.cmd) need a shell, and the shell splits on spaces — including inside the binary's
      // own path ("C:\Program Files\..."). Build one quoted command line ourselves instead of letting Node
      // concatenate an args array unescaped.
      const q = s => /[\s"&|<>^%()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s;
      r = spawnSync([bin, ...args].map(q).join(' '), { ...opts, shell: true });
    } else r = spawnSync(bin, args, opts);
    if (r.error) { appendFileSync(logFile, `[${nowIso()}] ${job} SPAWN ERROR ${r.error.message}\n`); return 127; }
    return r.status ?? 1;
  } finally { closeSync(fd); }
}

// jobs.<job>.expect: a regex the run's output must match. Exit 0 only means claude did not crash — not that it
// did the job. A run whose output misses the pattern is a failure (exit 65), with everything that implies.
function expectMet(root, spec, fromByte) {
  if (!spec.expect) return true;
  const f = join(stateDir(root), 'log.txt');
  const out = readFileSync(f).subarray(fromByte).toString('utf8');
  return new RegExp(spec.expect, 'i').test(out);
}

// A broken config must be loud even when nobody watches stdout (cron → /dev/null). log() and the raw
// alert line below need no config, so they work precisely when loadConfig() cannot.
function rawAlert(root, key, text) {
  try {
    const f = join(root, 'ALERTS.md');
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : '# Alerts\n\n';
    if (cur.includes(`[alert:${key}]`)) return;
    appendFileSync(f, `${cur.endsWith('\n') ? '' : '\n'}- ⚠ [alert:${key}] ${nowIso().slice(0, 10)} — ${text}\n`);
  } catch { }
}

export async function runJob(root, job, override = {}) {
  let cfg;
  try { cfg = loadConfig(root); }
  catch (e) { log(root, `${job} ABORT config: ${e.message}`); rawAlert(root, 'config', `${e.message} — no job will run until it parses. **Fix:** repair nightshift.config.json`); return 1; }
  const spec = { ...(cfg.jobs[job] || {}), ...override };
  if (!spec.prompt && !spec.promptText) { log(root, `${job} ABORT no prompt configured (jobs.${job}.prompt)`); return 2; }
  const state = stateDir(root);

  // 1. Global kill switch: a file named PAUSE halts all autonomy until removed.
  if (existsSync(join(state, 'PAUSE'))) { log(root, `${job} SKIP paused`); return 0; }

  // 2. Tamper gate.
  const pf = await preflight.run(root);
  if (!pf.ok) { log(root, `${job} ABORT preflight`); return 1; }

  // 3. Network gate.
  const net = await netwait.wait(root);
  if (!net.ok) { log(root, `${job} ABORT no-network`); failures(root, `${job} FAILED no-network`); await alert.add(root, 'netwait', { id: job, vars: { job } }); return 1; }
  alert.clear(root, 'netwait', job);

  // 4. Circuit breaker. A corrupt state file counts as open (fail closed) and is a human alert.
  const c = circuit.check(root, job);
  if (c.corrupt) { await alert.add(root, 'state', { vars: { reason: c.reason } }); log(root, `${job} SKIP circuit-state-corrupt`); return 1; }
  if (c.open) { log(root, `${job} SKIP circuit-open (reset with: nightshift circuit reset ${job})`); return 0; }

  // 5. Lock. One claude at a time per project (jobs share quota and often share files). Created with
  // O_EXCL so two runs starting together cannot both pass; a stale lock (crash leftover) is removed once.
  const lock = join(state, 'lock');
  if (!acquireLock(lock, job, cfg.lock.staleMinutes)) { log(root, `${job} SKIP lock-held`); return 1; }

  let exit = 1;
  try {
    log(root, `==== ${job} START ====`);
    // Anything that throws between START and END is a failed run like any other: logged, counted by the
    // breaker, alerted after the threshold. An exception must never skip the bookkeeping.
    try {
      const logPath = join(stateDir(root), 'log.txt');
      let from = statSync(logPath).size;
      exit = launch(root, cfg, job, spec);
      if (exit === 0 && !expectMet(root, spec, from)) { exit = 65; log(root, `${job} EXPECT not met: output did not match /${spec.expect}/`); }
      if (exit !== 0 && spec.retry) {
        log(root, `${job} RETRY after exit=${exit}`);
        await netwait.wait(root);
        from = statSync(logPath).size;
        exit = launch(root, cfg, job, spec);
        if (exit === 0 && !expectMet(root, spec, from)) { exit = 65; log(root, `${job} EXPECT not met: output did not match /${spec.expect}/`); }
      }
    } catch (e) {
      exit = 70; // EX_SOFTWARE: the harness itself failed, not the agent
      log(root, `${job} HARNESS ERROR ${e.message}`);
    }
    log(root, `==== ${job} END exit=${exit} ====`);
    if (exit !== 0) failures(root, `${job} FAILED exit=${exit}`);
    if (exit === 0) circuit.pass(root, job); else await circuit.fail(root, job);
  } finally {
    try { unlinkSync(lock); } catch { }
  }
  if (cfg.page?.auto) (await import('./page.mjs')).buildQuietly(root);
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
