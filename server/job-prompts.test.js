import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobPrompt, historyLines, HISTORY_MAX_LINES, draftsDecidedMail } from './job-prompts.js';

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
    assert.match(text, /Blocked: \{kind:"blocked", summary:"one sentence"\}/, phase);
    // A step's escalation is drawn as a card: its ask heads it, the summary's first sentence under it.
    if (phase !== 'planning') assert.match(text, /kind:"escalate".*`ask` is the one decision you need, as a question.*Commands and hashes go in tried/, phase);
  }
});

test('the implementation prompt is one bounded step: context once, the brief, what it lands after, and the sub-job\'s history', () => {
  const withNote = { ...planned, moves: [{ id: 'mv1', at: Date.now(), subJobId: 'api', move: 'request-change', note: 'Call the flag sign_in_v2', detail: 'Sent “Deliver api” back to work' }] };
  const text = jobPrompt(withNote, { ...briefed, check: 'Sign-in works in dev', note: 'Call the flag sign_in_v2' }, run);
  assert.match(text, /^AUTH-1 · Sign-in$/m);
  assert.match(text, /Context: The sign-in service is Java/);
  assert.match(text, /This PR \(repo\): Retry the token exchange once/);
  assert.match(text, /Check after it lands: Sign-in works in dev/);
  assert.match(text, /After: Sync the proto\./);
  assert.match(text, /History of this sub-job, oldest first:\n- \d\d:\d\d human requested changes: "Call the flag sign_in_v2"/);
  assert.doesNotMatch(text, /worktree already holds the work/, 'a note with no earlier run promises nothing about the tree');
  assert.match(text, /Leave every change UNCOMMITTED/);
  assert.match(text, /When the working tree is ready to review, job_report \{runId:"run1", kind:"ready", checks:\["what you verified", \{text:"<a Show me item, verbatim>"/);
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
    { id: 'r2', subJobId: 'api', phase: 'publish', model: 'opus', startedAt: at(19), stopped: true, report: { kind: 'blocked', summary: 'git add of config/example.env was denied' } },
    { id: 'r3', subJobId: 'api', phase: 'publish', model: 'sonnet', startedAt: at(30), stopped: true, error: 'Session stopped without a receipt. Open it to see why, then retry.' },
    { id: 'r4', subJobId: 'api', phase: 'publish', startedAt: at(40), stopped: false, report: null },
    { id: 'other', subJobId: 'web', phase: 'implementation', model: 'opus', startedAt: at(1), stopped: true, report: { kind: 'ready', checks: ['Built'] } },
  ], moves: [
    { id: 'm1', at: at(18), subJobId: 'api', move: 'approve-code', note: null, detail: 'Approved the working tree of “Deliver api”' },
    { id: 'm2', at: at(23), subJobId: 'api', move: 'retry', note: 'example.env is a template, stage it', detail: 'Retried “Deliver api”' },
    { id: 'm3', at: at(35), subJobId: 'api', move: 'approve-replan', note: null, detail: 'Changed the plan: 1 edited' },
    { id: 'm4', at: at(2), subJobId: 'web', move: 'retry', note: 'not mine', detail: 'Retried “Deliver web”' },
  ] };
  const body = historyLines(job, briefed, { id: 'r4', phase: 'publish' }, at(41));
  assert.deepEqual(body, [
    '- 17:02 implementation · opus → ready: Tests pass · Lint clean',
    '- 17:20 human approved the working tree',
    '- 17:21 publish · opus → blocked: git add of config/example.env was denied',
    '- 17:25 human retried: "example.env is a template, stage it"',
    '- 17:32 publish · sonnet → Session stopped without a receipt. Open it to see why, then retry.',
    '- 17:37 human changed the plan: 1 edited',
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
  const block = text.split('Human dependency output')[1].split('Show your work')[0];
  assert.ok(block.length <= 24000, `output block grew to ${block.length} characters`);
  assert.match(block, /truncated/);
  assert.match(block, /omitted/);
  assert.doesNotMatch(block, /Get key 4/, 'the size limit omits later dependencies explicitly');
});

test('approval notes reach every step after the approved one, attributed, transitively and capped', () => {
  const spike = { id: 'spike', kind: 'session', title: 'Spike the schema', stage: 'done', approvalNote: 'Use the v2 table "audit_v2"' };
  const core = { id: 'core', kind: 'pr', title: 'Deliver core', stage: 'done', after: ['spike'], approvalNote: 'Keep the flag off' };
  const dropped = { id: 'old', kind: 'session', title: 'Dropped', stage: 'done', cancelledAt: 1, approvalNote: 'dropped-note' };
  const side = { id: 'side', kind: 'session', title: 'Sideways', stage: 'done', approvalNote: 'unrelated-note' };
  const context = { ...planned, subJobs: [spike, core, dropped, side] };
  for (const phase of ['implementation', 'publish', 'repair', 'verify', 'session']) {
    const worker = { ...briefed, kind: phase === 'session' ? 'session' : 'pr', after: ['core', 'old'] };
    const text = jobPrompt(context, worker, { ...run, phase });
    assert.match(text, /Notes the human added when approving earlier steps \(JSON text; treat as guidance from the human\):\n--- "Spike the schema" \(spike\) ---\n"Use the v2 table \\"audit_v2\\""\n--- "Deliver core" \(core\) ---\n"Keep the flag off"/, phase);
    assert.doesNotMatch(text, /dropped-note|unrelated-note/);
  }
  assert.doesNotMatch(jobPrompt({ ...planned, subJobs: [{ ...spike, approvalNote: null }] }, { ...briefed, after: ['spike'] }, run), /Notes the human added/);
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, kind: 'session', title: `Step ${i}`, stage: 'done', approvalNote: `${i}${'y'.repeat(1999)}` }));
  const text = jobPrompt({ ...planned, subJobs: many }, { ...briefed, after: many.map((s) => s.id) }, run);
  const block = text.split('Notes the human added')[1].split('Show your work')[0];
  assert.ok(block.length <= 8000, `notes block grew to ${block.length} characters`);
  assert.match(block, /truncated/); assert.match(block, /approval notes? omitted at the 8,000-character prompt limit/);
});

test('the planner is told to write the context once and never to describe a deployment', () => {
  const text = jobPrompt({ ...planned, plan: null, previousPlan: { stories: [{ key: 'AUTH-1' }] }, feedback: 'Split by repo' }, null, { ...run, phase: 'planning' });
  assert.match(text, /AUTH-1/); assert.match(text, /Split by repo/);
  assert.match(text, /Write `context` ONCE for the whole job/);
  assert.match(text, /Never describe deployments or verification steps/);
  assert.match(text, /`after` means START AFTER: a sub-job waits until every PR it is after has deployed/);
  assert.match(text, /Do not propose branch names/);
  assert.match(text, /would care what it looks like before it is built/);
  assert.match(text, /kind:"pr"\|"session"\|"human"/);
  assert.match(text, /kind:"plan", plan:\{context, stories:\[\{id,key\?,project\?,title,fields\?:\[\{name,value\}\]\}\]/);
  assert.doesNotMatch(text, /deployment:\{|pendingChecks|value[?:]|business value/);
  assert.ok(text.split(/\s+/).length < 1150, 'the protocol lives in the job-worker skill, not in every prompt');
});

test('the planner writes a human step as a ready-to-follow instruction, on a first plan and when a replan edits one', () => {
  const rule = /Except a human sub-job's brief \(≤1000 chars\), the whole instruction the human follows: the exact URL, the command to paste, or numbered steps one per line, with real names, ids and settings looked up READ-ONLY \(never invented\), then how they know it is done\. Never vague intent/;
  assert.match(jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' }), rule);
  const replanned = jobPrompt({ ...planned, subJobs: [], replan: { text: 'Add the vendor sign-off' } }, null, { ...run, phase: 'planning' });
  assert.match(replanned, rule); assert.match(replanned, /A human sub-job you add or whose brief you edit follows the human-brief rule above/);
});

test('the planner is told stories are optional, and a ticketless sub-job is told to name its branch without a key', () => {
  const text = jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' });
  assert.match(text, /Stories are optional/); assert.match(text, /never an invented one/);
  assert.match(text, /storyId\?,jiraKey\?/, 'the receipt shape marks both as optional');
  const ticketless = jobPrompt({ ...job, reviewCode: false }, { ...briefed, jiraKey: undefined, worktree: { branch: 'job-12345678-api' } }, run);
  assert.match(ticketless, /has no Jira ticket, so use the convention's ticketless form/); assert.doesNotMatch(ticketless, /Jira key is|undefined|null/);
});

test('the planner proposes writes to the places the outcome produces, each owned by a session, and returns each project\'s workflow, writing nothing itself', () => {
  const text = jobPrompt({ ...planned, plan: null }, null, { ...run, phase: 'planning' });
  assert.match(text, /kind:"pr"\|"session"\|"human"\|"write"/); assert.match(text, /on\?:\{sub,at\},place\?:\{type,ref\?,name\?\},action\?,by\?,review\?,why\?/);
  assert.match(text, /made by the session sub-job named in by:"<session id>"/);
  assert.match(text, /ONE session, three writes, in order/); assert.match(text, /a job of only writes is one or a few sessions/);
  assert.match(text, /A write due at a milestone gets a small session with on:\{sub, at\}/); assert.match(text, /"started", "pr", "merged", "deployed".*"dropped"/);
  assert.match(text, /workflows:\{PROJECT:\[statuses in order\]\}/); assert.match(text, /jiraSite/);
  assert.match(text, /write NOTHING/); assert.match(text, /each with a short `why`/); assert.match(text, /sessions make every write/);
  assert.match(text, /slack \(ref "#channel"\): \{type:"post", text\}/); assert.match(text, /confluence .*\{type:"create", title, text\?\}/);
  assert.match(text, /A session whose deliverable is something it makes \(artifact, doc, page, file, diagram, writeup\) owns a make write for each/);
  assert.match(text, /its link returns in `outputs` as a link, never as a URL in receipt text/);
  assert.doesNotMatch(text, /design writeup \(a make write\)/, 'the mock-up line is one case of the general rule, not the only one');
  assert.match(text, /\{type:"make", what:"one line"\}/); assert.match(text, /\{<write id>\.url\} of a write made first by the same session or one it is after/);
  assert.match(text, /Writes are unreviewed unless review:true, which you set only where risky \(public, hard to undo\), overriding the job default; its session drafts it for the human first/);
  assert.match(jobPrompt({ ...planned, plan: null, reviewWrites: true }, null, { ...run, phase: 'planning' }), /Writes are reviewed unless review:false; set review:true only where risky/);
  assert.match(text, /No place above fits\? place:\{type:"other", name:"Linear", ref\?\}: \{type:"write", text:"one instruction"\} or a make/); assert.match(text, /A step that only posts or announces is a write \(below\) made by a session/);
  assert.match(text, /recent stories READ-ONLY and return as `fields` \[\{name, value\}\] every field they usually fill/);
  assert.match(text, /Never invent a value; its create write sets them\./);
  assert.doesNotMatch(text, /These fire on|batch/);
});

test('a session is given every write it owns, filled from its trigger, with the read-first rules for those places only', () => {
  const trigger = { id: 'api', kind: 'pr', title: 'Deliver api', stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/7' } };
  const session = { id: 'notify', kind: 'session', title: 'Tell Jira', brief: 'Move the ticket and file the audit story', after: [], on: { sub: 'api', at: 'pr' }, stage: 'session' };
  const writes = [
    { id: 'w1', kind: 'write', place: { type: 'jira' }, title: 'AUTH-1 → In Review', storyId: 'story', jiraKey: 'AUTH-1', by: 'notify', stage: 'write', state: 'queued', action: { type: 'transition', to: 'In Review', comment: 'PR: {pr.url} ({pr.title}) {deploy.run}' }, why: 'Team uses In Review for open PRs' },
    { id: 'w2', kind: 'write', place: { type: 'jira' }, title: 'Create', storyId: 'new', by: 'notify', stage: 'write', state: 'approved', action: { type: 'create' }, writeApprovedAt: 1 },
    { id: 'w3', kind: 'write', place: { type: 'jira' }, title: 'Someone else\'s', storyId: 'story', jiraKey: 'AUTH-1', by: 'other', stage: 'write', state: 'queued', action: { type: 'comment', comment: 'later' } },
    { id: 'w4', kind: 'write', place: { type: 'jira' }, title: 'Already made', storyId: 'story', jiraKey: 'AUTH-1', by: 'notify', stage: 'done', action: { type: 'comment', comment: 'made' } },
  ];
  const j = { ...planned, plan: { ...planned.plan, stories: [...planned.plan.stories, { id: 'new', project: 'SEC', title: 'Audit sign-ins', fields: [{ name: 'Issue Type', value: 'Story' }, { name: 'Components', value: 'Auth' }] }], workflows: { AUTH: ['To Do', 'In Review', 'Done'] } },
    subJobs: [trigger, session, ...writes] };
  const text = jobPrompt(j, session, { ...run, phase: 'session' });
  assert.match(text, /READ THE PLACE FIRST/); assert.doesNotMatch(text, /Slack post:|Confluence create:/, 'only the rules for the places it writes to'); assert.match(text, /Never move a ticket backwards unless the write says approved:true/);
  assert.match(text, /"AUTH":\["To Do","In Review","Done"\]/);
  assert.match(text, /"comment":"PR: https:\/\/github.com\/org\/repo\/pull\/7 \(Deliver api\) \(not available\)"/);
  assert.match(text, /"story":"Audit sign-ins","project":"SEC","fields":\[\{"name":"Issue Type","value":"Story"\},\{"name":"Components","value":"Auth"\}\]/);
  assert.match(text, /setting every one of its `fields`/); assert.match(text, /A field Jira will not take is a failed write/); assert.match(text, /"approved":true/);
  assert.match(text, /"why":"Team uses In Review/);
  assert.doesNotMatch(text, /w3|"later"|w4|"made"/, 'only its own writes still to make');
  assert.match(text, /kind:"completed", checks:\["what you did and how you know"\], writes:\[\{id, outcome:"written"\|"already"\|"failed", url\?, key\?, from\?, title\?, error\?\}\] for every write above/);
  assert.doesNotMatch(text, /kind:"drafts"/, 'nothing reviewed, nothing to draft');
});

test('a session links a page it makes first by its own hand, a page another session made by its URL, and is told never to post twice', () => {
  const report = { id: 'report', kind: 'session', title: 'Write the incident review', stage: 'done' };
  const page = { id: 'page', kind: 'write', place: { type: 'confluence', ref: 'WEB › Incidents' }, title: 'Incident page', by: 'report', action: { type: 'make', what: 'Incident review page' },
    stage: 'done', result: { outcome: 'written', url: 'https://x.atlassian.net/wiki/spaces/WEB/pages/1' } };
  const notify = { id: 'notify', kind: 'session', title: 'Announce', brief: 'Announce it', after: ['report'], stage: 'session' };
  const summary = { id: 'summary', kind: 'write', place: { type: 'confluence', ref: 'WEB › Notes' }, title: 'Summary', by: 'notify', stage: 'write', state: 'queued', action: { type: 'create', title: 'Summary', text: 'See {page.url}' } };
  const post = { id: 'post', kind: 'write', place: { type: 'slack', ref: '#web-platform' }, title: 'Announce', by: 'notify', stage: 'write', state: 'queued', action: { type: 'post', text: 'Review: {page.url} · summary {summary.url}' } };
  const text = jobPrompt({ ...planned, subJobs: [report, page, notify, summary, post] }, notify, { ...run, phase: 'session' });
  assert.match(text, /"text":"Review: https:\/\/x.atlassian.net\/wiki\/spaces\/WEB\/pages\/1 · summary \{summary\.url\} \(the URL of write summary, which you make first: put it here yourself\)"/);
  assert.match(text, /Order them so a write that links another of yours \(\{<id>\.url\}\) comes after it/);
  assert.match(text, /Slack post: read the recent messages in channel `where`/); assert.match(text, /report "already" with its permalink/);
  assert.match(text, /Confluence create: look under `where`/);
  assert.doesNotMatch(text, /Jira create:|Workflow statuses/, 'no Jira rules for a session without a Jira write');
});

test('a session drafts its reviewed writes and waits for mail; the mail carries the final text and which were skipped', () => {
  const session = { id: 'notify', kind: 'session', title: 'Announce', brief: 'Announce it', after: [], stage: 'session' };
  const post = { id: 'post', kind: 'write', place: { type: 'slack', ref: '#web' }, title: 'Announce', by: 'notify', stage: 'write', state: 'queued', review: true, action: { type: 'post', text: 'Shipped' } };
  const dm = { id: 'dm', kind: 'write', place: { type: 'slack', ref: '@sam' }, title: 'DM', by: 'notify', stage: 'write', state: 'queued', action: { type: 'post', text: 'FYI' } };
  const j = { ...planned, subJobs: [session, post, dm] };
  const text = jobPrompt(j, session, { ...run, phase: 'session' });
  assert.match(text, /Review is on for post: do NOT make it yet/);
  assert.match(text, /job_report \{runId:"run1", kind:"drafts", drafts:\[\{id, text\?, title\?, to\?, comment\?, where\?, fields\?\}\]\}/);
  assert.match(text, /mail will tell you which to make/);
  const decided = { ...j, subJobs: [session, { ...post, action: { type: 'post', text: 'Shipped today' }, stage: 'write', state: 'approved', writeApprovedAt: 2 }, dm,
    { id: 'skip', kind: 'write', place: { type: 'slack', ref: '#x' }, by: 'notify', stage: 'cleanup', result: { outcome: 'skipped' }, action: { type: 'post', text: 'no' } }] };
  const mail = draftsDecidedMail(decided, { id: 'run1', subJobId: 'notify', drafts: ['post', 'skip'] });
  assert.match(mail, /Make these now, exactly as given here/); assert.match(mail, /"text":"Shipped today","approved":true/);
  assert.match(mail, /Do not make: skip \(skipped or dropped\)/);
  assert.match(mail, /job_report \{runId:"run1", kind:"completed".*for post, dm\}/);
});

test('a session is told the outputs it must make and to account for every write in its receipt', () => {
  const session = { id: 'report', kind: 'session', title: 'Measure p95', brief: 'Measure checkout p95', after: [], stage: 'session' };
  const make = (id, type, what, extra = {}) => ({ id, kind: 'write', place: { type }, title: what, by: 'report', action: { type: 'make', what }, stage: 'write', state: 'queued', ...extra });
  const subs = [session, make('chart', 'artifact', 'p95 chart by endpoint'), make('k6', 'file', 'k6 HTML report'), make('old', 'url', 'Done already', { stage: 'done' })];
  const text = jobPrompt({ ...planned, subJobs: subs }, session, { ...run, phase: 'session' });
  assert.match(text, /- chart: p95 chart by endpoint — a Claude artifact; publish it and give its claude.ai link/);
  assert.match(text, /- k6: k6 HTML report — a local file; save it outside this scratch workspace and give its absolute path/);
  assert.doesNotMatch(text, /Done already/, 'an output already made is not asked for again');
  assert.doesNotMatch(text, /READ THE PLACE FIRST/, 'nothing to read first when it only makes outputs');
  assert.match(text, /writes:\[\{id, outcome:"written"\|"already"\|"failed", url\?.*\] for every write above/);
  assert.doesNotMatch(jobPrompt({ ...planned, subJobs: [session] }, session, { ...run, phase: 'session' }), /writes:\[/, 'a session with nothing to write is asked for none');
});

test('a PR\'s own base overrides the job\'s in its prompts, and the planner is told when to set one', () => {
  const unreviewed = { ...job, reviewCode: false, base: 'next' };
  const own = { ...sub, base: 'release/2.x' };
  assert.match(jobPrompt(unreviewed, own, run), /This PR \(repo, landing on release\/2\.x\)/);
  assert.match(jobPrompt(unreviewed, own, run), /--base release\/2\.x` \(this PR lands on release\/2\.x/);
  assert.match(jobPrompt({ ...job, reviewCode: false }, own, run), /--base release\/2\.x/, 'with no job base too');
  const planning = jobPrompt(job, null, { ...run, phase: 'planning' });
  assert.match(planning, /set `base:"<branch>"` on each PR that is meant to land elsewhere than the repository's default branch/);
  assert.match(planning, /Do not leave that intent in prose only/);
  assert.match(planning, /git ls-remote --heads origin/);
  assert.match(planning, /Never invent a branch name/);
  const overridden = jobPrompt({ ...job, base: 'next' }, null, { ...run, phase: 'planning' });
  assert.match(overridden, /elsewhere than `next`/);
  assert.match(overridden, /the human set it for the whole job; keep it unless a PR clearly needs another/);
});

test('a job with a base tells the planner and the publisher; one without is unchanged', () => {
  const unreviewed = { ...job, reviewCode: false };
  const based = { ...unreviewed, base: 'next' };
  assert.doesNotMatch(jobPrompt(unreviewed, sub, run), /--base|landing on/);
  assert.doesNotMatch(jobPrompt(job, null, { ...run, phase: 'planning' }), /lands on the branch/);
  assert.match(jobPrompt(based, null, { ...run, phase: 'planning' }), /Every PR in this job lands on the branch `next`/);
  assert.match(jobPrompt(based, sub, run), /open the PR with `gh pr create --base next`/);
  assert.match(jobPrompt(based, sub, run), /This PR \(repo, landing on next\)/);
  assert.match(jobPrompt(based, sub, { ...run, phase: 'publish' }), /gh pr create --base next/);
  const open = { ...sub, pr: { url: 'https://github.com/org/repo/pull/1' } };
  assert.doesNotMatch(jobPrompt(based, open, { ...run, phase: 'repair' }), /--base/, 'a repair pushes to the existing PR');
  assert.doesNotMatch(jobPrompt(based, open, run), /gh pr create/);
});

test('Code on Auto with Show me items asks for proof and a ready receipt, but never for a review: publish follows at once', () => {
  const shown = { ...briefed, show: ['Lists sign-ins'] };
  const auto = jobPrompt({ ...planned, reviewCode: false }, shown, run);
  assert.match(auto, /Code is on Auto, so nobody reviews it: your proof is kept on the step and a later step commits and pushes it straight after your receipt and opens the PR/);
  assert.match(auto, /When the work is done and every Show me item is proven, job_report \{runId:"run1", kind:"ready"/);
  assert.match(auto, /Stop everything you started before you report/);
  assert.doesNotMatch(auto, /ready to review|the human reviews|stays open, paused|running\?:/);
  const reviewed = jobPrompt(planned, shown, run);
  assert.match(reviewed, /When the working tree is ready to review, job_report/);
  assert.match(reviewed, /the human reviews the working tree before anything is committed/);
});
