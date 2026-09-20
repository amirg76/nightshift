import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { tmpProject, cleanup } from './helpers.mjs';
import * as netwait from '../lib/netwait.mjs';

test('reachable local port → ok on first probe', async () => {
  const dir = tmpProject('net-ok', { git: false });
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await netwait.wait(dir, { host: '127.0.0.1', port: srv.address().port, tries: 3, waitMs: 10, connectMs: 1000 });
    assert.deepEqual(r, { ok: true, tries: 1 });
  } finally { srv.close(); cleanup(dir); }
});

test('closed port → gives up after the configured tries', async () => {
  const dir = tmpProject('net-fail', { git: false });
  const srv = createServer(() => { }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; await new Promise(r => srv.close(r)); // now guaranteed closed
  try {
    const r = await netwait.wait(dir, { host: '127.0.0.1', port, tries: 2, waitMs: 10, connectMs: 500 });
    assert.deepEqual(r, { ok: false, tries: 2 });
  } finally { cleanup(dir); }
});
