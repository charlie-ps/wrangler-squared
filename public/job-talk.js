import { esc } from './util.js';
import { ICONS } from './icons.js';
import { convoGroups, askPending, replanPending, convoNumber, convoRunning, replanQueued, queuedLabel } from './jobs.js';
import { proseHtml } from './job-idea.js';

// A running job's conversations with the wrangler (server/job-talk.js), drawn above
// the Add idea box, one section each: what the human asked, what the wrangler
// answered, and each plan change it proposed as a card that says what became of
// it. Several can be answering at once, each with its own box under it; the box
// below them all starts a new one. The job dialog shows all of them, a step's
// dialog only what was said on that step: a conversation started there shows on
// the job too only once its wrangler escalated it. Pure markup; jobs-view.js draws and
// wires the boxes. Every word is escaped.

export const WRANGLER_NAME = 'The wrangler';
const time = (at) => at ? new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : '';
const MARK = { added: 'New', edited: 'Edited', removed: 'Cancelled', rework: 'Rework', forward: 'Forward', 'accept-red': 'Accept red', mark: 'Mark', recover: 'Recover', retry: 'Retry' };
const OUTCOME = { approved: ['ok', 'Approved'], discarded: ['muted', 'Discarded'], revised: ['muted', 'Revised'] };

function humanHtml(job, m, onJob) {
  const step = onJob && m.sub ? job.subJobs.find((s) => s.id === m.sub)?.title || m.sub : null;
  const meta = ['You', step ? `on ${step}` : '', m.images ? `${m.images} image${m.images === 1 ? '' : 's'}` : '', time(m.at)].filter(Boolean).join(' · ');
  return `<div class="job-sent" data-talk="${esc(m.id)}"><div class="job-sent-bubble"><span>${esc(m.text)}</span></div><span class="job-sent-meta">${esc(meta)}</span></div>`;
}
const wranglerHtml = (m, body, cls = '') => `<div class="job-idea-msg job-talk-msg ${cls}" data-talk="${esc(m.id)}"><span class="job-idea-orb small" aria-hidden="true"></span><div><div class="job-idea-who">${WRANGLER_NAME}<time>${esc(time(m.at))}</time></div>${body}</div></div>`;

// The card's state: what the human did with it, else waiting while it is the
// proposal on the job, else gone (a red step's fate, a cancelled job).
function cardState(job, m) {
  if (m.outcome) return OUTCOME[m.outcome] || ['muted', m.outcome];
  return job.replan?.proposal?.id === m.proposalId && !job.cancelledAt ? ['needs', 'Waiting for you'] : ['muted', 'No longer waiting'];
}
function proposalHtml(job, m, onJob) {
  const [tone, label] = cardState(job, m);
  const live = tone === 'needs';
  const rows = (m.changes || []).map((c) => `<li class="job-talk-change job-mark-${esc(c.mark)}"><span class="job-mark">${esc(MARK[c.mark] || c.mark)}</span><span class="job-talk-change-title">${esc(c.title)}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}${c.then ? `<span class="job-talk-then">${esc(c.then)}</span>` : ''}</span></li>`).join('');
  const button = live ? onJob ? `<button type="button" data-talk-review title="The proposal is drawn at the top of this dialog">${ICONS.eye}Review proposal</button>` : `<button type="button" data-open-job title="Opens the job dialog on the proposal">${ICONS.eye}Review proposal</button>` : '';
  const options = m.options > 1 ? `<small class="job-talk-options">${m.options} options</small>` : '';
  const queued = live && queuedLabel(job) ? `<span class="job-talk-tag tone-working">${esc(queuedLabel(job))}</span>` : '';
  return `<div class="job-talk-card tone-${tone}"><header><b>${m.red ? 'Proposed a fix' : 'Proposed a change'}</b><span class="job-talk-tag">${esc(label)}</span>${queued}${options}</header>${m.text ? `<div class="job-idea-body">${proseHtml(m.text)}</div>` : ''}${rows ? `<ul class="job-talk-changes">${rows}</ul>` : '<p class="job-talk-none">No sub-job changes</p>'}${button ? `<footer>${button}</footer>` : ''}</div>`;
}

function messageHtml(job, m, onJob) {
  if (m.from === 'human') return humanHtml(job, m, onJob);
  if (m.kind === 'proposal') return wranglerHtml(m, proposalHtml(job, m, onJob), 'proposal');
  return wranglerHtml(m, `<div class="job-idea-body">${proseHtml(m.text)}</div>`, m.kind === 'error' ? 'error' : '');
}

// What this conversation's wrangler is doing now: answering, or drawing a
// proposal for an idea the human sent in it.
function workingHtml(job, convo) {
  const text = convo && askPending(job, convo) ? `${WRANGLER_NAME} ${convoRunning(job, convo) ? 'is looking into it' : 'will look into it'}…`
    : replanPending(job) && !job.replan.proposal && !(job.replan.red && !job.replan.red.human) && (job.replan.convo || null) === (convo?.id || null) ? `${WRANGLER_NAME} is drawing a proposal…` : '';
  if (!text && convo && replanQueued(job).some((q) => q.convo === convo.id)) return '<div class="job-idea-thinking job-talk-working job-talk-queued"><span class="job-idea-orb small" aria-hidden="true"></span><span>Queued behind the plan change being drawn</span></div>';
  return text ? `<div class="job-idea-thinking job-talk-working"><span class="job-idea-orb small" aria-hidden="true"></span><span class="job-idea-shine">${text}</span></div>` : '';
}

function groupHtml(job, { convo, messages }, sub, boxFor) {
  const onJob = !sub;
  const step = onJob && convo?.sub ? job.subJobs.find((s) => s.id === convo.sub)?.title || convo.sub : '';
  const state = convo && askPending(job, convo) ? `<span class="job-talk-tag tone-working">${convoRunning(job, convo) ? 'Answering' : 'Queued'}</span>` : '';
  const raised = convo?.sub && convo.escalatedAt ? `<span class="job-talk-tag" title="The wrangler judged it the whole job's, so the job's list shows it too">${onJob ? 'Escalated' : 'Also on the job'}</span>` : '';
  const head = `<header class="job-talk-convo-head"><b>${convo ? `Conversation ${convoNumber(job, convo)}` : 'From the wrangler'}</b>${step ? `<small>on ${esc(step)}</small>` : ''}${raised}${state}</header>`;
  return `<div class="job-talk-convo" data-convo="${esc(convo?.id || '')}">${head}${messages.map((m) => messageHtml(job, m, onJob)).join('')}${workingHtml(job, convo)}${convo && boxFor ? boxFor(convo) : ''}</div>`;
}

// `boxFor(convo)` draws that conversation's own box (jobs-view.js), or nothing
// where the view takes no idea.
export function talkHtml(job, sub = null, boxFor = null) {
  const groups = convoGroups(job, sub);
  const loose = groups.some((g) => !g.convo) ? '' : workingHtml(job, null);
  if (!groups.length && !loose) return '';
  const many = groups.filter((g) => g.convo).length > 1;
  return `<section class="job-talk" aria-label="Conversations with the wrangler" aria-live="polite"><h4 class="job-talk-head">${ICONS.note}${many ? 'Conversations' : 'Conversation'} with the wrangler</h4>${groups.map((g) => groupHtml(job, g, sub, boxFor)).join('')}${loose}</section>`;
}
