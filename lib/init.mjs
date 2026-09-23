// init.mjs — set a project up in one command. Creates nightshift.config.json (if missing), adds the
// state dir to .gitignore, and wires the guard hook into .claude/settings.json by merging, never
// replacing. Idempotent: running it twice changes nothing the second time. Prints the next steps.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, STATE_DIRNAME } from './paths.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url))); // the nightshift checkout
const IGNORE_LINES = [`${STATE_DIRNAME}/`, 'ALERTS.md'];

export function init(root = process.cwd(), { settingsFile = join(root, '.claude', 'settings.json') } = {}) {
  const did = [];
  const cfgPath = join(root, CONFIG_FILE);
  if (!existsSync(cfgPath)) { copyFileSync(join(HERE, 'nightshift.config.example.json'), cfgPath); did.push(`created ${CONFIG_FILE} (edit protected paths and jobs)`); }

  const gi = join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const lines = cur.split(/\r?\n/);
  const missing = IGNORE_LINES.filter(l => !lines.includes(l));
  if (missing.length) { writeFileSync(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + missing.join('\n') + '\n'); did.push(`.gitignore += ${missing.join(', ')}`); }

  const hookCmd = `node ${resolve(HERE, 'hooks', 'guard.mjs').replace(/\\/g, '/')}`;
  mkdirSync(dirname(settingsFile), { recursive: true });
  let settings = {};
  if (existsSync(settingsFile)) { try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch (e) { throw new Error(`${settingsFile} is not valid JSON — fix it first (${e.message})`); } }
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const already = settings.hooks.PreToolUse.some(g => (g.hooks || []).some(h => String(h.command || '').includes('hooks/guard.mjs')));
  if (!already) {
    settings.hooks.PreToolUse.push({ matcher: 'Bash|PowerShell|Read|Glob|Grep|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    did.push(`wired the guard hook into ${settingsFile}`);
  }
  return { did, hookCmd, cfgPath, settingsFile };
}

export async function main(argv) {
  // `nightshift init [dir]` — the directory defaults to cwd, but can be given explicitly (schedulers and
  // wrappers do not always start where you think).
  const root = resolve(argv.find(a => !a.startsWith('--')) || process.cwd());
  const r = init(root);
  console.log(`project: ${root}`);
  if (r.did.length) { console.log('nightshift init:'); for (const d of r.did) console.log('  + ' + d); }
  else console.log('nightshift init: nothing to do — already set up');
  const bin = resolve(HERE, 'bin', 'nightshift.mjs').replace(/\\/g, '/');
  console.log(`
next:
  1. edit ${CONFIG_FILE}: your protected files and your jobs
  2. git add ${CONFIG_FILE} .gitignore .claude/settings.json && git commit
     (the tamper gate compares protected files against the last commit)
  3. node ${bin} status
  4. schedule:  node ${bin} run <job>
  optional: npm link (in the nightshift folder) puts a global "nightshift" command on your PATH`);
  return 0;
}
