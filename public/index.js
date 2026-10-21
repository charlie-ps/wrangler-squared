import { initJobsView } from './jobs-view.js';
import { jobNeedsYou } from './job-state.js';
import { diffReturnTarget } from './diff-return.js';
import { createIntro } from './intro.js';
import { createUpdates } from './updates.js';
import { ICONS } from './icons.js';
import { closeOnBackdrop } from './dialog-backdrop.js';
import { createEarlyAdopterGesture } from './early-adopter.js';

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
//  - "Open session" switched view and selected the card, or sent `resume` for
//    an archived one → `api.openSession(sid)` (host api 1.8) does exactly that
//    on our behalf; the card list `onBoard` reads for the button's label is the
//    graph's `sessions`, kept from the last update(). "Review code in Wrangler"
//    also opened the diff panel and came back to the job when it closed →
//    `api.openDiff(sid, {onClose})` (host api 1.27) opens it, and onClose runs
//    the same diff-return.js decision core's app.js did (reviewDiff below).
//  - `getAgents()` read the board's connect-time `agents` list → `api.agents()`
//    (host api 1.25), the same live-catalog list, read each time New job opens.

const TOAST_MS = 3000;
// A failure is read, not glanced at: it stays until closed or this long.
const ERROR_TOAST_MS = 10000;

// This view's route (agent-wrangler app.js extViewKey). Setting the hash is how
// the diff round trip gets back here: the api can show the grid but no other view.
const VIEW_HASH = '#view=ext:jobs:board';

export default {
  register(slots) {
    let view = null;
    let dialog = null;
    let viewHost = null;
    let toastTimer = null;
    let needsMe = 0;
    let sessions = [];
    let tasks = [];
    let jobs = [];
    let newJobOnMount = false;

    // One toast element at a time, inside the view's own host: the board exposes
    // no toast to an extension, and a host that is display:none while another
    // view is active hides it for free (a top-layer element is still not drawn
    // under a display:none ancestor). Inside #jobs so it wears the theme's
    // scheme. A manual popover puts it in the top layer, above a modal detail,
    // intro or updates dialog and its backdrop, which a z-index never can.
    // textContent, never innerHTML — anything a frame carries is agent-written.
    function toast(text, { error = false } = {}) {
      if (!viewHost) return;
      clearTimeout(toastTimer);
      viewHost.querySelector('.jobs-toast')?.remove();
      const el = document.createElement('div');
      el.className = error ? 'jobs-toast jobs-toast-error' : 'jobs-toast';
      el.setAttribute('role', error ? 'alert' : 'status');
      el.setAttribute('popover', 'manual');
      const body = document.createElement('span');
      body.textContent = text;
      el.appendChild(body);
      const dismiss = () => { clearTimeout(toastTimer); el.remove(); };
      if (error) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'jobs-toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.innerHTML = ICONS.x;
        close.onclick = dismiss;
        el.appendChild(close);
      }
      (viewHost.querySelector('#jobs') || viewHost).appendChild(el);
      try { el.showPopover?.(); } catch {}
      toastTimer = setTimeout(dismiss, error ? ERROR_TOAST_MS : TOAST_MS);
    }
    const toastError = (text) => toast(text, { error: true });

    // Core disarmed the trip when the reader left the grid or picked another
    // card, BEFORE either closed the panel. onClose fires inside those same
    // closes, while the board is still mid-switch, so the check waits a tick and
    // then reads where they ended up: a `#view=` hash or another selected card
    // is somewhere they chose, and is left alone.
    function reviewDiff(api, sid, from) {
      const armed = { sid, jobId: from?.jobId || null, subId: from?.subId || '' };
      api.openDiff(sid, { onClose: () => setTimeout(() => {
        const loc = document.defaultView?.location;
        if (!loc || loc.hash.startsWith('#view=')) return;
        const now = api.selectedSessionId?.();
        if (now && now !== sid) return;
        const target = diffReturnTarget({ armed, closedSid: sid, jobs });
        if (!target) return;
        loc.hash = VIEW_HASH;
        if (target.jobId) view?.openDetail(target.jobId, target.subId);
      }) });
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
        view?.created(msg);
        toast(msg.started ? (msg.idea ? 'Idea sent to Wrangler' : 'Job started — planning') : msg.idea ? 'Idea added to backlog' : 'Job added to backlog');
      } else if (msg.event === 'job-create-failed') {
        toastError(msg.error);
      } else if (msg.event === 'job-action-complete') {
        view?.created(msg);
        // A checkpoint switch says what it did in the footer it was made from, an idea in its own bubble.
        if (msg.action === 'accept-idea') toast('Job created from the idea');
        else if (msg.action === 'dismiss-convo') toast('Conversation dismissed');
        else if (msg.action === 'edit-idea') toast('Idea saved');
        else if (!['set-review', 'request-change', 'idea-reply'].includes(msg.action)) toast('Job updated');
      } else if (msg.event === 'job-action-failed') {
        if (msg.action === 'set-review') view?.reviewFailed(msg);
        else if (!(msg.action === 'request-change' && view?.changeFailed(msg))) { view?.ideaFailed(msg); toastError(msg.error); }
      } else if (msg.event === 'job-images') {
        view?.images(msg);
      } else if (msg.event === 'job-evidence') {
        view?.evidence(msg);
      } else if (msg.event === 'job-running-log') {
        view?.runningLog(msg);
      } else if (msg.event === 'job-ide-opened') {
        toast(`Opened in ${msg.app}`);
      } else if (msg.event === 'job-ide-failed') {
        toastError(msg.error);
      } else if (msg.event?.startsWith('feature-request-')) {
        view?.idea(msg);
      }
    });

    // The intro's last button: New job on the Jobs view. From any other view the
    // hash switches to Jobs and the form opens once mount() has built it.
    function startJob() {
      const loc = document.defaultView?.location;
      if (loc && loc.hash !== VIEW_HASH) loc.hash = VIEW_HASH;
      if (view) view.newJob();
      else newJobOnMount = true;
    }

    // Built from the REGISTRAR's api (host api 1.14), not mount()'s, so a reader
    // who has never seen it gets it on whatever view the board opens on — the
    // intro is what tells them the Jobs button exists. Same storage object either
    // way: the board builds one api per extension.
    // A first-run reader gets the intro and never an update splash on top of it;
    // the intro already shows Jobs as it is today, so closing it counts every
    // current update as seen. Anyone else gets their unseen updates, but only on
    // the Jobs view: they announce Jobs features, so they wait until the reader
    // opens it. Core mirrors the active view into the hash, and the view host is
    // mounted whether or not it is showing, so the hash is the signal.
    const updates = createUpdates({ storage: slots.api?.storage });
    let firstRun = false;
    const intro = createIntro({ storage: slots.api?.storage, onNewJob: startJob, onClose: () => { if (firstRun) updates.markAllSeen(); firstRun = false; } });
    firstRun = intro.maybeShow();
    const win = document.defaultView;
    const showUpdates = () => {
      if (firstRun || win?.location.hash !== VIEW_HASH) return;
      if (updates.maybeShow()) win.removeEventListener('hashchange', showUpdates);
    };
    win?.addEventListener('hashchange', showUpdates);
    showUpdates();

    // Kept across mounts, so a chain of swaps survives a view switch.
    const earlyAdopter = createEarlyAdopterGesture(slots.api);

    slots.register('view', {
      id: 'board',
      label: 'Jobs',
      icon: ICONS.jobs,
      mount(el, api) {
        // jobs-view.js finds both by id, as it did in core's index.html. The
        // dialog goes on <body>, not in the host: a <dialog> under a display:none
        // ancestor cannot showModal(), and the host is hidden whenever another
        // view is active.
        el.innerHTML = '<section id="jobs" aria-label="Wrangler²"></section>';
        viewHost = el;
        dialog = document.createElement('dialog');
        dialog.id = 'job-dialog';
        dialog.className = 'job-dialog';
        dialog.setAttribute('aria-label', 'Job details');
        document.body.appendChild(dialog);
        closeOnBackdrop(dialog);
        view = initJobsView({
          send: api.send,
          stageImage: (file) => api.images.stage(file),
          getAgents: () => api.agents(),
          getTasks: () => tasks,
          // Core answered "is this card on the board right now" off the graph's
          // session list, and so do we: on it → "Open session" selects the card,
          // off it → "Restore session" and openSession resumes it first.
          onBoard: (sid) => sessions.some((s) => s.sessionId === sid),
          onSession: (sid) => api.openSession(sid),
          files: api.files,
          onOpenFile: (path) => api.openFile(path),
          onDiff: (sid, from) => reviewDiff(api, sid, from),
          onIntro: () => intro.open(0),
          onThemeChoice: (choice) => earlyAdopter.note(choice),
          updates,
          storage: api.storage,
          toast,
          toastError,
        });
        if (newJobOnMount) { newJobOnMount = false; view.newJob(); }
      },
      update(el, session, graph) {
        if (!graph?.jobs) return;
        sessions = graph.sessions || [];
        jobs = graph.jobs.jobs || [];
        tasks = graph.tasks?.tasks || [];
        // The rail count is every job that needs a human, NOT the subset the
        // view is currently drawing: its filter, Needs me and Show finished are
        // one human's view of the board, while the badge is what is waiting
        // from any view. Counted here rather than inside badge() because this
        // is the only place the graph is handed to us, and core reads the badge
        // in the same syncHosts pass that has just called update.
        needsMe = graph.jobs.jobs.filter(jobNeedsYou).length;
        if (!view) return;
        view.update(graph.jobs);
      },
      // What core's `<span id="jobs-nav-badge">` in index.html did when core
      // owned Jobs: the needs-you count on the rail button, visible from any
      // view. Core evaluates this on every graph tick and draws or hides its own
      // span (agent-wrangler public/slots.js syncHosts); 0 draws nothing. Host
      // API 1.7 is where core started calling it; the manifest's pin (now
      // `^1.27.0`, for api.openDiff) is not for this — a board that spreads the
      // key without reading it only loses the count.
      badge: () => needsMe,
      unmount() {
        clearTimeout(toastTimer);
        dialog?.remove();
        dialog = null;
        view = null;
        viewHost = null;
        needsMe = 0;
        sessions = [];
        tasks = [];
        jobs = [];
      },
    });
  },
};
