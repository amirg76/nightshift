// preflight.mjs — the tamper gate. Before any unattended run: if a protected file (rules, prompts,
// hook config) differs from the last commit, refuse to run. A clean tree means a human committed
// the change on purpose. Catches both tampering and "I edited the rules and forgot".
// The refusal is loud (alert), not just logged: a log-only abort once hid a 2-day outage.
import { execFileSync } from 'node:child_process';
import { findRoot, loadConfig, log } from './paths.mjs';
import * as alert from './alert.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function dirtyProtected(root, cfg = loadConfig(root)) {
  // The gate can only judge inside a repo with at least one commit. Anything else fails closed,
  // with a reason a newcomer can act on.
  try { git(root, ['rev-parse', '--is-inside-work-tree']); }
  catch { return ['<not a git repository — run: git init && git add . && git commit>']; }
  try { git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch { return ['<no commits yet — the gate compares against the last commit: git add . && git commit>']; }
  try {
    // `git status`, not `git diff HEAD`: diff never shows untracked files, so a NEW file dropped into a
    // protected directory (prompts/evil.md) passed the gate. status reports modified, staged, deleted, renamed
    // and untracked alike. -z keeps unusual file names intact.
    const out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...cfg.protected],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parts = out.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2); files.push(parts[i].slice(3));
      if (code.includes('R') || code.includes('C')) i++; // a rename's source path follows as its own entry
    }
    return files;
  } catch (e) {
    return ['<git error: ' + (e.message || 'error').split('\n')[0] + '>'];
  }
}

export async function run(root = findRoot()) {
  const cfg = loadConfig(root);
  const dirty = dirtyProtected(root, cfg);
  if (dirty.length) {
    log(root, `PREFLIGHT ABORT: protected files changed since last commit: ${dirty.join(', ')}`);
    await alert.add(root, 'preflight');
    return { ok: false, dirty };
  }
  alert.clear(root, 'preflight');
  return { ok: true, dirty: [] };
}

export async function main() {
  const r = await run();
  if (r.ok) { console.log('preflight OK — protected files match the last commit'); return 0; }
  console.log('preflight ABORT — changed without a commit:\n  ' + r.dirty.join('\n  '));
  return 1;
}
