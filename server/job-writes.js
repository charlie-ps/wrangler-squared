import { z } from 'zod';
import { line, commentSchema, storyFieldSchema, isWriteSub, isPrSub, isHumanSub, isStoryCreate, isMakeWrite, isJiraWrite, placeOf, awaitsTicket, storyProject, writeReviewed, WRITE_REF, placeNameSchema, storyCreateTitle } from './jobs-schema.js';
import { dropSub, keyStory, validatePlan } from './job-sub-ops.js';

// Writes (a `write` sub-job, jobs-schema.js): one write to one place outside the
// board, made by the session sub-job it names (`by`). Pure over the job draft
// the store is about to persist, like job-sub-ops.js. The session's prompt lists
// every open write it owns (job-prompts.js) and its `completed` receipt must
// answer for each one (`applyWrites`), or it is refused whole and the session
// fixes it. A milestone is the session's (`on`, `triggerStatus`), so the
// session — and every write it owns — waits for it.
//
// A reviewed write that is not a made output is drafted, not made: the session
// reports `drafts` mid-run and its run is parked (`run.parkedAt`) while each
// draft waits in review for Write (with the human's edits) or Skip. Once every
// draft is decided the runner mails the session the final writes
// (job-prompts.js `draftsDecidedMail`) and it makes them and completes.
//
// stage `write`:  queued (its session has not made it) or approved (drafted and
//                 approved; its session makes it next) → cleanup/done, or failed
// stage `review`: verified, until Write / Edit / Skip; a made output stops here
//                 AFTER it is published (it has its result), until Accept
const quoted = (title) => `“${title}”`;
const FINISHED = ['cleanup', 'done'];
export const PLACE_NAME = { jira: 'Jira', slack: 'Slack', confluence: 'Confluence', artifact: 'the artifact', file: 'the file', url: 'the web page' };
export const placeName = (sub) => placeOf(sub) === 'other' ? sub.place?.name || 'the place' : PLACE_NAME[placeOf(sub)];
export const sessionOf = (job, w) => (w?.by ? job.subJobs.find((s) => s.id === w.by) : null) || null;
const triggerOf = (job, session) => session?.on ? job.subJobs.find((s) => s.id === session.on.sub) || null : null;
// A write planned before every write lived on a session has no `by`: it was
// fired by the batched writer this extension no longer has. The store fails it
// on load (job-store.js) rather than guessing a session for it.
export const LEGACY_WRITE = 'This write predates session-owned writes; drop it or redo it by hand';
export const isLegacyWrite = (sub) => isWriteSub(sub) && !sub.by;

// Whether a trigger has reached a milestone. Started is any session having run
// for it (a human task marked in progress counts); merged includes a PR marked
// done by hand; deployed is the same bar `after` holds a dependant to (a
// session rerun only for its writes has already done its work).
export function milestoneReached(t, at) {
  if (!t) return false;
  if (at === 'dropped') return !!t.cancelledAt;
  if (at === 'started') return (t.sessions || []).length > 0 || !!t.pr || (isHumanSub(t) && t.state === 'doing')
    || (!t.cancelledAt && !['implementation', 'session', 'human'].includes(t.stage));
  if (at === 'pr') return !!t.pr;
  if (at === 'merged') return !!t.mergedAt || (isPrSub(t) && !!t.deployed);
  return !t.cancelledAt && (isPrSub(t) ? !!t.deployed : FINISHED.includes(t.stage) || !!t.writesOnly);
}

// Where a session with a milestone stands this tick: `wait` for it, `due`,
// `dead` (its trigger was dropped before getting there: the prerequisite-dropped
// treatment), or `not-needed` — an if-dropped session whose trigger landed
// instead, which the runner drops. A session with no `on` is always due.
export function triggerStatus(job, session) {
  if (!session?.on) return 'due';
  const t = triggerOf(job, session);
  if (session.on.at === 'dropped') {
    if (!t?.cancelledAt && milestoneReached(t, 'deployed')) return 'not-needed';
    return t?.cancelledAt ? 'due' : 'wait';
  }
  if (milestoneReached(t, session.on.at)) return 'due';
  return !t || t.cancelledAt ? 'dead' : 'wait';
}

// Every write a session owns, and the ones its receipt still has to answer for.
export const ownedWrites = (job, session) => (job.subJobs || []).filter((w) => isWriteSub(w) && !!session && w.by === session.id);
export const openWrites = (job, session) => ownedWrites(job, session).filter((w) => !w.cancelledAt && w.stage === 'write' && ['queued', 'approved'].includes(w.state) && !w.error);
// The reviewed writes it must draft before it may make them.
export const toDraft = (job, session) => openWrites(job, session).filter((w) => !isMakeWrite(w) && writeReviewed(job, w) && !w.writeApprovedAt);
// The writes a run was told to draft: fixed when it was claimed (`run.drafting`,
// job-store.js), so a Writes switch mid-run changes the next launch, never the
// prompt this one is working to. A run from before the field reads the job.
export const draftingFor = (job, run, session) => (run?.drafting
  ? openWrites(job, session).filter((w) => run.drafting.includes(w.id) && !isMakeWrite(w) && !w.writeApprovedAt) : toDraft(job, session));
// Drafted and still with the human: the session is not run again until each is decided.
export const inReview = (job, session) => ownedWrites(job, session).filter((w) => !w.cancelledAt && !isMakeWrite(w) && w.stage === 'review');
// A session writing to a story nobody has created yet waits for its key, as a
// PR naming that story does — unless it owns that story's create itself, which
// it makes first: waiting there would wait on its own receipt forever.
const createOf = (job, storyId) => (job.subJobs || []).find((w) => isStoryCreate(w) && w.storyId === storyId && !w.cancelledAt);
export const awaitsKeys = (job, session) => openWrites(job, session).some((w) => awaitsTicket(w) && createOf(job, w.storyId)?.by !== session.id);

// A write lives and dies with its session: dropped with it, and failed (the
// human's to mark done, or drop) if the session finished without reporting it —
// marked done by hand, say. One tick's step; returns whether it changed.
export function advanceWrite(job, sub, now) {
  if (!isWriteSub(sub) || sub.stage !== 'write' || !['queued', 'approved'].includes(sub.state) || sub.error || sub.cancelledAt || isLegacyWrite(sub)) return false;
  const session = sessionOf(job, sub);
  if (!session || session.cancelledAt) { dropSub(sub, now, job); return true; }
  if (!FINISHED.includes(session.stage)) return false;
  sub.state = 'failed'; sub.error = `${session.title} finished without reporting it`; sub.blocked = null;
  return true;
}

// Where a write's place is once it exists: the permalink its result carried,
// else a ticket's browse URL on the site the planner read.
export function writeUrl(job, sub) {
  if (sub?.result?.url) return sub.result.url;
  const key = isJiraWrite(sub) && (sub.jiraKey || sub.result?.key);
  const site = job.plan?.jiraSite;
  return key && site ? `${site.replace(/\/$/, '')}/browse/${key}` : null;
}
// {pr.url}, {pr.title} and {deploy.run} come from the session's trigger as it
// stands, {<write id>.url} from that write's place. A write the same session has
// still to make is named for the session to fill in (`ahead`, the prompt's
// view); anything else with nothing to fill says so rather than posting a brace.
export function fillText(job, sub, text, ahead = null) {
  if (!text) return null;
  const t = triggerOf(job, sessionOf(job, sub));
  const runs = t?.deploymentResult?.runs || [];
  const values = { 'pr.url': t?.pr?.url, 'pr.title': t?.pr?.title || t?.title, 'deploy.run': (runs.find((r) => r.status === 'passing') || runs[0])?.url };
  return text.replace(/\{(pr\.url|pr\.title|deploy\.run)\}/g, (_, k) => values[k] || '(not available)')
    .replace(WRITE_REF, (brace, ref) => {
      const w = job.subJobs.find((s) => s.id === ref);
      const url = writeUrl(job, w);
      if (url) return url;
      return ahead && w && w.by === sub.by && !w.cancelledAt ? ahead(w, brace) : '(not available)';
    });
}
const storyOf = (job, sub) => job.plan?.stories.find((t) => t.id === sub.storyId) || null;
const makeFirst = (w, brace) => `${brace} (the URL of write ${w.id}, which you make first: put it here yourself)`;
// The write as its session is given it: everything it needs to read the place
// first and make exactly this change. `approved` is a draft the human approved,
// as they left it: make it exactly so.
export function writeBrief(job, sub) {
  const a = sub.action;
  const tail = { ...(sub.writeApprovedAt ? { approved: true } : {}), ...(sub.why ? { why: sub.why } : {}) };
  const fill = (text) => fillText(job, sub, text, makeFirst);
  const where = { ...(sub.place?.name ? { name: sub.place.name } : {}), ...(sub.place?.ref ? { where: sub.place.ref } : {}) };
  if (isMakeWrite(sub)) return { id: sub.id, place: placeOf(sub), ...where, write: 'make', what: a.what, ...tail };
  if (!isJiraWrite(sub)) {
    return { id: sub.id, place: placeOf(sub), ...where, write: a.type, ...(a.title ? { title: a.title } : {}), ...(a.text ? { text: fill(a.text) } : {}), ...tail };
  }
  const story = storyOf(job, sub);
  // Only a create carries the story to make; a write to a ticket its own session
  // creates first names that create, not a story it would read as one to make.
  const create = !sub.jiraKey && !isStoryCreate(sub) ? createOf(job, sub.storyId) : null;
  const ticket = sub.jiraKey || (create ? `the ticket ${create.id} creates` : null);
  return { id: sub.id, place: 'jira', ticket, ...(sub.jiraKey || create ? {} : { story: story?.title, project: storyProject(story), ...(story?.fields?.length ? { fields: story.fields } : {}) }),
    write: a.type, ...(a.to ? { to: a.to } : {}), ...(a.comment ? { comment: fill(a.comment) } : {}), ...tail };
}

function doneLine(sub, r) {
  const a = sub.action;
  if (isMakeWrite(sub)) return `Made ${r.title || r.url}`;
  if (!isJiraWrite(sub)) {
    const what = { post: `Posted in ${sub.place?.ref}`, create: `Created “${a.title}”`, comment: 'Commented on the page', write: `Wrote to ${placeName(sub)}` }[a.type];
    return r.outcome === 'already' ? `Already there: ${what[0].toLowerCase()}${what.slice(1)}` : what;
  }
  if (r.outcome === 'already') return `${sub.jiraKey || r.key} was already ${a.to ? `at or past ${a.to}` : 'there'}${a.comment ? '; comment posted' : ''}`;
  return a.type === 'create' ? `Created ${r.key}` : `${sub.jiraKey}${a.to ? ` moved to ${a.to}` : ''}${a.comment ? `${a.to ? ';' : ''} comment posted` : ''}`;
}
const finish = (sub, result) => { sub.result = result; sub.stage = 'cleanup'; sub.state = 'queued'; sub.error = null; sub.blocked = null; };
// The receipt shape before every write lived on a session, from a session
// launched with that prompt: an output's link, or why it is missing.
const fromOutputs = (outputs = []) => outputs.map((o) => (o.missing ? { id: o.id, outcome: 'failed', error: o.missing } : { id: o.id, outcome: 'written', url: o.url, ...(o.title ? { title: o.title } : {}) }));
export const WRITE_RESULT_SHAPE = 'writes:[{id, outcome:"written"|"already"|"failed", url?, key?, from?, title?, error?}]';

// A session's `completed` receipt answers for every open write it owns, and only
// those. Checked whole before anything moves, so a rejected receipt changes
// nothing and the session can correct it in the same run. A write dropped or
// marked done while it worked may still be reported; that answer is ignored.
// A reviewed made output stops in review once it exists: there is no draft to
// show, and a second session to publish it would only repeat the first.
export function applyWrites(job, run, session, report, now) {
  const asked = openWrites(job, session);
  const owned = ownedWrites(job, session);
  const results = [...(report.writes || []), ...fromOutputs(report.outputs)];
  const told = new Set(draftingFor(job, run, session).map((w) => w.id));
  const undrafted = toDraft(job, session).filter((w) => told.has(w.id)).map((w) => w.id);
  if (undrafted.length) throw new Error(`Review is on for ${undrafted.join(', ')}: report them as kind:"drafts" first, then wait for mail with the human's decision`);
  const seen = new Set();
  for (const r of results) {
    const w = owned.find((x) => x.id === r.id);
    if (!w) throw new Error(`${r.id} is not one of the writes this session makes`);
    if (seen.has(r.id)) throw new Error(`${r.id} is reported twice`);
    seen.add(r.id);
    if (!asked.includes(w) || r.outcome === 'failed') continue;
    if (r.url && placeOf(w) === 'file' && /^https?:/.test(r.url)) throw new Error(`${r.id}: give the file's absolute path`);
    if (r.url && !['file', 'other'].includes(placeOf(w)) && !/^https?:/.test(r.url)) throw new Error(`${r.id}: give its https link`);
    if (isMakeWrite(w) && !r.url) throw new Error(`${r.id}: say where it is (url), or report it failed with why`);
    if (isStoryCreate(w) && !r.key) throw new Error(`${r.id}: report the key of the story`);
  }
  const missing = asked.filter((w) => !seen.has(w.id)).map((w) => w.id);
  if (missing.length) throw new Error(`Report ${WRITE_RESULT_SHAPE} for every write you make; still missing: ${missing.join(', ')}`);
  const made = [];
  for (const r of results) {
    const w = asked.find((x) => x.id === r.id);
    if (!w) continue;
    if (r.outcome === 'failed') { w.state = 'failed'; w.error = r.error || (isMakeWrite(w) ? 'The session did not make it' : `${placeName(w)} refused the write`); w.blocked = null; continue; }
    if (isStoryCreate(w)) keyStory(job, w.storyId, r.key);
    const result = { outcome: r.outcome, checks: r.checks || [doneLine(w, r)], ...(r.from ? { from: r.from } : {}), ...(r.key ? { key: r.key } : {}),
      ...(r.url ? { url: r.url } : {}), ...(r.title ? { title: r.title } : {}), at: now, receiptId: run.id };
    if (isMakeWrite(w) && writeReviewed(job, w)) { w.result = result; w.stage = 'review'; w.state = 'verified'; w.error = null; w.blocked = null; } else finish(w, result);
    made.push(w);
  }
  // Filled once every write in the receipt has its place, so one linking a
  // page made in the same session records that page's URL.
  for (const w of made) {
    const text = w.action.comment || w.action.text;
    if (text) w.result.text = fillText(job, w, text);
  }
}

// The session's drafts of the reviewed writes it owns: exactly those, each laid
// onto its write the way the human's own edit would be (and validated the same
// way), then held in review. A draft the plan's rules refuse is refused to the
// session, which can still fix it. One no longer reviewed (Writes switched to
// Auto while the session worked to its draft-first prompt) is approved as it
// lands, as a ready receipt is under Code on Auto: the caller records the
// [write, detail] pairs returned, and a run with nothing left in review is
// mailed on the next tick.
export function applyDrafts(job, run, session, report, now) {
  const asked = draftingFor(job, run, session);
  const seen = new Set();
  for (const d of report.drafts) {
    if (!asked.some((w) => w.id === d.id)) throw new Error(`${d.id} is not a reviewed write of yours still to draft; draft only ${asked.map((w) => w.id).join(', ') || 'none'}`);
    if (seen.has(d.id)) throw new Error(`${d.id} is drafted twice`);
    seen.add(d.id);
  }
  const missing = asked.filter((w) => !seen.has(w.id)).map((w) => w.id);
  if (missing.length) throw new Error(`Draft every reviewed write in one drafts receipt; still missing: ${missing.join(', ')}`);
  for (const d of report.drafts) {
    const w = asked.find((x) => x.id === d.id);
    const { id: _, where, fields, title, ...action } = d;
    if (!isStoryCreate(w) && fields) throw new Error(`${d.id}: only a story's create has fields`);
    const story = { ...(title ? { title } : {}), ...(fields ? { fields } : {}) };
    reshape(job, w, isStoryCreate(w) ? (Object.keys(story).length ? { story } : {}) : { action: { ...action, ...(title ? { title } : {}) }, ...(where ? { ref: where } : {}) });
    w.draft = { ...d, at: now, receiptId: run.id };
    w.stage = 'review'; w.state = 'verified'; w.error = null; w.blocked = null;
  }
  run.drafts = report.drafts.map((d) => d.id);
  run.parkedAt = now;
  return asked.filter((w) => !writeReviewed(job, w)).map((w) => [w, approveWrite(job, w, now)]);
}
// Every draft the parked run is waiting on has been approved, skipped or dropped.
export const draftsDecided = (job, run) => !!run.parkedAt && !run.mailedAt && !run.stopped
  && (run.drafts || []).every((id) => { const w = job.subJobs.find((s) => s.id === id); return !w || w.cancelledAt || w.stage !== 'review'; });

// Write: approval of the write on display, with the human's edits applied in
// the same change (the review panel IS the editor), so a refused edit approves
// nothing; its session makes it next. A made output is already published:
// Accept finishes it as it is. Skip finishes a write unwritten.
export function approveWrite(job, sub, now, edit = null) {
  if (!isWriteSub(sub) || sub.stage !== 'review' || sub.error) throw new Error('This write is not waiting for review');
  const data = edit ? applyEdit(job, sub, edit) : null;
  sub.writeApprovedAt = now;
  if (isMakeWrite(sub)) { finish(sub, sub.result); return `Accepted the output ${quoted(sub.title)}`; }
  sub.stage = 'write'; sub.state = 'approved';
  return `Approved the write ${quoted(sub.title)}${data ? ' with edits' : ''}`;
}
export function skipWrite(sub, now) {
  if (!isWriteSub(sub) || sub.stage !== 'review') throw new Error('This write is not waiting for review');
  if (isMakeWrite(sub)) throw new Error('It is already made; drop it instead');
  finish(sub, { outcome: 'skipped', checks: [`Skipped; nothing written to ${placeName(sub)}`], at: now, receiptId: null });
  return `Skipped the write ${quoted(sub.title)}`;
}

// A failed write is made again by its session: retried, it reopens and its
// session runs again (one waiting on review goes back to work). A session that
// has already finished runs once more for its open writes alone (`writesOnly`:
// its prompt gives its work as done, job-prompts.js) and goes straight back to
// cleanup on its receipt, with no second review of work nobody redid. A
// session scratch workspace is fresh per run, so nothing cleanup removed is
// needed again. A dropped session is gone: the write is the human's to make by
// hand and mark done, or drop.
export function reopenWrite(job, sub) {
  if (isLegacyWrite(sub)) throw new Error(LEGACY_WRITE);
  const session = sessionOf(job, sub);
  if (!session || session.cancelledAt) throw new Error('Its session was dropped; make it by hand and mark it done, or drop it');
  if (job.runs.some((r) => !r.stopped && r.subJobId === session.id)) throw new Error('Wait for its session to stop');
  sub.error = null; sub.blocked = null; sub.state = sub.writeApprovedAt ? 'approved' : 'queued';
  if (session.stage === 'review') { session.stage = 'session'; session.state = 'queued'; session.result = null; }
  else if (FINISHED.includes(session.stage)) {
    session.writesOnly ??= { from: session.stage };
    session.stage = 'session'; session.state = 'queued'; session.error = null; session.blocked = null;
  }
}

// Edit (in review, or waiting for its session), Pick another status (failed),
// Turn review on: one action, the fields it changes. In `action`, null removes
// a field and absent leaves it; a write keeps its type (a Jira one is a
// transition or a comment by whether it still moves the ticket). `story` is a
// create write's: the story it creates (title, fields replaced whole), which is
// the plan's, so the sub-jobs naming it read the same one.
export const writeEditSchema = z.object({
  action: z.object({ to: line.nullable().optional(), comment: commentSchema.nullable().optional(), text: commentSchema.nullable().optional(),
    title: line.nullable().optional(), what: line.nullable().optional() }).strict().default({}),
  ref: z.string().trim().min(1).max(500).nullable().optional(), name: placeNameSchema.optional(),
  review: z.boolean().optional(),
  story: z.object({ title: line.optional(), fields: z.array(storyFieldSchema).max(25).optional() }).strict().optional(),
}).strict();
function applyEdit(job, sub, payload) {
  if (!isWriteSub(sub)) throw new Error('Only a write can be edited this way');
  if (sub.cancelledAt || FINISHED.includes(sub.stage)) throw new Error('This write has already finished');
  if (isLegacyWrite(sub)) throw new Error(LEGACY_WRITE);
  // Its session may be making it as it stands, or about to be told to.
  if (sub.stage === 'write' && job.runs.some((r) => !r.stopped && r.subJobId === sub.by)) throw new Error('Wait for its session to finish');
  const data = writeEditSchema.parse(payload);
  if (isMakeWrite(sub) && sub.stage === 'review' && (Object.keys(data.action).length || data.ref !== undefined || data.name !== undefined)) throw new Error('It is already made; accept it or drop it');
  reshape(job, sub, data);
  sub.error = null; sub.blocked = null;
  return data;
}
// Validated against the plan it would produce, then applied to the write and its
// plan entry alike; where the write then stands is the caller's.
function reshape(job, sub, data) {
  const create = isStoryCreate(sub);
  if (create && (Object.keys(data.action || {}).length || data.ref !== undefined || data.name !== undefined)) throw new Error('A create write can only change its story and whether it is reviewed');
  if (data.story && !create) throw new Error('Only the write that creates a story can edit it');
  const action = { ...sub.action };
  for (const [k, v] of Object.entries(data.action || {})) { if (v === null) delete action[k]; else action[k] = v; }
  if (isJiraWrite(sub) && !create) {
    if (!action.to && !action.comment) throw new Error('A write moves the ticket, comments on it, or both');
    action.type = action.to ? 'transition' : 'comment';
  }
  const place = { ...sub.place };
  if (data.ref === null) delete place.ref; else if (data.ref) place.ref = data.ref;
  if (data.name) place.name = data.name;
  const next = { action, place, review: data.review ?? sub.review };
  let stories = job.plan.stories;
  if (data.story) {
    stories = stories.map((t) => {
      if (t.id !== sub.storyId) return t;
      const story = { ...t, ...(data.story.title ? { title: data.story.title } : {}), ...(data.story.fields ? { fields: data.story.fields } : {}) };
      if (!story.fields?.length) delete story.fields;
      return story;
    });
    if (data.story.title) next.title = storyCreateTitle(data.story.title);
  }
  const spec = job.plan.subJobs.find((s) => s.id === sub.id);
  validatePlan({ ...job.plan, stories, subJobs: job.plan.subJobs.map((s) => (s === spec ? { ...s, ...next } : s)) });
  job.plan.stories = structuredClone(stories);
  for (const target of [sub, spec].filter(Boolean)) {
    Object.assign(target, structuredClone(next));
    if (target.review === undefined) delete target.review;
  }
}
export function editWrite(job, sub, payload, now = Date.now()) {
  const failed = sub?.state === 'failed';
  applyEdit(job, sub, payload);
  // A made output already exists: with review turned off it is accepted as it
  // is. A draft with review turned off is approved as it now stands.
  if (isMakeWrite(sub) && sub.stage === 'review') { if (!writeReviewed(job, sub)) finish(sub, sub.result); }
  else if (sub.stage === 'review' && !writeReviewed(job, sub)) { sub.writeApprovedAt = now; sub.stage = 'write'; sub.state = 'approved'; }
  else if (failed) reopenWrite(job, sub);
  return `Edited the write ${quoted(sub.title)}`;
}
