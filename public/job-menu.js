import { esc } from './util.js';
import { ICONS, PULL_REQUEST_ICON, TICKET_ICON } from './icons.js';
import { inConversation, isPrSub, isWriteSub, placesOf, prNumber, webUrl } from './jobs.js';
import { jobLabel } from './job-state.js';

// A plate's right-click menu, modelled on core's session card menu (agent-wrangler
// public/app.js openCardMenu/mountMenu): icon rows, a danger row last, focus on the
// first row, arrows to move, Enter or Space to pick, Esc or a click outside to close.
// Our own classes rather than core's .context-menu, which an extension cannot count on.

const live = (job) => job.stage === 'active' || job.stage === 'done';
const finished = (job) => !!job.cancelledAt || job.stage === 'done';

// Every open pull request link the job has, in plan order.
export function jobPrs(job) {
  if (!live(job)) return [];
  return job.subJobs.filter((s) => isPrSub(s) && webUrl(s.pr?.url)).map((s) => ({ url: s.pr.url, n: prNumber(s), title: s.title }));
}

// Every story that has somewhere to open: a ticket a write made or names (its
// place), or a sub-job's key through the site the planner read.
export function jobStories(job) {
  const plan = live(job) ? { ...job.plan, subJobs: job.subJobs } : job.plan;
  if (!plan?.subJobs) return [];
  const out = new Map();
  for (const p of placesOf(plan, plan.subJobs.filter(isWriteSub))) if (p.type === 'jira' && webUrl(p.url)) out.set(p.url, { url: p.url, key: p.label });
  const site = (plan.jiraSite || '').replace(/\/$/, '');
  for (const s of plan.subJobs) if (s.jiraKey && webUrl(site)) { const url = `${site}/browse/${s.jiraKey}`; if (![...out.values()].some((x) => x.key === s.jiraKey)) out.set(url, { url, key: s.jiraKey }); }
  return [...out.values()];
}

// One line to paste into another agent's chat. No tool reads a job by id
// (get_job_context reads only the caller's own), so the line carries what a reader
// would otherwise have to ask for: where it stands and its pull requests.
export function jobReference(job) {
  const prs = jobPrs(job).map((p) => p.url);
  return `Wrangler² job "${job.title || job.id}" (id: ${job.id}) — ${jobLabel(job)}${prs.length ? `; PR${prs.length === 1 ? '' : 's'}: ${prs.join(', ')}` : ''}`;
}

// Only what the job's stage can take; the server refuses the rest anyway
// (server/job-store.js action()). Pause has nothing to hold on a backlog job,
// which Start covers; a finished job keeps only what reads it.
export function jobMenuItems(job) {
  const prs = jobPrs(job), stories = jobStories(job);
  const links = [
    ...prs.map((p) => ({ id: 'link', label: p.n ? `Open PR #${p.n}` : 'Open PR', title: p.title, icon: PULL_REQUEST_ICON, href: p.url })),
    ...stories.map((s) => ({ id: 'link', label: `Open story ${s.key}`, icon: TICKET_ICON, href: s.url })),
  ];
  const control = finished(job) ? [] : [
    job.stage === 'backlog' ? { id: 'start', label: 'Start planning', icon: ICONS.play }
      : job.paused ? { id: 'resume', label: 'Resume', icon: ICONS.play } : { id: 'pause', label: 'Pause', icon: ICONS.pause },
  ];
  return [
    { id: 'open', label: 'Open job', icon: ICONS.doc },
    { id: 'copy-ref', label: 'Copy reference', icon: ICONS.copy },
    { id: 'copy-id', label: 'Copy job ID', icon: ICONS.copy },
    ...(links.length ? [{ sep: true }, ...links] : []),
    ...(control.length ? [{ sep: true }, ...control] : []),
    ...(finished(job) ? [] : [{ sep: true }, { id: 'cancel', label: inConversation(job) ? 'Cancel idea' : 'Cancel job', icon: ICONS.stop, danger: true }]),
  ];
}

// Mounts `items` at (x, y) inside `host`, clamped into the viewport, and calls
// onPick(item) for the row chosen. Returns close(); the menu also closes itself
// on a pick, Esc, a press outside it, scroll or resize.
export function mountJobMenu(host, items, x, y, onPick) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const back = doc.activeElement;
  const menu = doc.createElement('div');
  menu.className = 'job-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { const d = doc.createElement('div'); d.className = 'job-menu-sep'; d.setAttribute('role', 'separator'); menu.appendChild(d); continue; }
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `job-menu-item${it.danger ? ' danger' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${it.icon || ''}<span>${esc(it.label)}</span>`;
    if (it.title) b.title = it.title;
    b.onclick = () => { close(); onPick(it); };
    menu.appendChild(b);
  }
  const rows = () => [...menu.querySelectorAll('.job-menu-item')];
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (back?.isConnected) back.focus(); return; }
    if (e.key === 'Tab') { close(); return; }
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const all = rows(), i = all.indexOf(doc.activeElement);
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); all[e.key === 'Home' ? 0 : all.length - 1]?.focus(); return; }
    if (!dir || !all.length) return;
    e.preventDefault();
    all[i < 0 ? (dir > 0 ? 0 : all.length - 1) : (i + dir + all.length) % all.length].focus();
  };
  let open = true;
  function close() {
    if (!open) return;
    open = false;
    menu.remove();
    doc.removeEventListener('mousedown', onDown, true);
    doc.removeEventListener('keydown', onKey, true);
    win?.removeEventListener('scroll', close, true);
    win?.removeEventListener('resize', close);
  }
  // Mounted hidden to measure, so a plate near an edge flips the menu back in.
  menu.style.visibility = 'hidden';
  host.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, (win?.innerWidth ?? x + width) - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, (win?.innerHeight ?? y + height) - height - 4))}px`;
  menu.style.visibility = '';
  doc.addEventListener('mousedown', onDown, true);
  doc.addEventListener('keydown', onKey, true);
  win?.addEventListener('scroll', close, true);
  win?.addEventListener('resize', close);
  rows()[0]?.focus();
  return close;
}
