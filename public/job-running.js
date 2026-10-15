import { esc } from './util.js';
import { ICONS } from './icons.js';
import { readyRun } from './jobs.js';

// What the agent left running for the human to try (server/job-running.js): the
// running chip on a Code review step, the amber note when a teardown left
// something up, and the board's green dot. The extension only reads the list the
// agent's receipt gave and tears it down; every name, url and log here is
// agent-written and reaches the page only through esc().

export const runningItems = (sub) => (sub?.running?.items || []).filter((i) => i && i.name);
export const hasRunning = (sub) => runningItems(sub).length > 0;
export const runningDown = (sub) => runningItems(sub).filter((i) => i.up === false);
// An entry's address as a link only when it is plain http(s): the schema already
// says so, and a stored one from anywhere else is shown as text, never as href.
export const safeHref = (u) => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? u : null;
const where = (u) => String(u || '').replace(/^https?:\/\//i, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The board's card: a green dot when any step of the job still has something up.
export const jobHasRunning = (job) => (job.subJobs || []).some((s) => runningItems(s).some((i) => i.up !== false));
export const runningDotHtml = (job) => jobHasRunning(job) ? `<span class="job-run-dot" title="The agent left something running for you to try" role="img" aria-label="Something is running for you"></span>` : '';

// On a Code review step what is running is one chip among the step's own, a
// popover behind it holding each link, Logs, a restart when something stopped
// answering, and Stop all. `open` is the view's memory of the popover.
export function runningChipHtml(job, sub, { open = false, logs = null } = {}) {
  const items = runningItems(sub);
  if (!items.length) return '';
  const down = runningDown(sub), up = items.length - down.length;
  const asked = sub.answering?.kind === 'restart';
  const canAsk = !!readyRun(job, sub) && !asked;
  const label = down.length ? (up ? `${up} of ${items.length} running` : 'Not running') : `${items.length} running`;
  const row = (i) => {
    const href = i.url && safeHref(i.url);
    const link = i.url ? (href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Opens in a new tab">${esc(where(i.url))} ↗</a>` : `<code>${esc(i.url)}</code>`) : '';
    return `<li class="${i.up === false ? 'down' : ''}" title="${esc([i.pid ? `process group ${i.pid}` : '', i.stop || ''].filter(Boolean).join(' · '))}"><span class="job-run-dot ${i.up === false ? 'down' : ''}"></span><b>${esc(i.name)}</b>${link}${i.up === false ? '<small>not answering</small>' : ''}${i.log ? `<button type="button" class="job-run-log" data-running-logs="${esc(i.name)}">${ICONS.terminal}Logs</button>` : ''}</li>`;
  };
  const restart = down.length && canAsk ? `<button type="button" data-running-restart="${down.length === items.length ? '' : esc(down[0].name)}">${ICONS.play}Ask it to start again</button>` : '';
  const note = asked ? 'Asked the session to start it again…' : down.length ? `${plural(down.length, 'thing', 'things')} stopped answering` : 'Stops when you approve.';
  return `<details class="job-run-pop" data-keep="running" ${open ? 'open' : ''}><summary class="job-chip job-run-chip ${down.length ? 'down' : 'on'}" title="What the agent left running for you to try"><span class="job-run-dot ${down.length ? 'down' : ''}"></span><span>${label}</span></summary>
    <div class="job-run-panel" aria-label="Running for you"><ul class="job-run-svcs">${items.map(row).join('')}</ul>${logs ? logsHtml(logs) : ''}<footer><small>${note}</small>${restart}<button type="button" data-running-stop>${ICONS.stop}Stop all</button></footer></div></details>`;
}

const logsHtml = (l) => `<div class="job-run-logs"><header><b>${esc(l.name)}</b><small>${l.error ? '' : l.truncated ? 'last 24 KB' : 'whole log'}</small></header>${l.error ? `<p class="job-run-log-err">${esc(l.error)}</p>` : `<pre>${esc(l.text || '')}</pre>`}</div>`;

// After a teardown: what was stopped and how, amber when something still answers
// (never a failed approval, only a flag the human can act on).
export function stoppedHtml(sub) {
  const st = sub?.running?.stopped;
  if (!st?.results?.length) return '';
  const still = st.still || [];
  const ok = st.results.length - still.length;
  const head = still.length ? `${still.map(esc).join(', ')} may still be running` : `Stopped what the agent started`;
  const note = still.length ? `${ok} of ${st.results.length} stopped · stop ${still.length === 1 ? 'it' : 'them'} by hand` : `${st.results.length} of ${st.results.length} · ${esc(st.reason)}`;
  return `<section class="job-running ${still.length ? 'warn' : 'done'}" aria-label="What the agent left running">${still.length ? '<span class="job-run-dot warn"></span>' : ICONS.check}<b>${head}</b><small>${note}</small>
    <ul class="job-run-svcs">${st.results.map((r) => `<li class="${r.ok ? '' : 'down'}"><span>${esc(r.name)}</span><small>${esc(r.detail)}</small></li>`).join('')}</ul></section>`;
}
