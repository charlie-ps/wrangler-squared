import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milestoneReached, writeStatus, fillText, editWrite, advanceWrite, writeUrl, writeBrief, approveWrite, skipWrite, placeName } from './job-writes.js';
import { writeReviewed } from './jobs-schema.js';

const pr = (over = {}) => ({ id: 't', kind: 'pr', title: 'Deliver t', repo: '/repo', stage: 'implementation', sessions: [], ...over });
const write = (on, over = {}) => ({ id: 'w', kind: 'write', place: { type: 'jira' }, title: 'W', storyId: 's', jiraKey: 'A-1', after: [], on, action: { type: 'transition', to: 'Done' }, stage: 'write', state: 'queued', ...over });
const jobOf = (t, w) => ({ plan: { context: '', stories: [{ id: 's', key: 'A-1', title: 'S' }], subJobs: [t, w] }, subJobs: [t, w], runs: [] });

test('milestones: started is any session or later stage, merged includes marked done, deployed is the after bar', () => {
  assert.equal(milestoneReached(pr(), 'started'), false);
  assert.equal(milestoneReached(pr({ sessions: ['s1'] }), 'started'), true);
  assert.equal(milestoneReached({ id: 'h', kind: 'human', stage: 'human', state: 'doing' }, 'started'), true);
  assert.equal(milestoneReached(pr({ stage: 'cleanup', cancelledAt: 1 }), 'started'), false, 'dropped before it began');
  assert.equal(milestoneReached(pr({ pr: { url: 'u' } }), 'pr'), true);
  assert.equal(milestoneReached(pr({ deployed: { checks: ['Marked'] } }), 'merged'), true);
  assert.equal(milestoneReached(pr({ mergedAt: 1, stage: 'deployment' }), 'deployed'), false);
  assert.equal(milestoneReached({ id: 's', kind: 'session', stage: 'cleanup' }, 'deployed'), true, 'a session is deployed once done');
});

test('a write waits, falls due, waits for its ticket, is dead on a dropped trigger, or is not needed once an if-dropped trigger lands', () => {
  assert.equal(writeStatus(jobOf(pr(), write({ sub: 't', at: 'pr' })), write({ sub: 't', at: 'pr' })), 'wait');
  const opened = pr({ pr: { url: 'u' } });
  assert.equal(writeStatus(jobOf(opened, write({ sub: 't', at: 'pr' })), write({ sub: 't', at: 'pr' })), 'due');
  assert.equal(writeStatus(jobOf(opened, null), write({ sub: 't', at: 'pr' }, { jiraKey: null })), 'ticket');
  assert.equal(writeStatus(jobOf(pr({ cancelledAt: 1, stage: 'cleanup' }), null), write({ sub: 't', at: 'pr' })), 'dead');
  assert.equal(writeStatus(jobOf(pr({ cancelledAt: 1, stage: 'cleanup' }), null), write({ sub: 't', at: 'dropped' })), 'due');
  assert.equal(writeStatus(jobOf(pr({ deployed: { checks: [] } }), null), write({ sub: 't', at: 'dropped' })), 'not-needed');
  assert.equal(writeStatus(jobOf(pr(), null), write({ sub: 't', at: 'dropped' })), 'wait', 'dormant');
  assert.equal(writeStatus(jobOf(pr(), null), { ...write(undefined), action: { type: 'create' }, jiraKey: null }), 'due', 'a create is due on approval and needs no key');
});

test('text is filled from its trigger and from other writes\' places, and says so where a value is missing', () => {
  const t = pr({ pr: { url: 'https://github.com/o/r/pull/3' }, deploymentResult: { runs: [{ status: 'failing', url: 'r1' }, { status: 'passing', url: 'r2' }] } });
  const w = write({ sub: 't', at: 'deployed' }, { action: { type: 'comment', comment: '{pr.title} {pr.url} {deploy.run} {other}' } });
  assert.equal(fillText(jobOf(t, w), w, w.action.comment), 'Deliver t https://github.com/o/r/pull/3 r2 {other}');
  assert.equal(fillText(jobOf(pr(), w), w, w.action.comment), 'Deliver t (not available) (not available) {other}');
  const job = jobOf(t, w);
  job.plan.jiraSite = 'https://x.atlassian.net';
  job.subJobs.push({ id: 'page', kind: 'write', place: { type: 'artifact' }, result: { url: 'https://claude.ai/artifact/1' } }, { id: 'later', kind: 'write', place: { type: 'url' } });
  assert.equal(fillText(job, w, '{page.url} {w.url} {later.url}'), 'https://claude.ai/artifact/1 https://x.atlassian.net/browse/A-1 (not available)', 'a ticket links through the site the planner read');
  assert.equal(writeUrl({ plan: {} }, w), null, 'no site, no link');
});

test('a create write only changes its story and review flag; a running write cannot be edited', () => {
  const create = { ...write(undefined), action: { type: 'create' } };
  delete create.on;
  const job = jobOf(pr(), create);
  assert.throws(() => editWrite(job, create, { action: { to: 'Done' } }), /only change its story and whether it is reviewed/);
  editWrite(job, create, { review: true });
  assert.equal(create.review, true);
  assert.throws(() => editWrite(job, { ...create, state: 'writing' }, { review: false }), /Wait for the write to finish/);
});

test('a made output is dropped with its session, and failed when its session finishes without saying where it is', () => {
  const session = { id: 'r', kind: 'session', title: 'Measure p95', stage: 'session', sessions: [] };
  const make = { id: 'm', kind: 'write', place: { type: 'file' }, title: 'k6 report', by: 'r', action: { type: 'make', what: 'k6 report' }, stage: 'write', state: 'queued', after: [] };
  const job = { plan: { stories: [], subJobs: [] }, subJobs: [session, make], runs: [] };
  assert.equal(advanceWrite(job, make, 1), false, 'it waits on its session, never falls due');
  session.stage = 'cleanup';
  assert.equal(advanceWrite(job, make, 2), true);
  assert.equal(make.state, 'failed'); assert.equal(make.error, 'Measure p95 finished without reporting it');
  const dropped = { ...make, state: 'queued', error: null };
  assert.equal(advanceWrite({ ...job, subJobs: [{ ...session, cancelledAt: 3 }, dropped] }, dropped, 4), true);
  assert.equal(dropped.cancelledAt, 4);
});

test('an edit changes a write\'s text or channel in place and keeps its type', () => {
  const t = pr();
  const post = { id: 'w', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], on: { sub: 't', at: 'pr' }, action: { type: 'post', text: 'Up: {pr.url}' }, stage: 'review', state: 'verified', review: true };
  const job = { plan: { context: '', stories: [], subJobs: [t, structuredClone(post)] }, subJobs: [t, post], runs: [] };
  editWrite(job, post, { action: { text: 'Shipped: {pr.url}' }, ref: '#web-platform' });
  assert.deepEqual([post.action, post.place], [{ type: 'post', text: 'Shipped: {pr.url}' }, { type: 'slack', ref: '#web-platform' }]);
  assert.deepEqual(job.plan.subJobs[1].place, { type: 'slack', ref: '#web-platform' }, 'the plan is the record of the write');
  assert.throws(() => editWrite(job, post, { action: { text: null } }), /a Slack post is its text/);
  assert.throws(() => editWrite(job, post, { ref: null }), /names its channel/);
});

test('review is the write\'s own say when it has one, else the job\'s default, else off', () => {
  assert.equal(writeReviewed({}, {}), false, 'off by default');
  assert.equal(writeReviewed({ reviewWrites: true }, {}), true);
  assert.equal(writeReviewed({ reviewWrites: true }, { review: false }), false, 'an explicit false overrides the job');
  assert.equal(writeReviewed({ reviewWrites: false }, { review: true }), true, 'a planner-set true holds');
  const t = pr({ pr: { url: 'u' } });
  const w = write({ sub: 't', at: 'pr' });
  const job = { ...jobOf(t, w), reviewWrites: true };
  advanceWrite(job, w, 1);
  assert.deepEqual([w.stage, w.state], ['review', 'verified'], 'the job default holds a write with no review of its own');
  const off = write({ sub: 't', at: 'pr' }, { review: false });
  advanceWrite({ ...jobOf(t, off), reviewWrites: true }, off, 1);
  assert.equal(off.state, 'due');
  const edited = write({ sub: 't', at: 'pr' }, { review: false, stage: 'write', state: 'failed' });
  editWrite(jobOf(t, edited), edited, { action: { to: 'QA' } });
  assert.equal(edited.review, false, 'an edit keeps an explicit false');
});

test('an other place is named, written with one instruction, and briefed with its name', () => {
  const t = pr({ pr: { url: 'https://github.com/o/r/pull/3' } });
  const w = { id: 'lin', kind: 'write', title: 'Link the PR', place: { type: 'other', name: 'Linear', ref: 'ENG-12' }, after: [], on: { sub: 't', at: 'pr' },
    action: { type: 'write', text: 'Attach {pr.url} to the issue' }, stage: 'write', state: 'queued', why: 'The team tracks it there' };
  const job = { plan: { context: '', stories: [], subJobs: [t, w] }, subJobs: [t, w], runs: [] };
  assert.equal(placeName(w), 'Linear');
  assert.deepEqual(writeBrief(job, w), { id: 'lin', place: 'other', name: 'Linear', where: 'ENG-12', write: 'write', text: 'Attach https://github.com/o/r/pull/3 to the issue', approved: false, because: 'Deliver t reached pr', why: 'The team tracks it there' });
  assert.throws(() => editWrite(job, w, { action: { text: null } }), /say what to write there/);
  editWrite(job, w, { ref: null });
  assert.deepEqual(w.place, { type: 'other', name: 'Linear' }, 'where is optional for another place');
  editWrite(job, w, { name: 'Linear (ENG)' });
  assert.deepEqual([w.place, job.plan.subJobs[1].place.name], [{ type: 'other', name: 'Linear (ENG)' }, 'Linear (ENG)'], 'another place can be renamed');
  const post = { id: 'p', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], on: { sub: 't', at: 'pr' }, action: { type: 'post', text: 'Up' }, stage: 'write', state: 'queued' };
  const named = { plan: { context: '', stories: [], subJobs: [t, structuredClone(post)] }, subJobs: [t, post], runs: [] };
  assert.throws(() => editWrite(named, post, { name: 'Somewhere' }), /name/i, 'only another place has a name');
});

test('a create write\'s review edits its story: title and fields on the plan, and the create\'s own title', () => {
  const create = { id: 'create-s', kind: 'write', title: 'Create story: S', place: { type: 'jira' }, storyId: 's', after: [], action: { type: 'create' }, stage: 'review', state: 'verified', review: true };
  const other = write({ sub: 't', at: 'pr' });
  const job = { plan: { context: '', stories: [{ id: 's', project: 'SEC', title: 'S', fields: [{ name: 'Labels', value: 'a' }] }], subJobs: [pr(), structuredClone(create), other] }, subJobs: [pr(), create, other], runs: [] };
  other.storyId = 's'; job.plan.subJobs[2].storyId = 's';
  assert.throws(() => editWrite(job, create, { story: { fields: [{ name: 'Summary', value: 'x' }] } }), /the title is the summary/);
  assert.throws(() => editWrite(job, create, { story: { fields: [{ name: 'Labels', value: 'a' }, { name: 'labels', value: 'b' }] } }), /name each field once/);
  assert.throws(() => editWrite(job, other, { story: { title: 'X' } }), /Only the write that creates a story can edit it/);
  assert.equal(job.plan.stories[0].title, 'S', 'a refused edit changes nothing');
  editWrite(job, create, { story: { title: 'Sign-ins are audited', fields: [{ name: 'Issue Type', value: 'Story' }] } });
  assert.deepEqual(job.plan.stories[0], { id: 's', project: 'SEC', title: 'Sign-ins are audited', fields: [{ name: 'Issue Type', value: 'Story' }] });
  assert.deepEqual([create.title, job.plan.subJobs[1].title], ['Create story: Sign-ins are audited', 'Create story: Sign-ins are audited']);
  assert.deepEqual([create.stage, create.state], ['review', 'verified'], 'still reviewed: it waits for Write');
  assert.deepEqual(writeBrief(job, create).fields, [{ name: 'Issue Type', value: 'Story' }]);
  editWrite(job, create, { story: { fields: [] } });
  assert.equal('fields' in job.plan.stories[0], false, 'an empty list removes the fields');
});

test('a made output in review is accepted as published, never skipped or reshaped; approve applies its edit atomically', () => {
  const made = { id: 'm', kind: 'write', title: 'Chart', place: { type: 'artifact' }, by: 'r', after: [], action: { type: 'make', what: 'A chart' }, stage: 'review', state: 'verified', review: true,
    result: { outcome: 'written', url: 'https://claude.ai/artifact/1', checks: ['Made it'], at: 1, receiptId: 'run' } };
  const session = { id: 'r', kind: 'session', title: 'Measure', stage: 'review', sessions: [] };
  const job = { plan: { context: '', stories: [], subJobs: [session, structuredClone(made)] }, subJobs: [session, made], runs: [{ subJobId: 'r', stopped: false }] };
  assert.throws(() => skipWrite(made, 2), /already made; drop it instead/);
  assert.throws(() => approveWrite(job, made, 2, { action: { what: 'Another' } }), /already made; accept it or drop it/);
  assert.equal(made.stage, 'review');
  assert.equal(approveWrite(job, made, 2), 'Accepted the output “Chart”');
  assert.deepEqual([made.stage, made.result.url], ['cleanup', 'https://claude.ai/artifact/1']);
  const t = pr();
  const post = { id: 'w', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], on: { sub: 't', at: 'pr' }, action: { type: 'post', text: 'Up' }, stage: 'review', state: 'verified', review: true };
  const j2 = { plan: { context: '', stories: [], subJobs: [t, structuredClone(post)] }, subJobs: [t, post], runs: [] };
  assert.throws(() => approveWrite(j2, post, 3, { ref: null }), /names its channel/);
  assert.deepEqual([post.stage, post.writeApprovedAt, post.place.ref], ['review', undefined, '#web']);
  approveWrite(j2, post, 3, { action: { text: 'Shipped' }, review: false });
  assert.deepEqual([post.stage, post.state, post.action.text, post.review, post.writeApprovedAt], ['write', 'due', 'Shipped', false, 3], 'turning review off while approving still approves');
});
