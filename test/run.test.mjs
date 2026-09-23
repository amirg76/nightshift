import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpProject, cleanup, join, fakeClaude, setFakeExit } from './helpers.mjs';
import { runJob } from '../lib/run.mjs';
import * as circuit from '../lib/circuit.mjs';

// Local loopback is always reachable, so the network gate passes instantly in tests.
const net = { host: '127.0.0.1', port: 0, tries: 1, waitMs: 1, connectMs: 500 };
const withServer = async (fn) => {
  const { createServer } = await import('node:net');
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { srv.close(); }
};

test('full harness: fake claude exit 0 → END exit=0, no failure marker', async () => {
  const dir = tmpProject('run-ok');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    await withServer(async port => {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { ...net, port }, jobs: { daily: { prompt: 'prompts/job.md', model: 'sonnet', maxTurns: 5 } } }));
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      const exit = await runJob(dir, 'daily');
      assert.equal(exit, 0);
      const log = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8');
      assert.match(log, /daily START/); assert.match(log, /fake claude ran with -p/); assert.match(log, /daily END exit=0/);
      assert.equal(circuit.report(dir).length, 0);
    });
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('jobs.<job>.cwd runs claude elsewhere while state stays at the root', async () => {
  const dir = tmpProject('run-cwd');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'fake-cwd.mjs'), "console.log('cwd=' + process.cwd()); process.exit(0);");
  process.env.NIGHTSHIFT_CLAUDE_BIN = join(dir, 'fake-cwd.mjs');
  try {
    await withServer(async port => {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { ...net, port }, jobs: { j: { prompt: 'prompts/job.md', cwd: 'elsewhere' } } }));
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      assert.equal(await runJob(dir, 'j'), 0);
      const log = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8');
      assert.match(log, new RegExp('cwd=' + join(dir, 'elsewhere').replace(/[\\\\^$.*+?()[\]{}|]/g, '\\$&')));
      assert.ok(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8').includes('j END exit=0'), 'state still written at the root');
    });
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('three failing runs open the circuit; the fourth is skipped without launching', async () => {
  const dir = tmpProject('run-fail');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    await withServer(async port => {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { ...net, port }, jobs: { j: { prompt: 'prompts/job.md' } } }));
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      setFakeExit(dir, 1);
      for (let i = 0; i < 3; i++) assert.equal(await runJob(dir, 'j'), 1);
      assert.equal(circuit.check(dir, 'j').open, true);
      const before = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8').match(/fake claude ran/g).length;
      assert.equal(await runJob(dir, 'j'), 0, 'skip is a clean exit, not a failure');
      const after = readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8').match(/fake claude ran/g).length;
      assert.equal(after, before, 'claude was not launched while the circuit is open');
      assert.match(readFileSync(join(dir, '.nightshift', 'failures.txt'), 'utf8'), /j FAILED exit=1/);
    });
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('PAUSE file stops everything; tamper gate stops everything', async () => {
  const dir = tmpProject('run-gates');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    await withServer(async port => {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { ...net, port }, jobs: { j: { prompt: 'prompts/job.md' } } }));
      const { execFileSync, } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      const { mkdirSync, unlinkSync } = await import('node:fs');
      mkdirSync(join(dir, '.nightshift'), { recursive: true });
      writeFileSync(join(dir, '.nightshift', 'PAUSE'), '');
      assert.equal(await runJob(dir, 'j'), 0);
      assert.match(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /j SKIP paused/);
      unlinkSync(join(dir, '.nightshift', 'PAUSE'));
      writeFileSync(join(dir, 'CLAUDE.md'), '# tampered\n');
      assert.equal(await runJob(dir, 'j'), 1);
      assert.match(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /j ABORT preflight/);
      assert.doesNotMatch(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /fake claude ran/, 'never launched');
    });
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});
