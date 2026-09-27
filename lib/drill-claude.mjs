// drill-claude.mjs — stand-in for the claude binary during a fire drill. Exits with DRILL_EXIT (default 0).
// Never launches a model: a drill proves the alert path, not the agent.
import { readFileSync } from 'node:fs';
let prompt = ''; try { prompt = readFileSync(0, 'utf8'); } catch { }
console.log('[drill] stand-in claude:', process.argv.slice(2).join(' '), '| prompt:', prompt.slice(0, 200));
process.exit(Number(process.env.DRILL_EXIT || 0));
