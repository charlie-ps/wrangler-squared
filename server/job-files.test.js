import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedFiles, allowFiles } from './job-files.js';

const write = (url, type = 'file') => ({ id: 'w', kind: 'write', stage: 'done', place: { type }, action: { type: 'make', what: 'x' }, by: 's', result: { url } });
const jobs = [{ subJobs: [write('/tmp/a.md'), write('/tmp/a.md'), write('https://example.com/x', 'artifact'), write('relative.md'), { id: 'pr', stage: 'pr' }] }];

test('only absolute paths a file place reported are collected, once', () => {
  assert.deepEqual(reportedFiles(jobs), ['/tmp/a.md']);
});

test('each reported file is registered with the host once, and a host without files is left alone', () => {
  const allowed = [], seen = new Set();
  const host = { files: { allow: (p) => allowed.push(p) } };
  allowFiles(host, jobs, seen); allowFiles(host, jobs, seen);
  assert.deepEqual(allowed, ['/tmp/a.md']);
  allowFiles({}, jobs); allowFiles(undefined, jobs);
});

test('a refused registration is logged and retried next time', () => {
  const logged = [], seen = new Set();
  allowFiles({ log: (...a) => logged.push(a), files: { allow: () => { throw new Error('no'); } } }, jobs, seen);
  assert.equal(logged.length, 1);
  assert.equal(seen.size, 0);
});
