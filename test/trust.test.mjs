import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpProject, cleanup } from './helpers.mjs';
import * as trust from '../lib/trust.mjs';
import * as alert from '../lib/alert.mjs';

const rec = (dir, cls, m, results) => { for (const r of results) trust.record(dir, cls, m, r); };

test('3 failures out of 3 bans the cheap model and routing falls through to the next', async () => {
  const dir = tmpProject('trust-ban');
  try {
    rec(dir, 'mechanical', 'haiku', ['fail', 'fail', 'fail']);
    const r = await trust.route(dir, 'mechanical');
    assert.equal(r.model, 'sonnet'); assert.equal(r.escalated, false);
  } finally { cleanup(dir); }
});

test('1 failure in 21 runs is trusted and sampled 1 in 5, not banned', async () => {
  const dir = tmpProject('trust-good');
  try {
    rec(dir, 'mechanical', 'haiku', ['fail', ...Array(20).fill('pass')]);
    const r1 = await trust.route(dir, 'mechanical');
    assert.equal(r1.state, 'trusted'); assert.equal(r1.model, 'haiku');
    const samples = [r1.sample];
    for (let i = 0; i < 4; i++) samples.push((await trust.route(dir, 'mechanical')).sample);
    assert.equal(samples.filter(Boolean).length, 1, 'exactly one of five routes is sampled');
  } finally { cleanup(dir); }
});

test('the 92%-pass-rate case: 4 failures spread over 52 runs never bans (rolling window)', async () => {
  const dir = tmpProject('trust-92');
  try {
    const seq = Array(52).fill('pass'); for (const i of [4, 6, 16, 21]) seq[i] = 'fail';
    rec(dir, 'mechanical', 'sonnet', seq);
    const row = trust.report(dir).find(r => r.cls === 'mechanical' && r.model === 'sonnet');
    assert.notEqual(row.state, 'banned');
    assert.equal(row.attempts, 52); assert.equal(row.fails, 4);
  } finally { cleanup(dir); }
});

test('a ban never heals itself: 12 clean passes after a ban keep it banned until reset', () => {
  const dir = tmpProject('trust-sticky');
  try {
    rec(dir, 'mechanical', 'haiku', ['fail', 'fail', 'fail', ...Array(12).fill('pass')]);
    let row = trust.report(dir).find(r => r.model === 'haiku' && r.cls === 'mechanical');
    assert.equal(row.state, 'banned'); assert.equal(row.window, '0/10');
    trust.reset(dir, 'mechanical', 'haiku', 'test');
    row = trust.report(dir).find(r => r.model === 'haiku' && r.cls === 'mechanical');
    assert.equal(row.state, 'probation');
  } finally { cleanup(dir); }
});

test('all candidates banned → escalated; second escalation raises the routing alert; recovery clears it', async () => {
  const dir = tmpProject('trust-esc');
  try {
    rec(dir, 'mechanical', 'haiku', ['fail', 'fail', 'fail']);
    rec(dir, 'mechanical', 'sonnet', ['fail', 'fail', 'fail']);
    const r1 = await trust.route(dir, 'mechanical');
    assert.equal(r1.state, 'escalated'); assert.equal(r1.model, 'sonnet');
    assert.equal(alert.isActive(dir, 'routing', 'mechanical'), false, 'one escalation is not yet an alert');
    await trust.route(dir, 'mechanical');
    assert.equal(alert.isActive(dir, 'routing', 'mechanical'), true, 'two in a row → alert');
    await trust.route(dir, 'mechanical');
    assert.equal(alert.list(dir).filter(l => l.includes('[alert:routing:mechanical]')).length, 1, 'no flooding');
    trust.reset(dir, 'mechanical', 'sonnet', 'fixed');
    const r4 = await trust.route(dir, 'mechanical');
    assert.equal(r4.escalated, false);
    assert.equal(alert.isActive(dir, 'routing', 'mechanical'), false, 'alert clears itself');
  } finally { cleanup(dir); }
});

test('locked classes never route away from their model', async () => {
  const dir = tmpProject('trust-locked');
  try {
    rec(dir, 'judgment', 'opus', ['fail', 'fail', 'fail', 'fail']);
    const r = await trust.route(dir, 'judgment');
    assert.equal(r.model, 'opus'); assert.equal(r.state, 'locked');
  } finally { cleanup(dir); }
});
