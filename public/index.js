import { initJobsView } from './jobs-view.js';
import { jobCards, jobNeedsReview } from './jobs.js';

// The client half: one `view` slot contribution (agent-wrangler public/slots.js),
// which the board draws a rail button, a `#view=ext:jobs:board` route and a
// full-width host for. Served from /ext/jobs/, so sibling imports resolve under
// that prefix; nothing here imports the board's modules (public/util.js).
//
// What core's app.js did around the view and what stands in for it here:
//  - `jobsView.update(graph.jobs)` on every graph  → update(el, session, graph).
//  - `job-created` / `job-action-complete` replies closed the dialog and toasted
//    → the server's `host.broadcast` reaches us as an `ext:jobs` frame through
//    the registrar's `onMessage`, so the dialog closes on the reply again; the
//    toast is drawn in the view's own host because the board's is app.js-private.
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

const TOAST_MS = 3000;

export default {
  register(slots) {
    let view = null;
    let dialog = null;
    let viewHost = null;
    let toastTimer = null;
    let needsMe = 0;

    // One toast element at a time, inside the view's own host: the board exposes
    // no toast to an extension, and a host that is display:none while another
    // view is active hides it for free. textContent, never innerHTML — anything
    // a frame carries is agent-written.
    function toast(text) {
      if (!viewHost) return;
      clearTimeout(toastTimer);
      viewHost.querySelector('.jobs-toast')?.remove();
      const el = document.createElement('div');
      el.className = 'jobs-toast';
      el.setAttribute('role', 'status');
      el.textContent = text;
      viewHost.appendChild(el);
      toastTimer = setTimeout(() => el.remove(), TOAST_MS);
    }

    // Subscribed on the REGISTRAR, not in mount(): a subscription taken here is
    // taken exactly once per module load, so it can neither double up nor be
    // lost while the view is unmounted (the board tears a view's host down when
    // another view is active, and a frame that arrives then should still close
    // the dialog). Optional because the manifest accepts host api ^1.0.0 while
    // `onMessage` landed in 1.4 — an older board simply never delivers.
    // The redraw is left to the next graph tick: the server rebuilt before it
    // broadcast, and the frame carries only ids, not the new snapshot.
    slots.onMessage?.((msg) => {
      if (msg.event === 'job-created') {
        view?.created();
        toast(msg.started ? 'Job started — planning' : 'Job added to backlog');
      } else if (msg.event === 'job-action-complete') {
        view?.created();
        toast('Job updated');
      } else if (msg.event === 'job-ide-opened') {
        toast(`Opened in ${msg.app}`);
      } else if (msg.event === 'job-ide-failed') {
        toast(msg.error);
      }
    });

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
        viewHost = el;
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
        if (!graph?.jobs) return;
        // The rail count is every job that needs a human, NOT the subset the
        // view is currently drawing: its filter, Needs me and Show finished are
        // one human's view of the board, while the badge is what is waiting
        // from any view. Counted here rather than inside badge() because this
        // is the only place the graph is handed to us, and core reads the badge
        // in the same syncHosts pass that has just called update.
        needsMe = jobCards(graph.jobs.jobs).filter((c) => jobNeedsReview(c.job, c.sub)).length;
        if (!view) return;
        view.update(graph.jobs);
      },
      // What core's `<span id="jobs-nav-badge">` in index.html did when core
      // owned Jobs: the needs-you count on the rail button, visible from any
      // view. Core evaluates this on every graph tick and draws or hides its own
      // span (agent-wrangler public/slots.js syncHosts); 0 draws nothing. The
      // manifest's `^1.4.0` is deliberately NOT bumped for it — a board older
      // than the badge simply spreads an unknown contribution key and ignores
      // it, so the only thing lost is the count, and refusing to boot the whole
      // extension over a rail decoration is the worse trade.
      badge: () => needsMe,
      unmount() {
        clearTimeout(toastTimer);
        dialog?.remove();
        dialog = null;
        view = null;
        viewHost = null;
        needsMe = 0;
      },
    });
  },
};
