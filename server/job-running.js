import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { inboxDir } from './job-evidence.js';

// What a Code review step's agent left running for the human to try (docs: "See
// it working"). The AGENT starts it, detached (`setsid`) so it outlives the session
// going dormant, and lists it in its `ready` receipt; this extension never starts
// anything. It only keeps the list on the sub-job (`sub.running`), checks it is
// still up, and kills each recorded process group once the review has moved on.
//
//   sub.running = { at, items: [{name, url?, pid?, log?, up, replaced?}],
//                   stopped?: {at, reason, results: [{name, ok, detail}], still: [name…]} }
//
// A new receipt's list replaces the old one; an old entry whose pid it does not
// list again is kept only as `replaced`, for the next tick to kill. Stop all
// replaces the list with nothing. Teardown NEVER fails an approval: a group that
// will not die, or an entry with no pid to signal, is reported on `stopped` (and
// flagged amber on the step), not thrown. Fields an older save carries beyond
// these are ignored.
//
// TODO(host-api processes): there is no façade to signal a process group or read
// a log file, so this module uses node's child_process and fs directly (the
// extension shares the wrangler's process and user). The agent's processes run in
// ITS sandbox; a Codex step the sandbox stops from listening answers with couldNot
// instead (job-prompts.js).

const TERM_WAIT_MS = 2000;
const POLL_MS = 100;
const LOG_TAIL_BYTES = 24 * 1024;

const live = (items) => (items || []).filter((i) => i && i.name);
export const runningOf = (sub) => live(sub?.running?.items).filter((i) => !i.replaced);
export const hasRunning = (sub) => runningOf(sub).length > 0;

// The review is still open on a round the human has not decided: what keeps the
// agent's preview alive. Approved, dropped, reworked by a plan change, retried,
// cleaned up or its job cancelled all end it.
export const holdsRunning = (job, sub) => !job.cancelledAt && !!sub && !sub.cancelledAt && sub.stage === 'review' && sub.state === 'verified' && !sub.ready?.approvedAt;

// Everything due for teardown now: what a new list replaced, and the whole list
// once the review no longer holds it.
export const dueTeardown = (job, sub) => holdsRunning(job, sub) ? live(sub?.running?.items).filter((i) => i.replaced) : live(sub?.running?.items);

export const stopReason = (job, sub) => job.cancelledAt || sub.cancelledAt ? 'dropped' : sub.stage === 'cleanup' || sub.stage === 'done' ? 'cleaned up' : sub.ready?.approvedAt ? 'approved' : sub.stage === 'review' ? 'stopped during review' : 'reworked';

// The receipt's list becomes the sub-job's. A process it lists again (same pid)
// keeps running; every other old entry with a pid is left `replaced` to be killed.
export function setRunning(sub, items, now) {
  const old = live(sub.running?.items).filter((o) => o.pid && !items.some((n) => n.pid === o.pid));
  const up = (n) => live(sub.running?.items).find((o) => !o.replaced && o.name === n.name && o.pid === n.pid && o.url === n.url)?.up ?? null;
  sub.running = { at: now, items: [...items.map((n) => ({ ...n, up: up(n) })), ...old.map((o) => ({ ...o, replaced: true }))], ...(sub.running?.stopped ? { stopped: sub.running.stopped } : {}) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgidOfDefault = (pid) => new Promise((resolve) => execFile('ps', ['-o', 'pgid=', '-p', String(pid)], (err, out) => resolve(err ? null : Number.parseInt(String(out).trim(), 10) || null)));
const aliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const answersDefault = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
export const defaultDeps = () => ({ kill: (pid, sig) => process.kill(pid, sig), alive: aliveDefault, pgidOf: pgidOfDefault, answers: answersDefault, sleep });

// Whether an entry is up now: its URL answers, else its process is alive.
export async function isUp(item, deps = defaultDeps()) {
  if (item.url) return deps.answers(item.url);
  if (item.pid) return deps.alive(item.pid);
  return true;
}

// One entry's teardown: SIGTERM to its process group (the agent started it with
// setsid, so the pid leads one; a pid that does not lead its own group is signalled
// alone, never a group that is not the agent's, and never our own process), a
// short wait, then SIGKILL. Never throws.
async function tearOne(item, deps) {
  if (!item.pid) return { name: item.name, ok: false, detail: 'no process to stop' };
  if (item.pid === process.pid || item.pid === process.ppid) return { name: item.name, ok: false, detail: `process ${item.pid} is the wrangler's own, not stopped` };
  try {
    const pgid = await deps.pgidOf(item.pid);
    if (pgid == null && !deps.alive(item.pid)) return { name: item.name, ok: true, detail: `process ${item.pid} already gone` };
    const group = pgid === item.pid;
    const target = group ? -item.pid : item.pid;
    try { deps.kill(target, 'SIGTERM'); } catch { /* gone already */ }
    for (let waited = 0; waited < TERM_WAIT_MS && deps.alive(item.pid); waited += POLL_MS) await deps.sleep(POLL_MS);
    if (deps.alive(item.pid)) { try { deps.kill(target, 'SIGKILL'); } catch { /* gone */ } await deps.sleep(POLL_MS); }
    if (deps.alive(item.pid)) return { name: item.name, ok: false, detail: `process ${item.pid} would not die` };
    return { name: item.name, ok: true, detail: group ? `process group ${item.pid} killed` : `process ${item.pid} killed` };
  } catch (e) { return { name: item.name, ok: false, detail: `could not kill ${item.pid}: ${String(e?.message || e).split('\n')[0]}` }; }
}

export async function teardown(items, { deps = defaultDeps() } = {}) {
  const results = [];
  for (const item of items) results.push(await tearOne(item, deps));
  return { results, still: results.filter((r) => !r.ok).map((r) => r.name) };
}

// The tail of the log an entry named, for the board's Logs button. The path is
// the agent's word, so it is read only from under the worktree or the evidence
// inbox, symlinks resolved first.
export function readLog(job, sub, name) {
  const item = live(sub?.running?.items).find((i) => i.name === name);
  if (!item?.log) return { error: 'No log was given for this' };
  const roots = [sub.worktree?.path, inboxDir(job.id, sub.id)].filter(Boolean);
  let real;
  try { real = fs.realpathSync(item.log); } catch { return { error: 'The log file is not there' }; }
  const inside = roots.some((r) => { try { const root = fs.realpathSync(r); return real === root || real.startsWith(root + path.sep); } catch { return false; } });
  if (!inside) return { error: 'The log is outside the worktree and the proof folder, so it is not shown' };
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: 'The log is not a file' };
    const fd = fs.openSync(real, 'r');
    try {
      const len = Math.min(st.size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return { text: buf.toString('utf8'), truncated: st.size > len };
    } finally { fs.closeSync(fd); }
  } catch (e) { return { error: String(e?.message || e).split('\n')[0] }; }
}
