// drill-claude.mjs — stand-in for the claude binary during a fire drill. Exits with DRILL_EXIT (default 0).
// Never launches a model: a drill proves the alert path, not the agent.
console.log('[drill] stand-in claude:', process.argv.slice(2).join(' '));
process.exit(Number(process.env.DRILL_EXIT || 0));
