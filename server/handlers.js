import { kick } from './tools.js';

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
    const job = host.stores.jobs.create(msg.job);
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

// "Open session" / "Restore session" from the Jobs view. Core's client did this
// itself — `setView('grid')`, `selectSession(sid)` or `send({type:'resume'})` —
// but an extension's client `send` is bound to ITS OWN handler types, so it
// cannot send the core `resume` frame, and the client api has no navigation. The
// server half can at least wake a dormant card (`sessions:wake`, logged as
// reason=ext:jobs); selecting it on the board is left to the human.
// TODO(host-api client navigation): an `api.openSession(sid)` / `api.openDiff(sid)`
// on the client façade would restore the round trip core had (diff-return.js).
export const jobOpenSessionHandler = {
  type: 'job-open-session',
  async handler(msg, host) {
    const s = host.sessions.get(msg.sessionId);
    if (!s) throw new Error('Session not found');
    if (s.archived) await host.sessions.wake(msg.sessionId);
  },
};

export const HANDLERS = [jobCreateHandler, jobActionHandler, jobSettingsHandler, jobOpenSessionHandler];
