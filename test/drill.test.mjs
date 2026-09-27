import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tmpProject, cleanup, join } from './helpers.mjs';
import { runDrills, report, lastDrill } from '../lib/drill.mjs';
import * as alert from '../lib/alert.mjs';
import * as circuit from '../lib/circuit.mjs';

test('the fire drill passes every injected failure and touches no live state', async () => {
  const dir = tmpProject('drill');
  try {
    // live state that the drill must leave alone
    await circuit.fail(dir, 'live-job');
    const before = readFileSync(join(dir, '.nightshift', 'circuit.json'), 'utf8');
    const results = await runDrills(dir, { push: false });
    assert.deepEqual(results.map(r => r.name), ['tamper', 'circuit', 'routing', 'harness-crash', 'corrupt-state', 'broken-config', 'network']);
    for (const r of results) assert.ok(r.pass, `${r.name}: ${r.detail}`);
    assert.equal(readFileSync(join(dir, '.nightshift', 'circuit.json'), 'utf8'), before, 'live circuit state untouched');
    assert.equal(alert.list(dir).some(l => l.includes('[alert:preflight]') || l.includes('[alert:routing')), false, 'no sandbox alert leaked into the live project');
    assert.equal(lastDrill(dir), null, 'runDrills alone records nothing; report() does');
    const { failed } = await report(dir, results);
    assert.equal(failed, 0);
    const d = lastDrill(dir);
    assert.equal(d.verdict, 'PASS'); assert.equal(d.days, 0); assert.equal(d.overdue, false);
    assert.equal(alert.isActive(dir, 'drill'), false);
  } finally { cleanup(dir); }
});

test('a failed drill raises a real alert; a later pass clears it', async () => {
  const dir = tmpProject('drill-fail', { git: false });
  try {
    const bad = [{ name: 'tamper', pass: true }, { name: 'circuit', pass: false, detail: 'alert missing' }];
    const r = await report(dir, bad);
    assert.equal(r.failed, 1);
    assert.ok(alert.isActive(dir, 'drill'));
    assert.match(readFileSync(join(dir, 'ALERTS.md'), 'utf8'), /circuit \(alert missing\)/);
    assert.equal(lastDrill(dir).verdict, 'FAIL');
    await report(dir, [{ name: 'circuit', pass: true }]);
    assert.equal(alert.isActive(dir, 'drill'), false);
    assert.equal(lastDrill(dir).verdict, 'PASS');
    assert.ok(existsSync(join(dir, '.nightshift', 'drill-log.txt')));
  } finally { cleanup(dir); }
});
