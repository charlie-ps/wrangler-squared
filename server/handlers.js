import { execFile as defaultExecFile } from 'node:child_process';
import { access as defaultAccess } from 'node:fs/promises';
import { kick, makeCreateJob } from './job-create.js';
import { settingsSchema } from './jobs-schema.js';
import { runFile } from './job-github.js';
import { thumbnailOf, readEvidence, keepAskImages } from './job-evidence.js';
import { workingTreeHash } from './git.js';
import { TREE_MOVED } from './job-store.js';
import { readLog } from './job-running.js';

// Control-WS handlers in the EXTENSION signature: `handler(msg, host)` — no
// `ctx`, and therefore no `ctx.reply`. Core's control/handlers/jobs.js replied
// `job-created` / `job-action-complete` so the board could close its dialog and
// toast; the façade's `board:broadcast` is the only outbound channel here, and
// its `type` is forced to `ext:jobs`, which the board hands to this extension's
// own client module (`onMessage`, public/index.js) — same dialog close and
// toast, addressed by the forced type rather than by a reply.
//
// The types below are what `graph.extensions[].handlerTypes` announces, and what
// the client façade's `send` is bound to — a frame of any other type is dropped
// browser-side before it is sent.

export function makeJobCreateHandler(deps) {
  const createJob = makeCreateJob(deps);
  return {
    type: 'job-create',
    async handler(msg, host) {
      let job;
      try {
        job = await createJob(host, msg);
      } catch (e) {
        host.broadcast({ event: 'job-create-failed', error: e?.issues?.[0]?.message || e?.message || String(e) });
        return;
      }
      host.broadcast({ event: 'job-created', jobId: job.id, started: Boolean(msg.start) });
    },
  };
}
export const jobCreateHandler = makeJobCreateHandler();

// The two actions that need something only an async read can give: the tree as
// it is NOW (approve-code is pinned to the one the agent reported) and the
// pictures pasted into an idea, kept beside the round they were sent in (or the
// job's or step's own ideas folder when no round holds it). Whatever the client
// sent under these names is discarded.
export const ASK_IMAGES_MAX = 4;
async function prepare(msg, host) {
  const { treeHash: _t, attachments: _a, ...clean } = msg;
  const job = host.stores.jobs.get(msg.id);
  const sub = job?.subJobs.find((s) => s.id === msg.subJobId);
  if (msg.action === 'approve-code' && sub?.ready?.treeHash && sub.worktree?.path) {
    return { ...clean, treeHash: await workingTreeHash(sub.worktree.path).catch(() => null) };
  }
  if (msg.action === 'request-change' && Array.isArray(msg.images) && msg.images.length && job) {
    const names = msg.images.filter((n) => typeof n === 'string').slice(0, ASK_IMAGES_MAX);
    const got = names.map((n) => host.images.read(n)).filter(Boolean);
    const kept = keepAskImages({ jobId: job.id, subId: sub?.id, round: sub?.ready?.round, messageId: Date.now().toString(36), images: got });
    for (const n of names) host.images.remove(n);
    return { ...clean, attachments: kept.map(({ file, mime, path }) => ({ file, mime, path })) };
  }
  return clean;
}

export const jobActionHandler = {
  type: 'job-action',
  async handler(raw, host) {
    const msg = await prepare(raw, host);
    const ids = { jobId: msg.id, action: msg.action, ...(msg.subJobId ? { subJobId: msg.subJobId } : {}) };
    // A refusal goes out as a frame rather than a throw, which never reaches the
    // board: the footer's checkpoint buttons snap back and say why.
    try { host.stores.jobs.action(msg.id, msg.action, msg); } catch (e) {
      // The tree moved under the approval: the parked session is asked to report
      // ready again (job-parked.js), and the human is told why nothing happened.
      if (e?.code === TREE_MOVED) { try { host.stores.jobs.action(msg.id, 'tree-moved', msg); await host.rebuild(); kick(host).catch(() => {}); } catch { /* the refusal below still says it */ } }
      host.broadcast({ event: 'job-action-failed', ...ids, ...(msg.field ? { field: msg.field } : {}), error: e?.message || String(e) });
      return;
    }
    await host.rebuild();
    host.broadcast({ event: 'job-action-complete', ...ids });
    kick(host).catch((e) => host.log('job-action tick failed', e));
  },
};

export const jobSettingsHandler = {
  type: 'job-settings',
  async handler(msg, host) {
    host.stores.jobs.settings(msg.patch);
    await host.rebuild();
  },
};

// "Review code in <IDE>" from the sub-job dialog: hand the worktree to the
// desktop IDE as a project, so the review surface is its Git tool window (the
// branch's changes against main, uncommitted work included). macOS `open -na`
// only — the wrangler runs on the reviewer's own Mac, and `open` is the one
// launcher that finds an app by name without a PATH or a shell; the app name is
// the `ideApp` setting. Success and failure both go out as broadcasts rather
// than a throw, because a thrown handler error never reaches the board and the
// human is looking at the dialog waiting for a window to appear.
export function makeOpenIdeHandler({ execFile = defaultExecFile, access = defaultAccess, platform = process.platform } = {}) {
  const launch = (app, dir) => new Promise((resolve, reject) => {
    execFile('open', ['-na', app, '--args', dir], (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
  return {
    type: 'job-open-ide',
    async handler(msg, host) {
      const job = host.stores.jobs.get(msg.id);
      const sub = job?.subJobs.find((s) => s.id === msg.subJobId);
      // Settings written before `ideApp` existed lack it until the next settings
      // save re-parses them, so the default is applied on read too.
      const { ideApp } = settingsSchema.parse(host.stores.jobs.snapshot().settings);
      const fail = (error) => host.broadcast({ event: 'job-ide-failed', jobId: msg.id, subJobId: msg.subJobId, app: ideApp, error });
      if (!sub) return fail('Sub-job not found');
      if (!sub.worktree?.path) return fail('This sub-job has no worktree yet');
      if (platform !== 'darwin') return fail('Opening an IDE is only supported on macOS');
      try { await access(sub.worktree.path); } catch { return fail(`Worktree no longer exists: ${sub.worktree.path}`); }
      try { await launch(ideApp, sub.worktree.path); } catch (e) { return fail(`Could not open ${ideApp}: ${e.message}`); }
      host.broadcast({ event: 'job-ide-opened', jobId: msg.id, subJobId: msg.subJobId, app: ideApp });
    },
  };
}
export const jobOpenIdeHandler = makeOpenIdeHandler();

// The job dialog's thumbnail strip. A job's pictures live in the extension's own
// store (`images:keep`) and nothing serves that store to a browser, so the bytes
// ride the one outbound channel there is. Asked once per job per dialog, and a
// name the store has lost is simply absent.
export const jobImagesHandler = {
  type: 'job-images',
  handler(msg, host) {
    const job = host.stores.jobs.get(msg.id);
    const images = (job?.images || []).flatMap((name) => {
      const got = host.images.read(name);
      return got ? [{ name, mime: got.mime, dataBase64: Buffer.from(got.bytes).toString('base64') }] : [];
    });
    host.broadcast({ event: 'job-images', jobId: msg.id, images });
  },
};

// The proof a Code review step shows (job-evidence.js). Nothing serves the
// extension's files to a browser (TODO(host-api files:serve)), so they ride the
// one outbound channel there is, like the job's images: the round's THUMBNAILS
// when the dialog or board asks, one full file when a shot is opened. `round`
// defaults to the sub-job's current one. A missing or unreadable file is simply
// absent; the grid draws a placeholder.
export function makeEvidenceHandler({ run = runFile } = {}) {
  return {
    type: 'job-evidence',
    async handler(msg, host) {
      const job = host.stores.jobs.get(msg.id);
      const sub = job?.subJobs.find((s) => s.id === msg.subJobId);
      if (!sub) return;
      const round = Number.isInteger(msg.round) ? msg.round : sub.ready?.round;
      const base = { event: 'job-evidence', jobId: msg.id, subJobId: sub.id, round };
      if (!round) return host.broadcast({ ...base, thumbs: [] });
      if (msg.file) {
        const got = readEvidence({ jobId: job.id, subId: sub.id, round, file: msg.file });
        return host.broadcast({ ...base, file: msg.file, ...(got ? { mime: got.mime, dataBase64: Buffer.from(got.bytes).toString('base64') } : {}) });
      }
      const inThread = (sub.thread || []).filter((m) => m.round === round).flatMap((m) => [...(m.shots || []), ...(m.images || [])].map((s) => s.file));
      const files = [...new Set([...((sub.ready?.round === round ? sub.ready : sub.earlier?.find((e) => e.round === round))?.proof || []).flatMap((p) => (p.shots || []).map((s) => s.file)), ...inThread])];
      const thumbs = (await Promise.all(files.map(async (file) => {
        const t = await thumbnailOf({ jobId: job.id, subId: sub.id, round, file, run });
        return t ? { file, mime: t.mime, dataBase64: Buffer.from(t.bytes).toString('base64') } : null;
      }))).filter(Boolean);
      host.broadcast({ ...base, thumbs });
    },
  };
}
export const jobEvidenceHandler = makeEvidenceHandler();

// The Logs button on the Running for you bar: the tail of the file the agent sent
// its process output to (job-running.js readLog decides what may be read). An
// answer or a reason goes out as a frame; the board shows it under the bar.
export const jobRunningLogsHandler = {
  type: 'job-running-logs',
  handler(msg, host) {
    const job = host.stores.jobs.get(msg.id);
    const sub = job?.subJobs.find((s) => s.id === msg.subJobId);
    const got = sub ? readLog(job, sub, String(msg.name || '')) : { error: 'Sub-job not found' };
    host.broadcast({ event: 'job-running-log', jobId: msg.id, subJobId: msg.subJobId, name: msg.name, ...got });
  },
};

// The board's "Have an idea?" corner: a request becomes a PUBLIC issue on this
// repo, filed by the reader's own `gh` login so it is theirs to follow. Title and
// body travel as argv items through execFile, never a shell. `rid` is echoed so
// only the tab that asked acts on the answer; every board tab gets the frame.
export const FEATURE_REPO = 'charlie-ps/wrangler-squared';
const FEATURE_LABEL = 'feature-request';
const ISSUE_URL = new RegExp(`^https://github\\.com/${FEATURE_REPO}/issues/(\\d+)$`);
// gh exits 4 when it needs `gh auth login`; older builds only say so in stderr.
const ghFailure = (e) => {
  if (e?.code === 'ENOENT') return { reason: 'missing', error: 'The GitHub CLI (gh) is not installed' };
  const said = String(e?.stderr || e?.message || e).trim();
  if (e?.code === 4 || /gh auth login|not logged in|authentication required|HTTP 401/i.test(said)) return { reason: 'auth', error: 'The GitHub CLI is not signed in' };
  return { reason: 'error', error: said.split('\n').find(Boolean) || 'gh failed' };
};
export function makeFeatureRequestHandlers({ run = runFile } = {}) {
  return [{
    type: 'feature-request-whoami',
    async handler(msg, host) {
      try {
        const login = await run('gh', ['api', 'user', '--jq', '.login']);
        host.broadcast({ event: 'feature-request-gh', rid: msg.rid, login });
      } catch (e) { host.broadcast({ event: 'feature-request-gh', rid: msg.rid, ...ghFailure(e) }); }
    },
  }, {
    type: 'feature-request',
    async handler(msg, host) {
      const fail = (f) => host.broadcast({ event: 'feature-request-failed', rid: msg.rid, ...f });
      const title = String(msg.title || '').trim().slice(0, 120);
      if (!title) return fail({ reason: 'error', error: 'Give the idea a title' });
      const body = `${String(msg.body || '').trim().slice(0, 4000)}\n\n---\n_Sent from the Wrangler² Jobs board._`.trimStart();
      const args = ['issue', 'create', '-R', FEATURE_REPO, '--title', title, '--body', body];
      // Labelled only when the repo already has the label; a reader without
      // triage rights may still be refused it, so that attempt falls back to none.
      const labels = await run('gh', ['label', 'list', '-R', FEATURE_REPO, '--json', 'name', '--limit', '200']).then((out) => JSON.parse(out).map((l) => l.name), () => []);
      let out;
      try {
        try { out = await run('gh', labels.includes(FEATURE_LABEL) ? [...args, '--label', FEATURE_LABEL] : args); } catch (e) {
          if (!labels.includes(FEATURE_LABEL) || ghFailure(e).reason !== 'error') throw e;
          out = await run('gh', args);
        }
      } catch (e) { return fail(ghFailure(e)); }
      const url = String(out).trim().split('\n').at(-1);
      const number = url.match(ISSUE_URL)?.[1];
      if (!number) return fail({ reason: 'error', error: `gh did not return an issue link: ${url}` });
      host.broadcast({ event: 'feature-request-created', rid: msg.rid, url, number: Number(number), title });
    },
  }];
}

export const HANDLERS = [jobCreateHandler, jobActionHandler, jobSettingsHandler, jobOpenIdeHandler, jobImagesHandler, jobEvidenceHandler, jobRunningLogsHandler, ...makeFeatureRequestHandlers()];
