import { esc } from './util.js';
import { ICONS } from './icons.js';
import { talkFor, askPending, replanPending } from './jobs.js';
import { proseHtml } from './job-idea.js';

// A running job's conversation with the wrangler (server/job-talk.js), drawn above
// the Add idea box: what the human asked, what the wrangler answered, and each
// plan change it proposed as a card that says what became of it. The job dialog
// shows all of it, a step's dialog only what was said on that step. Pure markup;
// jobs-view.js wires the card's button. Every word is escaped.

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
  const rows = (m.changes || []).map((c) => `<li class="job-talk-change job-mark-${esc(c.mark)}"><span class="job-mark">${esc(MARK[c.mark] || c.mark)}</span><span class="job-talk-change-title">${esc(c.title)}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}</span></li>`).join('');
  const button = live ? onJob ? `<button type="button" data-talk-review title="The proposal is drawn at the top of this dialog">${ICONS.eye}Review proposal</button>` : `<button type="button" data-open-job title="Opens the job dialog on the proposal">${ICONS.eye}Review proposal</button>` : '';
  const options = m.options > 1 ? `<small class="job-talk-options">${m.options} options</small>` : '';
  return `<div class="job-talk-card tone-${tone}"><header><b>${m.red ? 'Proposed a fix' : 'Proposed a change'}</b><span class="job-talk-tag">${esc(label)}</span>${options}</header>${m.text ? `<div class="job-idea-body">${proseHtml(m.text)}</div>` : ''}${rows ? `<ul class="job-talk-changes">${rows}</ul>` : '<p class="job-talk-none">No sub-job changes</p>'}${button ? `<footer>${button}</footer>` : ''}</div>`;
}

function messageHtml(job, m, onJob) {
  if (m.from === 'human') return humanHtml(job, m, onJob);
  if (m.kind === 'proposal') return wranglerHtml(m, proposalHtml(job, m, onJob), 'proposal');
  return wranglerHtml(m, `<div class="job-idea-body">${proseHtml(m.text)}</div>`, m.kind === 'error' ? 'error' : '');
}

// What the wrangler is doing now, if it concerns this view: answering a question,
// or drawing a proposal for an idea the human sent.
function workingHtml(job, sub) {
  const mine = (src) => !sub || src?.sub === sub.id;
  const text = askPending(job) && mine(job.ask.source) ? `${WRANGLER_NAME} is looking into it…`
    : replanPending(job) && !job.replan.proposal && !(job.replan.red && !job.replan.red.human) && mine(job.replan.source) ? `${WRANGLER_NAME} is drawing a proposal…` : '';
  return text ? `<div class="job-idea-thinking job-talk-working"><span class="job-idea-orb small" aria-hidden="true"></span><span class="job-idea-shine">${text}</span></div>` : '';
}

export function talkHtml(job, sub = null) {
  const msgs = talkFor(job, sub);
  const working = workingHtml(job, sub);
  if (!msgs.length && !working) return '';
  return `<section class="job-talk" aria-label="Conversation with the wrangler" aria-live="polite"><h4 class="job-talk-head">${ICONS.note}Conversation with the wrangler</h4>${msgs.map((m) => messageHtml(job, m, !sub)).join('')}${working}</section>`;
}
