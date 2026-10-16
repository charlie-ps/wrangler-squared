import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { runFile } from './job-github.js';
import { jobPrompt, placeholderBranch } from './job-prompts.js';
import { removeWorktree, gitRepoRoot } from './git.js';
import { targetOf } from './jobs-schema.js';
import { checkoutsDir } from './data-dir.js';
import { ensureInbox } from './job-evidence.js';

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
// `noteDispatch` (new — see launch()) and `exists` / `resumeWithMail`, which a
// session parked on its drafts needs (job-writes.js).
export const LAUNCH_GRACE_MS = 2 * 60 * 1000;
// The job's extra writable folders for a Codex step, expanded and deduped.
// Claude has no OS sandbox to widen and Full access has none left, so neither
// gets them; a folder missing on this machine is skipped, since a missing
// --add-dir fails the whole launch.
export function writableDirsFor(job) {
  if (job.agent !== 'codex' || job.sandbox === 'full') return [];
  const dirs = (job.writableDirs || []).map(expandRepo).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  return [...new Set(dirs)];
}

export const expandRepo = (repo) => path.resolve(repo.startsWith('~/') ? path.join(os.homedir(), repo.slice(2)) : repo);

// A cleanup that would lose work. `refusal` is what the board shows the human
// and what a Discard must echo back: the head and dirty-state fingerprint pin
// the override to exactly what was seen.
export class CleanupRefused extends Error {
  constructor(message, refusal) { super(message); this.refusal = refusal; }
}
const LOSS_LIST_CAP = 50;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const changeOf = (type, xy, sub) => type === '?' ? 'untracked' : sub?.[0] === 'S' ? 'submodule' : type === 'u' ? 'conflicted'
  : /D/.test(xy) ? 'deleted' : /A/.test(xy) ? 'added' : /R/.test(xy) ? 'renamed' : 'modified';
// `git status --porcelain=v2 -z`: a path may contain spaces, so it is everything
// after the fixed fields, and a rename carries its old path as the next entry.
// An untracked directory still listed whole under --untracked-files=all is a
// nested repository: git will not look inside it, so nor can the list.
export function parseStatus(out) {
  const entries = out.split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const fixed = { 1: 8, 2: 9, u: 10 }[e[0]];
    if (e[0] === '?') files.push({ change: e.endsWith('/') ? 'nested repository' : 'untracked', path: e.slice(2) });
    else if (fixed) {
      const f = e.split(' ');
      files.push({ change: changeOf(e[0], f[1], f[2]), path: f.slice(fixed).join(' ') });
      if (e[0] === '2') i++;
    }
  }
  return files;
}
const PIN_WALK_CAP = 20000;
const PIN_BYTE_CAP = 256 * 1024 * 1024;
// What a Discard is pinned to must change whenever the bytes it would delete
// do, so file contents are hashed, not their size and mtime (a restore can keep
// both). An untracked nested repository is walked whole, its .git included,
// because the parent's status sees it as one entry. A submodule cannot be
// pinned this way (its index lives in the parent's .git/modules), and nor can a
// tree past the caps: those refusals carry `pinned: false` and offer no Discard.
function contentPin(dir, files) {
  const h = crypto.createHash('sha256');
  const budget = { entries: PIN_WALK_CAP, bytes: PIN_BYTE_CAP };
  const add = (rel) => {
    const abs = path.join(dir, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { h.update(`\0${rel}\0-`); return true; }
    if (--budget.entries < 0) return false;
    h.update(`\0${rel}\0${st.mode}`);
    if (st.isSymbolicLink()) h.update(fs.readlinkSync(abs));
    else if (st.isFile()) {
      if ((budget.bytes -= st.size) < 0) return false;
      h.update(fs.readFileSync(abs));
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) if (!add(path.join(rel, name))) return false;
    }
    return true;
  };
  const pinned = files.every((f) => f.change !== 'submodule' && add(f.path));
  return { pinned, digest: h.digest('hex') };
}

export class JobRuntime {
  // `statusOf(sessionId)` and `dormantOf(sessionId)` answer from the graph the
  // contributor last saw (server/jobs.js): core read `lastGraph` directly; the
  // projection `host.sessions.get()` carries neither (TODO(host-api sessions:read status)).
  constructor({ host, statusOf = () => null, dormantOf = () => false, now = Date.now }, run = runFile) {
    Object.assign(this, { host, statusOf, dormantOf, now, run });
    this.pendingLaunch = null;
  }

  // The job's own copies (`images:keep`) go with the job. A name the store no
  // longer has is dropped here rather than handed to spawn, which refuses an
  // unknown image before launching anything and would wedge the step forever.
  imagesFor(job, phase) {
    const wanted = phase === 'planning' || job.shareImages !== false;
    return wanted ? (job.images || []).filter((n) => this.host.images.read(n)) : [];
  }

  releaseImages(job) {
    for (const n of job.images || []) this.host.images.remove(n);
  }

  async launch(job, sub, run, prepared) {
    if (job.taskId) {
      const task = this.host.tasks.get(job.taskId);
      if (!task || task.archived) throw new Error('The Job task is no longer active. Restore it before retrying.');
    }
    // Planning discovers its repositories and a session sub-job has none: blank
    // cwd asks the wrangler for a fresh scratch workspace (dispatch's own rule),
    // without fetching or branching a repo.
    const planning = ['planning', 'session'].includes(run.phase);
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
      const target = targetOf(job, sub);
      const baseName = target || JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], repo)).defaultBranchRef.name;
      // A ref name, never the main checkout's possibly-local HEAD: the wrangler
      // hands it straight to `git worktree add -b` as the commit-ish.
      const base = `refs/remotes/origin/${baseName}`;
      // The commit the branch is cut from. cleanup()'s compare-and-delete needs
      // it and neither the spawn result nor the hook payload carries it, so it
      // is read here and merged onto the record the wrangler settles on.
      cleanupHead = await this.run('git', ['rev-parse', '--verify', base], repo).catch((e) => {
        if (target) throw new Error(`Base branch "${target}" does not exist on origin; push it or change ${sub.base ? 'this PR\'s' : 'the job\'s'} Land on branch`);
        throw e;
      });
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
    const checkouts = planning && checkoutsDir();
    // The proof inbox (job-evidence.js) lies outside the worktree, so the agent
    // that fills it is granted it: a Codex step (never under Full access, which
    // needs no grant) and a Claude one, whose --add-dir spares it a prompt per file.
    const evidence = run.phase === 'implementation' && sub && !(job.agent === 'codex' && job.sandbox === 'full') ? ensureInbox(job.id, sub.id) : null;
    const addDirs = [...new Set([...(checkouts ? [checkouts] : []), ...writableDirsFor(job), ...(evidence ? [evidence] : [])])];
    const images = this.imagesFor(job, run.phase);
    try {
      const result = await this.host.sessions.spawn({
        cwd: existing?.repoRoot || repo,
        agent: job.agent,
        model: job.model || undefined,
        effort: job.effort || undefined,
        intent: jobPrompt(job, sub, run),
        ...(images.length ? { images } : {}),
        ...(worktree ? { worktree } : {}),
        // Planning discovers and clones checkouts, so it needs the parent of the
        // repos it will find; a Codex worker's own worktree git dir is granted by
        // the wrangler (session-manager.js withCodexWorktreeAddDir). No such
        // folder on this machine, no grant: a missing --add-dir fails the launch.
        // The job's own extra folders ride along on every phase.
        ...(addDirs.length ? { addDirs } : {}),
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
  //
  // A starting Claude has no status file yet, so its card reads 'unknown' (core's
  // "visible, never idle") or is not in the cached graph at all; reading either as
  // dead reaped Jira steps seconds after launch. No status counts only for
  // LAUNCH_GRACE_MS, so a card that never reaches the graph still errors.
  //
  // A parked run woken to read its mail is starting again, so the grace runs
  // from the mail as well as from the launch.
  async isAlive(run) {
    if (!(await this.exists(run))) return false;
    const status = this.statusOf(run.sessionId);
    if (['working', 'needs-you', 'idle', 'unknown'].includes(status)) return true;
    const since = Math.max(run.startedAt || 0, run.mailedAt || 0);
    return status == null && since > 0 && this.now() - since < LAUNCH_GRACE_MS;
  }

  // The card is still on the board, live or dormant: what a parked run (which
  // may idle or be suspended for as long as the human takes) is held to.
  async exists(run) {
    const s = run.sessionId && this.host.sessions.get(run.sessionId);
    return !!s && !s.archived;
  }

  // The human's decisions on a parked session's drafts reach it as mail, which
  // the wrangler pastes in once the card is live and idle; a dormant card is
  // woken first (resume relaunches a live pane, so only a dormant one is).
  async resumeWithMail(run, text) {
    if (this.dormantOf(run.sessionId)) await this.host.sessions.wake(run.sessionId);
    this.host.mail.send(run.sessionId, text);
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

  // A headless comment triage has no card of its own; bill it to the sub-job's
  // latest card so the usage scan sees it (`sessions:bill` pushes the live id onto
  // the card's priorLiveSessionIds, what core's recordPriorLiveSessionId did).
  attributeSpend(sub, liveSessionId) {
    const sid = sub?.sessions?.at(-1);
    if (!sid || !liveSessionId) return false;
    return this.host.sessions.bill(sid, liveSessionId);
  }

  async cleanup(job, sub) {
    // Backstop for a session bound to a run that never settled cleanly (an
    // interrupted claim, a restart mid-launch): normally stop() already archived.
    for (const sid of sub.sessions || []) {
      const s = this.host.sessions.get(sid);
      if (s && !s.archived) await this.host.sessions.archive(sid, { cascade: false });
    }
    // A sub-job with no PR — cancelled, or marked done by hand before it ever
    // opened one — merged nothing. Its bytes are retained only if the branch
    // was pushed (the PR head) or never left the base it was cut from.
    if (sub.worktree) await this.cleanupWorktree(sub.worktree, sub.pr?.head || sub.worktree.cleanupHead, { mergedHead: sub.pr?.head, base: sub.pr?.base || targetOf(job, sub), discard: sub.discard });
    if (sub.worktree && sub.pr && !sub.cancelledAt) await this.deleteRemoteBranch(sub.worktree, sub.pr.head);
    if (job.updateMain && !sub.cancelledAt && sub.pr && await this.landedOnDefault(job, sub)) {
      const root = await gitRepoRoot(expandRepo(sub.repo));
      if (!root) throw new Error('Cannot resolve main checkout');
      const dirty = await this.run('git', ['status', '--porcelain'], root);
      const branch = await this.run('git', ['branch', '--show-current'], root);
      if (dirty || branch !== sub.pr.base) throw new Error('Main checkout has local changes or is on another branch; update it manually, then retry');
      await this.run('git', ['fetch', 'origin'], root);
      await this.run('git', ['merge', '--ff-only', `refs/remotes/origin/${sub.pr.base}`], root);
    }
  }

  // Fast-forwarding main is for work that landed on the default branch: a PR
  // that lands on an integration branch must not move main under the human.
  async landedOnDefault(job, sub) {
    if (!targetOf(job, sub)) return true;
    const remote = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], expandRepo(sub.repo)));
    return sub.pr.base === remote.defaultBranchRef.name;
  }

  // A PR head can move on GitHub after the push (`gh pr update-branch`, the merge
  // commit), so with `mergedHead` a local value strictly behind it is also
  // accepted. The caller still deletes with the exact value that passed.
  async isMergedAncestor(local, mergedHead, repoRoot) {
    if (local === mergedHead) return true;
    await this.run('git', ['fetch', 'origin'], repoRoot).catch(() => {});
    // GitHub's Update branch makes a merge commit that no surviving branch carries once the PR branch is auto-deleted.
    await this.run('git', ['fetch', 'origin', mergedHead], repoRoot).catch(() => {});
    await this.run('git', ['cat-file', '-e', `${mergedHead}^{commit}`], repoRoot).catch(() => {
      throw new Error(`Cannot resolve merged PR head ${mergedHead}; nothing was deleted, preserve it for review`);
    });
    try {
      await this.run('git', ['merge-base', '--is-ancestor', local, mergedHead], repoRoot);
      return true;
    } catch (e) {
      if (e.code === 1) return false;
      throw e;
    }
  }

  // Compare-and-delete: the worktree and branch go only if nothing on them would
  // be lost — a clean tree whose head is the verified one, or one whose commits
  // are all on origin's default branch or behind the merged PR head already (a
  // rebase onto newer main moves the head without adding work). The ref is
  // deleted at the value inspected, so a racing local commit is refused.
  // `discard` is the human's override, pinned to the head and fingerprint shown.
  async cleanupWorktree(wt, expectedHead, { mergedHead, base, discard, tree = true } = {}) {
    if (!expectedHead && !discard) throw new Error('Cannot clean up without the verified branch head');
    const ref = `refs/heads/${wt.branch}`;
    let head = null;
    if (fs.existsSync(wt.path)) {
      const branch = await this.run('git', ['symbolic-ref', 'HEAD'], wt.path);
      if (branch !== ref) throw new Error('Worktree has changed since verification; preserve it for review');
      head = await this.run('git', ['rev-parse', 'HEAD'], wt.path);
      const status = tree ? await this.run('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], wt.path) : '';
      const discarded = await this.assertDisposable(wt, { head, status, files: parseStatus(status) }, expectedHead, { mergedHead, base, discard });
      // Only a matched Discard forces: otherwise git itself refuses a tree that
      // gained work after the inspection above (a planning tree is scratch).
      // Git also refuses any tree holding a submodule unforced, so for that one
      // the status is read again right before forcing: it narrows the window
      // the unforced remove closes, rather than closing it.
      const force = discarded || !tree;
      await removeWorktree({ worktreePath: wt.path, repoRoot: wt.repoRoot, force }).catch(async (e) => {
        if (force || !e.submodules) throw e;
        if (await this.run('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], wt.path) !== status) throw new Error('Worktree has changed since verification; preserve it for review');
        await removeWorktree({ worktreePath: wt.path, repoRoot: wt.repoRoot, force: true });
      });
    }
    const trees = await this.run('git', ['worktree', 'list', '--porcelain'], wt.repoRoot);
    if (trees.split('\n').includes(`branch ${ref}`)) throw new Error('Branch is in use by another worktree');
    const existing = await this.run('git', ['for-each-ref', '--format=%(objectname)', ref], wt.repoRoot);
    if (!existing) return;
    if (existing !== head) await this.assertDisposable(wt, { head: existing, status: '', files: [] }, expectedHead, { mergedHead, base, discard });
    await this.run('git', ['update-ref', '-d', ref, existing], wt.repoRoot);
  }

  // Returns true when a Discard's pin matched (the caller may then force), false
  // when nothing would be lost, and throws a CleanupRefused otherwise. The pin
  // covers everything the refusal listed — the raw status (staged blob ids and
  // modes included), the files' contents, every lost commit and whether origin
  // could be confirmed — so a Discard never deletes more than the human saw.
  async assertDisposable(wt, { head, status, files }, expectedHead, { mergedHead, base, discard }) {
    if (!discard && !files.length && head === expectedHead) return false;
    // At the verified head, or behind the merged one, there is nothing to
    // compare, so a dirty tree is refused (with its Discard) even when origin's
    // default branch is unknowable.
    const retained = head === expectedHead || (!!mergedHead && await this.isMergedAncestor(head, mergedHead, wt.repoRoot));
    const target = retained ? base || null : base || await this.defaultBranch(wt.repoRoot);
    const { commits, stale } = retained ? { commits: [], stale: false } : await this.unmergedCommits(wt.repoRoot, head, target);
    // Nothing to lose is disposable whatever the pin: a human who saved their
    // work after looking is not asked to Discard a clean tree again.
    if (!files.length && !commits.length && !stale) return false;
    const content = contentPin(wt.path, files);
    const fingerprint = crypto.createHash('sha256')
      .update([head, status, content.digest, target, stale, ...commits.map((c) => `${c.sha}:${c.pushed}`)].join('\0')).digest('hex').slice(0, 16);
    if (discard && content.pinned && discard.head === head && discard.fingerprint === fingerprint) return true;
    const lost = [commits.length && `${plural(commits.length, 'commit')} not on origin/${target}`, files.length && plural(files.length, 'uncommitted file'),
      stale && `origin/${target} could not be confirmed on origin`].filter(Boolean).join(', ');
    const message = discard ? `Worktree changed after you chose to discard it (${lost}); review it again`
      : `Worktree has work that would be lost (${lost}); preserve it for review`;
    throw new CleanupRefused(message, { path: wt.path, branch: wt.branch, base: target, head, fingerprint, pinned: content.pinned, stale,
      commits: commits.slice(0, LOSS_LIST_CAP), commitCount: commits.length, files: files.slice(0, LOSS_LIST_CAP), fileCount: files.length });
  }

  // Commits on `head` that origin's `target` branch does not have. The branch
  // is fetched by name into its tracking ref, so a deleted or unreachable one,
  // or a fetch refspec that would skip it, leaves the answer `stale` rather
  // than read off a cached ref origin may have force-reset or removed — and a
  // stale empty list is never taken as "nothing to lose". Each commit says
  // whether some origin branch carries it: pushed work survives a local delete,
  // but is not on the branch that ships.
  async unmergedCommits(repoRoot, head, target) {
    const tracking = `refs/remotes/origin/${target}`;
    const stale = await this.run('git', ['fetch', 'origin', `+refs/heads/${target}:${tracking}`], repoRoot).then(() => false, () => true);
    const known = await this.run('git', ['rev-parse', '--verify', '--quiet', tracking], repoRoot).then(Boolean, () => false);
    if (!known) return { commits: [], stale: true };
    const log = await this.run('git', ['log', '--format=%H%x09%s', head, '--not', tracking], repoRoot);
    if (!log) return { commits: [], stale };
    const unpushed = new Set((await this.run('git', ['rev-list', head, '--not', '--remotes=origin'], repoRoot)).split('\n').filter(Boolean));
    return { stale, commits: log.split('\n').map((line) => {
      const [sha, ...subject] = line.split('\t');
      return { sha, subject: subject.join('\t'), pushed: !unpushed.has(sha) };
    }) };
  }

  // Origin's live HEAD first: a local origin/HEAD is only as current as the
  // last `remote set-head`, and may name a branch origin has since deleted.
  async defaultBranch(repoRoot) {
    const remote = await this.run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], repoRoot).catch(() => '');
    const live = remote.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
    if (live) return live;
    const local = await this.run('git', ['rev-parse', '--abbrev-ref', 'refs/remotes/origin/HEAD'], repoRoot).catch(() => '');
    if (local.startsWith('origin/')) return local.slice('origin/'.length);
    throw new Error('Cannot tell which branch origin delivers to; preserve it for review');
  }


  // Verbatim from core: the merged PR's branch on origin, only while it still
  // points at the merged head.
  async deleteRemoteBranch(wt, mergedHead) {
    const ref = `refs/heads/${wt.branch}`;
    const lookup = () => this.run('git', ['ls-remote', '--exit-code', 'origin', ref], wt.repoRoot).catch((e) => {
      if (e.code === 2) return '';
      throw e;
    });
    const remote = await lookup();
    if (!remote) return;
    if (remote.split(/\s+/)[0] !== mergedHead) throw new Error('Remote branch has commits beyond the merged PR; preserve it for review');
    // GitHub's own delete-on-merge can land between the look and the push, which
    // the lease then refuses as stale: a branch gone by now is the same success.
    await this.run('git', ['push', 'origin', `--force-with-lease=${ref}:${mergedHead}`, '--delete', ref], wt.repoRoot).catch(async (e) => {
      if (await lookup()) throw e;
    });
  }

  // A `write` run is the batched writer's from before session-owned writes.
  async cleanupPlanning(job) {
    for (const run of job.runs.filter((r) => (r.phase === 'planning' || r.phase === 'write') && r.sessionId)) {
      await this.stop(run);
    }
    // A planning tree holds scratch, never deliverable work, and the job has no
    // Discard to offer for it, so its files are not grounds to refuse.
    for (const wt of job.planningWorktrees || []) {
      await this.cleanupWorktree(wt, wt.cleanupHead, { tree: false });
    }
  }
}
