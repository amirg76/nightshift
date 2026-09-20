import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, join } from './helpers.mjs';
import { tmpProject, cleanup } from './helpers.mjs';
import * as alert from '../lib/alert.mjs';

test('add is idempotent, clear removes exactly that line, unknown keys throw', async () => {
  const dir = tmpProject('alert', { git: false });
  try {
    assert.equal(await alert.add(dir, 'circuit', { id: 'a', vars: { job: 'a', fails: 3 } }), true);
    assert.equal(await alert.add(dir, 'circuit', { id: 'a', vars: { job: 'a', fails: 4 } }), false, 'second add is a no-op');
    assert.equal(await alert.add(dir, 'circuit', { id: 'b', vars: { job: 'b', fails: 3 } }), true, 'different id is a different alert');
    const f = join(dir, 'ALERTS.md');
    assert.ok(existsSync(f));
    assert.match(readFileSync(f, 'utf8'), /failed 3 times in a row/);
    assert.equal(alert.list(dir).length, 2);
    assert.equal(alert.clear(dir, 'circuit', 'a'), true);
    assert.equal(alert.list(dir).length, 1);
    assert.equal(alert.clear(dir, 'circuit', 'a'), false, 'clearing what is absent is quiet');
    await assert.rejects(() => alert.add(dir, 'nope'), /unknown alert key/);
  } finally { cleanup(dir); }
});
