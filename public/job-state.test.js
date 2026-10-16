import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, STATE_ORDER, stateIconHtml, stateSolid, subState, subLabel, subLine, jobState, jobLabel, leadSub, sortJobs } from './job-state.js';

const sub = (id, over = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after: [], brief: 'b', sessions: [], repairs: [], stage: 'implementation', ...over });
const job = (over = {}) => ({ id: 'j', title: 'Job', intent: 'x', repos: [], stage: 'active', plan: null, subJobs: [], runs: [], moves: [], reviewMerge: true, ...over });
const pr = (over = {}) => ({ url: 'https://github.com/org/repo/pull/142', head: 'h1', checkStatus: 'pending', checks: [], ...over });
const run = (subJobId, over = {}) => ({ id: `r_${subJobId}`, subJobId, phase: 'implementation', stopped: false, status: 'working', ...over });
const stateOf = (s, over = {}) => { const j = job({ subJobs: [s], ...over }); return subState(j, s); };

test('every state is a tone, a glyph and a name, and the order puts the urgent first', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, v.tone])),
    { planned: 'idle', queued: 'idle', waiting: 'idle', running: 'run', needs: 'warn', failing: 'bad', done: 'ok', paused: 'pause', dropped: 'idle' });
  assert.deepEqual(STATE_ORDER.slice(0, 2), ['failing', 'needs']);
  assert.deepEqual([...STATE_ORDER].sort(), Object.keys(STATES).sort());
  for (const k of Object.keys(STATES)) assert.match(stateIconHtml(k), /^<svg class="icon/);
  assert.match(stateIconHtml('running'), /job-spin/, 'running is the one glyph that moves');
  assert.deepEqual(Object.keys(STATES).filter(stateSolid), ['running', 'needs', 'failing', 'done', 'paused']);
});

test('a sub-job maps onto the vocabulary from its stage, run, checks and gates', () => {
  const cases = [
    ['plan sub-job, no stage yet', { stage: undefined }, {}, 'planned'],
    ['queued implementation', {}, {}, 'queued'],
    ['agent working', {}, { runs: [run('a')] }, 'running'],
    ['agent stuck on a prompt', {}, { runs: [run('a', { status: 'needs-you' })] }, 'needs'],
    ['diff awaiting review', { stage: 'review', state: 'verified', ready: { checks: [] } }, {}, 'needs'],
    ['approved, committing next', { stage: 'review', state: 'approved' }, {}, 'running'],
    ['checks pending', { stage: 'pr', pr: pr() }, {}, 'queued'],
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
    ['watching post-merge runs', { stage: 'deployment', pr: pr({ mergeCommit: 'm' }) }, {}, 'queued'],
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

test('a job rolls up to its most urgent sub-job, and before work starts follows its own stage', () => {
  assert.equal(jobState(job({ stage: 'backlog' })), 'planned');
  assert.equal(jobState(job({ stage: 'planning', plan: { subJobs: [], stories: [] } })), 'needs');
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

test('the board orders jobs newest first by creation, whatever their live state', () => {
  const quiet = job({ id: 'quiet', createdAt: 10, subJobs: [sub('a')] });
  const fine = job({ id: 'fine', createdAt: 30, subJobs: [sub('a', { stage: 'done' })] });
  const broken = job({ id: 'broken', createdAt: 20, error: 'x' });
  const legacy = job({ id: 'legacy', createdAt: undefined });
  const legacy2 = job({ id: 'legacy2', createdAt: undefined });
  assert.deepEqual(sortJobs([legacy, quiet, legacy2, broken, fine]).map((j) => j.id), ['fine', 'broken', 'quiet', 'legacy2', 'legacy']);
});
