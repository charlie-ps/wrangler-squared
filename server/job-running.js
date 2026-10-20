import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { runFile } from './job-github.js';
import { inboxDir } from './job-evidence.js';
import { expandRepo } from './job-runtime.js';

// What a Code review step's agent left running for the human to try (docs: "See
// it working"). The AGENT starts it, detached (`setsid`) so it outlives the session
// going dormant, and lists it in its `ready` receipt; this extension never starts
// anything. It only keeps the list on the sub-job (`sub.running`), checks it is
// still up, and tears down what a receipt listed once the review has moved on.
//
//   sub.running = { round, at, items: [{name, url?, pid?, stop?, log?, up}],
//                   owed: [item…]   // dropped by a later round, torn down at once
//                   stopped?: {at, reason, results: [{name, ok, detail}], still: [name…]} }
//
// Teardown NEVER fails an approval: a stop command that errors or a process that
// outlives its group is reported on `stopped` (and flagged amber on the step), not
// thrown.
//
// A `stop` is the agent's own words run later by us, so it never gets more power
// than the agent that wrote it: it runs under a seatbelt profile (`stopSandbox`)
// that writes only the worktree, the proof inbox, the job's writableDirs and temp
// (network and sockets stay open, for `docker compose down`), unsandboxed only for
// a Codex job on Full access. With no sandbox to hand it is not run at all.
//
// TODO(host-api processes): there is no façade to signal a process group, run a
// shell command in a worktree or read a log file, so this module uses node's
// child_process, fetch and fs directly (the extension shares the wrangler's
// process and user). The agent's processes run in ITS sandbox; a Codex step the
// sandbox stops from listening answers with couldNot instead (job-prompts.js).

const TERM_WAIT_MS = 2000;
const POLL_MS = 100;
const URL_RECHECKS = 3;
const URL_RECHECK_MS = 700;
const LOG_TAIL_BYTES = 24 * 1024;

export const itemKey = (i) => JSON.stringify([i.name, i.url || null, i.pid || null, i.stop || null]);
export const sameItem = (a, b) => itemKey(a) === itemKey(b);
const live = (items) => (items || []).filter((i) => i && i.name);
export const runningOf = (sub) => live(sub?.running?.items);
export const owedOf = (sub) => live(sub?.running?.owed);
export const hasRunning = (sub) => runningOf(sub).length > 0;

// The review is still open on a round the human has not decided: what keeps the
// agent's preview alive. Approved, dropped, reworked by a plan change, retried,
// cleaned up or its job cancelled all end it.
export const holdsRunning = (job, sub) => !job.cancelledAt && !!sub && !sub.cancelledAt && sub.stage === 'review' && sub.state === 'verified' && !sub.ready?.approvedAt;

// Everything due for teardown now: what a later round dropped, and the whole
// list once the review no longer holds it.
export const dueTeardown = (job, sub) => [...owedOf(sub), ...(holdsRunning(job, sub) ? [] : runningOf(sub))];

export const stopReason = (job, sub) => job.cancelledAt || sub.cancelledAt ? 'dropped' : sub.stage === 'cleanup' || sub.stage === 'done' ? 'cleaned up' : sub.ready?.approvedAt ? 'approved' : sub.stage === 'review' ? 'asked to stop' : 'reworked';

// The receipt's list becomes the sub-job's. A round (or a reply) that no longer
// lists an entry owes its teardown; `keep` false (Code on Auto, or a receipt that
// does not park) owes all of it: nothing is left running when no human will try it.
export function setRunning(sub, items, { round, keep, now }) {
  const prev = runningOf(sub);
  const next = keep ? items : [];
  const owed = [...owedOf(sub), ...prev.filter((p) => !next.some((n) => sameItem(p, n))), ...(keep ? [] : items.filter((n) => !prev.some((p) => sameItem(p, n))))];
  const carried = (n) => prev.find((p) => sameItem(p, n));
  sub.running = { round, at: now, items: next.map((n) => ({ ...n, up: carried(n)?.up ?? null })), owed: owed.filter((o, i) => owed.findIndex((x) => sameItem(x, o)) === i) };
}

// The human's Stop (all, or one by name): the same teardown, asked for.
export function owe(sub, name = null) {
  const items = runningOf(sub);
  const taken = name ? items.filter((i) => i.name === name) : items;
  if (!taken.length) return 0;
  sub.running = { ...sub.running, items: items.filter((i) => !taken.includes(i)), owed: [...owedOf(sub), ...taken.map(({ up: _u, ...i }) => i)] };
  return taken.length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgidOfDefault = (pid) => new Promise((resolve) => execFile('ps', ['-o', 'pgid=', '-p', String(pid)], (err, out) => resolve(err ? null : Number.parseInt(String(out).trim(), 10) || null)));
const aliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const answersDefault = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const sandboxExecDefault = () => process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC) ? SANDBOX_EXEC : null;
export const defaultDeps = () => ({ kill: (pid, sig) => process.kill(pid, sig), alive: aliveDefault, pgidOf: pgidOfDefault, answers: answersDefault, run: runFile, sleep, exists: (p) => fs.existsSync(p), sandboxExec: sandboxExecDefault() });

// Where a sub-job's stop command may write. Seatbelt matches resolved paths
// (/tmp is /private/tmp), so each is realpath'd and a missing one dropped.
export function stopSandbox(job, sub) {
  if (job?.agent === 'codex' && job.sandbox === 'full') return { off: true };
  const dirs = [sub?.worktree?.path, job?.id && sub?.id ? inboxDir(job.id, sub.id) : null, ...(job?.writableDirs || []).map(expandRepo), os.tmpdir(), '/tmp'];
  const real = dirs.filter(Boolean).flatMap((d) => { try { return [fs.realpathSync(d)]; } catch { return []; } });
  return { writable: [...new Set(real)] };
}

// The paths go in as -D parameters, never spliced into the profile text.
const PROFILE_HEAD = '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/") (regex #"^/dev/tty")';
export function stopCommand(stop, sandbox, deps) {
  if (sandbox?.off) return { bin: 'sh', args: ['-c', stop] };
  if (!deps.sandboxExec) return null;
  const writable = sandbox?.writable || [];
  const profile = `${PROFILE_HEAD}${writable.map((_, n) => ` (subpath (param "W${n}"))`).join('')})`;
  return { bin: deps.sandboxExec, args: ['-p', profile, ...writable.flatMap((w, n) => ['-D', `W${n}=${w}`]), 'sh', '-c', stop] };
}

// Whether an entry is up now: its URL answers, else its process is alive; an
// entry with only a stop command has nothing to probe and reads as up.
export async function isUp(item, deps = defaultDeps()) {
  if (item.url) return deps.answers(item.url);
  if (item.pid) return deps.alive(item.pid);
  return true;
}

// The whole of one entry's teardown: its process group (the agent started it with
// setsid, so the pid leads one; a pid that does not lead its own group is killed
// alone, never a group that is not the agent's), then its stop command in the
// worktree (sandboxed, see stopCommand), then a check that its URL stopped
// answering. Never throws.
async function tearOne(item, { cwd, sandbox, deps }) {
  const notes = [];
  let ok = true;
  if (item.pid && item.pid !== process.pid && item.pid !== process.ppid) {
    try {
      const pgid = await deps.pgidOf(item.pid);
      const target = pgid === item.pid ? -item.pid : item.pid;
      if (pgid != null || deps.alive(item.pid)) {
        try { deps.kill(target, 'SIGTERM'); } catch { /* gone already */ }
        for (let waited = 0; waited < TERM_WAIT_MS && deps.alive(item.pid); waited += POLL_MS) await deps.sleep(POLL_MS);
        if (deps.alive(item.pid)) { try { deps.kill(target, 'SIGKILL'); } catch { /* gone */ } await deps.sleep(POLL_MS); }
        notes.push(deps.alive(item.pid) ? `process ${item.pid} would not die` : pgid === item.pid ? `process group ${item.pid} killed` : `process ${item.pid} killed`);
        if (deps.alive(item.pid)) ok = false;
      } else notes.push(`process ${item.pid} already gone`);
    } catch (e) { ok = false; notes.push(`could not kill ${item.pid}: ${String(e?.message || e).split('\n')[0]}`); }
  }
  const cmd = item.stop ? stopCommand(item.stop, sandbox, deps) : null;
  if (item.stop && !cmd) { ok = false; notes.push(`${item.stop} · not run: no sandbox to run it in on this machine`); }
  else if (cmd) {
    try { await deps.run(cmd.bin, cmd.args, cwd && deps.exists(cwd) ? cwd : undefined); notes.push(`${item.stop} · exit 0`); }
    catch (e) { ok = false; notes.push(`${item.stop} · ${e?.code != null ? `exit ${e.code}` : String(e?.message || e).split('\n')[0]}`); }
  }
  if (item.url) {
    let up = await deps.answers(item.url);
    for (let i = 0; up && i < URL_RECHECKS; i++) { await deps.sleep(URL_RECHECK_MS); up = await deps.answers(item.url); }
    if (up) ok = false;
    notes.push(up ? 'still answering' : 'stopped answering');
  }
  return { name: item.name, ok, detail: notes.join(' · ') || 'nothing to stop' };
}

// `sandbox` is stopSandbox(job, sub); left out, a stop may write nowhere.
export async function teardown(items, { cwd = null, sandbox = { writable: [] }, deps = defaultDeps() } = {}) {
  const results = [];
  for (const item of items) results.push(await tearOne(item, { cwd, sandbox, deps }));
  return { results, still: results.filter((r) => !r.ok).map((r) => r.name) };
}

// The tail of the log an entry named, for the board's Logs button. The path is
// the agent's word, so it is read only from under the worktree or the evidence
// inbox, symlinks resolved first.
export function readLog(job, sub, name) {
  const item = [...runningOf(sub), ...owedOf(sub)].find((i) => i.name === name);
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
