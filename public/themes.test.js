import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window } from 'happy-dom';
import { THEMES, THEME_IDS, themeById, themeOf, optionsOf, applyTheme } from './themes.js';
import { DEFAULT_THEME, migrateTheme } from './theme-ids.js';
import { PLATE_ART } from './job-plates.js';
import { settingsSchema } from '../server/jobs-schema.js';

const css = fs.readFileSync(new URL('./jobs.css', import.meta.url), 'utf8');
// The custom properties a [data-theme="<id>"] block sets.
function tokensOf(id) {
  const at = css.indexOf(`[data-theme="${id}"] {`);
  if (at < 0) return null;
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at));
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

test('the registry is the shared id list, in order, with the default among them', () => {
  assert.deepEqual(THEMES.map((t) => t.id), THEME_IDS);
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length);
  assert.ok(THEME_IDS.includes(DEFAULT_THEME));
});

for (const theme of THEMES) {
  test(`${theme.name}: a complete registry entry, a CSS block with every token, and a schema that accepts it`, () => {
    assert.match(theme.name, /\S/); assert.ok(theme.blurb.length > 20);
    assert.ok(['dark', 'host'].includes(theme.scheme));
    assert.ok(theme.facts.length && theme.facts.every((f) => f.length === 2 && f.every((s) => typeof s === 'string')));
    for (const o of theme.options) assert.ok(o.values.some(([v]) => v === o.default), `${o.key} defaults to one of its values`);
    assert.ok(PLATE_ART.includes(theme.plateArt(optionsOf({}, theme))));
    if (theme.mount) assert.equal(typeof theme.mount, 'function');
    const space = tokensOf('space'), own = tokensOf(theme.id);
    assert.ok(own, `jobs.css has a [data-theme="${theme.id}"] block`);
    assert.deepEqual([...space].filter((t) => !own.has(t)), [], 'it sets every token Space sets');
    assert.deepEqual([...own].filter((t) => !space.has(t)), [], 'and no token Space lacks');
    const s = settingsSchema.parse({ theme: theme.id });
    assert.equal(s.theme, theme.id);
    for (const o of theme.options) assert.equal(s.themeOptions[theme.id][o.key], o.default, `the schema keeps ${theme.id}'s ${o.key}`);
  });
}

test('every look lives in its [data-theme] block: no rule picks a theme by excluding another, and the old backdrop is gone', () => {
  assert.doesNotMatch(css, /:not\(\[data-theme/);
  assert.doesNotMatch(css, /data-backdrop/);
  for (const m of css.matchAll(/var\((--jt-[\w-]+)/g)) assert.ok(tokensOf('space').has(m[1]), `${m[1]} is a token every theme sets`);
});

test('a theme lookup falls back to the default, and options fall back to their defaults', () => {
  assert.equal(themeOf({ theme: 'wrangler' }).id, 'wrangler');
  assert.equal(themeOf({ theme: 'nebula' }).id, DEFAULT_THEME);
  assert.equal(themeOf(undefined).id, DEFAULT_THEME);
  const space = themeById('space');
  assert.deepEqual(optionsOf({ themeOptions: { space: { plateArt: 'full' } } }, space), { plateArt: 'full' });
  assert.deepEqual(optionsOf({ themeOptions: { space: { plateArt: 'peek' } } }, space), { plateArt: 'quiet' }, 'a value no longer offered');
  assert.deepEqual(optionsOf({}, themeById('wrangler')), {});
});

test('migrateTheme keeps old settings in the look they had, gives new ones the default, and moves plate art under Space', () => {
  assert.deepEqual(migrateTheme({ backdrop: 'wrangler', concurrency: 3 }), { theme: 'wrangler', concurrency: 3 });
  assert.deepEqual(migrateTheme({ backdrop: 'sky', plateArt: 'peek' }), { theme: 'space', themeOptions: { space: { plateArt: 'quiet' } } });
  assert.deepEqual(migrateTheme({ theme: 'nebula' }), { theme: 'nebula' }, 'an explicit theme is left for the schema to refuse');
  assert.deepEqual(migrateTheme({ concurrency: 3 }), { theme: DEFAULT_THEME, concurrency: 3 }, 'settings with neither old key get the default');
  assert.deepEqual(migrateTheme({ theme: 'space', plateArt: 'quiet', themeOptions: { space: { plateArt: 'full' } } }).themeOptions, { space: { plateArt: 'full' } });
});

test('applyTheme stamps the theme, forcing dark only for a theme that asks', () => {
  const el = { dataset: {} };
  applyTheme(el, themeById('space')); assert.deepEqual({ ...el.dataset }, { theme: 'space', scheme: 'dark' });
  applyTheme(el, themeById('wrangler')); assert.deepEqual({ ...el.dataset }, { theme: 'wrangler' });
});

test('Space mounts its masthead glare and its unmount takes it away; Wrangler mounts nothing', async (t) => {
  const window = new Window();
  const prev = globalThis.document; globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  const root = window.document.createElement('section');
  root.innerHTML = '<div class="jobs-top"><div>title</div></div>';
  const stop = themeById('space').mount(root);
  assert.equal(root.querySelector('.jobs-top').firstElementChild.className, 'jobs-mast-sky');
  stop();
  assert.equal(root.querySelector('canvas'), null);
  assert.equal(themeById('wrangler').mount, undefined, 'no live art, so no animation loop or observer');
});
