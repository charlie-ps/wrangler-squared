import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTitle, parseTitle, generateTitle } from './job-title.js';

test('the fallback title is the first line of the description, cut on a word', () => {
  assert.equal(fallbackTitle('\n  Customers can   sign in\nreliably, every time'), 'Customers can sign in');
  const long = fallbackTitle(`${'word '.repeat(40)}end`);
  assert.ok(long.length <= 80); assert.match(long, /word…$/);
  assert.equal(fallbackTitle('   '), 'Untitled job');
});

test('a generated title is one clean line, or nothing', () => {
  assert.equal(parseTitle('"Reliable customer sign-in."\nextra'), 'Reliable customer sign-in');
  assert.equal(parseTitle('**Title:** Audit every sign-in'), 'Audit every sign-in');
  assert.equal(parseTitle('  \n'), null);
  assert.equal(parseTitle(null), null);
  assert.ok(parseTitle('x'.repeat(400)).length <= 180);
});

test('title generation hands the description to the model and never throws', async () => {
  const calls = [];
  const ok = await generateTitle('Make sign-in reliable', { run: async (prompt, stdin) => { calls.push(stdin); return { text: 'Reliable sign-in', liveSessionId: 'live-1', error: null }; } });
  assert.deepEqual(ok, { title: 'Reliable sign-in', liveSessionId: 'live-1' }); assert.deepEqual(calls, ['Make sign-in reliable']);
  assert.deepEqual(await generateTitle('x', { run: async () => ({ text: null, liveSessionId: 'live-2', error: new Error('boom') }) }), { title: null, liveSessionId: 'live-2' });
  assert.deepEqual(await generateTitle('x', { run: async () => { throw new Error('spawn failed'); } }), { title: null, liveSessionId: null });
});
