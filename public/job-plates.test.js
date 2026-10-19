import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignScenes, plateAsk, plateHtml, placePopHtml, levelOf, inkFor } from './job-plates.js';
import { planGraphHtml } from './job-graph.js';

const sub = (id, extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/Users/me/repo', after: [], sessions: [], repairs: [], ...extra });
const job = (extra = {}) => ({ id: 'job1', title: 'Sign-in', intent: 'x', repos: ['/Users/me/repo'], stage: 'active', subJobs: [], runs: [], moves: [], reviewMerge: true, createdAt: 1, ...extra });

test('scenes are picked oldest first, never repeat the job before or four back, and stay put', () => {
  const jobs = Array.from({ length: 24 }, (_, i) => job({ id: `j${i}`, createdAt: i }));
  const memo = assignScenes([...jobs].reverse());
  const seq = jobs.map((j) => memo.get(j.id));
  seq.forEach((s, i) => { if (i) assert.notEqual(s, seq[i - 1]); if (i > 3) assert.notEqual(s, seq[i - 4]); });
  assert.ok(new Set(seq).size >= 3, 'the wall mixes scenes');
  assignScenes(jobs.slice(5), memo);
  assert.deepEqual(jobs.map((j) => memo.get(j.id)), seq, 'a job leaving the list never reshuffles the rest');
});

test('the scene brightens as the job lands, and ink follows the art', () => {
  assert.equal(levelOf(job({ stage: 'backlog' })), 1);
  assert.equal(levelOf(job({ subJobs: [sub('a', { stage: 'done' }), sub('b', { stage: 'pr' })] })), 4);
  assert.equal(levelOf(job({ stage: 'done' })), 5);
  assert.equal(inkFor('haiku', 3, 160, 70), 'dk', 'dark ink on the ivory page');
  assert.equal(inkFor('sonnet', 3, 160, 40), 'lt', 'light ink in space');
});

test('the stub names the one thing a job needs from you, and nothing when it needs nothing', () => {
  assert.deepEqual(['label', 'button', 'act', 'sub'].map((k) => plateAsk(job({ stage: 'planning', plan: { stories: [], subJobs: [sub('a'), sub('b', { kind: 'session' })] } }))[k]), ['Plan ready', 'Review plan', 'open', '']);
  assert.equal(plateAsk(job({ stage: 'planning', plan: { stories: [], subJobs: [sub('a')] } })).detail, '1 PR');
  const green = sub('api', { stage: 'pr', pr: { url: 'https://github.com/o/r/pull/7', head: 'h7', checkStatus: 'passing', checks: [] } });
  assert.deepEqual(['label', 'button', 'act', 'sub', 'tone'].map((k) => plateAsk(job({ subJobs: [green] }))[k]), ['Merge #7', 'Merge', 'merge', 'api', 'warn']);
  const review = sub('api', { stage: 'review', state: 'verified' });
  assert.deepEqual(['label', 'button', 'act'].map((k) => plateAsk(job({ subJobs: [review] }))[k]), ['Review code', 'Review', 'open']);
  const kept = sub('api', { stage: 'cleanup', cancelledAt: 1, error: 'Worktree has work that would be lost', cleanupRefusal: { path: '/wt', files: [], fileCount: 0 } });
  assert.deepEqual(['label', 'button', 'tone', 'sub'].map((k) => plateAsk(job({ cancelledAt: 1, subJobs: [kept] }))[k]), ['Cancelled · worktree kept', 'Open', 'warn', 'api']);
  assert.equal(plateAsk(job({ cancelledAt: 1, subJobs: [{ ...kept, error: null, cleanupRefusal: null }] })), null, 'plain cleanup asks for nothing');
  const blocked = sub('api', { stage: 'pr', error: 'Automatic repair limit reached', pr: { url: 'https://github.com/o/r/pull/9', head: 'h9', checkStatus: 'failing', checks: [] } });
  const failing = plateAsk(job({ subJobs: [blocked] }));
  assert.deepEqual([failing.tone, failing.button, failing.act, failing.detail], ['bad', 'Resolve', 'open', '#9 · Deliver api'], 'a red step opens to be resolved: the box is there');
  const prompt = sub('s', { kind: 'session', stage: 'session', sessions: ['card-1'] });
  assert.deepEqual(['button', 'act'].map((k) => plateAsk(job({ subJobs: [prompt], runs: [{ id: 'r', subJobId: 's', stopped: false, status: 'needs-you' }] }))[k]), ['Answer', 'session']);
  assert.equal(plateAsk(job({ subJobs: [sub('api', { stage: 'implementation' })], runs: [{ id: 'r', subJobId: 'api', stopped: false, status: 'working' }] })), null);
  assert.equal(plateAsk(job({ paused: true, subJobs: [green] })), null, 'a paused job asks nothing');
});

test('a prompt waiting anywhere is the stub, answered on the waiting run’s own card', () => {
  const planning = plateAsk(job({ stage: 'planning', plan: null, runs: [{ id: 'p', subJobId: null, stopped: false, status: 'needs-you', sessionId: 'plan-card' }] }));
  assert.deepEqual(['label', 'detail', 'button', 'act', 'sub', 'session'].map((k) => planning[k]), ['Prompt waiting', 'Planning', 'Answer', 'session', '', 'plan-card'], 'the planning run has no sub-job, but it has a card');
  const green = sub('api', { stage: 'pr', pr: { url: 'https://github.com/o/r/pull/7', head: 'h7', checkStatus: 'passing', checks: [] } });
  const note = sub('note', { kind: 'session', stage: 'session', sessions: ['old-card'] });
  const docs = sub('docs', { kind: 'session', stage: 'session' });
  const behind = plateAsk(job({ subJobs: [green, note], runs: [{ id: 'n', subJobId: 'note', stopped: false, status: 'needs-you', sessionId: 'note-card' }] }));
  assert.deepEqual(['label', 'detail', 'act', 'sub', 'session'].map((k) => behind[k]), ['Prompt waiting', 'Deliver note', 'session', 'note', 'note-card'], 'a prompt outranks a green PR earlier in the plan');
  const two = plateAsk(job({ subJobs: [green, note, docs], runs: [{ id: 'd', subJobId: 'docs', stopped: false, status: 'needs-you', sessionId: 'docs-card', startedAt: 1 }, { id: 'n', subJobId: 'note', stopped: false, status: 'needs-you', sessionId: 'note-card', startedAt: 2 }] }));
  assert.deepEqual([two.detail, two.session], ['Deliver docs +1', 'docs-card'], 'the longest-waiting first, the rest counted');
  assert.match(plateHtml(job({ subJobs: [note], runs: [{ id: 'n', subJobId: 'note', stopped: false, status: 'needs-you', sessionId: 'note-card' }] }), 'sonnet'), /data-ask="session" data-job="job1" data-sub="note" data-session="note-card"/);
});

test('a plate draws its plan as kind shapes in the sky, dashed where work waits for a deploy, and escapes what agents wrote', () => {
  const j = job({ title: '<script>x</script>', subJobs: [sub('api', { stage: 'done', deployed: { at: 1 } }), sub('web', { after: ['api'], stage: 'implementation' }), sub('s', { kind: 'session', after: ['web'], stage: 'session' }), sub('h', { kind: 'human', after: ['s'], stage: 'human' })], runs: [{ id: 'r', subJobId: 'web', stopped: false, status: 'working' }] });
  const html = plateHtml(j, 'opus');
  assert.ok(!html.includes('<script>x') && html.includes('&lt;script&gt;'));
  assert.equal((html.match(/class="edge deploy/g) || []).length, 2, 'an edge out of a PR waits for its deploy');
  assert.equal((html.match(/class="edge  /g) || []).length, 1, 'one out of a session starts once it is done');
  assert.match(html, /class="edge deploy lit/, 'a deployed prerequisite lights its edge once the work behind it moves');
  assert.equal((html.match(/<circle class="core"/g) || []).length, 2);
  assert.match(html, /<rect class="core"[^>]*rx="2"/);
  assert.match(html, /transform="rotate\(45/);
  assert.match(html, /class="job-plate-tag lt">repo</);
  assert.match(html, /1 of 4 landed/);
});

test('plate art: the sky alone, or the scene alone with ink that follows it', () => {
  const j = job({ subJobs: [sub('api', { stage: 'implementation' })] });
  const quiet = plateHtml(j, 'haiku', 'quiet'), full = plateHtml(j, 'haiku', 'full');
  assert.ok(quiet.includes('class="gx"') && !quiet.includes('class="scene"'));
  assert.ok(!full.includes('class="gx"') && full.includes('class="scene"') && full.includes('class="scrim"'));
  assert.match(quiet, /job-plate-tag lt/, 'light ink on the night sky whatever the scene');
  assert.match(full, /job-plate-tag dk/, 'dark ink on the ivory page');
});

test('the quiet sky is a placeholder with the graph\u2019s floor, tone and level, drawn with no DOM', () => {
  assert.equal(typeof document, 'undefined');
  const tall = job({ subJobs: [sub('a', { stage: 'done' }), sub('b', { after: ['a'], stage: 'implementation' }), sub('c', { after: ['a'], stage: 'implementation' }), sub('d', { after: ['a'], stage: 'implementation' }), sub('e', { after: ['b', 'c', 'd'] })] });
  const lone = job({ subJobs: [sub('a', { stage: 'implementation' })] });
  const attr = (html, k) => html.match(new RegExp(`class="gx"[^>]*data-${k}="([^"]*)"`))[1];
  assert.ok(+attr(plateHtml(tall, 'opus'), 'floor') > +attr(plateHtml(lone, 'opus'), 'floor'), 'a taller plan reports a lower floor');
  assert.match(plateHtml(lone, 'opus'), /class="gx"[^>]*data-tone="idle"|class="gx"[^>]*data-tone="(run|warn|bad|ok|pause)"/);
  assert.match(plateHtml(job({ stage: 'backlog', subJobs: [] }), 'opus'), /class="gx"[^>]*data-floor="82"/);
  assert.equal(plateHtml(lone, 'opus', 'full').includes('class="gx"'), false);
});

test('a write is a moon off the session that makes it, its place a chip under the title, and a draft in review the stub', () => {
  const draft = { id: 'w', kind: 'write', place: { type: 'slack', ref: '#web<b>' }, title: 'Post it', by: 's', after: [], action: { type: 'post', text: 'hi' }, review: true, stage: 'review', state: 'verified', sessions: [], repairs: [] };
  const j = job({ subJobs: [sub('api', { stage: 'implementation' }), sub('s', { kind: 'session', after: ['api'], stage: 'session', sessions: ['c1'] }), draft],
    runs: [{ id: 'r', subJobId: 's', stopped: false, sessionId: 'c1', parkedAt: 1, drafts: ['w'] }] });
  const html = plateHtml(j, 'opus');
  const svg = html.match(/<svg class="job-plate-graph"[\s\S]*?<\/svg>/)[0];
  assert.deepEqual([...svg.matchAll(/<g class="node ([a-z]+)[^"]*"[^>]*data-sub="([^"]+)"/g)].map((m) => [m[1], m[2]]), [['pr', 'api'], ['session', 's'], ['moon', 'w']], 'two steps, and the write hangs off its session');
  assert.match(svg, /class="tether /);
  assert.match(svg, /aria-label="Post in #web&lt;b&gt;: Review write"/);
  assert.equal((svg.match(/class="edge /g) || []).length, 1, 'only api → s is an edge; a write joins by its tether');
  assert.match(html, /<div class="job-plate-places"><button type="button" class="job-plate-place tone-warn urgent ghost" data-place-job="job1" data-place="0" aria-haspopup="true" title="Slack channel · #web&lt;b&gt;\nPost in #web&lt;b&gt;: Review write \(you review it first\)">/);
  const pop = placePopHtml(j, 0);
  assert.match(pop, /<em>not made yet<\/em>/);
  assert.match(pop, /<button type="button" class="job-plate-pop-write" data-job="job1" data-sub="w"><i class="tone-warn"><\/i><span><b>Post in #web&lt;b&gt;<\/b><small>Review write · you review it first<\/small>/);
  assert.equal(placePopHtml(j, 5), '');
  assert.match(html, /<span class="job-plate-place-name">#web&lt;b&gt;<\/span><i class="tone-warn"><\/i>/);
  assert.ok(!html.includes('#web<b>'));
  const ask = plateAsk(j);
  assert.deepEqual([ask.label, ask.detail, ask.button, ask.act, ask.sub, ask.alt], ['Draft ready', '', 'Post to Slack', 'approve-write', 'w', { label: 'Skip', act: 'skip-write' }]);
  assert.match(html, /<button type="button" class="job-plate-alt" data-ask="skip-write" data-job="job1" data-sub="w">Skip<\/button><button type="button" class="job-plate-go" data-ask="approve-write" data-job="job1" data-sub="w">Post to Slack<\/button>/);
  const made = { ...draft, place: { type: 'artifact' }, action: { type: 'make', what: 'chart' }, result: { url: 'https://claude.ai/artifact/1', at: 1 } };
  const output = plateAsk(job({ ...j, subJobs: [j.subJobs[0], j.subJobs[1], made] }));
  assert.deepEqual([output.label, output.button, output.alt], ['Check output', 'Accept', null], 'a made output is accepted, never skipped');
  const failing = plateAsk(job({ ...j, subJobs: [sub('api', { stage: 'implementation', error: 'boom' }), j.subJobs[1], draft] }));
  assert.equal(failing.tone, 'bad', 'failing still wins over a draft');
});

test('a plate stacks each column in the order and rows the expanded dialog untangles it into', () => {
  // b → c and a → d cross in plan order, and a → e skips a wave past them.
  const j = job({ subJobs: [sub('a'), sub('b'), sub('c', { after: ['b'] }), sub('d', { after: ['a'] }), sub('e', { after: ['c', 'a'] })] });
  const svg = plateHtml(j, 'opus').match(/<svg class="job-plate-graph"[\s\S]*?<\/svg>/)[0];
  const plate = new Map();
  for (const m of svg.matchAll(/data-sub="([^"]+)"[\s\S]*?<circle cx="([\d.]+)" cy="([\d.]+)" r="13"/g)) plate.set(m[2], [...(plate.get(m[2]) || []), [+m[3], m[1]]]);
  const plateCols = [...plate.entries()].sort((p, q) => p[0] - q[0]).map(([, col]) => col.sort((p, q) => p[0] - q[0]).map(([, id]) => id));
  const dialog = [];
  for (const m of planGraphHtml(j.plan || { subJobs: j.subJobs }, {}).matchAll(/data-col="(\d+)" style="[^"]*grid-row:(\d+)"><div[^>]*data-node="([^"]+)"/g)) (dialog[+m[1]] ||= []).push([+m[2], m[3]]);
  const dialogCols = dialog.map((col) => col.sort((p, q) => p[0] - q[0]).map(([, id]) => id));
  assert.deepEqual(dialogCols[1], ['d', 'c'], 'the dialog swaps the column out of plan order to untangle it');
  assert.deepEqual(plateCols, dialogCols);
  const ys = new Map([...plate.values()].flat().map(([y, id]) => [id, y]));
  assert.equal(ys.get('e'), ys.get('a'), 'e takes the median row of its prerequisites, as in the dialog');
  assert.match(svg, /<path class="edge [^"]*" d="M64,56 C[^"]*,70 160,70 C[^"]*"\/>/, 'the wave-skipping link follows its lane through the column it skips');
});
