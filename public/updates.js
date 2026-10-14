import { ICONS } from './icons.js';

// What's new: a splash for each bigger release, shown once per browser, and the
// list Automation settings reads to show any of them again. Seen ids live in the
// client api's namespaced `storage` beside the intro's flag, so like the intro it
// is per browser rather than per install. Every string here is our own copy.
export const SEEN_UPDATES_KEY = 'updatesSeen';

const W2 = 'WRANGLER<sup>2</sup>';
const done = (items) => `<ul class="intro-done">${items.map((t) => `<li>${ICONS.check}<span>${t}</span></li>`).join('')}</ul>`;

// The Writes figures, in the job graph's own vocabulary (job-state.js tones,
// job-graph.js place pills): [tone, state glyph, solid tile].
const ST = { queued: ['idle', 'planned', false], running: ['run', 'spin', true], review: ['warn', 'eye', true], done: ['ok', 'check', true] };
const tile = (state, icon) => `<span class="job-node-tile${ST[state][2] ? ' on' : ''}">${ICONS[icon]}<span class="job-node-state">${ICONS[ST[state][1]]}</span></span>`;
const node = (state, icon, title, line) => `<div class="job-node tone-${ST[state][0]}">${tile(state, icon)}<strong class="job-node-title">${title}</strong><span class="job-status">${line}</span></div>`;
// Dashed until the place exists, a dot per write, amber while one waits on you.
const pill = (icon, label, state, exists) => `<span class="job-place-chip${exists ? '' : ' ghost'}${state === 'review' ? ' tone-warn urgent' : ''}">${ICONS[icon]}<b>${label}</b><span class="job-place-dots"><span class="job-place-dot tone-${ST[state][0]}${ST[state][2] ? ' on' : ''}"></span></span>${exists ? '<span class="job-place-go">↗</span>' : ''}</span>`;
const scenes = (frames) => frames.reduce((acc, f) => [...acc, { ...acc.at(-1), ...f }], []);

const DESIGN = scenes([
  { s: ['running', 'Designing'], art: ['queued', false], tix: ['running', false], h: ['queued', 'After the design'], pr: ['queued', 'After you approve'], view: 'none', note: 'none' },
  { tix: ['done', true], art: ['running', false], view: 'draft' },
  { s: ['done', 'Published'], art: ['done', true], view: 'live', h: ['review', 'Needs you'], note: 'ask' },
  {},
  { h: ['done', 'Approved'], note: 'said', pr: ['running', 'Building the design'] },
  {},
  { pr: ['done', 'Merged'] },
  {}, {},
]);
function designFigure(phase) {
  const f = DESIGN[phase];
  const mock = [['warn', 'Plan', true], ['warn', 'Code', true], ['idle', 'Merge', false], ['idle', 'Writes', false]]
    .map(([t, n, on]) => `<div class="wn-art-cp tone-${t}"><i></i><span>${n}</span><span class="wn-art-tg${on ? ' on' : ''}"></span></div>`).join('');
  const body = f.view === 'live' ? `<div class="wn-art-title wn-fade">Checkpoint buttons</div><div class="wn-art-mock wn-fade">${mock}</div>`
    : f.view === 'draft' ? '<div class="wn-art-sk" style="width:55%"></div><div class="wn-art-sk"></div><div class="wn-art-sk" style="width:80%"></div><div class="wn-art-sk" style="width:65%"></div>' : '';
  const bar = f.view === 'live' ? `${ICONS.sparkle}<code>claude.ai/artifact/…</code><span class="wn-art-open">Open ↗</span>` : `${ICONS.sparkle}<code>Claude artifact</code><em>${f.view === 'draft' ? 'Publishing…' : 'Not made yet'}</em>`;
  const tone = { ask: 'warn', said: 'ok' }[f.note] || 'idle';
  const quote = f.note === 'said' ? '<blockquote class="wn-fade">Looks good. Add a Next button for when two updates are waiting, and drop Learn more.</blockquote>'
    : `<blockquote class="ph">${f.note === 'ask' ? 'Open the design, then approve it with a note or ask for changes.' : 'Opens once the design is published.'}</blockquote>`;
  const moves = f.note === 'ask' ? `<span class="go">${ICONS.check}Approve</span><span>${ICONS.edit}Ask for changes</span>` : f.note === 'said' ? `<span>${ICONS.next}Goes to the PR as its brief</span>` : '';
  return `<div class="wn-row3" role="img" aria-label="A session publishes a design artifact and opens a ticket, you approve the design with a note, then a pull request builds it">
      <div class="wn-stack">${node(f.s[0], 'robot', 'Design it as an artifact', f.s[1])}<div class="job-places">${pill('sparkle', 'design', f.art[0], f.art[1])}${pill('ticket', f.tix[1] ? 'WEB-214' : 'story', f.tix[0], f.tix[1])}</div></div>
      <span class="wn-edge${f.s[0] === 'done' ? ' landed' : ''}"></span>
      <div class="wn-stack">${node(f.h[0], 'person', 'Approve the design', f.h[1])}</div>
      <span class="wn-edge${f.h[0] === 'done' ? ' landed' : ''}"></span>
      <div class="wn-stack">${node(f.pr[0], 'pr', 'Build the approved design', f.pr[1])}</div>
    </div>
    <div class="wn-under">
      <div class="wn-art${f.view === 'live' ? '' : ' pending'}"><div class="wn-art-bar">${bar}</div><div class="wn-art-body">${body}</div></div>
      <div class="wn-note tone-${tone}"><header>${ICONS.person}<span>Your sign-off</span><span>${{ said: 'Approved', ask: 'Needs you' }[f.note] || 'Waiting'}</span></header>${quote}${moves ? `<footer>${moves}</footer>` : ''}</div>
    </div>`;
}

const TELL = scenes([
  { s: ['running', 'Starting'], jira: ['queued', 'Queued'], page: ['queued', 'Queued'], slack: ['queued', 'After the page'] },
  { s: ['running', 'Making 3 writes'], jira: ['done', 'Written <u>WEB-214 ↗</u>'], page: ['running', 'Writing'] },
  { page: ['done', 'Written <u>Checkpoints runbook ↗</u>'], slack: ['running', 'Writing'] },
  { s: ['done', 'Delivered'], slack: ['done', 'Written <u>#team-web ↗</u>'] },
  {}, {},
]);
function tellFigure(phase) {
  const f = TELL[phase];
  const write = (state, icon, title, line) => `<div class="wn-write tone-${ST[state][0]}">${tile(state, icon)}<span><b>${title}</b><small>${line}</small></span></div>`;
  return `<div class="wn-row2" role="img" aria-label="A merged pull request, then a session that moves the ticket to Done, adds a Confluence runbook page and posts in Slack, each with a receipt">
      <div class="wn-stack">${node('done', 'merge', 'Build the approved design', 'Merged')}</div>
      <span class="wn-edge landed"></span>
      <div class="wn-stack">${node(f.s[0], 'robot', 'Close the ticket and tell the team', f.s[1])}<div class="job-places">${pill('ticket', 'WEB-214', f.jira[0], true)}${pill('confluence', 'runbook', f.page[0], f.page[0] === 'done')}${pill('slack', '#team-web', f.slack[0], f.slack[0] === 'done')}</div></div>
    </div>
    <div class="wn-writes">
      ${write(f.jira[0], 'ticket', 'Move WEB-214 to Done with the PR link', f.jira[1])}
      ${write(f.page[0], 'confluence', 'Add the “Review checkpoints” runbook page', f.page[1])}
      ${write(f.slack[0], 'slack', 'Post in #team-web: what changed and where', f.slack[1])}
    </div>`;
}

// Redraws a figure in place, so surviving nodes keep their identity: tones
// transition, spinners keep turning and fade-ins play only for what is new.
// Replacing innerHTML every tick made the whole figure flash.
function patch(el, html) {
  const next = el.ownerDocument.createElement('div');
  next.innerHTML = html;
  morph(el, next);
}
function morph(a, b) {
  const as = [...a.childNodes];
  const bs = [...b.childNodes];
  bs.forEach((bn, i) => {
    const an = as[i];
    if (!an) return a.appendChild(bn);
    if (an.nodeType !== bn.nodeType || an.nodeName !== bn.nodeName) return a.replaceChild(bn, an);
    if (an.nodeType !== 1) { if (an.nodeValue !== bn.nodeValue) an.nodeValue = bn.nodeValue; return; }
    [...an.attributes].forEach((at) => { if (!bn.hasAttribute(at.name)) an.removeAttribute(at.name); });
    [...bn.attributes].forEach((at) => { if (an.getAttribute(at.name) !== at.value) an.setAttribute(at.name, at.value); });
    morph(an, bn);
  });
  as.slice(bs.length).forEach((n) => n.remove());
}
// Oldest first; append a release's entry at the end. `date` is YYYY-MM-DD and
// `body` is our own HTML. Optional: `icon` (an ICONS key) and `tone` for the
// settings row, `figure(phase)` drawn above the title, and `anim` ({ frames, ms,
// still }) to redraw it every `ms`, holding `still` with reduced motion.
export const UPDATES = [
  { id: 'writes-designs', date: '2026-10-14', icon: 'sparkle', tone: 'run',
    title: 'See the design before anything is built',
    body: `<p>A plan can now start with a session that publishes a <b>Claude artifact</b>, such as a mockup, a before and after, or a prototype, and then stop for you. Nothing is built until you approve, and what you write when you approve goes to the PR as its brief.</p>${done([
      '<b>Artifacts are private</b> claude.ai pages, linked from the job and from the ticket.',
      '<b>Files and web pages too</b>: a screenshot of the change on your own board, a report, a page a session hosts.',
      '<b>Ask for it in plain words</b>, like “design it first and let me approve it”, and the plan adds the steps.',
    ])}`,
    anim: { frames: 9, ms: 1500, still: 4 }, figure: (phase) => designFigure(phase) },
  { id: 'writes-places', date: '2026-10-14', icon: 'ticket', tone: 'ok',
    title: 'Jira, Slack and Confluence, kept up to date as the job runs',
    body: `<p>Jobs now handle the work around the code: opening the ticket, linking the design, moving it to Done when the PR merges, and telling the people who need to know. Every write is a step in the plan, made by one of its sessions, and nothing is written that the plan doesn’t list.</p>${done([
      '<b>A receipt for every write</b>: written, already done, or failed with the place’s own error. Nothing is posted twice.',
      '<b>Each place is a pill</b> under the session that writes to it. It shows a dot per write and opens to what was written.',
      '<b>The Writes checkpoint</b> starts on Auto. Set it to You review to get a draft you can edit, write or skip.',
    ])}`,
    anim: { frames: 6, ms: 1400, still: 3 }, figure: (phase) => tellFigure(phase) },
];

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
      if (fig) patch(fig, u.figure(phase));
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
