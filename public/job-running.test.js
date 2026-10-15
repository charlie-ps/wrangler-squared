import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningItems, hasRunning, runningDown, safeHref, runningBarHtml, stoppedHtml, jobHasRunning, runningDotHtml } from './job-running.js';

const VITE = { name: 'vite dev server', url: 'http://localhost:5174/admin/security/audit', pid: 48211, log: '/wt/vite.log', up: true };
const DB = { name: 'postgres with fixtures', url: 'http://localhost:55432/', stop: 'docker compose -p sec-412 down', up: true };
const sub = (extra = {}, items = [VITE, DB]) => ({ id: 'api', stage: 'review', state: 'verified', ready: { round: 1 }, running: { items }, ...extra });
const job = (s = sub()) => ({ id: 'j1', subJobs: [s], runs: [{ id: 'r1', subJobId: 'api', sessionId: 's1', parkedFor: 'ready', parkedAt: 1 }] });

test('the bar links the running page and lists each process with its port and group', () => {
  const html = runningBarHtml(job(), sub());
  assert.match(html, /Running for you/);
  assert.match(html, /<a href="http:\/\/localhost:5174\/admin\/security\/audit" target="_blank" rel="noopener noreferrer"[^>]*>localhost:5174\/admin\/security\/audit ↗/);
  assert.match(html, /vite dev server<\/span><small>:5174 · process group 48211/);
  assert.match(html, /postgres with fixtures<\/span><small>:55432 · docker compose -p sec-412 down/);
  assert.match(html, /data-running-logs="vite dev server"/, 'Logs on the entry that has a log');
  assert.doesNotMatch(html, /data-running-logs="postgres/);
  assert.match(html, /data-running-stop/);
  assert.match(html, /stops when you approve/);
  assert.match(runningBarHtml(job(), sub({ ready: { round: 2 } })), /reloaded with round 2/);
});

test('a down entry turns the bar amber and offers one click to ask the session to start it again', () => {
  const s = sub({}, [{ ...VITE, up: false }, DB]);
  const html = runningBarHtml(job(s), s);
  assert.match(html, /job-running down/);
  assert.match(html, /1 thing stopped answering/);
  assert.match(html, /data-running-restart="vite dev server"/);
  assert.match(html, /vite dev server<\/span><small>[^<]*not answering/);
  const all = sub({}, [{ ...VITE, up: false }]);
  assert.match(runningBarHtml(job(all), all), /data-running-restart=""/, 'everything down asks for everything');
  const asked = sub({ answering: { kind: 'restart' } }, [{ ...VITE, up: false }]);
  assert.doesNotMatch(runningBarHtml(job(asked), asked), /data-running-restart/);
  assert.match(runningBarHtml(job(asked), asked), /Asked the session to start it again/);
  const noSession = { id: 'j1', subJobs: [s], runs: [] };
  assert.doesNotMatch(runningBarHtml(noSession, s), /data-running-restart/, 'nobody left to ask');
});

test('agent text is escaped and a link is only ever plain http(s)', () => {
  const evil = sub({}, [{ name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', pid: 5, log: '/x', up: true }]);
  const html = runningBarHtml(job(evil), evil);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /&lt;img/);
  assert.equal(safeHref('http://localhost:1/'), 'http://localhost:1/');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('http://a b'), null);
  const logs = runningBarHtml(job(), sub(), { logs: { name: 'vite dev server', text: '<script>x</script>', truncated: true } });
  assert.match(logs, /&lt;script&gt;/);
  assert.match(logs, /last 24 KB/);
  assert.match(runningBarHtml(job(), sub(), { logs: { name: 'vite dev server', error: 'The log file is not there' } }), /job-run-log-err">The log file is not there/);
});

test('after teardown the step says what stopped, amber when something may still be up', () => {
  const done = { id: 'api', running: { items: [], stopped: { at: 1, reason: 'approved', still: [], results: [{ name: 'vite', ok: true, detail: 'process group 48211 killed · stopped answering' }, { name: 'db', ok: true, detail: 'docker compose -p x down · exit 0 · stopped answering' }] } } };
  const html = runningBarHtml(job(done), done);
  assert.match(html, /Stopped what the agent started/);
  assert.match(html, /2 of 2 · approved/);
  assert.doesNotMatch(html, /warn/);
  const left = { id: 'api', running: { items: [], stopped: { at: 1, reason: 'approved', still: ['db'], results: [{ name: 'vite', ok: true, detail: 'killed' }, { name: 'db', ok: false, detail: 'exit 1 · still answering' }] } } };
  assert.match(stoppedHtml(left), /job-running warn.*db may still be running.*1 of 2 stopped/s);
  assert.equal(stoppedHtml({ id: 'x' }), '');
  assert.equal(runningBarHtml(job({ id: 'x' }), { id: 'x' }), '');
});

test('the board draws a green dot only while something is up', () => {
  assert.equal(jobHasRunning(job()), true);
  assert.match(runningDotHtml(job()), /job-run-dot/);
  assert.equal(runningDotHtml(job(sub({}, []))), '');
  assert.equal(jobHasRunning(job(sub({}, [{ ...VITE, up: false }]))), false, 'a dead preview is not "running"');
  assert.deepEqual([hasRunning(sub()), runningItems({}).length, runningDown(sub({}, [{ ...VITE, up: false }])).length], [true, 0, 1]);
});
