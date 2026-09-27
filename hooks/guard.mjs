#!/usr/bin/env node
// guard.mjs — PreToolUse hook for Claude Code. Denies what an unattended agent must never do, even after
// a successful prompt injection: destroy, exfiltrate, download-and-run, pay, push, or rewrite its own rules.
//   (a) always denied, in every mode: destructive commands, secret files, download→execute, payments,
//       git push and push aliases, destructive git;
//   (b) denied only when NO human is present (an unattended permission mode): writing protected files by
//       any tool — Edit/Write or a shell redirect — and git history changes (commit, add, rebase, config…),
//       because the tamper gate treats a commit as a human's approval.
// Every denial is logged to .nightshift/security-log.txt.
//
// LIMITS — read this before relying on it. This is a text matcher over the command the agent submits. It
// stops a careless or a lightly-steered agent; it does not stop one that is actively evading it through
// shell expansion (`F=-rf; rm $F`), encodings (base64 | sh), quote splitting (`cat .e''nv`), aliases, or a
// language runtime (`node -e`, `python -c`). General data flow (sending an arbitrary file somewhere) cannot
// be judged from text. The real boundaries are OS-level: Claude Code's sandbox, network allow-lists, and
// credentials the agent never had. run.mjs adds two structural checks that do not depend on text: protected
// files dirty or committed after a run fail that run (see INCIDENTS.md and SECURITY.md).
import { appendFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { findRoot, loadConfig, DEFAULTS, STATE_DIRNAME, CONFIG_FILE } from '../lib/paths.mjs';

const stdin = await new Promise(res => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => d += c); process.stdin.on('end', () => res(d)); process.stdin.on('error', () => res('')); });
let input; try { input = JSON.parse(stdin); } catch { process.exit(0); }

// Which project's rules apply? The project that owns the touched file (walk up for a nightshift.config.json),
// then Claude Code's CLAUDE_PROJECT_DIR, then cwd — so the guard is right even when launched elsewhere.
const touched = String((input.tool_input || {}).file_path || (input.tool_input || {}).notebook_path || '');
const fromFile = touched ? findRoot(dirname(resolve(touched))) : null;
const root = fromFile && existsSync(join(fromFile, CONFIG_FILE)) ? fromFile : findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());

const secLog = line => { try { const d = join(root, STATE_DIRNAME); mkdirSync(d, { recursive: true }); appendFileSync(join(d, 'security-log.txt'), `[${new Date().toISOString()}] ${line}\n`); } catch { } };

// Fail closed: an unreadable config does not disable protection, it falls back to the default protected list.
let cfg;
try { cfg = loadConfig(root); }
catch (e) { cfg = { protected: DEFAULTS.protected, allowAgentCommits: false }; secLog(`CONFIG UNREADABLE — using the default protected list: ${e.message}`); }

// Permission modes in which nobody is there to approve. `auto` and `default` are interactive.
const UNATTENDED = ['acceptEdits', 'bypassPermissions', 'dontAsk'];
const automated = UNATTENDED.includes(input.permission_mode || '');

function deny(reason) {
  secLog(`BLOCKED ${reason}`);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `nightshift guard: ${reason}. If this is legitimate, do it by hand in an interactive session.` } }));
  process.exit(0);
}

const tool = input.tool_name || '';
const ti = input.tool_input || {};
const short = s => String(s).slice(0, 100);

// ---- secrets: one list, used by every tool ------------------------------------------------------------
const SECRET_NAMES = String.raw`\.env(?:\.[\w-]+)?|\.claude\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials|cookies\.sqlite|login data`;
const SECRET_DIRS = String.raw`\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[\\/]gcloud`;
// A path (Read/Write/Glob/Grep target): the last segment is a secret name, or it passes through a secret dir.
const SECRET_PATH = new RegExp(String.raw`(^|[\\/])(${SECRET_NAMES})$|(^|[\\/])(${SECRET_DIRS})([\\/]|$)`, 'i');
// Inside a shell command: the same names as whole path tokens anywhere in the text.
const SECRET_IN_CMD = new RegExp(String.raw`(^|[\s'"=@:<>(\\/])(${SECRET_NAMES})(?=$|[\s'";|&<>)])|(^|[\s'"=@:<>(\\/~])(${SECRET_DIRS})[\\/]`, 'i');

if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'NotebookRead') {
  const p = String(ti.file_path || ti.path || ti.pattern || '').replace(/\\/g, '/');
  if (SECRET_PATH.test(p)) deny(`${tool} of a secret path (${short(p)})`);
  if (tool === 'Grep' && ti.glob && SECRET_PATH.test(String(ti.glob))) deny(`Grep over secret files (${short(ti.glob)})`);
  process.exit(0);
}

// ---- protected files ---------------------------------------------------------------------------------
// Real path (follows symlinks and junctions, expands 8.3 short names). A file that does not exist yet has no
// real path: resolve its nearest existing ancestor and re-attach the rest.
const real = p => {
  let abs = resolve(root, p); const tail = [];
  while (!existsSync(abs)) { const parent = dirname(abs); if (parent === abs) break; tail.unshift(basename(abs)); abs = parent; }
  try { abs = realpathSync.native(abs); } catch { }
  return tail.length ? join(abs, ...tail) : abs;
};
const norm = p => real(p).replace(/\\/g, '/').toLowerCase();
const isProtected = raw => {
  const target = norm(raw);
  return (cfg.protected || []).some(p => {
    const base = norm(p);
    return /[\/\\]$/.test(p) ? target === base || target.startsWith(base + '/') : target === base;
  });
};

if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
  const raw = String(ti.file_path || ti.notebook_path || '');
  if (SECRET_PATH.test(raw.replace(/\\/g, '/'))) deny(`write to secret file (${raw})`);
  if (automated && isProtected(raw)) deny(`unattended write to protected file (${raw}) — needs a human in an interactive session`);
  process.exit(0);
}

if (tool === 'Bash' || tool === 'PowerShell') {
  const orig = String(ti.command || '');
  const c = orig.toLowerCase();

  // (a) always
  const DOWNLOADER = /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer|certutil|bitsadmin)\b/; // unattended rule below
  const EXECUTES = /\|\s*(sh|bash|zsh|dash|ksh|node|python3?|perl|ruby|pwsh|powershell|iex|invoke-expression)\b|\bchmod\s+\+?[0-7]*x|(^|[\s;&|])\.{1,2}[\\/][\w.-]+|\b(sh|bash|zsh|source)\s+[\w.\\/-]+|\b(node|python3?|perl|ruby|pwsh|powershell)\s+[\w.\\/-]+\.(js|mjs|cjs|py|pl|rb|ps1)\b|\biex\b|invoke-expression|start-process|\bcmd\s+\/c\s+[\w.\\/-]+\.(bat|cmd|exe)/;
  const always = [
    [/\brm\b(?=[^\n|;&]*(\s-[a-z]*r|\s--recursive))/, 'recursive delete'],
    [/\b(ri|rm|rd|del|erase|rmdir|remove-item)\b[^\n|;&]*-rec/, 'recursive delete (PowerShell)'],
    [/(^|[&|;]|\n)\s*(del|erase)\s/, 'del/erase'],
    [/\brmdir\b|\bremove-item\b|\brd\s+\/s/, 'directory/item removal'],
    [/\bfind\b[^\n|;&]*\s-delete\b/, 'find -delete'],
    [/\brobocopy\b[^\n]*\/mir/, 'robocopy /mir (mirror delete)'],
    [/\bformat\s+[a-z]:|\bmkfs\b|\bdiskpart\b/, 'disk format'],
    [/\bshutdown\b|\breboot\b|\bstop-computer\b/, 'shutdown/reboot'],
    [/\breg\s+delete\b/, 'registry delete'],
    [/:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, 'fork bomb'],
    [/\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer/, 'LOLBin downloader'],
    [/\bmshta\b|\bregsvr32\b[^\n]*\/i:|\brundll32\b[^\n]*javascript/, 'LOLBin execution'],
    [/\b(schtasks\s+\/(delete|create|change)|crontab\s+-[re]|launchctl\s+(unload|remove|load))|register-scheduledtask|unregister-scheduledtask|set-scheduledtask/, 'scheduler change'],
    [/\bgit\b[^\n;&|]*\spush\b/, 'git push'],
    [/\bgit\b[^\n;&|]*(\salias\.|-c\s+alias\.)/, 'git alias (a way around the push rule)'],
    [/\bgit\b[^\n;&|]*\s(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-d|update-ref|filter-branch|filter-repo|reflog\s+expire|gc\s+--prune)/, 'destructive git'],
  ];
  for (const [re, label] of always) if (re.test(c)) deny(`${label} (${short(orig)})`);
  // Download → execute. With a human present only the unmistakable form is denied (piping a download straight
  // into an interpreter), so `curl …/health && node build.mjs` still works. Unattended, a download plus any
  // execution anywhere in the same command is denied — `;`, newlines, chmod +x, ./file.
  if (/\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b[^\n;&]*\|\s*(sh|bash|zsh|dash|ksh|node|python3?|perl|ruby|pwsh|powershell|iex|invoke-expression)\b/.test(c))
    deny(`download → execute (${short(orig)})`);
  if (automated && DOWNLOADER.test(c) && EXECUTES.test(c)) deny(`unattended download → execute (${short(orig)})`);
  if (SECRET_IN_CMD.test(orig)) deny(`secret file access (${short(orig)})`);
  const secretWord = /\b(secret|password|passwd|api[_-]?key|credential|access[_-]?token|private[_-]?key)\b/;
  const egress = /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|ncat|scp|sftp|ftp|rsync)\b|http\.request|https\.request|fetch\s*\(|net\.connect|dns\.resolve/;
  const readVerb = /\b(type|cat|get-content|gc|more|less|head|tail|copy|cp)\b|readfilesync|readfile/;
  if (secretWord.test(c) && (egress.test(c) || readVerb.test(c))) deny(`possible secret read/exfiltration (${short(orig)})`);
  if (/\b(checkout|purchase|subscribe|billing|payout|create[_-]?payment|place[_-]?order|add[_-]?card|payment[_-]?method|stripe|paypal)\b/.test(c)
      && !/\bgit\b[^\n;&|]*\scheckout\b/.test(c)) deny(`possible payment action (${short(orig)}) — money is a human gate`);

  // (b) unattended only
  if (automated) {
    // A commit is the tamper gate's proof that a human approved a change. An unattended agent never makes one.
    if (!cfg.allowAgentCommits && /\bgit\b[^\n;&|]*\s(commit|add|rm|mv|stash|rebase|merge|cherry-pick|revert|am|apply|config|update-index|restore|switch|checkout)\b/.test(c))
      deny(`unattended git history/config change (${short(orig)}) — commits are how a human approves changes`);
    // Writing a protected file through the shell instead of the Edit tool. Only real write TARGETS count — the
    // word after a redirect, or the arguments of a command that writes files — never text that merely mentions
    // a protected name (`echo "left CLAUDE.md alone" >> notes.txt` is fine).
    const WRITE_CMDS = /^(tee|cp|mv|copy|move|ren|rename|touch|truncate|install|ln|mklink|rm|del|erase|unlink|set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|clear-content|remove-item|sc|ac)$/;
    const unq = t => t.replace(/^["']|["']$/g, '');
    for (const seg of orig.split(/&&|\|\||[;|\n]/)) {
      const toks = seg.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [];
      const targets = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const redirect = t.match(/^\d?>>?(.*)$/);
        if (redirect) targets.push(redirect[1] || toks[i + 1] || '');
        else if (/.>>?./.test(t)) targets.push(t.split(/>>?/).pop());
      }
      const cmd = (toks[0] || '').toLowerCase().replace(/\.exe$/, '');
      const inPlace = (cmd === 'sed' || cmd === 'perl') && toks.some(t => /^-[a-z]*i/i.test(t));
      const args = toks.slice(1).filter(t => !/^-/.test(t));
      // A copy writes only its destination (copying a protected file OUT is harmless); a move also removes its source.
      if (/^(cp|copy|copy-item|install|ln|mklink)$/.test(cmd)) targets.push(...args.slice(-1));
      else if (WRITE_CMDS.test(cmd) || inPlace) targets.push(...args);
      for (const t of targets.map(unq)) if (t && /[\w.]/.test(t) && isProtected(t)) deny(`unattended shell write to protected file (${t}) — needs a human in an interactive session`);
    }
  }
  process.exit(0);
}

process.exit(0);
