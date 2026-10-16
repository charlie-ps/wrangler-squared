import { esc } from './util.js';
import { ICONS } from './icons.js';
import { shotButtonHtml } from './job-proof.js';
import { readyRun } from './jobs.js';

// The conversation under a Code review step (server/job-parked.js): what the
// human asked the session that wrote the tree, and what it answered. Every word of
// it is agent- or human-written and reaches the page only through esc(); pictures
// are evidence slots the view hydrates from `job-evidence` frames.

export const hasThread = (sub) => Array.isArray(sub?.thread) && sub.thread.length > 0;
const clock = (at) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const WHO = { human: 'You', agent: 'Session', system: 'Wrangler' };

function messageHtml(job, sub, m) {
  const files = [...(m.shots || []), ...(m.images || [])].map((x) => x.file);
  const attach = files.length ? `<div class="job-msg-att">${files.map((f, k) => shotButtonHtml(job, sub, m.round, f, k)).join('')}</div>` : '';
  const run = m.run ? `<pre class="job-msg-run"><i>$</i> ${esc(m.run.cmd)}\n${esc(m.run.out)}\n<b class="${m.run.exit === 0 ? 'ok' : 'bad'}">exit ${esc(m.run.exit)}</b></pre>` : '';
  const via = m.via === 'planner' ? '<span class="job-msg-via">via the planner · approved</span>' : '';
  return `<div class="job-msg ${esc(m.from)}"><span class="job-msg-who">${m.from === 'system' ? `Round ${esc(m.round)}` : WHO[m.from] || esc(m.from)}</span><div><p>${esc(m.text)}<time>${m.from === 'human' && m.sentAt ? `<i class="job-msg-tick" title="Delivered to the session">${ICONS.check}</i>` : ''}${esc(clock(m.at))}</time></p>${run}${attach}${via}</div></div>`;
}

// Where the session stands: answering, waiting on your review, or gone.
export function threadState(job, sub) {
  const run = readyRun(job, sub);
  if (run) return sub.answering ? 'answering' : 'waiting';
  return hasThread(sub) ? 'stopped' : null;
}
// What the fold's summary adds about the session: news while it works, and that
// it has gone once stopped. One waiting on review is what the state chip says.
const STATE_NOTE = { answering: 'working on what you sent', stopped: 'session stopped' };

// The messages alone: where the session stands is the fold's summary line, and
// Open session is the footer's.
export function threadHtml(job, sub) {
  const st = threadState(job, sub);
  if (!st) return '';
  const body = hasThread(sub) ? sub.thread.map((m) => messageHtml(job, sub, m)).join('') : '<div class="job-thread-empty">Ideas reach it through the planner: ask about how it works or anything you saw, and once you approve, the session that wrote the code answers.</div>';
  return `<section class="job-thread ${st}" aria-label="Conversation with the session">${body}</section>`;
}

// Earlier rounds' proof, kept in case the human wants to see what changed.
const earlierBody = (job, sub, rounds) => rounds.map((r) => `<div class="job-earlier-round"><h4>Round ${esc(r.round)}</h4><div class="job-msg-att">${(r.proof || []).flatMap((p) => (p.shots || []).map((s) => s.file)).map((f, k) => shotButtonHtml(job, sub, r.round, f, k)).join('')}</div><ul class="job-receipt">${(r.checks || []).map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul></div>`).join('');
export function earlierRoundsHtml(job, sub) {
  const rounds = Array.isArray(sub?.earlier) ? sub.earlier : [];
  if (!rounds.length) return '';
  return `<details class="job-more job-earlier"><summary>Earlier rounds <small>${rounds.map((r) => `Round ${esc(r.round)}`).join(' · ')}</small></summary>${earlierBody(job, sub, rounds)}</details>`;
}

// The review step folds the conversation and earlier rounds into one line. It
// stays open while the session is answering, since that is news.
export function historyHtml(job, sub, { open = false } = {}) {
  const rounds = Array.isArray(sub?.earlier) ? sub.earlier : [];
  const msgs = hasThread(sub) ? sub.thread.length : 0;
  const st = threadState(job, sub), answering = st === 'answering';
  if (!rounds.length && !msgs && !answering) return '';
  const title = rounds.length && (msgs || answering) ? 'Earlier rounds and conversation' : rounds.length ? 'Earlier rounds' : 'Conversation';
  const note = [rounds.map((r) => `Round ${esc(r.round)}`).join(' · '), msgs ? `${msgs} message${msgs === 1 ? '' : 's'}` : '', STATE_NOTE[st] || ''].filter(Boolean).join(' · ');
  return `<details class="job-more job-history ${st || ''}" data-keep="history" ${open || answering ? 'open' : ''}><summary>${answering ? ICONS.spin : ICONS.terminal}${title}${note ? ` <small>${note}</small>` : ''}</summary>${msgs || answering ? threadHtml(job, sub) : ''}${rounds.length ? `<div class="job-earlier">${earlierBody(job, sub, rounds)}</div>` : ''}</details>`;
}
