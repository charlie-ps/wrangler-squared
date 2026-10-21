// A plan change's asks, oldest first: `replan.feedback` is the latest, `earlier`
// the ones before it (the human's ideas and Wrangler's send-back notes). A leaf
// both the server and the board import, like theme-ids.js.
//
// A replan saved before asks were kept flat has no `earlier`: its feedback nested
// every older ask as `Earlier: <older>\n\nNow: <newer>`, wrapped again on each
// ask and cut from the front at 16,000 characters, so it is split on its Now:
// seams and the run of Earlier: prefixes left at its start dropped.
export function replanAsks(replan) {
  if (!replan?.feedback) return [];
  if (Array.isArray(replan.earlier)) return [...replan.earlier, replan.feedback];
  const [first, ...rest] = replan.feedback.split('\n\nNow: ');
  return [first.replace(/^(Earlier: )+/, ''), ...rest];
}

export const latestAsk = (replan) => replanAsks(replan).at(-1) || '';

// What the planner reads: each earlier ask once, in order, then the latest.
export function replanAsked(replan) {
  const asks = replanAsks(replan);
  if (asks.length < 2) return asks[0] || '';
  return `Earlier:\n${asks.slice(0, -1).map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nNow: ${asks.at(-1)}`;
}
