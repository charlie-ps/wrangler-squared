import { execFile as defaultExecFile } from 'node:child_process';
import { access as defaultAccess } from 'node:fs/promises';
import { kick, makeCreateJob } from './job-create.js';
import { settingsSchema } from './jobs-schema.js';

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

export const jobActionHandler = {
  type: 'job-action',
  async handler(msg, host) {
    const ids = { jobId: msg.id, action: msg.action, ...(msg.subJobId ? { subJobId: msg.subJobId } : {}) };
    // A refusal goes out as a frame rather than a throw, which never reaches the
    // board: the footer's checkpoint buttons snap back and say why.
    try { host.stores.jobs.action(msg.id, msg.action, msg); } catch (e) {
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

export const HANDLERS = [jobCreateHandler, jobActionHandler, jobSettingsHandler, jobOpenIdeHandler, jobImagesHandler];
