import fs from 'node:fs';
import crypto from 'node:crypto';
import { isPrSub, isHumanSub } from './jobs-schema.js';
import { upstreamOf } from './job-prompts.js';
import { heldBy } from './job-red.js';
import { expandRepo } from './job-runtime.js';

// Ask an agent: the human's own session about one step, never a step itself. Its
// ids live in `sub.helpers`, not `sub.sessions` (cleanup archives those, and Open
// session and Review code read the last one) nor `job.runs` (runForSession would
// hand it job_report, the worker skill and the job's sandbox). Queued here, spawned
// by the runner's tick (tendHelpers) so no launch's pendingLaunch is in flight.
export const pendingHelper = (sub) => (sub?.helpers || []).find((h) => !h.sessionId && !h.error) || null;

export function queueHelper(job, sub, now) {
  if (pendingHelper(sub)) throw new Error('An agent is already starting for this step');
  (sub.helpers ||= []).push({ id: `hp_${crypto.randomBytes(6).toString('hex')}`, at: now, sessionId: null });
  // A human task someone is now working on with an agent is in progress, as
  // Mark in progress would make it; a pending plan change holds that mark.
  const started = isHumanSub(sub) && sub.stage === 'human' && sub.state !== 'doing' && !(job.replan && heldBy(job, sub));
  if (started) sub.state = 'doing';
  return { started };
}

// The step a helper session was opened from, by its session id: the one caller
// send_step_idea answers to (tools.js).
export function helperFor(store, sessionId) {
  if (!sessionId) return null;
  for (const job of store.data.jobs) for (const sub of job.subJobs) {
    const helper = sub.helpers?.find((h) => h.sessionId === sessionId);
    if (helper) return { job, sub, helper };
  }
  return null;
}

const isDir = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
// The step's own checkout, else a prerequisite PR's, else '' (the wrangler's
// fresh scratch workspace). Never a worktree: a live worker may be writing there.
export function helperCwd(job, sub) {
  const repos = [sub, ...upstreamOf(job, sub).filter(isPrSub)].filter((s) => isPrSub(s) && s.repo).map((s) => expandRepo(s.repo));
  return repos.find(isDir) || '';
}
