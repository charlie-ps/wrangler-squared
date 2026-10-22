import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, STATE_ORDER, stateIconHtml, stateSolid, subState, subLabel, subLine, jobState, jobLabel, leadSub, sortJobs, jobNeedsYou, mainWaiting } from './job-state.js';
import { plateHtml, plateAsk } from './job-plates.js';
import { jobStatus, eventFor } from './jobs.js';
import { heldBy } from '../server/job-red.js';

const sub = (id, over = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after: [], brief: 'b', sessions: [], repairs: [], stage: 'implementation', ...over });
const job = (over = {}) => ({ id: 'j', title: 'Job', intent: 'x', repos: [], stage: 'active', plan: null, subJobs: [], runs: [], moves: [], reviewMerge: true, ...over });
const pr = (over = {}) => ({ url: 'https://github.com/org/repo/pull/142', head: 'h1', checkStatus: 'pending', checks: [], ...over });
const run = (subJobId, over = {}) => ({ id: `r_${subJobId}`, subJobId, phase: 'implementation', stopped: false, status: 'working', ...over });
// What the graph contributor stamps (server/job-red.js withHeld), in place.
const stamped = (j) => { for (const s of j.subJobs) s.held = heldBy(j, s); return j; };
const stateOf = (s, over = {}) => { const j = job({ subJobs: [s], ...over }); return subState(j, s); };

test('every state is a tone, a glyph and a name, and the order puts the urgent first', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, v.tone])),
    { planned: 'idle', queued: 'idle', waiting: 'idle', running: 'run', needs: 'warn', read: 'read', change: 'warn', failing: 'bad', done: 'ok', paused: 'pause', dropped: 'idle' });
  assert.deepEqual(STATE_ORDER.slice(0, 4), ['change', 'read', 'failing', 'needs'], 'a plan change, then what else Wrangler wrote for you, outrank red');
  assert.deepEqual([...STATE_ORDER].sort(), Object.keys(STATES).sort());
  for (const k of Object.keys(STATES)) assert.match(stateIconHtml(k), /^<svg class="icon/);
  assert.match(stateIconHtml('running'), /job-spin/, 'running is the one glyph that moves');
  assert.deepEqual(Object.keys(STATES).filter(stateSolid), ['running', 'needs', 'read', 'change', 'failing', 'done', 'paused']);
});

test('a sub-job maps onto the vocabulary from its stage, run, checks and gates', () => {
  const cases = [
    ['plan sub-job, no stage yet', { stage: undefined }, {}, 'planned'],
    ['queued implementation', {}, {}, 'queued'],
    ['agent working', {}, { runs: [run('a')] }, 'running'],
    ['agent stuck on a prompt', {}, { runs: [run('a', { status: 'needs-you' })] }, 'needs'],
    ['diff awaiting review', { stage: 'review', state: 'verified', ready: { checks: [] } }, {}, 'needs'],
    ['approved, committing next', { stage: 'review', state: 'approved' }, {}, 'running'],
    ['checks pending', { stage: 'pr', pr: pr() }, {}, 'running'],
    ['green PR awaiting manual merge', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) }, {}, 'needs'],
    ['green PR, manual merge, fix requested', { stage: 'pr', pr: pr({ checkStatus: 'passing' }), fixRequested: { note: null, at: 1 } }, {}, 'running'],
    ['green PR, manual merge, repair running', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) }, { runs: [run('a', { phase: 'repair' })] }, 'running'],
    ['green PR merging on its own', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) }, { reviewMerge: false }, 'running'],
    ['red checks', { stage: 'pr', pr: pr({ checkStatus: 'failing' }) }, {}, 'failing'],
    ['red checks with a repair running', { stage: 'pr', pr: pr({ checkStatus: 'failing' }) }, { runs: [run('a', { phase: 'repair' })] }, 'running'],
    ['red checks accepted', { stage: 'pr', pr: pr({ checkStatus: 'failing' }), acceptedRed: { ref: 'h1' } }, {}, 'running'],
    ['blocking comments', { stage: 'pr', pr: pr({ checkStatus: 'passing' }), prComments: { items: [{}], fingerprint: 'f' }, commentSummary: { tone: 'red', text: 't', fingerprint: 'f' } }, { reviewMerge: false }, 'failing'],
    ['worker error', { error: 'blocked' }, {}, 'failing'],
    ['job-level error', {}, { error: 'coordinator' }, 'failing'],
    ['watching post-merge runs', { stage: 'deployment', pr: pr({ mergeCommit: 'm' }) }, {}, 'running'],
    ['post-merge run red', { stage: 'deployment', pr: pr({ mergeCommit: 'm' }), deploymentResult: { status: 'failing', runs: [] } }, {}, 'failing'],
    ['no deploy run for too long', { stage: 'deployment', pr: pr({ mergeCommit: 'm' }), deploymentStale: { since: 1 } }, {}, 'needs'],
    ['session queued', { kind: 'session', stage: 'session' }, {}, 'queued'],
    ['session reported', { kind: 'session', stage: 'review', result: { checks: [] } }, {}, 'needs'],
    ['human task yours', { kind: 'human', stage: 'human', state: 'queued' }, {}, 'needs'],
    ['human task started', { kind: 'human', stage: 'human', state: 'doing' }, {}, 'running'],
    ['delivered', { stage: 'done' }, { error: 'cleanup failed' }, 'done'],
    ['cleaning up after a drop', { stage: 'cleanup', cancelledAt: 1 }, {}, 'dropped'],
    ['paused job', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) }, { paused: true }, 'paused'],
  ];
  for (const [name, over, jobOver, expected] of cases) assert.equal(stateOf(sub('a', over), jobOver), expected, name);
});

test('waiting is a prerequisite holding the start; a dropped prerequisite fails it', () => {
  const dep = sub('a', { kind: 'session', stage: 'session' });
  const behind = sub('b', { kind: 'session', stage: 'session', after: ['a'] });
  assert.equal(subState(job({ subJobs: [dep, behind] }), behind), 'waiting');
  const gone = { ...dep, stage: 'done', cancelledAt: 1 };
  assert.equal(subState(job({ subJobs: [gone, behind] }), behind), 'failing');
  assert.equal(subLabel(job({ subJobs: [gone, behind] }), behind), 'Prerequisite dropped');
});

test('a green PR moved behind work that has not deployed waits instead of offering Merge, like the server', () => {
  const dep = sub('a');
  const green = sub('b', { stage: 'pr', pr: pr({ checkStatus: 'passing' }), after: ['a'] });
  const j = job({ subJobs: [dep, green] });
  assert.equal(subState(j, green), 'waiting'); assert.equal(subLabel(j, green), 'Waiting for 1 deployment');
  assert.equal(subState(job({ subJobs: [dep, green], reviewMerge: false }), green), 'waiting');
  const rework = { ...green, fixRequested: { note: 'New brief', at: 1 } };
  assert.equal(subState(job({ subJobs: [dep, rework] }), rework), 'waiting', 'the rework starts once the prerequisite lands');
  const landed = { ...dep, stage: 'cleanup', deployed: { at: 1 } };
  assert.equal(subState(job({ subJobs: [landed, green] }), green), 'needs'); assert.equal(subLabel(job({ subJobs: [landed, green] }), green), 'Merge #142');
  assert.equal(subLabel(job({ subJobs: [landed, rework] }), rework), 'Fix requested');
  const red = { ...green, pr: pr({ checkStatus: 'failing' }) };
  assert.equal(subState(job({ subJobs: [dep, red] }), red), 'failing', 'red checks still repair while it waits');
});

test('a red PR a plan change moved behind a fix waits for it instead of reading red', () => {
  const fix = sub('fix');
  const behind = sub('b', { stage: 'pr', pr: pr({ checkStatus: 'failing' }), after: ['fix'], catchUp: { at: 1 } });
  const j = job({ subJobs: [fix, behind] });
  assert.equal(subState(j, behind), 'waiting'); assert.equal(subLabel(j, behind), 'Waiting for 1 deployment');
});

test('a job rolls up to its most urgent sub-job, and before work starts follows its own stage', () => {
  assert.equal(jobState(job({ stage: 'backlog' })), 'planned');
  assert.equal(jobState(job({ stage: 'planning', plan: { subJobs: [], stories: [] } })), 'change', 'a plan to review is amber, like a plan change');
  assert.equal(jobState(job({ stage: 'planning', runs: [run(null, { phase: 'planning' })] })), 'running');
  assert.equal(jobState(job({ stage: 'jira', runs: [run(null, { phase: 'jira' })] })), 'running');
  assert.equal(jobState(job({ stage: 'planning', paused: true })), 'paused');
  assert.equal(jobState(job({ stage: 'done' })), 'done');
  assert.equal(jobState(job({ cancelledAt: 1 })), 'dropped');
  assert.equal(jobState(job({ error: 'x', subJobs: [sub('a', { stage: 'done' })] })), 'failing');
  const mixed = job({ subJobs: [sub('a', { stage: 'done' }), sub('b', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) }), sub('c', { stage: 'pr', pr: pr({ checkStatus: 'failing' }) })] });
  assert.equal(jobState(mixed), 'failing'); assert.equal(leadSub(mixed).id, 'c');
  assert.equal(jobState({ ...mixed, subJobs: mixed.subJobs.slice(0, 2) }), 'needs');
  assert.equal(jobState(job({ subJobs: [sub('a', { stage: 'done' }), sub('b', { stage: 'cleanup', cancelledAt: 1 })] })), 'done', 'a dropped sub-job does not hold the job open');
});

test('the short labels name the decision, with the PR number where there is one', () => {
  const merge = sub('a', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) });
  assert.equal(subLabel(job({ subJobs: [merge] }), merge), 'Merge #142');
  const asked = { ...merge, fixRequested: { note: null, at: 1 } };
  assert.equal(subLabel(job({ subJobs: [asked] }), asked), 'Fix requested', 'Fix here takes the merge decision off the human');
  assert.equal(jobState(job({ subJobs: [asked] })), 'running');
  const fixing = job({ subJobs: [merge], runs: [run('a', { phase: 'repair' })] });
  assert.equal(subLabel(fixing, merge), 'Fixing the PR'); assert.equal(jobState(fixing), 'running');
  const red = sub('a', { stage: 'pr', pr: pr({ checkStatus: 'failing', checks: [{ name: 'e2e', state: 'FAILURE' }, { name: 'lint', state: 'ERROR' }, { name: 'unit', state: 'SUCCESS' }] }) });
  assert.equal(subLabel(job({ subJobs: [red] }), red), 'Checks failing');
  assert.equal(subLine(job({ subJobs: [red] }), red), '#142 · 2 checks red');
  const limit = { ...red, pr: { ...red.pr, checks: [] }, error: 'Automatic repair limit reached.' };
  assert.equal(subLine(job({ subJobs: [limit] }), limit), 'Checks failing on #142', 'the number is never said twice');
  const code = sub('a', { stage: 'review', state: 'verified' });
  assert.equal(subLabel(job({ subJobs: [code] }), code), 'Review code');
  assert.equal(subLine(job({ subJobs: [sub('a')] }), sub('a')), 'Queued');
  assert.equal(jobLabel(job({ stage: 'planning', plan: { subJobs: [], stories: [] } })), 'Plan ready');
  assert.equal(jobLabel(job({ stage: 'backlog' })), 'Backlog');
  assert.equal(jobLabel(job({ subJobs: [merge, { ...merge, id: 'b', pr: pr({ checkStatus: 'passing', url: 'https://github.com/org/repo/pull/143' }) }] })), 'Merge #142 +1');
  assert.equal(jobLabel(job({ subJobs: [sub('a', { stage: 'done' })] })), 'Delivered');
  assert.equal(jobLabel(job({ stage: 'done', cancelledAt: 1 })), 'Cancelled');
});

test('a cancelled job whose cleanup kept a worktree needs the human until Retry or Discard', () => {
  const refusal = { path: '/wt', files: [{ change: 'modified', path: 'a.js' }], fileCount: 1, pinned: true };
  const kept = sub('a', { stage: 'cleanup', cancelledAt: 1, error: 'Worktree has work that would be lost (1 uncommitted file); preserve it for review', cleanupRefusal: refusal });
  const j = job({ cancelledAt: 1, subJobs: [kept, sub('b', { stage: 'done', cancelledAt: 1 })] });
  assert.equal(subState(j, kept), 'needs'); assert.equal(subLabel(j, kept), 'Worktree kept');
  assert.equal(jobState(j), 'needs'); assert.equal(jobLabel(j), 'Cancelled · worktree kept'); assert.equal(leadSub(j), kept);
  const cleaning = job({ cancelledAt: 1, subJobs: [sub('a', { stage: 'cleanup', cancelledAt: 1 })] });
  assert.equal(jobState(cleaning), 'dropped'); assert.equal(jobLabel(cleaning), 'Cancelled · cleaning up');
  const discarding = { ...kept, discard: { at: 2 } };
  assert.equal(subState(job({ cancelledAt: 1, subJobs: [discarding] }), discarding), 'dropped', 'a Discard under way is cleanup again');
  assert.equal(jobLabel(job({ cancelledAt: 1, subJobs: [discarding] })), 'Cancelled · cleaning up');
  const finished = job({ stage: 'done', cancelledAt: 1, subJobs: [{ ...kept, stage: 'done' }] });
  assert.equal(jobState(finished), 'dropped'); assert.equal(jobLabel(finished), 'Cancelled');
  const dropped = job({ subJobs: [kept, sub('b')] });
  assert.equal(jobState(dropped), 'needs', 'a sub-job dropped from a live job surfaces the same way'); assert.equal(jobLabel(dropped), 'Worktree kept');
});

test('a job needs you exactly when its plate asks, once however many of its steps wait', () => {
  const review = (id) => sub(id, { kind: 'session', stage: 'review', result: { checks: [] } });
  const cases = [
    ['two steps waiting', job({ subJobs: [review('a'), review('b')] }), true],
    ['plan ready', job({ stage: 'planning', plan: { subJobs: [sub('a')] } }), true],
    ['red step', job({ subJobs: [sub('a', { error: 'blocked' })] }), true],
    ['prompt waiting on a paused job', job({ paused: true, subJobs: [sub('a')], runs: [run('a', { status: 'needs-you', sessionId: 'card' })] }), true],
    ['cancelled, cleaning up a red step', job({ cancelledAt: 1, subJobs: [sub('a', { stage: 'cleanup', cancelledAt: 1, error: 'cleanup failed' })] }), false],
    ['finished with a red step', job({ stage: 'done', subJobs: [sub('a', { stage: 'done', error: 'cleanup failed' })] }), false],
    ['step held by a replan', stamped(job({ replan: { at: 1, source: { sub: 'a' } }, subJobs: [review('a')], runs: [run(null, { phase: 'planning' })] })), false],
    ['running', job({ subJobs: [sub('a')], runs: [run('a')] }), false],
  ];
  for (const [name, j, expected] of cases) {
    assert.equal(jobNeedsYou(j), expected, name);
    assert.equal(/\bstubbed\b/.test(plateHtml(j, 0)), expected, `${name}: the plate agrees`);
  }
});

test('a local main left behind asks for you without moving the stage, until something is fixing it', () => {
  const notice = (over = {}) => ({ path: '/repo', base: 'main', reason: 'dirty', subs: ['a'], at: 1, retrying: false, resolving: null, ...over });
  const working = job({ subJobs: [sub('a', { stage: 'done' }), sub('b')], runs: [run('b')], mainNotices: [notice()] });
  assert.equal(jobState(working), 'running', 'the roll-up is untouched'); assert.equal(subState(working, working.subJobs[1]), 'running', 'no step is held');
  assert.equal(jobNeedsYou(working), true); assert.equal(jobLabel(working), 'Local main behind');
  const plate = plateHtml(working, 0);
  assert.match(plate, /\bstubbed\b/); assert.match(plate, /tone-warn/); assert.match(plate, /Local main behind/); assert.match(plate, /data-ask="open" data-job="j" data-sub=""/);
  const delivered = job({ stage: 'done', subJobs: [sub('a', { stage: 'done' })], mainNotices: [notice({ base: 'trunk', path: '/other' }), notice()] });
  assert.equal(jobState(delivered), 'done'); assert.equal(jobLabel(delivered), 'Local trunk behind', 'not Delivered while the notice is open');
  assert.equal(jobNeedsYou(delivered), true); assert.match(plateHtml(delivered, 0), /\/other \+1/);
  for (const [name, over] of [['retrying', { retrying: true }], ['resolving', { resolving: { id: 'stash', at: 2, sessionId: 's_fix' } }], ['starting a fix', { resolving: { id: 'stash', at: 2, sessionId: null } }]]) {
    const j = job({ stage: 'done', subJobs: [sub('a', { stage: 'done' })], mainNotices: [notice(over)] });
    assert.deepEqual(mainWaiting(j), [], name); assert.equal(jobNeedsYou(j), false, name); assert.equal(jobLabel(j), 'Delivered', name);
    assert.doesNotMatch(plateHtml(j, 0), /\bstubbed\b/, `${name}: the plate agrees`);
  }
  const review = job({ subJobs: [sub('a', { kind: 'session', stage: 'review', result: { checks: [] } })], mainNotices: [notice()] });
  assert.equal(jobLabel(review), 'Review result', 'a step waiting on you outranks the notice'); assert.doesNotMatch(plateHtml(review, 0), /Local main behind/);
});

test('the board orders jobs newest first by creation, whatever their live state', () => {
  const quiet = job({ id: 'quiet', createdAt: 10, subJobs: [sub('a')] });
  const fine = job({ id: 'fine', createdAt: 30, subJobs: [sub('a', { stage: 'done' })] });
  const broken = job({ id: 'broken', createdAt: 20, error: 'x' });
  const legacy = job({ id: 'legacy', createdAt: undefined });
  const legacy2 = job({ id: 'legacy2', createdAt: undefined });
  assert.deepEqual(sortJobs([legacy, quiet, legacy2, broken, fine]).map((j) => j.id), ['fine', 'broken', 'quiet', 'legacy2', 'legacy']);
});

test('a job label never throws when the roll-up state has no sub-job behind it', () => {
  const dropped = sub('a', { cancelledAt: 1, stage: 'cleanup' });
  assert.equal(jobState(job({ subJobs: [dropped] })), 'queued');
  assert.equal(jobLabel(job({ subJobs: [dropped] })), 'Queued', 'every sub-job dropped');
  assert.equal(leadSub(job({ subJobs: [dropped] })), null);
  assert.equal(jobLabel(job({ paused: true, subJobs: [dropped] })), 'Paused');
});

test('a job held by a replan labels itself whatever the replan is', () => {
  const waiting = sub('a', { kind: 'session' });
  const done = sub('a', { kind: 'session', stage: 'done' });
  const red = { sub: 'a', auto: true, n: 1 };
  const proposal = { plan: { subJobs: [] } };
  for (const [replan, state, label] of [
    [{}, 'running', 'Wrangling'],
    [{ proposal }, 'change', 'Plan change ready'],
    [{ red }, 'running', 'Fixing'],
    [{ red, proposal }, 'change', 'Fix proposed'],
  ]) {
    const j = job({ subJobs: [waiting], replan });
    assert.equal(jobState(j), state);
    assert.doesNotThrow(() => jobLabel(j));
    if (label) assert.equal(jobLabel(j), label);
  }
  const fixReady = job({ subJobs: [done], replan: { red, proposal } });
  assert.equal(jobState(fixReady), 'change');
  assert.equal(leadSub(fixReady), null);
  assert.equal(jobLabel(fixReady), 'Fix proposed', 'a red triage proposal names itself even with no step of its own');
});

test('approving a session step while a red triage proposal is open moves the step to done and still labels the job', () => {
  const approved = sub('a', { kind: 'session', stage: 'done' });
  const later = sub('b', { kind: 'session', after: ['a'], stage: undefined });
  const j = job({ subJobs: [approved, later], replan: { red: { sub: 'a', auto: true, n: 1 }, proposal: { plan: { subJobs: [] } } } });
  assert.equal(jobState(j), 'change');
  assert.doesNotThrow(() => jobLabel(j));
  assert.doesNotThrow(() => plateHtml(j, 'sonnet'));
});

test('a red job with a plan change waiting is the amber plan change, while its red step stays red', () => {
  const api = sub('api', { stage: 'pr', error: 'Automatic repair limit reached', pr: pr({ checkStatus: 'failing' }) });
  const j = job({ subJobs: [api, sub('web', { after: ['api'] })] });
  api.red = { declared: { at: 1, ref: `${api.error}|h1||0` } };
  assert.deepEqual([jobState(j), subState(j, api), subLabel(j, api)], ['failing', 'failing', 'Declared red']);
  j.replan = { at: 2, source: { sub: 'api', at: 'pr', ref: 'h1' }, convo: 'c1', proposal: { id: 'run_p', plan: { subJobs: [] }, changes: { added: ['fix'], edited: [], removed: [], kept: ['api', 'web'], frozen: [] }, actions: [] } };
  stamped(j);
  assert.deepEqual([jobState(j), jobLabel(j), jobNeedsYou(j)], ['change', 'Plan change ready', true]);
  assert.deepEqual([subState(j, api), subLabel(j, api)], ['failing', 'Declared red'], 'the step itself is still red');
  assert.deepEqual([plateAsk(j).tone, plateAsk(j).label, plateAsk(j).button, plateAsk(j).sub], ['warn', 'Plan change ready', 'Review', '']);
  j.replan.red = { sub: 'api', auto: false, n: 1 };
  assert.equal(jobLabel(j), 'Fix proposed');
  j.paused = true;
  assert.notEqual(jobState(j), 'change', 'a paused job holds its proposal');
});

test('a step a proposal acts on reads as the plan change; one it leaves alone keeps its own ask', () => {
  const touched = sub('a', { kind: 'session' }), merge = sub('m', { stage: 'pr', pr: pr({ checkStatus: 'passing' }) });
  const j = stamped(job({ subJobs: [touched, merge], replan: { at: 1, proposal: { id: 'p', plan: { subJobs: [] }, changes: { added: [], edited: [{ id: 'a' }], removed: [], kept: ['m'], frozen: [] }, actions: [] } } }));
  assert.deepEqual([subState(j, touched), subLabel(j, touched)], ['change', 'Plan change ready']);
  assert.deepEqual([subState(j, merge), subLabel(j, merge)], ['needs', 'Merge #142'], 'Merge stays amber');
  assert.equal(jobState(j), 'change');
});

test('the board reads held from the server: a step is held exactly when the server holds it', () => {
  const writes = sub('w', { kind: 'session', stage: 'done', writesOnly: { from: 'done' } }), working = sub('r');
  const j = stamped(job({ subJobs: [writes, working], runs: [run('r')], replan: { at: 1, proposal: { id: 'p', plan: { subJobs: [] }, changes: { added: [], edited: [{ id: 'w' }, { id: 'r' }], removed: [], kept: [], frozen: [] }, actions: [] } } }));
  assert.deepEqual([writes.held, working.held], [false, true], 'a session back for its writes alone launches; a working step merges nothing new');
  assert.notEqual(subLabel(j, writes), 'Held for the plan change');
  assert.deepEqual([subState(j, working), subLabel(j, working)], ['change', 'Plan change ready'], 'its run carries on, but the proposal is what to read');
  delete working.held;
  assert.equal(subState(j, working), 'running', 'nothing stamped, nothing held: the board never re-derives it');
});

test('a wrangler answer is to read until its conversation was shown, then the job is what it was', () => {
  const answer = { id: 't2', at: 5, from: 'wrangler', kind: 'answer', text: 'It retries twice.\nThen it gives up.', convo: 'c1' };
  const j = job({ subJobs: [sub('a', { stage: 'done' }), sub('b', { stage: 'pr', pr: pr() })], convos: [{ id: 'c1', at: 1, pending: null, seenAt: 1 }], talk: [{ id: 't1', at: 2, from: 'human', text: 'Does it retry?', convo: 'c1' }, answer] });
  assert.deepEqual([jobState(j), jobLabel(j), jobNeedsYou(j)], ['read', 'Wrangler replied', true]);
  assert.deepEqual([plateAsk(j).tone, plateAsk(j).label, plateAsk(j).detail, plateAsk(j).button], ['read', 'Wrangler replied', 'It retries twice.', 'Read']);
  j.convos[0].seenAt = 5;
  assert.deepEqual([jobState(j), jobNeedsYou(j)], ['running', false], 'back to its checks running');
  const onStep = job({ subJobs: [sub('a')], convos: [{ id: 'c2', at: 1, sub: 'a', pending: null, seenAt: 0 }], talk: [{ ...answer, convo: 'c2', sub: 'a' }] });
  assert.deepEqual([subState(onStep, onStep.subJobs[0]), subLabel(onStep, onStep.subJobs[0]), jobState(onStep)], ['read', 'Wrangler replied', 'read']);
  assert.equal(plateAsk(onStep).sub, 'a', 'a step\'s answer opens on that step');
  const review = sub('r', { stage: 'review', state: 'verified', ready: { checks: [] } });
  const both = job({ subJobs: [review], convos: [{ id: 'c3', at: 1, sub: 'r', pending: null, seenAt: 0 }], talk: [{ ...answer, convo: 'c3', sub: 'r' }] });
  assert.deepEqual([subState(both, review), subLabel(both, review)], ['needs', 'Review code'], 'Review code stays amber');
});

test('a code review the human sent an idea on is Wrangler\'s until it answers or the session reports back', () => {
  const review = sub('r', { stage: 'review', state: 'verified', ready: { checks: [], round: 1 } });
  const j = job({ subJobs: [review], runs: [run('r', { parkedFor: 'ready', parkedAt: 1 })], talk: [{ id: 't1', at: 2, from: 'human', text: 'Does it handle an empty list?', convo: 'c1', sub: 'r' }],
    convos: [{ id: 'c1', at: 2, sub: 'r', seenAt: 2, pending: { at: 2, asks: [{ messageId: 't1', sentAt: null }], source: { sub: 'r', at: 'code', ref: 'r_r#1', state: 'review/verified' } } }] });
  assert.deepEqual([subState(j, review), subLabel(j, review), jobStatus(j, review).tone], ['running', 'Working on your feedback', 'working'], 'its ask run reads it');
  assert.deepEqual([jobState(j), jobLabel(j), jobNeedsYou(j), plateAsk(j)], ['running', 'Working on your feedback', false, null]);
  // The ask run proposes: the plan change drawn from it holds the step, still Wrangler's.
  j.convos[0].pending = null;
  j.replan = { at: 3, feedback: 'x', source: j.convos[0].pending?.source || { sub: 'r', at: 'code', ref: 'r_r#1' }, convo: 'c1', proposal: null };
  stamped(j);
  assert.deepEqual([subState(j, review), subLabel(j, review), jobNeedsYou(j)], ['running', 'Working on your feedback', false], 'drafting a plan change from it');
  delete j.replan; stamped(j);
  j.replanQueue = [{ feedback: 'x', at: 3, source: { sub: 'r', at: 'code' }, convo: 'c1' }];
  assert.deepEqual([subState(j, review), jobNeedsYou(j)], ['running', false], 'queued behind another change');
  delete j.replanQueue;
  // Forwarded to the session: its own answering line until it reports back.
  review.answering = { at: 4 };
  assert.deepEqual([subState(j, review), subLabel(j, review), jobNeedsYou(j)], ['running', 'Working on your message', false]);
  delete review.answering;
  assert.deepEqual([subState(j, review), subLabel(j, review), jobNeedsYou(j), plateAsk(j).label], ['needs', 'Review code', true, 'Review code'], 'back to the human');
  // An idea typed on another step leaves this review the human's.
  j.convos[0].pending = { at: 5, asks: [], source: { sub: 'other', at: 'pr' } };
  assert.deepEqual([subState(j, review), jobNeedsYou(j)], ['needs', true]);
});

test('a declared red the human sent an idea on reads as worked on until Wrangler proposes', () => {
  const api = sub('api', { stage: 'pr', error: 'Automatic repair limit reached', pr: pr({ checkStatus: 'failing' }) });
  const j = job({ subJobs: [api, sub('web', { after: ['api'] })] });
  api.red = { declared: { at: 1, ref: `${api.error}|h1||0`, summary: 'The test is flaky.', ask: 'Accept it?' } };
  stamped(j);
  assert.deepEqual([subState(j, api), subLabel(j, api), jobNeedsYou(j), plateAsk(j).label], ['failing', 'Declared red', true, 'Declared red']);
  // job-change.js: a declared red's idea goes straight to the planner.
  j.convos = [{ id: 'c1', at: 2, sub: 'api', seenAt: 2, pending: null }];
  j.replan = { at: 2, feedback: 'x', source: { sub: 'api', at: 'pr', ref: 'h1' }, convo: 'c1', red: { sub: 'api', auto: false, human: true }, proposal: null };
  stamped(j);
  assert.deepEqual([subState(j, api), subLabel(j, api), jobStatus(j, api).tone], ['running', 'Working on your feedback', 'working']);
  assert.deepEqual([jobState(j), jobLabel(j), jobNeedsYou(j), plateAsk(j)], ['running', 'Working on your feedback', false, null]);
  assert.equal(eventFor(j, api).fix.kind, 'fixing', 'no Declared red banner while Wrangler has it');
  assert.equal(eventFor(j, api).fix.title, 'Working on your feedback');
  // The proposal lands: the usual asks take over.
  j.replan.proposal = { id: 'p', plan: { subJobs: [] }, changes: { added: [], edited: [], removed: [], kept: ['api', 'web'], frozen: [] }, actions: [{ type: 'accept-red', sub: 'api' }] };
  stamped(j);
  assert.deepEqual([jobState(j), jobLabel(j), jobNeedsYou(j)], ['change', 'Fix proposed', true]);
  assert.equal(eventFor(j, api).fix.kind, 'declared');
  // Dropped (replanFailed, discard): Declared red again.
  delete j.replan; stamped(j);
  assert.deepEqual([subState(j, api), subLabel(j, api), jobNeedsYou(j)], ['failing', 'Declared red', true]);
});
