import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobRuntime } from './job-runtime.js';
import { makeCreateJob } from './job-create.js';
import { jobInputSchema } from './jobs-schema.js';
import { fakeHost } from './test-helpers.js';

const A = 'paste-1700000000000-aaaa1111.png';
const B = 'paste-1700000000001-bbbb2222.jpg';
const intent = 'Fix the sign-in layout shown in the screenshots';
const createJob = makeCreateJob({ run: async () => '' });
const runtimeWith = (host) => new JobRuntime({ host }, async () => '');
const jobWith = (images, extra = {}) => ({ id: 'job_12345678', title: 'Sign-in', agent: 'claude', images, ...extra });
const sub = { id: 'api', repo: '/repo', worktree: { path: '/' } };

test('the job schema accepts minted image names, at most eight, and never a path', () => {
  assert.deepEqual(jobInputSchema.parse({ intent }).images, []);
  assert.equal(jobInputSchema.parse({ intent }).shareImages, true);
  assert.throws(() => jobInputSchema.parse({ intent, images: ['../../etc/passwd'] }));
  assert.throws(() => jobInputSchema.parse({ intent, images: ['shot.png'] }));
  assert.throws(() => jobInputSchema.parse({ intent, images: Array(9).fill(A) }));
});

test('creating a job keeps its own copy of each staged image and stores the names', async () => {
  const { host, staged, kept } = fakeHost();
  staged.add(A); staged.add(B);
  const job = await createJob(host, { job: { intent, images: [A, B], shareImages: false } });
  assert.deepEqual(job.images, [A, B]);
  assert.equal(job.shareImages, false);
  assert.deepEqual([...kept.keys()], [A, B]);
});

test('an image that is no longer staged fails the create and leaves nothing kept or created', async () => {
  const { host, staged, kept } = fakeHost();
  staged.add(A);
  await assert.rejects(createJob(host, { job: { intent, images: [A, B] } }), /no longer available/);
  assert.equal(kept.size, 0);
  assert.equal(host.stores.jobs.snapshot().jobs.length, 0);
});

test('planning always gets the images, whatever the sharing flag says', async () => {
  const { host, spawned, kept } = fakeHost();
  kept.set(A, Buffer.from('x'));
  await runtimeWith(host).launch(jobWith([A], { shareImages: false }), null, { id: 'run_1', phase: 'planning' }, () => {});
  assert.deepEqual(spawned[0].images, [A]);
});

test('sub-job spawns get the images while sharing is on and not when it is off', async () => {
  const { host, spawned, kept } = fakeHost();
  kept.set(A, Buffer.from('x'));
  const runtime = runtimeWith(host);
  for (const phase of ['implementation', 'publish', 'repair']) await runtime.launch(jobWith([A]), sub, { id: 'r', phase }, () => {});
  assert.deepEqual(spawned.map((s) => s.images), [[A], [A], [A]]);
  await runtime.launch(jobWith([A], { shareImages: false }), sub, { id: 'r', phase: 'implementation' }, () => {});
  assert.equal('images' in spawned[3], false);
});

test('a job without images spawns without the option, and a write step never gets them', async () => {
  const { host, spawned, kept } = fakeHost();
  kept.set(A, Buffer.from('x'));
  const runtime = runtimeWith(host);
  await runtime.launch(jobWith([]), null, { id: 'r', phase: 'planning' }, () => {});
  await runtime.launch(jobWith([A]), null, { id: 'r', phase: 'write' }, () => {});
  assert.deepEqual(spawned.map((s) => 'images' in s), [false, false]);
});

test('a kept image that has gone missing is skipped rather than failing the launch', async () => {
  const { host, spawned, kept } = fakeHost();
  kept.set(B, Buffer.from('x'));
  await runtimeWith(host).launch(jobWith([A, B]), null, { id: 'r', phase: 'planning' }, () => {});
  assert.deepEqual(spawned[0].images, [B]);
});

test('releasing a finished job removes its kept images', () => {
  const { host, kept } = fakeHost();
  kept.set(A, Buffer.from('x')); kept.set(B, Buffer.from('y'));
  runtimeWith(host).releaseImages(jobWith([A, B]));
  assert.equal(kept.size, 0);
});
