import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOpenIdeHandler, jobImagesHandler, jobSettingsHandler, makeFeatureRequestHandlers } from './handlers.js';
import { fakeHost } from './test-helpers.js';
import { ideasDir, roundDir } from './job-evidence.js';

// The launcher is `open -na <app> --args <worktree>`: an app NAME and a path,
// never a shell, so the setting cannot smuggle flags or a command in.
function ideFixture({ platform = 'darwin', fail = null } = {}) {
  const calls = [];
  const execFile = (cmd, args, cb) => { calls.push([cmd, ...args]); cb(fail, '', fail ? 'Unable to find application named' : ''); };
  const handler = makeOpenIdeHandler({ execFile, platform });
  const { host, broadcasts } = fakeHost();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const job = host.stores.jobs.create({ title: 'Sign-in', intent: 'Reliable sign-in' });
  host.stores.jobs.update(job.id, (j) => { j.subJobs = [{ id: 'api', worktree: { path: dir, branch: 'fix/AUTH-1' } }, { id: 'web' }]; });
  return { handler, host, broadcasts, calls, job, dir };
}

test('the IDE button opens the sub-job worktree with open -na and the configured app, then tells the board', async () => {
  const f = ideFixture();
  await f.handler.handler({ id: f.job.id, subJobId: 'api' }, f.host);
  assert.deepEqual(f.calls, [['open', '-na', 'IntelliJ IDEA', '--args', f.dir]], 'default app when the setting predates the field');
  assert.deepEqual(f.broadcasts.at(-1), { event: 'job-ide-opened', jobId: f.job.id, subJobId: 'api', app: 'IntelliJ IDEA' });
  f.host.stores.jobs.settings({ ideApp: 'Visual Studio Code' });
  await f.handler.handler({ id: f.job.id, subJobId: 'api' }, f.host);
  assert.deepEqual(f.calls.at(-1), ['open', '-na', 'Visual Studio Code', '--args', f.dir]);
});

test('every way the launch cannot happen is a job-ide-failed broadcast, not a thrown error, and nothing is launched', async () => {
  const f = ideFixture();
  const failure = () => { const b = f.broadcasts.at(-1); assert.equal(b.event, 'job-ide-failed'); return b.error; };
  await f.handler.handler({ id: f.job.id, subJobId: 'nope' }, f.host); assert.match(failure(), /Sub-job not found/);
  await f.handler.handler({ id: f.job.id, subJobId: 'web' }, f.host); assert.match(failure(), /no worktree yet/);
  fs.rmSync(f.dir, { recursive: true });
  await f.handler.handler({ id: f.job.id, subJobId: 'api' }, f.host); assert.match(failure(), /no longer exists/);
  assert.deepEqual(f.calls, []);
  const linux = ideFixture({ platform: 'linux' });
  await linux.handler.handler({ id: linux.job.id, subJobId: 'api' }, linux.host);
  assert.match(linux.broadcasts.at(-1).error, /only supported on macOS/); assert.deepEqual(linux.calls, []);
  const missing = ideFixture({ fail: Object.assign(new Error('exit 1'), { code: 1 }) });
  await missing.handler.handler({ id: missing.job.id, subJobId: 'api' }, missing.host);
  assert.equal(missing.broadcasts.at(-1).error, 'Could not open IntelliJ IDEA: Unable to find application named');
});

test('job-images sends the job’s kept pictures back as base64 for the dialog strip, skipping a name the store lost', () => {
  const { host, broadcasts, staged } = fakeHost();
  const A = 'paste-1700000000000-aaaa1111.png', B = 'paste-1700000000001-bbbb2222.png';
  staged.add(A);
  host.images.keep(A);
  const job = host.stores.jobs.create({ intent: 'Fix the layout', images: [A, B] });
  jobImagesHandler.handler({ id: job.id }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-images', jobId: job.id, images: [{ name: A, mime: 'image/png', dataBase64: Buffer.from(A).toString('base64') }] });
  jobImagesHandler.handler({ id: 'nope' }, host);
  assert.deepEqual(broadcasts.at(-1), { event: 'job-images', jobId: 'nope', images: [] });
});

test('job-images also serves the pictures kept on a wrangler conversation, from where each was kept, as talk:<file>', (t) => {
  const { host, broadcasts } = fakeHost();
  const job = host.stores.jobs.create({ intent: 'Fix the layout' });
  t.after(() => fs.rmSync(path.dirname(ideasDir(job.id)), { recursive: true, force: true }));
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const put = (dir, file) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), PNG); };
  put(ideasDir(job.id), 'ask-a-1.png'); put(ideasDir(job.id, 'api'), 'ask-b-1.png'); put(roundDir(job.id, 'api', 2), 'ask-c-1.png');
  host.stores.jobs.update(job.id, (j) => { j.talk = [
    { id: 't1', from: 'human', text: 'old', images: 2 },
    { id: 't2', from: 'human', text: 'job', images: [{ file: 'ask-a-1.png', mime: 'image/png' }, { file: 'gone.png', mime: 'image/png' }] },
    { id: 't3', from: 'human', text: 'step', images: [{ file: 'ask-b-1.png', mime: 'image/png', sub: 'api' }, { file: 'ask-c-1.png', mime: 'image/png', sub: 'api', round: 2 }] },
    { id: 't4', from: 'human', text: 'escape', images: [{ file: '../../x.png', mime: 'image/png' }] },
  ]; });
  jobImagesHandler.handler({ id: job.id }, host);
  const data = PNG.toString('base64');
  assert.deepEqual(broadcasts.at(-1).images, ['ask-a-1.png', 'ask-b-1.png', 'ask-c-1.png'].map((f) => ({ name: `talk:${f}`, mime: 'image/png', dataBase64: data })));
});

test('job-settings stores the usual pick the New job picker sends, and refuses one the job fields would', async () => {
  const { host } = fakeHost();
  await jobSettingsHandler.handler({ patch: { usualPick: { agent: 'codex', model: 'gpt-6-sol', effort: 'high' } } }, host);
  assert.deepEqual(host.stores.jobs.snapshot().settings.usualPick, { agent: 'codex', model: 'gpt-6-sol', effort: 'high' });
  await assert.rejects(jobSettingsHandler.handler({ patch: { usualPick: { agent: 'nope', model: 'x', effort: '' } } }, host));
  assert.equal(host.stores.jobs.snapshot().settings.usualPick.agent, 'codex');
});

// A fake `gh`: each call is recorded as argv, and answered by the first reply
// whose matcher the argv passes (a function result, or a thrown error).
function ghFixture(replies) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    const reply = replies.find(([match]) => match(args));
    if (!reply) throw new Error(`unexpected gh ${args.join(' ')}`);
    const got = reply[1];
    if (got instanceof Error) throw got;
    return typeof got === 'function' ? got(args) : got;
  };
  const [whoami, file] = makeFeatureRequestHandlers({ run });
  const { host, broadcasts } = fakeHost();
  return { whoami, file, host, broadcasts, calls };
}
const isCreate = (a) => a[0] === 'issue' && a[1] === 'create';
const isLabels = (a) => a[0] === 'label';
const ghError = (props) => Object.assign(new Error(props.stderr || 'failed'), props);
const URL47 = 'https://github.com/charlie-ps/wrangler-squared/issues/47';

test('a feature request is filed as a public issue on the repo, title and body as argv, and the link goes back to the asking tab', async () => {
  const f = ghFixture([[isLabels, '[{"name":"bug"}]'], [isCreate, `Creating issue in charlie-ps/wrangler-squared\n\n${URL47}\n`]]);
  await f.file.handler({ rid: 'r1', title: '  Clone a job; rm -rf ~ `x` $(y)  ', body: 'Most jobs repeat.' }, f.host);
  const create = f.calls.find((c) => isCreate(c.slice(1)));
  assert.deepEqual(create.slice(0, 7), ['gh', 'issue', 'create', '-R', 'charlie-ps/wrangler-squared', '--title', 'Clone a job; rm -rf ~ `x` $(y)'], 'one argv item, shell characters and all');
  assert.equal(create[7], '--body');
  assert.match(create[8], /^Most jobs repeat\.\n\n---\n_Sent from the Wrangler² Jobs board\._$/);
  assert.ok(!create.includes('--label'), 'the repo has no feature-request label, so none is asked for');
  assert.deepEqual(f.broadcasts, [{ event: 'feature-request-created', rid: 'r1', url: URL47, number: 47, title: 'Clone a job; rm -rf ~ `x` $(y)' }]);
});

test('the feature-request label is added only when the repo has it, and dropped when the reader may not apply it', async () => {
  const labelled = ghFixture([[isLabels, '[{"name":"feature-request"}]'], [isCreate, URL47]]);
  await labelled.file.handler({ rid: 'r', title: 'Idea' }, labelled.host);
  assert.deepEqual(labelled.calls.at(-1).slice(-2), ['--label', 'feature-request']);
  let tries = 0;
  const refused = ghFixture([[isLabels, '[{"name":"feature-request"}]'], [isCreate, (a) => { tries += 1; if (a.includes('--label')) throw ghError({ code: 1, stderr: 'could not add label' }); return URL47; }]]);
  await refused.file.handler({ rid: 'r', title: 'Idea' }, refused.host);
  assert.equal(tries, 2);
  assert.ok(!refused.calls.at(-1).includes('--label'));
  assert.equal(refused.broadcasts.at(-1).event, 'feature-request-created');
});

test('a missing or signed-out gh, an empty title and any other gh error come back as feature-request-failed with a reason', async () => {
  const cases = [
    [ghError({ code: 'ENOENT' }), 'missing'],
    [ghError({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }), 'auth'],
    [ghError({ code: 1, stderr: 'HTTP 401: Bad credentials' }), 'auth'],
    [ghError({ code: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection' }), 'error'],
  ];
  for (const [err, reason] of cases) {
    const f = ghFixture([[isLabels, err], [isCreate, err]]);
    await f.file.handler({ rid: 'r2', title: 'Idea' }, f.host);
    assert.equal(f.broadcasts.length, 1);
    assert.equal(f.broadcasts[0].event, 'feature-request-failed');
    assert.equal(f.broadcasts[0].reason, reason, err.stderr || err.code);
    assert.equal(f.broadcasts[0].rid, 'r2');
  }
  const f = ghFixture([[isLabels, ghError({ code: 1, stderr: 'error connecting to api.github.com\ncheck' })], [isCreate, ghError({ code: 1, stderr: 'error connecting to api.github.com\ncheck' })]]);
  await f.file.handler({ rid: 'r', title: 'Idea' }, f.host);
  assert.equal(f.broadcasts[0].error, 'error connecting to api.github.com');
  const blank = ghFixture([]);
  await blank.file.handler({ rid: 'r', title: '   ' }, blank.host);
  assert.deepEqual(blank.calls, [], 'nothing is filed without a title');
  assert.equal(blank.broadcasts[0].event, 'feature-request-failed');
  const odd = ghFixture([[isLabels, '[]'], [isCreate, 'https://example.com/nope']]);
  await odd.file.handler({ rid: 'r', title: 'Idea' }, odd.host);
  assert.match(odd.broadcasts[0].error, /did not return an issue link/);
});

test('whoami answers the gh login the panel will post as, or why there is none', async () => {
  const ok = ghFixture([[(a) => a[0] === 'api', 'octo-swigger']]);
  await ok.whoami.handler({ rid: 'w' }, ok.host);
  assert.deepEqual(ok.calls, [['gh', 'api', 'user', '--jq', '.login']]);
  assert.deepEqual(ok.broadcasts, [{ event: 'feature-request-gh', rid: 'w', login: 'octo-swigger' }]);
  const out = ghFixture([[(a) => a[0] === 'api', ghError({ code: 4, stderr: 'gh auth login' })]]);
  await out.whoami.handler({ rid: 'w' }, out.host);
  assert.equal(out.broadcasts[0].reason, 'auth');
});
