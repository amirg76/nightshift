// docs.test.mjs — the documentation must match the code, and CI enforces it.
// Every check here is a claim that went stale during the first release (CHANGELOG 0.2.0, review findings):
// the test count, a removed config option still documented, the command list, the number of drills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './helpers.mjs';
import { DEFAULTS } from '../lib/paths.mjs';
import { DRILLS } from '../lib/drill.mjs';

// CRLF-normalised: a Windows checkout with core.autocrlf=true hands us \r\n, and the patterns below anchor on \n.
const text = (...p) => readFileSync(join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const readme = text('README.md');
const testDir = join(REPO, 'test');

test('README test count equals the number of test() calls in test/*.test.mjs', () => {
  const m = readme.match(/`npm test` runs (\d+) tests/);
  assert.ok(m, 'README no longer says "`npm test` runs N tests"');
  const actual = readdirSync(testDir).filter(f => f.endsWith('.test.mjs'))
    .map(f => (text('test', f).match(/^test\(/gm) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.equal(Number(m[1]), actual, `README says ${m[1]} tests, test/ defines ${actual} — update README.md`);
});

test('every top-level DEFAULTS key is documented, and every example-config key exists in DEFAULTS', () => {
  const example = JSON.parse(text('nightshift.config.example.json'));
  for (const k of Object.keys(DEFAULTS)) {
    const inReadme = new RegExp('`' + k + '(`|[.:])|"' + k + '"').test(readme);
    assert.ok(inReadme || k in example, `DEFAULTS.${k} is neither in README.md nor in nightshift.config.example.json`);
  }
  for (const k of Object.keys(example)) {
    assert.ok(k in DEFAULTS, `nightshift.config.example.json has "${k}", which DEFAULTS does not know — a removed option still documented?`);
  }
});

test('every command in the README command block exists in bin/nightshift.mjs', () => {
  const block = readme.match(/```\n(nightshift init[\s\S]*?)```/);
  assert.ok(block, 'README command block (the one starting "nightshift init") not found');
  const commands = block[1].split('\n').filter(Boolean).flatMap(line =>
    line.replace(/^nightshift\s+/, '').split('·').map(p => p.trim().split(/\s+/)[0]).filter(Boolean));
  const bin = text('bin', 'nightshift.mjs');
  const known = new Set([...bin.matchAll(/^ {2}(\w+): \(\) => import\(/gm)].map(x => x[1]));
  known.add('status'); // dispatched inline in bin/nightshift.mjs, not through the module map
  assert.ok(commands.length >= 9, `expected at least 9 commands in the README block, parsed ${commands.length}: ${commands.join(' ')}`);
  for (const c of commands) assert.ok(known.has(c), `README documents "nightshift ${c}" but bin/nightshift.mjs has no such command`);
});

test('README drill count ("injects N failure modes") equals DRILLS.length', () => {
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const m = readme.match(/injects (\w+) failure modes/);
  assert.ok(m, 'README no longer says "injects N failure modes"');
  const n = words[m[1]] ?? Number(m[1]);
  assert.equal(n, DRILLS.length, `README says ${m[1]} failure modes, lib/drill.mjs defines ${DRILLS.length}`);
});
