import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobPrompt, historyLines, HISTORY_MAX_LINES } from './job-prompts.js';

// The prompt half of agent-wrangler's job-runtime.test.js (`job-system` branch).
// It never touched a SessionManager — the prompts are pure functions of the
// store — so it ports unchanged apart from the model label: an extension cannot reach the agent
// adapters' `models` table, so a run's model is printed raw (job-prompts.js
// TODO(host-api agents:read)) where core printed "Opus 5".
const job = { id: 'job_12345678', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], agent: 'claude', model: '', taskId: null, plan: { stories: [] } };
const run = { id: 'run1', phase: 'implementation' };
const sub = { id: 'api', repo: '/repo', jiraKey: 'AUTH-1' };
// One shared context, briefs that lean on it, and a second sub-job so the
// "After" line has something to name.
const planned = {
  ...job,
  plan: { context: 'The sign-in service is Java; deploys are Helm.', stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }], subJobs: [] },
  subJobs: [{ id: 'proto', title: 'Sync the proto', kind: 'pr' }],
};
const briefed = { ...sub, title: 'Deliver api', brief: 'Retry the token exchange once', after: ['proto'], worktree: { branch: 'fix/AUTH-1-api' } };

test('the implementer is told to name its placeholder branch in the repo\'s convention via name_branch, and to keep a name it already gave', () => {
  // The rename happens where the branch reaches origin: the implementation
  // session when it publishes itself, the publish session under code review.
  const unreviewed = { ...job, reviewCode: false };
  assert.doesNotMatch(jobPrompt(job, { ...sub, worktree: { branch: 'job-12345678-api' } }, run), /placeholder|name_branch/, 'a reviewed implementation neither pushes nor renames');
  const fresh = jobPrompt(unreviewed, { ...sub, worktree: { branch: 'job-12345678-api' } }, run);
  assert.match(fresh, /job-12345678-api\) is a placeholder/); assert.match(fresh, /branch-naming convention/); assert.match(fresh, /Jira key is AUTH-1/);
  assert.match(fresh, /name_branch MCP tool \(never git branch -m\)/);
  assert.match(jobPrompt(unreviewed, sub, run), /is a placeholder/, 'a sub-job whose worktree is not yet recorded is still told to rename');
  const named = jobPrompt(job, { ...sub, worktree: { branch: 'fix/AUTH-1-deliver-api' } }, { ...run, phase: 'publish' });
  assert.match(named, /branch is fix\/AUTH-1-deliver-api; keep it/); assert.doesNotMatch(named, /is a placeholder/);
  assert.match(jobPrompt(job, { ...sub, worktree: { branch: 'job-12345678-api' } }, { ...run, phase: 'publish' }), /is a placeholder/, 'publish repeats it: that is where the name reaches origin');
  assert.doesNotMatch(jobPrompt(job, null, { ...run, phase: 'planning' }), /For every PR sub-job propose branch|{key}/);
  assert.match(jobPrompt(job, null, { ...run, phase: 'planning' }), /Do not propose branch names/);
});

test('every phase ends with its own receipt call, naming this run and the blocked shape', () => {
  for (const phase of ['planning', 'jira', 'implementation', 'publish', 'repair', 'verify', 'session']) {
    const text = jobPrompt(planned, { ...briefed, pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abc123' }, check: 'Sign-in works in dev' }, { ...run, phase });
    assert.match(text, /job_report \{runId:"run1"/, phase);
    assert.match(text, /Blocked: \{kind:"blocked", summary:"one sentence", move\?:"fix-here"/, phase);
  }
});

test('the implementation prompt is one bounded step: context once, the brief, what it lands after, and the sub-job\'s history', () => {
  const withNote = { ...planned, moves: [{ id: 'mv1', at: Date.now(), subJobId: 'api', move: 'fix-here', note: 'Call the flag sign_in_v2', detail: 'Sent “Deliver api” back to work' }] };
  const text = jobPrompt(withNote, { ...briefed, check: 'Sign-in works in dev', note: 'Call the flag sign_in_v2' }, run);
  assert.match(text, /^AUTH-1 · Sign-in$/m);
  assert.match(text, /Context: The sign-in service is Java/);
  assert.match(text, /This PR \(repo\): Retry the token exchange once/);
  assert.match(text, /Check after it lands: Sign-in works in dev/);
  assert.match(text, /After: Sync the proto\./);
  assert.match(text, /History of this sub-job, oldest first:\n- \d\d:\d\d human requested changes: "Call the flag sign_in_v2"/);
  assert.doesNotMatch(text, /worktree already holds the work/, 'a note with no earlier run promises nothing about the tree');
  assert.match(text, /Leave every change UNCOMMITTED/);
  assert.match(text, /When the working tree is ready to review, job_report \{runId:"run1", kind:"ready", checks:\["what you verified"\]\}/);
  assert.doesNotMatch(text, /kind:"published"|Commit, push/, 'under code review nothing reaches origin from this session');
  const unreviewed = jobPrompt({ ...planned, reviewCode: false }, { ...briefed, check: 'Sign-in works in dev' }, run);
  assert.match(unreviewed, /Commit, push, open the PR, then job_report \{runId:"run1", kind:"published", url:"<PR url>"\}/);
  assert.doesNotMatch(unreviewed, /UNCOMMITTED|kind:"ready"/);
  const publish = jobPrompt(planned, briefed, { ...run, phase: 'publish' });
  assert.match(publish, /^AUTH-1 · Sign-in$/m); assert.match(publish, /Context: The sign-in service is Java/);
  assert.match(publish, /This PR \(repo\): Retry the token exchange once/);
  assert.match(publish, /reviewed the uncommitted changes in this worktree and approved them as they stand/);
  assert.match(publish, /Do not change the code/);
  assert.match(publish, /branch is fix\/AUTH-1-api; keep it/);
  assert.match(publish, /Commit, push, open the PR, then job_report \{runId:"run1", kind:"published", url:"<PR url>"\}/);
  const plainest = jobPrompt(planned, { ...briefed, after: [] }, run);
  assert.match(plainest, /After: none\./);
  assert.doesNotMatch(plainest, /Check after it lands|History of this sub-job/, 'nothing to say is nothing written');
});

test('a relaunched step reads what already happened: every earlier run with its model and receipt, every human intervention with its note, oldest first', () => {
  const t0 = new Date('2026-09-15T17:02:00').getTime();
  const at = (min) => t0 + min * 60000;
  const job = { ...planned, agent: 'claude', runs: [
    { id: 'r1', subJobId: 'api', phase: 'implementation', model: 'opus', startedAt: at(0), stopped: true, report: { kind: 'ready', checks: ['Tests pass', 'Lint clean'] } },
    { id: 'r2', subJobId: 'api', phase: 'publish', model: 'opus', startedAt: at(19), stopped: true, report: { kind: 'blocked', summary: 'git add of config/example.env was denied', move: 'fix-here' } },
    { id: 'r3', subJobId: 'api', phase: 'publish', model: 'sonnet', startedAt: at(30), stopped: true, error: 'Session stopped without a receipt. Open it to see why, then retry.' },
    { id: 'r4', subJobId: 'api', phase: 'publish', startedAt: at(40), stopped: false, report: null },
    { id: 'other', subJobId: 'web', phase: 'implementation', model: 'opus', startedAt: at(1), stopped: true, report: { kind: 'ready', checks: ['Built'] } },
  ], moves: [
    { id: 'm1', at: at(18), subJobId: 'api', move: 'approve-code', note: null, detail: 'Approved the working tree of “Deliver api”' },
    { id: 'm2', at: at(23), subJobId: 'api', move: 'retry', note: 'example.env is a template, stage it', detail: 'Retried “Deliver api”' },
    { id: 'm3', at: at(35), subJobId: 'api', move: 'reorder', note: null, detail: 'Now lands after “Sync the proto”' },
    { id: 'm4', at: at(2), subJobId: 'web', move: 'retry', note: 'not mine', detail: 'Retried “Deliver web”' },
  ] };
  const body = historyLines(job, briefed, { id: 'r4', phase: 'publish' }, at(41));
  assert.deepEqual(body, [
    '- 17:02 implementation · opus → ready: Tests pass · Lint clean',
    '- 17:20 human approved the working tree',
    '- 17:21 publish · opus → blocked: git add of config/example.env was denied',
    '- 17:25 human retried: "example.env is a template, stage it"',
    '- 17:32 publish · sonnet → Session stopped without a receipt. Open it to see why, then retry.',
    '- 17:37 human now lands after “Sync the proto”',
  ]);
  const text = jobPrompt(job, briefed, { ...run, id: 'r4', phase: 'publish' });
  assert.match(text, /History of this sub-job, oldest first:\n- (?:\d{1,2} \w+ )?\d\d:\d\d implementation · opus → ready: Tests pass · Lint clean\n/);
  assert.match(text, /The worktree already holds the work above\. Pick up from the last line; do not redo or re-verify/);
  assert.doesNotMatch(text, /Built|not mine/, 'a sibling sub-job\'s history is not this worker\'s');
  for (const phase of ['implementation', 'repair', 'verify']) {
    assert.match(jobPrompt(job, { ...briefed, pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abc' }, check: 'x' }, { ...run, id: 'r4', phase }), /History of this sub-job/, phase);
  }
  // Legacy runs carry no model at all.
  const legacy = historyLines({ ...job, runs: [{ id: 'r0', subJobId: 'api', phase: 'implementation', startedAt: at(0), stopped: true, report: { kind: 'ready', checks: ['x'] } },
    { id: 'r5', subJobId: 'api', phase: 'publish', model: 'retired-model', startedAt: at(1), stopped: true, report: { kind: 'published', url: 'https://github.com/org/repo/pull/9' } }], moves: [] }, briefed, run, at(2));
  assert.deepEqual(legacy, ['- 17:02 implementation → ready: x', '- 17:03 publish · retired-model → published: https://github.com/org/repo/pull/9']);
  // Long histories keep the newest lines; one spanning days says which day.
  const many = { ...job, moves: [], runs: Array.from({ length: 13 }, (_, i) => ({ id: `x${i}`, subJobId: 'api', phase: 'implementation', startedAt: at(i), stopped: true, report: { kind: 'blocked', summary: `attempt ${i}` } })) };
  const capped = historyLines(many, briefed, run, at(20));
  assert.equal(capped.length, HISTORY_MAX_LINES + 1);
  assert.equal(capped[0], '- … 3 earlier'); assert.match(capped.at(-1), /attempt 12$/);
  const spanning = historyLines({ ...job, moves: [], runs: [job.runs[0]] }, briefed, run, at(24 * 60));
  assert.match(spanning[0], /^- 15 Sept? 17:02 implementation/);
});

test('a repair carries the human\'s note when there is one, and the checks otherwise', () => {
  const pr = { url: 'https://github.com/org/repo/pull/7' };
  const asked = jobPrompt(planned, { ...briefed, pr, fixRequested: { note: 'Rename the flag' } }, { ...run, phase: 'repair' });
  assert.match(asked, /Fix PR https:\/\/github.com\/org\/repo\/pull\/7 on this worktree branch: the human asks: Rename the flag/);
  const failing = jobPrompt(planned, { ...briefed, pr }, { ...run, phase: 'repair' });
  assert.match(failing, /failing checks, merge conflicts or requested changes/);
  for (const text of [asked, failing]) assert.match(text, /Never weaken checks; never merge/);
});

test('a verify session exists only for the plan\'s one check, and stays off production data', () => {
  const verify = jobPrompt(planned, { ...briefed, check: 'Expired links are rejected', pr: { url: 'u', mergeCommit: 'abc123' },
    deploymentResult: { runs: [{ workflow: 'Deploy', status: 'passing' }, { workflow: 'Scan', status: 'skipped' }] } }, { ...run, phase: 'verify' });
  assert.match(verify, /merged as abc123; post-merge runs passed \(Deploy\)/);
  assert.match(verify, /Confirm: Expired links are rejected/);
  assert.match(verify, /Never modify production data/);
  assert.match(verify, /playground or dev/);
  assert.match(verify, /Do not change the deployment/);
});

test('the session prompt keeps its step out of every repository and carries a review\'s feedback', () => {
  const text = jobPrompt({ ...planned, subJobs: [{ id: 'spike', kind: 'session', title: 'Spike the schema' }] },
    { id: 'backfill', kind: 'session', jiraKey: 'AUTH-1', brief: 'Backfill the audit rows', after: ['spike'], feedback: 'Also check staging' },
    { ...run, phase: 'session' });
  const revised = jobPrompt({ ...planned, subJobs: [{ id: 'spike', kind: 'session', title: 'Spike the schema' }],
    runs: [{ id: 'r0', subJobId: 'backfill', phase: 'session', model: 'opus', startedAt: Date.now() - 60000, stopped: true, report: { kind: 'completed', checks: ['Rows backfilled in dev'] } }],
    moves: [{ id: 'mv1', at: Date.now(), subJobId: 'backfill', move: 'revise-session', note: 'Also check staging', detail: 'Requested changes on “Backfill”' }] },
  { id: 'backfill', kind: 'session', jiraKey: 'AUTH-1', brief: 'Backfill the audit rows', after: ['spike'], feedback: 'Also check staging' },
  { ...run, phase: 'session' });
  assert.match(text, /This session: Backfill the audit rows/);
  assert.match(text, /After: Spike the schema\./);
  assert.match(text, /no repository changes \(report blocked if one is needed\)/);
  assert.doesNotMatch(text, /History of this sub-job/, 'a first attempt has no history');
  assert.match(revised, /session · opus → completed: Rows backfilled in dev\n- \d\d:\d\d human requested changes: "Also check staging"\nPick up from the last line; do not redo what an earlier session reported\./);
  assert.doesNotMatch(revised, /worktree/, 'a session sub-job has no worktree to speak of');
  assert.match(text, /kind:"completed"/);
});

test('the planner is told to write the context once and never to describe a deployment', () => {
  const text = jobPrompt({ ...planned, plan: null, previousPlan: { stories: [{ key: 'AUTH-1' }] }, feedback: 'Split by repo' }, null, { ...run, phase: 'planning' });
  assert.match(text, /AUTH-1/); assert.match(text, /Split by repo/);
  assert.match(text, /Write `context` ONCE for the whole job/);
  assert.match(text, /Never describe deployments or verification steps/);
  assert.match(text, /`after` on a PR means DEPLOY AFTER/);
  assert.match(text, /Do not propose branch names/);
  assert.match(text, /kind:"pr"\|"session"/);
  assert.match(text, /kind:"plan", plan:\{context, stories:\[\{id,key\?,project\?,title\}\]/);
  assert.doesNotMatch(text, /deployment:\{|pendingChecks|value/);
  assert.ok(text.split(/\s+/).length < 450, 'the protocol lives in the job-worker skill, not in every prompt');
});

test('the planner is told stories are optional, and a ticketless sub-job is told to name its branch without a key', () => {
  const text = jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' });
  assert.match(text, /Stories are optional/); assert.match(text, /never an invented one/);
  assert.match(text, /storyId\?,jiraKey\?/, 'the receipt shape marks both as optional');
  const ticketless = jobPrompt({ ...job, reviewCode: false }, { ...briefed, jiraKey: undefined, worktree: { branch: 'job-12345678-api' } }, run);
  assert.match(ticketless, /has no Jira ticket, so use the convention's ticketless form/); assert.doesNotMatch(ticketless, /Jira key is|undefined|null/);
});

test('the ticketing prompt creates exactly the approved titles', () => {
  const text = jobPrompt(planned, null, { ...run, phase: 'jira' });
  assert.match(text, /"key":"AUTH-1"/);
  assert.match(text, /Search first so a retry never duplicates one/);
  assert.match(text, /kind:"jira", stories:\[\{id,key\}\]/);
});
