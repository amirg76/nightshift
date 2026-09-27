import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpProject, cleanup, join } from './helpers.mjs';
import { publish } from '../lib/publish.mjs';
import { loadConfig } from '../lib/paths.mjs';
import * as alert from '../lib/alert.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('publish pushes index.html to a separate branch, only when it changed, and alerts on failure', async () => {
  const dir = tmpProject('publish', { git: false });
  const remote = join(dir, 'remote.git');
  mkdirSync(remote); git(remote, 'init', '-q', '--bare');
  try {
    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ page: { publish: { repo: remote, branch: 'gh-pages' } } }));
    const html = join(dir, 'status.html');
    writeFileSync(html, '<p>day 1</p>');
    const r1 = await publish(dir, loadConfig(dir), html);
    assert.equal(r1.changed, true);
    assert.equal(git(remote, 'show', 'gh-pages:index.html'), '<p>day 1</p>');
    assert.deepEqual(git(remote, 'ls-tree', '--name-only', 'gh-pages').split('\n'), ['index.html'], 'the branch holds only the page');

    const r2 = await publish(dir, loadConfig(dir), html);
    assert.equal(r2.changed, false, 'unchanged page → no commit');

    writeFileSync(html, '<p>day 2</p>');
    await publish(dir, loadConfig(dir), html);
    assert.equal(git(remote, 'show', 'gh-pages:index.html'), '<p>day 2</p>');
    assert.equal(git(remote, 'rev-list', '--count', 'gh-pages'), '2', 'appends, never rewrites');

    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ page: { publish: { repo: join(dir, 'nope.git'), branch: 'gh-pages' } } }));
    const bad = await publish(dir, loadConfig(dir), html);
    assert.ok(bad.error);
    assert.ok(alert.isActive(dir, 'publish'), 'a failed publish is an alert');
  } finally { cleanup(dir); }
});

test('publishing to a branch that already has other files leaves only the page', async () => {
  const dir = tmpProject('publish-existing', { git: false });
  const remote = join(dir, 'remote.git');
  mkdirSync(remote); git(remote, 'init', '-q', '--bare');
  const seed = join(dir, 'seed'); mkdirSync(join(seed, 'assets'), { recursive: true });
  try {
    git(seed, 'init', '-q', '-b', 'gh-pages'); git(seed, 'config', 'user.email', 't@e'); git(seed, 'config', 'user.name', 't');
    writeFileSync(join(seed, 'index.html'), 'old'); writeFileSync(join(seed, 'old-report.html'), 'x'); writeFileSync(join(seed, 'assets', 'style.css'), 'x');
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'pre-existing'); git(seed, 'push', '-q', remote, 'gh-pages');
    writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify({ page: { publish: { repo: remote, branch: 'gh-pages' } } }));
    writeFileSync(join(dir, 'status.html'), 'new');
    await publish(dir, loadConfig(dir), join(dir, 'status.html'));
    assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'gh-pages').split('\n'), ['index.html']);
    assert.equal(git(remote, 'show', 'gh-pages:index.html'), 'new');
  } finally { cleanup(dir); }
});

test('no publish config → nothing happens', async () => {
  const dir = tmpProject('publish-off', { git: false });
  try { assert.deepEqual(await publish(dir, loadConfig(dir), join(dir, 'x.html')), { skipped: true }); }
  finally { cleanup(dir); }
});
