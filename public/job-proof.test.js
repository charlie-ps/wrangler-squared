import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { showOf, proofItems, hasProof, proofSummary, summaryText, alsoChecked, filmFiles, proofGridHtml, alsoCheckedHtml, proofViewerHtml, filmHtml, hydrateEvidence, EvidenceCache } from './job-proof.js';

const job = { id: 'job1' };
const shot = (file, extra = {}) => ({ file, mime: 'image/png', at: 1700000000000, url: 'http://localhost:5174/audit', viewport: '1280x800', tool: 'Playwright', ...extra });
const sub = (extra = {}) => ({ id: 'api', title: 'Audit page', worktree: { path: '/wt/api', branch: 'sec-412' }, show: ['Lists sign-ins', 'Filters', 'SSO appears', 'Unit tests pass'],
  ready: { round: 1, receiptId: 'r1', checks: ['Lint clean', 'Unit tests pass', 'Filters', 'Lists sign-ins', 'SSO appears'],
    proof: [{ text: 'Unit tests pass', run: { cmd: 'npm test', out: '42 passed', exit: 0 } }, { text: 'Filters', shots: [shot('f.png'), shot('f2.png', { tool: undefined })], note: 'Result = Failed' },
      { text: 'Lists sign-ins', shots: [shot('l.png')] }, { text: 'SSO appears', couldNot: 'No SSO key in this worktree' }] }, ...extra });

test('proof reads in the order the plan asked for it, and a receipt without proof reads as it always did', () => {
  assert.deepEqual(proofItems(sub()).map((p) => p.text), ['Lists sign-ins', 'Filters', 'SSO appears', 'Unit tests pass']);
  assert.deepEqual(showOf(sub()).length, 4);
  assert.deepEqual(showOf({}), []);
  const extra = sub({ show: ['Filters'] });
  assert.deepEqual(proofItems(extra).map((p) => p.text), ['Filters', 'Unit tests pass', 'Lists sign-ins', 'SSO appears'], 'what the plan did not ask for follows, in the agent\'s order');
  const old = { id: 'api', ready: { checks: ['Tests pass'], receiptId: 'r' } };
  assert.deepEqual([hasProof(old), proofItems(old), proofItems({})], [false, [], []]);
  assert.equal(proofSummary(old).round, 1);
});

test('the summary counts what was shown and what could not be, and plain checks stay under Also checked', () => {
  const s = proofSummary(sub());
  assert.deepEqual(s, { total: 4, gaps: 1, shown: 3, round: 1 });
  assert.equal(summaryText(s), '3 of 4 shown · 1 couldn’t');
  assert.equal(summaryText({ shown: 2, total: 2, gaps: 0 }), '2 of 2 shown');
  assert.deepEqual(alsoChecked(sub()), ['Lint clean']);
  assert.match(alsoCheckedHtml(sub()), /<h3>Also checked<\/h3>.*Lint clean/s);
  assert.equal(alsoCheckedHtml(sub({ ready: { ...sub().ready, checks: ['Lists sign-ins', 'Filters', 'SSO appears', 'Unit tests pass'] } })), '', 'nothing plain, nothing drawn');
  assert.deepEqual(filmFiles(sub()), ['l.png', 'f.png', 'f2.png'], 'the first shots in grid order, three at most');
});

test('the grid is a card per item: a thumbnail slot, a tick, a caption; a reason is amber and a run is its command', () => {
  const html = proofGridHtml(job, sub());
  assert.match(html, /Shown working<\/span><small>3 of 4 shown · 1 couldn’t<\/small><span class="job-proof-round">Round 1/);
  assert.equal((html.match(/class="job-proof-card/g) || []).length, 4);
  assert.match(html, /job-proof-card gap" data-proof="2"[^>]*title="Could not show it: open for the reason"/);
  assert.match(html, /<small>No SSO key in this worktree<\/small>/);
  assert.match(html, /<small>npm test · exit 0<\/small>/);
  assert.match(html, /<small>Result = Failed<\/small>/);
  assert.match(html, /<em class="job-proof-count" title="2 shots">2<\/em>/, 'an item with two shots says so');
  assert.match(html, /data-ev-job="job1" data-ev-sub="api" data-ev-round="1" data-ev-file="l\.png"/);
  assert.match(html, /<span class="job-proof-term"><i>\$<\/i> npm test\n42 passed/);
});

test('everything an agent wrote is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = sub({ show: [evil], ready: { round: 1, checks: [evil], proof: [{ text: evil, note: evil, shots: [shot('a.png', { url: evil, viewport: evil, tool: evil })] }, { text: `${evil}2`, couldNot: evil }, { text: `${evil}3`, run: { cmd: evil, out: evil, exit: 1 } }] } });
  for (const html of [proofGridHtml(job, s), alsoCheckedHtml(s), ...[0, 1, 2].map((i) => proofViewerHtml(job, s, { i }, new EvidenceCache())), filmHtml(job, s)]) {
    assert.doesNotMatch(html, /<img src=x/, 'no raw agent markup reaches the page');
  }
  assert.match(proofGridHtml(job, s), /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the viewer says where a shot was taken, shows a reason in full, and a run as the command it was', () => {
  const cache = new EvidenceCache();
  const open = proofViewerHtml(job, sub(), { i: 0 }, cache, { branch: 'sec-412' });
  assert.match(open, /<h2>Shown working · 1 of 4<\/h2>/);
  assert.match(open, /Round 1<\/span>.*sec-412/s);
  assert.match(open, /<dt>URL<\/dt><dd>http:\/\/localhost:5174\/audit<\/dd><dt>Viewport<\/dt><dd>1280x800<\/dd><dt>How<\/dt><dd>Playwright<\/dd><dt>At<\/dt>/);
  assert.match(open, /data-proof-ask="0"[^>]*>.*Ask about this/s);
  assert.equal((open.match(/data-proof-go=/g) || []).length, 4, 'every item is in the strip');
  const gap = proofViewerHtml(job, sub(), { i: 2 }, cache);
  assert.match(gap, /job-proof-stage gap.*Couldn’t show this.*No SSO key in this worktree/s);
  assert.match(gap, /Ask it to try another way/);
  assert.doesNotMatch(gap, /<dl/, 'a reason has no capture to describe');
  const run = proofViewerHtml(job, sub(), { i: 3 }, cache);
  assert.match(run, /<pre class="job-proof-run"><i>\$<\/i> npm test\n42 passed\n<b class="ok">exit 0<\/b>/);
  assert.match(run, /<dt>In<\/dt><dd>\/wt\/api<\/dd>.*<dt>Exit<\/dt><dd>0<\/dd>/s);
  assert.match(proofViewerHtml(job, sub(), { i: 3 }, cache).replace('exit 0', 'x'), /job-proof-run/);
  const multi = proofViewerHtml(job, sub(), { i: 1, j: 1 }, cache);
  assert.equal((multi.match(/data-proof-shot=/g) || []).length, 2, 'two shots of one item can be flipped between');
  assert.match(multi, /<dt>How<\/dt><dd>Screenshot<\/dd>/, 'an agent that did not say how is not credited with a tool');
  assert.equal(proofViewerHtml(job, { ...sub(), ready: null }, { i: 0 }, cache), '');
  assert.match(proofViewerHtml(job, sub(), { i: 99 }, cache), /4 of 4/, 'an index past the end lands on the last item');
});

test('the viewer shows the thumbnail soft until the full file arrives, a clip as a video, and the cache fills from frames', () => {
  const cache = new EvidenceCache();
  assert.match(proofViewerHtml(job, sub(), { i: 0 }, cache), /job-proof-thumb big/, 'nothing yet: a placeholder');
  cache.note({ jobId: 'job1', subJobId: 'api', round: 1, thumbs: [{ file: 'l.png', mime: 'image/jpeg', dataBase64: 'dGh1bWI=' }, { file: 'x.png', mime: 'image/jpeg' }] });
  assert.match(proofViewerHtml(job, sub(), { i: 0 }, cache), /job-proof-full soft" alt="Lists sign-ins" src="data:image\/jpeg;base64,dGh1bWI="/);
  assert.equal(cache.thumb('job1', 'api', 1, 'x.png'), null, 'a frame entry with no bytes is nothing');
  cache.note({ jobId: 'job1', subJobId: 'api', round: 1, file: 'l.png', mime: 'image/png', dataBase64: 'ZnVsbA==' });
  assert.match(proofViewerHtml(job, sub(), { i: 0 }, cache), /<img class="job-proof-full" alt="Lists sign-ins" src="data:image\/png;base64,ZnVsbA=="/);
  const clip = sub({ ready: { round: 1, checks: ['Clip'], proof: [{ text: 'Clip', shots: [shot('c.webm', { mime: 'video/webm' })] }] } });
  cache.note({ jobId: 'job1', subJobId: 'api', round: 1, file: 'c.webm', mime: 'video/webm', dataBase64: 'dmlk' });
  assert.match(proofViewerHtml(job, clip, { i: 0 }, cache), /<video class="job-proof-full" controls src="data:video\/webm;base64,dmlk">/);
  assert.match(proofGridHtml(job, clip), /job-proof-thumb  video/);
  cache.note(null); cache.note({});
});

test('the plate filmstrip is the first three shots and how many more there are', () => {
  assert.equal((filmHtml(job, sub()).match(/job-proof-thumb/g) || []).length, 3);
  assert.match(filmHtml(job, sub()), /^<div class="job-plate-film"/);
  assert.doesNotMatch(filmHtml(job, sub()), /<small>/, 'three shots, none to add');
  const many = sub({ ready: { round: 1, checks: ['A'], proof: [{ text: 'A', shots: ['1', '2', '3', '4'].map((n) => shot(`${n}.png`)) }] } });
  assert.match(filmHtml(job, many), /<small>\+1<\/small>/);
  assert.equal(filmHtml(job, sub({ ready: { round: 1, checks: ['x'], proof: [{ text: 'x', couldNot: 'no' }] } })), '', 'no shots, no strip');
});

test('hydrating fills a slot from the cache and asks the server once per round for what it lacks', async (t) => {
  const window = new Window({ url: 'http://localhost:7878' });
  t.after(() => window.happyDOM.close());
  const doc = window.document;
  doc.body.innerHTML = proofGridHtml(job, sub());
  const cache = new EvidenceCache(), sent = [];
  hydrateEvidence(doc.body, cache, (m) => sent.push(m));
  assert.deepEqual(sent, [{ type: 'job-evidence', id: 'job1', subJobId: 'api', round: 1 }]);
  hydrateEvidence(doc.body, cache, (m) => sent.push(m));
  assert.equal(sent.length, 1, 'a tick\'s redraw never asks twice');
  cache.note({ jobId: 'job1', subJobId: 'api', round: 1, thumbs: [{ file: 'l.png', mime: 'image/jpeg', dataBase64: 'dGg=' }] });
  hydrateEvidence(doc.body, cache, (m) => sent.push(m));
  const img = doc.querySelector('[data-ev-file="l.png"] img');
  assert.equal(img.getAttribute('src'), 'data:image/jpeg;base64,dGg=');
  assert.equal(img.getAttribute('alt'), '');
  hydrateEvidence(doc.body, cache, (m) => sent.push(m), { full: { jobId: 'job1', subId: 'api', round: 1, file: 'l.png' } });
  assert.deepEqual(sent.at(-1), { type: 'job-evidence', id: 'job1', subJobId: 'api', round: 1, file: 'l.png' });
  hydrateEvidence(doc.body, cache, (m) => sent.push(m), { full: { jobId: 'job1', subId: 'api', round: 1, file: 'l.png' } });
  assert.equal(sent.filter((m) => m.file).length, 1, 'the full file is asked for once too');
  const before = sent.length;
  hydrateEvidence(doc.body, cache, (m) => sent.push(m));
  assert.equal(sent.length, before, 'the same missing set is never asked twice');
});
