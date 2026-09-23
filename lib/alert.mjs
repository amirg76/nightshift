// alert.mjs — turns a silent failure into a line a human sees. Idempotent: adding twice writes once,
// clearing what is absent does nothing. Optional push via ntfy so the line also reaches a phone.
// Lesson behind it: a flag written only to a log hid a 33-day incident (see INCIDENTS.md).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, log } from './paths.mjs';

export const TEMPLATES = {
  preflight: {
    text: 'AUTONOMY HALTED — preflight refuses every scheduled run: a protected file changed without a commit. This is the tamper gate working. If the change is yours, commit it.',
    fix: 'git status; review; git add <files>; git commit',
  },
  circuit: {
    text: 'CIRCUIT OPEN for job "{job}" — it failed {fails} times in a row and is stopped so it cannot burn quota in a loop.',
    fix: 'read .nightshift/failures.txt, fix the cause, then: nightshift circuit reset {job}',
  },
  routing: {
    text: 'ROUTING INVERTED for class "{cls}" — every candidate model is banned, so route() escalates to the most expensive one. {streak} runs in a row.',
    fix: 'nightshift trust report; release a wrongly banned model with: nightshift trust reset {cls} <model> "<reason>"',
  },
  state: {
    text: 'STATE FILE CORRUPT — .nightshift/circuit.json cannot be parsed ({reason}). Every job is treated as circuit-open until it is fixed.',
    fix: 'inspect or delete .nightshift/circuit.json, then re-run',
  },
  drill: {
    text: 'FIRE DRILL FAILED — {failed}. The alert path itself is broken: until this is fixed, do not trust the absence of other alerts.',
    fix: 'nightshift drill (read the FAIL lines), fix, re-run until it passes',
  },
  netwait: {
    text: 'NETWORK — job "{job}" skipped: api.anthropic.com unreachable after the wait window.',
    fix: 'check connectivity; the job will run at its next schedule',
  },
};

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? vars[n] : m));
const mark = (key, id) => `[alert:${key}${id ? ':' + id : ''}]`;

function file(cfg) { return join(cfg._root, cfg.alerts.file); }

export function list(root = findRoot()) {
  const cfg = loadConfig(root);
  const f = file(cfg);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split(/\r?\n/).filter(l => /\[alert:[^\]]+\]/.test(l));
}

export function isActive(root, key, id = '') {
  return list(root).some(l => l.includes(mark(key, id)));
}

export async function add(root, key, { id = '', vars = {} } = {}) {
  const cfg = loadConfig(root);
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown alert key: ${key} (known: ${Object.keys(TEMPLATES).join(', ')})`);
  if (isActive(root, key, id)) return false; // already reported — no flooding on the daily re-run
  const f = file(cfg);
  const head = existsSync(f) ? readFileSync(f, 'utf8') : '# Alerts\n\nManaged by nightshift. A line here means a human must act. Lines clear themselves when the cause is gone.\n\n';
  const date = new Date().toISOString().slice(0, 10);
  const row = `- ⚠ ${mark(key, id)} ${date} — ${fill(t.text, vars)} **Fix:** ${fill(t.fix, vars)}\n`;
  writeFileSync(f, head.endsWith('\n') ? head + row : head + '\n' + row, 'utf8');
  log(root, `ALERT ${mark(key, id)}`);
  await push(cfg, `nightshift: ${key}${id ? ' ' + id : ''}`, fill(t.text, vars));
  return true;
}

export function clear(root, key, id = '') {
  const cfg = loadConfig(root);
  const f = file(cfg);
  if (!existsSync(f)) return false;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  const kept = lines.filter(l => !l.includes(mark(key, id)));
  if (kept.length === lines.length) return false;
  writeFileSync(f, kept.join('\n'), 'utf8');
  log(root, `ALERT CLEARED ${mark(key, id)}`);
  return true;
}

// ntfy.sh (or any ntfy server): free, no account, phone app. The topic name is a shared secret — anyone who
// knows it can read and post. Configure it either inline (alerts.ntfy = "https://ntfy.sh/<topic>") or, better,
// in a file outside git (alerts.ntfyFile = "/path/.ntfy-topic" holding a topic name or a full URL).
export function ntfyUrl(cfg) {
  if (cfg.alerts?.ntfy) return cfg.alerts.ntfy;
  const f = cfg.alerts?.ntfyFile;
  if (!f) return '';
  try {
    const v = readFileSync(join(cfg._root, f), 'utf8').trim();
    return !v ? '' : /^https?:\/\//.test(v) ? v : `https://ntfy.sh/${v}`;
  } catch { return ''; }
}

export async function push(cfg, title, body) {
  const url = ntfyUrl(cfg);
  if (!url || typeof fetch !== 'function') return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { method: 'POST', body, headers: { Title: title, Priority: 'high' }, signal: ctrl.signal });
    clearTimeout(t);
    log(cfg._root, `NTFY ${r.ok ? 'ok' : 'http ' + r.status}`);
    return r.ok;
  } catch (e) { log(cfg._root, `NTFY failed: ${e.message}`); return false; }
}

export async function main(argv) {
  const [cmd, key, ...rest] = argv;
  const root = findRoot();
  const id = (rest.find(a => a.startsWith('--id=')) || '').slice(5);
  const vars = Object.fromEntries(rest.filter(a => a.startsWith('--arg=')).map(a => { const [, n, ...v] = a.slice(6).split('='); return [n, v.join('=')]; }));
  switch (cmd) {
    case 'add': { const did = await add(root, key, { id, vars }); console.log(did ? `alert added: ${mark(key, id)}` : `already active: ${mark(key, id)}`); return 0; }
    case 'clear': { const did = clear(root, key, id); console.log(did ? `alert cleared: ${mark(key, id)}` : 'nothing to clear'); return 0; }
    case 'list': case undefined: { const l = list(root); console.log(l.length ? l.join('\n') : 'no active alerts'); return 0; }
    default: console.error('usage: nightshift alert add|clear <key> [--id=x] [--arg=name=value] | list'); return 2;
  }
}
