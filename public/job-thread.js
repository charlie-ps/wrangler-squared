import { esc } from './util.js';
import { ICONS } from './icons.js';
import { roundThumbHtml } from './job-proof.js';
import { readyRun, answeringLabel } from './jobs.js';

// The conversation under a Code review step (server/job-parked.js): what the
// human asked the session that wrote the tree, and what it answered. Every word of
// it is agent- or human-written and reaches the page only through esc(); pictures
// are evidence slots the view hydrates from `job-evidence` frames.

export const hasThread = (sub) => Array.isArray(sub?.thread) && sub.thread.length > 0;
const clock = (at) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const WHO = { human: 'You', agent: 'Session', system: 'Wrangler' };

function messageHtml(job, sub, m) {
  const files = [...(m.shots || []), ...(m.images || [])].map((x) => x.file);
  const attach = files.length ? `<div class="job-msg-att">${files.map((f) => roundThumbHtml(job, sub, m.round, f)).join('')}</div>` : '';
  const run = m.run ? `<pre class="job-msg-run"><i>$</i> ${esc(m.run.cmd)}\n${esc(m.run.out)}\n<b class="${m.run.exit === 0 ? 'ok' : 'bad'}">exit ${esc(m.run.exit)}</b></pre>` : '';
  return `<div class="job-msg ${esc(m.from)}"><span class="job-msg-who">${m.from === 'system' ? `Round ${esc(m.round)}` : WHO[m.from] || esc(m.from)}</span><div><p>${esc(m.text)}<time>${esc(clock(m.at))}</time></p>${run}${attach}</div></div>`;
}

// Where the session stands, in the words of the thread's header.
export function threadState(job, sub) {
  const run = readyRun(job, sub);
  if (run && sub.answering) return { kind: 'answering', title: answeringLabel(sub), note: 'Working on what you sent', sid: run.sessionId };
  if (run) return { kind: 'waiting', title: 'Its session is waiting on your review', note: 'Paused · no slot · keeps its context', sid: run.sessionId };
  if (!hasThread(sub)) return null;
  return { kind: 'stopped', title: 'Session stopped', note: sub.state === 'approved' ? `Approved round ${sub.ready?.round || 1}` : 'It is no longer open: a change starts a new session', sid: null };
}

export function threadHtml(job, sub) {
  const st = threadState(job, sub);
  if (!st) return '';
  const open = st.sid ? `<span class="r"><button type="button" data-fab-session="${esc(st.sid)}">${ICONS.terminal}Open session</button></span>` : '';
  const body = hasThread(sub) ? sub.thread.map((m) => messageHtml(job, sub, m)).join('') : '<div class="job-thread-empty">Ask about how it works or anything you saw. It answers from the session that wrote the code.</div>';
  return `<section class="job-thread ${st.kind}" aria-label="Conversation with the session"><div class="job-thread-head">${st.kind === 'answering' ? ICONS.spin : ICONS.terminal}<b>${esc(st.title)}</b><small>${esc(st.note)}</small>${open}</div>${body}</section>`;
}

// Earlier rounds' proof, kept in case the human wants to see what changed.
const earlierBody = (job, sub, rounds) => rounds.map((r) => `<div class="job-earlier-round"><h4>Round ${esc(r.round)}</h4><div class="job-msg-att">${(r.proof || []).flatMap((p) => (p.shots || []).map((s) => roundThumbHtml(job, sub, r.round, s.file))).join('')}</div><ul class="job-receipt">${(r.checks || []).map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul></div>`).join('');
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
  const answering = threadState(job, sub)?.kind === 'answering';
  if (!rounds.length && !msgs && !answering) return '';
  const title = rounds.length && (msgs || answering) ? 'Earlier rounds and conversation' : rounds.length ? 'Earlier rounds' : 'Conversation';
  const note = [rounds.map((r) => `Round ${esc(r.round)}`).join(' · '), msgs ? `${msgs} message${msgs === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return `<details class="job-more job-history" data-keep="history" ${open || answering ? 'open' : ''}><summary>${ICONS.terminal}${title}${note ? ` <small>${note}</small>` : ''}</summary>${msgs || answering ? threadHtml(job, sub) : ''}${rounds.length ? `<div class="job-earlier">${earlierBody(job, sub, rounds)}</div>` : ''}</details>`;
}
