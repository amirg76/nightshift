// Test helpers: a throwaway project under .tmp-test/ with its own git repo and config.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = join(REPO, '.tmp-test');

export function tmpProject(name, { git = true, config = {} } = {}) {
  const dir = join(TMP, `${name}-${process.pid}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nightshift.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'CLAUDE.md'), '# rules\n');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'job.md'), 'do nothing\n');
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'test');
    g('add', 'nightshift.config.json', 'CLAUDE.md', 'prompts/job.md');
    g('commit', '-q', '-m', 'init');
  }
  return dir;
}

export function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

// A stand-in for the claude binary: exits with the code found in <root>/.tmp-exit (default 0).
export function fakeClaude(dir) {
  const p = join(dir, 'fake-claude.mjs');
  writeFileSync(p, `import { readFileSync, existsSync } from 'node:fs';
const f = process.argv[1].replace(/fake-claude\\.mjs$/, '.tmp-exit');
console.log('fake claude ran with', process.argv.slice(2).join(' '));
process.exit(existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0);
`);
  return p;
}
export function setFakeExit(dir, code) { writeFileSync(join(dir, '.tmp-exit'), String(code)); }
export { existsSync, readFileSync, join };
