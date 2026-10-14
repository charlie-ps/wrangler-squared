import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milestoneReached, triggerStatus, fillText, editWrite, advanceWrite, writeUrl, writeBrief, approveWrite, skipWrite, placeName, applyWrites, applyDrafts, draftsDecided, reopenWrite, openWrites, toDraft, awaitsKeys } from './job-writes.js';
import { writeReviewed } from './jobs-schema.js';

const pr = (over = {}) => ({ id: 't', kind: 'pr', title: 'Deliver t', repo: '/repo', stage: 'implementation', sessions: [], after: [], ...over });
const session = (over = {}) => ({ id: 'n', kind: 'session', title: 'Notify', brief: 'Tell people', stage: 'session', state: 'queued', sessions: [], after: [], ...over });
const write = (over = {}) => ({ id: 'w', kind: 'write', place: { type: 'jira' }, title: 'W', storyId: 's', jiraKey: 'A-1', after: [], by: 'n', action: { type: 'transition', to: 'Done' }, stage: 'write', state: 'queued', ...over });
const jobOf = (...subs) => ({ plan: { context: '', stories: [{ id: 's', key: 'A-1', title: 'S' }], subJobs: structuredClone(subs) }, subJobs: subs, runs: [] });

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

test('a session with a milestone waits, falls due, is dead on a dropped trigger, or is not needed once an if-dropped trigger lands', () => {
  const on = (at, t = pr()) => triggerStatus(jobOf(t, session({ on: { sub: 't', at } })), session({ on: { sub: 't', at } }));
  assert.equal(triggerStatus(jobOf(pr(), session()), session()), 'due', 'no milestone: due on approval');
  assert.equal(on('pr'), 'wait');
  assert.equal(on('pr', pr({ pr: { url: 'u' } })), 'due');
  assert.equal(on('merged', pr({ mergedAt: 1, stage: 'deployment' })), 'due');
  assert.equal(on('pr', pr({ cancelledAt: 1, stage: 'cleanup' })), 'dead');
  assert.equal(on('dropped', pr({ cancelledAt: 1, stage: 'cleanup' })), 'due');
  assert.equal(on('dropped', pr({ deployed: { checks: [] } })), 'not-needed');
  assert.equal(on('dropped'), 'wait', 'dormant');
});

test('text is filled from its session\'s trigger and other writes\' places; a write its own session makes first is named for it to fill', () => {
  const t = pr({ pr: { url: 'https://github.com/o/r/pull/3' }, deploymentResult: { runs: [{ status: 'failing', url: 'r1' }, { status: 'passing', url: 'r2' }] } });
  const n = session({ on: { sub: 't', at: 'deployed' } });
  const w = write({ action: { type: 'comment', comment: '{pr.title} {pr.url} {deploy.run} {other}' } });
  assert.equal(fillText(jobOf(t, n, w), w, w.action.comment), 'Deliver t https://github.com/o/r/pull/3 r2 {other}');
  assert.equal(fillText(jobOf(pr(), n, w), w, w.action.comment), 'Deliver t (not available) (not available) {other}');
  assert.equal(fillText(jobOf(t, session(), w), w, '{pr.url}'), '(not available)', 'a session with no trigger has no PR to name');
  const job = jobOf(t, n, w);
  job.plan.jiraSite = 'https://x.atlassian.net';
  job.subJobs.push({ id: 'page', kind: 'write', by: 'other', place: { type: 'artifact' }, result: { url: 'https://claude.ai/artifact/1' } }, { id: 'later', kind: 'write', by: 'n', place: { type: 'url' } });
  assert.equal(fillText(job, w, '{page.url} {w.url} {later.url}'), 'https://claude.ai/artifact/1 https://x.atlassian.net/browse/A-1 (not available)', 'a ticket links through the site the planner read');
  assert.equal(fillText(job, w, 'See {later.url}', (x, brace) => `${brace}<${x.id}>`), 'See {later.url}<later>');
  assert.equal(writeUrl({ plan: {} }, w), null, 'no site, no link');
  const post = write({ id: 'dm', place: { type: 'slack', ref: '@sam' }, storyId: undefined, jiraKey: undefined, action: { type: 'post', text: 'Page: {later.url}' } });
  job.subJobs.push(post);
  assert.equal(writeBrief(job, post).text, 'Page: {later.url} (the URL of write later, which you make first: put it here yourself)');
});

test('a create write only changes its story and review flag; a write its session is working on cannot be edited', () => {
  const create = write({ id: 'create-s', action: { type: 'create' } });
  const job = jobOf(session(), create);
  assert.throws(() => editWrite(job, create, { action: { to: 'Done' } }), /only change its story and whether it is reviewed/);
  editWrite(job, create, { review: true });
  assert.equal(create.review, true);
  job.runs.push({ subJobId: 'n', stopped: false });
  assert.throws(() => editWrite(job, create, { review: false }), /Wait for its session to finish/);
});

test('every write is dropped with its session, and failed when its session finishes without reporting it', () => {
  const n = session({ title: 'Measure p95' });
  const make = { id: 'm', kind: 'write', place: { type: 'file' }, title: 'k6 report', by: 'n', action: { type: 'make', what: 'k6 report' }, stage: 'write', state: 'queued', after: [] };
  const post = write({ id: 'p', place: { type: 'slack', ref: '#web' }, action: { type: 'post', text: 'Done' } });
  const job = { plan: { stories: [], subJobs: [] }, subJobs: [n, make, post], runs: [] };
  assert.equal(advanceWrite(job, make, 1), false, 'it waits on its session');
  n.stage = 'cleanup';
  assert.equal(advanceWrite(job, make, 2), true);
  assert.equal(advanceWrite(job, post, 2), true);
  assert.deepEqual([make.state, make.error, post.error], ['failed', 'Measure p95 finished without reporting it', 'Measure p95 finished without reporting it']);
  const dropped = { ...post, state: 'queued', error: null };
  assert.equal(advanceWrite({ ...job, subJobs: [{ ...n, cancelledAt: 3 }, dropped] }, dropped, 4), true);
  assert.equal(dropped.cancelledAt, 4);
  const legacy = write({ by: undefined, on: { sub: 't', at: 'pr' } });
  assert.equal(advanceWrite({ ...job, subJobs: [legacy] }, legacy, 5), false, 'a write from before sessions owned writes is left to the human');
});

test('an edit changes a write\'s text or channel in place and keeps its type', () => {
  const post = { id: 'w', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], by: 'n', action: { type: 'post', text: 'Up: {pr.url}' }, stage: 'review', state: 'verified', review: true };
  const job = jobOf(session(), post);
  editWrite(job, post, { action: { text: 'Shipped: {pr.url}' }, ref: '#web-platform' });
  assert.deepEqual([post.action, post.place], [{ type: 'post', text: 'Shipped: {pr.url}' }, { type: 'slack', ref: '#web-platform' }]);
  assert.deepEqual(job.plan.subJobs[1].place, { type: 'slack', ref: '#web-platform' }, 'the plan is the record of the write');
  assert.throws(() => editWrite(job, post, { action: { text: null } }), /a Slack post is its text/);
  assert.throws(() => editWrite(job, post, { ref: null }), /names its channel/);
  assert.throws(() => editWrite(job, post, { on: { sub: 'n', at: 'started' } }), /Unrecognized key/, 'a write has no milestone of its own to move');
});

test('review is the write\'s own say when it has one, else the job\'s default, else off; a reviewed write is drafted before it is made', () => {
  assert.equal(writeReviewed({}, {}), false, 'off by default');
  assert.equal(writeReviewed({ reviewWrites: true }, {}), true);
  assert.equal(writeReviewed({ reviewWrites: true }, { review: false }), false, 'an explicit false overrides the job');
  assert.equal(writeReviewed({ reviewWrites: false }, { review: true }), true, 'a planner-set true holds');
  const n = session();
  const held = write({ id: 'held' }), free = write({ id: 'free', review: false }), made = { id: 'made', kind: 'write', place: { type: 'artifact' }, by: 'n', action: { type: 'make', what: 'A chart' }, stage: 'write', state: 'queued', after: [] };
  const job = { ...jobOf(n, held, free, made), reviewWrites: true };
  assert.deepEqual(openWrites(job, n).map((w) => w.id), ['held', 'free', 'made']);
  assert.deepEqual(toDraft(job, n).map((w) => w.id), ['held'], 'a made output is reviewed once published, never drafted');
  const edited = write({ review: false, state: 'failed', error: 'No' });
  editWrite(jobOf(session(), edited), edited, { action: { to: 'QA' } });
  assert.deepEqual([edited.review, edited.state, edited.error], [false, 'queued', null], 'an edit keeps an explicit false, and a failed write goes back to its session');
});

test('an other place is named, written with one instruction, and briefed with its name', () => {
  const t = pr({ pr: { url: 'https://github.com/o/r/pull/3' } });
  const w = { id: 'lin', kind: 'write', title: 'Link the PR', place: { type: 'other', name: 'Linear', ref: 'ENG-12' }, after: [], by: 'n',
    action: { type: 'write', text: 'Attach {pr.url} to the issue' }, stage: 'write', state: 'queued', why: 'The team tracks it there' };
  const job = jobOf(t, session({ on: { sub: 't', at: 'pr' } }), w);
  assert.equal(placeName(w), 'Linear');
  assert.deepEqual(writeBrief(job, w), { id: 'lin', place: 'other', name: 'Linear', where: 'ENG-12', write: 'write', text: 'Attach https://github.com/o/r/pull/3 to the issue', why: 'The team tracks it there' });
  assert.throws(() => editWrite(job, w, { action: { text: null } }), /say what to write there/);
  editWrite(job, w, { ref: null });
  assert.deepEqual(w.place, { type: 'other', name: 'Linear' }, 'where is optional for another place');
  editWrite(job, w, { name: 'Linear (ENG)' });
  assert.deepEqual([w.place, job.plan.subJobs[2].place.name], [{ type: 'other', name: 'Linear (ENG)' }, 'Linear (ENG)'], 'another place can be renamed');
  const post = { id: 'p', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], by: 'n', action: { type: 'post', text: 'Up' }, stage: 'write', state: 'queued' };
  assert.throws(() => editWrite(jobOf(session(), post), post, { name: 'Somewhere' }), /name/i, 'only another place has a name');
});

test('a create write\'s review edits its story: title and fields on the plan, and the create\'s own title', () => {
  const create = { id: 'create-s', kind: 'write', title: 'Create story: S', place: { type: 'jira' }, storyId: 's', after: [], by: 'n', action: { type: 'create' }, stage: 'review', state: 'verified', review: true };
  const other = write({ storyId: 's' });
  const job = jobOf(session(), create, other);
  job.plan.stories = [{ id: 's', project: 'SEC', title: 'S', fields: [{ name: 'Labels', value: 'a' }] }];
  assert.throws(() => editWrite(job, create, { story: { fields: [{ name: 'Summary', value: 'x' }] } }), /the title is the summary/);
  assert.throws(() => editWrite(job, create, { story: { fields: [{ name: 'Labels', value: 'a' }, { name: 'labels', value: 'b' }] } }), /name each field once/);
  assert.throws(() => editWrite(job, other, { story: { title: 'X' } }), /Only the write that creates a story can edit it/);
  assert.equal(job.plan.stories[0].title, 'S', 'a refused edit changes nothing');
  editWrite(job, create, { story: { title: 'Sign-ins are audited', fields: [{ name: 'Issue Type', value: 'Story' }] } });
  assert.deepEqual(job.plan.stories[0], { id: 's', project: 'SEC', title: 'Sign-ins are audited', fields: [{ name: 'Issue Type', value: 'Story' }] });
  assert.deepEqual([create.title, job.plan.subJobs[1].title], ['Create story: Sign-ins are audited', 'Create story: Sign-ins are audited']);
  assert.deepEqual([create.stage, create.state], ['review', 'verified'], 'still reviewed: it waits for Write');
  editWrite(job, create, { story: { fields: [] } });
  assert.equal('fields' in job.plan.stories[0], false, 'an empty list removes the fields');
});

test('a made output in review is accepted as published, never skipped or reshaped; approve applies its edit atomically', () => {
  const made = { id: 'm', kind: 'write', title: 'Chart', place: { type: 'artifact' }, by: 'n', after: [], action: { type: 'make', what: 'A chart' }, stage: 'review', state: 'verified', review: true,
    result: { outcome: 'written', url: 'https://claude.ai/artifact/1', checks: ['Made it'], at: 1, receiptId: 'run' } };
  const job = jobOf(session({ stage: 'review' }), made);
  job.runs.push({ subJobId: 'n', stopped: false });
  assert.throws(() => skipWrite(made, 2), /already made; drop it instead/);
  assert.throws(() => approveWrite(job, made, 2, { action: { what: 'Another' } }), /already made; accept it or drop it/);
  assert.equal(made.stage, 'review');
  assert.equal(approveWrite(job, made, 2), 'Accepted the output “Chart”');
  assert.deepEqual([made.stage, made.result.url], ['cleanup', 'https://claude.ai/artifact/1']);
  const post = { id: 'w', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, after: [], by: 'n', action: { type: 'post', text: 'Up' }, stage: 'review', state: 'verified', review: true };
  const j2 = jobOf(session(), post);
  j2.runs.push({ subJobId: 'n', stopped: false, parkedAt: 1 });
  assert.throws(() => approveWrite(j2, post, 3, { ref: null }), /names its channel/);
  assert.deepEqual([post.stage, post.writeApprovedAt, post.place.ref], ['review', undefined, '#web']);
  approveWrite(j2, post, 3, { action: { text: 'Shipped' }, review: false });
  assert.deepEqual([post.stage, post.state, post.action.text, post.review, post.writeApprovedAt], ['write', 'approved', 'Shipped', false, 3], 'approved under a parked session, for it to make');
});

test('a completed receipt answers for every open write its session owns: one left out is named, and nothing moves', () => {
  const n = session();
  const ticket = write({ id: 'ticket', action: { type: 'create' }, storyId: 's', jiraKey: null });
  const page = { id: 'page', kind: 'write', title: 'Page', place: { type: 'confluence', ref: 'WEB › Notes' }, by: 'n', after: [], action: { type: 'create', title: 'Notes', text: 'See {ticket.url}' }, stage: 'write', state: 'queued' };
  const dm = { id: 'dm', kind: 'write', title: 'DM', place: { type: 'slack', ref: '@sam' }, by: 'n', after: [], action: { type: 'post', text: '{page.url} and {ticket.url}' }, stage: 'write', state: 'queued' };
  const job = jobOf(n, ticket, page, dm);
  job.plan.stories = [{ id: 's', project: 'SEC', title: 'S' }];
  job.plan.jiraSite = 'https://x.atlassian.net';
  const run = { id: 'run1', subJobId: 'n' };
  assert.throws(() => applyWrites(job, run, n, { writes: [{ id: 'ticket', outcome: 'written', key: 'SEC-9' }] }, 1), /still missing: page, dm/);
  assert.equal(ticket.stage, 'write', 'a refused receipt changes nothing');
  assert.throws(() => applyWrites(job, run, n, { writes: [{ id: 'ticket', outcome: 'written' }, { id: 'page', outcome: 'written', url: 'https://c/p' }, { id: 'dm', outcome: 'written', url: 'https://s/1' }] }, 1), /report the key/);
  assert.throws(() => applyWrites(job, run, n, { writes: [{ id: 'stranger', outcome: 'written' }] }, 1), /not one of the writes this session makes/);
  applyWrites(job, run, n, { writes: [{ id: 'ticket', outcome: 'written', key: 'SEC-9' }, { id: 'page', outcome: 'written', url: 'https://c/p' }, { id: 'dm', outcome: 'failed', error: 'channel_not_found' }] }, 1);
  assert.deepEqual([ticket.stage, ticket.jiraKey, job.plan.stories[0].key], ['cleanup', 'SEC-9', 'SEC-9']);
  assert.equal(page.result.text, 'See https://x.atlassian.net/browse/SEC-9', 'a link to a write made in the same receipt records where it went');
  assert.deepEqual([dm.state, dm.error], ['failed', 'channel_not_found']);
});

test('drafts: exactly the reviewed writes, laid on as edits; the run parks until each is decided, and a failed write reopens its session', () => {
  const n = session();
  const post = { id: 'post', kind: 'write', title: 'Announce', place: { type: 'slack', ref: '#web' }, by: 'n', after: [], action: { type: 'post', text: 'Planned text' }, stage: 'write', state: 'queued', review: true };
  const move = write({ id: 'move', review: true });
  const free = write({ id: 'free', action: { type: 'comment', comment: 'Hi' } });
  const job = jobOf(n, post, move, free);
  const run = { id: 'run1', subJobId: 'n', stopped: false };
  job.runs.push(run);
  assert.throws(() => applyWrites(job, run, n, { writes: [] }, 1), /Review is on for post, move: report them as kind:"drafts" first/);
  assert.throws(() => applyDrafts(job, run, n, { drafts: [{ id: 'post', text: 'x' }] }, 1), /still missing: move/);
  assert.throws(() => applyDrafts(job, run, n, { drafts: [{ id: 'free', comment: 'x' }, { id: 'post' }, { id: 'move' }] }, 1), /free is not a reviewed write of yours/);
  assert.throws(() => applyDrafts(job, run, n, { drafts: [{ id: 'post', where: 'not a channel\nreally' }, { id: 'move' }] }, 1), /Slack|channel|line/i);
  applyDrafts(job, run, n, { drafts: [{ id: 'post', text: 'Shipped the page' }, { id: 'move', to: 'In Review', comment: 'Ready' }] }, 2);
  assert.deepEqual([post.stage, post.action.text, post.draft.text, move.action], ['review', 'Shipped the page', 'Shipped the page', { type: 'transition', to: 'In Review', comment: 'Ready' }]);
  assert.deepEqual([run.parkedAt, run.drafts], [2, ['post', 'move']]);
  assert.equal(draftsDecided(job, run), false);
  approveWrite(job, post, 3, { action: { text: 'Shipped the page today' } });
  assert.equal(draftsDecided(job, run), false, 'one still waits');
  skipWrite(move, 4);
  assert.equal(draftsDecided(job, run), true);
  assert.deepEqual(writeBrief(job, post), { id: 'post', place: 'slack', where: '#web', write: 'post', text: 'Shipped the page today', approved: true });
  run.mailedAt = 5;
  assert.equal(draftsDecided(job, run), false, 'told once');
  applyWrites(job, run, n, { writes: [{ id: 'post', outcome: 'failed', error: 'not_in_channel' }, { id: 'free', outcome: 'written' }] }, 6);
  run.stopped = true; n.stage = 'review';
  reopenWrite(job, post);
  assert.deepEqual([post.state, post.error, n.stage], ['approved', null, 'session'], 'retrying it sends its session back to make it, still approved');
  n.stage = 'done'; post.state = 'failed'; post.error = 'again';
  reopenWrite(job, post);
  assert.deepEqual([post.state, n.stage, n.state, n.writesOnly], ['approved', 'session', 'queued', { from: 'done' }], 'a finished session runs again for its writes alone');
  n.stage = 'done'; delete n.writesOnly; n.cancelledAt = 7; post.state = 'failed'; post.error = 'again';
  assert.throws(() => reopenWrite(job, post), /Its session was dropped/);
});

test('a session that creates a story does not wait for its key; one that only uses it does', () => {
  const create = write({ id: 'mk', jiraKey: undefined, action: { type: 'create' } });
  const link = write({ id: 'cm', jiraKey: undefined, action: { type: 'comment', comment: 'Preview attached' } });
  const job = jobOf(session(), create, link);
  job.plan.stories[0].key = undefined;
  assert.equal(awaitsKeys(job, job.subJobs[0]), false, 'it makes the ticket first');
  assert.equal(writeBrief(job, link).ticket, 'the ticket mk creates');
  assert.equal(writeBrief(job, link).story, undefined, 'a comment is not a story to create');
  job.subJobs[1].by = 'other';
  assert.equal(awaitsKeys(job, job.subJobs[0]), true, 'another session owns the create');
});
