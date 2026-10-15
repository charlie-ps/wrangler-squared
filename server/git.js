import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// What is left of the worktree plumbing ported from agent-wrangler's
// server/worktree.js. Creating and renaming are gone: host API 1.4's
// `sessions.spawn({ worktree })` cuts the sub-job's worktree, stamps the entry
// and hands the record back, and core's `name_branch` renames it.
//
// These two survive because nothing on the façade does them. Cleanup is a
// compare-and-delete the extension owns (job-runtime.js cleanupWorktree): it
// verifies nothing on the branch or in the tree would be lost and only then
// removes the worktree, and core's archive-time offer is a UI prompt to a human,
// not something an extension can drive. `gitRepoRoot` answers "which checkout is
// this" for the `updateMain` fast-forward, which never runs in a worktree.
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

// `force` deletes uncommitted and untracked files too: only for a caller that
// has decided they are disposable (a Discard of exactly the state it was shown).
// Unforced, git refuses a tree that is not clean, which closes the gap between
// cleanup's inspection and the delete; ignored files go either way. A tree
// holding a submodule cannot be removed unforced at all, so a clean one is
// retried forced. A missing dir is a no-op success.
export async function removeWorktree({ worktreePath, repoRoot = '', force = true }) {
  if (!worktreePath) throw new WorktreeError('No worktree path');
  if (!fs.existsSync(worktreePath)) return { ok: true, alreadyGone: true };
  const root = repoRoot || (await gitRepoRoot(worktreePath));
  if (!root) throw new WorktreeError('Could not resolve the repository for this worktree');
  try {
    await exec('git', ['-C', root, 'worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
    return { ok: true };
  } catch (e) {
    if (!force && /submodules/.test(e.stderr || '')) return removeWorktree({ worktreePath, repoRoot: root, force: true });
    throw new WorktreeError(`git worktree remove failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
}
