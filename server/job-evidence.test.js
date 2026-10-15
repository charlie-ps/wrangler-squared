import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './job-store.js';
import { planSchema, reportSchema, proofSchema, unansweredShow } from './jobs-schema.js';
import { inboxDir, roundDir, ensureInbox, adoptEvidence, thumbnailOf, readEvidence, sniffKind, evidenceName, EVIDENCE_MAX_BYTES } from './job-evidence.js';
import { makeEvidenceHandler } from './handlers.js';
import { jobPrompt, leavesUncommitted } from './job-prompts.js';
import { mergeReplan } from './job-replan.js';
import { fakeHost } from './test-helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpg body')]);
const GIF = Buffer.from('GIF89a gif body');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm body')]);
const SHOW = ['Lists the last 24h of sign-ins', 'Unit tests pass'];

const spec = (id, extra = {}) => ({ id, title: `Deliver ${id}`, kind: 'pr', repo: '/repo', after: [], brief: `Implement ${id}`, ...extra });
const planOf = (subs) => ({ context: 'ctx', stories: [], subJobs: subs });

// A running job with one PR sub-job in implementation and a run bound to a session.
function fixture(show = SHOW, jobExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-evidence-'));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const job = store.create({ title: 'Audit page', intent: 'Show sign-ins', repos: ['/repo'], ...jobExtra });
  store.update(job.id, (j) => {
    j.stage = 'active'; j.plan = planOf([spec('api', { show })]);
    j.subJobs = [{ ...spec('api', { show }), stage: 'implementation', state: 'running', sessions: ['sid'] }];
    j.runs = [{ id: 'run_1', subJobId: 'api', phase: 'implementation', startedAt: Date.now(), sessionId: 'sid', stopped: false, report: null }];
  });
  const inbox = ensureInbox(job.id, 'api');
  const put = (name, bytes) => fs.writeFileSync(path.join(inbox, name), bytes);
  const next = (id) => store.update(job.id, (j) => { j.runs.push({ id, subJobId: 'api', phase: 'implementation', startedAt: Date.now(), sessionId: 'sid', stopped: false, report: null }); });
  return { store, job, inbox, put, next, report: (payload, runId = 'run_1') => store.report('sid', runId, payload), sub: () => store.get(job.id).subJobs[0] };
}
const shotCheck = (text, file = 'list.png') => ({ text, shots: [{ file, url: 'http://localhost:5174/audit', viewport: '1280x800', tool: 'Playwright' }] });
const runCheck = (text) => ({ text, run: { cmd: 'npm test', out: '42 passed', exit: 0 } });

test('show is a list of one-line things to see on a PR sub-job, and nowhere else', () => {
  assert.deepEqual(planSchema.parse(planOf([spec('api', { show: SHOW })])).subJobs[0].show, SHOW);
  assert.equal(planSchema.parse(planOf([spec('api')])).subJobs[0].show, undefined, 'optional: a change with nothing to see lists none');
  assert.throws(() => planSchema.parse(planOf([spec('api', { show: ['x'.repeat(181)] })])));
  assert.throws(() => planSchema.parse(planOf([spec('api', { show: Array.from({ length: 9 }, (_, i) => `item ${i}`) })])));
  assert.throws(() => planSchema.parse(planOf([{ id: 's', kind: 'session', title: 'Spike', after: [], brief: 'x', show: ['a'] }])), /only a PR sub-job/);
  assert.doesNotThrow(() => planSchema.parse(planOf([{ id: 's', kind: 'session', title: 'Spike', after: [], brief: 'x', show: [] }])));
});

test('a proof check carries shots, a run or couldNot; couldNot is the whole answer; a bare check is a plain string', () => {
  assert.ok(proofSchema.parse(shotCheck('A')).shots[0].file);
  assert.deepEqual(proofSchema.parse({ text: 'A', shots: ['a.png', 'b.gif'] }).shots, ['a.png', 'b.gif']);
  assert.equal(proofSchema.parse(runCheck('B')).run.exit, 0);
  assert.equal(proofSchema.parse({ text: 'C', couldNot: 'No SSO key in this worktree' }).couldNot, 'No SSO key in this worktree');
  assert.throws(() => proofSchema.parse({ text: 'D' }), /shots, run or couldNot/);
  assert.throws(() => proofSchema.parse({ text: 'E', couldNot: 'no', run: { cmd: 'x', out: '', exit: 0 } }), /whole answer/);
  for (const file of ['../a.png', 'a/b.png', 'a.exe', '.hidden.png', 'a b.png']) assert.throws(() => proofSchema.parse({ text: 'F', shots: [file] }), undefined, file);
  assert.throws(() => proofSchema.parse({ text: 'G', run: { cmd: 'x', out: 'y'.repeat(4001), exit: 0 } }));
  assert.throws(() => proofSchema.parse({ text: 'H', shots: ['a.png'], extra: 1 }), 'strict, so a typo is named rather than dropped');
  assert.ok(reportSchema.parse({ kind: 'ready', checks: ['Lint clean', shotCheck('A')] }), 'plain strings and proof mix in one receipt');
  assert.throws(() => reportSchema.parse({ kind: 'ready', checks: [] }));
  assert.deepEqual(unansweredShow(['  A  thing ', 'B'], [{ text: 'a THING', couldNot: 'x' }, 'B']), ['B'], 'compared loosely, and a plain string does not answer');
});

test('magic bytes decide what a file is, and a name is a bare file name', () => {
  assert.deepEqual([PNG, JPG, GIF, WEBM].map((b) => sniffKind(b).mime), ['image/png', 'image/jpeg', 'image/gif', 'video/webm']);
  assert.equal(sniffKind(Buffer.from('<svg/>')), null);
  assert.equal(evidenceName('shot-1.PNG'), true);
  for (const n of ['../x.png', 'x.svg', 'a/b.png', '', 'x.png/', undefined]) assert.equal(evidenceName(n), false, String(n));
});

test('ready is refused until every Show me item has proof or a reason, naming what is missing, and leaves nothing behind', () => {
  const f = fixture();
  f.put('list.png', PNG);
  assert.throws(() => f.report({ kind: 'ready', checks: ['Tests pass'] }), /Show me: answer "Lists the last 24h of sign-ins", "Unit tests pass"/);
  assert.throws(() => f.report({ kind: 'ready', checks: ['Tests pass', 'Lists the last 24h of sign-ins', 'Unit tests pass'] }), /Show me: answer/, 'a plain string is a claim, not proof');
  assert.throws(() => f.report({ kind: 'ready', checks: [shotCheck('Lists the last 24h of sign-ins')] }), /Show me: answer "Unit tests pass"/);
  assert.equal(f.sub().ready, undefined);
  assert.equal(f.store.get(f.job.id).runs[0].report, null, 'a refused receipt is not recorded; the agent fixes it and reports again');
  assert.equal(fs.existsSync(roundDir(f.job.id, 'api', 1)), false);
  f.report({ kind: 'ready', checks: [shotCheck('lists the last 24h of sign-ins'), runCheck('Unit tests pass')] });
  assert.equal(f.sub().stage, 'review');
});

test('a ready receipt keeps its proof: files copied into round 1, shots resolved, plain checks left plain', () => {
  const f = fixture();
  f.put('list.png', PNG); f.put('run.gif', GIF); f.put('stray.png', PNG);
  f.report({ kind: 'ready', checks: ['Lint clean', { ...shotCheck('Lists the last 24h of sign-ins'), note: 'Seeded with 1,284 rows' }, { text: 'Unit tests pass', run: { cmd: 'npm test', out: '42 passed', exit: 0 }, shots: ['run.gif'] }] });
  const { ready } = f.sub();
  assert.deepEqual(ready.checks, ['Lint clean', 'Lists the last 24h of sign-ins', 'Unit tests pass'], 'every check keeps its text where the old list is read');
  assert.equal(ready.round, 1);
  assert.deepEqual(ready.proof.map((p) => p.text), ['Lists the last 24h of sign-ins', 'Unit tests pass'], 'only proof checks are proof');
  const [first, second] = ready.proof;
  assert.deepEqual([first.note, first.shots[0].file, first.shots[0].mime, first.shots[0].url, first.shots[0].viewport, first.shots[0].tool], ['Seeded with 1,284 rows', 'list.png', 'image/png', 'http://localhost:5174/audit', '1280x800', 'Playwright']);
  assert.ok(first.shots[0].at > 0, 'the time is the file\'s own, not the agent\'s say-so');
  assert.deepEqual([second.shots[0], second.run.exit].map((v) => v.file ?? v), ['run.gif', 0]);
  assert.deepEqual(fs.readdirSync(roundDir(f.job.id, 'api', 1)).sort(), ['list.png', 'run.gif'], 'only what the receipt named is kept');
  assert.deepEqual(fs.readFileSync(path.join(roundDir(f.job.id, 'api', 1), 'list.png')), PNG);
});

test('a reason is amber proof; a sub-job with nothing to show still keeps proof it chose to attach', () => {
  const f = fixture();
  f.report({ kind: 'ready', checks: [{ text: SHOW[0], couldNot: 'The SSO stub needs a key that is not in this worktree' }, runCheck(SHOW[1])] });
  assert.equal(f.sub().ready.proof[0].couldNot, 'The SSO stub needs a key that is not in this worktree');
  const g = fixture([]);
  g.put('a.jpg', JPG);
  g.report({ kind: 'ready', checks: ['Tests pass', shotCheck('Page renders', 'a.jpg')] });
  assert.equal(g.sub().ready.proof.length, 1);
  const h = fixture(undefined);
  h.report({ kind: 'ready', checks: [runCheck(SHOW[0]), runCheck(SHOW[1])] });
  const bare = fixture([]);
  bare.report({ kind: 'ready', checks: ['Tests pass'] });
  assert.equal(bare.sub().ready.proof, undefined, 'nothing to show, nothing attached: the old receipt is unchanged');
  assert.deepEqual(bare.sub().ready.checks, ['Tests pass']);
});

test('files are checked by their bytes, size and place before the receipt is accepted', () => {
  const f = fixture([]);
  const ready = (file) => f.report({ kind: 'ready', checks: [shotCheck('Page', file)] });
  assert.throws(() => ready('missing.png'), /missing\.png is not in \$JOB_EVIDENCE/);
  f.put('fake.png', Buffer.from('<svg>not a png</svg>'));
  assert.throws(() => ready('fake.png'), /fake\.png is not a PNG, JPEG, GIF or WebM/);
  f.put('renamed.gif', PNG);
  assert.throws(() => ready('renamed.gif'), /renamed\.gif is not a PNG/, 'a PNG called .gif is refused, whatever it says');
  f.put('big.png', Buffer.concat([PNG, Buffer.alloc(EVIDENCE_MAX_BYTES)]));
  assert.throws(() => ready('big.png'), /big\.png is over 5 MB/);
  fs.mkdirSync(path.join(f.inbox, 'dir.png'));
  assert.throws(() => ready('dir.png'), /regular file/);
  fs.symlinkSync(path.join(f.inbox, 'fake.png'), path.join(f.inbox, 'link.png'));
  assert.throws(() => ready('link.png'), /regular file/, 'a link could point anywhere on disk');
  f.put('clip.webm', WEBM);
  ready('clip.webm');
  assert.equal(f.sub().ready.proof[0].shots[0].mime, 'video/webm');
});

test('a rework is a new round: its files sit beside round 1, which keeps what the human read', () => {
  const f = fixture();
  f.put('list.png', PNG);
  f.report({ kind: 'ready', checks: [shotCheck(SHOW[0]), runCheck(SHOW[1])] });
  f.store.update(f.job.id, (j) => { j.subJobs[0].stage = 'implementation'; j.subJobs[0].ready = null; });
  f.next('run_2');
  f.put('list2.jpg', JPG);
  f.report({ kind: 'ready', checks: [shotCheck(SHOW[0], 'list2.jpg'), runCheck(SHOW[1])] }, 'run_2');
  assert.equal(f.sub().ready.round, 2);
  assert.deepEqual(fs.readFileSync(path.join(roundDir(f.job.id, 'api', 1), 'list.png')), PNG, 'round 1 is untouched');
  assert.deepEqual(fs.readFileSync(path.join(roundDir(f.job.id, 'api', 2), 'list2.jpg')), JPG);
  assert.equal(f.sub().ready.proof[0].shots[0].mime, 'image/jpeg');
});

test('an identical retry of an accepted receipt is safe and copies nothing twice', () => {
  const f = fixture();
  f.put('list.png', PNG);
  const receipt = { kind: 'ready', checks: [shotCheck(SHOW[0]), runCheck(SHOW[1])] };
  f.report(receipt);
  fs.rmSync(path.join(f.inbox, 'list.png'));
  assert.doesNotThrow(() => f.report(receipt));
  assert.equal(f.sub().ready.round, 1);
});

test('adoptEvidence resolves a bare name and an object alike, and a thumbnail is cut once through sips', async () => {
  const f = fixture();
  f.put('a.png', PNG); f.put('b.jpg', JPG);
  const out = adoptEvidence({ jobId: f.job.id, subId: 'api', round: 1, proof: [{ text: 'A', shots: ['a.png', { file: 'b.jpg', tool: 'Chrome' }] }] });
  assert.deepEqual(out[0].shots.map((s) => [s.file, s.mime, s.tool]), [['a.png', 'image/png', undefined], ['b.jpg', 'image/jpeg', 'Chrome']]);
  const calls = [];
  const run = async (bin, args) => { calls.push([bin, ...args]); fs.writeFileSync(args.at(-1), JPG); };
  const first = await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: 'a.png', run });
  assert.equal(first.mime, 'image/jpeg');
  assert.deepEqual(calls[0].slice(0, 6), ['sips', '-s', 'format', 'jpeg', '-Z', '320']);
  await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: 'a.png', run });
  assert.equal(calls.length, 1, 'cut once, then read from disk');
  assert.equal(await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: 'a.png', run: async () => { throw new Error('no sips'); } }) !== null, true, 'the kept thumbnail wins');
  adoptEvidence({ jobId: f.job.id, subId: 'api', round: 1, proof: [{ text: 'V', shots: ['clip.webm'] }].map((p) => { fs.writeFileSync(path.join(f.inbox, 'clip.webm'), WEBM); return p; }) });
  assert.equal(await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: 'clip.webm', run }), null, 'video is never thumbnailed');
  assert.equal(await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: 'b.jpg', run: async () => { throw new Error('sips failed'); } }), null, 'a failure is a placeholder, not an error');
  assert.equal(await thumbnailOf({ jobId: f.job.id, subId: 'api', round: 1, file: '../x.png', run }), null);
  assert.equal(readEvidence({ jobId: f.job.id, subId: 'api', round: 1, file: 'a.png' }).bytes.equals(PNG), true);
  assert.equal(readEvidence({ jobId: f.job.id, subId: 'api', round: 9, file: 'a.png' }), null);
  assert.equal(readEvidence({ jobId: f.job.id, subId: 'api', round: 1, file: '../../jobs.json' }), null);
});

test('job-evidence broadcasts the round\'s thumbnails, or one full file when a shot is opened', async () => {
  const { host, broadcasts } = fakeHost();
  const job = host.stores.jobs.create({ title: 'Audit', intent: 'Show it' });
  host.stores.jobs.update(job.id, (j) => { j.subJobs = [{ id: 'api', ready: { round: 1, proof: [{ text: 'A', shots: [{ file: 'a.png' }, { file: 'clip.webm' }] }, { text: 'B', run: { cmd: 'x', out: '', exit: 0 } }] } }, { id: 'web' }]; });
  const inbox = ensureInbox(job.id, 'api');
  fs.writeFileSync(path.join(inbox, 'a.png'), PNG); fs.writeFileSync(path.join(inbox, 'clip.webm'), WEBM);
  adoptEvidence({ jobId: job.id, subId: 'api', round: 1, proof: [{ text: 'A', shots: ['a.png', 'clip.webm'] }] });
  const sips = async (bin, args) => fs.writeFileSync(args.at(-1), JPG);
  const { handler } = makeEvidenceHandler({ run: sips });
  await handler.call(null, { id: job.id, subJobId: 'api' }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-evidence', jobId: job.id, subJobId: 'api', round: 1, thumbs: [{ file: 'a.png', mime: 'image/jpeg', dataBase64: JPG.toString('base64') }] },
    'the video has no thumbnail, and a run has no file');
  await makeEvidenceHandler().handler({ id: job.id, subJobId: 'api', round: 1, file: 'clip.webm' }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-evidence', jobId: job.id, subJobId: 'api', round: 1, file: 'clip.webm', mime: 'video/webm', dataBase64: WEBM.toString('base64') });
  await makeEvidenceHandler().handler({ id: job.id, subJobId: 'api', round: 1, file: '../../jobs.json' }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-evidence', jobId: job.id, subJobId: 'api', round: 1, file: '../../jobs.json' }, 'a path is never read');
  await makeEvidenceHandler().handler({ id: job.id, subJobId: 'web' }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-evidence', jobId: job.id, subJobId: 'web', round: undefined, thumbs: [] });
  const before = broadcasts.length;
  await makeEvidenceHandler().handler({ id: job.id, subJobId: 'ghost' }, host);
  assert.equal(broadcasts.length, before);
});

test('the implementer is told to show each item working, where to save proof and what the receipt looks like', () => {
  const job = { id: 'job_12345678', title: 'Audit', agent: 'claude', reviewCode: true, subJobs: [], runs: [], plan: { context: 'c' } };
  const sub = spec('api', { show: SHOW, after: [] });
  const text = jobPrompt(job, sub, { id: 'run1', phase: 'implementation' });
  assert.match(text, new RegExp(`export JOB_EVIDENCE=.*${inboxDir(job.id, 'api').split('/').slice(-3).join('/')}`));
  assert.match(text, /- "Lists the last 24h of sign-ins"\n- "Unit tests pass"/);
  assert.match(text, /whose text is EXACTLY the item/);
  assert.match(text, /RUNNING build, never a mock-up: Playwright by default.*Claude in Chrome/);
  assert.match(text, /couldNot:"why you could not/);
  assert.match(text, /LEAVE RUNNING for the human to try/);
  assert.match(text, /A receipt that leaves an item out is refused/);
  const none = jobPrompt(job, { ...sub, show: undefined }, { id: 'run1', phase: 'implementation' });
  assert.match(none, /lists nothing it must show/);
  assert.doesNotMatch(jobPrompt(job, sub, { id: 'run1', phase: 'publish' }), /JOB_EVIDENCE/, 'only the run that builds it shows it');
});

test('Code on Auto still asks for ready when there is something to show, so the proof is kept', () => {
  const sub = spec('api', { show: SHOW });
  const auto = { id: 'job_12345678', title: 'A', agent: 'claude', reviewCode: false, subJobs: [], runs: [], plan: { context: 'c' } };
  assert.equal(leavesUncommitted(auto, sub), true);
  assert.equal(leavesUncommitted(auto, spec('api')), false);
  assert.equal(leavesUncommitted({ ...auto, reviewCode: true }, spec('api')), true);
  const text = jobPrompt(auto, sub, { id: 'run1', phase: 'implementation' });
  assert.match(text, /Leave every change UNCOMMITTED: a later step commits and pushes it/);
  assert.doesNotMatch(text, /the human reviews the working tree/, 'nobody reads it first on Auto');
  assert.match(text, /kind:"ready"/);
  assert.match(jobPrompt(auto, spec('api'), { id: 'run1', phase: 'implementation' }), /kind:"published"/);
});

test('the planner is told to write show as things to see, and a replan may change it like check', () => {
  const planning = jobPrompt({ id: 'job_1', title: 'T', intent: 'I', repos: [], subJobs: [], runs: [] }, null, { id: 'run1', phase: 'planning' });
  assert.match(planning, /`show`: 1–6 lines, written as THINGS TO SEE/);
  assert.match(planning, /show\?:\["a thing to see"\]/);
  const j = { plan: planOf([spec('a', { show: ['One'] }), spec('b')]), subJobs: [{ ...spec('a'), stage: 'implementation' }, { ...spec('b'), stage: 'implementation' }], runs: [] };
  const { changes, plan } = mergeReplan(j, planOf([spec('a', { show: ['One', 'Two'] }), spec('b', { show: [] })]));
  assert.deepEqual(changes.edited, [{ id: 'a', fields: ['show'] }], 'an empty list is no list: b is unchanged');
  assert.deepEqual(plan.subJobs.map((s) => s.show), [['One', 'Two'], undefined]);
  assert.throws(() => mergeReplan({ ...j, subJobs: [{ ...spec('a'), stage: 'done' }, j.subJobs[1]] }, planOf([spec('a', { show: ['Different'] }), spec('b')])), /has already landed/);
});

test('an implementation launch is granted its proof inbox, and a Codex job on Full access needs no grant', async () => {
  const { JobRuntime } = await import('./job-runtime.js');
  for (const [agent, sandbox, granted] of [['claude', undefined, true], ['codex', 'auto', true], ['codex', 'locked', true], ['codex', 'full', false]]) {
    const { host, spawned } = fakeHost();
    const runtime = new JobRuntime({ host }, async (bin, args) => (args[0] === 'rev-parse' ? 'base' : bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : ''));
    const job = { id: 'job_00000000abcd1234', title: 'T', agent, sandbox, model: '', effort: '' };
    await runtime.launch(job, { id: 'api', repo: '/repos/thing', brief: 'x' }, { id: 'run_1', phase: 'implementation' }, () => {});
    assert.deepEqual(spawned[0].addDirs, granted ? [inboxDir(job.id, 'api')] : undefined, `${agent}/${sandbox}`);
    assert.ok(!granted || fs.statSync(inboxDir(job.id, 'api')).isDirectory(), 'created first: a missing --add-dir fails the launch');
  }
  const { host, spawned } = fakeHost();
  const runtime = new JobRuntime({ host }, async () => '');
  await runtime.launch({ id: 'job_00000000abcd1234', agent: 'claude', title: 'T' }, { id: 'api', repo: '/repos/thing', brief: 'x', worktree: { path: process.cwd(), branch: 'b', repoRoot: '/repos/thing' } }, { id: 'run_2', phase: 'publish' }, () => {});
  assert.equal(spawned[0].addDirs, undefined, 'publish shows nothing');
});
