import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPick, switchPick } from './model-picker.js';
import { describe, startGalaxy, plateArt } from './model-plates.js';

const claude = { id: 'claude', label: 'Claude', efforts: ['low', 'high', 'max'].map((value) => ({ value })), models: [{ value: 'fable' }, { value: 'opus', default: true }, { value: 'sonnet' }] };
const codex = { id: 'codex', label: 'Codex', efforts: ['low', 'high', 'max', 'ultra'].map((value) => ({ value })), models: [
  { value: 'gpt-6.1-sol', default: true }, { value: 'gpt-6-luna', efforts: ['low', 'high'] }] };
const agents = [claude, codex];
const d = (agent, value, extra = {}, all = agent.models) => describe(agent, { value, ...extra }, all);

test('describe reads a Claude alias by family only, and shows a version only for a full id', () => {
  assert.equal(d(claude, 'opus').name, 'Claude Opus');
  assert.equal(d(claude, 'opus').version, '');
  assert.equal(d(claude, 'opus').plate, 'horizon');
  assert.equal(d(claude, 'haiku').plate, 'arc');
  assert.equal(d(claude, 'sonnet').plate, 'specimen');
  assert.equal(d(claude, 'claude-opus-6').name, 'Claude Opus 6');
  assert.equal(d(claude, 'claude-opus-6').short, 'Opus 6');
  assert.equal(d(claude, 'claude-haiku-4-5-20251001').version, '4.5');
  assert.equal(d(claude, 'claude-opus-6').resolved, 'claude-opus-6');
  assert.equal(d(claude, 'opus').resolved, '', 'nothing resolves an alias to an id yet');
});

test('the Fable numeral falls back to the family initial for an alias', () => {
  assert.equal(d(claude, 'fable').plate, 'swarm');
  assert.equal(d(claude, 'fable').numeral, 'F');
  assert.equal(d(claude, 'claude-fable-5-1').numeral, '5');
});

test('describe handles the 1M suffix, opusplan and an unknown Claude family', () => {
  const long = d(claude, 'sonnet[1m]');
  assert.equal(long.name, 'Claude Sonnet · 1M'); assert.equal(long.short, 'Sonnet 1M'); assert.ok(long.sp.tail > d(claude, 'sonnet').sp.tail, 'long tails');
  const plan = d(claude, 'opusplan', { label: 'Opus plan · Sonnet execution' });
  assert.equal(plan.name, 'Opus plan'); assert.equal(plan.split.length, 2); assert.match(plan.latin, /opus × sonnet/);
  const odd = d(claude, 'claude-lumen-1');
  assert.equal(odd.name, 'Claude Lumen 1'); assert.equal(odd.known, false); assert.equal(odd.plate, 'specimen');
  assert.deepEqual(d(claude, 'claude-lumen-1').sp, odd.sp, 'bred from the id, so stable');
});

test('describe draws Codex by suffix and dims older versions of the same suffix', () => {
  const all = [{ value: 'gpt-6.1-sol' }, { value: 'gpt-6-sol' }, { value: 'gpt-5.6-sol' }];
  assert.equal(d(codex, 'gpt-6-astra').plate, 'galaxy'); assert.equal(d(codex, 'gpt-6-astra').numeral, '6');
  assert.equal(d(codex, 'gpt-6-luna').body.kind, 'luna');
  assert.equal(d(codex, 'gpt-6.1-terra').body.kind, 'planet');
  assert.equal(d(codex, 'gpt-6.1-sol', {}, all).body.kind, 'sun');
  assert.notDeepEqual(d(codex, 'gpt-6.1-sol', {}, all).body.c, d(codex, 'gpt-5.6-sol', {}, all).body.c, 'older suns are dimmer');
  const nova = d(codex, 'gpt-7-nova');
  assert.equal(nova.known, false); assert.equal(nova.plate, 'body'); assert.equal(nova.numeral, '7');
  assert.deepEqual(d(codex, 'gpt-7-nova').body.c, nova.body.c, 'orb hue is seeded from the id');
  assert.match(d(codex, 'gpt-6-luna', { efforts: ['low', 'high'] }).latin, /efforts up to high/);
});

test('an unknown agent gets index cards, and catalog strings are escaped in the art', () => {
  const kestrel = { id: 'kestrel', label: 'Kestrel <b>', efforts: [], models: [] };
  const c = d(kestrel, 'kestrel-2-pro', { label: 'Kestrel 2 "Pro"' }, []);
  assert.equal(c.plate, 'card'); assert.equal(c.name, 'Kestrel 2 "Pro"');
  const svg = plateArt(c, kestrel, [], '', 'preview');
  assert.ok(!svg.includes('<b>') && svg.includes('KESTREL &lt;B&gt;'), 'agent label escaped');
  assert.ok(!svg.includes('"Pro"') && svg.includes('&quot;Pro&quot;'));
  const empty = d(claude, '', {}, []);
  assert.equal(empty.plate, 'card', 'an agent with no models still describes');
});

test('initialPick opens on your usual while the catalog has it, else on the first agent’s default', () => {
  assert.deepEqual(initialPick(agents, { agent: 'codex', model: 'gpt-6-luna', effort: 'high' }), { agent: 'codex', model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(initialPick(agents, { agent: 'codex', model: 'gpt-6-luna', effort: 'max' }), { agent: 'codex', model: 'gpt-6-luna', effort: '' }, 'luna stops at high');
  assert.deepEqual(initialPick(agents, null), { agent: 'claude', model: 'opus', effort: '' });
  assert.deepEqual(initialPick(agents, { agent: 'codex', model: 'gone', effort: 'high' }), { agent: 'claude', model: 'opus', effort: '' });
  assert.deepEqual(initialPick(agents, { agent: 'kestrel', model: 'x', effort: '' }), { agent: 'claude', model: 'opus', effort: '' });
  assert.deepEqual(initialPick([], null), { agent: '', model: '', effort: '' });
});

test('switching model keeps the effort only when the new model offers it', () => {
  const from = { agent: 'claude', model: 'opus', effort: 'max' };
  assert.equal(switchPick(agents, from, 'claude', 'sonnet').effort, 'max');
  assert.equal(switchPick(agents, from, 'codex', 'gpt-6.1-sol').effort, 'max');
  assert.equal(switchPick(agents, from, 'codex', 'gpt-6-luna').effort, '', 'luna offers only low and high');
  assert.equal(switchPick(agents, { ...from, effort: 'ultra' }, 'claude', 'opus').effort, '', 'claude has no ultra');
});

test('a galaxy runs exactly one animation loop, stops on demand, and ends when its canvas leaves the document', () => {
  const prev = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, mm: globalThis.matchMedia };
  let next = 1; const pending = new Map(), cancelled = [];
  globalThis.requestAnimationFrame = (fn) => { pending.set(next, fn); return next++; };
  globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); pending.delete(id); };
  globalThis.matchMedia = () => ({ matches: false });
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }), scale() {} }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  const canvas = (connected = true) => ({ getContext: () => ctx, clientWidth: 100, clientHeight: 60, isConnected: connected });
  try {
    const stop = startGalaxy(canvas(), { seed: 'gpt-6-astra', numeral: '6' }, 3);
    assert.equal(pending.size, 1, 'one loop per galaxy');
    const [[, frame]] = pending; pending.clear(); frame();
    assert.equal(pending.size, 1, 'still one after a frame');
    stop(); assert.equal(pending.size, 0); assert.equal(cancelled.length, 1);
    const gone = startGalaxy(canvas(false), { seed: 'x', numeral: '6' }, 1);
    assert.equal(pending.size, 0, 'a detached canvas never schedules'); gone();
    globalThis.matchMedia = () => ({ matches: true });
    startGalaxy(canvas(), { seed: 'x', numeral: '6' }, 1);
    assert.equal(pending.size, 0, 'reduced motion draws one still frame');
  } finally { Object.assign(globalThis, { requestAnimationFrame: prev.raf, cancelAnimationFrame: prev.caf, matchMedia: prev.mm }); }
});
