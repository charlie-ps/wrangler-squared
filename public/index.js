import { initJobsView } from './jobs-view.js';

// The client half: one `view` slot contribution (agent-wrangler public/slots.js),
// which the board draws a rail button, a `#view=ext:jobs:board` route and a
// full-width host for. Served from /ext/jobs/, so sibling imports resolve under
// that prefix; nothing here imports the board's modules (public/util.js).
//
// What core's app.js did around the view and what stands in for it here:
//  - `jobsView.update(graph.jobs)` on every graph  → update(el, session, graph).
//  - `job-created` / `job-action-complete` replies closed the dialog and toasted
//    → the server's `ext:jobs` broadcast is not routed to a client module yet
//    (TODO(host-api client broadcast)), so the dialog is closed when the next
//    graph shows the new job, and there is no toast.
//  - "Open session" / "Review code in Wrangler" switched view, selected the card
//    or opened the diff panel → the api has no navigation, so both send
//    `job-open-session` (wakes a dormant card server-side) and the human picks
//    the card on the board. TODO(host-api client navigation).
//  - `getAgents()` read the board's connect-time `agents` list → not on the api;
//    the two adapters' model vocabularies are mirrored below until
//    TODO(host-api agents:read) — they WILL drift, which is exactly what the
//    wrangler's "one source for the model vocabulary" rule forbids, so treat this
//    constant as a placeholder, not a design.
const AGENTS = [
  { id: 'claude', label: 'Claude', models: [
    { value: 'fable', label: 'Fable 5 · 1M context' }, { value: 'opus', label: 'Opus 5 · 1M context', default: true },
    { value: 'opusplan', label: 'Opus plan · Sonnet execution' }, { value: 'sonnet', label: 'Sonnet 5 · 200K context' },
    { value: 'sonnet[1m]', label: 'Sonnet 5 · 1M context' }, { value: 'haiku', label: 'Haiku 4.5 · 200K context' },
  ] },
  { id: 'codex', label: 'Codex', models: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · capable', default: true }, { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · everyday coding' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · fast & cheap' }, { value: 'gpt-5.5', label: 'GPT-5.5 · capable' },
    { value: 'gpt-5.4', label: 'GPT-5.4 · everyday coding' }, { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini · fast & cheap' },
  ] },
];

const ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5 8h2M11 11h2M17 8h2"/></svg>';

export default {
  register(slots) {
    let view = null;
    let dialog = null;
    let knownJobs = null;
    slots.register('view', {
      id: 'board',
      label: 'Jobs',
      icon: ICON,
      mount(el, api) {
        // jobs-view.js finds both by id, as it did in core's index.html. The
        // dialog goes on <body>, not in the host: a <dialog> under a display:none
        // ancestor cannot showModal(), and the host is hidden whenever another
        // view is active.
        el.innerHTML = '<section id="jobs" aria-label="Automated jobs"></section>';
        dialog = document.createElement('dialog');
        dialog.id = 'job-dialog';
        dialog.className = 'job-dialog';
        dialog.setAttribute('aria-label', 'Job details');
        document.body.appendChild(dialog);
        view = initJobsView({
          send: api.send,
          getAgents: () => AGENTS,
          // Core answered "is this card on the board right now" off its session
          // list; the api exposes only the selected id, so every session reads as
          // off-board and the button says Restore. Harmless: the handler wakes
          // only an archived card.
          onBoard: () => false,
          onSession: (sid) => api.send({ type: 'job-open-session', sessionId: sid }),
          onDiff: (sid) => api.send({ type: 'job-open-session', sessionId: sid }),
        });
      },
      update(el, session, graph) {
        if (!view || !graph?.jobs) return;
        // Stand-in for the `job-created` reply: a job that was not in the last
        // snapshot has just been created from the open form, so close it.
        const ids = new Set((graph.jobs.jobs || []).map((j) => j.id));
        if (knownJobs && [...ids].some((id) => !knownJobs.has(id))) view.created();
        knownJobs = ids;
        view.update(graph.jobs);
      },
      unmount() {
        dialog?.remove();
        dialog = null;
        view = null;
        knownJobs = null;
      },
    });
  },
};
