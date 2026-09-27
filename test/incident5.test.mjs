// INCIDENTS.md #5: on Windows the prompt reached claude in fragments (shell args are joined unescaped),
// claude said "I don't see a request" and exited 0. The run looked successful and did nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpProject, cleanup, join, fakeClaude, fakeClaudeShim } from './helpers.mjs';
import { runJob } from '../lib/run.mjs';
import * as circuit from '../lib/circuit.mjs';

async function project(name, job) {
  const dir = tmpProject(name);
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { host: '127.0.0.1', port: srv.address().port, tries: 1, waitMs: 1, connectMs: 500 }, jobs: { j: job } }));
  execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
  return { dir, done: () => { srv.close(); cleanup(dir); } };
}

// Spaces, quotes, shell metacharacters, a Windows path and Hebrew — everything that broke or could break.
const NASTY = 'Read the file E:\\new-repos\\.claude\\skills\\x\\SKILL.md & do it | now; "quoted" 100% <ok> ^caret — שלום';

test('the whole prompt reaches claude intact through a real shim (claude.cmd on Windows, a script elsewhere)', async () => {
  const { dir, done } = await project('inc5-shim', { promptText: NASTY, model: 'sonnet', maxTurns: 3 });
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaudeShim(dir);
  try {
    assert.equal(await runJob(dir, 'j'), 0);
    const log = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8');
    assert.ok(log.includes('prompt=' + JSON.stringify(NASTY)), 'prompt arrived byte-for-byte:\n' + log);
    assert.match(log, /ran with -p --model sonnet --max-turns 3 --permission-mode acceptEdits/);
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; done(); }
});

test('expect: exit 0 without the expected output is a failure — logged, marked, counted', async () => {
  const { dir, done } = await project('inc5-expect', { promptText: 'x', expect: 'SCAN (OK|SKIP)' });
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    for (let i = 0; i < 3; i++) assert.equal(await runJob(dir, 'j'), 65);
    const log = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8');
    assert.equal((log.match(/j EXPECT not met/g) || []).length, 3);
    assert.equal(circuit.check(dir, 'j').open, true, 'three empty successes open the breaker');
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; done(); }
});

test('expect: matching output passes, and only THIS run\'s output counts', async () => {
  const { dir, done } = await project('inc5-expect-ok', { promptText: 'SCAN OK please', expect: 'SCAN OK' });
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    assert.equal(await runJob(dir, 'j'), 0, 'the fake echoes the prompt, so the pattern appears');
    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'nightshift.config.json'), 'utf8')), jobs: { j: { promptText: 'nothing useful', expect: 'SCAN OK' } } }));
    execFileSync('git', ['commit', '-qam', 'cfg2'], { cwd: dir });
    assert.equal(await runJob(dir, 'j'), 65, 'an earlier run\'s match in the log does not count');
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; done(); }
});
