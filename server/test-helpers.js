import fs from 'node:fs';
import path from 'node:path';
import manifest from './manifest.js';
import { DATA_DIR } from './data-dir.js';
import { JobStore } from './job-store.js';

// The fake-host pattern every ported suite shares (docs/PORTING.md, Tests):
// a JobStore on its own temp file (the manifest's factory would share one
// jobs.json across every test in the process), plus the façade keys the manifest
// declares in `requires` — and nothing else, so a test fails the moment code
// reaches for a capability the manifest did not ask for.
//
// Not a `*.test.js` name on purpose: the runner's glob would otherwise run it as
// a suite of no tests. Everything it writes goes under DATA_DIR, which
// test-setup.js has already redirected to a temp dir it removes on exit.
export function fakeHost() {
  const spawned = [];
  const broadcasts = [];
  const archived = [];
  const billed = [];
  const usage = []; // what host.usage.byCard() resolves to: [{ cardId, usd, estimatedUsd }]
  const sessions = new Map();
  const host = {
    id: 'jobs', version: '1.0.0', log: () => {},
    stores: { jobs: new JobStore(path.join(fs.mkdtempSync(path.join(DATA_DIR, 'host-')), 'jobs.json')) },
    rebuild: async () => { host.rebuilds++; },
    rebuilds: 0,
    broadcast: (p) => broadcasts.push(p),
    sessions: {
      spawn: async (opts) => {
        const sessionId = `s_${spawned.length + 1}`;
        spawned.push({ sessionId, ...opts });
        // What the wrangler settles on: the branch it was asked for, in the
        // folder beside the repo (session-manager.js resolveWorktree) — or, with
        // an absolute folderName, that folder as-is (createWorktree's adopt).
        const worktree = opts.worktree
          ? { branch: opts.worktree.branch, path: opts.worktree.folderName || `${opts.cwd}-worktree-${opts.worktree.branch}`, repoRoot: opts.cwd }
          : null;
        sessions.set(sessionId, { sessionId, archived: false, worktree });
        // What the wrangler does inside dispatch(): fire onBeforeDispatch with the
        // settled id and the worktree it just cut, before any pane starts.
        manifest.session.onBeforeDispatch({ sessionId, cwd: opts.cwd, worktree, host });
        return { sessionId, worktree };
      },
      get: (id) => sessions.get(id) ?? null,
      archive: async (id) => { archived.push(id); const s = sessions.get(id); if (s) s.archived = true; },
      // recordPriorLiveSessionId's contract: false for an unknown card or a live
      // id that IS the card's own; the set of prior ids grows otherwise.
      bill: (id, liveSessionId) => {
        const s = sessions.get(id);
        if (!s || !liveSessionId || s.liveSessionId === liveSessionId) return false;
        billed.push({ sessionId: id, liveSessionId });
        s.priorLiveSessionIds = [...new Set([...(s.priorLiveSessionIds || []), liveSessionId])];
        return true;
      },
    },
    usage: { byCard: async () => usage.map((r) => ({ ...r })) },
  };
  return { host, spawned, broadcasts, archived, billed, usage, sessions };
}
