// page.mjs — the live status page. One self-contained HTML file, rebuilt after every run and every drill,
// showing what a stranger (or an interviewer) wants to know in ten seconds: running since when, how many
// runs, are the gates clean, when was the alert path last proven. No external assets, no scripts.
// It shows harness lines only — never the agent's own output, never prompt contents.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { findRoot, loadConfig, stateDir, nowIso, log } from './paths.mjs';
import * as preflight from './preflight.mjs';
import * as circuit from './circuit.mjs';
import * as alert from './alert.mjs';
import * as trust from './trust.mjs';
import { lastDrill, OVERDUE_DAYS } from './drill.mjs';

const HARNESS_LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] (.*)$/;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function collect(root) {
  const cfg = loadConfig(root);
  const state = stateDir(root);
  const lines = existsSync(join(state, 'log.txt')) ? readFileSync(join(state, 'log.txt'), 'utf8').split('\n').map(l => l.match(HARNESS_LINE)).filter(Boolean).map(m => ({ ts: m[1], text: m[2] })) : [];
  const runs = lines.filter(l => /^==== \S+ START ====$/.test(l.text));
  const ends = lines.filter(l => /^==== \S+ END exit=\d+ ====$/.test(l.text));
  const lastByJob = {};
  for (const e of ends) { const m = e.text.match(/^==== (\S+) END exit=(\d+)/); lastByJob[m[1]] = { ts: e.ts, exit: Number(m[2]) }; }
  const failures = existsSync(join(state, 'failures.txt')) ? readFileSync(join(state, 'failures.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
  const dirty = preflight.dirtyProtected(root, cfg);
  return {
    generated: nowIso(),
    since: lines[0]?.ts || null,
    runs: runs.length, failures, lastByJob,
    jobs: Object.keys(cfg.jobs || {}),
    gate: dirty.length ? { clean: false, dirty } : { clean: true, dirty: [] },
    circuits: circuit.report(root),
    alerts: alert.list(root).map(l => l.replace(/^- ⚠\s*/, '')),
    trust: trust.report(root).filter(r => r.attempts > 0 || r.state === 'banned'),
    drill: lastDrill(root),
    recent: lines.slice(-25).reverse(),
  };
}

const days = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;

export function render(d) {
  const ok = d.gate.clean && !d.alerts.length && !d.circuits.some(c => c.open) && d.drill && d.drill.verdict === 'PASS' && !d.drill.overdue;
  const pill = (good, text) => `<span class="pill ${good ? 'ok' : 'bad'}">${esc(text)}</span>`;
  const drillText = !d.drill ? 'never run' : `${d.drill.verdict} · ${d.drill.days} day(s) ago${d.drill.overdue ? ` · OVERDUE (>${OVERDUE_DAYS})` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nightshift status</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b6b6b;--line:#e6e6e6;--ok:#1a7f37;--okbg:#e8f5ec;--bad:#b42318;--badbg:#fdecea;--mono:ui-monospace,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#9a9a9a;--line:#2a2a2a;--ok:#4cc38a;--okbg:#0f2a1c;--bad:#ff6b6b;--badbg:#3a1414}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:760px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--mut);margin:0 0 16px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px}.ok{color:var(--ok);background:var(--okbg)}.bad{color:var(--bad);background:var(--badbg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{border:1px solid var(--line);border-radius:10px;padding:12px}.n{font-size:26px;font-weight:700}.l{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:600}
pre{font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word;border:1px solid var(--line);border-radius:10px;padding:12px;margin:0}
ul{padding-left:20px}li{margin:4px 0}.foot{color:var(--mut);font-size:12px;margin-top:24px}
</style></head><body>
<h1>nightshift ${pill(ok, ok ? 'all clear' : 'needs attention')}</h1>
<p class="sub">Run Claude Code unattended. Know when it goes wrong. · generated ${esc(d.generated.slice(0, 16).replace('T', ' '))} UTC</p>
<div class="grid">
<div class="tile"><div class="n">${d.since ? days(d.since) : '—'}</div><div class="l">days running${d.since ? ' · since ' + esc(d.since.slice(0, 10)) : ''}</div></div>
<div class="tile"><div class="n">${d.runs}</div><div class="l">scheduled runs</div></div>
<div class="tile"><div class="n">${d.failures}</div><div class="l">failed runs</div></div>
<div class="tile"><div class="n">${d.alerts.length}</div><div class="l">open alerts</div></div>
</div>
<h2>Gates</h2>
<table>
<tr><th>tamper gate</th><td>${pill(d.gate.clean, d.gate.clean ? 'clean' : 'ABORT')}${d.gate.clean ? '' : ' ' + esc(d.gate.dirty.join(', '))}</td></tr>
<tr><th>circuit breakers</th><td>${d.circuits.length ? d.circuits.map(c => pill(!c.open, `${c.job} ${c.open ? 'OPEN' : c.fails + '/' + c.threshold}`)).join(' ') : pill(true, 'all closed')}</td></tr>
<tr><th>fire drill</th><td>${pill(!!d.drill && d.drill.verdict === 'PASS' && !d.drill.overdue, drillText)}</td></tr>
<tr><th>banned models</th><td>${d.trust.filter(t => t.state === 'banned').length ? d.trust.filter(t => t.state === 'banned').map(t => pill(false, `${t.model}@${t.cls}`)).join(' ') : pill(true, 'none')}</td></tr>
</table>
<h2>Open alerts</h2>
${d.alerts.length ? '<ul>' + d.alerts.map(a => `<li>${esc(a)}</li>`).join('') + '</ul>' : '<p class="sub">none — every alert that was raised has cleared itself.</p>'}
<h2>Jobs</h2>
${d.jobs.length ? '<table><tr><th>job</th><th>last run</th><th>result</th></tr>' + d.jobs.map(j => { const l = d.lastByJob[j]; return `<tr><td>${esc(j)}</td><td>${l ? esc(l.ts) : '—'}</td><td>${l ? pill(l.exit === 0, l.exit === 0 ? 'ok' : 'exit ' + l.exit) : '<span class="l">never</span>'}</td></tr>`; }).join('') + '</table>' : '<p class="sub">no jobs configured</p>'}
${d.trust.length ? '<h2>Model trust</h2><table><tr><th>class</th><th>model</th><th>state</th><th>runs</th><th>pass</th><th>window</th></tr>' + d.trust.map(t => `<tr><td>${esc(t.cls)}</td><td>${esc(t.model)}</td><td>${pill(t.state !== 'banned', t.state)}</td><td>${t.attempts}</td><td>${esc(t.rate)}</td><td>${esc(t.window)}</td></tr>`).join('') + '</table>' : ''}
<h2>Recent harness events</h2>
<pre>${d.recent.length ? d.recent.map(l => `${esc(l.ts.slice(0, 16).replace('T', ' '))}  ${esc(l.text)}`).join('\n') : 'no runs yet'}</pre>
<p class="foot">Harness lines only. The agent's own output and prompt contents never appear here. <a href="https://github.com/amirg76/nightshift">nightshift</a></p>
</body></html>
`;
}

export function build(root = findRoot()) {
  const cfg = loadConfig(root);
  const out = resolve(root, cfg.page?.out || join(stateDir(root), 'status.html'));
  mkdirSync(dirname(out), { recursive: true });
  const html = render(collect(root));
  writeFileSync(out, html, 'utf8');
  log(root, `PAGE built ${out}`);
  if (cfg.page?.publishCmd) {
    try { execSync(cfg.page.publishCmd, { cwd: root, stdio: 'ignore', timeout: 120000 }); log(root, 'PAGE published'); }
    catch (e) { log(root, `PAGE publish failed: ${e.message.split('\n')[0]}`); }
  }
  return out;
}

// Best effort: a page failure must never fail a run.
export function buildQuietly(root) { try { return build(root); } catch (e) { try { log(root, `PAGE failed: ${e.message}`); } catch { } return null; } }

export async function main() {
  const out = build();
  console.log(`status page: ${out}`);
  return 0;
}
