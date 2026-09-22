import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from './job-github.js';
import { jobPrompt, placeholderBranch } from './job-prompts.js';
import { removeWorktree, gitRepoRoot } from './git.js';
import { CHECKOUTS_DIR } from './data-dir.js';

// The one module that touches sessions — and therefore the one that had to be
// REWRITTEN for the extension port rather than copied. In core (agent-wrangler
// server/job-runtime.js on the `job-system` branch) it held a SessionManager,
// MemoryStore and TaskStore directly; here it holds the per-extension `host`
// façade (agent-wrangler server/host-api/v1.js) and nothing else. Every place the
// façade is narrower than what core reached for is marked `TODO(host-api …)` and
// listed in docs/PORTING.md with the capability that would close it.
//
// Host API 1.4: spawn takes the worktree, addDirs, task binding and PR-automation
// options core's dispatch took, so the wrangler cuts the sub-job's worktree and
// stamps the entry again — this module only decides the base and keeps the
// cleanup head, which is the one fact no host projection carries.
//
// Same shape as core so job-runner.js is a verbatim copy: launch / stop / isAlive /
// acceptTrustDialog / attributeSpend / cleanup / cleanupPlanning, plus
// `noteDispatch` (new — see launch()).
export const expandRepo = (repo) => path.resolve(repo.startsWith('~/') ? path.join(os.homedir(), repo.slice(2)) : repo);

export class JobRuntime {
  // `statusOf(sessionId)` answers from the graph the contributor last saw
  // (server/jobs.js): core read `lastGraph` directly; the projection
  // `host.sessions.get()` carries no status (TODO(host-api sessions:read status)).
  constructor({ host, statusOf = () => null }, run = runFile) {
    Object.assign(this, { host, statusOf, run });
    this.pendingLaunch = null;
  }

  async launch(job, sub, run, prepared) {
    // Planning discovers its repositories, ticketing only talks to Jira and a
    // session sub-job has none: blank cwd asks the wrangler for a fresh scratch
    // workspace (dispatch's own rule), without fetching or branching a repo.
    const planning = ['planning', 'jira', 'session'].includes(run.phase);
    const repo = planning ? '' : expandRepo(sub.repo);
    const existing = sub?.worktree;
    if (existing && !fs.existsSync(existing.path)) throw new Error('Worktree is missing; restore it before retrying');
    // Every later phase (publish, repair, a retry) launches into the EXISTING
    // worktree and must still carry a worktree record on its card: core's
    // name_branch refuses a card without one, and publish — the run the prompt
    // tells to rename — is never the creating run. spawn has no adopt option,
    // but dispatch's own createWorktree adopts when the folder is already this
    // repo's worktree on that branch (classifyWorktreeTarget → 'adopt'), so the
    // stored record is handed back as { branch, folderName } with auto off; a
    // record that has drifted from the real checkout fails the launch loudly
    // instead of launching a worker that cannot push. The hook then reports the
    // adopted record, which noteDispatch() discards: the store's copy (with its
    // cleanupHead and any rename) is already the record and must not be
    // overwritten by a thinner launch snapshot.
    let worktree;
    let cleanupHead;
    if (existing) {
      worktree = { branch: existing.branch, folderName: existing.path, auto: false };
    } else if (!planning) {
      await this.run('git', ['fetch', 'origin'], repo);
      const remote = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], repo));
      // A ref name, never the main checkout's possibly-local HEAD: the wrangler
      // hands it straight to `git worktree add -b` as the commit-ish.
      const base = `refs/remotes/origin/${remote.defaultBranchRef.name}`;
      // The commit the branch is cut from. cleanup()'s compare-and-delete needs
      // it and neither the spawn result nor the hook payload carries it, so it
      // is read here and merged onto the record the wrangler settles on.
      cleanupHead = await this.run('git', ['rev-parse', '--verify', base], repo);
      worktree = { branch: placeholderBranch(job, sub), base, auto: true };
    }
    // Correlating the dispatch to this run: core stamped `automationRun` onto the
    // entry and called `onAutomationPrepared(sessionId, worktree)` BEFORE the pane
    // started, so a fast job_report always found its run bound. The extension's
    // equivalent is the `onBeforeDispatch` session hook (server/manifest.js),
    // which fires inside spawn() with the settled card id and the worktree the
    // wrangler cut — but carries no tag saying WHICH spawn it is for.
    // `pendingLaunch` is that correlation: one launch at a time (job-runner.js's
    // tick is serialised by `busy`), set before spawn, consumed by noteDispatch().
    // TODO(host-api sessions:spawn tag): a `tag` option echoed to onBeforeDispatch
    // would make this explicit rather than positional.
    this.pendingLaunch = { prepared, cleanupHead, adopt: Boolean(existing) };
    try {
      const result = await this.host.sessions.spawn({
        cwd: existing?.repoRoot || repo,
        agent: job.agent,
        model: job.model || undefined,
        intent: jobPrompt(job, sub, run),
        ...(worktree ? { worktree } : {}),
        // Planning discovers and clones checkouts, so it needs the parent of the
        // repos it will find; a Codex worker's own worktree git dir is granted by
        // the wrangler (session-manager.js withCodexWorktreeAddDir).
        ...(planning ? { addDirs: [CHECKOUTS_DIR] } : {}),
        // Binds task memory before the pane starts, which is the only ordering a
        // Codex session honours (it resolves its writable root once, at launch).
        taskId: job.taskId || undefined,
        // The runner drives this PR: core's nudge and auto-merge would be a
        // second driver on the same branch.
        autoMergeOnPass: false,
        autoFixPrChecks: false,
      });
      // The hook did not fire (an older host, or a spawn that never reached
      // dispatch's hook site): bind late rather than not at all.
      if (this.pendingLaunch) this.noteDispatch({ sessionId: result.sessionId, worktree: result.worktree });
      return result;
    } finally {
      this.pendingLaunch = null;
    }
  }

  // Called by the manifest's onBeforeDispatch hook with the settled card id and
  // the worktree the wrangler cut — or adopted — for it (null when neither).
  // Only the creating run reports it to the store (see launch()).
  // Returns false when no launch of ours is pending (an ordinary board dispatch).
  noteDispatch({ sessionId, worktree }) {
    const p = this.pendingLaunch;
    if (!p) return false;
    this.pendingLaunch = null;
    p.prepared(sessionId, worktree && !p.adopt ? { ...worktree, cleanupHead: p.cleanupHead } : undefined);
    return true;
  }

  // A job step that has stopped is finished for good: core suspended the pane,
  // probed tmux to confirm it was gone, then archived the card ("retire"). The
  // `sessions:archive` capability is archiveCascade — it kills the pane and
  // archives in one — so stop() is one call plus the same confirm-before-release
  // rule: a slot is never freed on a session that might still be running.
  // TODO(host-api sessions:archive review:false): core's archive() skipped the
  // paid memory review for an automationRun session; neither archive call here
  // (stop, cleanup) can ask for that, so a retired step may bill a Haiku review
  // whenever archiveReviewEnabled is on.
  async stop(run) {
    if (!run.sessionId) return;
    const before = this.host.sessions.get(run.sessionId);
    if (!before) return; // purged — nothing to stop
    if (!before.archived) await this.host.sessions.archive(run.sessionId, { cascade: false });
    if (await this.isAlive(run)) throw new Error('Session is still running; cannot release its concurrency slot');
  }

  // TODO(host-api sessions:read status / sessions:probe): core ran a fresh tmux
  // `list-panes` probe (SessionManager.isSessionAlive). The projection only says
  // `archived`, and the graph status the contributor cached is up to one tick
  // (~4s) stale and reads a DORMANT card as 'idle' too — so this is "archived, or
  // not on the board as a live pane" rather than a real probe.
  async isAlive(run) {
    const s = run.sessionId && this.host.sessions.get(run.sessionId);
    if (!s || s.archived) return false;
    const status = this.statusOf(run.sessionId);
    return status === 'working' || status === 'needs-you' || status === 'idle';
  }

  // TODO(host-api pane:capture/pane:keys): core answered Claude's first-launch
  // "do you trust this folder" dialog by reading the pane and pressing Down/Enter
  // (tmux-scraper.js trustDialogState). No capability reaches a pane, so a job
  // worker parked on that dialog waits for a human — the core `classify()` change
  // that reports it as needs-you (docs/PORTING.md, core PRs) is what makes it
  // visible at all.
  async acceptTrustDialog() {
    return false;
  }

  // TODO(host-api sessions:bill): core pushed a headless triage's live id onto the
  // sub-job's latest card (`recordPriorLiveSessionId`) so the cost scanners billed
  // it. Nothing on the façade can; the triage's spend is currently unattributed.
  attributeSpend() {}

  async cleanup(job, sub) {
    // Backstop for a session bound to a run that never settled cleanly (an
    // interrupted claim, a restart mid-launch): normally stop() already archived.
    for (const sid of sub.sessions || []) {
      const s = this.host.sessions.get(sid);
      if (s && !s.archived) await this.host.sessions.archive(sid, { cascade: false });
    }
    // A cancelled sub-job merged nothing. Its bytes are retained only if the
    // branch was pushed (the PR head) or never left the base it was cut from.
    if (sub.worktree) await this.cleanupWorktree(sub.worktree, sub.cancelledAt ? sub.pr?.head || sub.worktree.cleanupHead : sub.pr.head);
    if (sub.worktree && sub.pr && !sub.cancelledAt) await this.deleteRemoteBranch(sub.worktree, sub.pr.head);
    if (job.updateMain && !sub.cancelledAt && sub.pr) {
      const root = await gitRepoRoot(expandRepo(sub.repo));
      if (!root) throw new Error('Cannot resolve main checkout');
      const dirty = await this.run('git', ['status', '--porcelain'], root);
      const branch = await this.run('git', ['branch', '--show-current'], root);
      if (dirty || branch !== sub.pr.base) throw new Error('Main checkout has local changes or is on another branch; update it manually, then retry');
      await this.run('git', ['fetch', 'origin'], root);
      await this.run('git', ['merge', '--ff-only', `refs/remotes/origin/${sub.pr.base}`], root);
    }
  }

  // Verbatim from core: compare-and-delete, so a racing local commit is refused.
  async cleanupWorktree(wt, expectedHead) {
    if (!expectedHead) throw new Error('Cannot clean up without the verified branch head');
    const ref = `refs/heads/${wt.branch}`;
    if (fs.existsSync(wt.path)) {
      const branch = await this.run('git', ['symbolic-ref', 'HEAD'], wt.path);
      const head = await this.run('git', ['rev-parse', 'HEAD'], wt.path);
      if (branch !== ref || head !== expectedHead) throw new Error('Worktree has changed since verification; preserve it for review');
      await removeWorktree({ worktreePath: wt.path, repoRoot: wt.repoRoot });
    }
    const trees = await this.run('git', ['worktree', 'list', '--porcelain'], wt.repoRoot);
    if (trees.split('\n').includes(`branch ${ref}`)) throw new Error('Branch is in use by another worktree');
    const existing = await this.run('git', ['for-each-ref', '--format=%(objectname)', ref], wt.repoRoot);
    if (!existing) return;
    if (existing !== expectedHead) throw new Error('Branch has additional commits; preserve it for review');
    await this.run('git', ['update-ref', '-d', ref, expectedHead], wt.repoRoot);
  }

  // Verbatim from core: the merged PR's branch on origin, only while it still
  // points at the merged head.
  async deleteRemoteBranch(wt, mergedHead) {
    const ref = `refs/heads/${wt.branch}`;
    const remote = await this.run('git', ['ls-remote', '--exit-code', 'origin', ref], wt.repoRoot).catch((e) => {
      if (e.code === 2) return '';
      throw e;
    });
    if (!remote) return;
    if (remote.split(/\s+/)[0] !== mergedHead) throw new Error('Remote branch has commits beyond the merged PR; preserve it for review');
    await this.run('git', ['push', 'origin', `--force-with-lease=${ref}:${mergedHead}`, '--delete', ref], wt.repoRoot);
  }

  async cleanupPlanning(job) {
    for (const run of job.runs.filter((r) => (r.phase === 'planning' || r.phase === 'jira') && r.sessionId)) {
      await this.stop(run);
    }
    for (const wt of job.planningWorktrees || []) {
      await this.cleanupWorktree(wt, wt.cleanupHead);
    }
  }
}
