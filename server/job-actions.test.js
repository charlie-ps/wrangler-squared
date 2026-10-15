import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateAction, stampActions, checkActions, applyActions, chipAction } from './job-actions.js';
import { proposeReplan, approveReplan, optionsOf } from './job-replan.js';
import { quickChange, changeView } from './job-change.js';
import { reportSchema } from './jobs-schema.js';
import { buildSubJob } from './job-store.js';

const spec = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', storyId: 'story', after, brief: `Implement ${id}`, ...extra });
const PR = 'https://github.com/o/r/pull/1';
function job(subs, patches = {}) {
  const plan = { context: 'ctx', stories: [{ id: 'story', key: 'A-1', title: 'Story' }], subJobs: subs };
  const j = { id: 'job_1', stage: 'active', revision: 1, plan, runs: [], subJobs: subs.map((s) => buildSubJob(plan, s)) };
  for (const [id, p] of Object.entries(patches)) Object.assign(j.subJobs.find((s) => s.id === id), p);
  return j;
}
const redOf = () => ({ stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1', checkStatus: 'failing' } });
const failedDeployOf = () => ({ stage: 'deployment', state: 'watching', pr: { url: PR, head: 'h1', mergeCommit: 'm1' }, deploymentResult: { status: 'failing' } });
const subOf = (j, id) => j.subJobs.find((s) => s.id === id);
const empty = (j) => ({ context: '', stories: [], subJobs: j.plan.subJobs });

test('accept red pins to the PR head, or to the merge commit once merged, and refuses what is not red', () => {
  const j = job([spec('api'), spec('web')], { api: redOf(), web: failedDeployOf() });
  assert.deepEqual(gateAction(j, { type: 'accept-red', sub: 'api' }).pin, { at: 'head', ref: 'h1' });
  assert.deepEqual(gateAction(j, { type: 'accept-red', sub: 'web' }).pin, { at: 'merge', ref: 'm1' });
  subOf(j, 'api').pr.checkStatus = 'passing';
  assert.throws(() => gateAction(j, { type: 'accept-red', sub: 'api' }), /no red pipeline/);
  Object.assign(subOf(j, 'api'), { pr: { url: PR, head: 'h1', dirty: true, checkStatus: 'failing' } });
  assert.throws(() => gateAction(j, { type: 'accept-red', sub: 'api' }), /merge conflicts cannot be overridden/);
  subOf(j, 'web').recoveredBy = 'fix';
  assert.throws(() => gateAction(j, { type: 'accept-red', sub: 'web' }), /no red pipeline/);
});

test('a mark must cite its evidence; merged needs an open PR; a write or human step is edited in the plan, not marked', () => {
  const j = job([spec('api'), spec('doc', [], { kind: 'human', repo: undefined })], { api: { stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1' } } });
  assert.throws(() => gateAction(j, { type: 'mark', sub: 'api', position: 'done' }), /cite the evidence/);
  assert.deepEqual(gateAction(j, { type: 'mark', sub: 'api', position: 'merged', evidence: 'merged by @a' }).pin, { at: 'head', ref: 'h1' });
  assert.deepEqual(gateAction(j, { type: 'mark', sub: 'api', position: 'done', evidence: '#421' }).pin, { at: 'stage', ref: 'pr' });
  subOf(j, 'api').stage = 'implementation';
  assert.throws(() => gateAction(j, { type: 'mark', sub: 'api', position: 'merged', evidence: 'x' }), /open PR/);
  assert.throws(() => gateAction(j, { type: 'mark', sub: 'doc', position: 'done', evidence: 'x' }), /edit it in the plan/);
});

test('recover needs a failed post-merge run and a PR fix in the plan; rework needs code that can still change', () => {
  const j = job([spec('api'), spec('fix'), spec('web')], { api: failedDeployOf(), web: { stage: 'deployment', state: 'watching', pr: { url: PR, mergeCommit: 'm2' } } });
  assert.throws(() => gateAction(j, { type: 'recover', sub: 'api' }, j.plan), /id of a PR sub-job/);
  assert.throws(() => gateAction(j, { type: 'recover', sub: 'api', fix: 'api' }, j.plan), /id of a PR sub-job/);
  assert.deepEqual(gateAction(j, { type: 'recover', sub: 'api', fix: 'fix' }, j.plan).pin, { at: 'merge', ref: 'm1' });
  assert.throws(() => gateAction(j, { type: 'recover', sub: 'web', fix: 'fix' }, j.plan), /no failed post-merge run/);
  assert.throws(() => gateAction(j, { type: 'rework', sub: 'api', note: 'x' }), /has merged/);
  assert.throws(() => gateAction(j, { type: 'rework', sub: 'fix' }), /say what to change/);
  assert.deepEqual(gateAction(j, { type: 'rework', sub: 'fix', note: 'x' }).pin, { at: 'stage', ref: 'implementation' });
  Object.assign(subOf(j, 'fix'), { stage: 'pr', pr: { url: PR, head: 'h9' } });
  assert.deepEqual(gateAction(j, { type: 'rework', sub: 'fix', note: 'x' }).pin, { at: 'head', ref: 'h9' });
  j.runs.push({ id: 'r', subJobId: 'fix' });
  assert.throws(() => gateAction(j, { type: 'rework', sub: 'fix', note: 'x' }), /Wait for the step/);
});

test('stamping refuses a second action on one sub-job and an action on what the plan cancels', () => {
  const j = job([spec('api'), spec('web')], { api: redOf() });
  const a = { type: 'accept-red', sub: 'api' };
  assert.deepEqual(stampActions(j, [a], j.plan, { removed: [] })[0].pin, { at: 'head', ref: 'h1' });
  assert.throws(() => stampActions(j, [a, a], j.plan, { removed: [] }), /two actions/);
  assert.throws(() => stampActions(j, [a], j.plan, { removed: ['api'] }), /which this plan cancels/);
});

test('approval is refused when the head or merge commit moved, and applies each action once it holds', () => {
  const j = job([spec('api'), spec('web'), spec('old')], { api: redOf(), web: failedDeployOf(), old: { stage: 'pr', state: 'watching', pr: { url: PR, head: 'h7' } } });
  const actions = stampActions(j, [{ type: 'accept-red', sub: 'api', note: 'flaky' }, { type: 'accept-red', sub: 'web' }, { type: 'mark', sub: 'old', position: 'done', evidence: 'done in #421' }], j.plan, { removed: [] });
  checkActions(j, actions, j.plan);
  subOf(j, 'api').pr.head = 'h2';
  assert.throws(() => checkActions(j, actions, j.plan), /“Deliver api” has moved since this was proposed \(head h1 is now h2\)/);
  subOf(j, 'api').pr.head = 'h1';
  const lines = applyActions(j, actions, { now: 9 });
  assert.deepEqual(subOf(j, 'api').acceptedRed, { ref: 'h1', note: 'flaky', at: 9 });
  assert.equal(subOf(j, 'api').mergeApprovedHead, 'h1', 'accepting red at an open PR is the merge approval');
  assert.deepEqual(subOf(j, 'web').acceptedRed, { ref: 'm1', note: null, at: 9 });
  assert.equal(subOf(j, 'web').mergeApprovedHead, undefined);
  assert.deepEqual([subOf(j, 'old').stage, subOf(j, 'old').deployed.checks], ['cleanup', ['done in #421']]);
  assert.equal(lines.length, 3);
});

test('recover waits for the fix; rework sends code or a session result back to its own agent', () => {
  const j = job([spec('api'), spec('fix'), spec('ses', [], { kind: 'session', repo: undefined })], { api: failedDeployOf(), fix: { stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1' } }, ses: { stage: 'review', state: 'verified', result: { receiptId: 'r1', checks: ['x'] } } });
  const actions = stampActions(j, [{ type: 'recover', sub: 'api', fix: 'fix' }, { type: 'rework', sub: 'ses', note: 'cover SSO' }], j.plan, { removed: [] });
  applyActions(j, actions, { now: 1 });
  assert.deepEqual([subOf(j, 'api').recoveredBy, subOf(j, 'api').state], ['fix', 'awaiting-fix']);
  assert.deepEqual([subOf(j, 'ses').stage, subOf(j, 'ses').state, subOf(j, 'ses').feedback, subOf(j, 'ses').result], ['session', 'queued', 'cover SSO', null]);
  const k = job([spec('fix')], { fix: { stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1' } } });
  applyActions(k, stampActions(k, [{ type: 'rework', sub: 'fix', note: 'rename it' }], k.plan, { removed: [] }), { now: 2 });
  assert.equal(subOf(k, 'fix').stage, 'implementation', 'code reworked under review comes back through review');
  assert.equal(subOf(k, 'fix').note, 'rename it');
});

test('a plan receipt may carry a diagnosis, actions and up to two alternatives, and nothing else', () => {
  const plan = { context: 'c', stories: [{ id: 'story', key: 'A-1', title: 'Story' }], subJobs: [spec('api')] };
  const ok = { kind: 'plan', plan, label: 'Accept', why: 'unrelated', actions: [{ type: 'accept-red', sub: 'api' }], diagnosis: { summary: 'flaky', evidence: [{ label: 'run 1', detail: 'timeout' }] }, alternatives: [{ label: 'Fix it', plan }, { label: 'Wait', plan, actions: [{ type: 'mark', sub: 'api', position: 'done', evidence: '#1' }] }] };
  assert.equal(reportSchema.safeParse(ok).success, true);
  assert.equal(reportSchema.safeParse({ ...ok, alternatives: [...ok.alternatives, { label: 'Third', plan }] }).success, false);
  assert.equal(reportSchema.safeParse({ ...ok, actions: [{ type: 'delete', sub: 'api' }] }).success, false);
  assert.equal(reportSchema.safeParse({ ...ok, actions: [{ type: 'accept-red', sub: 'api', pin: { at: 'head', ref: 'x' } }] }).success, false, 'a pin is the server\'s to stamp');
});

test('a proposal carries ranked options, each merged and stamped; approving the chosen one applies only its actions', () => {
  const subs = [spec('api'), spec('web', ['api'])];
  const j = job(subs, { api: redOf() });
  j.replan = { feedback: 'Checks red', at: 1, proposal: null };
  const alt = { ...empty(j), subJobs: [...subs, spec('flake', [], { brief: 'Stabilise it' })].map((s) => (s.id === 'api' ? { ...s, after: ['flake'] } : s)) };
  proposeReplan(j, { id: 'run_1' }, { plan: empty(j), label: 'Accept', why: 'Noise', actions: [{ type: 'accept-red', sub: 'api' }], diagnosis: { summary: 'flaky' }, alternatives: [{ label: 'Fix it first', plan: alt }] }, 5);
  const p = j.replan.proposal;
  assert.deepEqual(optionsOf(p).map((o) => o.label), ['Accept', 'Fix it first']);
  assert.deepEqual(p.actions[0].pin, { at: 'head', ref: 'h1' });
  assert.deepEqual(p.alternatives[0].changes.added, ['flake']);
  assert.throws(() => approveReplan(structuredClone(j), 'run_1', { now: 6, buildSubJob, option: 2 }), /Choose one of/);
  const second = structuredClone(j);
  approveReplan(second, 'run_1', { now: 6, buildSubJob, option: 1 });
  assert.equal(subOf(second, 'api').acceptedRed, undefined, 'the other option\'s action is not applied');
  assert.ok(subOf(second, 'flake'));
  const first = structuredClone(j);
  const { detail } = approveReplan(first, 'run_1', { now: 6, buildSubJob });
  assert.equal(subOf(first, 'api').acceptedRed.ref, 'h1');
  assert.match(detail, /1 action/);
  const moved = structuredClone(j);
  subOf(moved, 'api').pr.head = 'h2';
  assert.throws(() => approveReplan(moved, 'run_1', { now: 6, buildSubJob }), /has moved since this was proposed/);
  assert.ok(moved.replan, 'a refused approval leaves the proposal to be looked at again');
});

test('a receipt whose second option breaks a rule is refused whole', () => {
  const j = job([spec('api')], { api: redOf() });
  j.replan = { feedback: 'x', at: 1, proposal: null };
  assert.throws(() => proposeReplan(j, { id: 'r' }, { plan: empty(j), alternatives: [{ label: 'Bad', plan: empty(j), actions: [{ type: 'mark', sub: 'api', position: 'merged' }] }] }, 1), /cite the evidence/);
  assert.equal(j.replan.proposal, null);
});

test('a recover and its fix are one proposal: the fix is added, then the merged sub-job waits on it', () => {
  const subs = [spec('api'), spec('web', ['api'])];
  const j = job(subs, { api: failedDeployOf() });
  j.replan = { feedback: 'Deploy failed', at: 1, proposal: null };
  const plan = { ...empty(j), subJobs: [...subs, spec('fix', [], { brief: 'Make the migration idempotent' })] };
  proposeReplan(j, { id: 'run_1' }, { plan, actions: [{ type: 'recover', sub: 'api', fix: 'fix' }] }, 1);
  approveReplan(j, 'run_1', { now: 2, buildSubJob });
  assert.deepEqual([subOf(j, 'api').recoveredBy, subOf(j, 'api').state, !!subOf(j, 'fix')], ['fix', 'awaiting-fix', true]);
});

test('instant chips build a pinned proposal with no agent, for the human to approve', () => {
  const j = job([spec('api'), spec('web', ['api'])], { api: redOf() });
  const at = (sub) => changeView(j, sub);
  const api = subOf(j, 'api');
  quickChange(j, api, { ...at(api), kind: 'accept-red', note: 'flaky e2e' }, { now: 100 });
  const p = j.replan.proposal;
  assert.deepEqual([p.id, p.instant, p.label, p.actions], ['quick_100', true, null, [{ type: 'accept-red', note: 'flaky e2e', sub: 'api', pin: { at: 'head', ref: 'h1' } }]]);
  assert.equal(j.replan.feedback, 'Accept the red pipeline on “Deliver api”');
  assert.equal(api.acceptedRed, undefined, 'nothing happens until approved');
  assert.throws(() => quickChange(j, api, { ...at(api), kind: 'drop' }, { now: 101 }), /pending/);
  approveReplan(j, 'quick_100', { now: 102, buildSubJob });
  assert.equal(api.acceptedRed.note, 'flaky e2e');
});

test('Drop leaves the sub-job out, refuses one that landed or a step that moved, and the mark chips default their evidence', () => {
  const j = job([spec('api'), spec('web'), spec('done')], { api: redOf(), done: { stage: 'deployment', state: 'watching' } });
  const api = subOf(j, 'api');
  assert.throws(() => quickChange(j, api, { at: 'pr', ref: 'stale', kind: 'drop' }, { now: 1 }), /changed since you looked/);
  assert.throws(() => quickChange(j, subOf(j, 'done'), { ...changeView(j, subOf(j, 'done')), kind: 'drop' }, { now: 1 }), /has landed/);
  quickChange(j, api, { ...changeView(j, api), kind: 'drop' }, { now: 2 });
  assert.deepEqual([j.replan.proposal.changes.removed, j.replan.proposal.actions], [['api'], []]);
  approveReplan(j, 'quick_2', { now: 3, buildSubJob });
  assert.ok(api.cancelledAt);
  assert.deepEqual(chipAction('mark-merged'), { type: 'mark', position: 'merged', evidence: 'Merged by hand' });
  assert.deepEqual(chipAction('mark-done', 'covered by #421'), { type: 'mark', position: 'done', evidence: 'covered by #421' });
  assert.equal(chipAction('drop'), null);
  assert.throws(() => chipAction('nuke'), /Unknown quick change/);
});
