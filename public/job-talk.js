import { esc } from './util.js';
import { ICONS, wranglerMark } from './icons.js';
import { convoGroups, askPending, replanPending, convoNumber, convoRunning, replanQueued, queuedLabel } from './jobs.js';
import { proseHtml, imageStripHtml } from './job-idea.js';
import { shotButtonHtml } from './job-proof.js';

// A running job's conversations with the wrangler (server/job-talk.js), drawn above
// the Add idea box, one section each: what the human asked, what the wrangler
// answered, and each plan change it proposed as a card that says what became of
// it. A forward is no plan change: it is one line saying where the words went,
// followed by what that step's session answered, read from its thread. Several
// can be answering at once, each with its own box under it; the box
// below them all starts a new one. The job dialog shows all of them, a step's
// dialog only what was said on that step: a conversation started there shows on
// the job too only once its wrangler escalated it. Pure markup; jobs-view.js draws and
// wires the boxes. Every word is escaped.

export const WRANGLER_NAME = 'Wrangler';
const time = (at) => at ? new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : '';
const MARK = { added: 'New', edited: 'Edited', removed: 'Cancelled', rework: 'Rework', forward: 'Forward', 'accept-red': 'Accept red', mark: 'Mark', recover: 'Recover', retry: 'Retry' };
const OUTCOME = { approved: ['ok', 'Approved'], discarded: ['muted', 'Discarded'], revised: ['muted', 'Revised'] };

function humanHtml(job, m, onJob) {
  const step = onJob && m.sub ? job.subJobs.find((s) => s.id === m.sub)?.title || m.sub : null;
  // Kept pictures are a strip the dialog fills from a job-images frame (`talk:<file>`);
  // a message saved before they were kept holds only how many there were.
  const kept = Array.isArray(m.images) ? m.images : [];
  const count = typeof m.images === 'number' && m.images ? `${m.images} image${m.images === 1 ? '' : 's'}` : '';
  const meta = ['You', step ? `on ${step}` : '', count, time(m.at)].filter(Boolean).join(' · ');
  const pics = imageStripHtml(job, kept.map((i) => `talk:${i.file}`), 'job-sent-strip');
  return `<div class="job-sent" data-talk="${esc(m.id)}"><div class="job-sent-bubble">${pics}<span>${esc(m.text)}</span></div><span class="job-sent-meta">${esc(meta)}</span></div>`;
}
const wranglerHtml = (m, body, cls = '') => `<div class="job-idea-msg job-talk-msg ${cls}" data-talk="${esc(m.id)}">${wranglerMark('small')}<div><div class="job-idea-who">${WRANGLER_NAME}<time>${esc(time(m.at))}</time></div>${body}</div></div>`;

// The card's state: what the human did with it, else waiting while it is the
// proposal on the job, else gone (a red step's fate, a cancelled job).
function cardState(job, m) {
  if (m.outcome) return OUTCOME[m.outcome] || ['muted', m.outcome];
  return job.replan?.proposal?.id === m.proposalId && !job.cancelledAt ? ['needs', 'Waiting for you'] : ['muted', 'No longer waiting'];
}
// A decided card folds to its title, outcome and how many of each kind of change.
const countsOf = (changes) => {
  const n = new Map();
  for (const c of changes) n.set(c.mark, (n.get(c.mark) || 0) + 1);
  const order = Object.keys(MARK);
  return [...n].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).map(([k, v]) => `${v} ${(MARK[k] || k).toLowerCase()}`).join(', ') || 'no sub-job changes';
};
function proposalHtml(job, m, onJob, kept) {
  const [tone, label] = cardState(job, m);
  const live = tone === 'needs';
  const rows = (m.changes || []).map((c) => `<li class="job-talk-change job-mark-${esc(c.mark)}"><span class="job-mark">${esc(MARK[c.mark] || c.mark)}</span><span class="job-talk-change-title">${esc(c.mark === 'forward' ? `To ${c.title}'s session` : c.title)}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}${c.then ? `<span class="job-talk-then">${esc(c.then)}</span>` : ''}</span></li>`).join('');
  const button = live ? onJob ? `<button type="button" data-talk-review title="The proposal is drawn at the top of this dialog">${ICONS.eye}Review proposal</button>` : `<button type="button" data-open-job title="Opens the job dialog on the proposal">${ICONS.eye}Review proposal</button>` : '';
  const options = m.options > 1 ? `<small class="job-talk-options">${m.options} options</small>` : '';
  const queued = live && queuedLabel(job) ? `<span class="job-talk-tag tone-working">${esc(queuedLabel(job))}</span>` : '';
  const title = `<b>${isForward(m) ? 'Forward your words' : m.red ? 'Proposed a fix' : 'Proposed a change'}</b><span class="job-talk-tag">${esc(label)}</span>${queued}${options}`;
  const body = `${m.text ? `<div class="job-idea-body">${proseHtml(m.text)}</div>` : ''}${rows ? `<ul class="job-talk-changes">${rows}</ul>` : '<p class="job-talk-none">No sub-job changes</p>'}`;
  if (live) return `<div class="job-talk-card tone-${tone}"><header>${title}</header>${body}${button ? `<footer>${button}</footer>` : ''}</div>`;
  const key = `talk-card:${m.id}`;
  return `<details class="job-talk-card tone-${tone}" data-keep="${esc(key)}" ${kept?.has(key) ? 'open' : ''}><summary>${title}<span class="job-talk-counts">${esc(countsOf(m.changes || []))}</span>${ICONS.caret}</summary>${body}</details>`;
}

// A proposal that only forwarded the human's words (server/job-talk.js
// noteProposal), or an older card that did no more than that.
export const isForward = (m) => m.kind === 'proposal' && (m.forward || (!m.red && (m.options || 1) === 1 && m.changes?.length > 0 && m.changes.every((c) => c.mark === 'forward')));
const stepTitle = (job, id) => job.subJobs.find((s) => s.id === id)?.title || id;
const sessionsOf = (titles) => titles.length === 1 ? `${titles[0]}'s session` : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}'s sessions`;
function forwardLine(job, m) {
  const titles = [...new Set((m.forwarded?.length ? m.forwarded.map((f) => stepTitle(job, f.sub)) : m.changes.map((c) => c.title)))];
  return `${WRANGLER_NAME} forwarded this to ${sessionsOf(titles)}`;
}

// What the session said back to a forwarded message, read from the step's thread
// (the source of truth): everything after it up to the next message sent to it.
export function repliesTo(sub, messageId) {
  const thread = sub?.thread || [];
  const at = thread.findIndex((t) => t.id === messageId);
  if (at < 0) return [];
  const next = thread.findIndex((t, k) => k > at && t.to === 'agent');
  return thread.slice(at + 1, next < 0 ? undefined : next).filter((t) => t.from === 'agent' || t.from === 'system');
}
function sessionHtml(job, sub, t) {
  const files = [...(t.shots || []), ...(t.images || [])].map((x) => x.file);
  const attach = files.length ? `<div class="job-msg-att">${files.map((f, k) => shotButtonHtml(job, sub, t.round, f, k)).join('')}</div>` : '';
  const run = t.run ? `<pre class="job-msg-run"><i>$</i> ${esc(t.run.cmd)}\n${esc(t.run.out)}\n<b class="${t.run.exit === 0 ? 'ok' : 'bad'}">exit ${esc(t.run.exit)}</b></pre>` : '';
  const text = t.from === 'system' ? `Reported ready again: round ${t.round}` : t.text;
  return `<div class="job-talk-session" data-talk-thread="${esc(t.id)}"><span class="job-talk-session-mark" aria-hidden="true">${ICONS.terminal}</span><div><div class="job-idea-who">Session · ${esc(sub.title)}<time>${esc(time(t.at))}</time></div><div class="job-idea-body">${proseHtml(text)}</div>${run}${attach}</div></div>`;
}
// Each approved forward's answers, or that its session is still at it.
const answersHtml = (job, m) => (m.forwarded || []).map(({ sub: id, message }) => {
  const sub = job.subJobs.find((s) => s.id === id);
  if (!sub) return '';
  const got = repliesTo(sub, message);
  const working = !got.length && sub.answering?.id === message ? `<div class="job-idea-thinking job-talk-working"><span class="job-talk-session-mark" aria-hidden="true">${ICONS.terminal}</span><span class="job-idea-shine">${esc(sub.title)}'s session is working on it…</span></div>` : '';
  return got.map((t) => sessionHtml(job, sub, t)).join('') + working;
}).join('');
const forwardHtml = (job, m) => `<div class="job-talk-forward" data-talk="${esc(m.id)}">${wranglerMark('small')}<span>${esc(forwardLine(job, m))}</span><time>${esc(time(m.outcomeAt || m.at))}</time></div>`;

function messageHtml(job, m, onJob, kept) {
  if (m.from === 'human') return humanHtml(job, m, onJob);
  if (isForward(m) && m.outcome === 'approved') return forwardHtml(job, m) + answersHtml(job, m);
  if (m.kind === 'proposal') return wranglerHtml(m, proposalHtml(job, m, onJob, kept), 'proposal') + answersHtml(job, m);
  return wranglerHtml(m, `<div class="job-idea-body">${proseHtml(m.text)}</div>`, m.kind === 'error' ? 'error' : '');
}

// What this conversation's wrangler is doing now: answering, or drawing a
// proposal for an idea the human sent in it.
function workingHtml(job, convo) {
  const text = convo && askPending(job, convo) ? `${WRANGLER_NAME} ${convoRunning(job, convo) ? 'is looking into it' : 'will look into it'}…`
    : replanPending(job) && !job.replan.proposal && !(job.replan.red && !job.replan.red.human) && (job.replan.convo || null) === (convo?.id || null) ? `${WRANGLER_NAME} is drawing a proposal…` : '';
  if (!text && convo && replanQueued(job).some((q) => q.convo === convo.id)) return `<div class="job-idea-thinking job-talk-working job-talk-queued">${wranglerMark('small')}<span>Queued behind the plan change being drawn</span></div>`;
  return text ? `<div class="job-idea-thinking job-talk-working">${wranglerMark('small', true)}<span class="job-idea-shine">${text}</span></div>` : '';
}

// A conversation stays open while its wrangler is at it (answering, queued, a
// change drawn or waiting in it) and when the human spoke in it last; the rest
// fold to a strip. `fold` holds the human's own clicks, which win.
const liveIn = (job, convo) => askPending(job, convo) || convoRunning(job, convo) || (!job.cancelledAt && !!job.replan && job.replan.convo === convo.id);
export function convoOpen(job, group, groups, fold = null) {
  const { convo } = group;
  if (!convo) return true;
  if (fold?.has(convo.id)) return fold.get(convo.id);
  if (liveIn(job, convo)) return true;
  const lastHuman = (g) => g.messages.findLast((m) => m.from === 'human')?.at ?? -Infinity;
  const latest = Math.max(...groups.map(lastHuman));
  return latest > -Infinity && lastHuman(group) === latest;
}

// The folded strip: the question, and the start of what the wrangler said last.
function stripHtml(job, messages) {
  const asked = messages.find((m) => m.from === 'human');
  const said = messages.findLast((m) => m.from !== 'human');
  if (said && isForward(said) && said.outcome === 'approved') return `<div class="job-talk-strip" data-convo-fold>${asked ? humanHtml(job, asked, false) : ''}${forwardHtml(job, said)}</div>`;
  const words = said && (said.kind === 'proposal' ? said.text || (said.red ? 'Proposed a fix' : 'Proposed a change') : said.text);
  return `<div class="job-talk-strip" data-convo-fold>${asked ? humanHtml(job, asked, false) : ''}${said ? wranglerHtml(said, `<div class="job-idea-body job-talk-clip">${proseHtml(words || '')}</div>`, said.kind === 'error' ? 'error' : '') : ''}</div>`;
}

function groupHtml(job, group, groups, sub, boxFor, fold, kept) {
  const { convo, messages } = group;
  const onJob = !sub;
  const open = convoOpen(job, group, groups, fold);
  const step = onJob && convo?.sub ? job.subJobs.find((s) => s.id === convo.sub)?.title || convo.sub : '';
  const state = convo && askPending(job, convo) ? `<span class="job-talk-tag tone-working">${convoRunning(job, convo) ? 'Answering' : 'Queued'}</span>` : '';
  const raised = convo?.sub && convo.escalatedAt ? `<span class="job-talk-tag" title="Wrangler judged it the whole job's, so the job's list shows it too">${onJob ? 'Escalated' : 'Also on the job'}</span>` : '';
  const title = convo ? `Conversation ${convoNumber(job, convo)}` : 'From Wrangler';
  const more = !open && messages.length > 2 ? `<small class="job-talk-count">${messages.length} messages</small>` : '';
  const tools = convo ? `<span class="job-talk-convo-tools"><button type="button" class="job-talk-fold" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(title)}">${ICONS.caret}</button>${liveIn(job, convo) ? '' : `<button type="button" class="job-talk-dismiss" data-convo-dismiss title="Dismiss this conversation" aria-label="Dismiss ${esc(title)}">${ICONS.x}</button>`}</span>` : '';
  const head = `<header class="job-talk-convo-head"${convo ? ' data-convo-fold' : ''}><b>${esc(title)}</b>${step ? `<small>on ${esc(step)}</small>` : ''}${raised}${state}${more}${tools}</header>`;
  const body = open ? `${messages.map((m) => messageHtml(job, m, onJob, kept)).join('')}${workingHtml(job, convo)}${convo && boxFor ? boxFor(convo) : ''}` : stripHtml(job, messages);
  return `<div class="job-talk-convo${open ? '' : ' is-folded'}" data-convo="${esc(convo?.id || '')}">${head}${body}</div>`;
}

// `boxFor(convo)` draws that conversation's own box (jobs-view.js), or nothing
// where the view takes no idea; `fold` maps a conversation id to open or not;
// `kept` is the set of decided proposal cards the human opened.
export function talkHtml(job, sub = null, boxFor = null, fold = null, kept = null) {
  const groups = convoGroups(job, sub);
  const loose = groups.some((g) => !g.convo) ? '' : workingHtml(job, null);
  if (!groups.length && !loose) return '';
  const many = groups.filter((g) => g.convo).length > 1;
  return `<section class="job-talk" aria-label="Conversations with Wrangler" aria-live="polite"><h4 class="job-talk-head">${ICONS.note}${many ? 'Conversations' : 'Conversation'} with Wrangler</h4>${groups.map((g) => groupHtml(job, g, groups, sub, boxFor, fold, kept)).join('')}${loose}</section>`;
}
