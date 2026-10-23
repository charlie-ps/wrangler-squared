import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { showOf, shotsOf, proofItems, hasProof, proofSummary, summaryText, alsoChecked, verdictOf, verdictText, filmFiles, filmSpots, proofListHtml, proofViewerHtml, shotBoxHtml, shotButtonHtml, filmHtml, hydrateEvidence, EvidenceCache } from './job-proof.js';

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

test('the summary counts what was shown and what could not be, and the verdict counts the plain checks too', () => {
  const s = proofSummary(sub());
  assert.deepEqual(s, { total: 4, gaps: 1, shown: 3, round: 1 });
  assert.equal(summaryText(s), '3 of 4 shown · 1 couldn’t');
  assert.equal(summaryText({ shown: 2, total: 2, gaps: 0 }), '2 of 2 shown');
  assert.deepEqual(alsoChecked(sub()), ['Lint clean']);
  assert.equal(verdictText(verdictOf(sub())), '4 of 5 checked · 1 couldn’t show');
  assert.equal(verdictText({ checked: 2, all: 2, gaps: 0 }), '2 of 2 checked');
  assert.deepEqual(filmFiles(sub()), ['l.png', 'f.png', 'f2.png'], 'the first shots in grid order, three at most');
});

test('the list is the verdict, then a row per item with its evidence at the end, then the plain checks as rows', () => {
  const html = proofListHtml(job, sub());
  assert.match(html, /<div class="job-proof-verdict"><b>4 of 5 checked<\/b><span class="gap">· 1 couldn’t show<\/span><\/div>/, 'the header names the round, so the list does not repeat it');
  assert.doesNotMatch(html, /Shown working|Also checked/, 'no headings repeat what the rows say');
  const rows = html.match(/<details class="job-proof-item[^"]*"/g);
  assert.deepEqual(rows, ['<details class="job-proof-item "', '<details class="job-proof-item "', '<details class="job-proof-item gap"', '<details class="job-proof-item "']);
  assert.match(html, /<div class="job-proof-item plain"><span class="job-proof-mk" aria-hidden="true">✓<\/span><span class="t">Lint clean<\/span><\/div><\/div><\/section>$/, 'plain checks close the same list');
  assert.match(html, /<span class="t">SSO appears<small>No SSO key in this worktree<\/small><\/span><span class="job-proof-ev"><span class="job-proof-pill gap">couldn’t<\/span>/);
  assert.match(html, /<span class="job-proof-pill ">exit 0<\/span>/, 'a run is its exit code at rest');
  assert.equal((html.match(/job-proof-thumb mini/g) || []).length, 2, 'one thumbnail a row, however many shots it has');
  assert.match(html, /data-ev-job="job1" data-ev-sub="api" data-ev-round="1" data-ev-file="l\.png"/);
});

test('an open row holds the detail: every shot with where it was taken, the full output, a long reason, the note and Ask', () => {
  const html = proofListHtml(job, sub(), { isOpen: (k) => k === 'proof-1-1' });
  assert.match(html, /<details class="job-proof-item " data-keep="proof-1-1" open>/);
  assert.equal((html.match(/ open>/g) || []).length, 1);
  assert.match(html, /data-proof="1" data-proof-at="1" title="Open full size">.*<small>localhost:5174\/audit · 1280x800<\/small>/);
  assert.match(html, /<p>Result = Failed<\/p>/);
  assert.match(html, /<pre class="job-proof-run"><i>\$<\/i> npm test\n42 passed\n<b class="ok">exit 0<\/b><\/pre>/);
  assert.match(html, /data-proof-ask="2"[^>]*>.*Ask it to try another way/);
  assert.match(html, /data-proof-ask="0"[^>]*>.*Ask about this/);
  assert.doesNotMatch(html, /<p class="gap">No SSO key/, 'a one-sentence reason is not said twice');
  const long = sub({ ready: { round: 2, checks: ['x'], proof: [{ text: 'x', couldNot: 'Mobile emulation crashes. A 400px window covers it.' }] } });
  const lh = proofListHtml(job, long);
  assert.match(lh, /<small>Mobile emulation crashes\.<\/small>/);
  assert.match(lh, /<p class="gap">Mobile emulation crashes\. A 400px window covers it\.<\/p>/);
  assert.match(lh, /data-keep="proof-2-0"/, 'a new round opens nothing the old one had open');
  assert.doesNotMatch(proofListHtml(job, sub(), { ask: false }), /data-proof-ask/, 'a delivered step has nothing to ask');
  const many = sub({ ready: { round: 1, checks: ['A'], proof: [{ text: 'A', shots: ['1', '2', '3'].map((n) => shot(`${n}.png`)) }, { text: 'B', run: { cmd: 'x', out: '', exit: 2 } }] } });
  assert.match(proofListHtml(job, many), /<small>\+2<\/small>/);
  assert.match(proofListHtml(job, many), /job-proof-pill bad">exit 2/);
});

test('everything an agent wrote is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = sub({ show: [evil], ready: { round: 1, checks: [evil], proof: [{ text: evil, note: evil, shots: [shot('a.png', { url: evil, viewport: evil, tool: evil })] }, { text: `${evil}2`, couldNot: evil }, { text: `${evil}3`, run: { cmd: evil, out: evil, exit: 1 } }] } });
  for (const html of [proofListHtml(job, s), proofListHtml(job, s, { isOpen: () => true }), ...[0, 1, 2].map((i) => proofViewerHtml(job, s, { i }, new EvidenceCache())), filmHtml(job, s)]) {
    assert.doesNotMatch(html, /<img src=x/, 'no raw agent markup reaches the page');
  }
  assert.match(proofListHtml(job, s), /&lt;img src=x onerror=alert\(1\)&gt;/);
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

test('a multi-shot check is a stack with its count, open it is a tray of its shots in its place among the checks, and a file named twice is one shot', () => {
  const cache = new EvidenceCache();
  const four = sub({ ready: { round: 1, checks: ['Wizard', 'B', 'C'], proof: [{ text: 'Wizard', shots: ['1', '2', '3', '4', '2'].map((n) => shot(`w${n}.png`)) }, { text: 'B', shots: [shot('b.png'), shot('b.png')] }, { text: 'C', run: { cmd: 'npm test', out: 'ok', exit: 0 } }] } });
  assert.deepEqual(shotsOf(four.ready.proof[0]).map((s) => s.file), ['w1.png', 'w2.png', 'w3.png', 'w4.png']);
  assert.deepEqual(filmFiles(four, 9), ['w1.png', 'w2.png', 'w3.png', 'w4.png', 'b.png']);
  const html = proofViewerHtml(job, four, { i: 0, j: 2 }, cache);
  assert.equal((html.match(/data-proof-shot=/g) || []).length, 4, 'four real shots');
  assert.equal((html.match(/data-proof-go=/g) || []).length, 2, 'the open check is its tray, the others are checks');
  assert.equal((html.match(/class="job-proof-pick/g) || []).length, 6, 'shots + other checks, nothing repeated');
  assert.match(html, /<small>Checks · 3<\/small><div class="job-proof-strip"><div class="job-proof-tray" role="group" aria-label="Wizard · 4 shots">(<button[^>]*data-proof-shot[^>]*>.*?<\/button>){4}<small>3\/4<\/small><\/div><button[^>]*data-proof-go="1"/s, 'the tray comes first, where its check is');
  assert.match(html, /class="job-proof-pick sel" data-proof-shot="2" aria-label="Shot 3 of 4"/);
  assert.doesNotMatch(html, /Shots in this check|All checks|job-proof-count/);
  const single = proofViewerHtml(job, four, { i: 1 }, cache);
  assert.match(single, /<button type="button" class="job-proof-pick stack " data-proof-go="0" aria-label="Wizard · 4 shots"[^>]*>.*<b class="job-proof-count" aria-hidden="true">4<\/b><\/button>/s, 'closed, the check says how many shots it holds');
  assert.match(single, /class="job-proof-pick  sel" data-proof-go="1" aria-label="B"/, 'a file named twice is not a second shot, so no stack');
  assert.doesNotMatch(single, /data-proof-shot|job-proof-tray/);
  assert.equal((single.match(/class="job-proof-pick/g) || []).length, 3);
  assert.match(proofListHtml(job, four), /<small>\+3<\/small>/, 'one thumbnail at rest, and how many more');
});

test('a job whose checks each have one shot keeps one plain strip', () => {
  const html = proofViewerHtml(job, sub({ ready: { round: 1, checks: [], proof: [{ text: 'A', shots: [shot('a.png')] }, { text: 'B', shots: [shot('b.png')] }, { text: 'C', couldNot: 'no' }] } }), { i: 0 }, new EvidenceCache());
  assert.match(html, /<div class="job-proof-strip"><button/);
  assert.doesNotMatch(html, /job-proof-row|job-proof-tray|job-proof-count|stack|data-proof-shot/);
  assert.equal((html.match(/data-proof-go=/g) || []).length, 3);
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
  assert.match(proofListHtml(job, clip), /job-proof-thumb mini video/);
  cache.note(null); cache.note({});
});

test('a thread shot is a button around its slot, and the lightbox shows one shot of its group with the way to its neighbours', () => {
  const cache = new EvidenceCache();
  assert.match(shotButtonHtml(job, sub(), 2, 'a<b>.png', 1), /^<button type="button" class="job-shot-open" data-shot-at="1" title="Open full size" aria-label="Open shot 2 full size"><span class="job-proof-thumb[^"]*" data-ev-job="job1" data-ev-sub="api" data-ev-round="2" data-ev-file="a&lt;b&gt;.png">/);
  const box = { round: 2, files: ['a.png', 'b.webm', 'c.png'], at: 0 };
  const first = shotBoxHtml(job, sub(), box, cache);
  assert.match(first, /data-ev-round="2" data-ev-file="a.png"/);
  assert.match(first, /<b>1 of 3<\/b>/);
  assert.match(first, /data-shotbox-go="-1"[^>]*disabled/, 'nothing before the first');
  assert.doesNotMatch(first, /data-shotbox-go="1"[^>]*disabled/);
  assert.match(first, /job-proof-thumb big/, 'a placeholder until a frame comes');
  cache.note({ jobId: 'job1', subJobId: 'api', round: 2, file: 'b.webm', mime: 'video/webm', dataBase64: 'dmlk' });
  const clip = shotBoxHtml(job, sub(), { ...box, at: 1 }, cache);
  assert.match(clip, /<video class="job-proof-full" controls src="data:video\/webm;base64,dmlk">/, 'a clip plays there');
  assert.match(shotBoxHtml(job, sub(), { ...box, at: 9 }, cache), /3 of 3.*data-shotbox-go="1"[^>]*disabled/s, 'past the end lands on the last');
  assert.doesNotMatch(shotBoxHtml(job, sub(), { round: 1, files: ['x.png'], at: 0 }, cache), /data-shotbox-go/, 'one shot: no stepping');
  assert.equal(shotBoxHtml(job, sub(), { round: 1, files: [], at: 0 }, cache), '');
  assert.match(shotBoxHtml(job, sub(), { round: 1, files: ['<i>.png'], at: 0 }, cache), /&lt;i&gt;\.png · Round 1/);
});

test('the plate filmstrip is the first three shots and how many more there are', () => {
  assert.equal((filmHtml(job, sub()).match(/job-proof-thumb/g) || []).length, 3);
  assert.match(filmHtml(job, sub()), /^<div class="job-plate-film"/);
  assert.doesNotMatch(filmHtml(job, sub()), /<small>/, 'three shots, none to add');
  const many = sub({ ready: { round: 1, checks: ['A'], proof: [{ text: 'A', shots: ['1', '2', '3', '4'].map((n) => shot(`${n}.png`)) }] } });
  assert.match(filmHtml(job, many), /<small>\+1<\/small>/);
  assert.equal(filmHtml(job, sub({ ready: { round: 1, checks: ['x'], proof: [{ text: 'x', couldNot: 'no' }] } })), '', 'no shots, no strip');
});

test('each filmstrip thumbnail opens the step\'s viewer on its own shot, and +N on the first shot not drawn', () => {
  const html = filmHtml(job, sub());
  assert.deepEqual([...html.matchAll(/<button type="button" class="job-plate-shot" data-film="(\d+:\d+)" data-film-job="job1" data-film-sub="api" title="Open this shot/g)].map((m) => m[1]), ['0:0', '1:0', '1:1'], 'l.png, f.png, f2.png in viewer order');
  assert.doesNotMatch(html, /<(div|button)[^>]*aria-hidden/, 'the strip and its buttons are not hidden');
  const dup = sub({ ready: { round: 1, checks: ['A', 'B'], proof: [{ text: 'A', shots: [shot('a.png')] }, { text: 'B', shots: [shot('a.png'), shot('b.png'), shot('c.png'), shot('d.png')] }] }, show: [] });
  assert.deepEqual(Object.fromEntries(filmSpots(dup)), { 'a.png': { i: 0, j: 0 }, 'b.png': { i: 1, j: 1 }, 'c.png': { i: 1, j: 2 }, 'd.png': { i: 1, j: 3 } }, 'a file named again opens where it first appears');
  assert.match(filmHtml(job, dup), /data-film="1:3"[^>]*title="Open the other 2 shots"[^>]*><small>\+2<\/small><\/button>/, '+N opens the first shot the strip left out');
});

test('hydrating fills a slot from the cache and asks the server once per round for what it lacks', async (t) => {
  const window = new Window({ url: 'http://localhost:7878' });
  t.after(() => window.happyDOM.close());
  const doc = window.document;
  doc.body.innerHTML = proofListHtml(job, sub());
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
