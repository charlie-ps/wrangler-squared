import { runnable, dependencySatisfied, dependenciesSatisfied, MERGE_IS_DELIVERY } from './job-store.js';
import { summariseComments, commentsBlockMerge } from './job-comments.js';
import { awaitsTicket } from './jobs-schema.js';
import { logWarn } from './log.js';
import { isFrozen } from './job-replan.js';
import { advanceWrite, triggerStatus, draftsDecided, inReview, awaitsKeys } from './job-writes.js';
import { dropSub } from './job-moves.js';
import { draftsDecidedMail } from './job-prompts.js';
const shortError = (e) => String(e?.message || e).split('\n')[0].slice(0, 240);
const BRANCH_UPDATE_BACKOFF_MS = 120000;
const MAX_BRANCH_UPDATES = 3;
export const acceptedRedLine = (sub) => `Post-merge run accepted red${sub.acceptedRed?.note ? `: ${sub.acceptedRed.note}` : ''}`;
const activeFor = (j, s) => j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null));
// A worker that stopped WORKING without reporting has finished in the only sense
// this runner can observe. The grace is long because "idle" is also what a
// session looks like between a tool call and its answer, and a false error here
// costs a human a retry; a real one only ever delays the same error.
export const IDLE_RECEIPT_GRACE_MS = 10 * 60 * 1000;

// One process owns the store (the existing DATA_DIR instance lock). Claims are
// durable before launch; an uncertain launch is blocked on restart, never replayed.
export class JobRunner {
  constructor({ store, runtime, github, onChange = async () => {}, now = Date.now, summarise = summariseComments, statusOf = () => null }) {
    Object.assign(this, { store, runtime, github, onChange, now, summarise, statusOf });
    this.busy = false;
    this.triaging = new Map(); this.pending = new Set();
  }
  // Every in-flight comment triage has settled (tests; the poll never waits).
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const before = this.store.data;
    try {
      for (const job of this.store.snapshot().jobs) {
        try {
          await this.settle(job.id);
          await this.advance(job.id);
        } catch (e) { this.store.update(job.id, (j) => { j.error = shortError(e); }); }
      }
    } finally { this.busy = false; if (before !== this.store.data) await this.onChange(); }
  }
  patchSub(jobId, subId, fn) { return this.store.update(jobId, (j) => fn(j.subJobs.find((s) => s.id === subId), j)); }
  allowed(id) { const d = this.store.snapshot(); return !d.settings.paused && !d.jobs.find((j) => j.id === id)?.paused; }
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
      const cancelled = job.cancelledAt || (run.subJobId && job.subJobs.find((s) => s.id === run.subJobId)?.cancelledAt)
        || (run.phase === 'planning' && job.stage === 'active' && !job.replan) || run.phase === 'write';
      if (!run.report && !cancelled) {
        if (!run.sessionId) error = 'Launch was interrupted. Check for an existing session/worktree before retrying.';
        // Parked on its drafts, a session sits idle (or goes dormant) by design
        // until the human decides them and it is mailed: only its card going
        // away ends it.
        else if (run.parkedAt && !run.mailedAt) {
          if (await this.runtime.exists(run)) continue;
          error = 'Session was closed while its drafts waited for review. Retry to run it again.';
        }
        else if (!(await this.runtime.isAlive(run))) error = 'Session stopped without a receipt. Open it to see why, then retry.';
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
          // On the run as well as the card: retry clears the card's, and the
          // history a later session reads (job-prompts.js) needs the run's.
          if (error) { r.error = error; (s || j).error = error; }
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
    // A plan change waiting on the human freezes every sub-job it may still
    // edit or cancel: no new step, no merge, no human approval (job-store.js).
    // Steps already running carry on, PRs keep being watched, and work past the
    // point of no return (a verify after deploy) lands as it would have.
    if (sub && this.store.get(job.id).replan && !isFrozen(sub)) return;
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
        (j.subJobs.find((s) => s.id === sub?.id) || j).error = shortError(e);
      });
    }
  }
  async advance(id) {
    let job = this.store.get(id);
    if (!this.allowed(id) || job.error || job.stage === 'done') return;
    // Cancelled before it had sub-jobs: nothing to clean up per sub-job, so the
    // job finishes as soon as settle() has stopped its planning run. An active
    // one takes the ordinary road below — every sub-job is already in cleanup.
    if (job.cancelledAt && job.stage !== 'active') { if (!job.runs.some(runnable)) await this.finish(id); return; }
    if (job.stage === 'planning' && !job.plan && !activeFor(job)) { await this.launch(job, null, 'planning'); return; }
    if (job.stage !== 'active') return;
    if (job.replan && !job.replan.proposal && !activeFor(job)) {
      await this.launch(job, null, 'planning');
      job = this.store.get(id);
    }
    for (const initial of job.subJobs) {
      job = this.store.get(id);
      if (!this.allowed(id) || job.error) return;
      let sub = job.subJobs.find((s) => s.id === initial.id);
      if (activeFor(job, sub)) continue;
      if (sub.error) continue;
      try {
        if (sub.stage === 'session') {
          // A session starts once its milestone (`on`) and its prerequisites
          // have come, and every story its writes name has a key. One whose
          // drafts are still with the human is not run again until they are
          // decided. An if-dropped one whose trigger landed is not needed.
          const trigger = triggerStatus(job, sub);
          if (trigger === 'not-needed' && !job.replan) this.patchSub(id, sub.id, (s) => { dropSub(s, this.now()); s.notNeeded = true; });
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
          if (!job.replan && advanceWrite(job, sub, this.now())) this.store.update(id, (j) => advanceWrite(j, j.subJobs.find((s) => s.id === sub.id), this.now()));
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
          if (pr.behind && sub.branchUpdate?.failedHead === pr.head) pr = { ...pr, behind: false, dirty: true, checkStatus: 'failing' };
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
          } else if (sub.fixRequested) {
            // The human saw something the checks do not cover; the repair runs
            // whatever colour they are. A plan change can ask for one ahead of
            // the prerequisites the new brief builds on; it waits for them.
            if (dependenciesSatisfied(job, sub)) await this.launch(job, sub, 'repair');
          } else if (pr.checkStatus === 'failing' && sub.acceptedRed?.ref !== pr.head) {
            const attempts = job.runs.filter((r) => r.subJobId === sub.id && r.phase === 'repair').length;
            const limit = this.store.snapshot().settings.maxRepairs + (sub.repairAllowance || 0);
            if (attempts >= limit) this.patchSub(id, sub.id, (s) => { s.error = 'Automatic repair limit reached. Review changes, then retry if needed.'; });
            else await this.launch(job, sub, 'repair');
          } else if (pr.behind && sub.acceptedRed?.ref !== pr.head) {
            // Green but behind a base that requires up-to-date branches: bring it
            // up to date and keep watching, since the new head re-runs the checks.
            if (!job.replan && dependenciesSatisfied(job, sub)) await this.updateBranch(id, sub, pr);
          } else if (!job.replan && (pr.checkStatus === 'passing' || sub.acceptedRed?.ref === pr.head) && dependenciesSatisfied(job, sub) && (sub.mergeApprovedHead === pr.head || (!job.reviewMerge && !commentsBlockMerge(sub)))) {
            // An accepted-red head merges whatever its checks say — the move
            // pinned both the acceptance and the merge approval to this head.
            // Match-head on GitHub closes the push-vs-merge race; re-poll after
            // success instead of pretending an accepted merge-queue entry merged.
            if (sub.mergeRequestedHead !== pr.head) {
              await this.github.merge(sub, { canMerge: () => this.allowed(id) && !this.store.get(id).replan });
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
          const staleMs = this.store.snapshot().settings.deploymentStaleMinutes * 60000;
          this.patchSub(id, sub.id, (s) => {
            s.deploymentResult = result; s.observationError = null; s.nextPollAt = this.now() + 30000;
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
          // A red run the human accepted (job-moves.js) climbs the same rungs as
          // a green one, the plan's own check included; only the receipt line
          // says which colour it was.
          const accepted = result.status === 'failing' && !!sub.acceptedRed && sub.acceptedRed.ref === sub.pr?.mergeCommit;
          if (result.status === 'passing' || accepted) {
            if (sub.check) await this.launch(job, sub, 'verify');
            else this.patchSub(id, sub.id, (s) => { s.deployed = { at: this.now(), checks: [accepted ? acceptedRedLine(s) : 'Post-merge runs passed'], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; });
          } else if (result.status === 'failing') {
            const failed = result.runs.filter((r) => r.status === 'failing').map((r) => r.workflow).join(', ');
            this.patchSub(id, sub.id, (s) => { s.error = `Post-merge run failed: ${failed || 'unknown workflow'}`; });
          }
        } else if (sub.stage === 'cleanup') {
          await this.runtime.cleanup(job, sub);
          this.patchSub(id, sub.id, (s) => { s.stage = 'done'; s.state = s.cancelledAt ? 'cancelled' : 'done'; });
        }
      } catch (e) {
        this.patchSub(id, sub.id, (s) => {
          if (s.stage === 'cleanup') s.error = shortError(e);
          else { s.observationError = shortError(e); s.nextPollAt = this.now() + 60000; }
        });
      }
    }
    job = this.store.get(id);
    for (const run of job.runs.filter((r) => draftsDecided(job, r))) await this.resumeDrafted(id, run);
    job = this.store.get(id);
    if (job.subJobs.length && job.subJobs.every((s) => s.stage === 'done')) await this.finish(id);
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
  // Delivered or cancelled, the job ends the same way: planning sessions and
  // worktrees go, then `done`. `cancelledAt` is what tells the two apart.
  async finish(id) {
    try {
      const job = this.store.get(id);
      await this.runtime.cleanupPlanning(job);
      this.runtime.releaseImages(job);
      this.store.update(id, (j) => { j.stage = 'done'; j.completedAt = this.now(); });
    } catch (e) { this.store.update(id, (j) => { j.error = shortError(e); }); }
  }
}
