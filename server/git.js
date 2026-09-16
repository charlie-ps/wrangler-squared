import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Git plumbing the job runtime needs, ported from agent-wrangler's
// server/worktree.js. It exists here ONLY because `host.sessions.spawn` (host API
// v1) has no worktree options: in core, `sessionManager.dispatch` cut the sub-job's
// worktree itself (`worktree: true, worktreeAuto, worktreeBase, worktreeBranch`)
// and stamped `entry.worktree` so the wrangler knew the session sat in one. Until
// the host grows that option (see docs/PORTING.md, "sessions:spawn worktree
// options"), the extension cuts the worktree with git and launches into it as a
// plain cwd — which is why the board shows no worktree record for a job session
// and `name_branch` refuses it (job_name_branch in tools.js is the stand-in).
//
// TODO(host-api sessions:spawn): delete most of this file once spawn accepts
// worktree options, and let core own worktree creation and the entry record again.
const exec = promisify(execFile);

export class WorktreeError extends Error {}

// The MAIN checkout's root for any cwd inside the repo, linked worktrees included.
export async function gitRepoRoot(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return path.dirname(stdout.trim());
  } catch {
    return null;
  }
}

// Linked worktrees keep their index/FETCH_HEAD under the main checkout's Git
// metadata; a sandboxed Codex worker needs those dirs writable (`--add-dir`),
// without the main checkout's source files. Core threaded these through
// dispatch's `addDirs`; spawn has no `addDirs` either (docs/PORTING.md).
export async function gitMetadataDirs(cwd) {
  const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const dirs = stdout.trim().split('\n');
  if (dirs.length !== 2 || dirs.some((dir) => !path.isAbsolute(dir))) {
    throw new Error('Cannot resolve Git metadata directories for the job workspace');
  }
  const roots = [...new Set(dirs.map((dir) => fs.realpathSync(dir)))];
  if (roots.some((dir) => !fs.statSync(dir).isDirectory())) throw new Error('Job Git metadata is not a directory');
  return roots.filter((dir) => !roots.some((parent) => parent !== dir && dir.startsWith(parent + path.sep)));
}

// `git check-ref-format --branch` without a subprocess. NOT a sanitiser: a name
// that fails is refused, because a branch that silently comes out different from
// what the human approved is worse than an error.
export function isValidBranchName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name === '@') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((c) => c && !c.startsWith('.') && !c.endsWith('.lock'));
}

// A branch may carry `/`; the worktree is ONE directory beside the main checkout
// (`<repo>-worktree-<branch>`, slashes folded), matching core's layout so a
// human's existing mental model of where worktrees live still holds.
const flatBranch = (branch) => String(branch).replaceAll('/', '-');
export const worktreeDirName = (repoRoot, branch) => `${path.basename(repoRoot)}-worktree-${flatBranch(branch)}`;

// Cut a NEW worktree on a NEW branch from `baseRef` (a fetched remote default
// ref, never the main checkout's possibly-local HEAD). Deliberately narrower than
// core's createWorktree: no adopt/existing-branch cases, because a job's
// placeholder branch is minted per sub-job and a collision is a bug to surface.
export async function createWorktree({ cwd, branch, baseRef }) {
  if (!isValidBranchName(branch)) throw new WorktreeError(`"${branch}" is not a valid git branch name.`);
  const repoRoot = await gitRepoRoot(cwd);
  if (!repoRoot) throw new WorktreeError('Not a git repository');
  const dir = path.join(path.dirname(repoRoot), worktreeDirName(repoRoot, branch));
  if (fs.existsSync(dir)) throw new WorktreeError(`${dir} already exists`);
  try {
    await exec('git', ['-C', repoRoot, 'worktree', 'add', '--no-track', '-b', branch, dir, baseRef]);
  } catch (e) {
    throw new WorktreeError(`git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  return { path: dir, branch, repoRoot };
}

// Uncommitted and untracked files included: every caller has already decided the
// work is disposable (cleanup verified the branch head is what the merged PR
// retains — commits are guarded there, working-tree dirt is not). A missing dir
// is a no-op success.
export async function removeWorktree({ worktreePath, repoRoot = '' }) {
  if (!worktreePath) throw new WorktreeError('No worktree path');
  if (!fs.existsSync(worktreePath)) return { ok: true, alreadyGone: true };
  const root = repoRoot || (await gitRepoRoot(worktreePath));
  if (!root) throw new WorktreeError('Could not resolve the repository for this worktree');
  try {
    await exec('git', ['-C', root, 'worktree', 'remove', '--force', worktreePath]);
    return { ok: true };
  } catch (e) {
    throw new WorktreeError(`git worktree remove failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
}

// Rename the worktree's checked-out branch VERBATIM (a job session names it in
// the repository's own convention — `fix/AUTH-123-x` must reach GitHub as typed).
// Suffixes -2, -3… if the name is taken, like core's renameBranch.
export async function renameBranch({ worktreePath, desired, currentBranch = '' }) {
  const name = String(desired || '').trim();
  if (!isValidBranchName(name)) throw new WorktreeError(`"${name}" is not a valid git branch name.`);
  if (name === currentBranch) return { branch: currentBranch, unchanged: true };
  const root = await gitRepoRoot(worktreePath);
  if (!root) throw new WorktreeError('Could not resolve the repository for this worktree');
  let final = name;
  for (let n = 2; await branchExists(root, final); n++) final = `${name}-${n}`;
  try {
    await exec('git', ['-C', worktreePath, 'branch', '-m', final]);
  } catch (e) {
    throw new WorktreeError(`git branch -m failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  return { branch: final };
}

export async function branchExists(repoRoot, branch) {
  try {
    await exec('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
