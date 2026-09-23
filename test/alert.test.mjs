import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, join } from './helpers.mjs';
import { tmpProject, cleanup } from './helpers.mjs';
import { writeFileSync } from 'node:fs';
import * as alert from '../lib/alert.mjs';
import * as paths from '../lib/paths.mjs';
const awaitImport = () => paths;

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

test('the ntfy topic can live in a file outside git, as a bare topic or a full URL', () => {
  const dir = tmpProject('alert-ntfyfile', { git: false, config: { alerts: { ntfyFile: '.ntfy-topic' } } });
  try {
    const { loadConfig } = awaitImport();
    assert.equal(alert.ntfyUrl(loadConfig(dir)), '', 'missing file → no push, no crash');
    writeFileSync(join(dir, '.ntfy-topic'), 'my-secret-topic\n');
    assert.equal(alert.ntfyUrl(loadConfig(dir)), 'https://ntfy.sh/my-secret-topic');
    writeFileSync(join(dir, '.ntfy-topic'), 'https://ntfy.example.org/t1');
    assert.equal(alert.ntfyUrl(loadConfig(dir)), 'https://ntfy.example.org/t1');
    assert.equal(alert.ntfyUrl({ ...loadConfig(dir), alerts: { ntfy: 'https://ntfy.sh/inline', ntfyFile: '.ntfy-topic' } }), 'https://ntfy.sh/inline', 'inline wins');
    assert.equal(alert.ntfyUrl({ ...loadConfig(dir), alerts: { ntfyFile: join(dir, '.ntfy-topic') } }), 'https://ntfy.example.org/t1', 'an absolute ntfyFile path is honoured');
  } finally { cleanup(dir); }
});
