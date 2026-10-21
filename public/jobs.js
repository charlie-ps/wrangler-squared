import { esc } from './util.js';
import { ICONS, PERSON_ICON, PULL_REQUEST_ICON, ROBOT_ICON, TICKET_ICON, SLACK_ICON, CONFLUENCE_ICON, FILE_ICON, GLOBE_ICON, PIN_ICON } from './icons.js';
export const isSessionSub = (sub) => sub?.kind === 'session';
export const isHumanSub = (sub) => sub?.kind === 'human';
// Mirrors server/jobs-schema.js: a write goes to one place and is made by the
// session it names (`by`); a make write is an output that session decides.
export const isWriteSub = (sub) => sub?.kind === 'write';
export const placeOf = (sub) => isWriteSub(sub) ? sub.place?.type || 'jira' : null;
export const isJiraWrite = (sub) => placeOf(sub) === 'jira';
export const isMakeWrite = (sub) => isWriteSub(sub) && sub.action?.type === 'make';
export const isStoryCreate = (sub) => isJiraWrite(sub) && sub.action?.type === 'create';
// Mirrors server/jobs-schema.js: a write's own `review` wins, else the job's
// default. The board sends an explicit boolean whenever the human toggles one.
export const writeReviewed = (job, sub) => sub?.review ?? job?.reviewWrites ?? false;
// Mirrors server/jobs-schema.js isPrSub: a PR is the only kind with a repository,
// a pipeline and a deploy gate, so "not a PR" is what those rules turn on.
export const isPrSub = (sub) => !isSessionSub(sub) && !isHumanSub(sub) && !isWriteSub(sub);
// Mirrors server/jobs-schema.js targetOf; null is the repository's default.
export const targetOf = (job, sub) => sub?.base || job?.base || null;
// A PR whose own base differs from the job's: the only branch a graph tile shows.
export const offBase = (job, sub) => isPrSub(sub) && !!sub.base && sub.base !== job?.base;
// The stories session never stops for Session results review: its writes are
// its result (server/job-store.js), so it alone does not make the switch matter.
export const reviewedSession = (sub) => isSessionSub(sub) && !sub.stories;
export const hasSessionSubs = (job) => job.subJobs.some(reviewedSession);
// New idea's conversation (mirrors server/job-idea.js). Its stage is the planner's turn
// (`thinking`, also while a reply waits to be mailed) or the human's: a reply to answer,
// or a job it suggests.
export const ideaThread = (job) => job?.idea?.thread || [];
export const inConversation = (job) => !!job?.idea && job.stage === 'planning' && !job.plan && !job.replan && !job.cancelledAt;
// An idea's plate on the board: talked through, or parked in the backlog, until it has a plan.
export const ideaOpen = (job) => !!job?.idea && ['planning', 'backlog'].includes(job.stage) && !job.plan && !job.replan && !job.cancelledAt;
export function liveSuggestion(job) {
  const last = ideaThread(job).at(-1);
  return last?.from === 'planner' && last.suggest && !last.acceptedAt ? last : null;
}
export function ideaStage(job) {
  if (!inConversation(job) || job.error) return null;
  const parked = job.runs.find((r) => !r.stopped && !r.subJobId && r.parkedFor === 'idea' && r.parkedAt && !r.mailedAt);
  if (!parked || ideaThread(job).some((m) => m.from === 'human' && !m.sentAt)) return 'thinking';
  return liveSuggestion(job) ? 'suggested' : 'reply';
}
// Mirrors server/jobs-schema.js reviewCode: a job from before the flag reviews.
export const reviewCode = (job) => job.reviewCode ?? true;
// The six review checkpoints, in the one set of words the New job form, the
// job's flags, the plan dialog and the intro all use: each is named for what you
// review, and each state for who acts. Merge and Writes default off on a stored job.
// `wait`, `yes` and `done` are the footer's words for releasing work already
// waiting at a checkpoint when it is switched to Auto; `unit` is what the next
// gate is reached by.
const several = (n, one, many) => n === 1 ? one : `${n} ${many}`;
export const CHECKPOINTS = [
  { field: 'reviewPlan', icon: 'doc', name: 'Plan', unit: 'plan', you: 'You approve the plan before any ticket, PR or session starts', auto: 'Work starts as soon as the plan is drafted',
    wait: () => 'The plan is waiting for your approval.', yes: () => 'Approve the plan and start', done: () => 'Plan approved, work starting' },
  { field: 'reviewCode', icon: 'code', name: 'Local verification', unit: 'PR', you: 'You see each PR working locally (screenshots, live service, diff) before it’s committed', auto: 'The agent commits and opens the PR without you seeing it run',
    wait: (n) => `${several(n, 'A PR is', 'PRs are')} working locally and waiting for you to verify ${n === 1 ? 'it' : 'them'}.`, yes: (n) => `Commit and open ${several(n, 'the PR', 'PRs')}`, done: (n) => `${several(n, 'The diff is', 'diffs are')} being committed and opened as PRs` },
  { field: 'reviewMerge', icon: 'merge', name: 'Merge', unit: 'PR', you: 'You approve each PR once its checks pass', auto: 'PRs merge once checks pass, unless a reviewer leaves blocking comments',
    wait: (n) => `${several(n, 'A PR has', 'PRs have')} passing checks and ${n === 1 ? 'is' : 'are'} waiting for Approve merge.`, yes: (n) => `Merge ${several(n, 'the PR', 'PRs')}`, done: (n) => `${several(n, 'The PR merges', 'PRs merge')} on the next poll, unless a reviewer leaves blocking comments` },
  { field: 'reviewSessions', icon: 'robot', name: 'Session results', unit: 'session receipt', you: 'You approve each session’s receipt before it counts as done', auto: 'A session counts as done once it reports',
    wait: (n) => `${several(n, 'A session receipt is', 'session receipts are')} waiting for your approval.`, yes: (n) => `Accept ${several(n, 'the receipt', 'receipts')}`, done: (n) => `${several(n, 'The receipt is', 'receipts are')} accepted` },
  { field: 'reviewWrites', icon: 'eye', name: 'Writes', unit: 'write', you: 'Each write to Jira, Slack, Confluence or another place stops for you before it’s made', auto: 'Each write is made by its session, with a receipt',
    wait: (n) => `${several(n, 'A write is', 'writes are')} waiting for your review.`, yes: (n) => `Approve ${several(n, 'the write', 'writes')}`, done: (n) => `${several(n, 'The write is', 'writes are')} approved; each session makes what it drafted` },
  // The one checkpoint in other words: it is not a review but who handles a red step.
  // Nothing waits here to be released, so its switch never asks first.
  { field: 'reviewRed', icon: 'wrench', name: 'Red steps', unit: 'red step', youWord: 'You decide', autoWord: 'Wrangler replans',
    you: 'Wrangler proposes a fix for a red step and waits for you to decide', auto: 'Wrangler replans a red step: it fixes the step, changes the plan (if Plan is on Auto), or declares it red for you',
    wait: () => '', yes: () => '', done: () => '' },
];
export const checkpoint = (field) => CHECKPOINTS.find((c) => c.field === field);
// server/jobs-schema.js REVIEW_DEFAULTS, read key by key so a graph from before
// `settings.reviewDefaults` existed still seeds New job the way it always did.
export const REVIEW_DEFAULTS = { reviewPlan: true, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: false, reviewRed: true };
export const reviewDefaultsOf = (settings) => Object.fromEntries(CHECKPOINTS.map(({ field }) => [field, typeof settings?.reviewDefaults?.[field] === 'boolean' ? settings.reviewDefaults[field] : REVIEW_DEFAULTS[field]]));
export const youReview = (job, field) => field === 'reviewMerge' || field === 'reviewWrites' ? !!job[field] : field === 'reviewCode' ? reviewCode(job) : job[field] ?? true;
export const youWord = (cp) => cp.youWord || 'You review';
export const autoWord = (cp) => cp.autoWord || 'Auto';
export const checkpointLabel = (cp, you) => `${cp.name}: ${you ? youWord(cp) : autoWord(cp)}`;
export const checkpointHint = (cp, you) => you ? cp.you : cp.auto;
// The stage glyph stays readable either way; the fill (amber, the colour the step
// shows while it waits) and the corner badge carry the setting, and the label
// says it in words, so colour is never the only cue.
export const checkpointFlagHtml = (cp, you) => {
  const text = esc(`${checkpointLabel(cp, you)}. ${checkpointHint(cp, you)}`);
  return `<span class="job-flag ${you ? 'you' : 'auto'}" role="img" aria-label="${text}" title="${text}">${ICONS[cp.icon]}<span class="job-flag-badge">${you ? ICONS.hand : ICONS.ff}</span></span>`;
};
// The detail footer's checkpoint is the same tile as a button (aria-pressed is
// You review). A locked one stays focusable, aria-disabled, so its name can say why.
export const checkpointButtonHtml = (cp, you, { lock = null, saving = false } = {}) => {
  const label = checkpointLabel(cp, you);
  const aria = esc(`${label}. ${lock || `Switch to ${you ? autoWord(cp) : youWord(cp)}`}`);
  return `<button type="button" class="job-flag ${you ? 'you' : 'auto'}" data-review="${cp.field}" aria-pressed="${you}" aria-label="${aria}" title="${esc(`${label}. ${checkpointHint(cp, you)}`)}"${lock ? ' aria-disabled="true"' : ''}${saving ? ' aria-busy="true"' : ''}>${ICONS[cp.icon]}<span class="job-flag-badge">${you ? ICONS.hand : ICONS.ff}</span></button>`;
};
// Why a checkpoint can no longer change. Mirrors server/job-store.js setReview,
// plus Writes once no write is left that the job's default still decides (its
// own `review` beats it, and one approved or made is past it): the server would
// take the switch, but nothing would follow from it.
const followsWritesDefault = (w) => isWriteSub(w) && !w.cancelledAt && w.review == null && !w.writeApprovedAt && !['cleanup', 'done'].includes(w.stage);
export function checkpointLock(job, field) {
  if (job.cancelledAt) return 'The job was cancelled: there is nothing left to review';
  if (job.stage === 'done') return 'The job is finished: there is nothing left to review';
  if (field === 'reviewPlan' && !['backlog', 'planning'].includes(job.stage)) return 'The plan is already approved. A replan always waits for you';
  if (field === 'reviewWrites' && !(job.subJobs.length ? job.subJobs : job.plan?.subJobs || []).some(followsWritesDefault)) return 'Every write is made, decided, or has its own review setting';
  return null;
}
// What switching a You review checkpoint to Auto would let through right now,
// which is what the footer asks about before it sends `release`. Mirrors
// server/job-store.js releaseWaiting, plus Merge, which the runner's next poll
// releases on its own once the flag is off.
export function checkpointWaiting(job, field) {
  if (!youReview(job, field) || field === 'reviewRed') return 0;
  if (field === 'reviewPlan') return job.stage === 'planning' && job.plan && !job.runs.some((r) => !r.stopped) ? 1 : 0;
  return job.subJobs.filter((s) => !s.error && (field === 'reviewCode' ? codeAwaitingReview(s) && !s.ready?.approvedAt
    : field === 'reviewMerge' ? s.stage === 'pr' && s.pr?.checkStatus === 'passing' && s.mergeApprovedHead !== s.pr.head && !pendingDependencies(job, s).length
      : field === 'reviewWrites' ? writeAwaitingReview(s) && !s.cancelledAt && s.review !== true
        : isSessionSub(s) && s.stage === 'review' && !!s.result)).length;
}
// One native checkbox (checked is You review), so a click or Space flips it and
// an unchecked box submits nothing, which reads as Auto. The words live in the
// title and the accessible name, both rewritten by whoever handles the change;
// `name` lets the intro's picture keep out of a form's fields.
export const checkpointToggleHtml = (cp, you, name = cp.field) => {
  const text = esc(checkpointLabel(cp, you));
  return `<label class="job-review-toggle" title="${text}"><input type="checkbox" role="switch" name="${esc(name)}" value="you" aria-label="${text}"${you ? ' checked' : ''}><span class="you">${ICONS.hand}</span><span class="auto">${ICONS.ff}</span></label>`;
};
export const syncCheckpointToggle = (input, cp) => {
  const text = checkpointLabel(cp, input.checked);
  input.setAttribute('aria-label', text); input.closest('label').title = text;
};
// A sub-job is one of exactly four kinds, drawn as the same glyph everywhere one
// appears (stepper badge, dependency editor, detail chip) and named only in its
// tooltip: a PR, an agent session on this machine (no PR), a human task, or one
// write to a place outside the board, drawn as that place's glyph.
export const kindClass = (sub) => isSessionSub(sub) ? 'session' : isHumanSub(sub) ? 'human' : isWriteSub(sub) ? 'write' : 'pr';
const KIND_LABEL = { pr: 'PR', session: 'Session', human: 'Human', write: 'Write' };
const KIND_ICON = { pr: PULL_REQUEST_ICON, session: ROBOT_ICON, human: PERSON_ICON };
export const KIND_TITLE = { pr: 'A pull request in a repository', session: 'An agent session on this machine — no pull request',
  human: 'Only you can do this one — no agent, no pull request', write: 'One write to a place outside the board: a ticket, a channel, a page, or something a session makes' };
export const kindLabel = (sub) => KIND_LABEL[kindClass(sub)];
export const kindIconHtml = (sub) => isWriteSub(sub) ? PLACES[placeOf(sub)].icon : KIND_ICON[kindClass(sub)];
export const kindChipHtml = (sub) => `<span class="job-kind ${kindClass(sub)}" role="img" aria-label="${kindLabel(sub)}" title="${KIND_TITLE[kindClass(sub)]}">${kindIconHtml(sub)}</span>`;
// "2 PRs · 1 session · 1 human task" rather than "4 sub-jobs": the count is where
// a reader first learns the mix.
export function kindCountLabel(subJobs) {
  const count = (test, one, many = `${one}s`) => {
    const n = subJobs.filter(test).length;
    return n ? `${n} ${n === 1 ? one : many}` : '';
  };
  return [count(isPrSub, 'PR'), count(isSessionSub, 'session'), count(isHumanSub, 'human task'), count(isWriteSub, 'write')].filter(Boolean).join(' · ');
}

// A session may wait for another sub-job's milestone (`on`), and every write it
// owns with it (server/job-writes.js). Mirrors milestoneReached there, so the
// board says what each waits for.
export const milestoneLabel = (trigger, at) => ({ started: 'started', pr: 'PR opened', merged: 'merged', deployed: isPrSub(trigger) || !trigger ? 'deployed' : 'done', dropped: 'dropped' })[at];
export function milestoneReached(t, at) {
  if (!t) return false;
  if (at === 'dropped') return !!t.cancelledAt;
  if (at === 'started') return (t.sessions || []).length > 0 || !!t.pr || (isHumanSub(t) && t.state === 'doing')
    || (!t.cancelledAt && !!t.stage && !['implementation', 'session', 'human'].includes(t.stage));
  if (at === 'pr') return !!t.pr;
  if (at === 'merged') return !!t.mergedAt || (isPrSub(t) && !!t.deployed);
  return !t.cancelledAt && (isPrSub(t) ? !!t.deployed : ['cleanup', 'done'].includes(t.stage));
}
export const sessionTrigger = (job, sub) => isSessionSub(sub) && sub.on ? job.subJobs?.find((s) => s.id === sub.on.sub) || null : null;
// "When Passkey API merges", "Only if Passkey API is dropped": what starts a
// session with `on`, in the words its node, card and dialog all use.
export function triggerLine(job, sub) {
  if (!isSessionSub(sub) || !sub.on) return '';
  const t = sessionTrigger(job, sub);
  const name = t?.title || sub.on.sub;
  if (sub.on.at === 'dropped') return `Only if ${name} is dropped`;
  return `When ${name} ${{ started: 'starts', pr: 'opens its PR', merged: 'merges', deployed: isPrSub(t) || !t ? 'deploys' : 'is done' }[sub.on.at]}`;
}
// "drafted for you", "by the session": how a write gets made, in the words the
// hanging tile uses (it hangs under its session, so never that session's name).
export function writeWhen(job, sub) {
  if (!sub.by) return 'predates sessions';
  if (isMakeWrite(sub)) return writeReviewed(job, sub) ? 'made, then reviewed' : 'made by the session';
  return writeReviewed(job, sub) ? 'drafted for your review' : 'by the session';
}
// "AUTH-412 → In Review", "Comment on AUTH-412", "Create “Passkey API”",
// "Post in #web", "Make p95 chart": the write's own title.
export function writeTarget(plan, sub) {
  const a = sub.action || {};
  if (a.type === 'make') return `Make ${a.what || PLACES[placeOf(sub)].name.toLowerCase()}`;
  if (placeOf(sub) === 'other') return `Write to ${sub.place?.name || 'somewhere else'}`;
  if (placeOf(sub) === 'slack') return `Post in ${sub.place?.ref || 'Slack'}`;
  if (placeOf(sub) === 'confluence') return a.type === 'create' ? `Create “${a.title || 'page'}”` : 'Comment on the page';
  const story = plan.stories?.find((t) => t.id === sub.storyId);
  const key = sub.jiraKey || story?.key || (story ? storyLabel(story, plan.stories) : 'ticket');
  if (isStoryCreate(sub)) return `Create ${story?.key || `“${story?.title || 'story'}”`}`;
  return sub.action?.to ? `${key} → ${sub.action.to}` : `Comment on ${key}`;
}
// Its trigger was dropped before reaching the milestone: the session can never
// start (an if-dropped one is exactly what a drop starts).
export const triggerDropped = (job, sub) => isSessionSub(sub) && !!sub.on && sub.on.at !== 'dropped' && sub.stage === 'session' && !liveRun(job, sub)
  && !!sessionTrigger(job, sub)?.cancelledAt && !milestoneReached(sessionTrigger(job, sub), sub.on.at);
export const sessionDormant = (job, sub) => isSessionSub(sub) && sub.on?.at === 'dropped' && sub.stage === 'session' && !sessionTrigger(job, sub)?.cancelledAt;
const sessionWaitsOn = (job, sub) => isSessionSub(sub) && !!sub.on && sub.stage === 'session' && !liveRun(job, sub) && !milestoneReached(sessionTrigger(job, sub), sub.on.at);
export const writeSession = (job, sub) => isWriteSub(sub) && sub.by ? job.subJobs?.find((s) => s.id === sub.by) || null : null;
export const writeWaiting = (job, sub) => isWriteSub(sub) && sub.stage === 'write' && ['queued', 'approved'].includes(sub.state) && !sub.error;
export const writeAwaitingReview = (sub) => isWriteSub(sub) && sub.stage === 'review' && !sub.error;
// A session parked on drafts it sent, until every one is decided and it is told
// which to make (server/job-writes.js).
export const parkedRun = (job, sub) => { const run = liveRun(job, sub); return run?.parkedAt && !run.mailedAt && run.parkedFor !== 'ready' ? run : null; };
export const draftsWaiting = (job, sub) => (parkedRun(job, sub)?.drafts || []).map((id) => job.subJobs.find((s) => s.id === id)).filter((w) => writeAwaitingReview(w));
// "→ In Review", "Comment", "Post", "Make": a write in a few words, beside the
// place's glyph that already says where.
export function writeAction(w) {
  const a = w.action || {};
  if (a.type === 'make') return 'Make';
  if (isJiraWrite(w)) return a.type === 'create' ? 'Create' : a.to ? `→ ${a.to}${a.comment ? ' + comment' : ''}` : 'Comment';
  return { post: 'Post', create: 'Create page', comment: 'Comment', write: 'Write' }[a.type] || a.type || 'Write';
}

// What approving a write in review does, in the place's own words; a made
// output is already there, so approving it accepts it.
export function writeVerb(sub) {
  const a = sub.action || {};
  const type = placeOf(sub);
  if (a.type === 'make') return 'Accept';
  if (type === 'jira') return a.type === 'create' ? 'Create in Jira' : a.to ? 'Move in Jira' : 'Comment in Jira';
  if (type === 'other') return `Write to ${placeShort(sub)}`;
  return ({ slack: 'Post to Slack', confluence: a.type === 'create' ? 'Create the page' : 'Comment on the page' })[type] || 'Write';
}

// Where a job writes, outside the board (server/jobs-schema.js PLACE_TYPES):
// a glyph and a name per type, never a brand's logo.
export const PLACES = {
  jira: { name: 'Jira ticket', short: 'Jira', icon: TICKET_ICON }, slack: { name: 'Slack channel', short: 'Slack', icon: SLACK_ICON },
  confluence: { name: 'Confluence page', short: 'Confluence', icon: CONFLUENCE_ICON }, artifact: { name: 'Claude artifact', short: 'Artifact', icon: ICONS.sparkle },
  file: { name: 'Local file', short: 'File', icon: FILE_ICON }, url: { name: 'Web page', short: 'Web page', icon: GLOBE_ICON },
  other: { name: 'Something else', short: 'Elsewhere', icon: PIN_ICON },
};
// What a place is called in a sentence: the human's own name for an `other`.
export const placeShort = (sub) => placeOf(sub) === 'other' ? sub.place?.name || PLACES.other.short : PLACES[placeOf(sub)].short;
// One place per Jira story, Slack channel and Confluence page, and one per
// output a session makes: what folds a node's writes into one pill.
export function placeKey(w) {
  const type = placeOf(w);
  if (type === 'jira') return `jira:${w.storyId || w.jiraKey || w.id}`;
  if (isMakeWrite(w)) return `${type}:${w.id}`;
  if (type === 'confluence' && w.action?.type === 'create') return `confluence:${w.place?.ref || ''}›${w.action.title || w.id}`;
  if (type === 'other') return `other:${(w.place?.name || w.id).toLowerCase()}›${w.place?.ref || ''}`;
  return `${type}:${w.place?.ref || w.id}`;
}
export const webUrl = (s) => /^https?:\/\//.test(s || '') ? s : null;
// A place exists once it has somewhere to open (a result's permalink, a page a
// comment goes to) or, for Jira, a key; a ticket links through the site the
// planner read. The label is short enough for a pill, the name is the whole of it.
export function placeFor(plan, writes) {
  const w = writes[0];
  const type = placeOf(w);
  const story = type === 'jira' ? plan.stories?.find((t) => t.id === w.storyId) : null;
  const key = type === 'jira' ? writes.map((x) => x.jiraKey || x.result?.key).find(Boolean) || story?.key || null : null;
  const latest = writes.filter((x) => x.result?.url).sort((a, b) => (b.result.at || 0) - (a.result.at || 0))[0]?.result;
  const site = (plan.jiraSite || '').replace(/\/$/, '');
  const url = latest?.url || (key && site ? `${site}/browse/${key}` : null) || ((type === 'confluence' && w.action?.type === 'comment') || type === 'other' ? webUrl(w.place?.ref) : null);
  const named = latest?.title || w.action?.title || w.action?.what;
  // An `other` place is the one the human named, whatever is written or made there.
  const label = type === 'jira' ? key || (story ? storyLabel(story, plan.stories) : 'Ticket') : type === 'slack' ? w.place?.ref || 'Slack' : type === 'other' ? placeShort(w) : named || PLACES[type].short;
  const name = type === 'jira' ? [label, story?.title].filter(Boolean).join(' · ') : type === 'slack' ? label
    : type === 'other' ? [label, w.place?.ref].filter(Boolean).join(' · ')
    : [named || PLACES[type].name, type === 'confluence' && w.action?.type !== 'comment' ? w.place?.ref : ''].filter(Boolean).join(' · ');
  return { key: placeKey(w), type, writes, label, name, url, exists: !!url || !!key };
}
// Every place among these writes, in plan order.
export function placesOf(plan, writes) {
  const groups = new Map();
  for (const w of writes) groups.set(placeKey(w), [...(groups.get(placeKey(w)) || []), w]);
  return [...groups.values()].map((g) => placeFor(plan, g));
}
// Statuses the planner read from the story's project workflow (server
// jobs-schema.js `workflows`); empty when it read none.
export function workflowFor(plan, sub) {
  const project = storyProject(plan.stories?.find((t) => t.id === sub.storyId));
  return (project && plan.workflows?.[project]) || [];
}
export const cancelledDependencies = (job, sub) => [...(triggerDropped(job, sub) ? [sub.on.sub] : []), ...sub.after.filter((id) => job.subJobs.find((s) => s.id === id)?.cancelledAt)];
// Mirrors server/job-store.js dependencySatisfied: a PR counts once deployed, a
// session or human task once it reached done.
export const dependencySatisfied = (dep) => isPrSub(dep) ? !!dep?.deployed : dep.stage === 'done' && !dep.cancelledAt;
export const pendingDependencies = (job, sub) => sub.after.map((id) => job.subJobs.find((s) => s.id === id)).filter((d) => !dependencySatisfied(d));
// Mirrors server/job-prompts.js upstreamOf from the other end: an approval note
// is read only by an agent step that has this one in its transitive `after`.
export const noteReaders = (job, sub) => {
  const byId = new Map(job.subJobs.map((s) => [s.id, s]));
  const reaches = (s, seen = new Set()) => (s?.after || []).some((id) => id === sub.id || (!seen.has(id) && seen.add(id) && reaches(byId.get(id), seen)));
  return job.subJobs.filter((s) => s.id !== sub.id && !s.cancelledAt && !isWriteSub(s) && !isHumanSub(s) && reaches(s));
};
// A session parked on its ready receipt (server/job-parked.js) is only waiting on
// the human, so it is not a running step until a message to it is in flight.
const liveRun = (job, sub) => job.runs.find((r) => !r.stopped && r.subJobId === (sub?.id || null) && !(r.parkedFor === 'ready' && !sub?.answering) && !(r.parkedFor === 'idea' && ideaStage(job) !== 'thinking'));
// The open session behind a Code review step: parked, or answering what was sent.
export const readyRun = (job, sub) => job.runs.find((r) => !r.stopped && r.subJobId === sub?.id && r.parkedFor === 'ready') || null;
// What the card says while that session works on a message. A question is
// answered; a change is the next round; a tree that moved is checked again.
const ANSWERING = { ask: 'Answering you', retell: 'Rechecking the tree', restart: 'Starting it again' };
// The round a parked session is reworking toward, or null while it only answers.
export const reworkRound = (sub) => sub?.answering && !ANSWERING[sub.answering.kind] ? (sub.ready?.round || 1) + 1 : null;
export const answeringLabel = (sub) => ANSWERING[sub?.answering?.kind] || `Reworking · round ${reworkRound(sub)}`;
// The live run's own card status, enriched onto the run server-side each graph
// tick (server/index.js withRunStatus). 'needs-you' is the one the board acts on:
// an automated step stuck on a prompt is nobody's but the human's.
export const runStatus = (job, sub) => liveRun(job, sub)?.status ?? null;
// Every live run stuck on a prompt, oldest first, with the card to answer it on:
// the run's own, since a planning run has no sub-job to look one up on.
export const promptsWaiting = (job) => job.runs.filter((r) => !r.stopped && r.status === 'needs-you')
  .map((run) => { const sub = job.subJobs?.find((s) => s.id === run.subJobId) || null; return { run, sub, sessionId: run.sessionId || sub?.sessions?.at(-1) || null }; })
  .filter((p) => p.sessionId).sort((a, b) => (a.run.startedAt || 0) - (b.run.startedAt || 0));
export const promptWhere = (job, p) => p.sub?.title || (job.stage === 'active' ? 'Re-planning' : 'Planning');
export const sessionColumn = (job, sub) => sub.stage === 'session' ? (liveRun(job, sub) ? 'running' : 'queued') : sub.stage === 'review' ? 'review' : 'done';
export const humanColumn = (sub) => sub.stage !== 'human' ? 'done' : sub.state === 'doing' ? 'doing' : 'waiting';
// Nothing automatic will ever move a waiting human task whose prerequisites are
// satisfied: it is the human's, in the same sense a receipt awaiting approval is.
// One still waiting on a prerequisite is just waiting.
export const humanTaskWaiting = (job, sub) => isHumanSub(sub) && sub.stage === 'human' && sub.state !== 'doing' && !pendingDependencies(job, sub).length;
// undefined: no comments on the PR; null: comments read, verdict still being
// written (or stale after new comments); otherwise the summary for exactly the
// comment set on display. Mirrors server/job-comments.js commentsBlockMerge.
export function commentVerdict(sub) {
  if (!sub?.prComments?.items?.length) return undefined;
  return sub.commentSummary?.fingerprint === sub.prComments.fingerprint ? sub.commentSummary : null;
}
export const COMMENT_TONE_LABEL = { green: 'All good', amber: 'Needs attention', red: 'Blocks merging' };
export const redComments = (sub) => commentVerdict(sub)?.tone === 'red';
// An Auto merge stays on hold while comments read as blocking; approving the
// displayed head is the human override.
// A merged sub-job whose post-merge runs have shown nothing at all for longer than
// the stale window (server job-runner.js): nothing automatic will ever move it,
// so it is the human's to act on, unlike an ordinary slow deploy.
export const deploymentStalled = (sub) => sub?.stage === 'deployment' && !!sub.deploymentStale;
export const mergeHeldByComments = (job, sub) => sub?.stage === 'pr' && !job.reviewMerge && sub.pr?.checkStatus === 'passing' && redComments(sub) && sub.mergeApprovedHead !== sub.pr.head && !pendingDependencies(job, sub).length;
// Mirrors server/job-store.js approve-merge: nothing merges before its prerequisites deploy.
export const mergeApprovable = (job, sub) => sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && (job.reviewMerge || redComments(sub)) && sub.mergeApprovedHead !== sub.pr.head && !pendingDependencies(job, sub).length;
export const hasWrites = (job) => (job.subJobs?.length ? job.subJobs : job.plan?.subJobs || []).some(isWriteSub);
// The checkpoints a job's own flags show: Session results and Writes only where
// the job has a sub-job they could stop.
export const jobCheckpoints = (job) => CHECKPOINTS.filter((cp) => (cp.field !== 'reviewSessions' || hasSessionSubs(job)) && (cp.field !== 'reviewWrites' || hasWrites(job)));
export const reviewFlagsLabel = (job) => jobCheckpoints(job).filter((cp) => cp.field !== 'reviewPlan').map((cp) => checkpointLabel(cp, youReview(job, cp.field))).join(' · ');
// The uncommitted working tree awaits the human: nothing is committed and no
// agent runs until approve-code (server/job-store.js) releases the publish session.
export const codeAwaitingReview = (sub) => isPrSub(sub) && sub?.stage === 'review' && sub.state === 'verified';
// What the merge inference found for this PR's head (server job-deploys.js), in
// the words the human reads on the card and in the detail: "Deploys on merge · …"
// or "Merge completes it · …". Absent until the PR exists.
export const deploysLine = (sub) => sub?.deploys?.summary || '';

// Which red pipeline Accept red would wave through, if any — the failing checks on
// an open PR, or the failing post-merge run of a merged one — mirroring the
// server's gates. Already accepted at this exact head or merge
// commit means there is nothing left to accept. A PR a plan change moved behind
// new work (`catchUp`) is not red: its checks run again once that work lands.
export function redPipeline(sub) {
  if (!sub || !isPrSub(sub)) return null;
  if (sub.stage === 'pr' && !sub.catchUp && sub.pr?.checkStatus === 'failing' && !sub.pr.dirty && sub.acceptedRed?.ref !== sub.pr.head) return 'checks';
  if (sub.stage === 'deployment' && !sub.recoveredBy && sub.deploymentResult?.status === 'failing' && sub.acceptedRed?.ref !== sub.pr?.mergeCommit) return 'post-merge';
  return null;
}
export const redAccepted = (sub) => !!sub?.acceptedRed && sub.acceptedRed.ref === (sub.stage === 'pr' ? sub.pr?.head : sub.stage === 'deployment' ? sub.pr?.mergeCommit : undefined);
// A proposal's options as the human picks between them (server/job-replan.js
// optionsOf): the recommended one first, then up to two alternatives. Each has
// its own merged plan, changes and pinned actions.
export const proposalOptions = (proposal) => [proposal, ...(proposal?.alternatives || [])];
// What an action says it does and what it is pinned to, in words; the node it
// acts on carries `actionMark` in the graph (job-graph.js MARKS).
export const actionMark = (a) => (a.type === 'mark' ? `mark-${a.position}` : a.type);
// The pin is why an approval can be refused, not something to read: it is the
// change line's tooltip.
const PIN_MOVED = { round: 'that review has moved on', head: 'its PR has new commits', merge: 'its merge has changed', stage: 'it has moved on', red: 'its failure has changed' };
export const pinLine = (pin) => !pin ? '' : `Not applied if ${PIN_MOVED[pin.at] || 'it has moved on'} by the time you approve`;
export function actionLine(a, plan) {
  const title = (id) => `“${plan.subJobs.find((s) => s.id === id)?.title || id}”`;
  const name = title(a.sub);
  if (a.type === 'accept-red') return { text: a.pin?.at === 'merge' ? `Counts ${name} as landed despite its failing run after merge` : `Merges ${name} despite its failing checks`, detail: a.note || '' };
  if (a.type === 'retry') return { text: `Starts ${name} again as it is`, detail: a.note || '' };
  if (a.type === 'recover') return { text: `Fixes ${name} with a new PR, ${title(a.fix)}`, detail: '' };
  if (a.type === 'mark') return { text: a.position === 'merged' ? `Marks ${name} as merged elsewhere` : `Marks ${name} as done`, detail: a.evidence || '' };
  if (a.type === 'forward') return { text: `Sends your message to the agent that built ${name}`, detail: `“${a.note || ''}”` };
  return { text: `Sends ${name} back to be redone`, detail: a.note || '' };
}
// What editing a sub-job's plan fields (server/job-replan.js EDITABLE, plus
// base) changes about it, in the human's words rather than the field names.
const EDIT_EFFECT = { brief: 'what it is asked to do', show: 'what it shows you', check: 'how it is checked', after: 'when it starts', base: 'which branch it lands on',
  action: 'what it writes', place: 'where it writes', on: 'when it runs', by: 'which step makes it', review: 'whether you review it first', why: 'why it is there' };
export function editLine(edit, plan) {
  const name = `“${plan.subJobs.find((s) => s.id === edit.id)?.title || edit.id}”`;
  const effects = [...new Set(edit.fields.map((f) => EDIT_EFFECT[f]).filter(Boolean))];
  if (!effects.length) return `Renames it to ${name}`;
  return `Changes ${name}: ${effects.length === 1 ? effects[0] : `${effects.slice(0, -1).join(', ')} and ${effects.at(-1)}`}`;
}
// Every idea goes to one recipient, the planner, which the board calls "the
// wrangler" (server/job-change.js): a question is answered in the job's
// conversation (server/job-talk.js), and anything else is sorted into feedback
// for a live step and changes to the plan, a proposal the human approves. `to`
// names it on the box, `mark` is its initial.
const WRANGLER = { to: 'The wrangler', mark: 'W', placeholder: 'Ask the wrangler, or say what to change…' };
const STEP = { ...WRANGLER, placeholder: 'Ask about this step, or say what to change…' };
const CHANGE_ROUTE = {
  plan: { ...WRANGLER, placeholder: 'Add an idea for the wrangler…' },
  proposal: { ...WRANGLER, placeholder: 'Ask about this proposal, or add to it…' },
};
export function changeRoute(at, job = null, sub = null) {
  if (sub && job && redDeclared(job, sub)) return WRANGLER;
  if (CHANGE_ROUTE[at]) return CHANGE_ROUTE[at];
  if (!sub) return WRANGLER;
  if (at === 'code' && job && readyRun(job, sub)) return { ...STEP, placeholder: 'Ask about it, or say what to change…' };
  return STEP;
}
// A running job's conversations with the wrangler (mirrors server/job-talk.js): a
// step's on that step only, and on the job too once its wrangler escalated it; the
// rest on the job; one the human dismissed nowhere, until the server
// clears its dismissal because something new was said in it. A conversation is pending while its wrangler has something of
// the human's left to answer.
export const talkOf = (job) => job?.talk || [];
export const convosOf = (job) => job?.convos || [];
export const askPending = (job, convo = null) => !job?.cancelledAt && (convo ? !!convo.pending : convosOf(job).some((c) => c.pending));
export function talkFor(job, sub) {
  const convo = (m) => m.convo ? convosOf(job).find((c) => c.id === m.convo) : null;
  return talkOf(job).filter((m) => !convo(m)?.dismissedAt).filter(sub ? (m) => m.sub === sub.id || convo(m)?.sub === sub.id : (m) => !convo(m)?.sub || convo(m).escalatedAt);
}
// A wrangler's answer the human has not had in front of them yet: newer than its
// conversation's `seenAt` (stamped by `seen-talk` while a dialog shows it). With
// `sub`, only the answers that step's dialog draws.
export const wranglerUnread = (job, sub = null) => job?.cancelledAt ? [] : talkFor(job, sub).filter((m) => m.from === 'wrangler' && m.kind === 'answer' && m.convo
  && m.at > (convosOf(job).find((c) => c.id === m.convo)?.seenAt || 0));
// The conversations a view shows, in the order they started, each with its
// messages; a message from no conversation (a red step's card) is grouped apart.
export function convoGroups(job, sub) {
  const groups = new Map();
  for (const m of talkFor(job, sub)) {
    const key = m.convo || '';
    if (!groups.has(key)) groups.set(key, { convo: convosOf(job).find((c) => c.id === key) || null, messages: [] });
    groups.get(key).messages.push(m);
  }
  return [...groups.values()];
}
export const convoNumber = (job, convo) => convosOf(job).indexOf(convo) + 1;
export const convoRunning = (job, convo) => job.runs.some((r) => !r.stopped && r.convo === convo.id);
// A planning run that is a question's (an ask run) holds nothing and approves nothing.
export const planningRun = (job) => job.runs.some((r) => !r.stopped && !r.subJobId && !r.ask);
// What the human is looking at, and the exact thing in it, which Request changes
// pins its idea to. Mirrors server/job-change.js changeView: the server refuses a
// request whose pin no longer matches. Null means nothing is left to change.
export function changeView(job, sub) {
  if (job.cancelledAt) return null;
  if (!sub) {
    if (job.stage === 'planning' && job.plan) return { at: 'plan', ref: String(job.revision) };
    if (job.stage !== 'active') return null;
    return job.replan?.proposal ? { at: 'proposal', ref: job.replan.proposal.id } : { at: 'job', ref: 'job' };
  }
  if (sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage)) return null;
  const step = { at: 'step', ref: `${sub.stage}/${sub.state}` };
  if (isWriteSub(sub)) return { at: 'write', ref: step.ref };
  if (isSessionSub(sub)) return sub.stage === 'review' && sub.result ? { at: 'session', ref: String(sub.result.receiptId) } : step;
  if (!isPrSub(sub)) return step;
  if (sub.stage === 'review' && ['verified', 'approved'].includes(sub.state) && sub.ready) return { at: 'code', ref: String(sub.ready.receiptId) };
  if (sub.stage === 'pr' && sub.pr?.head) return { at: 'pr', ref: sub.pr.head };
  return step;
}
// The runner writes these error strings itself, so the short title is derived
// from them; anything it does not recognise keeps the neutral heading and lets
// the detail line — the agent's own sentence, or the observation — do the work.
export const prNumber = (sub) => (sub?.pr?.url || '').split('/').filter(Boolean).pop();
function eventTitle(sub) {
  if (sub.cleanupRefusal) return 'Worktree kept';
  if (sub.blocked?.summary && sub.blocked.summary === sub.error) return 'Worker blocked';
  if (/closed without merging/i.test(sub.error)) return 'PR was closed';
  if (/repair limit/i.test(sub.error)) return prNumber(sub) ? `Checks failing on #${prNumber(sub)}` : 'Checks failing';
  if (/^Post-merge run failed/i.test(sub.error)) return 'Post-merge run failed';
  if (/without a receipt/i.test(sub.error)) return 'Session stopped early';
  if (isWriteSub(sub) && !sub.by) return 'Write predates sessions';
  if (isMakeWrite(sub) && sub.state === 'failed') return 'Not made';
  if (isWriteSub(sub) && sub.state === 'failed') return `${placeShort(sub)} refused the write`;
  return 'Needs attention';
}
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
// What happened, in one line.
export function eventFor(job, sub) {
  if (!sub) return job.error ? { title: 'Job needs attention', detail: job.error } : null;
  // A dropped sub-job's only event is a refused cleanup: the one thing left for a human.
  if (sub.cancelledAt && !sub.error) return null;
  // The failure itself stays as the event; `fix` is what Wrangler has done about it.
  const base = { title: eventTitle(sub), detail: sub.error };
  // An escalation's error is its own summary cut short: the declaration alone says it, in full.
  if (sub.error && !job.error && redDeclared(job, sub)) {
    const d = sub.red.declared;
    const fix = { kind: 'declared', title: 'Declared red', detail: d.summary, tried: d.tried || [], ask: d.ask || '', by: d.by || (d.auto ? 'auto' : 'planner'), options: !!job.replan?.proposal?.escalation };
    return { ...base, ...(flat(d.summary).startsWith(flat(sub.error)) ? { detail: '' } : {}), fix };
  }
  if (sub.error && !job.error && redFixing(job, sub)) return { ...base, fix: { kind: 'fixing', title: 'Fixing', n: job.replan.red.n || 1 } };
  if (sub.error && !job.error && redFixReady(job, sub)) return { ...base, fix: { kind: 'ready', title: 'Fix ready', detail: job.replan.proposal.diagnosis?.summary || job.replan.proposal.label || 'Wrangler proposed a fix. Review it.', waits: job.reviewRed ?? true } };
  if (sub.error) return { title: eventTitle(sub), detail: sub.error };
  if (deploymentStalled(sub)) return { title: 'Nothing deployed', detail: `No post-merge run has started for merge commit ${(sub.pr?.mergeCommit || '').slice(0, 8)}.` };
  if (sub.stage === 'pr' && redComments(sub)) return { title: 'Comments block merging', detail: commentVerdict(sub).text };
  return null;
}
// Red steps (server/job-red.js, mirrored). A sub-job is red when it has an `error`;
// Wrangler's planner is sent after it, holding only that step and what follows.
// While it works the step is FIXING (the board does not count it as yours); a fix
// waiting on you is FIX READY; a step Wrangler gave up on, or ran out of tries
// on, or whose agent escalated is DECLARED red, the only red you act on.
export const redRef = (job, sub) => `${sub.error || ''}|${sub.pr?.head || ''}|${sub.pr?.mergeCommit || ''}|${job.runs.filter((r) => r.subJobId === sub.id).length}`;
export const redDeclared = (job, sub) => !!sub?.error && sub.red?.declared?.ref === redRef(job, sub);
const redReplan = (job) => (job.replan?.red && !job.cancelledAt ? job.replan.red : null);
export const redFixing = (job, sub) => !!sub?.error && redReplan(job)?.sub === sub.id && !job.replan.proposal && !redDeclared(job, sub);
export const redFixReady = (job, sub) => !!sub?.error && redReplan(job)?.sub === sub.id && !!job.replan.proposal && !redDeclared(job, sub);
// Mirrors server/job-red.js redScope: the step and everything waiting on it.
export function redScope(job, id) {
  const scope = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of job.subJobs) {
      if (scope.has(s.id) || !(edgesOf(s).some((e) => scope.has(e)) || (isWriteSub(s) && scope.has(s.by)))) continue;
      scope.add(s.id); grew = true;
    }
  }
  return scope;
}
// A plan change on a running job (server/job-replan.js): asked for, then a
// proposal the human approves or discards. Mirrors the server's isFrozen.
export const replanPending = (job) => !!job.replan && !job.cancelledAt;
export const replanProposed = (job) => replanPending(job) && !!job.replan.proposal;
// Changes sent while the wrangler was drafting, each planned in its own round once
// the one ahead is approved or discarded (server/job-replan.js requestReplan).
export const replanQueued = (job) => job.cancelledAt ? [] : job.replanQueue || [];
export const queuedLabel = (job) => { const n = replanQueued(job).length; return n ? `${n} change${n === 1 ? '' : 's'} queued` : ''; };
export const isFrozen = (sub) => !!sub.cancelledAt || ['deployment', 'cleanup', 'done'].includes(sub.stage) || !!sub.mergedAt || !!sub.deployed;
// Mirrors server/job-red.js touchedBy: what a waiting proposal edits, cancels or
// acts on, in any of its options.
export function touchedBy(proposal) {
  const ids = new Set();
  for (const o of proposal ? [proposal, ...(proposal.alternatives || [])] : []) {
    for (const e of o.changes?.edited || []) ids.add(e.id);
    for (const id of o.changes?.removed || []) ids.add(id);
    for (const a of o.actions || []) ids.add(a.sub);
  }
  return ids;
}
// A plan change never pauses the job (server/job-red.js heldBy): only the step
// the idea was typed on and the sub-jobs a waiting proposal touches are frozen
// where they stand (server/job-store.js refuses their approvals and moves, the
// runner their launches and merges), plus, for a red step's replan, that step
// and what follows it. One with a step still running carries on.
export const heldByReplan = (job, sub) => replanPending(job) && !!sub?.stage && !isFrozen(sub) && !sub.error && !liveRun(job, sub)
  && (job.replan.source?.sub === sub.id || touchedBy(job.replan.proposal).has(sub.id) || (!!redReplan(job) && redScope(job, redReplan(job).sub).has(sub.id)));
export function jobNeedsReview(job, sub) {
  if (job.error) return true;
  if (sub?.error) return !redFixing(job, sub);
  // A step waiting on a prompt is the human's, whatever else the job is doing.
  if (runStatus(job, sub) === 'needs-you') return true;
  if (heldByReplan(job, sub)) return false;
  // A requested or running fix is the agent's turn on the PR: the merge and comment
  // gates it would otherwise show belong to the head the repair is about to replace.
  if (sub?.stage === 'pr' && (sub.fixRequested || liveRun(job, sub))) return false;
  if (sub && mergeHeldByComments(job, sub)) return true;
  if (!sub && ['reply', 'suggested'].includes(ideaStage(job))) return !job.paused;
  if (!sub) return !job.cancelledAt && (job.stage === 'planning' && job.plan || replanProposed(job)) && !planningRun(job);
  if (!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return true;
  if (isWriteSub(sub)) return writeAwaitingReview(sub);
  if (isHumanSub(sub)) return humanTaskWaiting(job, sub);
  if (isSessionSub(sub)) return sub.stage === 'review';
  // Not yours again until it reports back: the answer or the new round is its turn.
  if (codeAwaitingReview(sub)) return !sub.answering;
  if (deploymentStalled(sub)) return true;
  return sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && job.reviewMerge && sub.mergeApprovedHead !== sub.pr.head && !pendingDependencies(job, sub).length;
}
// One kind of prerequisite names itself; a mix is only ever "prerequisites".
const waitingNoun = (list) => list.every(isSessionSub) ? 'session' : list.every(isHumanSub) ? 'human task' : list.every(isPrSub) ? 'deployment' : 'prerequisite';
// Cleanup refused to lose work and waits for the human to Retry or Discard anyway.
export const worktreeKept = (sub) => !!sub?.cleanupRefusal && !sub.discard && sub.stage === 'cleanup';
export function jobStatus(job, sub) {
  if (!job.error && sub?.error && !sub.cancelledAt) {
    if (redFixing(job, sub)) return { tone: 'working', text: 'Fixing' };
    if (redFixReady(job, sub)) return { tone: 'needs', text: 'Fix ready' };
    if (redDeclared(job, sub)) return { tone: 'needs', text: 'Declared red' };
  }
  if (sub?.cancelledAt && worktreeKept(sub)) return { tone: 'needs', text: 'Worktree kept' };
  if (!sub && job.cancelledAt && job.subJobs.some(worktreeKept)) return { tone: 'needs', text: 'Cancelled · worktree kept' };
  if (job.error || sub?.error) return { tone: 'needs', text: 'Needs attention' };
  if (sub?.cancelledAt) { const word = sub.superseded ? 'Superseded' : sub.notNeeded ? 'Not needed' : 'Dropped'; return { tone: sub.stage === 'done' ? 'done' : 'muted', text: sub.stage === 'done' ? word : `${word} · cleaning up` }; }
  if (!sub && job.cancelledAt) return { tone: job.stage === 'done' ? 'done' : 'muted', text: job.stage === 'done' ? 'Cancelled' : 'Cancelled · cleaning up' };
  if (job.paused) return { tone: 'muted', text: 'Paused' };
  if (budgetHeld(job)) return { tone: 'muted', text: 'Paused for budget' };
  if (sub && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return { tone: 'needs', text: triggerDropped(job, sub) ? 'Trigger dropped' : 'Depends on a dropped sub-job' };
  if (isWriteSub(sub)) return writeStatusLine(job, sub);
  const idea = !sub && ideaStage(job);
  if (idea) return idea === 'thinking' ? { tone: 'working', text: ideaThread(job).length ? 'The wrangler is thinking' : 'The wrangler is reading the idea' } : { tone: 'needs', text: idea === 'suggested' ? 'Job suggested' : 'Your reply' };
  const run = liveRun(job, sub);
  if (run) {
    if (run.status === 'needs-you') return { tone: 'needs', text: 'Waiting on a prompt' };
    // Its drafts are each the human's to decide (the writes carry the needs-you).
    if (run.parkedFor === 'ready') return { tone: 'working', text: answeringLabel(sub) };
    if (parkedRun(job, sub)) { const n = draftsWaiting(job, sub).length; return n ? { tone: 'muted', text: `Paused · ${n} draft${n === 1 ? '' : 's'} to review` } : { tone: 'working', text: 'Drafts decided · resuming' }; }
    if (run.mailedAt && !run.report) return { tone: 'working', text: 'Making the approved writes' };
    return { tone: 'working', text: run.report ? 'Saving receipt' : ({ planning: run.ask ? 'Answering you' : job.stage === 'active' ? 'Re-planning' : 'Planning', implementation: reviewCode(job) ? 'Working' : 'Working on the PR', publish: 'Committing & opening the PR', repair: 'Fixing the PR', verify: 'Checking it landed', session: 'Working' }[run.phase] || 'Working') };
  }
  if (sub && heldByReplan(job, sub)) return { tone: 'muted', text: job.replan.red ? 'Held for the fix' : 'Held for the plan change' };
  // The human said they had started; no agent and no clock runs against it, so
  // this outranks the prerequisite line a waiting one would show.
  if (isHumanSub(sub) && sub.stage === 'human' && sub.state === 'doing') return { tone: 'working', text: 'In progress' };
  // A requested fix is a repair the runner picks up on its next tick, so it outranks
  // whatever the checks currently say.
  if (sub?.stage === 'pr' && sub.fixRequested && !pendingDependencies(job, sub).length) return { tone: 'working', text: 'Fix requested' };
  if (deploymentStalled(sub)) return { tone: 'needs', text: 'No deployment run' };
  if (jobNeedsReview(job, sub)) return { tone: 'needs', text: sub ? isHumanSub(sub) ? 'Needs you' : isSessionSub(sub) || codeAwaitingReview(sub) ? 'Ready to review' : sub.stage === 'pr' ? mergeHeldByComments(job, sub) ? 'Comments block merging' : 'Ready to merge' : 'Needs you' : replanProposed(job) ? 'Plan change to review' : 'Plan ready to review' };
  // Approved: the publish session starts on the runner's next tick.
  if (sub?.stage === 'review' && isPrSub(sub)) return { tone: 'working', text: 'Approved · committing next' };
  if (!sub) return { tone: 'muted', text: job.stage === 'backlog' ? 'Ready when you are' : job.stage === 'done' ? 'Delivered' : 'Queued' };
  // A session or human prerequisite blocks the work from starting; a PR prerequisite
  // only blocks its merge, and the rework a plan change asked of an open PR.
  const waiting = pendingDependencies(job, sub);
  const blocked = ['session', 'human', 'pr'].includes(sub.stage) ? waiting : sub.stage === 'implementation' ? waiting.filter((d) => !isPrSub(d)) : [];
  if (blocked.length) return { tone: 'muted', text: `Waiting for ${blocked.length} ${waitingNoun(blocked)}${blocked.length === 1 ? '' : 's'}` };
  // A story added by New ticket has no key until its create write is made, and a
  // sub-job that names a story cannot start without one; a storyless sub-job
  // is ticketless by design and never waits.
  if (sub.stage === 'implementation' && sub.storyId && !sub.jiraKey) return { tone: 'muted', text: 'Waiting for a Jira ticket' };
  if (sessionDormant(job, sub)) return { tone: 'muted', text: triggerLine(job, sub) };
  if (sessionWaitsOn(job, sub)) return { tone: 'muted', text: triggerLine(job, sub).replace(/^When/, 'Waits until') };
  if (sub.observationError) return { tone: 'needs', text: 'Pipeline polling will retry' };
  // Accepted red: the runner merges, or finishes the landing, on its next tick.
  if (redAccepted(sub)) return { tone: 'working', text: sub.stage === 'pr' ? (sub.mergeRequestedHead ? 'Merge requested' : 'Merging with red checks') : 'Red run accepted · landing' };
  // Watching runs is Wrangler at work; a red run or a GitHub review is not.
  if (sub.stage === 'pr') {
    const text = sub.mergeRequestedHead ? 'Merge requested' : sub.pr?.behind ? 'Behind base · updating branch' : sub.pr?.checkStatus === 'awaiting-review' ? 'GitHub review required' : 'Watching checks';
    return { tone: sub.pr?.behind || (!redPipeline(sub) && text !== 'GitHub review required') ? 'working' : 'muted', text };
  }
  if (sub.stage === 'deployment') return sub.recoveredBy ? { tone: 'muted', text: 'Awaiting fix' } : { tone: redPipeline(sub) ? 'muted' : 'working', text: 'Watching post-merge runs' };
  // Fix here on an open PR under code review: the work restarts on the next tick.
  if (sub.stage === 'implementation' && sub.pr) return { tone: 'working', text: 'Fix queued' };
  if (sub.stage === 'done') return { tone: 'done', text: isPrSub(sub) ? 'Delivered' : isSessionSub(sub) ? 'Completed' : 'Done' };
  return { tone: 'muted', text: 'Queued' };
}
// A write's own run is its session's, so its line is that session's progress
// seen from the write. Held for a plan change is read before here.
function writeStatusLine(job, sub) {
  const session = writeSession(job, sub);
  const by = session?.title || sub.by;
  if (sub.stage === 'done') return { tone: 'done', text: { already: 'Already there', skipped: 'Skipped' }[sub.result?.outcome] || (sub.result?.receiptId ? (isMakeWrite(sub) ? 'Made' : 'Written') : 'Done') };
  if (sub.stage === 'cleanup') return { tone: 'working', text: 'Finishing' };
  if (heldByReplan(job, sub)) return { tone: 'muted', text: job.replan.red ? 'Held for the fix' : 'Held for the plan change' };
  if (writeAwaitingReview(sub)) return { tone: 'needs', text: isMakeWrite(sub) ? 'Review the output' : 'Review the draft' };
  const running = !!session && !!liveRun(job, session);
  if (sub.state === 'approved') return { tone: running ? 'working' : 'muted', text: `Approved · ${by} makes it` };
  if (running) return { tone: 'working', text: `${by} is working` };
  if (sub.storyId && !sub.jiraKey && !isStoryCreate(sub)) return { tone: 'muted', text: 'Waiting for a Jira ticket' };
  return { tone: 'muted', text: `${isMakeWrite(sub) ? 'Made' : 'Written'} by ${by}` };
}
// A job card joins the sub-job cards when the job itself needs attention, and
// stands alone for a job cancelled before it had any sub-jobs — otherwise that
// job would have no card at all and its board would never be drawn.
export function jobCards(jobs) {
  return jobs.flatMap((job) => job.stage === 'active' || job.stage === 'done'
    ? [...job.subJobs.map((sub) => isSessionSub(sub) ? { job, sub, board: 'sessions', stage: sessionColumn(job, sub) }
      : isHumanSub(sub) ? { job, sub, board: 'human', stage: humanColumn(sub) }
      : isWriteSub(sub) ? { job, sub, board: 'writes', stage: sub.stage }
      : { job, sub, board: 'prs', stage: sub.stage === 'done' ? 'cleanup' : sub.stage }), ...(job.error || !job.subJobs.length || (replanProposed(job) && !job.replan.red) ? [{ job, sub: null, board: 'prs', stage: 'cleanup' }] : [])]
    : [{ job, sub: null, board: 'prs', stage: job.stage }]);
}
// Every dependency gates the start: a PR once it deploys, a session or human task
// once it is done.
export function dependencyLine(job, sub) {
  if (isWriteSub(sub)) return sub.by ? `${isMakeWrite(sub) ? 'Made' : 'Written'} by ${writeSession(job, sub)?.title || sub.by}` : 'Predates session-owned writes';
  const deps = sub.after.map((id) => job.subJobs.find((s) => s.id === id) || { id, title: id });
  const after = deps.length ? `${isPrSub(sub) ? 'Start after' : 'After'} ${deps.map((d) => isPrSub(d) ? `${d.title} deploys` : d.title).join(' + ')}` : '';
  return [triggerLine(job, sub), after].filter(Boolean).join(' · ');
}
// What a job (or one sub-job) cost: planning, every step, CI repairs and the
// headless comment triage, summed server-side (server/job-spend.js) from every
// transcript its cards have owned. `~` for a Codex estimate, exactly as a session
// card reads it (cards.js). Empty for null/0 — a backlog job that has spent nothing
// shows no price rather than an authoritative-looking $0.00.
// Paused at its spend limit (server/job-budget.js), until Add $X or a new limit in Settings.
// Mirrors server/jobs-schema.js DEFAULT_SPEND_LIMIT: what Settings shows while none is saved.
export const DEFAULT_SPEND_LIMIT = 100;
export const budgetHeld = (job) => !!job.budgetPaused && !job.cancelledAt && job.stage !== 'done';
export const dollars = (usd) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
export const topUpLabel = (job) => `Add ${dollars(job.spendStep ?? 0)}`;
export const budgetLine = (job) => `${dollars(Math.max(job.usd ?? 0, job.budgetPaused?.usd ?? 0))} of ${job.spendLimit == null ? 'no limit' : dollars(job.spendLimit)}`;
export const jobCostLabel = (usd, estimated) => typeof usd === 'number' && usd > 0 ? `${estimated ? '~' : ''}$${usd.toFixed(2)}` : '';
export const JOB_COST_TITLE = 'Total price of this job: planning, every implementation step, CI repairs and PR comment triage';
export const SUB_COST_TITLE = 'Price of this sub-job: every step it ran, its CI repairs and its comment triage';

// Mirrors server/jobs-schema.js storyProject.
export const storyProject = (story) => story?.key ? story.key.split('-')[0] : story?.project || null;
// A story is an existing ticket (key) or a proposal awaiting its create write.
// Proposals are numbered per project (ENT-NEW-1, BAE-NEW-1, BAE-NEW-2) so the
// human can tell which goes where before Jira has minted the keys.
export function storyLabel(story, stories = []) {
  if (story?.key) return story.key;
  const project = story?.project || '';
  const peers = stories.filter((s) => !s.key && (s.project || '') === project);
  const n = Math.max(peers.indexOf(story), 0) + 1;
  return project ? `${project}-NEW-${n}` : `NEW-${n}`;
}
export const receiptHtml = (checks = []) => `<ul class="job-receipt">${checks.map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul>`;
// A session's milestone (`on`) orders it like `after`, so it is a wave past its trigger.
export const edgesOf = (sub) => [...sub.after, ...(isSessionSub(sub) && sub.on && !sub.after.includes(sub.on.sub) ? [sub.on.sub] : [])];
// Every step `id` waits on, directly or through another, as id → hops (1 is a
// direct prerequisite; breadth-first, so a step reached both ways counts as 1).
// Writes are not steps. `edges` lets a drawn graph walk its own connectors.
export function prerequisitesOf(subs, id, edges = edgesOf) {
  const byId = new Map(subs.filter((s) => !isWriteSub(s)).map((s) => [s.id, s])), hops = new Map(), queue = [[id, 0]];
  while (queue.length) {
    const [at, n] = queue.shift(), sub = byId.get(at);
    for (const p of sub ? edges(sub) : []) if (p !== id && byId.has(p) && !hops.has(p)) { hops.set(p, n + 1); queue.push([p, n + 1]); }
  }
  return hops;
}
export function dependencyLevels(plan) {
  const levels = new Map();
  function level(sub, visiting = new Set()) {
    if (levels.has(sub.id)) return levels.get(sub.id);
    if (visiting.has(sub.id)) return 0;
    visiting.add(sub.id);
    const edges = edgesOf(sub);
    const n = edges.length ? 1 + Math.max(...edges.map((id) => {
      const parent = plan.subJobs.find((s) => s.id === id); return parent ? level(parent, new Set(visiting)) : 0;
    })) : 0;
    levels.set(sub.id, n); return n;
  }
  plan.subJobs.forEach((s) => level(s));
  return levels;
}
