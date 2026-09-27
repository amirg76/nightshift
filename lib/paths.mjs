// paths.mjs — where the project is, where nightshift keeps its state, and how config is loaded.
// Resolution order for the root: NIGHTSHIFT_ROOT → nearest nightshift.config.json walking up from cwd
// → CLAUDE_PROJECT_DIR (set for hooks) → cwd. Nothing is hardcoded.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export const CONFIG_FILE = 'nightshift.config.json';
export const STATE_DIRNAME = '.nightshift';

export const DEFAULTS = {
  // Files an unattended run must never change. A change here without a commit stops every run (preflight).
  protected: ['CLAUDE.md', '.claude/', 'prompts/', CONFIG_FILE],
  alerts: { file: 'ALERTS.md', ntfy: '' },
  circuit: { threshold: 3 },
  trust: {
    window: 10, banFails: 3, probation: 10, promoteMaxFails: 1, demoteStreak: 2, sample: 5,
    classes: {
      mechanical: { candidates: ['haiku', 'sonnet'], locked: false },
      summarize:  { candidates: ['haiku', 'sonnet'], locked: false },
      research:   { candidates: ['sonnet', 'opus'],  locked: false },
      build:      { candidates: ['sonnet', 'opus'],  locked: false },
      judgment:   { candidates: ['opus'],            locked: true  },
    },
  },
  net: { host: 'api.anthropic.com', port: 443, tries: 10, waitMs: 25000, connectMs: 4000 },
  lock: { staleMinutes: 60 },
  claude: { bin: 'claude', permissionMode: 'acceptEdits' },
  // An unattended agent may not commit (or add, rebase, config…): the tamper gate treats a commit as a
  // human's approval. Set true only for jobs whose purpose is to commit; protected files stay guarded anyway.
  allowAgentCommits: false,
  // Status page: rebuilt after every run and drill. `out` is relative to the project. `publish: { repo, branch }`
  // (optional) pushes it to a Pages branch; a published page redacts absolute paths. `redact` forces that locally.
  page: { auto: true, out: '.nightshift/status.html', redact: false },
  jobs: {},
};

export function findRoot(start = process.cwd()) {
  if (process.env.NIGHTSHIFT_ROOT) return resolve(process.env.NIGHTSHIFT_ROOT);
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, CONFIG_FILE))) return d;
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  return resolve(start);
}

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  }
  return out;
};

export function loadConfig(root) {
  const f = join(root, CONFIG_FILE);
  if (!existsSync(f)) return { ...DEFAULTS, _root: root, _hasConfig: false };
  let user = {};
  try { user = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
  return { ...merge(DEFAULTS, user), _root: root, _hasConfig: true };
}

export function stateDir(root) {
  const s = join(root, STATE_DIRNAME);
  mkdirSync(s, { recursive: true });
  return s;
}

export const nowIso = () => new Date().toISOString();

// One log for everything nightshift does. Append-only, human-readable, never throws.
export function log(root, line) {
  try { appendFileSync(join(stateDir(root), 'log.txt'), `[${nowIso()}] ${line}\n`, 'utf8'); } catch { /* logging must never break a run */ }
}
