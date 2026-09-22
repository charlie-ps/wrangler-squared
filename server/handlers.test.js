import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOpenIdeHandler } from './handlers.js';
import { fakeHost } from './test-helpers.js';

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
