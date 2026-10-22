import { esc } from './util.js';
import { ICONS } from './icons.js';

// A step's Sessions (the approved Mission Control): every session the step ran,
// listed beside the board's own session panel, which the host lends to the
// view's element (`api.mountSession`, host API 1.42). Job sessions are spawned
// off the board (1.41), so this is the only place they are shown and used.
// The job's own scope ('' sub) holds what no step owns: planning, the
// wrangler's conversations and plan changes, and a local-main fix.

const PHASE = { implementation: 'Implementation', repair: 'Repair', sync: 'Sync', publish: 'Publish', verify: 'Verify', session: 'Session', write: 'Write' };
const PHASE_ICON = { implementation: ICONS.terminal, repair: ICONS.wrench, sync: ICONS.merge, publish: ICONS.send, planning: ICONS.idea, session: ICONS.robot, write: ICONS.edit };

const planningLabel = (run) => (run.ask || run.convo ? 'Wrangler conversation' : run.red ? 'Wrangler · red step' : 'Planning');

// Oldest first, numbered from 1: a sub-job's bound sessions in the order they
// were bound, then any run of it whose card never reached that list.
export function sessionsOf(job, subId = '') {
  const runOf = (sid) => job.runs?.find((r) => r.sessionId === sid) || null;
  let ids;
  if (subId) {
    const sub = job.subJobs?.find((s) => s.id === subId);
    ids = [...(sub?.sessions || []), ...(job.runs || []).filter((r) => r.subJobId === subId && r.sessionId).map((r) => r.sessionId)];
  } else {
    ids = [...(job.runs || []).filter((r) => !r.subJobId && r.sessionId).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((r) => r.sessionId),
      ...(job.mainNotices || []).map((n) => n.resolving?.sessionId).filter(Boolean)];
  }
  return [...new Set(ids)].map((sid, i) => {
    const run = runOf(sid);
    const fix = !run && job.mainNotices?.find((n) => n.resolving?.sessionId === sid);
    const label = fix ? 'Local main fix' : !run ? 'Session' : run.phase === 'planning' ? planningLabel(run) : PHASE[run.phase] || 'Session';
    return { sid, n: i + 1, run, label, icon: fix ? ICONS.branch : PHASE_ICON[run?.phase] || ICONS.terminal, startedAt: run?.startedAt || fix?.resolving?.at || null };
  });
}

// What the card itself says now, off the graph's session list (`sessionOf`):
// an archived card is not in it, and opening one restores it.
export function rowState(card) {
  if (!card) return { tone: 'idle', text: 'Archived · opens restored' };
  if (card.status === 'needs-you') return { tone: 'warn', text: card.waitingFor || 'Needs you' };
  if (card.status === 'working') return { tone: 'run', text: 'Working' };
  if (card.managed === false) return { tone: 'idle', text: 'Dormant · opens resumed' };
  return { tone: 'idle', text: 'Idle' };
}

const clock = (at) => at ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

export function sessionRowHtml(row, { selected, card }) {
  const st = rowState(card);
  const icon = st.tone === 'run' ? ICONS.spin : row.icon;
  return `<button type="button" class="job-mc-row tone-${st.tone}" role="option" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-pick-session="${esc(row.sid)}" title="${esc(`${row.label} · run ${row.n} · ${st.text}`)}">${icon}<b>${esc(row.label)}<span class="job-mc-runno">run ${row.n}</span></b><time>${esc(clock(row.startedAt))}</time><small>${esc(st.text)}</small></button>`;
}

// Newest first, as the step reads: the latest run is what is happening.
export function sessionsListHtml(rows, { selected, sessionOf, title, step = true }) {
  return `<div class="job-mc-scope">${step ? 'Runs of' : 'Wrangler’s own runs on'} <b>${esc(title)}</b>, newest first.</div>
    <div class="job-mc-rows" role="listbox" aria-label="${step ? 'Sessions of this step' : 'Wrangler’s own sessions'}">${[...rows].reverse().map((r) => sessionRowHtml(r, { selected: r.sid === selected, card: sessionOf(r.sid) })).join('')}</div>`;
}

export const sessionsCountLabel = (n) => `${n} session${n === 1 ? '' : 's'} · this step only`;

// The way in, from a step's (or the job's) action row.
export function sessionsButtonHtml(rows, { primary = false, step = true } = {}) {
  if (!rows.length) return '';
  return `<button type="button" ${primary ? 'class="primary" ' : ''}data-sessions title="${step ? 'This step’s sessions' : 'Wrangler’s own sessions: planning and conversations'}, on this page">${ICONS.terminal}Sessions <span class="job-n">${rows.length}</span></button>`;
}
