import { COMMENT_SETTLE_MS } from './job-comments.js';

// Sync: an open PR whose branch conflicts with its base is brought up to date by a
// session that does only that (job-runner.js), before any work runs on it. It merges
// the base in, commits and pushes, and never goes through code review: a mechanical
// resolution is visible in the PR, and one that needs a judgement call parks on a
// `conflict` receipt for the human to pick (`sub.conflict`), then carries on.
// Work never merges or rebases, so the tree the human reviews is only the work.
export const MAX_SYNCS = 5;
// The phrase "conflict repair limit" is what the board reads the title from (public/jobs.js eventTitle).
export const SYNC_LIMIT = `Merge conflicts still there after ${MAX_SYNCS} syncs (conflict repair limit reached). Review changes, then retry if needed.`;
// A conflict repair from before sync counts the same: both are the base moving.
export const syncAttempts = (job, sub) => job.runs.filter((r) => r.subJobId === sub.id && (r.phase === 'sync' || (r.phase === 'repair' && r.conflict))).length;
export const conflictWaiting = (sub) => !!sub?.conflict && !sub.conflict.decided;
export const conflictRun = (job, sub) => (sub?.conflict && job.runs.find((r) => !r.stopped && r.id === sub.conflict.runId && r.parkedFor === 'conflict')) || null;

// The session stops mid-merge and waits for mail (no slot, held only to its card
// existing, as a drafts park is). A second conflict after the picks were mailed is
// a new question on the same run.
export function parkConflict(j, r, s, report, now) {
  if (r.phase !== 'sync') throw new Error('Only the session syncing a branch with its base reports a conflict');
  if (r.parkedAt && !r.mailedAt) {
    if (JSON.stringify(r.conflictReport) === JSON.stringify(report)) return;
    throw new Error('You already reported this conflict; wait for mail with the human\'s choices');
  }
  Object.assign(r, { conflictReport: report, parkedFor: 'conflict', parkedAt: now, mailedAt: null, idleSince: null });
  if (s && !j.cancelledAt && !s.cancelledAt) s.conflict = { runId: r.id, ...(report.summary ? { summary: report.summary } : {}), conflicts: report.conflicts, at: now };
}

// The human's pick for each conflict, pinned to the run that asked: a retry or a
// newer question is not answered by a board a tick behind.
export const CONFLICT_NOTE_MAX = 2000;
export function resolveConflict(s, { runId, picks, note }) {
  const c = s?.conflict;
  if (!c || c.decided) throw new Error('No conflict is waiting for you on this step');
  if (runId && runId !== c.runId) throw new Error('That conflict has moved on; look again');
  if (!Array.isArray(picks) || picks.length !== c.conflicts.length || picks.some((p, i) => !Number.isInteger(p) || p < 0 || p >= c.conflicts[i].options.length)) {
    throw new Error('Pick one way to resolve each conflict');
  }
  const said = typeof note === 'string' ? note.trim() : '';
  if (said.length > CONFLICT_NOTE_MAX) throw new Error(`A note is at most ${CONFLICT_NOTE_MAX.toLocaleString('en-GB')} characters`);
  c.decided = { picks, ...(said ? { note: said } : {}), at: Date.now() };
  return `Chose how to resolve ${c.conflicts.length === 1 ? 'the conflict' : `${c.conflicts.length} conflicts`} on “${s.title}”`;
}

// The base is in and pushed: a PR is watched afresh (the head moved, so a merge
// approval lapses), and work waiting on the sync re-reads the PR and starts.
export function applySynced(s, report, now) {
  (s.syncs ||= []).push({ at: now, ...(report.resolved ? { resolved: report.resolved } : {}), ...(s.conflict?.decided ? { decided: true } : {}) });
  s.conflict = null; s.note = null; s.mergeApprovedHead = null;
  if (s.stage === 'pr') { s.state = 'watching'; if (s.pr) s.pr.checkStatus = 'pending'; s.nextPollAt = now + COMMENT_SETTLE_MS; } else s.nextPollAt = 0;
}
