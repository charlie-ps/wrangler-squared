import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateAction, stampActions, checkActions, applyActions, forwardsOnly, changeView } from './job-actions.js';
import { proposeReplan, approveReplan, optionsOf } from './job-replan.js';
import { reportSchema } from './jobs-schema.js';
import { buildSubJob } from './job-store.js';
import { autoApplicable } from './job-red.js';
import { requestChange } from './job-change.js';

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

test('a plan receipt may carry a diagnosis, actions, what each option leaves you and up to two alternatives, and nothing else', () => {
  const plan = { context: 'c', stories: [{ id: 'story', key: 'A-1', title: 'Story' }], subJobs: [spec('api')] };
  const ok = { kind: 'plan', plan, label: 'Accept', why: 'unrelated', leaves: 'Merge main into next by hand', actions: [{ type: 'accept-red', sub: 'api' }], diagnosis: { summary: 'flaky', evidence: [{ label: 'run 1', detail: 'timeout' }] }, alternatives: [{ label: 'Fix it', plan, leaves: 'Nothing' }, { label: 'Wait', plan, actions: [{ type: 'mark', sub: 'api', position: 'done', evidence: '#1' }] }] };
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
  proposeReplan(j, { id: 'run_1' }, { plan: empty(j), label: 'Accept', why: 'Noise', leaves: 'Fix the flake later', actions: [{ type: 'accept-red', sub: 'api' }], diagnosis: { summary: 'flaky' }, alternatives: [{ label: 'Fix it first', plan: alt }] }, 5);
  const p = j.replan.proposal;
  assert.deepEqual(optionsOf(p).map((o) => o.label), ['Accept', 'Fix it first']);
  assert.deepEqual(optionsOf(p).map((o) => o.leaves), ['Fix the flake later', null], 'what each option leaves the human, kept for the decision card');
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
  assert.equal(approveReplan(moved, 'run_1', { now: 6, buildSubJob }).sentBack, true, 'a moved head can never be approved: it goes back to the planner');
  assert.equal(subOf(moved, 'api').acceptedRed, undefined);
  assert.equal(moved.replan.proposal, null);
  assert.match(moved.replan.feedback, /“Deliver api” \(api\) has moved \(head h1 is now h2\)/);
  const busy = structuredClone(j);
  busy.runs.push({ id: 'run_r', subJobId: 'api', stopped: false });
  assert.throws(() => approveReplan(busy, 'run_1', { now: 6, buildSubJob }), /Wait for the step on “Deliver api” to stop/, 'a step still running has not moved: that refusal stands');
  assert.ok(busy.replan.proposal, 'a refused approval leaves the proposal to be looked at again');
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

// A PR step whose session reported ready and is parked on the review (job-parked.js).
const parkedOf = (round = 2) => ({ stage: 'review', state: 'verified', ready: { checks: ['x'], receiptId: `run_i#${round}`, round } });
const parkedJob = (patches = {}) => {
  const j = job([spec('api'), spec('web')], { api: parkedOf(), ...patches });
  j.runs.push({ id: 'run_i', subJobId: 'api', stopped: false, parkedFor: 'ready' });
  return j;
};

test('forward pins to the open review round; a step with no open session is refused, one still answering is not', () => {
  const j = parkedJob();
  assert.deepEqual(gateAction(j, { type: 'forward', sub: 'api', note: 'Tighten it' }).pin, { at: 'round', ref: 'run_i#2', round: 2 });
  assert.throws(() => gateAction(j, { type: 'forward', sub: 'api' }), /human's words for it in `note`/);
  assert.throws(() => gateAction(j, { type: 'rework', sub: 'api', note: 'x' }), /session is still open: forward the feedback to it instead/, 'nothing ends a session that could answer');
  assert.throws(() => gateAction(j, { type: 'forward', sub: 'web', note: 'x' }), /no session open on its review to forward to: use rework instead/);
  subOf(j, 'api').answering = { id: 'msg_1', kind: 'ask', round: 2 };
  assert.deepEqual(gateAction(j, { type: 'forward', sub: 'api', note: 'x' }).pin, { at: 'round', ref: 'run_i#2', round: 2 }, 'it queues behind the answer in flight');
  j.runs[0].stopped = true; subOf(j, 'api').answering = null;
  assert.throws(() => gateAction(j, { type: 'forward', sub: 'api', note: 'x' }), /use rework instead/);
  assert.deepEqual(gateAction(j, { type: 'rework', sub: 'api', note: 'x' }).pin, { at: 'stage', ref: 'review' });
  assert.ok(reportSchema.safeParse({ kind: 'plan', plan: { context: '', subJobs: [{ id: 'api', title: 'x', repo: '/r', brief: 'b' }] }, actions: [{ type: 'forward', sub: 'api', note: 'Line one.\nLine two, which the human wrote at length.' }] }).success, 'a note carries the human\'s words, more than one line');
});

test('approving a forward posts the human\'s words into the open session\'s thread, with the pictures kept beside its round', () => {
  const j = parkedJob();
  j.replan = { feedback: 'About api: Tighten it', at: 1, proposal: null, previous: null, source: { sub: 'api', at: 'code', ref: 'run_i#2' },
    images: [{ sub: 'api', round: 2, file: 'ask-1.png', mime: 'image/png', path: '/r/2/ask-1.png' }, { sub: null, round: null, file: 'ask-2.png', mime: 'image/png', path: '/ideas/ask-2.png' }] };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'Not enough spacing. Does it work narrow?' }] }, 2);
  assert.deepEqual(j.replan.proposal.actions[0].pin, { at: 'round', ref: 'run_i#2', round: 2 });
  assert.equal(subOf(j, 'api').thread, undefined, 'nothing is said until the human approves');
  const { lines } = approveReplan(j, 'run_p', { now: 3, buildSubJob });
  const [m] = subOf(j, 'api').thread;
  assert.deepEqual([m.from, m.via, m.to, m.round, m.sentAt, m.images], ['human', 'planner', 'agent', 2, null, [{ file: 'ask-1.png', mime: 'image/png' }]]);
  assert.equal(m.text, 'Not enough spacing. Does it work narrow?\n(Pasted images, read them: "/ideas/ask-2.png")');
  assert.deepEqual(subOf(j, 'api').answering, { id: m.id, at: 3, kind: 'change', round: 2 });
  assert.deepEqual([subOf(j, 'api').stage, subOf(j, 'api').state, j.runs[0].stopped], ['review', 'verified', false], 'the session stays open and answers');
  assert.match(lines.at(-1).detail, /Forwarded your words to “Deliver api”'s open session/);
});

test('a forward approved while the session is still answering is accepted and queued behind the message in flight', () => {
  const j = parkedJob();
  subOf(j, 'api').thread = [{ id: 'msg_1', at: 1, from: 'human', via: 'planner', to: 'agent', text: 'Tighten it', round: 2, sentAt: 2 }];
  subOf(j, 'api').answering = { id: 'msg_1', at: 1, kind: 'change', round: 2 };
  j.replan = { feedback: 'About api: Does it work narrow?', at: 3, proposal: null, previous: null, source: { sub: 'api', at: 'code', ref: 'run_i#2' } };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'Does it work narrow?' }] }, 4);
  assert.deepEqual(j.replan.proposal.actions[0].pin, { at: 'round', ref: 'run_i#2', round: 2 });
  approveReplan(j, 'run_p', { now: 5, buildSubJob });
  const [, m] = subOf(j, 'api').thread;
  assert.deepEqual([m.text, m.sentAt], ['Does it work narrow?', null], 'queued, not yet sent');
  assert.deepEqual(subOf(j, 'api').answering, { id: 'msg_1', at: 1, kind: 'change', round: 2 }, 'still answering the first');
});

test('a forward on a moved review round, or a finished review, is still refused', () => {
  const j = parkedJob();
  j.replan = { feedback: 'About api: Tighten it', at: 1, proposal: null, previous: null, source: { sub: 'api', at: 'code', ref: 'run_i#2' } };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'Tighten it' }] }, 2);
  Object.assign(subOf(j, 'api'), parkedOf(3));
  assert.throws(() => checkActions(j, j.replan.proposal.actions, j.plan), /has moved since .*run_i#2 is now .*run_i#3/);
  const out = approveReplan(j, 'run_p', { now: 3, buildSubJob });
  assert.equal(out.sentBack, true, 'a new round sends it back to the wrangler');
  assert.equal(subOf(j, 'api').thread, undefined, 'nothing reaches the session');
  const k = parkedJob({ api: { ...parkedOf(), state: 'approved' } });
  assert.throws(() => gateAction(k, { type: 'forward', sub: 'api', note: 'x' }), /no session open on its review/);
});

test('a forwards-only proposal is noted as a forward with no prose, and its approval names the thread message it became; a plan change keeps its words', () => {
  const j = parkedJob();
  j.replan = { feedback: 'About api: Tighten it', at: 1, proposal: null, previous: null, source: { sub: 'api', at: 'code', ref: 'run_i#2' } };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'Tighten it' }], why: 'Passes your words straight to the agent.' }, 2);
  const card = j.talk.at(-1);
  assert.deepEqual([card.kind, card.forward, card.text, card.changes], ['proposal', true, '', [{ mark: 'forward', title: 'Deliver api', sub: 'api' }]]);
  approveReplan(j, 'run_p', { now: 3, buildSubJob });
  assert.deepEqual([card.outcome, card.forwarded], ['approved', [{ sub: 'api', message: subOf(j, 'api').thread[0].id }]]);

  const k = parkedJob();
  k.replan = { feedback: 'Add web2', at: 1, proposal: null, previous: null };
  proposeReplan(k, { id: 'run_q' }, { kind: 'plan', plan: { ...empty(k), subJobs: [...empty(k).subJobs, { id: 'web2', title: 'Deliver web2', repo: '/r', brief: 'b' }] }, actions: [{ type: 'forward', sub: 'api', note: 'x' }], why: 'Adds web2.' }, 2);
  const mixed = k.talk.at(-1);
  assert.deepEqual([mixed.forward, mixed.text], [undefined, 'Adds web2.'], 'a real plan change is still a card with its words');
});

test('a forward or rework on the step the idea came from is refused once that view has moved: a new round is not what the human read', () => {
  const j = parkedJob();
  j.replan = { feedback: 'x', at: 1, proposal: null, previous: null, source: { sub: 'api', at: 'code', ref: 'run_i#1' } };
  assert.throws(() => proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'x' }] }, 2), /moved since the idea about it was sent \(code run_i#1 is now code run_i#2\)/);
  j.replan.source.ref = 'run_i#2';
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'x' }] }, 2);
  Object.assign(subOf(j, 'api'), parkedOf(3));
  assert.equal(approveReplan(j, 'run_p', { now: 3, buildSubJob }).sentBack, true);
  assert.equal(subOf(j, 'api').thread, undefined);
  assert.deepEqual(j.replan.source, { sub: 'api', at: 'code', ref: 'run_i#3' }, 'the planner may act on the round the human now has in front of them');
});

test('a retry pins to the failure it was written about, refuses a step that is not red, and starts it again as the human\'s Retry would', () => {
  const lock = "Command failed: git fetch origin: error: cannot lock ref 'refs/remotes/origin/main'";
  const j = job([spec('api'), spec('web')], { api: { stage: 'implementation', state: 'queued', error: lock, red: { held: 'x' } } });
  assert.throws(() => gateAction(j, { type: 'retry', sub: 'web' }), /“Deliver web” is not red: nothing to retry/);
  const actions = stampActions(j, [{ type: 'retry', sub: 'api' }], j.plan, { removed: [] });
  assert.deepEqual(actions[0].pin, { at: 'red', ref: `${lock}|||0` });
  subOf(j, 'api').error = 'Command failed: npm ci';
  assert.throws(() => checkActions(j, actions, j.plan), /“Deliver api” has moved since this was proposed \(failure Command f/);
  subOf(j, 'api').error = lock;
  checkActions(j, actions, j.plan);
  assert.deepEqual(applyActions(j, actions, { now: 9 }).map((l) => l.detail), ['Retried “Deliver api”']);
  const api = subOf(j, 'api');
  assert.deepEqual([api.error, api.blocked, api.state, api.replanAllowance, api.red.held], [null, null, 'queued', 1, null]);
});

test('a red step\'s fix never applies a retry by itself, whatever else it carries', () => {
  const j = job([spec('api')], { api: { stage: 'implementation', state: 'queued', error: 'cannot lock ref' } });
  j.replan = { feedback: 'x', at: 1, proposal: null, previous: null };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'retry', sub: 'api' }] }, 2);
  assert.equal(autoApplicable({ ...j, reviewPlan: false, reviewRed: false }, j.replan.proposal), false);
  assert.equal(autoApplicable(j, { ...j.replan.proposal, actions: [{ type: 'rework', sub: 'api', note: 'x' }] }), true, 'a rework alone still would');
});

test('a red step\'s fix never applies a forward by itself', () => {
  const j = parkedJob();
  j.replan = { feedback: 'x', at: 1, proposal: null, previous: null };
  proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), actions: [{ type: 'forward', sub: 'api', note: 'x' }] }, 2);
  assert.equal(autoApplicable({ ...j, reviewPlan: false }, j.replan.proposal), false);
});

test('only a proposal of forwards and nothing else skips the human: any plan change, other action, option or escalation waits', () => {
  const j = parkedJob({ web: redOf() });
  const of = (report) => { j.replan = { feedback: 'x', at: 1, proposal: null, previous: null }; proposeReplan(j, { id: 'run_p' }, { kind: 'plan', plan: empty(j), ...report }, 2); return forwardsOnly(j.replan.proposal); };
  const fwd = { type: 'forward', sub: 'api', note: 'x' };
  assert.equal(of({ actions: [fwd] }), true);
  assert.equal(of({ actions: [] }), false, 'a diagnosis alone is for the human to read');
  assert.equal(of({ actions: [fwd, { type: 'rework', sub: 'web', note: 'y' }] }), false);
  assert.equal(of({ actions: [fwd], plan: { ...empty(j), subJobs: [...empty(j).subJobs, spec('docs')] } }), false, 'a plan edit');
  assert.equal(of({ actions: [fwd], alternatives: [{ label: 'Or', plan: empty(j), actions: [] }] }), false);
  assert.equal(forwardsOnly({ ...j.replan.proposal, actions: [fwd], alternatives: [], escalation: { sub: 'api' } }), false);
});

// The job moved under a proposal the human is about to approve: what it edits or
// acts on has since landed. No press could ever approve it, so it goes back.
const openPrOf = () => ({ stage: 'pr', state: 'watching', pr: { url: PR, head: 'h1', checkStatus: 'passing' } });
const ideaOn = (j, id, text) => { const sub = subOf(j, id); requestChange(j, sub, { ...changeView(j, sub), text }, { now: 1 }); };
const land = (j, id, patch) => Object.assign(subOf(j, id), patch);

test('Unit test: brief edit on a PR that merges before approval goes back to the planner', () => {
  const j = job([spec('api'), spec('web')], { api: openPrOf() });
  ideaOn(j, 'api', 'Rename the flag');
  proposeReplan(j, { id: 'run_p' }, { plan: { ...empty(j), subJobs: [spec('api', [], { brief: 'Implement api with the renamed flag' }), spec('web')] } }, 2);
  land(j, 'api', { stage: 'deployment', mergedAt: 3, pr: { ...subOf(j, 'api').pr, mergeCommit: 'm1' } });
  const back = approveReplan(j, 'run_p', { now: 4, buildSubJob });
  assert.equal(back.sentBack, true);
  assert.deepEqual(back.lines.map((l) => l.detail), ['“Deliver api” has merged since the plan change was proposed, so it went back to Wrangler']);
  assert.equal(back.detail, 'Sent the plan change back to Wrangler: “Deliver api” has merged since it was proposed');
  assert.equal(subOf(j, 'api').brief, 'Implement api', 'nothing of the stale proposal is applied');
  assert.equal(j.replan.proposal, null, 'the planner runs again');
  assert.deepEqual(j.replan.earlier, ['About “Deliver api” (api, pr/watching): Rename the flag'], 'the human\'s idea stays, once');
  assert.match(j.replan.feedback, /^Wrangler, not the human: .*“Deliver api” \(api\) has merged\./s);
  assert.equal(j.replan.previous.subJobs[0].brief, 'Implement api with the renamed flag', 'the planner reads what it proposed');
  assert.deepEqual(j.replan.source, { sub: 'api', at: 'step', ref: 'deployment/watching' });

  const k = job([spec('api')], { api: openPrOf() });
  ideaOn(k, 'api', 'Tighten the error');
  proposeReplan(k, { id: 'run_p' }, { plan: empty(k), actions: [{ type: 'rework', sub: 'api', note: 'Tighten the error' }] }, 2);
  land(k, 'api', { stage: 'deployment', mergedAt: 3 });
  assert.equal(approveReplan(k, 'run_p', { now: 4, buildSubJob }).sentBack, true, 'a rework on a PR that merged meanwhile goes back too');
  assert.deepEqual(k.replan.previousActions, [{ type: 'rework', sub: 'api', note: 'Tighten the error' }]);
  assert.equal(subOf(k, 'api').fixRequested, null);
});

test('Unit test: mark-done on a deploying step that finishes goes back to the planner', () => {
  const j = job([spec('api'), spec('web', ['api'])], { api: { stage: 'deployment', state: 'watching', pr: { url: PR, head: 'h1', mergeCommit: 'm1' }, deploymentResult: { status: 'pending' } } });
  ideaOn(j, 'api', 'The deploy is done, I checked');
  proposeReplan(j, { id: 'run_p' }, { plan: empty(j), actions: [{ type: 'mark', sub: 'api', position: 'done', evidence: 'Deploy run 7' }] }, 2);
  assert.deepEqual(j.replan.proposal.actions[0].pin, { at: 'stage', ref: 'deployment' });
  land(j, 'api', { stage: 'cleanup', state: 'queued', deployed: { at: 3, checks: ['Deploy passed'], commit: 'm1' } });
  const back = approveReplan(j, 'run_p', { now: 4, buildSubJob });
  assert.equal(back.sentBack, true);
  assert.match(back.detail, /“Deliver api” has landed since it was proposed/);
  assert.deepEqual(subOf(j, 'api').deployed.checks, ['Deploy passed'], 'the real delivery stands, not the mark');
  assert.match(j.replan.feedback, /“Deliver api” \(api\) has landed/);
  assert.deepEqual(j.replan.source, { sub: 'api', at: 'step', ref: 'deployment/watching' }, 'a finished step has no view to re-pin to');
});

test('a proposal refused for a rule the job did not move into still refuses, and stays', () => {
  const j = job([spec('api'), spec('web')], { api: openPrOf() });
  j.replan = { feedback: 'x', at: 1, proposal: null };
  proposeReplan(j, { id: 'run_p' }, { plan: empty(j), actions: [{ type: 'rework', sub: 'api', note: 'x' }] }, 2);
  j.runs.push({ id: 'run_r', subJobId: 'api', stopped: false });
  assert.throws(() => approveReplan(j, 'run_p', { now: 3, buildSubJob }), /Wait for the step on “Deliver api” to stop/);
  assert.equal(j.replan.proposal.id, 'run_p');
  const { sentBack } = approveReplan(Object.assign(j, { runs: [] }), 'run_p', { now: 3, buildSubJob });
  assert.equal(sentBack, undefined);
});
