import { z } from 'zod';
import { line, commentSchema, triggerSchema, storyFieldSchema, isWriteSub, isPrSub, isHumanSub, isStoryCreate, isMakeWrite, isJiraWrite, placeOf, awaitsTicket, storyProject, writeReviewed, WRITE_REF, placeNameSchema } from './jobs-schema.js';
import { dropSub, validatePlan } from './job-moves.js';

// Writes (a `write` sub-job, jobs-schema.js): one write to one place outside the
// board. Pure over the job draft the store is about to persist, like
// job-moves.js. A milestone write is asked about by the runner each tick
// (`writeStatus`) and every due one is batched into one short agent session
// (job-prompts.js `write`); a make write waits for its session's receipt, which
// must account for it (`applyOutputs`).
//
// stage `write`:  queued (waiting) → due → writing → cleanup/done, or failed
// stage `review` (review on):  verified, until Write / Edit / Skip; a made
// output stops here AFTER it is published (it has its result), until Accept
const quoted = (title) => `“${title}”`;
const triggerOf = (job, sub) => sub.on ? job.subJobs.find((s) => s.id === sub.on.sub) : null;
const FINISHED = ['cleanup', 'done'];
export const PLACE_NAME = { jira: 'Jira', slack: 'Slack', confluence: 'Confluence', artifact: 'the artifact', file: 'the file', url: 'the web page' };
export const placeName = (sub) => placeOf(sub) === 'other' ? sub.place?.name || 'the place' : PLACE_NAME[placeOf(sub)];

// Whether a trigger has reached a milestone. Started is any session having run
// for it (a human task marked in progress counts); merged includes a PR marked
// done by hand; deployed is the same bar `after` holds a dependant to.
export function milestoneReached(t, at) {
  if (!t) return false;
  if (at === 'dropped') return !!t.cancelledAt;
  if (at === 'started') return (t.sessions || []).length > 0 || !!t.pr || (isHumanSub(t) && t.state === 'doing')
    || (!t.cancelledAt && !['implementation', 'session', 'human'].includes(t.stage));
  if (at === 'pr') return !!t.pr;
  if (at === 'merged') return !!t.mergedAt || (isPrSub(t) && !!t.deployed);
  return !t.cancelledAt && (isPrSub(t) ? !!t.deployed : FINISHED.includes(t.stage));
}

// What a waiting milestone write is doing this tick: `wait` for its milestone,
// `ticket` for its story's key, `due`, `dead` (its trigger was dropped before
// getting there: the prerequisite-dropped treatment), or `not-needed` — an
// if-dropped write whose trigger landed instead, which the runner drops.
export function writeStatus(job, sub) {
  const t = triggerOf(job, sub);
  let due = !sub.on;
  if (sub.on?.at === 'dropped') {
    if (!t?.cancelledAt && milestoneReached(t, 'deployed')) return 'not-needed';
    due = !!t?.cancelledAt;
  } else if (sub.on) {
    due = milestoneReached(t, sub.on.at);
    if (!due && (!t || t.cancelledAt)) return 'dead';
  }
  if (!due) return 'wait';
  return awaitsTicket(sub) ? 'ticket' : 'due';
}

// A made output lives and dies with its session: dropped with it, and failed
// (the human's to mark done with a link, or drop) if the session finished
// without saying where it is — marked done by hand, say.
function advanceMake(job, sub, now) {
  const session = job.subJobs.find((s) => s.id === sub.by);
  if (!session || session.cancelledAt) { dropSub(sub, now); return true; }
  if (!FINISHED.includes(session.stage)) return false;
  sub.state = 'failed'; sub.error = `${session.title} finished without reporting it`; sub.blocked = null;
  return true;
}
// One tick's step for a waiting write; returns whether it changed.
export function advanceWrite(job, sub, now) {
  if (!isWriteSub(sub) || sub.stage !== 'write' || sub.state !== 'queued' || sub.error || sub.cancelledAt) return false;
  if (isMakeWrite(sub)) return advanceMake(job, sub, now);
  const status = writeStatus(job, sub);
  if (status === 'not-needed') { dropSub(sub, now); sub.notNeeded = true; return true; }
  if (status !== 'due') return false;
  sub.dueAt = now;
  if (writeReviewed(job, sub) && !sub.writeApprovedAt) { sub.stage = 'review'; sub.state = 'verified'; } else sub.state = 'due';
  return true;
}
export const dueWrites = (job) => job.subJobs.filter((s) => isWriteSub(s) && !isMakeWrite(s) && s.stage === 'write' && s.state === 'due' && !s.error && !s.cancelledAt);

// A run that ended without results, or blocked, fails every write it still held:
// each is retried on its own card, not by retrying the whole job.
export function failWrites(job, run, error, blocked = null) {
  for (const id of run.writes || []) {
    const s = job.subJobs.find((x) => x.id === id);
    if (s && s.state === 'writing' && !s.cancelledAt) { s.error = error; s.blocked = blocked; s.state = 'failed'; }
  }
}

// Where a write's place is once it exists: the permalink its result carried,
// else a ticket's browse URL on the site the planner read.
export function writeUrl(job, sub) {
  if (sub?.result?.url) return sub.result.url;
  const key = isJiraWrite(sub) && (sub.jiraKey || sub.result?.key);
  const site = job.plan?.jiraSite;
  return key && site ? `${site.replace(/\/$/, '')}/browse/${key}` : null;
}
// {pr.url}, {pr.title} and {deploy.run} come from the trigger as it stands when
// the write runs, {<write id>.url} from that write's place; one with nothing to
// fill says so rather than posting a brace.
export function fillText(job, sub, text) {
  if (!text) return null;
  const t = triggerOf(job, sub);
  const runs = t?.deploymentResult?.runs || [];
  const values = { 'pr.url': t?.pr?.url, 'pr.title': t?.pr?.title || t?.title, 'deploy.run': (runs.find((r) => r.status === 'passing') || runs[0])?.url };
  return text.replace(/\{(pr\.url|pr\.title|deploy\.run)\}/g, (_, k) => values[k] || '(not available)')
    .replace(WRITE_REF, (_, ref) => writeUrl(job, job.subJobs.find((s) => s.id === ref)) || '(not available)');
}
const storyOf = (job, sub) => job.plan?.stories.find((t) => t.id === sub.storyId) || null;
// The write as the session is given it: everything it needs to read the place
// first and make exactly this change.
export function writeBrief(job, sub) {
  const t = triggerOf(job, sub);
  const a = sub.action;
  const tail = { approved: !!sub.writeApprovedAt, ...(t ? { because: `${t.title} reached ${sub.on.at}` } : {}), ...(sub.why ? { why: sub.why } : {}) };
  if (!isJiraWrite(sub)) {
    return { id: sub.id, place: placeOf(sub), ...(sub.place?.name ? { name: sub.place.name } : {}), ...(sub.place?.ref ? { where: sub.place.ref } : {}), write: a.type,
      ...(a.title ? { title: a.title } : {}), ...(a.text ? { text: fillText(job, sub, a.text) } : {}), ...tail };
  }
  const story = storyOf(job, sub);
  return { id: sub.id, place: 'jira', ticket: sub.jiraKey || null, ...(sub.jiraKey ? {} : { story: story?.title, project: storyProject(story), ...(story?.fields?.length ? { fields: story.fields } : {}) }),
    write: a.type, ...(a.to ? { to: a.to } : {}), ...(a.comment ? { comment: fillText(job, sub, a.comment) } : {}), ...tail };
}

const keyStory = (job, storyId, key) => {
  const story = job.plan.stories.find((t) => t.id === storyId);
  if (!story) throw new Error(`Unknown story: ${storyId}`);
  if (story.key && story.key !== key) throw new Error(`${storyId} was approved as ${story.key}; keep that key`);
  story.key = key;
  for (const sub of [...job.subJobs, ...job.plan.subJobs]) if (sub.storyId === storyId && !sub.jiraKey) sub.jiraKey = key;
};
function doneLine(sub, r) {
  const a = sub.action;
  if (!isJiraWrite(sub)) {
    const what = { post: `Posted in ${sub.place?.ref}`, create: `Created “${a.title}”`, comment: 'Commented on the page', write: `Wrote to ${placeName(sub)}` }[a.type];
    return r.outcome === 'already' ? `Already there: ${what[0].toLowerCase()}${what.slice(1)}` : what;
  }
  if (r.outcome === 'already') return `${sub.jiraKey || r.key} was already ${a.to ? `at or past ${a.to}` : 'there'}${a.comment ? '; comment posted' : ''}`;
  return a.type === 'create' ? `Created ${r.key}` : `${sub.jiraKey}${a.to ? ` moved to ${a.to}` : ''}${a.comment ? `${a.to ? ';' : ''} comment posted` : ''}`;
}
const finish = (sub, result) => { sub.result = result; sub.stage = 'cleanup'; sub.state = 'queued'; sub.error = null; sub.blocked = null; };

// Every write the run was given is answered, and only those. A write dropped
// while the session worked is answered too, and ignored.
export function applyWriteReceipt(job, run, report, now) {
  if (!report.writes && !report.stories) throw new Error('Report writes:[{id,outcome}] for every write you were given');
  for (const { id, key } of report.stories || []) {
    keyStory(job, id, key);
    const create = job.subJobs.find((s) => isStoryCreate(s) && s.storyId === id && !FINISHED.includes(s.stage));
    if (create && !create.cancelledAt) finish(create, { outcome: 'written', checks: [`Created ${key}`], key, at: now, receiptId: run.id });
  }
  const results = report.writes || [];
  const asked = run.writes || [];
  for (const r of results) if (!asked.includes(r.id)) throw new Error(`${r.id} was not one of this run's writes`);
  const missing = asked.filter((id) => !results.some((r) => r.id === id) && job.subJobs.find((s) => s.id === id)?.state === 'writing');
  if (report.writes && missing.length) throw new Error(`Report every write; still missing: ${missing.join(', ')}`);
  for (const r of results) {
    const sub = job.subJobs.find((s) => s.id === r.id);
    if (!sub || sub.cancelledAt) continue;
    if (r.outcome === 'failed') { sub.error = r.error || `${placeName(sub)} refused the write`; sub.blocked = null; sub.state = 'failed'; continue; }
    if (isStoryCreate(sub)) {
      if (!r.key) throw new Error(`${r.id}: report the key of the story`);
      keyStory(job, sub.storyId, r.key);
    }
    const text = sub.action.comment || sub.action.text;
    finish(sub, { outcome: r.outcome, checks: r.checks || [doneLine(sub, r)], ...(r.from ? { from: r.from } : {}), ...(r.key ? { key: r.key } : {}),
      ...(r.url ? { url: r.url } : {}), ...(text ? { text: fillText(job, sub, text) } : {}), at: now, receiptId: run.id });
  }
}

// The open make writes a session's `completed` receipt must account for, one
// output each: where it is, or why it is not. Checked whole before anything
// moves, so a rejected receipt changes nothing and the session can correct it.
// A reviewed output is reviewed once it exists: there is no draft to show, and
// a second session to publish it would only repeat the first.
export const openOutputs = (job, session) => (job.subJobs || []).filter((w) => isMakeWrite(w) && w.by === session?.id && !w.cancelledAt && w.stage === 'write');
export function applyOutputs(job, run, session, report, now) {
  const asked = openOutputs(job, session);
  const outputs = report.outputs || [];
  const seen = new Set();
  for (const o of outputs) {
    const w = asked.find((x) => x.id === o.id);
    if (!w) throw new Error(`${o.id} is not one of the outputs this session makes`);
    if (seen.has(o.id)) throw new Error(`${o.id} is reported twice`);
    seen.add(o.id);
    if (o.url && placeOf(w) === 'file' && /^https?:/.test(o.url)) throw new Error(`${o.id}: give the file's absolute path`);
    if (o.url && !['file', 'other'].includes(placeOf(w)) && !/^https?:/.test(o.url)) throw new Error(`${o.id}: give its URL`);
  }
  const missing = asked.filter((w) => !seen.has(w.id)).map((w) => w.id);
  if (missing.length) throw new Error(`Report outputs:[{id, url, title?} or {id, missing:"why"}] for every output you make; still missing: ${missing.join(', ')}`);
  for (const o of outputs) {
    const w = asked.find((x) => x.id === o.id);
    if (o.missing) { w.state = 'failed'; w.error = o.missing; w.blocked = null; continue; }
    const result = { outcome: 'written', url: o.url, ...(o.title ? { title: o.title } : {}), checks: [`Made ${o.title || o.url}`], at: now, receiptId: run.id };
    if (writeReviewed(job, w)) { w.result = result; w.stage = 'review'; w.state = 'verified'; w.error = null; w.blocked = null; } else finish(w, result);
  }
}

// Write: approval of the write on display, with the human's edits applied in
// the same change (the review panel IS the editor), so a refused edit approves
// nothing. A made output is already published: Accept finishes it as it is.
// Skip finishes a write unwritten.
export function approveWrite(job, sub, now, edit = null) {
  if (!isWriteSub(sub) || sub.stage !== 'review' || sub.error) throw new Error('This write is not waiting for review');
  const data = edit ? applyEdit(job, sub, edit) : null;
  sub.writeApprovedAt = now;
  if (isMakeWrite(sub)) { finish(sub, sub.result); return `Accepted the output ${quoted(sub.title)}`; }
  // A moved trigger is waited for again; the approval already stands.
  sub.stage = 'write'; sub.state = data?.on !== undefined ? 'queued' : 'due';
  return `Approved the write ${quoted(sub.title)}${data ? ' with edits' : ''}`;
}
export function skipWrite(sub, now) {
  if (!isWriteSub(sub) || sub.stage !== 'review') throw new Error('This write is not waiting for review');
  if (isMakeWrite(sub)) throw new Error('It is already made; drop it instead');
  finish(sub, { outcome: 'skipped', checks: [`Skipped; nothing written to ${placeName(sub)}`], at: now, receiptId: null });
  return `Skipped the write ${quoted(sub.title)}`;
}

// Edit (in review), Pick another status (failed), Turn review on, move its
// trigger (waiting or trigger dropped): one action, the fields it changes. In
// `action`, null removes a field and absent leaves it; a write keeps its type
// (a Jira one is a transition or a comment by whether it still moves the ticket).
// `story` is a create write's: the story it creates (title, fields replaced
// whole), which is the plan's, so the sub-jobs naming it read the same one.
export const writeEditSchema = z.object({
  action: z.object({ to: line.nullable().optional(), comment: commentSchema.nullable().optional(), text: commentSchema.nullable().optional(),
    title: line.nullable().optional(), what: line.nullable().optional() }).strict().default({}),
  ref: z.string().trim().min(1).max(500).nullable().optional(), name: placeNameSchema.optional(),
  on: triggerSchema.nullable().optional(), review: z.boolean().optional(),
  story: z.object({ title: line.optional(), fields: z.array(storyFieldSchema).max(25).optional() }).strict().optional(),
}).strict();
const createTitle = (title) => `Create story: ${title}`.slice(0, 180).trim();
// Validated against the plan it would produce, then applied to the write and its
// plan entry alike; where the write then stands is the caller's.
function applyEdit(job, sub, payload) {
  if (!isWriteSub(sub)) throw new Error('Only a write can be edited this way');
  if (sub.cancelledAt || FINISHED.includes(sub.stage)) throw new Error('This write has already finished');
  if (sub.state === 'writing') throw new Error('Wait for the write to finish');
  const data = writeEditSchema.parse(payload);
  const create = isStoryCreate(sub);
  const reshapes = Object.keys(data.action).length || data.on !== undefined || data.ref !== undefined || data.name !== undefined;
  if (create && reshapes) throw new Error('A create write can only change its story and whether it is reviewed');
  if (data.story && !create) throw new Error('Only the write that creates a story can edit it');
  const made = isMakeWrite(sub) && sub.stage === 'review';
  if (made && reshapes) throw new Error('It is already made; accept it or drop it');
  if (isMakeWrite(sub) && !made && job.runs.some((r) => !r.stopped && r.subJobId === sub.by)) throw new Error('Wait for its session to finish');
  const action = { ...sub.action };
  for (const [k, v] of Object.entries(data.action)) { if (v === null) delete action[k]; else action[k] = v; }
  if (isJiraWrite(sub) && !create) {
    if (!action.to && !action.comment) throw new Error('A write moves the ticket, comments on it, or both');
    action.type = action.to ? 'transition' : 'comment';
  }
  const place = { ...sub.place };
  if (data.ref === null) delete place.ref; else if (data.ref) place.ref = data.ref;
  if (data.name) place.name = data.name;
  const on = data.on === undefined ? sub.on : data.on || undefined;
  const next = { action, place, on, review: data.review ?? sub.review };
  let stories = job.plan.stories;
  if (data.story) {
    stories = stories.map((t) => {
      if (t.id !== sub.storyId) return t;
      const story = { ...t, ...(data.story.title ? { title: data.story.title } : {}), ...(data.story.fields ? { fields: data.story.fields } : {}) };
      if (!story.fields?.length) delete story.fields;
      return story;
    });
    if (data.story.title) next.title = createTitle(data.story.title);
  }
  const spec = job.plan.subJobs.find((s) => s.id === sub.id);
  validatePlan({ ...job.plan, stories, subJobs: job.plan.subJobs.map((s) => (s === spec ? { ...s, ...next } : s)) });
  job.plan.stories = structuredClone(stories);
  for (const target of [sub, spec].filter(Boolean)) {
    Object.assign(target, structuredClone(next));
    for (const k of ['on', 'review']) if (target[k] === undefined) delete target[k];
  }
  sub.error = null; sub.blocked = null;
  return data;
}
export function editWrite(job, sub, payload) {
  const data = applyEdit(job, sub, payload);
  // A made output already exists: with review turned off it is accepted as it is.
  if (isMakeWrite(sub) && sub.stage === 'review') { if (!writeReviewed(job, sub)) finish(sub, sub.result); }
  else if (sub.stage === 'review' && (!writeReviewed(job, sub) || data.on !== undefined)) { sub.stage = 'write'; sub.state = 'queued'; }
  else if (sub.stage === 'write') sub.state = 'queued';
  return `Edited the write ${quoted(sub.title)}`;
}
