import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpProject, cleanup } from './helpers.mjs';
import * as circuit from '../lib/circuit.mjs';
import * as alert from '../lib/alert.mjs';

test('opens after 3 consecutive failures, raises one alert, and a clean run resets it', async () => {
  const dir = tmpProject('circuit');
  try {
    assert.equal(circuit.check(dir, 'daily').open, false);
    await circuit.fail(dir, 'daily'); await circuit.fail(dir, 'daily');
    assert.equal(circuit.check(dir, 'daily').open, false, 'two failures do not open it');
    const r = await circuit.fail(dir, 'daily');
    assert.equal(r.opened, true);
    assert.equal(circuit.check(dir, 'daily').open, true);
    assert.equal(alert.isActive(dir, 'circuit', 'daily'), true, 'alert raised');
    await circuit.fail(dir, 'daily');
    assert.equal(alert.list(dir).filter(l => l.includes('[alert:circuit:daily]')).length, 1, 'no duplicate alert');
    const p = circuit.pass(dir, 'daily');
    assert.equal(p.wasOpen, true);
    assert.equal(circuit.check(dir, 'daily').open, false);
    assert.equal(alert.isActive(dir, 'circuit', 'daily'), false, 'alert cleared on recovery');
  } finally { cleanup(dir); }
});

test('threshold is configurable and reset is manual', async () => {
  const dir = tmpProject('circuit-cfg', { config: { circuit: { threshold: 1 } } });
  try {
    const r = await circuit.fail(dir, 'x');
    assert.equal(r.opened, true);
    assert.equal(circuit.reset(dir, 'x'), true);
    assert.equal(circuit.check(dir, 'x').open, false);
    assert.equal(circuit.reset(dir, 'x'), false, 'nothing left to reset');
  } finally { cleanup(dir); }
});
