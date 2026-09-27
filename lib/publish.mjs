// publish.mjs — push the status page to a branch that GitHub Pages serves (default: gh-pages), so the
// page is public and updates itself after every run and drill. The branch is separate from the code:
// the code history stays clean, and the page branch only ever holds index.html.
//
// Configure:  "page": { "publish": { "repo": "https://github.com/you/repo.git", "branch": "gh-pages" } }
// Uses the git credentials already on the machine. Appends a commit per change (never force-pushes).
// A failed publish is an alert like any other: a status page that silently stops updating is exactly
// the kind of failure this tool exists to catch.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDir, log, nowIso } from './paths.mjs';
import * as alert from './alert.mjs';

const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...opts }).trim();

export async function publish(root, cfg, htmlFile) {
  const p = cfg.page?.publish;
  if (!p?.repo) return { skipped: true };
  const branch = p.branch || 'gh-pages';
  const dir = join(stateDir(root), 'pages');
  try {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      git(dir, ['init', '-q']);
      git(dir, ['remote', 'add', 'origin', p.repo]);
      git(dir, ['config', 'user.name', 'nightshift']);
      git(dir, ['config', 'user.email', 'nightshift@users.noreply.github.com']);
    }
    // Always follow the config: a changed page.publish.repo must not keep pushing to the old remote.
    git(dir, ['remote', 'set-url', 'origin', p.repo]);
    // Reach the remote first, and let that failure throw: "unreachable" must never be mistaken for
    // "branch not created yet", or an unchanged page would skip the push and the failure would stay silent.
    const heads = git(dir, ['ls-remote', '--heads', 'origin', branch]);
    if (heads) {
      git(dir, ['fetch', '-q', '--depth', '1', 'origin', branch]);
      git(dir, ['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
    } else {
      git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]); // same local name every time, no pile-up
    }
    // The branch holds the page and nothing else — also on a branch that existed before nightshift used it.
    git(dir, ['rm', '-rq', '--cached', '--ignore-unmatch', '.']);
    copyFileSync(htmlFile, join(dir, 'index.html'));
    git(dir, ['add', 'index.html']);
    const changed = (() => { try { git(dir, ['diff', '--cached', '--quiet']); return false; } catch { return true; } })();
    if (!changed) { alert.clear(root, 'publish'); return { changed: false }; }
    git(dir, ['commit', '-q', '-m', `status ${nowIso().slice(0, 16).replace('T', ' ')} UTC`]);
    git(dir, ['push', '-q', 'origin', `HEAD:${branch}`]);
    log(root, `PUBLISH ok → ${branch}`);
    alert.clear(root, 'publish');
    return { changed: true };
  } catch (e) {
    const reason = String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-1)[0] || 'error';
    log(root, `PUBLISH failed: ${reason}`);
    await alert.add(root, 'publish', { vars: { branch, reason } });
    return { error: reason };
  }
}
