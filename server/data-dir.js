import os from 'node:os';
import path from 'node:path';

// The wrangler's own state dir, resolved the same way server/data-dir.js does in
// agent-wrangler (AW_DATA_DIR, else ~/.agent-wrangler). An extension has no
// wrangler-owned data dir of its own — "a store's file is chosen by the
// extension's own factory" — so this is where jobs.json lives, and it is the SAME
// path the in-core job system used, so an install carries its jobs over. Honouring
// AW_DATA_DIR is what keeps a run-dev instance and the test suite isolated.
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export const DATA_DIR = process.env.AW_DATA_DIR
  ? path.resolve(expandTilde(process.env.AW_DATA_DIR))
  : path.join(os.homedir(), '.agent-wrangler');

// Where repositories are checked out on this machine: planning clones missing
// repos here and workers treat it as read-only reference, so the prompts and the
// planning launch's `addDirs` must agree on the one path. The default is the
// author's layout; AW_CHECKOUTS_DIR overrides it.
export const CHECKOUTS_DIR = process.env.AW_CHECKOUTS_DIR
  ? path.resolve(expandTilde(process.env.AW_CHECKOUTS_DIR))
  : path.join(os.homedir(), 'IdeaProjects');

// The prompts show `~/…` where they can: shorter, and not the human's login name.
export const displayPath = (p) => {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
};
