import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpProject, cleanup, join, fakeClaude, setFakeExit } from './helpers.mjs';
import { build, collect } from '../lib/page.mjs';
import { runJob } from '../lib/run.mjs';
import { report } from '../lib/drill.mjs';

test('the page is built after a run, counts runs and failures, and never shows agent output', async () => {
  const dir = tmpProject('page');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { host: '127.0.0.1', port: srv.address().port, tries: 1, waitMs: 1, connectMs: 500 }, jobs: { nightly: { prompt: 'prompts/job.md' } } }));
    execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
    await runJob(dir, 'nightly');
    setFakeExit(dir, 1); await runJob(dir, 'nightly');
    const out = join(dir, '.nightshift', 'status.html');
    assert.ok(existsSync(out), 'page built automatically after the run');
    const html = readFileSync(out, 'utf8');
    const d = collect(dir);
    assert.equal(d.runs, 2); assert.equal(d.failures, 1);
    assert.match(html, /scheduled runs/); assert.match(html, />2<\/div>/);
    assert.match(html, /nightly/); assert.match(html, /exit 1/);
    assert.doesNotMatch(html, /fake claude ran/, 'the stand-in claude printed to the log; the page must not show it');
    assert.doesNotMatch(html, /<script/, 'no scripts');
    assert.match(html, /never run/, 'drill shown as never run');
    await report(dir, [{ name: 'tamper', pass: true }]);
    assert.match(readFileSync(out, 'utf8'), /PASS · 0 day\(s\) ago/, 'rebuilt after the drill');
  } finally { srv.close(); delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('a redacted page hides absolute paths; an unredacted local page keeps them', async () => {
  const dir = tmpProject('page-redact', { git: false, config: { page: { redact: true } } });
  try {
    mkdirSync(join(dir, '.nightshift'), { recursive: true });
    appendFileSync(join(dir, '.nightshift', 'log.txt'), [
      '[2026-09-01T06:00:00.000Z] PAGE built E:\\new-repos\\secret-client\\.nightshift\\status.html',
      '[2026-09-01T06:00:01.000Z] opened /home/user/work/x.txt and /Users/a/b and \\\\server\\share\\f',
      '[2026-09-01T06:00:02.000Z] relative prompts/job.md stays',
    ].join('\n') + '\n');
    const html = readFileSync(await build(dir), 'utf8');
    assert.doesNotMatch(html, /secret-client|\/home\/user|\/Users\/a|server\\share/);
    assert.match(html, /&lt;path&gt;/);
    assert.match(html, /prompts\/job\.md stays/, 'relative paths are not machine layout and stay');
    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ page: { redact: false } }));
    assert.match(readFileSync(await build(dir), 'utf8'), /secret-client/, 'a local-only page is not redacted');
  } finally { cleanup(dir); }
});

test('page.out is honoured and HTML is escaped', async () => {
  const dir = tmpProject('page-out', { git: false, config: { page: { out: 'docs/index.html' }, jobs: { 'a<b': { prompt: 'p.md' } } } });
  try {
    mkdirSync(join(dir, '.nightshift'), { recursive: true });
    appendFileSync(join(dir, '.nightshift', 'log.txt'), `[2026-09-01T06:00:00.000Z] ==== a<b START ====\n<b>agent output line</b>\n[2026-09-01T06:01:00.000Z] ==== a<b END exit=0 ====\n`);
    const out = await build(dir);
    assert.equal(out, join(dir, 'docs', 'index.html'));
    const html = readFileSync(out, 'utf8');
    assert.match(html, /a&lt;b/); assert.doesNotMatch(html, /<b>agent output/);
  } finally { cleanup(dir); }
});
