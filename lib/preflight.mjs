// preflight.mjs — the tamper gate. Before any unattended run: if a protected file (rules, prompts,
// hook config) differs from the last commit, refuse to run. A clean tree means a human committed
// the change on purpose. Catches both tampering and "I edited the rules and forgot".
// The refusal is loud (alert), not just logged: a log-only abort once hid a 2-day outage.
import { execFileSync } from 'node:child_process';
import { findRoot, loadConfig, log } from './paths.mjs';
import * as alert from './alert.mjs';

export function dirtyProtected(root, cfg = loadConfig(root)) {
  const paths = cfg.protected;
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    // Not a git repo or no commits yet: the gate cannot judge, so it fails closed.
    return ['<git unavailable: ' + (e.message || 'error').split('\n')[0] + '>'];
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
