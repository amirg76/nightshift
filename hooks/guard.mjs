#!/usr/bin/env node
// guard.mjs — PreToolUse hook for Claude Code. Deny-by-default for the things an unattended agent
// must never do, even if a prompt injection succeeds: destroy, exfiltrate, download-and-run, pay,
// or rewrite its own rules. Two tiers:
//   (a) always denied — destructive / exfil / remote-code, in every mode;
//   (b) denied only when NO human is present — editing protected files (rules, prompts, hook config).
// "No human present" = permission_mode is one of the unattended modes. Interactive modes pass.
// Every denial is logged to .nightshift/security-log.txt. Reads nightshift.config.json for the protected list.
import { appendFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { findRoot, loadConfig, STATE_DIRNAME, CONFIG_FILE } from '../lib/paths.mjs';

const stdin = await new Promise(res => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => d += c); process.stdin.on('end', () => res(d)); process.stdin.on('error', () => res('')); });
let input; try { input = JSON.parse(stdin); } catch { process.exit(0); }

// Which project's rules apply? Prefer the project that owns the file being touched (walk up from it
// for a nightshift.config.json), then Claude Code's CLAUDE_PROJECT_DIR, then cwd. This keeps the guard
// correct even when the hook is launched from an unrelated directory.
const touched = String((input.tool_input || {}).file_path || (input.tool_input || {}).notebook_path || '');
const fromFile = touched ? findRoot(dirname(resolve(touched))) : null;
const root = fromFile && existsSync(join(fromFile, CONFIG_FILE)) ? fromFile : findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
let cfg; try { cfg = loadConfig(root); } catch { cfg = { protected: [] }; }
const UNATTENDED = ['acceptEdits', 'bypassPermissions', 'dontAsk'];
const automated = UNATTENDED.includes(input.permission_mode || '');

function deny(reason) {
  try { const d = join(root, STATE_DIRNAME); mkdirSync(d, { recursive: true }); appendFileSync(join(d, 'security-log.txt'), `[${new Date().toISOString()}] BLOCKED ${reason}\n`); } catch { }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `nightshift guard: ${reason}. If this is legitimate, do it by hand in an interactive session.` } }));
  process.exit(0);
}

const tool = input.tool_name || '';
const ti = input.tool_input || {};

// Secret files are denied in EVERY tool and EVERY mode. Read/Glob/Grep are how an agent quietly
// exfiltrates: it reads the file, then the content is in the transcript and in its next tool call.
const SECRET_PATH = /(^|[\/\\])(\.env(\..*)?|\.claude\.json|id_rsa|id_ed25519|id_ecdsa|credentials|\.npmrc|\.pypirc|\.netrc|cookies\.sqlite|login data)$|[\/\\]\.(ssh|aws|gnupg|kube|docker)[\/\\]/i;
if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'NotebookRead') {
  const p = String(ti.file_path || ti.path || ti.pattern || '').replace(/\\/g, '/');
  if (SECRET_PATH.test(p)) deny(`${tool} of a secret path (${p.slice(0, 80)})`);
  process.exit(0);
}

if (tool === 'Bash' || tool === 'PowerShell') {
  const orig = String(ti.command || '');
  const c = orig.toLowerCase();
  // Recursive delete in any spelling: rm -rf, rm -r -f, rm --recursive, rm -R, PowerShell ri/rm/rd/del -Recurse.
  const recursiveRm = /\brm\b(?=[^\n|;&]*(\s-[a-z]*r|\s--recursive))/i;
  const psRecurse = /\b(ri|rm|rd|del|erase|rmdir|remove-item)\b[^\n|;&]*-rec/i;
  const always = [
    [recursiveRm, 'recursive delete'],
    [psRecurse, 'recursive delete (PowerShell)'],
    [/(^|[&|;])\s*(del|erase)\s/, 'del/erase'],
    [/\brmdir\b|\bremove-item\b|\brd\s+\/s/, 'directory/item removal'],
    [/\brobocopy\b[^\n]*\/mir/, 'robocopy /mir (mirror delete)'],
    [/\bformat\s+[a-z]:|\bmkfs\b|\bdiskpart\b/, 'disk format'],
    [/\bshutdown\b|\breboot\b|\bstop-computer\b/, 'shutdown/reboot'],
    [/\breg\s+delete\b/, 'registry delete'],
    [/:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, 'fork bomb'],
    [/(curl|wget|invoke-webrequest|iwr|invoke-restmethod)\b[^\n]*\|\s*(sh|bash|zsh|node|python|iex|invoke-expression)/, 'download → execute'],
    [/\|\s*iex\b|invoke-expression/, 'invoke-expression'],
    [/\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer/, 'LOLBin downloader'],
    [/\bmshta\b|\bregsvr32\b[^\n]*\/i:|\brundll32\b[^\n]*javascript/, 'LOLBin execution'],
    [/\b(schtasks\s+\/(delete|create|change)|crontab\s+-[re]|launchctl\s+(unload|remove))/, 'scheduler change'],
    [/\bgit\s+push\b/, 'git push'],
    [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/, 'destructive git'],
  ];
  for (const [re, label] of always) if (re.test(c)) deny(`${label} (${orig.slice(0, 80)})`);

  const secretPath = /(\.env\b|\.claude\.json|id_rsa|id_ed25519|\.ssh[\/\\]|\.aws[\/\\]|login\s*data|cookies\.sqlite)/;
  const secretWord = /\b(secret|password|api[_-]?key|credential|access[_-]?token)\b/;
  const egress = /(curl|wget|invoke-webrequest|iwr|invoke-restmethod|\bnc\b|ncat|scp|\bftp\b|http\.request|https\.request|fetch\s*\(|net\.connect|dns\.resolve)/;
  const readVerb = /(\btype\b|\bcat\b|get-content|\bmore\b|\bcopy\b|readfilesync|readfile)/;
  if (secretPath.test(c)) deny(`secret file access (${orig.slice(0, 80)})`);
  if (secretWord.test(c) && (egress.test(c) || readVerb.test(c))) deny(`possible secret read/exfiltration (${orig.slice(0, 80)})`);
  if (/\b(checkout|purchase|subscribe|billing|payout|create[_-]?payment|place[_-]?order|add[_-]?card|payment[_-]?method|stripe|paypal)\b/.test(c)) deny(`possible payment action (${orig.slice(0, 80)}) — money is a human gate`);
  process.exit(0);
}

if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
  const raw = String(ti.file_path || ti.notebook_path || '');
  if (SECRET_PATH.test(raw.replace(/\\/g, '/'))) deny(`write to secret file (${raw})`);
  if (automated) {
    // Resolve the real path (follows symlinks/junctions, expands 8.3 short names on Windows) and compare
    // against the resolved protected entries, so "..", links and short names cannot dodge the list.
    // A file that does not exist yet has no real path; resolve its nearest existing ancestor and
    // re-attach the rest, so a new file under a protected dir still compares on real paths.
    const real = p => {
      let abs = resolve(root, p); const tail = [];
      while (!existsSync(abs)) { const parent = dirname(abs); if (parent === abs) break; tail.unshift(basename(abs)); abs = parent; }
      try { abs = realpathSync.native(abs); } catch { }
      return tail.length ? join(abs, ...tail) : abs;
    };
    const norm = p => real(p).replace(/\\/g, '/').toLowerCase();
    const target = norm(raw);
    for (const p of cfg.protected || []) {
      const isDir = /[\/\\]$/.test(p);
      const base = norm(p);
      const hit = isDir ? target === base || target.startsWith(base + '/') : target === base;
      if (hit) deny(`unattended write to protected file (${raw}) — needs a human in an interactive session`);
    }
  }
  process.exit(0);
}

process.exit(0);
