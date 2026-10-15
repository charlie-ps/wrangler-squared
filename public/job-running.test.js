import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningItems, hasRunning, runningDown, safeHref, runningChipHtml, stoppedHtml, jobHasRunning, runningDotHtml } from './job-running.js';

const VITE = { name: 'vite dev server', url: 'http://localhost:5174/admin/security/audit', pid: 48211, log: '/wt/vite.log', up: true };
const DB = { name: 'postgres with fixtures', url: 'http://localhost:55432/', stop: 'docker compose -p sec-412 down', up: true };
const sub = (extra = {}, items = [VITE, DB]) => ({ id: 'api', stage: 'review', state: 'verified', ready: { round: 1 }, running: { items }, ...extra });
const job = (s = sub()) => ({ id: 'j1', subJobs: [s], runs: [{ id: 'r1', subJobId: 'api', sessionId: 's1', parkedFor: 'ready', parkedAt: 1 }] });

test('the chip counts what is up, and its popover links each page and says it stops when you approve', () => {
  const html = runningChipHtml(job(), sub());
  assert.match(html, /<details class="job-run-pop" data-keep="running" >/, 'closed unless the view kept it open');
  assert.match(runningChipHtml(job(), sub(), { open: true }), /data-keep="running" open>/);
  assert.match(html, /<summary class="job-chip job-run-chip on"[^>]*><span class="job-run-dot "><\/span><span>2 running<\/span><\/summary>/);
  assert.match(html, /<a href="http:\/\/localhost:5174\/admin\/security\/audit" target="_blank" rel="noopener noreferrer"[^>]*>localhost:5174\/admin\/security\/audit ↗/);
  assert.match(html, /<li class="" title="process group 48211"><span class="job-run-dot "><\/span><b>vite dev server<\/b>/);
  assert.match(html, /title="docker compose -p sec-412 down"><span class="job-run-dot "><\/span><b>postgres with fixtures<\/b>/, 'how it stops is a tooltip, not text');
  assert.match(html, /data-running-logs="vite dev server"/, 'Logs on the entry that has a log');
  assert.doesNotMatch(html, /data-running-logs="postgres/);
  assert.match(html, /Stops when you approve\..*data-running-stop[^>]*>.*Stop all/s);
  assert.doesNotMatch(html, /reloaded with round|Started by the agent|process group 48211<\/small>/, 'no wordy status line');
  assert.equal(runningChipHtml(job({ id: 'x' }), { id: 'x' }), '');
});

test('a down entry turns the chip amber and offers one click to ask the session to start it again', () => {
  const s = sub({}, [{ ...VITE, up: false }, DB]);
  const html = runningChipHtml(job(s), s);
  assert.match(html, /job-run-chip down"[^>]*><span class="job-run-dot down"><\/span><span>1 of 2 running</);
  assert.match(html, /1 thing stopped answering/);
  assert.match(html, /data-running-restart="vite dev server"/);
  assert.match(html, /<li class="down"[^>]*>.*<b>vite dev server<\/b>.*<small>not answering<\/small>/);
  const all = sub({}, [{ ...VITE, up: false }]);
  assert.match(runningChipHtml(job(all), all), /data-running-restart=""/, 'everything down asks for everything');
  assert.match(runningChipHtml(job(all), all), /<span>Not running<\/span>/);
  const asked = sub({ answering: { kind: 'restart' } }, [{ ...VITE, up: false }]);
  assert.doesNotMatch(runningChipHtml(job(asked), asked), /data-running-restart/);
  assert.match(runningChipHtml(job(asked), asked), /Asked the session to start it again/);
  const noSession = { id: 'j1', subJobs: [s], runs: [] };
  assert.doesNotMatch(runningChipHtml(noSession, s), /data-running-restart/, 'nobody left to ask');
});

test('agent text is escaped and a link is only ever plain http(s)', () => {
  const evil = sub({}, [{ name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', pid: 5, log: '/x', stop: '"><img src=y>', up: true }]);
  const html = runningChipHtml(job(evil), evil);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /&lt;img/);
  assert.equal(safeHref('http://localhost:1/'), 'http://localhost:1/');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('http://a b'), null);
  const logs = runningChipHtml(job(), sub(), { logs: { name: 'vite dev server', text: '<script>x</script>', truncated: true } });
  assert.match(logs, /job-run-panel.*&lt;script&gt;/s, 'the log opens inside the popover');
  assert.match(logs, /last 24 KB/);
  assert.match(runningChipHtml(job(), sub(), { logs: { name: 'vite dev server', error: 'The log file is not there' } }), /job-run-log-err">The log file is not there/);
});

test('after teardown the step says what stopped, amber when something may still be up', () => {
  const done = { id: 'api', running: { items: [], stopped: { at: 1, reason: 'approved', still: [], results: [{ name: 'vite', ok: true, detail: 'process group 48211 killed · stopped answering' }, { name: 'db', ok: true, detail: 'docker compose -p x down · exit 0 · stopped answering' }] } } };
  const html = stoppedHtml(done);
  assert.match(html, /Stopped what the agent started/);
  assert.match(html, /2 of 2 · approved/);
  assert.doesNotMatch(html, /warn/);
  const left = { id: 'api', running: { items: [], stopped: { at: 1, reason: 'approved', still: ['db'], results: [{ name: 'vite', ok: true, detail: 'killed' }, { name: 'db', ok: false, detail: 'exit 1 · still answering' }] } } };
  assert.match(stoppedHtml(left), /job-running warn.*db may still be running.*1 of 2 stopped/s);
  assert.equal(stoppedHtml({ id: 'x' }), '');
});

test('the board draws a green dot only while something is up', () => {
  assert.equal(jobHasRunning(job()), true);
  assert.match(runningDotHtml(job()), /job-run-dot/);
  assert.equal(runningDotHtml(job(sub({}, []))), '');
  assert.equal(jobHasRunning(job(sub({}, [{ ...VITE, up: false }]))), false, 'a dead preview is not "running"');
  assert.deepEqual([hasRunning(sub()), runningItems({}).length, runningDown(sub({}, [{ ...VITE, up: false }])).length], [true, 0, 1]);
});
