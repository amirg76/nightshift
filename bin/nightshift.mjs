#!/usr/bin/env node
// nightshift — run Claude Code unattended, and know when it goes wrong.
import { findRoot, loadConfig, stateDir } from '../lib/paths.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const mods = {
  init: () => import('../lib/init.mjs'),
  drill: () => import('../lib/drill.mjs'),
  page: () => import('../lib/page.mjs'),
  run: () => import('../lib/run.mjs'),
  preflight: () => import('../lib/preflight.mjs'),
  netwait: () => import('../lib/netwait.mjs'),
  circuit: () => import('../lib/circuit.mjs'),
  trust: () => import('../lib/trust.mjs'),
  alert: () => import('../lib/alert.mjs'),
};

async function status() {
  const root = findRoot();
  const cfg = loadConfig(root);
  const [pf, circ, al, tr] = await Promise.all([import('../lib/preflight.mjs'), import('../lib/circuit.mjs'), import('../lib/alert.mjs'), import('../lib/trust.mjs')]);
  console.log(`root:   ${root}${cfg._hasConfig ? '' : '  (no nightshift.config.json — using defaults)'}`);
  console.log(`state:  ${stateDir(root)}`);
  const dirty = pf.dirtyProtected(root, cfg);
  console.log(`gate:   ${dirty.length ? 'ABORT — ' + dirty.join(', ') : 'clean'}`);
  const rows = circ.report(root);
  console.log(`jobs:   ${rows.length ? rows.map(r => `${r.job} ${r.open ? 'OPEN' : r.fails + '/' + r.threshold}`).join(', ') : 'all circuits closed'}`);
  const alerts = al.list(root);
  console.log(`alerts: ${alerts.length ? alerts.length + ' active' : 'none'}`);
  for (const a of alerts) console.log('  ' + a);
  const banned = tr.report(root).filter(r => r.state === 'banned');
  console.log(`trust:  ${banned.length ? 'BANNED ' + banned.map(r => `${r.model}@${r.cls}`).join(', ') : 'no banned models'}`);
  const { lastDrill, OVERDUE_DAYS } = await import('../lib/drill.mjs');
  const d = lastDrill(root);
  console.log(`drill:  ${!d ? 'never run — the alert path is unproven: nightshift drill' : `${d.verdict} ${d.days} day(s) ago${d.overdue ? ` — OVERDUE (>${OVERDUE_DAYS}): nightshift drill` : ''}`}`);
  return 0;
}

const usage = () => { console.log(`nightshift <command>

  init                           set this project up: config, .gitignore, guard hook in .claude/settings.json
  status                         one screen: gate, circuits, alerts, banned models, last drill
  drill [--push]                 fire drill: inject every failure mode in a sandbox, prove each alert raises and clears
  page                           rebuild the status page (also happens after every run and drill)
  run <job> [--retry]            run a configured job through the full harness
  preflight                      tamper gate: protected files vs last commit
  netwait                        wait for the API host to be reachable
  circuit check|fail|pass|reset <job> | report
  trust route <class> | record <class> <model> pass|fail [note] | reset <class> <model> | report | classes
  alert add|clear <key> [--id=x] [--arg=k=v] | list

  config: nightshift.config.json at the project root · state: .nightshift/`); return 0; };

let code;
try {
  if (!cmd || cmd === 'help' || cmd === '--help') code = usage();
  else if (cmd === 'status') code = await status();
  else if (mods[cmd]) code = await (await mods[cmd]()).main(rest);
  else { console.error(`unknown command: ${cmd}`); code = usage() || 2; }
} catch (e) { console.error(`nightshift ${cmd}: ${e.message}`); code = 1; }
process.exit(typeof code === 'number' ? code : 0);
