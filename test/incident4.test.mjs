// INCIDENTS.md #4: a promptText job crashed before launching claude, and the crash skipped all
// bookkeeping — no END line, no failure marker, no breaker count, no alert — for four days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpProject, cleanup, join, fakeClaude, REPO } from './helpers.mjs';
import { runJob } from '../lib/run.mjs';
import * as circuit from '../lib/circuit.mjs';
import * as alert from '../lib/alert.mjs';

async function project(name, job) {
  const dir = tmpProject(name);
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { host: '127.0.0.1', port: srv.address().port, tries: 1, waitMs: 1, connectMs: 500 }, jobs: { j: job } }));
  execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
  return { dir, done: () => { srv.close(); cleanup(dir); } };
}

test('a promptText job (no prompt file) launches claude with that exact text', async () => {
  const { dir, done } = await project('inc4-text', { promptText: 'say the magic word' });
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    assert.equal(await runJob(dir, 'j'), 0);
    assert.match(readFileSync(join(dir, '.nightshift', 'agent.log'), 'utf8'), /prompt="say the magic word"/);
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; done(); }
});

test('an exception inside a run is logged, marked, counted, and alerted at the threshold', async () => {
  const { dir, done } = await project('inc4-crash', { promptText: 'x' });
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  process.env.NIGHTSHIFT_FAULT = 'launch';
  try {
    for (let i = 0; i < 3; i++) assert.equal(await runJob(dir, 'j'), 70);
    const log = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8');
    assert.equal((log.match(/j HARNESS ERROR injected fault/g) || []).length, 3);
    assert.equal((log.match(/==== j END exit=70 ====/g) || []).length, 3, 'every START has its END');
    assert.equal(readFileSync(join(dir, '.nightshift', 'failures.txt'), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.equal(circuit.check(dir, 'j').open, true);
    assert.ok(alert.isActive(dir, 'circuit', 'j'));
  } finally { delete process.env.NIGHTSHIFT_FAULT; delete process.env.NIGHTSHIFT_CLAUDE_BIN; done(); }
});

test('an exception that escapes to the CLI still reaches the log and ALERTS.md', () => {
  const dir = tmpProject('inc4-cli', { git: false });
  try {
    // "trust route" with an unknown class throws inside the command handler.
    const r = spawnSync(process.execPath, [join(REPO, 'bin', 'nightshift.mjs'), 'trust', 'route', 'no-such-class'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NIGHTSHIFT_ROOT: dir } });
    assert.equal(r.status, 1);
    assert.match(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /UNCAUGHT in "trust": unknown class/);
    assert.match(readFileSync(join(dir, 'ALERTS.md'), 'utf8'), /\[alert:uncaught\]/);
  } finally { cleanup(dir); }
});
