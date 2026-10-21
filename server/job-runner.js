import { allowFiles } from './job-files.js';
import { runnable, dependencySatisfied, dependenciesSatisfied, MERGE_IS_DELIVERY } from './job-store.js';
import { summariseComments, commentsBlockMerge } from './job-comments.js';
import { awaitsTicket, settingsSchema } from './jobs-schema.js';
import { logWarn } from './log.js';
import { isFrozen, startQueued, queuedReady, replanQueue } from './job-replan.js';
import { heldBy, needsTriage, triesOn, triesAllowed, startRed, failRedReplan } from './job-red.js';
import { advanceWrite, triggerStatus, draftsDecided, inReview, awaitsKeys } from './job-writes.js';
import { dropSub } from './job-sub-ops.js';
import { draftsDecidedMail, threadMail, ideaMail, askMail } from './job-prompts.js';
import { inConversation, unsentIdea } from './job-idea.js';
import { askFailed, replanFailed, convosOf, convoById, convoRun, unsentAsks } from './job-talk.js';
import { waitsOnReview, unsentFor } from './job-parked.js';
import { noteMain } from './job-main.js';
import { stderrLine } from './git.js';
import { budgetOf, liveCards, budgetContinueMail } from './job-budget.js';
import { holdsRunning, dueTeardown, runningOf, sameItem, stopReason, teardown, isUp, defaultDeps, stopSandbox } from './job-running.js';
export const shortError = (e) => {
  const first = String(e?.message || e).split('\n')[0], why = stderrLine(e);
  return (why && !first.includes(why) ? `${first}: ${why}` : first).slice(0, 240);
};
const BRANCH_UPDATE_BACKOFF_MS = 120000;
const MAX_BRANCH_UPDATES = 3;
// A failed post-merge run is red but still watched, more slowly: a re-run that
// passes, or a later run containing the merge that does, clears it and the
// sub-job climbs on as a green one would, with nobody pressing Retry. Read from
// the error, not the last result: a re-run in flight reads pending meanwhile.
// The watch backs off with the red's age (`redSince`) and ends after
// RED_WATCH_MS, so one nobody acts on stops costing GitHub calls; Retry clears
// the error, and the next failing poll stamps a fresh `redSince`.
const POST_MERGE_FAILED = 'Post-merge run failed';
const RED_POLL_MS = [[30 * 60000, 120000], [2 * 3600000, 300000], [Infinity, 900000]];
const RED_WATCH_MS = 6 * 3600000;
const redAge = (sub, now) => sub.error?.startsWith(POST_MERGE_FAILED) && sub.redSince ? now - sub.redSince : 0;
const redPollMs = (sub, now) => RED_POLL_MS.find(([upTo]) => redAge(sub, now) < upTo)[1];
const postMergeRed = (sub, now) => sub.stage === 'deployment' && !sub.recoveredBy && !!sub.error?.startsWith(POST_MERGE_FAILED)
  && redAge(sub, now) < RED_WATCH_MS;
export const acceptedRedLine = (sub) => `Post-merge run accepted red${sub.acceptedRed?.note ? `: ${sub.acceptedRed.note}` : ''}`;
// Which red step a planning run was sent after: counted against that step's tries.
const redStamp = (job) => job.replan?.red && !job.replan.red.human ? { red: { sub: job.replan.red.sub } } : undefined;
// A conversation's run (job-talk.js) is its own: it never stands in for the plan's.
const activeFor = (j, s) => j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null) && !r.convo);
// A worker that stopped WORKING without reporting has finished in the only sense
// this runner can observe. The grace is long because "idle" is also what a
// session looks like between a tool call and its answer, and a false error here
// costs a human a retry; a real one only ever delays the same error.
export const IDLE_RECEIPT_GRACE_MS = 10 * 60 * 1000;

// A delivered job does not finish under a conversation: finishing stops every
// planning session, so an answer being written, a question waiting for a slot or a
// plan change being drawn (which may add steps) would be cut off.
const talking = (job) => convosOf(job).some((c) => c.pending) || !!replanQueue(job).length || (!!job.replan && !job.replan.proposal)
  || job.runs.some((r) => !r.stopped && !r.report && r.phase === 'planning' && !r.subJobId);

// One process owns the store (the existing DATA_DIR instance lock). Claims are
// durable before launch; an uncertain launch is blocked on restart, never replayed.
export class JobRunner {
  constructor({ store, runtime, github, onChange = async () => {}, now = Date.now, summarise = summariseComments, statusOf = () => null, running = defaultDeps(), budget = null }) {
    Object.assign(this, { store, runtime, github, onChange, now, summarise, statusOf, running, budget });
    this.busy = false; this.allowedFiles = new Set();
    this.triaging = new Map(); this.pending = new Set();
  }
  // Every in-flight comment triage has settled (tests; the poll never waits).
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const before = this.store.data;
    try {
      allowFiles(this.runtime.host, this.store.data.jobs, this.allowedFiles);
      await this.enforceBudget();
      for (const job of this.store.data.jobs) {
        try {
          await this.sweepRunning(job.id);
          await this.tendMain(job.id);
          await this.settle(job.id);
          await this.advance(job.id);
        } catch (e) { this.store.update(job.id, (j) => { j.error = shortError(e); }); }
      }
    } finally { this.busy = false; if (before !== this.store.data) await this.onChange(); }
  }
  // The human's buttons on a "Local main not updated" notice (job-main.js): Retry
  // runs the update again; a resolution spawns its session here, in the tick, so
  // no launch's pendingLaunch is in flight; and a notice whose session has brought
  // the branch level with origin clears itself. Runs on a finished or paused job
  // too: it touches only the human's checkout.
  async tendMain(id) {
    const same = (j, path) => j.mainNotices?.find((n) => n.path === path);
    for (const notice of this.store.get(id).mainNotices || []) {
      if (notice.retrying) {
        const result = await this.runtime.retryMain(notice);
        this.store.update(id, (j) => { if (same(j, notice.path)?.retrying) noteMain(j, notice.path, null, result, this.now()); });
      } else if (notice.resolving && !notice.resolving.sessionId) {
        if (this.store.get(id).budgetPaused) continue;
        let sessionId = null, error = null;
        try { sessionId = await this.runtime.resolveMain(this.store.get(id), notice, notice.resolving.id); } catch (e) { error = shortError(e); }
        this.store.update(id, (j) => {
          const n = same(j, notice.path);
          if (n?.resolving && !n.resolving.sessionId) n.resolving = error ? null : { ...n.resolving, sessionId };
          if (n && error) n.resolveError = error;
        });
      } else if (notice.resolving && await this.runtime.mainCaughtUp(notice)) {
        this.store.update(id, (j) => { if (same(j, notice.path)?.resolving) noteMain(j, notice.path, null, { ok: true }, this.now()); });
      }
    }
  }
  // What an agent left running for the human to try (job-running.js). A preview
  // is probed while its review is open, written only when up/down flips (the
  // graph rebuild reads the file). Whatever is due is torn down FIRST each tick,
  // before cleanup removes the worktree its stop commands run in, and also at
  // boot: a sub-job no longer in review owns nothing that should still answer.
  // Teardown never fails the step it follows; a leftover is flagged on the card.
  async sweepRunning(id) {
    for (const initial of this.store.get(id).subJobs) {
      const job = this.store.get(id);
      const sub = job.subJobs.find((s) => s.id === initial.id);
      if (!sub?.running) continue;
      const due = dueTeardown(job, sub);
      if (due.length) {
        let outcome;
        try { outcome = await teardown(due, { cwd: sub.worktree?.path, sandbox: stopSandbox(job, sub), deps: this.running }); } catch (e) { outcome = { results: due.map((i) => ({ name: i.name, ok: false, detail: shortError(e) })), still: due.map((i) => i.name) }; }
        const reason = stopReason(job, sub);
        this.patchSub(id, sub.id, (s) => {
          const gone = (list) => (list || []).filter((i) => !due.some((d) => sameItem(i, d)));
          s.running = { ...s.running, items: gone(s.running.items), owed: gone(s.running.owed), stopped: { at: this.now(), reason, results: outcome.results, still: outcome.still } };
        });
      }
      const now = this.store.get(id);
      const kept = now.subJobs.find((s) => s.id === sub.id);
      if (!holdsRunning(now, kept)) continue;
      const items = runningOf(kept);
      const ups = await Promise.all(items.map((i) => isUp(i, this.running)));
      if (ups.some((up, n) => up !== items[n].up)) {
        this.patchSub(id, sub.id, (s) => { for (const [n, i] of items.entries()) { const hit = s.running.items.find((x) => sameItem(x, i)); if (hit) hit.up = ups[n]; } });
      }
    }
  }
  patchSub(jobId, subId, fn) { return this.store.update(jobId, (j) => fn(j.subJobs.find((s) => s.id === subId), j)); }
  allowed(id) { const d = this.store.data, job = d.jobs.find((j) => j.id === id); return !d.settings.paused && !job?.paused && !job?.budgetPaused; }
  // The spend limit (job-budget.js), first each tick so nothing below launches,
  // mails or triages for a job that has reached it. Over: paused for budget, and
  // every working session of it interrupted (the enforcer's cooldown keeps it to
  // one Escape per card per window, again each window while it is still over).
  // Under again (a top-up, or a new X): released, and each session it interrupted
  // is mailed to carry on. A failed mail is tried again next tick.
  async enforceBudget() {
    if (!this.budget) return;
    const byCard = this.budget.spend(this.store.data.jobs);
    for (const { id } of this.store.data.jobs) {
      try {
        const job = this.store.get(id);
        const verdict = budgetOf(this.store.data.settings, job, byCard);
        if (!verdict) continue;
        if (verdict.over) {
          if (!job.budgetPaused) this.store.budgetPause(id, verdict);
          const halted = await this.budget.interrupt(liveCards(job));
          for (const run of job.runs.filter((r) => halted.includes(r.sessionId) && !r.budgetHaltedAt)) this.patchRun(id, run.id, (r) => { r.budgetHaltedAt = this.now(); });
          continue;
        }
        if (job.budgetPaused) this.store.budgetRelease(id, verdict);
        for (const run of job.runs.filter((r) => runnable(r) && r.budgetHaltedAt && r.sessionId)) {
          await this.runtime.resumeWithMail(run, budgetContinueMail(job, verdict.limit));
          this.patchRun(id, run.id, (r) => { r.budgetHaltedAt = null; r.idleSince = null; });
        }
      } catch (e) { logWarn('[jobs] spend limit', id, shortError(e)); }
    }
  }
  // No clock runs against a session: a long step is legitimate work, and a
  // needs-you one is surfaced on the board rather than killed. What ends a run
  // is its receipt, its process, or having stopped working without either.
  async settle(id) {
    for (const run of this.store.get(id).runs.filter(runnable)) {
      let error;
      const job = this.store.get(id);
      // A cancelled job stops its planning run the way a dropped sub-job stops
      // its step: quietly, no missing-receipt error. So does a re-planning run
      // whose plan change the human discarded, and a batched writer run from
      // before session-owned writes (job-store.js failed its writes on load).
      // A session parked on its ready receipt (job-parked.js) ends quietly too once
      // the review has moved on (approved, reworked, retried) or its card is gone:
      // the human can still approve the tree without it.
      const cancelled = job.cancelledAt || (run.subJobId && job.subJobs.find((s) => s.id === run.subJobId)?.cancelledAt)
        // An ask run (job-talk.js) is the same once its conversation has nothing pending.
        || (run.phase === 'planning' && job.stage === 'active' && (run.ask ? !convoById(job, run.convo)?.pending : !job.replan)) || run.phase === 'write'
        || (run.parkedFor === 'ready' && !run.report && (!waitsOnReview(job, run) || !(await this.runtime.exists(run))))
        // A new idea's planner is done talking once the idea is planned (its suggestion accepted).
        || (run.parkedFor === 'idea' && !run.report && !inConversation(job));
      if (!run.report && !cancelled) {
        if (!run.sessionId) error = 'Launch was interrupted. Check for an existing session/worktree before retrying.';
        // Parked on its drafts, a session sits idle (or goes dormant) by design
        // until the human decides them and it is mailed: only its card going
        // away ends it.
        else if (run.parkedAt && !run.mailedAt) {
          if (await this.runtime.exists(run)) continue;
          error = run.parkedFor === 'idea' ? 'Wrangler\'s session was closed while it waited for your reply. Retry to plan again.' : 'Session was closed while its drafts waited for review. Retry to run it again.';
        }
        else if (!(await this.runtime.isAlive(run))) error = 'Session stopped without a receipt. Open it to see why, then retry.';
        // Stopped at the spend limit, a session sits idle by design until a top-up.
        else if (job.budgetPaused) { if (run.idleSince) this.patchRun(id, run.id, (r) => { r.idleSince = null; }); continue; }
        else {
          await this.answerDialogs(run);
          const idleSince = this.statusOf(run.sessionId) === 'idle' ? (run.idleSince ?? this.now()) : null;
          // Written only on the edge: the graph rebuild reads this file, so a
          // per-tick rewrite would broadcast a whole snapshot every few seconds.
          if (idleSince !== (run.idleSince ?? null)) this.patchRun(id, run.id, (r) => { r.idleSince = idleSince; });
          if (!idleSince || this.now() - idleSince <= IDLE_RECEIPT_GRACE_MS) continue;
          error = 'Session finished without a receipt. Open it to see why, then retry.';
        }
      }
      // A receipt can arrive while the process probe is awaiting tmux. Honour
      // that durable report even if the worker has already exited afterwards.
      if (error && this.store.get(id).runs.find((r) => r.id === run.id)?.report) error = undefined;
      try {
        await this.runtime.stop(run);
        this.store.update(id, (j) => {
          const r = j.runs.find((r) => r.id === run.id);
          r.stopped = true; r.stoppedAt = this.now();
          const s = j.subJobs.find((s) => s.id === r.subJobId);
          if (s?.answering) s.answering = null;
          // On the run as well as the card: retry clears the card's, and the
          // history a later session reads (job-prompts.js) needs the run's.
          // A red step's planner that died is that step's to declare, not the job's:
          // `job.error` would hold every sub-job for one step's trouble.
          // An unanswered question, or a plan change never drawn, is said in its
          // conversation; the job never stops for it.
          if (error && r.ask) { r.error = error; askFailed(j, r, error.replace(/\. .*$/, ''), this.now()); }
          else if (error && !failRedReplan(j, r, error.replace(/\. .*$/, ''), this.now()) && !replanFailed(j, r, error.replace(/\. .*$/, ''), this.now())) { r.error = error; (s || j).error = error; }
          else if (error) r.error = error;
        });
      } catch (e) {
        this.store.update(id, (j) => { j.error = shortError(e); });
      }
    }
  }
  patchRun(jobId, runId, fn) { return this.store.update(jobId, (j) => fn(j.runs.find((r) => r.id === runId))); }
  // A live, unreported worker may be parked on Claude's trust dialog rather than
  // working (job-runtime.js acceptTrustDialog). Best-effort: a tmux hiccup here
  // must not fail a run that is otherwise fine, so the error is logged, not raised.
  async answerDialogs(run) {
    try { await this.runtime.acceptTrustDialog?.(run); } catch (e) { logWarn('[jobs] trust dialog', run.sessionId, shortError(e)); }
  }
  // Classify the current comment set once per fingerprint, off the poll: a
  // Haiku call takes seconds and the tick must not stall other jobs on it. The
  // verdict lands only if the comments it read are still the current ones;
  // otherwise the next poll re-triages against the newer set.
  // update-branch merges the base into the PR head, so the PR's own diff is what
  // the human approved: an approval (or accepted red) pinned to the head we
  // updated moves to the head the update produced. Any other head change was not
  // ours, and leaves the approval to lapse as it always did.
  carryApproval(s, pr) {
    const bu = s.branchUpdate;
    if (!bu?.updated || bu.carried || !pr.head || pr.head === bu.from) return;
    if (s.mergeApprovedHead === bu.from) s.mergeApprovedHead = pr.head;
    if (s.acceptedRed?.ref === bu.from) s.acceptedRed = { ...s.acceptedRed, ref: pr.head };
    s.branchUpdate = { ...bu, carried: true, to: pr.head }; s.mergeRequestedHead = null;
  }
  async updateBranch(id, sub, pr) {
    const prior = sub.branchUpdate?.from === pr.head ? sub.branchUpdate : null;
    // GitHub takes a moment to move the head and the PR may report BEHIND until
    // it has; one attempt per head per interval, and a bounded number of them.
    if (prior && this.now() - prior.at < BRANCH_UPDATE_BACKOFF_MS) return;
    const attempts = (prior?.attempts || 0) + 1;
    if (attempts > MAX_BRANCH_UPDATES) { this.patchSub(id, sub.id, (s) => { s.error = 'Branch is still behind its base after repeated updates. Update it by hand, then retry.'; }); return; }
    const record = { from: pr.head, at: this.now(), attempts };
    try {
      await this.github.updateBranch(sub);
      this.patchSub(id, sub.id, (s) => { s.branchUpdate = { ...record, updated: true }; });
    } catch (e) {
      const message = String(e.stderr || e.message || e).trim().slice(0, 500);
      const conflict = /conflict/i.test(message);
      this.patchSub(id, sub.id, (s) => { s.branchUpdate = { ...record, error: message, ...(conflict ? { failedHead: pr.head } : {}) }; s.note = `Updating the branch failed: ${message}`; });
    }
  }
  triage(id, subId) {
    const sub = this.store.get(id)?.subJobs.find((s) => s.id === subId);
    const comments = sub?.prComments;
    if (!comments?.items.length) {
      if (sub?.commentSummary) this.patchSub(id, subId, (s) => { s.commentSummary = null; });
      return;
    }
    const key = `${id}/${subId}`;
    if (sub.commentSummary?.fingerprint === comments.fingerprint || this.triaging.get(key)?.fingerprint === comments.fingerprint) return;
    const done = this.summarise(comments, sub.pr)
      .catch((e) => ({ tone: 'amber', text: `Summary unavailable (${shortError(e)}). Read the comments yourself before merging.`, error: true }))
      .then(async ({ tone, text, error, liveSessionId }) => {
        if (this.triaging.get(key)?.fingerprint === comments.fingerprint) this.triaging.delete(key);
        const current = this.store.get(id)?.subJobs.find((s) => s.id === subId);
        if (!current) return;
        if (liveSessionId) this.runtime.attributeSpend(current, liveSessionId);
        if (current.prComments?.fingerprint !== comments.fingerprint) return;
        this.patchSub(id, subId, (s) => { s.commentSummary = { fingerprint: comments.fingerprint, tone, text, error: !!error, at: this.now() }; });
        await this.onChange();
      }).catch((e) => console.error('[jobs] comment triage', e)).finally(() => this.pending.delete(done));
    this.triaging.set(key, { fingerprint: comments.fingerprint }); this.pending.add(done);
  }
  async launch(job, sub, phase, extra) {
    // A plan change waiting on the human freezes only the sub-jobs it would
    // edit, cancel or act on (job-red.js heldBy): no new step, no merge, no human
    // approval (job-store.js). Everything else carries on, steps already running
    // finish, and work past the point of no return lands as it would have.
    if (sub && heldBy(this.store.get(job.id), sub) && !isFrozen(sub)) return;
    const run = this.store.claim(job.id, sub?.id || null, phase, extra);
    if (!run) return;
    try {
      await this.runtime.launch(job, sub, run, (sessionId, wt) => this.store.bindRun(job.id, run.id, sessionId, wt));
    } catch (e) {
      const latest = this.store.get(job.id).runs.find((r) => r.id === run.id);
      // Even a launch error may have created a process. Stop before releasing.
      await this.runtime.stop(latest);
      this.store.update(job.id, (j) => {
        const r = j.runs.find((r) => r.id === run.id);
        r.stopped = true;
        if (r.ask) askFailed(j, r, shortError(e), this.now());
        else (j.subJobs.find((s) => s.id === sub?.id) || j).error = shortError(e);
      });
    }
  }
  async advance(id) {
    let job = this.store.get(id);
    if (!this.allowed(id) || job.stage === 'done') return;
    // A question holds nothing, not even a job an error has stopped.
    if (job.error) { if (job.stage === 'active' && !job.cancelledAt) await this.converse(id); return; }
    // Cancelled before it had sub-jobs: nothing to clean up per sub-job, so the
    // job finishes as soon as settle() has stopped its planning run. An active
    // one takes the ordinary road below — every sub-job is already in cleanup.
    if (job.cancelledAt && job.stage !== 'active') { if (!job.runs.some(runnable)) await this.finish(id); return; }
    if (job.stage === 'planning' && !job.plan && !activeFor(job)) { await this.launch(job, null, 'planning'); return; }
    if (inConversation(job)) {
      // Parked or still mid-turn: a message written while the planner works is
      // mailed now, or a plan reported before its next reply would never see it.
      const run = job.runs.find((r) => runnable(r) && r.phase === 'planning' && !r.subJobId && r.sessionId);
      if (run && unsentIdea(job).length) await this.deliverIdea(id, run);
      return;
    }
    if (job.stage !== 'active') return;
    // A change queued behind one that ended some other way (answered, declared red,
    // failed), or behind a discarded planner that has now stopped, takes its turn.
    if (queuedReady(job)) { this.store.update(id, (j) => startQueued(j, this.now())); job = this.store.get(id); }
    if (!job.replan) await this.triageRed(id);
    job = this.store.get(id);
    if (job.replan && !job.replan.proposal && !activeFor(job)) {
      await this.launch(job, null, 'planning', redStamp(job));
      job = this.store.get(id);
    }
    await this.converse(id);
    for (const initial of job.subJobs) {
      job = this.store.get(id);
      if (!this.allowed(id) || job.error) return;
      let sub = job.subJobs.find((s) => s.id === initial.id);
      if (activeFor(job, sub)) continue;
      if (sub.error && !postMergeRed(sub, this.now())) continue;
      try {
        if (sub.stage === 'session') {
          // A session starts once its milestone (`on`) and its prerequisites
          // have come, and every story its writes name has a key. One whose
          // drafts are still with the human is not run again until they are
          // decided. An if-dropped one whose trigger landed is not needed.
          const trigger = triggerStatus(job, sub);
          if (trigger === 'not-needed' && !heldBy(job, sub)) this.patchSub(id, sub.id, (s) => { dropSub(s, this.now()); s.notNeeded = true; });
          else if (trigger === 'due' && dependenciesSatisfied(job, sub) && !awaitsKeys(job, sub) && !inReview(job, sub).length) await this.launch(job, sub, 'session');
        } else if (sub.stage === 'human') {
          // The one stage this runner never launches anything for. A human task
          // moves only when the human marks it (job-store.js start-human /
          // finish-human), which is also why no clock or dependency gate applies:
          // the board shows it, and passing it by is the whole behaviour.
        } else if (sub.stage === 'write') {
          // A write never launches on its own: its session makes it and reports
          // it. Here it only follows that session out (dropped with it, failed
          // if it finished without reporting it). A pending plan change may still
          // edit or drop it, so it waits.
          // Tried on this tick's copy first: an idle tick must not rewrite the file.
          if (!heldBy(job, sub) && advanceWrite(job, sub, this.now())) this.store.update(id, (j) => advanceWrite(j, j.subJobs.find((s) => s.id === sub.id), this.now()));
        } else if (sub.stage === 'implementation') {
          // One session per PR: work, commit, push, open the PR. Every
          // prerequisite gates the start: the worktree is cut from the default
          // branch at launch, so a PR prerequisite must have deployed for its
          // code to be in the base.
          if (!awaitsTicket(sub) && dependenciesSatisfied(job, sub)) await this.launch(job, sub, 'implementation');
        } else if (sub.stage === 'review') {
          // The human's approval of the uncommitted working tree is what starts
          // the session that commits, pushes and opens the PR; until then the
          // card just sits here, using no agent.
          if (sub.state === 'approved') await this.launch(job, sub, 'publish');
        } else if (sub.stage === 'pr') {
          if (sub.nextPollAt > this.now()) continue;
          let pr = await this.github.pr(sub);
          // A failed update-branch (conflicts) on this head reads as DIRTY, so the
          // repair path that already handles conflicts takes it from here.
          const redBehind = sub.acceptedRed?.ref === pr.head && pr.state === 'OPEN' && pr.mergeState === 'BEHIND' && !pr.dirty;
          if ((pr.behind || redBehind) && sub.branchUpdate?.failedHead === pr.head) pr = { ...pr, behind: false, dirty: true, checkStatus: 'failing' };
          const comments = await this.github.comments(sub);
          // Whether this diff deploys is a property of the head, so it is read
          // once per head and again after every repair push.
          const deploys = !sub.deploys || sub.deploys.head !== pr.head ? await this.github.deploys(sub, pr) : sub.deploys;
          this.patchSub(id, sub.id, (s) => { s.pr = pr; this.carryApproval(s, pr); s.prComments = comments; s.deploys = deploys; s.observationError = null; s.nextPollAt = this.now() + 30000; });
          this.triage(id, sub.id);
          if (!this.allowed(id)) continue;
          job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id);
          if (pr.state === 'MERGED') {
            // Nothing runs on push for these paths, so the merge IS the
            // delivery: mark it deployed to release dependants, without waiting
            // for a workflow run that can never appear.
            this.patchSub(id, sub.id, (s) => {
              s.mergedAt = this.now();
              if (!s.deploys?.expected) { s.deployed = { at: this.now(), checks: [MERGE_IS_DELIVERY], commit: pr.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; }
              else { s.stage = 'deployment'; s.state = 'watching'; s.nextPollAt = 0; }
            });
          } else if (pr.state === 'CLOSED') {
            this.patchSub(id, sub.id, (s) => { s.error = 'PR was closed without merging'; });
          } else if (sub.catchUp) {
            // A plan change moved this PR behind new work (job-replan.js): no
            // repair or merge until that lands, then its branch takes it from the
            // base and the checks run again.
            if (dependenciesSatisfied(job, sub)) {
              await this.updateBranch(id, sub, pr);
              this.patchSub(id, sub.id, (s) => { s.catchUp = null; });
            }
          } else if (sub.fixRequested) {
            // The human saw something the checks do not cover; the repair runs
            // whatever colour they are. A plan change can ask for one ahead of
            // the prerequisites the new brief builds on; it waits for them.
            if (dependenciesSatisfied(job, sub)) await this.launch(job, sub, 'repair');
          } else if (pr.checkStatus === 'failing' && sub.acceptedRed?.ref !== pr.head) {
            const attempts = job.runs.filter((r) => r.subJobId === sub.id && r.phase === 'repair').length;
            const limit = this.store.data.settings.maxRepairs + (sub.repairAllowance || 0);
            if (attempts >= limit) this.patchSub(id, sub.id, (s) => { s.error = 'Automatic repair limit reached. Review changes, then retry if needed.'; });
            else await this.launch(job, sub, 'repair');
          } else if (pr.behind && sub.acceptedRed?.ref !== pr.head || redBehind) {
            // Green but behind a base that requires up-to-date branches: bring it
            // up to date and keep watching, since the new head re-runs the checks.
            // An accepted-red head is behind too (`behind` excludes red ones); an
            // --admin merge cannot be relied on for it, so it is updated and
            // carryApproval moves the acceptance to the new head.
            if (!heldBy(job, sub) && dependenciesSatisfied(job, sub)) await this.updateBranch(id, sub, pr);
          } else if (!heldBy(job, sub) && (pr.checkStatus === 'passing' || sub.acceptedRed?.ref === pr.head) && dependenciesSatisfied(job, sub) && (sub.mergeApprovedHead === pr.head || (!job.reviewMerge && !commentsBlockMerge(sub)))) {
            // An accepted-red head merges whatever its checks say — the move
            // pinned both the acceptance and the merge approval to this head.
            // Match-head on GitHub closes the push-vs-merge race; re-poll after
            // success instead of pretending an accepted merge-queue entry merged.
            if (sub.mergeRequestedHead !== pr.head) {
              await this.github.merge(sub, { canMerge: () => this.allowed(id) && !heldBy(this.store.get(id), sub) });
              this.patchSub(id, sub.id, (s) => { s.mergeRequestedHead = pr.head; });
            }
          }
        } else if (sub.stage === 'deployment' && sub.recoveredBy) {
          // Split out from a merged sub-job: it counts as deployed the moment
          // its fix does, and goes to cleanup exactly as a watched one would.
          const fix = job.subJobs.find((s) => s.id === sub.recoveredBy);
          if (fix?.cancelledAt) this.patchSub(id, sub.id, (s) => { s.error = `The fix sub-job (${fix.title}) was cancelled`; });
          else if (dependencySatisfied(fix)) this.patchSub(id, sub.id, (s) => { s.deployed = { at: this.now(), checks: [`Fixed by ${fix.title}`], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; });
        } else if (sub.stage === 'deployment') {
          if (sub.nextPollAt > this.now()) continue;
          const result = await this.github.deployment(sub);
          const staleMs = this.store.data.settings.deploymentStaleMinutes * 60000;
          this.patchSub(id, sub.id, (s) => {
            s.deploymentResult = result; s.observationError = null; s.nextPollAt = this.now() + (result.status === 'failing' || s.error ? redPollMs(s, this.now()) : 30000);
            // NOTHING running this long after the merge means the workflows said
            // this push deploys and GitHub disagrees — nothing triggered, or
            // everything that did was skipped, or a cancelled run that no later
            // run containing the merge has replaced. Silence can never be read as
            // success (it is indistinguishable from a run not yet queued), so it
            // goes to the human rather than completing the sub-job. A run in
            // progress is just a slow deploy and is never stale. Pre-existing
            // sub-jobs have no mergedAt; count from their first observation.
            s.mergedAt ??= this.now();
            const silent = result.status === 'pending' && !result.runs.some((r) => r.status === 'pending');
            const cancelled = result.runs.filter((r) => r.status === 'cancelled').map((r) => r.workflow);
            s.deploymentStale = silent && this.now() - s.mergedAt > staleMs
              ? { since: s.mergedAt, ...(cancelled.length ? { cancelled } : {}) } : null;
          });
          if (!this.allowed(id)) continue;
          job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id);
          // The ladder ends here unless the plan named a check no pipeline can
          // perform; that one line is the only thing a verify session exists for.
          // A red run the human accepted (job-sub-ops.js) climbs the same rungs as
          // a green one, the plan's own check included; only the receipt line
          // says which colour it was.
          const accepted = result.status === 'failing' && !!sub.acceptedRed && sub.acceptedRed.ref === sub.pr?.mergeCommit;
          if (result.status === 'passing' || accepted) {
            if (sub.error) { this.patchSub(id, sub.id, (s) => { s.error = null; s.blocked = null; s.redSince = null; }); job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id); }
            if (sub.check) await this.launch(job, sub, 'verify');
            else this.patchSub(id, sub.id, (s) => { s.deployed = { at: this.now(), checks: [accepted ? acceptedRedLine(s) : 'Post-merge runs passed'], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; });
          } else if (result.status === 'failing') {
            const failed = result.runs.filter((r) => r.status === 'failing').map((r) => r.workflow).join(', ');
            this.patchSub(id, sub.id, (s) => {
              if (!s.error?.startsWith(POST_MERGE_FAILED) || !s.redSince) s.redSince = this.now();
              s.error = `${POST_MERGE_FAILED}: ${failed || 'unknown workflow'}`;
            });
          }
        } else if (sub.stage === 'cleanup') {
          const { main } = (await this.runtime.cleanup(job, sub, { updateMain: settingsSchema.parse(this.store.data.settings ?? {}).updateMain })) || {};
          this.patchSub(id, sub.id, (s, j) => { if (main) noteMain(j, main.path, s.id, main.result, this.now()); s.stage = 'done'; s.state = s.cancelledAt ? 'cancelled' : 'done'; s.cleanupRefusal = null; s.discard = null; });
        }
      } catch (e) {
        this.patchSub(id, sub.id, (s) => {
          // A refusal keeps what would be lost for the board; a Discard is spent
          // either way, so a changed tree has to be looked at and chosen again.
          if (s.stage === 'cleanup') { s.error = shortError(e); s.cleanupRefusal = e.refusal || null; s.discard = null; }
          else if (e.needsAdmin) s.error = shortError(e);
          else { s.observationError = shortError(e); s.nextPollAt = this.now() + 60000; }
        });
      }
    }
    job = this.store.get(id);
    for (const run of job.runs.filter((r) => draftsDecided(job, r))) await this.resumeDrafted(id, run);
    for (const run of job.runs.filter((r) => runnable(r) && r.parkedFor === 'ready')) {
      const sub = job.subJobs.find((s) => s.id === run.subJobId);
      // One message at a time, and only to a session waiting: one queued while it
      // answers goes once that reply is in, so each reply answers one message.
      if (!run.mailedAt && unsentFor(sub).length) await this.deliverThread(id, run);
    }
    job = this.store.get(id);
    if (job.subJobs.length && job.subJobs.every((s) => s.stage === 'done') && (job.cancelledAt || !talking(job))) await this.finish(id);
  }
  // A question for the wrangler (job-talk.js): one planning run per conversation,
  // holding nothing, and what the human says before it replies is mailed to it.
  async converse(id) {
    let job = this.store.get(id);
    for (const convo of convosOf(job)) {
      if (!convo.pending) continue;
      const run = convoRun(job, convo);
      if (!run) await this.launch(job, null, 'planning', { convo: convo.id, ask: convo.pending.asks[0].messageId });
      else if (run.sessionId && !run.report && unsentAsks(convo).length) await this.deliverAsks(id, run);
      job = this.store.get(id);
    }
  }
  // A red step goes up one level before it goes to the human: the planner looks
  // at it (job-red.js), holding only that step and what follows it. One replan at
  // a time, so a second red step waits its turn. Out of tries it is declared red
  // to the human with every attempt listed. `maxReplans` 0 leaves red to the human.
  async triageRed(id) {
    const job = this.store.get(id);
    // Parsed, so a settings file from before `maxReplans` reads the default, not 0.
    const settings = settingsSchema.parse(this.store.data.settings ?? {});
    if (job.replan || job.stage !== 'active' || job.cancelledAt || !settings.maxReplans || !this.allowed(id) || job.runs.some((r) => !r.stopped && !r.subJobId && !r.ask)) return;
    const sub = job.subJobs.find((s) => needsTriage(job, s));
    if (!sub) return;
    const tries = triesOn(job, sub.id), limit = triesAllowed(settings, sub);
    if (tries >= limit) {
      this.store.declareOutOfTries(id, sub.id, limit);
      return;
    }
    this.store.update(id, (j) => startRed(j, j.subJobs.find((x) => x.id === sub.id), { tries, limit, now: this.now() }));
  }
  // Every draft a parked session sent is decided: tell it which writes to make
  // and with what text, waking its card first if it went dormant meanwhile. A
  // failed send is tried again next tick, and says so on the card.
  async resumeDrafted(id, run) {
    try {
      await this.runtime.resumeWithMail(run, draftsDecidedMail(this.store.get(id), run));
      this.patchRun(id, run.id, (r) => { r.mailedAt = this.now(); r.idleSince = null; });
      this.patchSub(id, run.subJobId, (s) => { s.observationError = null; });
    } catch (e) {
      const note = `Could not resume the session with the decided drafts: ${shortError(e)}`;
      if (this.store.get(id).subJobs.find((s) => s.id === run.subJobId)?.observationError !== note) this.patchSub(id, run.subJobId, (s) => { s.observationError = note; });
    }
  }
  // The human wrote to the session parked on its ready receipt: mail it, waking
  // its card first if it went dormant. Sent messages are marked so a failed send
  // is tried again next tick; the run is the agent's to work on again from here.
  async deliverThread(id, run) {
    const job = this.store.get(id);
    const sub = job.subJobs.find((s) => s.id === run.subJobId);
    const batch = unsentFor(sub).slice(0, 1);
    try {
      await this.runtime.resumeWithMail(run, threadMail(job, run, sub, batch));
      const now = this.now();
      this.patchRun(id, run.id, (r) => { r.mailedAt = now; r.idleSince = null; });
      this.patchSub(id, sub.id, (s) => { for (const m of s.thread) if (batch.some((b) => b.id === m.id)) m.sentAt = now; s.observationError = null; });
    } catch (e) {
      const note = `Could not send your message to the session: ${shortError(e)}`;
      if (sub.observationError !== note) this.patchSub(id, sub.id, (s) => { s.observationError = note; });
    }
  }
  // The human wrote again before this conversation's wrangler replied: the same
  // session reads it, so the answer it is writing covers both. A failed send is
  // tried again next tick; the asks stay unsent until one lands.
  async deliverAsks(id, run) {
    const job = this.store.get(id);
    const batch = unsentAsks(convoById(job, run.convo));
    try {
      await this.runtime.resumeWithMail(run, askMail(job, run, batch));
      const now = this.now();
      this.store.update(id, (j) => { for (const a of convoById(j, run.convo)?.pending?.asks || []) if (batch.some((b) => b.messageId === a.messageId)) a.sentAt = now; });
    } catch (e) { logWarn('[jobs] ask mail', run.sessionId, shortError(e)); }
  }
  // The human answered a new idea's planner (job-idea.js): mail it, waking its card
  // first if it went dormant. A failed send is tried again next tick.
  async deliverIdea(id, run) {
    const job = this.store.get(id);
    const batch = unsentIdea(job);
    try {
      await this.runtime.resumeWithMail(run, ideaMail(job, run, batch, { busy: !(run.parkedAt && !run.mailedAt) }));
      const now = this.now();
      this.patchRun(id, run.id, (r) => { r.mailedAt = now; r.idleSince = null; });
      this.store.update(id, (j) => { for (const m of j.idea.thread) if (batch.some((b) => b.id === m.id)) m.sentAt = now; j.idea.error = null; });
    } catch (e) {
      const note = `Could not send your reply to Wrangler: ${shortError(e)}`;
      if (job.idea.error !== note) this.store.update(id, (j) => { j.idea.error = note; });
    }
  }
  // Delivered or cancelled, the job ends the same way: planning sessions and
  // worktrees go, then `done`. `cancelledAt` is what tells the two apart.
  async finish(id) {
    try {
      const job = this.store.get(id);
      await this.runtime.cleanupPlanning(job);
      // A job made from an idea's suggestion shares the idea's pictures (JobStore.acceptIdea).
      const held = new Set(this.store.snapshot().jobs.filter((o) => o.id !== id && o.stage !== 'done').flatMap((o) => o.images || []));
      this.runtime.releaseImages({ ...job, images: (job.images || []).filter((n) => !held.has(n)) });
      this.store.update(id, (j) => { j.stage = 'done'; j.completedAt = this.now(); });
    } catch (e) { this.store.update(id, (j) => { j.error = shortError(e); }); }
  }
}
