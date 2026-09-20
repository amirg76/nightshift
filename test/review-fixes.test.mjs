// Each test here is a hole the first code review found (see git log). They stay so the holes stay closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, closeSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpProject, cleanup, join, REPO, fakeClaude } from './helpers.mjs';
import * as circuit from '../lib/circuit.mjs';
import * as trust from '../lib/trust.mjs';
import { runJob } from '../lib/run.mjs';

const HOOK = join(REPO, 'hooks', 'guard.mjs');
const guard = (dir, input) => { const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, NIGHTSHIFT_ROOT: dir } }); return r.stdout.trim() ? JSON.parse(r.stdout) : null; };
const denied = o => o?.hookSpecificOutput?.permissionDecision === 'deny';

test('review #1: Read/Glob/Grep of secret paths is denied in every mode', () => {
  const dir = tmpProject('rv-read', { git: false });
  try {
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: join(dir, '.env') }], ['Read', { file_path: '/home/u/.ssh/id_rsa' }], ['Read', { file_path: 'C:\\Users\\u\\.aws\\credentials' }],
      ['Grep', { pattern: 'KEY', path: join(dir, '.env.production') }], ['Glob', { pattern: '**/.env' }],
    ]) assert.ok(denied(guard(dir, { tool_name, tool_input, permission_mode: 'default' })), `${tool_name} ${JSON.stringify(tool_input)}`);
    assert.equal(guard(dir, { tool_name: 'Read', tool_input: { file_path: join(dir, 'README.md') }, permission_mode: 'bypassPermissions' }), null, 'ordinary reads pass');
    assert.equal(guard(dir, { tool_name: 'Read', tool_input: { file_path: join(dir, 'environment.md') }, permission_mode: 'default' }), null, 'no false positive on "environment"');
  } finally { cleanup(dir); }
});

test('review #2: recursive delete in every spelling is denied', () => {
  const dir = tmpProject('rv-rm', { git: false });
  try {
    for (const command of ['rm -rf x', 'rm -r -f x', 'rm --recursive --force x', 'rm -R x', 'ri -Recurse -Force x', 'Remove-Item x -Recurse', 'rd /s /q x', 'ls && rm -r x'])
      assert.ok(denied(guard(dir, { tool_name: 'Bash', tool_input: { command }, permission_mode: 'default' })), `should deny: ${command}`);
    for (const command of ['rm file.txt', 'rmx', 'echo rm', 'git rm --cached f'])
      assert.equal(guard(dir, { tool_name: 'Bash', tool_input: { command }, permission_mode: 'default' }), null, `should allow: ${command}`);
  } finally { cleanup(dir); }
});

test('review #3: corrupt circuit.json fails closed — check() reports open, run skips and alerts', async () => {
  const dir = tmpProject('rv-circuit');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    mkdirSync(join(dir, '.nightshift'), { recursive: true });
    writeFileSync(join(dir, '.nightshift', 'circuit.json'), '{"j":{"fails":3,"opened_at":"2026-');
    const c = circuit.check(dir, 'j');
    assert.equal(c.open, true); assert.equal(c.corrupt, true);
    const { createServer } = await import('node:net');
    const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ net: { host: '127.0.0.1', port: srv.address().port, tries: 1, waitMs: 1, connectMs: 500 }, jobs: { j: { prompt: 'prompts/job.md' } } }));
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      assert.equal(await runJob(dir, 'j'), 1);
      assert.match(readFileSync(join(dir, 'ALERTS.md'), 'utf8'), /\[alert:state\]/);
      assert.doesNotMatch(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /fake claude ran/);
    } finally { srv.close(); }
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('review #4: a broken config is loud — log line and ALERTS.md even with no console', async () => {
  const dir = tmpProject('rv-config', { git: false });
  try {
    writeFileSync(join(dir, 'nightshift.config.json'), '{ not json');
    assert.equal(await runJob(dir, 'x'), 1);
    assert.match(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /ABORT config/);
    assert.match(readFileSync(join(dir, 'ALERTS.md'), 'utf8'), /\[alert:config\]/);
    await runJob(dir, 'x');
    assert.equal(readFileSync(join(dir, 'ALERTS.md'), 'utf8').match(/\[alert:config\]/g).length, 1, 'idempotent');
  } finally { cleanup(dir); }
});

test('review #5: the lock is exclusive; a fresh lock blocks, a stale lock is reclaimed', async () => {
  const dir = tmpProject('rv-lock');
  process.env.NIGHTSHIFT_CLAUDE_BIN = fakeClaude(dir);
  try {
    const { createServer } = await import('node:net');
    const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ lock: { staleMinutes: 60 }, net: { host: '127.0.0.1', port: srv.address().port, tries: 1, waitMs: 1, connectMs: 500 }, jobs: { j: { prompt: 'prompts/job.md' } } }));
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', 'nightshift.config.json'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'cfg'], { cwd: dir });
      mkdirSync(join(dir, '.nightshift'), { recursive: true });
      const lock = join(dir, '.nightshift', 'lock');
      closeSync(openSync(lock, 'w')); // fresh lock held by "another run"
      assert.equal(await runJob(dir, 'j'), 1);
      assert.match(readFileSync(join(dir, '.nightshift', 'log.txt'), 'utf8'), /SKIP lock-held/);
      const old = new Date(Date.now() - 2 * 3600 * 1000); utimesSync(lock, old, old); // now stale
      assert.equal(await runJob(dir, 'j'), 0, 'stale lock reclaimed and job ran');
      assert.equal(existsSync(lock), false, 'lock released after the run');
    } finally { srv.close(); }
  } finally { delete process.env.NIGHTSHIFT_CLAUDE_BIN; cleanup(dir); }
});

test('review #6: a demoted model earns trust back after a clean probation window', () => {
  const dir = tmpProject('rv-promote');
  try {
    const rec = rs => { for (const r of rs) trust.record(dir, 'mechanical', 'haiku', r); };
    rec(Array(10).fill('pass'));
    let row = trust.report(dir).find(r => r.model === 'haiku');
    assert.equal(row.state, 'trusted');
    rec(['fail', 'fail']); // demoteStreak=2 → probation
    row = trust.report(dir).find(r => r.model === 'haiku');
    assert.equal(row.state, 'probation');
    rec(Array(10).fill('pass')); // full clean window after demotion
    row = trust.report(dir).find(r => r.model === 'haiku');
    assert.equal(row.state, 'trusted', 'lifetime fails=2 must not block promotion');
  } finally { cleanup(dir); }
});

test('review #7: protected-file writes are matched on the resolved path, not the string', () => {
  const dir = tmpProject('rv-path', { git: false, config: { protected: ['CLAUDE.md', 'prompts/'] } });
  try {
    const edit = fp => guard(dir, { tool_name: 'Edit', tool_input: { file_path: fp }, permission_mode: 'acceptEdits' });
    assert.ok(denied(edit(join(dir, 'notes', '..', 'CLAUDE.md'))), '".." is resolved');
    assert.ok(denied(edit('CLAUDE.md')), 'relative to the project root');
    assert.ok(denied(edit(join(dir, 'prompts', 'sub', 'x.md'))), 'nested under a protected dir');
    assert.equal(edit(join(dir, 'prompts-archive', 'x.md')), null, 'a sibling with the same prefix is not protected');
    assert.equal(edit(join(dir, 'CLAUDE.md.bak')), null, 'suffix does not match');
  } finally { cleanup(dir); }
});
