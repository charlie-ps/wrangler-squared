import { execFile as defaultExecFile } from 'node:child_process';
import { access as defaultAccess } from 'node:fs/promises';
import { kick } from './tools.js';
import { jobInputSchema, line, settingsSchema } from './jobs-schema.js';

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
export const jobCreateHandler = {
  type: 'job-create',
  async handler(msg, host) {
    let job;
    try {
      const input = jobInputSchema.parse(msg.job);
      let taskId = input.taskId;
      if (msg.newTaskName !== undefined) {
        if (taskId) throw new Error('Choose an existing task or create a new one, not both');
        if (typeof msg.newTaskName !== 'string') throw new Error('Enter a task name of up to 180 characters on one line');
        const name = msg.newTaskName.trim();
        if (!name) throw new Error('Enter a name for the new task');
        if (!line.safeParse(name).success) throw new Error('Enter a task name of up to 180 characters on one line');
        taskId = host.tasks.create({ name }).id;
      } else if (taskId) {
        const task = host.tasks.get(taskId);
        if (!task || task.archived) throw new Error('The selected task is no longer available');
      }
      job = host.stores.jobs.create({ ...input, taskId });
    } catch (e) {
      host.broadcast({ event: 'job-create-failed', error: e?.issues?.[0]?.message || e?.message || String(e) });
      return;
    }
    if (msg.start) host.stores.jobs.action(job.id, 'start', {});
    await host.rebuild();
    host.broadcast({ event: 'job-created', jobId: job.id, started: Boolean(msg.start) });
    if (msg.start) kick(host).catch((e) => host.log('job-create tick failed', e));
  },
};

export const jobActionHandler = {
  type: 'job-action',
  async handler(msg, host) {
    host.stores.jobs.action(msg.id, msg.action, msg);
    await host.rebuild();
    host.broadcast({ event: 'job-action-complete', jobId: msg.id });
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

export const HANDLERS = [jobCreateHandler, jobActionHandler, jobSettingsHandler, jobOpenIdeHandler];
