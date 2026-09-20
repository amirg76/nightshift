// trust.mjs — the model trust ledger. Which model has PROVEN it can do which class of task.
// Route to the cheapest candidate that is not banned; sample its output for review (100% while on
// probation, 1 in N once trusted). Bans are decided on a rolling window, never a lifetime counter —
// a lifetime counter once banned a model with a 92% pass rate (INCIDENTS.md #1).
// Source of truth: .nightshift/trust.ndjson (append-only). trust.json is derived, never edited.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, stateDir, nowIso, log } from './paths.mjs';
import * as alert from './alert.mjs';

const ledger = root => join(stateDir(root), 'trust.ndjson');
const derived = root => join(stateDir(root), 'trust.json');
const blank = () => ({ state: 'probation', attempts: 0, passes: 0, fails: 0, streak_fail: 0, since_sample: 0, since_demote: 0, recent: [], last: null });
const windowFails = c => (c.recent || []).filter(r => r === 'f').length;

function readEvents(root) {
  const f = ledger(root);
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ malformed: true }); }
  }
  return out;
}
const append = (root, e) => appendFileSync(ledger(root), JSON.stringify({ ts: nowIso(), ...e }) + '\n', 'utf8');

// Replays the whole ledger under the CURRENT rules. Changing a rule re-judges history.
export function rebuild(root, cfg = loadConfig(root)) {
  const T = cfg.trust;
  const classes = {};
  let bad = 0;
  const cell = (cls, m) => ((classes[cls] ??= {})[m] ??= blank());
  for (const e of readEvents(root)) {
    if (e.malformed || !e.cls || !e.model) { bad++; continue; }
    const c = cell(e.cls, e.model);
    if (e.event === 'reset') { classes[e.cls][e.model] = blank(); continue; }
    if (e.event === 'route') { c.since_sample = e.sampled ? 0 : c.since_sample + 1; continue; }
    if (e.event !== 'verdict') continue;
    c.attempts++; c.last = e.ts ?? null;
    if (e.result === 'pass') { c.passes++; c.streak_fail = 0; c.recent.push('p'); }
    else { c.fails++; c.streak_fail++; c.recent.push('f'); }
    if (c.recent.length > T.window) c.recent = c.recent.slice(-T.window);
    if (windowFails(c) >= T.banFails) { c.state = 'banned'; continue; }
    if (c.state === 'banned') continue; // a ban never heals itself; only a human reset ends it
    if (c.state === 'trusted' && c.streak_fail >= T.demoteStreak) { c.state = 'probation'; c.since_sample = 0; c.since_demote = 0; continue; }
    // Promotion is judged on the rolling window too, so a demotion is temporary: a model that has
    // completed a full probation window with at most `promoteMaxFails` failures in it earns trust back.
    if (c.state === 'probation') {
      c.since_demote = (c.since_demote ?? 0) + 1;
      const observed = Math.min(c.attempts, c.since_demote);
      if (observed >= T.probation && windowFails(c) <= T.promoteMaxFails) c.state = 'trusted';
    }
  }
  const out = { rebuilt_at: nowIso(), malformed_lines: bad, classes };
  writeFileSync(derived(root), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function escalatedStreak(root, cls) {
  let streak = 0;
  for (const e of readEvents(root)) {
    if (e.cls !== cls || e.event !== 'route') continue;
    streak = e.note === 'all-banned-escalated' ? streak + 1 : 0;
  }
  return streak;
}

export async function route(root, cls) {
  const cfg = loadConfig(root);
  const def = cfg.trust.classes[cls];
  if (!def) throw new Error(`unknown class: ${cls} (known: ${Object.keys(cfg.trust.classes).join(', ')})`);
  const led = rebuild(root, cfg);
  if (def.locked) {
    const model = def.candidates[0];
    append(root, { cls, model, event: 'route', sampled: false, note: 'locked' });
    return { model, sample: false, state: 'locked', escalated: false };
  }
  const cells = led.classes[cls] ?? {};
  let model = def.candidates.find(m => (cells[m]?.state ?? 'probation') !== 'banned');
  let escalated = false;
  if (!model) { model = def.candidates[def.candidates.length - 1]; escalated = true; }
  const c = cells[model] ?? blank();
  const sample = escalated || c.state !== 'trusted' || c.since_sample + 1 >= cfg.trust.sample;
  append(root, { cls, model, event: 'route', sampled: sample, ...(escalated ? { note: 'all-banned-escalated' } : {}) });
  // Escalation is a silent failure: nothing stops, everything just gets expensive. Two in a row → alert.
  const streak = escalated ? escalatedStreak(root, cls) : 0;
  if (escalated && streak >= 2) await alert.add(root, 'routing', { id: cls, vars: { cls, streak } });
  if (!escalated && alert.isActive(root, 'routing', cls)) alert.clear(root, 'routing', cls);
  if (escalated) log(root, `TRUST route ${cls} ESCALATED (streak ${streak})`);
  return { model, sample, state: escalated ? 'escalated' : c.state, escalated };
}

export function record(root, cls, model, result, note = '') {
  if (!['pass', 'fail'].includes(result)) throw new Error('result must be pass|fail');
  append(root, { cls, model, event: 'verdict', result, ...(note ? { note } : {}) });
  return rebuild(root).classes[cls][model];
}

export function reset(root, cls, model, note = 'human') {
  append(root, { cls, model, event: 'reset', note });
  rebuild(root);
}

export function report(root) {
  const cfg = loadConfig(root);
  const led = rebuild(root, cfg);
  const rows = [];
  for (const [cls, def] of Object.entries(cfg.trust.classes)) {
    const cells = led.classes[cls] ?? {};
    const models = Object.keys(cells).length ? Object.keys(cells) : [def.candidates[0]];
    for (const m of models) {
      const c = cells[m] ?? blank();
      rows.push({ cls, model: m, state: def.locked ? 'locked' : c.state, attempts: c.attempts, fails: c.fails,
        rate: c.attempts ? Math.round((c.passes / c.attempts) * 100) + '%' : '—',
        window: c.attempts ? `${windowFails(c)}/${(c.recent || []).length}` : '—' });
    }
  }
  return rows;
}

export async function main(argv) {
  const [cmd, a, b, ...rest] = argv;
  const root = findRoot();
  switch (cmd) {
    case 'route': { const r = await route(root, a); console.log(`MODEL=${r.model} SAMPLE=${r.sample ? 1 : 0} STATE=${r.state}`); return 0; }
    case 'record': { const c = record(root, a, b, rest[0], rest.slice(1).join(' ')); console.log(`${b}@${a} → ${c.state} (${c.passes}/${c.attempts} passed, ${c.fails} failed, window ${windowFails(c)}/${c.recent.length})`); return 0; }
    case 'reset': { reset(root, a, b, rest.join(' ') || 'human'); console.log(`${b}@${a} → probation (reset)`); return 0; }
    case 'rebuild': { const l = rebuild(root); console.log(`trust.json rebuilt · classes: ${Object.keys(l.classes).length} · malformed lines: ${l.malformed_lines}`); return 0; }
    case 'classes': { const cfg = loadConfig(root); for (const [k, v] of Object.entries(cfg.trust.classes)) console.log(`${k.padEnd(12)} ${v.locked ? 'LOCKED ' + v.candidates[0] : v.candidates.join(' → ')}`); return 0; }
    case 'report': case undefined: {
      const rows = report(root);
      const head = ['class', 'model', 'state', 'runs', 'fails', 'pass', 'window'];
      const data = rows.map(r => [r.cls, r.model, r.state, String(r.attempts), String(r.fails), r.rate, r.window]);
      const w = head.map((h, i) => Math.max(h.length, ...data.map(d => d[i].length)));
      const line = r => r.map((v, i) => v.padEnd(w[i])).join('  ');
      console.log(line(head)); console.log(w.map(n => '-'.repeat(n)).join('  ')); data.forEach(d => console.log(line(d)));
      const banned = rows.filter(r => r.state === 'banned');
      if (banned.length) console.log(`\nBANNED: ${banned.map(r => `${r.model}@${r.cls}`).join(', ')}`);
      if (!rows.some(r => r.attempts > 0)) console.log('\nno measurements yet — routing is an educated guess until verdicts are recorded');
      return 0;
    }
    default: console.error('usage: nightshift trust route <class> | record <class> <model> pass|fail [note] | reset <class> <model> [reason] | rebuild | classes | report'); return 2;
  }
}
