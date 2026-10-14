import { ICONS } from './icons.js';

// What's new: a splash for each bigger release, shown once per browser, and the
// list Automation settings reads to show any of them again. Seen ids live in the
// client api's namespaced `storage` beside the intro's flag, so like the intro it
// is per browser rather than per install. Every string here is our own copy.
export const SEEN_UPDATES_KEY = 'updatesSeen';

// Oldest first; append a release's entry at the end. `date` is YYYY-MM-DD and
// `body` is our own HTML. Optional: `icon` (an ICONS key) and `tone` for the
// settings row, `figure(phase)` drawn above the title, and `anim` ({ frames, ms,
// still }) to redraw it every `ms`, holding `still` with reduced motion.
export const UPDATES = [];

const W2 = 'WRANGLER<sup>2</sup>';
const dateLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// `storage` is null in a test or on a board without it: then nothing opens by
// itself, since nothing could record that it had been seen.
export function createUpdates({ storage, updates = UPDATES }) {
  const ordered = [...updates].sort((a, b) => a.date.localeCompare(b.date));
  let dialog = null;
  let queue = [];
  let at = 0;
  let phase = 0;
  let timer = null;
  const win = () => document.defaultView;
  const still = () => !win() || !!win().matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function seen() {
    try { const ids = JSON.parse(storage?.get(SEEN_UPDATES_KEY) || '[]'); return new Set(Array.isArray(ids) ? ids : []); } catch { return new Set(); }
  }
  function markSeen(ids) {
    if (!storage) return;
    const all = seen();
    ids.forEach((id) => all.add(id));
    storage.set(SEEN_UPDATES_KEY, JSON.stringify([...all]));
  }
  const unseen = () => { const s = seen(); return ordered.filter((u) => !s.has(u.id)); };

  function build() {
    dialog = document.createElement('dialog');
    dialog.id = 'jobs-update';
    dialog.className = 'job-dialog jobs-update';
    dialog.setAttribute('aria-labelledby', 'jobs-update-title');
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>
      <div class="update-appbar"><span class="jobs-kicker">${W2} · WHAT’S NEW</span><time class="update-date"></time><span class="intro-count"></span></div>
      <div class="update-panel"></div>
      <div class="job-actions"><button class="primary" data-update="next"></button><button data-update="back">${ICONS.back}Back</button></div>`;
    document.body.appendChild(dialog);
    const go = (i) => { at = Math.max(0, Math.min(queue.length - 1, i)); phase = queue[at].anim && still() ? queue[at].anim.still ?? 0 : 0; render(); };
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
    dialog.querySelector('[data-update="back"]').onclick = () => go(at - 1);
    dialog.querySelector('[data-update="next"]').onclick = () => (at < queue.length - 1 ? go(at + 1) : dialog.close());
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && at < queue.length - 1) go(at + 1);
      if (e.key === 'ArrowLeft' && at > 0) go(at - 1);
    });
    // Every way out, from any update in the run, is the reader having seen the
    // whole run; a reload while it is still open is not.
    dialog.addEventListener('close', () => { stop(); markSeen(queue.map((u) => u.id)); });
  }

  function render() {
    const u = queue[at];
    const last = at === queue.length - 1;
    const date = dialog.querySelector('.update-date');
    date.dateTime = u.date;
    date.textContent = dateLabel(u.date);
    dialog.querySelector('.intro-count').textContent = queue.length > 1 ? `${at + 1} of ${queue.length}` : '';
    dialog.querySelector('.update-panel').innerHTML = `${u.figure ? `<div class="intro-figure">${u.figure(phase)}</div>` : ''}<h2 id="jobs-update-title">${u.title}</h2><div class="update-body">${u.body}</div>`;
    const next = dialog.querySelector('[data-update="next"]');
    next.className = `primary tone-${last ? 'ok' : 'run'}`;
    next.innerHTML = last ? 'Got it' : `Next${ICONS.next}`;
    dialog.querySelector('[data-update="back"]').hidden = at === 0;
    play();
  }

  function play() {
    stop();
    const u = queue[at];
    if (!u.anim || still()) return;
    timer = win().setInterval(() => {
      phase = (phase + 1) % u.anim.frames;
      const fig = dialog.querySelector('.update-panel .intro-figure');
      if (fig) fig.innerHTML = u.figure(phase);
    }, u.anim.ms);
  }
  function stop() { if (timer) win()?.clearInterval(timer); timer = null; }

  function show(list) {
    if (!list.length) return false;
    if (!dialog || !dialog.isConnected) build();
    queue = list;
    at = 0;
    phase = list[0].anim && still() ? list[0].anim.still ?? 0 : 0;
    render();
    if (!dialog.open) dialog.showModal();
    return true;
  }

  return {
    // Newest first, for What's new.
    list() { const s = seen(); return [...ordered].reverse().map((u) => ({ ...u, seen: s.has(u.id) })); },
    open(id) { return show(ordered.filter((u) => u.id === id)); },
    // Every unseen update in one run, oldest first, so a reader a few releases
    // behind steps through them in the order they shipped.
    maybeShow() { return storage ? show(unseen()) : false; },
    markAllSeen() { markSeen(ordered.map((u) => u.id)); },
    remove() { stop(); dialog?.remove(); dialog = null; },
  };
}

// The What's new section of Automation settings: each row reopens its splash.
export function whatsNewHtml(items) {
  const rows = items.map((u) => `<li><button type="button" class="update-item tone-${u.tone || 'run'}" data-update-id="${u.id}"><span class="job-node-tile">${ICONS[u.icon] || ICONS.info}</span><span class="update-item-text"><strong>${u.title}</strong><time datetime="${u.date}">${dateLabel(u.date)}</time></span><span class="update-item-end">${u.seen ? '' : '<span class="update-new">NEW</span>'}${ICONS.next}</span></button></li>`).join('');
  return `<section class="update-section" aria-labelledby="job-settings-updates"><h3 id="job-settings-updates">What’s new</h3>${rows ? `<ul class="update-list">${rows}</ul>` : '<p class="update-empty">Nothing here yet. When a release adds something bigger, it opens once on its own and stays listed here.</p>'}</section>`;
}
