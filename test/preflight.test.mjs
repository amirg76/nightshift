import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpProject, cleanup, join } from './helpers.mjs';
import * as preflight from '../lib/preflight.mjs';
import * as alert from '../lib/alert.mjs';

test('clean tree passes; an uncommitted change to a protected file aborts and alerts; committing clears it', async () => {
  const dir = tmpProject('preflight');
  try {
    assert.equal((await preflight.run(dir)).ok, true);
    writeFileSync(join(dir, 'CLAUDE.md'), '# rules\nnew rule injected\n');
    const r = await preflight.run(dir);
    assert.equal(r.ok, false); assert.deepEqual(r.dirty, ['CLAUDE.md']);
    assert.equal(alert.isActive(dir, 'preflight'), true);
    await preflight.run(dir);
    assert.equal(alert.list(dir).filter(l => l.includes('[alert:preflight]')).length, 1, 'no duplicate on re-run');
    execFileSync('git', ['add', 'CLAUDE.md'], { cwd: dir }); execFileSync('git', ['commit', '-q', '-m', 'ok'], { cwd: dir });
    assert.equal((await preflight.run(dir)).ok, true);
    assert.equal(alert.isActive(dir, 'preflight'), false, 'alert cleared after commit');
  } finally { cleanup(dir); }
});

test('changes outside the protected list do not stop a run', async () => {
  const dir = tmpProject('preflight-other');
  try {
    writeFileSync(join(dir, 'notes.md'), 'scratch\n');
    assert.equal((await preflight.run(dir)).ok, true);
  } finally { cleanup(dir); }
});

test('without git the gate fails closed', async () => {
  const dir = tmpProject('preflight-nogit', { git: false });
  try {
    const r = await preflight.run(dir);
    assert.equal(r.ok, false); assert.match(r.dirty[0], /not a git repository/);
  } finally { cleanup(dir); }
});

test('a repo with no commits fails closed with a hint', async () => {
  const dir = tmpProject('preflight-nocommit', { git: false });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const r = await preflight.run(dir);
    assert.equal(r.ok, false); assert.match(r.dirty[0], /no commits yet/);
  } finally { cleanup(dir); }
});
