// circuit.mjs — circuit breaker for scheduled jobs. A job that fails N times in a row is stopped
// until a human resets it, so a broken job cannot burn quota in a silent daily loop.
// run.mjs calls: check (before), pass/fail (after). Deterministic, zero tokens.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, stateDir, nowIso, log } from './paths.mjs';
import * as alert from './alert.mjs';

const file = root => join(stateDir(root), 'circuit.json');
// A corrupt state file must not silently erase an open breaker (fail closed): load() throws, check() reports it.
const load = root => {
  const f = file(root);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`circuit.json is corrupt: ${e.message}`); }
};
const save = (root, s) => writeFileSync(file(root), JSON.stringify(s, null, 2), 'utf8');

export function check(root, job) {
  let state;
  try { state = load(root); } catch (e) { log(root, `CIRCUIT state corrupt — treating every job as OPEN: ${e.message}`); return { open: true, corrupt: true, reason: e.message }; }
  const c = state[job];
  return c?.opened_at ? { open: true, ...c } : { open: false };
}

export async function fail(root, job) {
  const cfg = loadConfig(root);
  const state = load(root);
  const c = (state[job] ??= { fails: 0, opened_at: null, last_failure: null });
  c.fails++; c.last_failure = nowIso();
  let opened = false;
  if (c.fails >= cfg.circuit.threshold && !c.opened_at) {
    c.opened_at = c.last_failure; opened = true;
  }
  save(root, state);
  log(root, `CIRCUIT ${job} fail ${c.fails}/${cfg.circuit.threshold}${opened ? ' → OPEN' : ''}`);
  if (opened) await alert.add(root, 'circuit', { id: job, vars: { job, fails: c.fails } });
  return { fails: c.fails, opened };
}

export function pass(root, job) {
  const state = load(root);
  const c = state[job];
  if (!c) return { reset: false };
  const wasOpen = !!c.opened_at;
  delete state[job]; save(root, state);
  if (wasOpen) alert.clear(root, 'circuit', job);
  log(root, `CIRCUIT ${job} reset after a clean run`);
  return { reset: true, wasOpen };
}

export function reset(root, job) {
  const state = load(root);
  if (!state[job]) return false;
  delete state[job]; save(root, state);
  alert.clear(root, 'circuit', job);
  log(root, `CIRCUIT ${job} reset by human`);
  return true;
}

export function report(root) {
  const cfg = loadConfig(root);
  return Object.entries(load(root)).map(([job, c]) => ({ job, open: !!c.opened_at, fails: c.fails, threshold: cfg.circuit.threshold, last_failure: c.last_failure }));
}

export async function main(argv) {
  const [cmd, job] = argv;
  const root = findRoot();
  switch (cmd) {
    case 'check': { const r = check(root, job); if (r.open) { console.log(`circuit OPEN for ${job} (${r.fails} consecutive failures since ${r.last_failure})`); return 1; } console.log(`circuit closed for ${job}`); return 0; }
    case 'fail': { const r = await fail(root, job); console.log(r.opened ? `circuit OPENED for ${job} after ${r.fails} failures` : `${job}: ${r.fails} consecutive failure(s)`); return 0; }
    case 'pass': { const r = pass(root, job); console.log(r.reset ? `${job}: counter cleared` : `${job}: nothing to clear`); return 0; }
    case 'reset': { console.log(reset(root, job) ? `${job}: circuit reset — will run next time` : `${job}: nothing to reset`); return 0; }
    case 'report': case undefined: {
      const rows = report(root);
      if (!rows.length) { console.log('all circuits closed — no job is blocked'); return 0; }
      for (const r of rows) console.log(`${r.job.padEnd(16)} ${r.open ? 'OPEN' : `${r.fails}/${r.threshold}`}  last failure: ${r.last_failure}`);
      return 0;
    }
    default: console.error('usage: nightshift circuit check|fail|pass|reset <job> | report'); return 2;
  }
}
