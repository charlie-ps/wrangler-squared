import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPick, switchPick, offeredAgents } from './model-picker.js';
import { describe, weakModel, startGalaxy, plateArt, plateThumb } from './model-plates.js';

const claude = { id: 'claude', label: 'Claude', efforts: ['low', 'high', 'max'].map((value) => ({ value })), models: [{ value: 'fable' }, { value: 'opus', default: true }, { value: 'sonnet' }] };
const codex = { id: 'codex', label: 'Codex', efforts: ['low', 'high', 'max', 'ultra'].map((value) => ({ value })), models: [
  { value: 'gpt-6.1-sol', default: true }, { value: 'gpt-6-luna', efforts: ['low', 'high'] }] };
const agents = [claude, codex];
const d = (agent, value, extra = {}, all = agent.models) => describe(agent, { value, ...extra }, all);

test('describe reads a Claude alias by family only, and shows a version only for a full id', () => {
  assert.equal(d(claude, 'opus').name, 'Claude Opus');
  assert.equal(d(claude, 'opus').version, '');
  assert.equal(d(claude, 'claude-opus-6').name, 'Claude Opus 6');
  assert.equal(d(claude, 'claude-opus-6').short, 'Opus 6');
  assert.equal(d(claude, 'claude-haiku-4-5-20251001').version, '4.5');
  assert.equal(d(claude, 'claude-opus-6').resolved, 'claude-opus-6');
  assert.equal(d(claude, 'opus').resolved, '', 'nothing resolves an alias to an id yet');
  assert.equal(d(claude, 'claude-opus-5-5').tag, 'CLAUDE-OPUS-5-5');
  assert.equal(d(claude, 'opus').tag, 'CLAUDE-OPUS', 'an alias never invents a version for the id line');
});

test('each Claude family gets its own launch plate, and an unknown one borrows Haiku’s page', () => {
  for (const fam of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert.equal(d(claude, fam).plate, fam, `${fam} alias`);
    assert.equal(d(claude, `claude-${fam}-5-5[1m]`).plate, fam, `${fam} full id`);
  }
  const plan = d(claude, 'opusplan', { label: 'Opus plan · Sonnet execution' });
  assert.equal(plan.plate, 'plan'); assert.equal(plan.name, 'Opus plan'); assert.equal(plan.ctx, '');
  assert.equal(d(claude, 'opusplan').name, 'Opus plan', 'named without a label too');
  const odd = d(claude, 'claude-lumen-1');
  assert.equal(odd.name, 'Claude Lumen 1'); assert.equal(odd.known, false); assert.equal(odd.plate, 'haiku');
});

test('the 1M suffix becomes a context badge rather than part of the name', () => {
  const long = d(claude, 'sonnet[1m]');
  assert.equal(long.name, 'Claude Sonnet'); assert.equal(long.short, 'Sonnet'); assert.equal(long.ctx, '1M');
  assert.equal(d(claude, 'claude-sonnet-5-5').ctx, '200K');
  assert.equal(d(claude, 'claude-opus-5-5[1m]').name, 'Claude Opus 5.5');
});

test('context comes from the host’s window or label, and the [1m] guess only when neither says', () => {
  assert.equal(d(claude, 'opus', { label: 'Opus 5.5 · 1M context' }).ctx, '1M', 'a 1M alias with no suffix');
  assert.equal(d(claude, 'fable', { label: 'Fable 5.1 · 1M context' }).ctx, '1M');
  assert.equal(d(claude, 'sonnet', { label: 'Sonnet 5.5 · 200K context' }).ctx, '200K');
  assert.equal(d(claude, 'sonnet[1m]', { label: 'Sonnet 5.5 · 1M context' }).ctx, '1M');
  assert.equal(d(claude, 'opus', { contextWindow: 1_000_000 }).ctx, '1M');
  assert.equal(d(claude, 'haiku', { contextWindow: 200_000, label: 'Haiku 4.5 · 1M context' }).ctx, '200K', 'contextWindow wins over the label');
  assert.equal(d(claude, 'opus', { label: 'Opus 5.5' }).ctx, '200K', 'no window and no suffix: the old guess');
  assert.equal(d(claude, 'opus[1m]', { label: 'Opus' }).ctx, '1M');
});

test('Claude plates are self-contained SVG: preview carries id and title, the tray the title, the band neither', () => {
  const efforts = claude.efforts;
  for (const v of ['claude-opus-5-5[1m]', 'sonnet', 'haiku', 'claude-fable-5-1', 'opusplan', 'claude-lumen-1']) {
    const x = d(claude, v), full = plateArt(x, claude, efforts, 'high', 'preview'), band = plateArt(x, claude, efforts, 'high', 'band'), thumb = plateThumb(x, claude, efforts, 'high');
    for (const svg of [full, band, thumb]) {
      assert.match(svg, /^<svg viewBox="0 0 320 200"/, `${v} is one svg`);
      assert.ok(!/<image|href="(?!#)/.test(svg), `${v} ships no images`);
      const ids = new Set([...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)) if (ref) assert.ok(ids.has(ref), `${v} defines ${ref}`);
    }
    assert.ok(full.includes(x.tag) && full.includes(`>${x.name}<`), `${v} preview has id and title`);
    assert.ok(!thumb.includes(x.tag) && thumb.includes(`>${x.name}<`), `${v} thumb has title only`);
    assert.ok(!band.includes(`>${x.name}<`), `${v} band is art only`);
  }
  const hi = plateArt(d(claude, 'opus'), claude, efforts, 'max', 'band'), lo = plateArt(d(claude, 'opus'), claude, efforts, 'low', 'band');
  const glow = (svg) => Number(svg.match(/stroke="#ff5512" stroke-width="([\d.]+)"/)[1]);
  assert.ok(glow(hi) > glow(lo), 'more effort, brighter limb');
  const sly = plateArt({ ...d(claude, 'opus'), name: 'Claude <b>', tag: 'A&B' }, claude, efforts, '', 'preview');
  assert.ok(!sly.includes('<b>') && sly.includes('Claude &lt;b&gt;') && sly.includes('A&amp;B'), 'name and id line escaped');
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

test('a live Codex label "Name · description" splits into name, description and short flanks', () => {
  const live = d(codex, 'gpt-6.1-sol', { label: 'GPT-6.1-Sol · Latest workhorse model for coding and everyday work' });
  assert.equal(live.name, 'GPT-6.1-Sol');
  assert.equal(live.desc, 'Latest workhorse model for coding and everyday work.');
  assert.deepEqual(live.flank, ['GPT-6.1', 'Sol']);
  assert.equal(live.short, 'Sol 6.1');
  assert.equal(d(codex, 'gpt-6-astra', { label: 'GPT-6-Astra · Frontier.', description: 'Own words.' }).desc, 'Own words.', 'a separate description wins');
  const plain = d(codex, 'gpt-6-luna', { label: 'GPT-6-Luna', description: 'Fast and affordable.' });
  assert.equal(plain.name, 'GPT-6-Luna'); assert.equal(plain.desc, 'Fast and affordable.'); assert.deepEqual(plain.flank, ['GPT-6', 'Luna']);
  const bare = d(codex, 'gpt-5.6-sol');
  assert.equal(bare.name, 'GPT-5.6-Sol'); assert.match(bare.desc, /just started offering/); assert.deepEqual(bare.flank, ['GPT-5.6', 'Sol']);
  assert.equal(d(codex, 'o4-mini').name, 'o4-mini'); assert.equal(d(codex, 'o4-mini').flank, null);
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

test('weakModel flags anything below Opus 5.5, Fable 5.1 or GPT-6 Astra, reading a bare opus or fable alias as current', () => {
  const weak = (agent, value) => weakModel(agent, { value });
  for (const v of ['opus', 'fable', 'opus[1m]', 'claude-opus-5-5', 'claude-opus-6', 'claude-opus-5-10', 'claude-fable-5-1', 'claude-fable-6[1m]']) assert.equal(weak(claude, v), false, v);
  for (const v of ['sonnet', 'sonnet[1m]', 'haiku', 'opusplan', 'claude-opus-5', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) assert.equal(weak(claude, v), true, v);
  for (const v of ['gpt-6-astra', 'gpt-6.1-astra', 'gpt-7-astra']) assert.equal(weak(codex, v), false, v);
  for (const v of ['gpt-5.5-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-terra', 'gpt-6']) assert.equal(weak(codex, v), true, v);
  assert.equal(weak({ id: 'gemini', label: 'Gemini' }, 'gemini-3-pro'), true, 'an unknown agent warns');
  assert.equal(weakModel(claude, { value: '' }), false, 'no pick, no warning');
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

test('the picker never offers opusplan, and a usual of opusplan opens on opus', () => {
  const withPlan = [{ ...claude, models: [...claude.models, { value: 'opusplan', label: 'Opus plan · Sonnet execution' }] }, codex];
  const offered = offeredAgents(withPlan);
  assert.deepEqual(offered[0].models.map((m) => m.value), ['fable', 'opus', 'sonnet']);
  assert.equal(offered[1], codex, 'other agents pass through untouched');
  assert.equal(withPlan[0].models.length, 4, 'the catalog itself is not changed');
  assert.deepEqual(initialPick(offered, { agent: 'claude', model: 'opusplan', effort: 'high' }), { agent: 'claude', model: 'opus', effort: 'high' });
});
