// Copied from agent-wrangler's server/agents/claude.js cleanClaudeEnv: a `claude`
// spawned from inside a Claude session inherits CLAUDECODE and CLAUDE_CODE_*, which
// makes the child look nested and silently drops its transcript. The headless
// triage runner (headless-claude.js) needs the same strip, and an extension cannot
// import the agent adapters.
export function cleanClaudeEnv(env = process.env) {
  const strip = new Set(['CLAUDECODE', ...Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))]);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !strip.has(k)));
}
