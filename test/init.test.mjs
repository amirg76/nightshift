import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpProject, cleanup, join } from './helpers.mjs';
import { init } from '../lib/init.mjs';

test('init creates config, extends .gitignore, wires the hook — and is idempotent', () => {
  const dir = tmpProject('init', { git: false });
  rmSync(join(dir, 'nightshift.config.json'));
  try {
    const r1 = init(dir);
    assert.equal(r1.did.length, 3);
    assert.ok(existsSync(join(dir, 'nightshift.config.json')));
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.nightshift\/\nALERTS\.md/);
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(s.hooks.PreToolUse.length, 1);
    assert.match(s.hooks.PreToolUse[0].hooks[0].command, /hooks\/guard\.mjs$/);
    const r2 = init(dir);
    assert.deepEqual(r2.did, [], 'second run changes nothing');
  } finally { cleanup(dir); }
});

test('init merges into existing settings and never drops what is there', () => {
  const dir = tmpProject('init-merge', { git: false });
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    init(dir);
    const s = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo stop');
    assert.equal(s.hooks.PreToolUse.length, 2, 'existing PreToolUse group kept, guard appended');
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.nightshift/\nALERTS.md\n');
  } finally { cleanup(dir); }
});

test('init refuses to touch a settings.json it cannot parse', () => {
  const dir = tmpProject('init-bad', { git: false });
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ broken');
    assert.throws(() => init(dir), /not valid JSON/);
    assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), '{ broken', 'left untouched');
  } finally { cleanup(dir); }
});
