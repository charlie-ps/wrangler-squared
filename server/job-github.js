import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMMENTS_QUERY, normaliseComments } from './job-comments.js';
import { inferDeploys } from './job-deploys.js';
import { ATTRIBUTION } from './jobs-schema.js';
const exec = promisify(execFile);
export async function runFile(bin, args, cwd) {
  const { stdout } = await exec(bin, args, { cwd: cwd?.startsWith('~/') ? path.join(os.homedir(), cwd.slice(2)) : cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const good = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const ADMIN_REFUSED = /admin|bypass|not authorized|permission/i;
const needsAdmin = (message) => Object.assign(new Error(message), { needsAdmin: true });
const MERGEABLE_AS_IS = new Set(['CLEAN', 'UNSTABLE']);
export function prSummary(pr) {
  const checks = (pr.statusCheckRollup || []).map((c) => ({ name: c.name || c.context || 'Check',
    state: c.status && c.status !== 'COMPLETED' ? c.status : c.conclusion || c.state || 'PENDING' }));
  const failed = checks.some((c) => bad.has(c.state));
  const allGreen = checks.length > 0 && checks.every((c) => good.has(c.state));
  const mergeWithAdmin = pr.state === 'OPEN' && !pr.isDraft && allGreen
    && pr.reviewDecision === 'REVIEW_REQUIRED' && pr.mergeStateStatus === 'BLOCKED'
    && pr.mergeable === 'MERGEABLE';
  const behind = pr.state === 'OPEN' && !pr.isDraft && pr.mergeStateStatus === 'BEHIND' && !failed
    && pr.reviewDecision !== 'CHANGES_REQUESTED' && (allGreen || !checks.length);
  let checkStatus = 'pending';
  if (failed || pr.reviewDecision === 'CHANGES_REQUESTED' || pr.mergeStateStatus === 'DIRTY') checkStatus = 'failing';
  else if (mergeWithAdmin || (pr.mergeStateStatus === 'CLEAN' && !pr.isDraft && (allGreen || !checks.length))) checkStatus = 'passing';
  else if (allGreen && pr.reviewDecision === 'REVIEW_REQUIRED') checkStatus = 'awaiting-review';
  return { url: pr.url, title: pr.title || null, state: pr.state, head: pr.headRefOid, branch: pr.headRefName,
    base: pr.baseRefName, mergeCommit: pr.mergeCommit?.oid || null,
    checkStatus, checks, mergeWithAdmin, behind, dirty: pr.mergeStateStatus === 'DIRTY', mergeState: pr.mergeStateStatus || null, reviewDecision: pr.reviewDecision };
}
const verdict = (run) => ({ workflow: run.workflowName, runId: run.databaseId, url: run.url,
  status: run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'passing'
    : run.conclusion === 'skipped' ? 'skipped' : 'failing',
  conclusion: run.conclusion || null });
export class JobGithub {
  constructor(run = runFile) { this.run = run; this.contains = new Map(); }
  async pr(sub) {
    const fields = 'url,title,state,isDraft,headRefOid,headRefName,baseRefName,mergeCommit,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup';
    const raw = JSON.parse(await this.run('gh', ['pr', 'view', sub.pr.url, '--json', fields], sub.repo));
    const repo = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'nameWithOwner'], sub.repo));
    const slug = new URL(raw.url).pathname.split('/').slice(1, 3).join('/');
    if (slug.toLowerCase() !== repo.nameWithOwner.toLowerCase() || raw.headRefName !== sub.worktree?.branch) {
      throw new Error('Reported PR does not belong to this repository and worktree branch');
    }
    const summary = prSummary(raw);
    if (summary.mergeWithAdmin) {
      const missing = await this.missingRequiredChecks(sub, summary, slug);
      if (missing.length) {
        summary.checks.push(...missing.map(name => ({ name, state: 'PENDING' })));
        summary.checkStatus = 'pending'; summary.mergeWithAdmin = false;
      }
    }
    return summary;
  }
  // Merges the base into the PR head. Fails (non-zero exit) when it conflicts.
  async updateBranch(sub) {
    await this.run('gh', ['pr', 'update-branch', sub.pr.url], sub.repo);
  }
  async comments(sub) {
    const raw = JSON.parse(await this.run('gh', ['api', 'graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `url=${sub.pr.url}`], sub.repo));
    return normaliseComments(raw?.data?.resource);
  }
  // Whether merging this diff into this base starts anything at all, judged by
  // what GitHub itself will run: a sub-job no workflow reacts to is delivered by
  // the merge itself, and would otherwise watch for a post-merge run GitHub never
  // queues until the stale flag gives up on it. Local files are only the fallback
  // when GitHub cannot be asked — they can say a push workflow exists that GitHub
  // will never run (unpushed, a checkout on another branch, Actions off on a fork).
  async deploys(sub, pr) {
    const files = JSON.parse(await this.run('gh', ['pr', 'view', pr.url || sub.pr.url, '--json', 'files'], sub.repo)).files || [];
    const paths = files.map((f) => f.path);
    const remote = await this.remoteWorkflows(sub, pr).catch(() => null);
    if (remote?.actionsDisabled) return { head: pr.head, base: pr.base, expected: false, workflows: [], summary: 'Merge completes it · Actions disabled' };
    if (remote) return { head: pr.head, base: pr.base, ...inferDeploys({ workflows: remote.workflows, files: paths, base: pr.base }) };
    // The worker pushed from the worktree, so that tree IS the PR head's; the
    // main checkout is only the fallback for a sub-job whose worktree is gone.
    const dirs = [sub.worktree?.path, sub.repo].filter(Boolean)
      .map((dir) => path.join(dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir, '.github', 'workflows'));
    let workflows = [];
    for (const dir of dirs) { workflows = this.readWorkflows(dir); if (workflows.length) break; }
    return { head: pr.head, base: pr.base, ...inferDeploys({ workflows, files: paths, base: pr.base }) };
  }
  // The workflow files at the PR head as GitHub holds them, each tagged with its
  // GitHub state when it is not active. Throws (so the caller reads local files)
  // on any error but a missing workflows directory, which is GitHub's "none". The
  // permissions and state reads need more than read access on some repos; either
  // failing only drops that refinement, since an unknown is never "merge is delivery".
  async remoteWorkflows(sub, pr) {
    const slug = new URL(pr.url || sub.pr.url).pathname.split('/').slice(1, 3).join('/');
    const api = async (endpoint, ...flags) => JSON.parse(await this.run('gh', ['api', ...flags, endpoint], sub.repo));
    const permissions = await api(`repos/${slug}/actions/permissions`).catch(() => null);
    if (permissions?.enabled === false) return { actionsDisabled: true };
    const ref = encodeURIComponent(pr.head);
    let listing;
    try { listing = await api(`repos/${slug}/contents/.github/workflows?ref=${ref}`); } catch (e) {
      // 404 is also a ref GitHub does not hold, which proves nothing about CI.
      if (!/HTTP 404/.test(e.message)) throw e;
      await api(`repos/${slug}/commits/${ref}`);
      return { workflows: [] };
    }
    if (!Array.isArray(listing)) throw new Error('Unexpected workflows listing');
    // A workflow GitHub lists as not active (disabled by hand, for inactivity, or
    // on a fork until its owner enables Actions) is never queued by a push; one
    // it does not list yet is new in this PR and runs once merged.
    const states = await api(`repos/${slug}/actions/workflows?per_page=100`)
      .then((r) => new Map((r.workflows || []).map((w) => [w.path, w.state]))).catch(() => new Map());
    const workflows = await Promise.all(listing.filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name)).map(async (e) => {
      const text = await this.run('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json',
        `repos/${slug}/contents/${e.path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`], sub.repo);
      const state = states.get(e.path);
      return { file: e.name, text, ...(state && state !== 'active' ? { disabled: state } : {}) };
    }));
    return { workflows };
  }
  readWorkflows(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return []; }
    return entries.filter((f) => /\.ya?ml$/i.test(f)).map((file) => {
      try { return { file, text: fs.readFileSync(path.join(dir, file), 'utf8') }; } catch { return null; }
    }).filter(Boolean);
  }
  async missingRequiredChecks(sub, pr, slug) {
    const branch = encodeURIComponent(pr.base);
    const api = async (endpoint, ...flags) => JSON.parse(await this.run('gh', ['api', endpoint, ...flags], sub.repo));
    // A green rollup omits required checks which have never reported. Read both
    // classic branch protection and active repository/organization rulesets.
    const protection = (await api(`repos/${slug}/branches/${branch}`)).protection;
    if (!protection) throw new Error('Cannot determine required checks for the review override');
    const classic = protection.required_status_checks;
    const required = [
      ...(classic?.contexts || []).map(context => ({ context })),
      ...(classic?.checks || []).map(c => ({ context: c.context, appId: c.app_id })),
    ];
    const rules = (await api(`repos/${slug}/rules/branches/${branch}?per_page=100`, '--paginate', '--slurp')).flat();
    for (const rule of rules) {
      if (rule.type === 'required_status_checks') required.push(...rule.parameters.required_status_checks
        .map(c => ({ context: c.context, appId: c.integration_id })));
    }
    let runs = [];
    if (required.some(c => c.appId > 0)) {
      runs = (await api(`repos/${slug}/commits/${pr.head}/check-runs?per_page=100`, '--paginate', '--slurp')).flatMap(page => page.check_runs);
    }
    return [...new Set(required.filter(c => !pr.checks.some(check => check.name === c.context && good.has(check.state))
      || (c.appId > 0 && !runs.some(run => run.name === c.context && run.app?.id === c.appId
        && run.head_sha === pr.head && run.status === 'completed' && good.has(run.conclusion?.toUpperCase()))))
      .map(c => c.context))];
  }
  async merge(sub, { canMerge = () => true } = {}) {
    // Admin bypasses GitHub's CI enforcement too. Recheck before using it and
    // retain match-head so a push cannot silently replace the approved change.
    let admin = false;
    if (sub.acceptedRed?.ref === sub.pr.head) {
      // The human accepted this head red (job-sub-ops.js), so green is not the
      // test — only that GitHub can still merge it. Admin is what gets a
      // BLOCKED merge past the check enforcement the red checks trip; an
      // UNSTABLE one (red but optional checks) needs no override, and a merge
      // conflict is beyond any.
      const current = await this.pr(sub);
      if (current.state !== 'OPEN' || current.head !== sub.pr.head) throw new Error('PR changed; waiting for a fresh observation');
      if (current.dirty) throw new Error('PR has merge conflicts, which no override can merge through');
      admin = !MERGEABLE_AS_IS.has(current.mergeState);
    } else if (sub.pr.mergeWithAdmin) {
      const current = await this.pr(sub);
      if (current.state !== 'OPEN' || current.head !== sub.pr.head || current.checkStatus !== 'passing') {
        throw new Error('PR changed or checks are no longer green; waiting for a fresh observation');
      }
      admin = current.mergeWithAdmin;
    }
    // An explicit body lands the PR description (and its attribution line)
    // whichever squash message the repository is set to build.
    const description = (JSON.parse(await this.run('gh', ['pr', 'view', sub.pr.url, '--json', 'body'], sub.repo)).body || '').trim();
    const body = description.endsWith(ATTRIBUTION) ? description : [description, ATTRIBUTION].filter(Boolean).join('\n\n');
    if (!canMerge()) throw new Error('Job paused before merge');
    if (admin) {
      const { viewerPermission } = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'viewerPermission'], sub.repo));
      if (viewerPermission !== 'ADMIN') throw needsAdmin(`Merging this PR needs admin rights on the repository (you have ${String(viewerPermission || 'unknown').toLowerCase()} access). Merge it yourself, or have someone with admin rights do it.`);
    }
    try {
      await this.run('gh', ['pr', 'merge', sub.pr.url, '--squash', ...(admin ? ['--admin'] : []), '--match-head-commit', sub.pr.head, '--body', body], sub.repo);
    } catch (e) {
      if (admin && ADMIN_REFUSED.test(String(e.stderr || e.message))) throw needsAdmin('Merging this PR needs admin rights on the repository, and GitHub refused the bypass. Merge it yourself, or have someone with admin rights do it.');
      throw e;
    }
  }
  // Watch whatever GitHub actually started for this merge, rather than a list of
  // workflow names chosen before the merge existed: the plan cannot reliably
  // predict which workflows trigger on a push to the base branch, and a name that
  // never runs leaves a merged sub-job watching forever.
  //
  // Pinned to the merge COMMIT, not `--branch <base>` + "created after we merged":
  // a job's PR sub-jobs may merge into the same repository minutes apart, so a
  // sibling's deploy run would otherwise become this sub-job's evidence.
  // `pull_request` runs are the PR gate, already judged before the merge.
  //
  // No runs is PENDING, never passing — silence is indistinguishable from a run
  // that has not been queued yet (measured: 4-10s from merge to the first run),
  // so the runner flags a lasting silence for the human instead of inferring a
  // deployment nothing observed. A sub-job whose merge IS its delivery carries no
  // `deployment` at all and never reaches this poll.
  async deployment(sub) {
    if (!sub.pr.mergeCommit) throw new Error('Waiting for GitHub to report the merge commit');
    const runs = JSON.parse(await this.run('gh', ['run', 'list', '--commit', sub.pr.mergeCommit,
      '--limit', '100', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,url,workflowName,attempt'], sub.repo))
      .filter((r) => r.headSha === sub.pr.mergeCommit && !['pull_request', 'pull_request_target'].includes(r.event));
    // One workflow can have several runs on one commit (a re-run, or a scan that
    // starts twice); the latest attempt is the live one, as for the named path.
    const latest = new Map();
    for (const r of runs.sort((a, b) => a.databaseId - b.databaseId || a.attempt - b.attempt)) latest.set(r.workflowName, r);
    // A skipped run is GitHub saying the workflow did not apply to this commit —
    // not a failure worth a recovery job, but not deployment evidence either, so
    // it neither blocks nor satisfies. All-skipped therefore reads as silence.
    const results = await Promise.all([...latest.values()].map(async (run) => {
      const own = verdict(run);
      return run.conclusion === 'cancelled' || own.status === 'failing' ? this.successor(sub, run, own) : own;
    }));
    // A cancelled run nothing has replaced yet holds the verdict like a pending
    // one, but is not one: the runner flags it stale rather than waiting forever.
    return { status: results.some((r) => r.status === 'failing') ? 'failing'
      : results.some((r) => r.status === 'passing') && !results.some((r) => ['pending', 'cancelled'].includes(r.status)) ? 'passing' : 'pending',
      runs: results, commit: sub.pr.mergeCommit };
  }
  // A cancelled or failed push run is judged again by later runs of the same
  // workflow on the same branch and event whose commit contains the merge: a
  // cancellation is almost always a concurrency group replacing a queued run with
  // a newer push, and a red one is often fixed by the next push or a flake gone
  // green. The NEWEST completed (not cancelled) such run is the verdict, so a
  // failed-then-passed branch reads green and passed-then-failed reads red. A run
  // on a commit that does not contain the merge (a sibling that landed first) is
  // never evidence. A cancelled run with only a replacement still running is
  // pending on it; with nothing at all it stays `cancelled`, not failing — GitHub
  // may still queue the successor, and a hand-cancelled run is the human's call,
  // not a recovery job's. A failed run with nothing completed after it stays red.
  // A green run on a revert of the merge contains it too and reads as deployed,
  // by design: this is evidence a run that built the merge passed, not that the
  // change is still live, and a revert is a later change somebody chose.
  async successor(sub, run, own = verdict(run)) {
    const fallback = run.conclusion === 'cancelled' ? { ...own, status: 'cancelled' } : own;
    if (!run.headBranch) return fallback;
    const later = JSON.parse(await this.run('gh', ['run', 'list', '--workflow', run.workflowName, '--branch', run.headBranch,
      '--event', run.event, '--limit', '50', '--json', 'databaseId,headSha,status,conclusion,url,workflowName,attempt'], sub.repo))
      .filter((r) => r.databaseId > run.databaseId && r.headSha !== run.headSha)
      .sort((a, b) => b.databaseId - a.databaseId || b.attempt - a.attempt);
    const runs = new Map();
    for (const r of later) if (!runs.has(r.databaseId)) runs.set(r.databaseId, r);
    let running = null;
    for (const r of runs.values()) {
      if (r.conclusion === 'cancelled' || (r.status !== 'completed' && (running || fallback.status !== 'cancelled'))) continue;
      if (!await this.includes(sub, run.headSha, r.headSha)) continue;
      if (r.status === 'completed') return { ...verdict(r), supersedes: run.databaseId, commit: r.headSha };
      running = r;
    }
    return running ? { ...verdict(running), supersedes: run.databaseId, commit: running.headSha } : fallback;
  }
  async includes(sub, commit, head) {
    const key = `${sub.repo}\0${commit}\0${head}`;
    if (!this.contains.has(key)) {
      const status = await this.run('gh', ['api', `repos/{owner}/{repo}/compare/${commit}...${head}`, '--jq', '.status'], sub.repo);
      this.contains.set(key, ['ahead', 'identical'].includes(status));
    }
    return this.contains.get(key);
  }
}
