import { z } from 'zod';
import path from 'node:path';

export const line = z.string().trim().min(1).max(180).refine((s) => !/[\r\n]/.test(s), 'Use one short line');
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const jira = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const jiraProject = z.string().regex(/^[A-Z][A-Z0-9]*$/);
export const prUrlSchema = z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/);
const repoPath = z.string().trim().min(1).max(1000).refine(
  (s) => !/[\r\n\0]/.test(s) && (path.isAbsolute(s) || s.startsWith('~/')),
  'Use an absolute local repository path or ~/path',
);
export const checksSchema = z.array(line).min(1).max(8);
export const briefSchema = z.string().trim().min(1).max(500);
// A sub-job is one of four kinds. A PR changes a repository. An agent session
// runs on this machine in a scratch workspace and is finished when its receipt
// is accepted. A human task is the rare step no agent can take at all (a click
// in somebody's console, a vendor, a signature): no repo, no receipt, no agent
// ever launched for it — it waits on the board until the human marks it done.
// A write is ONE write to one place outside the board (a Jira ticket, a Slack
// channel, a Confluence page, something a session makes: an artifact, a local
// file, a web page; or any other place an agent can reach, named). A milestone write fires when another sub-job
// reaches a milestone (`on`) and is made by a short agent session that batches
// every write falling due on the same tick; a `make` write is an output its
// session (`by`) must produce and report (job-writes.js).
// None of the non-PR kinds has a repo. Every `after` gates the dependent's
// START: a PR's once it has deployed, an agentless one's once done.
//
// Nothing here describes deployment or verification: the runner infers whether a
// merge deploys from the repository's own workflows (job-deploys.js) and watches
// whatever GitHub starts. `check` is the one line a pipeline cannot prove — and
// only on a PR, because a session's receipt IS its check and a human task has
// no pipeline to outlast.
//
// A PR sub-job names no branch: the plan cannot know a repository's convention
// as well as the session working inside it, so the worktree starts on a
// placeholder (`job-runtime.js`) and the implementer renames it via
// `name_branch` (`job-store.js` `noteBranchRename` keeps the record in step).
//
// `storyId` is optional: work nobody tracks in Jira (personal tooling, a repo
// with no project) has no story, so it never waits for a ticket and its branch
// and commits carry no key. Only a sub-job that NAMES a story is held until
// that story has a key (`awaitsTicket`) — and the story's key is minted by the
// one Jira write that creates it.
export const MILESTONES = ['started', 'pr', 'merged', 'deployed', 'dropped'];
export const PLACE_TYPES = ['jira', 'slack', 'confluence', 'artifact', 'file', 'url', 'other'];
// What each place can be asked for. `make` is never the batched writer's: the
// session the write hangs under produces it and reports where it is. `other` is
// any place no preset covers (a Linear issue, a Notion page, a Google Sheet),
// named by the planner: its `write` is one free-text instruction the writer
// carries out with whatever MCP or CLI reaches that place.
export const PLACE_ACTIONS = { jira: ['create', 'transition', 'comment'], slack: ['post', 'make'], confluence: ['create', 'comment', 'make'],
  artifact: ['make'], file: ['make'], url: ['make'], other: ['write', 'make'] };
export const WRITE_ACTIONS = [...new Set(Object.values(PLACE_ACTIONS).flat())];
export const commentSchema = z.string().trim().min(1).max(2000);
// Where a made output or a written post lives: a web URL, or an absolute local
// path for a file (which the board cannot open, only show).
export const placeLinkSchema = z.string().trim().min(1).max(2000).refine(
  (s) => !/[\r\n\0]/.test(s) && /^(https?:\/\/\S+|\/|~\/)/.test(s), 'Give an http(s) URL or an absolute path');
export const placeNameSchema = z.string().trim().min(1).max(60).refine((s) => !/[\r\n]/.test(s), 'Use one short line');
export const placeSchema = z.object({ type: z.enum(PLACE_TYPES), ref: z.string().trim().min(1).max(500).refine((s) => !/[\r\n]/.test(s), 'Use one line').optional(),
  name: placeNameSchema.optional() });
// `to`/`comment` are Jira's; `text` is a Slack post, a Confluence comment or an
// `other` write's instruction; `title` a Confluence page's; `what` one line
// saying what a made output is.
export const writeActionSchema = z.object({ type: z.enum(WRITE_ACTIONS), to: line.optional(), comment: commentSchema.optional(),
  text: commentSchema.optional(), title: line.optional(), what: line.optional() });
export const triggerSchema = z.object({ sub: id, at: z.enum(MILESTONES) });
export const subJobSchema = z.object({
  id, title: line, kind: z.enum(['pr', 'session', 'human', 'write']).default('pr'), repo: repoPath.optional(),
  storyId: id.optional(), jiraKey: jira.optional(), after: z.array(id).max(30).default([]),
  brief: briefSchema.optional(), check: line.optional(),
  // A write's own fields. `review` is tri-state (`writeReviewed`): true or
  // false is this write's own say, absent is the job's `reviewWrites`. On
  // stops in the review stage until the human says Write (a made output: after
  // it is published, until Accept); off writes and shows a receipt.
  place: placeSchema.optional(), action: writeActionSchema.optional(), on: triggerSchema.optional(), by: id.optional(),
  review: z.boolean().optional(), why: line.optional(),
});
export const isSessionSub = (sub) => sub?.kind === 'session';
export const isHumanSub = (sub) => sub?.kind === 'human';
export const isWriteSub = (sub) => sub?.kind === 'write';
export const placeOf = (sub) => isWriteSub(sub) ? sub.place?.type || 'jira' : null;
export const isJiraWrite = (sub) => placeOf(sub) === 'jira';
export const isMakeWrite = (sub) => isWriteSub(sub) && sub.action?.type === 'make';
export const isStoryCreate = (sub) => isJiraWrite(sub) && sub.action?.type === 'create';
// An explicit `false` is kept, never collapsed to absent: it is what overrides a
// job whose default is to review every write.
export const writeReviewed = (job, sub) => sub?.review ?? job?.reviewWrites ?? false;
// A PR is the only kind with a repository, a pipeline and a deploy gate,
// so "not a PR" — not "is a session" — is what every one of those rules turns on.
export const isPrSub = (sub) => !isSessionSub(sub) && !isHumanSub(sub) && !isWriteSub(sub);
// The write that creates a story is what gives it a key, so it is the one
// sub-job naming a keyless story that never waits for one.
export const awaitsTicket = (sub) => !!sub?.storyId && !sub?.jiraKey && !isStoryCreate(sub);
// {pr.url}, {pr.title} and {deploy.run} come from the trigger; {<write id>.url}
// is another write's result (a page a session made, a ticket a create minted).
export const WRITE_REF = /\{([a-zA-Z0-9_-]{1,64})\.url\}/g;
export const writeRefs = (sub) => [...`${sub.action?.comment || ''} ${sub.action?.text || ''}`.matchAll(WRITE_REF)].map(([, ref]) => ref).filter((ref) => ref !== 'pr');
// With code review on, a PR sub-job's implementation session leaves the working
// tree UNCOMMITTED and reports `ready`; the human reads the diff on the board
// and approval launches a `publish` session that commits, pushes and opens the
// PR. Off, one session does all of it. Read through this helper: a job created
// before the flag existed has no field and reviews like a new one.
export const reviewCode = (job) => job?.reviewCode ?? true;
// The one line every PR description and squash commit a job lands must end with.
export const ATTRIBUTION = 'Made with Agent Wrangler and the charlie-ps/wrangler-squared extension';
// A story either already exists in Jira (key) or is a proposal (no key, optional
// project hint). Planning never writes to Jira: the human approves the titles,
// their mapping to sub-jobs and every proposed write first, and a keyless story
// is created by its own `create` write (`withStoryCreates` adds one wherever a
// plan lacks it). A plan may have no stories at all: then nothing is written.
// `fields` are what that write fills in beyond the summary (the title), read by
// the planner off the project's recent stories so a created ticket looks like
// the team's own: name as Jira labels it. They are reviewed with that write,
// like any other (edit-write `story`), not with the plan.
export const storyFieldSchema = z.object({ name: line, value: z.string().trim().min(1).max(2000) });
export const storySchema = z.object({ id, key: jira.optional(), project: jiraProject.optional(), title: line,
  fields: z.array(storyFieldSchema).max(25).optional() });
// Read by the planner from Jira, project by project, in workflow order: the
// board offers exactly these statuses for a write, so it needs no Jira client
// and a typo can never reach Jira.
export const workflowsSchema = z.record(jiraProject, z.array(line).max(40)).default({});
export const storyProject = (story) => story?.key ? story.key.split('-')[0] : story?.project || null;
const freeId = (taken, base) => { if (!taken.has(base)) return base; let n = 2; while (taken.has(`${base}-${n}`)) n++; return `${base}-${n}`; };
// The old ticketing stage folded into the plan: every keyless story is created
// by exactly one write, due on approval (and reviewed then, if it is reviewed). Pure; returns the same plan when
// nothing was missing.
export function withStoryCreates(plan) {
  const missing = plan.stories.filter((t) => !t.key && !plan.subJobs.some((s) => isStoryCreate(s) && s.storyId === t.id));
  if (!missing.length) return plan;
  const taken = new Set(plan.subJobs.map((s) => s.id));
  const creates = missing.map((t) => {
    const sid = freeId(taken, `create-${t.id}`.slice(0, 58)); taken.add(sid);
    return { id: sid, title: `Create story: ${t.title}`.slice(0, 180).trim(), kind: 'write', place: { type: 'jira' }, storyId: t.id, after: [], action: { type: 'create' } };
  });
  return { ...plan, subJobs: [...creates, ...plan.subJobs] };
}
export const planSchema = z.object({
  // Written once for the whole job, the way a human writes a dispatch: every
  // brief refers to it rather than repeating the background, which is what keeps
  // a brief inside its 500 characters.
  context: z.string().trim().max(2000),
  stories: z.array(storySchema).max(30).default([]),
  workflows: workflowsSchema,
  // The Jira site the planner read, so a ticket on the board links to it.
  jiraSite: z.string().trim().regex(/^https:\/\/[^\s/]+\/?$/, 'Give the site root, e.g. https://x.atlassian.net').max(200).optional(),
  subJobs: z.array(subJobSchema).min(1).max(80),
}).superRefine((plan, ctx) => {
  const stories = new Set(plan.stories.map((s) => s.id));
  const nodes = new Map(plan.subJobs.map((s) => [s.id, s]));
  const issue = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (stories.size !== plan.stories.length || nodes.size !== plan.subJobs.length) issue('IDs must be unique');
  for (const s of plan.subJobs) {
    if (isSessionSub(s) && s.repo) issue(`${s.id}: a session sub-job has no repo`);
    if (isSessionSub(s) && s.check) issue(`${s.id}: a session sub-job's receipt is its own check`);
    if (isHumanSub(s) && s.repo) issue(`${s.id}: a human sub-job has no repo`);
    if (isHumanSub(s) && s.check) issue(`${s.id}: a human sub-job has nothing to check after it lands`);
    if (isPrSub(s) && !s.repo) issue(`${s.id}: a PR sub-job needs repo`);
    if (!isWriteSub(s) && !s.brief) issue(`${s.id}: brief is required`);
    if (!isWriteSub(s) && (s.action || s.on || s.by || s.place)) issue(`${s.id}: only a write has a place, an action or a trigger`);
    for (const dep of s.after) if (isWriteSub(nodes.get(dep))) issue(`${s.id}: nothing waits on a write (${dep})`);
    if (isWriteSub(s)) writeRules(s, plan, nodes, issue);
  }
  const visiting = new Set(), visited = new Set();
  function visit(s) {
    if (visiting.has(s.id)) { issue('Dependency chains must not contain cycles'); return; }
    if (visited.has(s.id)) return;
    visiting.add(s.id);
    for (const dep of s.after) {
      if (!nodes.has(dep)) issue(`Unknown dependency: ${dep}`);
      else visit(nodes.get(dep));
    }
    visiting.delete(s.id); visited.add(s.id);
  }
  for (const t of plan.stories) {
    const names = (t.fields || []).map((f) => f.name.toLowerCase());
    if (new Set(names).size !== names.length) issue(`${t.id}: name each field once`);
    if (names.includes('summary')) issue(`${t.id}: the title is the summary`);
  }
  for (const s of plan.subJobs) {
    if (s.storyId && !stories.has(s.storyId)) issue(`Unknown story: ${s.storyId}`);
    visit(s);
  }
});
// A Jira write names its ticket through a story, so the key it writes to is the
// one the human approved (or the one its own create write mints). A milestone a
// trigger can never reach is refused here rather than waited on forever, and a
// made output names the session that makes it.
function writeRules(s, plan, nodes, issue) {
  const a = s.action;
  const type = placeOf(s);
  if (s.repo) issue(`${s.id}: a write has no repo`);
  if (s.check) issue(`${s.id}: a write has nothing to check after it lands`);
  if (s.after.length) issue(`${s.id}: a write fires on a milestone (on) or is made by a session (by), not after`);
  if (!a) { issue(`${s.id}: a write needs an action`); return; }
  if (!PLACE_ACTIONS[type].includes(a.type)) issue(`${s.id}: a ${type} write can ${PLACE_ACTIONS[type].join(', ')}, not ${a.type}`);
  if (type === 'jira') jiraRules(s, plan, issue);
  else {
    if (s.storyId || s.jiraKey) issue(`${s.id}: only a Jira write names a story`);
    if (a.to || a.comment) issue(`${s.id}: only a Jira write moves a ticket or comments on one`);
  }
  if (type === 'other' && !s.place?.name) issue(`${s.id}: name the place (place.name)`);
  if (type !== 'other' && s.place?.name) issue(`${s.id}: only an other place is named; a ${type} place is its type`);
  if (a.type === 'write' && a.title) issue(`${s.id}: a write to another place is one instruction (text)`);
  if (a.type === 'write' && !a.text) issue(`${s.id}: say what to write there (action.text)`);
  if (type === 'slack' && !s.place?.ref) issue(`${s.id}: a Slack write names its channel (place.ref)`);
  if (['artifact', 'file', 'url'].includes(type) && s.place?.ref) issue(`${s.id}: a ${type} is made by its session, so it has no ref`);
  if (a.type === 'post' && (!a.text || a.title)) issue(`${s.id}: a Slack post is its text`);
  if (type === 'confluence' && a.type === 'create' && (!a.title || !s.place?.ref)) issue(`${s.id}: a Confluence page needs a title and where it goes (place.ref)`);
  if (type === 'confluence' && a.type === 'comment' && (!a.text || !s.place?.ref)) issue(`${s.id}: a Confluence comment needs its text and the page (place.ref)`);
  if (a.type === 'make') {
    if (!a.what) issue(`${s.id}: say in one line what the session makes (action.what)`);
    if (a.to || a.comment || a.text || a.title) issue(`${s.id}: the session decides what a made output says; give only what it is`);
    if (s.on) issue(`${s.id}: a made output comes with its session (by), not on a milestone`);
    if (!s.by) issue(`${s.id}: a made output names the session that makes it (by)`);
    else if (!isSessionSub(nodes.get(s.by))) issue(`${s.id}: ${s.by} is not a session sub-job, so it cannot make it`);
  } else {
    if (a.what) issue(`${s.id}: only a made output has a what`);
    if (s.by) issue(`${s.id}: only a made output names a session (by); a write fires on a milestone (on)`);
  }
  for (const ref of writeRefs(s)) {
    if (!isWriteSub(nodes.get(ref))) issue(`${s.id}: {${ref}.url} names no write in this plan`);
    else if (ref === s.id) issue(`${s.id}: a write cannot link to itself`);
  }
  if (!s.on) return;
  const trigger = nodes.get(s.on.sub);
  if (!trigger) issue(`${s.id}: unknown trigger ${s.on.sub}`);
  else if (trigger === s || isWriteSub(trigger)) issue(`${s.id}: a write fires on a PR, session or human sub-job`);
  else if (!isPrSub(trigger) && ['pr', 'merged'].includes(s.on.at)) issue(`${s.id}: ${s.on.sub} opens no PR, so it is never ${s.on.at === 'pr' ? 'opened' : 'merged'}`);
}
function jiraRules(s, plan, issue) {
  const a = s.action;
  if (s.place?.ref) issue(`${s.id}: a Jira write names its ticket through its story, not a ref`);
  if (!s.storyId) issue(`${s.id}: a Jira write names the story it writes to`);
  if (a.text || a.title) issue(`${s.id}: a Jira write moves the ticket (to) or comments on it (comment)`);
  if (a.type === 'create' && (a.to || a.comment || s.on)) issue(`${s.id}: creating a story is the whole write, made on approval`);
  if (a.type === 'create' && plan.subJobs.some((o) => o !== s && isStoryCreate(o) && o.storyId === s.storyId)) issue(`${s.id}: a story is created once`);
  if (a.type === 'transition' && !a.to) issue(`${s.id}: a transition needs a status to move to`);
  if (a.type === 'comment' && (!a.comment || a.to)) issue(`${s.id}: a comment write posts a comment and moves nothing`);
}
// A name the wrangler minted (paste-<ms>-<hex>.<ext>), never a path.
export const MAX_IMAGES = 8;
const imageName = z.string().regex(/^paste-\d{1,20}-[a-f0-9]{4,32}\.(?:png|jpg|gif|webp)$/);
export const jobInputSchema = z.object({
  title: line.optional(), intent: z.string().trim().min(1).max(16000),
  repos: z.array(repoPath).max(30).default([]),
  agent: z.enum(['claude', 'codex']).default('claude'), model: z.string().max(150).default(''),
  effort: z.string().max(40).default(''),
  planningPrompt: z.string().max(8000).default(''),
  reviewPlan: z.boolean().default(true), reviewCode: z.boolean().default(true), reviewMerge: z.boolean().default(true), reviewSessions: z.boolean().default(true),
  // The default for a write with no `review` of its own (`writeReviewed`).
  reviewWrites: z.boolean().default(false),
  updateMain: z.boolean().default(false), taskId: z.string().nullable().default(null),
  // Names of images the job keeps in the host's per-extension store (`images:keep`),
  // already staged by the client's `api.images.stage`. `shareImages` decides whether
  // sub-job sessions get them too; planning always does.
  images: z.array(imageName).max(MAX_IMAGES).default([]), shareImages: z.boolean().default(true),
});
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(8),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  // How long a merged sub-job may wait for a post-merge workflow to show ANY run
  // on the merge commit before the board flags it (job-runner.js).
  deploymentStaleMinutes: z.number().int().min(5).max(1440).default(30),
  paused: z.boolean().default(false),
  // The macOS application "Review code in …" hands a sub-job's worktree to
  // (`open -na <ideApp> --args <path>`, server/handlers.js). An app NAME, not a
  // command: nothing typed here ever reaches a shell.
  ideApp: z.string().trim().min(1).max(120).default('IntelliJ IDEA'),
  // The agent/model/effort the last created job used: New job's picker opens on it
  // while the catalog still offers that model. Same bounds as the job's own fields.
  usualPick: z.object({
    agent: z.enum(['claude', 'codex']), model: z.string().max(150), effort: z.string().max(40).default(''),
  }).nullable().default(null),
});
// A worker never changes the plan: `move` is a SUGGESTION on a blocked receipt,
// which the board offers the human as the pre-selected button (job-moves.js).
export const MOVE_NAMES = ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark', 'accept-red'];
// Strict, so a receipt carrying a field this system no longer has (an
// `amendment`, a `commitMessage`) fails loudly with the offending key rather
// than being silently stripped — the agent can then correct and retry, exactly
// as it does for a rejected Jira key.
const receipt = (shape) => z.object(shape).strict();
// `already`: the ticket was at or past the target, so nothing moved (a comment
// is still posted), or the post or page was already there. `failed` carries the
// place's own error, verbatim. `url` is the permalink to what was written.
export const WRITE_OUTCOMES = ['written', 'already', 'failed'];
export const writeResultSchema = z.object({ id, outcome: z.enum(WRITE_OUTCOMES), key: jira.optional(), from: line.optional(),
  url: z.string().trim().regex(/^https:\/\/\S+$/, 'Give the https permalink').max(2000).optional(),
  checks: checksSchema.optional(), error: z.string().trim().min(1).max(500).optional() }).strict();
// What a session made, one per make write it was given: where it is, or why not.
export const outputSchema = z.union([z.object({ id, url: placeLinkSchema, title: line.optional() }).strict(), z.object({ id, missing: line }).strict()]);
export const reportSchema = z.discriminatedUnion('kind', [
  receipt({ kind: z.literal('plan'), plan: planSchema }),
  // One result per write the run was given (job-writes.js). `jira` with
  // `stories` is the shape the old ticketing step reported, still accepted from
  // a run that was live when its job was migrated onto create writes.
  receipt({ kind: z.literal('write'), writes: z.array(writeResultSchema).min(1).max(50) }),
  receipt({ kind: z.literal('jira'), stories: z.array(z.object({ id, key: jira })).min(1).max(30) }),
  receipt({ kind: z.literal('ready'), checks: checksSchema }),
  receipt({ kind: z.literal('published'), url: prUrlSchema }),
  receipt({ kind: z.literal('repaired'), changes: checksSchema, checks: checksSchema }),
  receipt({ kind: z.literal('deployed'), checks: checksSchema }),
  receipt({ kind: z.literal('completed'), checks: checksSchema, outputs: z.array(outputSchema).max(30).optional() }),
  receipt({ kind: z.literal('blocked'), summary: line, move: z.enum(MOVE_NAMES).optional() }),
]);
