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
  for (const phase of ['planning', 'write', 'implementation', 'publish', 'repair', 'verify', 'session']) {
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
  for (const text of [unreviewed, publish]) assert.match(text, /End the commit message and the PR description with exactly this line:\nMade with Agent Wrangler and the charlie-ps\/wrangler-squared extension\nCommit, push, open the PR/);
  assert.doesNotMatch(text, /Made with Agent Wrangler/, 'nothing is committed under code review');
  const onOpenPr = jobPrompt(planned, { ...briefed, pr: { url: 'https://github.com/org/repo/pull/1' } }, { ...run, phase: 'publish' });
  assert.match(onOpenPr, /End the commit message with exactly this line[^\n]*\nMade with Agent Wrangler and the charlie-ps\/wrangler-squared extension\nCommit, push to the open PR/);
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

test('PR and session workers receive only direct completed HUMAN dependency output', () => {
  const human = { id: 'key', kind: 'human', title: 'Get public key', stage: 'done', result: { output: 'ssh-ed25519 AAAA user@host\nKeep this line' } };
  const unrelated = { id: 'secret', kind: 'human', title: 'Unrelated', stage: 'done', result: { output: 'unrelated-secret' } };
  const unfinished = { id: 'pending', kind: 'human', title: 'Pending', stage: 'human', result: { output: 'unfinished-secret' } };
  const context = { ...planned, subJobs: [human, unrelated, unfinished] };
  for (const phase of ['implementation', 'publish', 'repair', 'verify', 'session']) {
    const worker = { ...briefed, kind: phase === 'session' ? 'session' : 'pr', after: ['key', 'pending'] };
    const text = jobPrompt(context, worker, { ...run, phase });
    assert.match(text, /Human dependency output/);
    assert.match(text, /Get public key/);
    assert.match(text, /ssh-ed25519 AAAA user@host\\nKeep this line/);
    assert.doesNotMatch(text, /unrelated-secret|unfinished-secret/);
  }
  assert.doesNotMatch(jobPrompt(context, { ...briefed, after: [] }, run), /Human dependency output/);
});

test('human dependency output is bounded in the prompt with explicit truncation and omission', () => {
  const deps = Array.from({ length: 5 }, (_, i) => ({ id: `key${i}`, kind: 'human', title: `Get key ${i}`, stage: 'done', result: { output: `${i}${'x'.repeat(7999)}` } }));
  const text = jobPrompt({ ...planned, subJobs: deps }, { ...briefed, after: deps.map((d) => d.id) }, run);
  assert.match(text, /Human dependency output/);
  const block = text.split('Human dependency output')[1].split('Leave every change')[0];
  assert.ok(block.length <= 24000, `output block grew to ${block.length} characters`);
  assert.match(block, /truncated/);
  assert.match(block, /omitted/);
  assert.doesNotMatch(block, /Get key 4/, 'the size limit omits later dependencies explicitly');
});

test('the planner is told to write the context once and never to describe a deployment', () => {
  const text = jobPrompt({ ...planned, plan: null, previousPlan: { stories: [{ key: 'AUTH-1' }] }, feedback: 'Split by repo' }, null, { ...run, phase: 'planning' });
  assert.match(text, /AUTH-1/); assert.match(text, /Split by repo/);
  assert.match(text, /Write `context` ONCE for the whole job/);
  assert.match(text, /Never describe deployments or verification steps/);
  assert.match(text, /`after` means START AFTER: a sub-job waits until every PR it is after has deployed/);
  assert.match(text, /Do not propose branch names/);
  assert.match(text, /kind:"pr"\|"session"\|"human"/);
  assert.match(text, /kind:"plan", plan:\{context, stories:\[\{id,key\?,project\?,title,fields\?:\[\{name,value\}\]\}\]/);
  assert.doesNotMatch(text, /deployment:\{|pendingChecks|value[?:]|business value/);
  assert.ok(text.split(/\s+/).length < 800, 'the protocol lives in the job-worker skill, not in every prompt');
});

test('the planner is told stories are optional, and a ticketless sub-job is told to name its branch without a key', () => {
  const text = jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' });
  assert.match(text, /Stories are optional/); assert.match(text, /never an invented one/);
  assert.match(text, /storyId\?,jiraKey\?/, 'the receipt shape marks both as optional');
  const ticketless = jobPrompt({ ...job, reviewCode: false }, { ...briefed, jiraKey: undefined, worktree: { branch: 'job-12345678-api' } }, run);
  assert.match(ticketless, /has no Jira ticket, so use the convention's ticketless form/); assert.doesNotMatch(ticketless, /Jira key is|undefined|null/);
});

test('the planner proposes writes to the places the outcome produces and returns each project\'s workflow, writing nothing itself', () => {
  const text = jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' });
  assert.match(text, /kind:"pr"\|"session"\|"human"\|"write"/); assert.match(text, /place\?:\{type,ref\?,name\?\},action\?,on\?,by\?,review\?,why\?/);
  assert.match(text, /on:\{sub, at\}/); assert.match(text, /"started", "pr", "merged", "deployed".*"dropped"/);
  assert.match(text, /workflows:\{PROJECT:\[statuses in order\]\}/); assert.match(text, /jiraSite/);
  assert.match(text, /write NOTHING/); assert.match(text, /each write with a short `why`/);
  assert.match(text, /slack \(ref "#channel"\): \{type:"post", text\}/); assert.match(text, /confluence .*\{type:"create", title, text\?\}/);
  assert.match(text, /\{type:"make", what:"one line"\} with by:"<session id>"/); assert.match(text, /\{<write id>\.url\}/);
  assert.match(text, /Writes are unreviewed unless review:true, which you set only where risky \(public, hard to undo\): it overrides the job default/);
  assert.match(jobPrompt({ ...planned, plan: null, reviewWrites: true }, null, { ...run, phase: 'planning' }), /Writes are reviewed unless review:false; set review:true only where risky/);
  assert.match(text, /No place above fits\? place:\{type:"other", name:"Linear", ref\?\}: \{type:"write", text:"one instruction"\} or a make/); assert.match(text, /A step that only posts or announces is a write/);
  assert.match(text, /recent stories READ-ONLY and return as `fields` \[\{name, value\}\] every field they usually fill/);
  assert.match(text, /Never invent a value; its create write sets them\./);
});

test('a write run is given exactly its batch, comments filled from the trigger, and the read-first rules', () => {
  const trigger = { id: 'api', kind: 'pr', title: 'Deliver api', stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/7' } };
  const writes = [
    { id: 'w1', kind: 'write', place: { type: 'jira' }, title: 'AUTH-1 → In Review', storyId: 'story', jiraKey: 'AUTH-1', action: { type: 'transition', to: 'In Review', comment: 'PR: {pr.url} ({pr.title}) {deploy.run}' }, on: { sub: 'api', at: 'pr' }, why: 'Team uses In Review for open PRs' },
    { id: 'w2', kind: 'write', place: { type: 'jira' }, title: 'Create', storyId: 'new', action: { type: 'create' }, writeApprovedAt: 1 },
    { id: 'w3', kind: 'write', place: { type: 'jira' }, title: 'Not in this batch', storyId: 'story', jiraKey: 'AUTH-1', action: { type: 'comment', comment: 'later' } },
  ];
  const j = { ...planned, plan: { ...planned.plan, stories: [...planned.plan.stories, { id: 'new', project: 'SEC', title: 'Audit sign-ins', fields: [{ name: 'Issue Type', value: 'Story' }, { name: 'Components', value: 'Auth' }] }], workflows: { AUTH: ['To Do', 'In Review', 'Done'] } },
    subJobs: [trigger, ...writes] };
  const text = jobPrompt(j, null, { ...run, phase: 'write', writes: ['w1', 'w2'] });
  assert.match(text, /READ THE PLACE FIRST/); assert.doesNotMatch(text, /Slack post:|Confluence create:/, 'only the rules for the places in this batch'); assert.match(text, /Never move a ticket backwards unless the write says approved:true/);
  assert.match(text, /"AUTH":\["To Do","In Review","Done"\]/);
  assert.match(text, /"comment":"PR: https:\/\/github.com\/org\/repo\/pull\/7 \(Deliver api\) \(not available\)"/);
  assert.match(text, /"story":"Audit sign-ins","project":"SEC","fields":\[\{"name":"Issue Type","value":"Story"\},\{"name":"Components","value":"Auth"\}\]/);
  assert.match(text, /setting every one of its `fields`/); assert.match(text, /A field Jira will not take is a failed write/); assert.match(text, /"approved":true/);
  assert.match(text, /"because":"Deliver api reached pr"/); assert.match(text, /"why":"Team uses In Review/);
  assert.doesNotMatch(text, /w3|later/, 'only the writes this run was given');
  assert.match(text, /kind:"write", writes:\[\{id, outcome:"written"\|"already"\|"failed", key\?, from\?, url\?/);
});

test('a Slack post links the page a session made through {<write id>.url}, and is told never to post twice', () => {
  const report = { id: 'report', kind: 'session', title: 'Write the incident review', stage: 'done' };
  const page = { id: 'page', kind: 'write', place: { type: 'confluence', ref: 'WEB › Incidents' }, title: 'Incident page', by: 'report', action: { type: 'make', what: 'Incident review page' },
    stage: 'done', result: { outcome: 'written', url: 'https://x.atlassian.net/wiki/spaces/WEB/pages/1' } };
  const post = { id: 'post', kind: 'write', place: { type: 'slack', ref: '#web-platform' }, title: 'Announce', on: { sub: 'report', at: 'deployed' }, action: { type: 'post', text: 'Review: {page.url} · {gone.url}' }, review: true, writeApprovedAt: 1 };
  const text = jobPrompt({ ...planned, subJobs: [report, page, post] }, null, { ...run, phase: 'write', writes: ['post'] });
  assert.match(text, /"place":"slack","where":"#web-platform","write":"post","text":"Review: https:\/\/x.atlassian.net\/wiki\/spaces\/WEB\/pages\/1 · \(not available\)"/);
  assert.match(text, /Slack post: read the recent messages in channel `where`/); assert.match(text, /report "already" with its permalink/);
  assert.doesNotMatch(text, /Jira create:|Workflow statuses/, 'no Jira rules for a batch without a Jira write');
});

test('a session is told the outputs it must make and to account for every one in its receipt', () => {
  const session = { id: 'report', kind: 'session', title: 'Measure p95', brief: 'Measure checkout p95', after: [], stage: 'session' };
  const make = (id, type, what, extra = {}) => ({ id, kind: 'write', place: { type }, title: what, by: 'report', action: { type: 'make', what }, stage: 'write', state: 'queued', ...extra });
  const subs = [session, make('chart', 'artifact', 'p95 chart by endpoint'), make('k6', 'file', 'k6 HTML report'), make('old', 'url', 'Done already', { stage: 'done' })];
  const text = jobPrompt({ ...planned, subJobs: subs }, session, { ...run, phase: 'session' });
  assert.match(text, /- chart: p95 chart by endpoint — a Claude artifact; publish it and give its claude.ai link/);
  assert.match(text, /- k6: k6 HTML report — a local file; save it outside this scratch workspace and give its absolute path/);
  assert.doesNotMatch(text, /Done already/, 'an output already made is not asked for again');
  assert.match(text, /outputs:\[\{id, url, title\?\} or \{id, missing:"one line why"\} for every output above\]/);
  assert.doesNotMatch(jobPrompt({ ...planned, subJobs: [session] }, session, { ...run, phase: 'session' }), /outputs/, 'a session with nothing to make is asked for none');
});
