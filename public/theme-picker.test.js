import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mountThemePicker } from './theme-picker.js';
import { THEMES, optionsOf } from './themes.js';

function fixture(t, value = 'space') {
  const window = new Window();
  const prev = globalThis.document; globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  document.body.innerHTML = '<dialog><form><fieldset id="pick"><legend>Theme</legend></fieldset></form></dialog>';
  const dialog = document.querySelector('dialog'), el = document.querySelector('#pick');
  const settings = { themeOptions: { space: { plateArt: 'quiet' } } }, changes = [], options = [];
  const picker = mountThemePicker(el, {
    themes: THEMES, value, optionsOf: (th) => optionsOf(settings, th),
    onChange: (id) => changes.push(id),
    onOption: (th, key, v) => { options.push([th.id, key, v]); settings.themeOptions = { ...settings.themeOptions, [th.id]: { ...optionsOf(settings, th), [key]: v } }; },
  });
  t.after(() => picker.dispose());
  const key = (target, k) => { const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
  const q = (s) => dialog.querySelector(s);
  return { window, dialog, el, picker, changes, options, key, q };
}

test('every theme is a radio row with its name and scheme, the current one checked, beside a captioned preview of it', (t) => {
  const f = fixture(t);
  assert.equal(f.el.querySelector('legend').textContent, 'Theme', 'the legend is kept');
  const list = f.q('.theme-list');
  assert.deepEqual([list.getAttribute('role'), list.getAttribute('aria-label')], ['radiogroup', 'Theme']);
  assert.deepEqual([...list.querySelectorAll('.theme-choice')].map((c) => [c.getAttribute('role'), c.dataset.value, c.querySelector('b').textContent, c.querySelector('small').textContent, c.getAttribute('aria-checked'), c.tabIndex]),
    [['radio', 'wrangler', 'Wrangler', 'LIGHT · DARK', 'false', -1], ['radio', 'space', 'Space', 'DARK', 'true', 0]]);
  assert.deepEqual([...list.querySelectorAll('.theme-swatch')].map((s) => [s.dataset.theme, s.dataset.scheme]), [['wrangler', undefined], ['space', 'dark']], 'each swatch wears its own theme');
  const fig = f.q('figure.theme-preview');
  assert.equal(fig.querySelector('.theme-cap').textContent, 'Preview · Space');
  assert.deepEqual([fig.querySelector('.theme-mini').dataset.theme, fig.querySelector('.theme-mini').className, fig.querySelector('h1').textContent], ['space', 'theme-mini preview', 'Wrangler²'], 'the preview is the theme\'s own board');
  assert.equal(fig.querySelector('button,a,[role="radio"]'), null, 'nothing in the preview is a control');
  assert.equal(fig.querySelector('.theme-mini').hasAttribute('inert'), true, 'and Tab never lands in it');
  assert.match(fig.querySelector('.theme-blurb').textContent, /night sky/);
  assert.deepEqual([...f.el.querySelectorAll('[data-opt]')].map((b) => [b.textContent, b.getAttribute('aria-checked'), b.tabIndex]), [['Skylines', 'true', 0], ['Launch scenes', 'false', -1]]);
});

test('an option saves at once, redraws the preview in it, and the arrow keys move along its segments', (t) => {
  const f = fixture(t);
  f.q('[data-opt="full"]').click();
  assert.deepEqual(f.options, [['space', 'plateArt', 'full']]);
  assert.equal(f.q('[data-opt="full"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.q('.theme-art .theme-mini').dataset.plateArt, 'full');
  assert.equal(document.activeElement, f.q('[data-opt="full"]'), 'focus stays on the choice');
  f.key(f.q('[data-opt="full"]'), 'ArrowLeft');
  assert.deepEqual(f.options.at(-1), ['space', 'plateArt', 'quiet']);
  f.q('[data-opt="quiet"]').click();
  assert.equal(f.options.length, 2, 'the current value is not saved again');
  assert.deepEqual(f.changes, [], 'an option is not a theme');
});

test('clicking a theme chooses it at once: its row is checked, the preview and options follow, and focus stays on it', (t) => {
  const f = fixture(t);
  f.q('.theme-choice[data-value="wrangler"]').click();
  assert.deepEqual(f.changes, ['wrangler']);
  assert.equal(f.picker.value(), 'wrangler');
  assert.deepEqual([...f.q('.theme-list').querySelectorAll('.theme-choice')].map((c) => [c.getAttribute('aria-checked'), c.tabIndex]), [['true', 0], ['false', -1]]);
  assert.equal(document.activeElement, f.q('.theme-choice[data-value="wrangler"]'));
  assert.deepEqual([f.q('.theme-art .theme-mini').dataset.theme, f.q('.theme-cap').textContent], ['wrangler', 'Preview · Wrangler']);
  assert.equal(f.el.querySelector('[data-opt]'), null, 'Wrangler has no options');
  assert.match(f.el.querySelector('.pick-usual').textContent, /light and dark mode/);
  f.q('.theme-choice[data-value="wrangler"]').click();
  assert.deepEqual(f.changes, ['wrangler'], 'choosing the current theme saves nothing');
  f.q('.theme-choice[data-value="space"]').click();
  assert.deepEqual(f.changes, ['wrangler', 'space']);
  assert.deepEqual([...f.el.querySelectorAll('[data-opt]')].map((b) => b.textContent), ['Skylines', 'Launch scenes'], 'Space\'s option comes back');
});

test('the arrow keys move between themes and choose as they go, holding at either end', (t) => {
  const f = fixture(t);
  const e = f.key(f.q('.theme-choice[data-value="space"]'), 'ArrowUp');
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(f.changes, ['wrangler']);
  assert.equal(document.activeElement, f.q('.theme-choice[data-value="wrangler"]'));
  f.key(document.activeElement, 'ArrowLeft');
  assert.deepEqual(f.changes, ['wrangler'], 'the first theme holds');
  f.key(document.activeElement, 'ArrowDown');
  assert.deepEqual(f.changes, ['wrangler', 'space']);
  assert.equal(document.activeElement, f.q('.theme-choice[data-value="space"]'));
  f.key(document.activeElement, 'ArrowRight');
  assert.deepEqual(f.changes, ['wrangler', 'space'], 'the last theme holds');
  assert.equal(f.key(document.activeElement, 'Escape').defaultPrevented, false, 'Escape is left to the dialog');
});

test('sync redraws for a theme chosen elsewhere with focus kept on the checked theme, and a disposed picker draws nothing', (t) => {
  const f = fixture(t);
  f.picker.sync('wrangler');
  assert.equal(f.q('.theme-choice[aria-checked="true"]').dataset.value, 'wrangler');
  f.picker.sync('nebula');
  assert.equal(f.q('.theme-choice[aria-checked="true"]').dataset.value, 'wrangler', 'an unknown id falls back to the first theme');
  f.q('.theme-choice[data-value="wrangler"]').focus();
  f.picker.sync('wrangler');
  assert.equal(document.activeElement, f.q('.theme-choice[data-value="wrangler"]'), 'the same markup is not redrawn');
  f.picker.sync('space');
  assert.equal(document.activeElement, f.q('.theme-choice[data-value="space"]'), 'a redraw keeps focus on the checked theme');
  f.picker.dispose();
  f.picker.sync('wrangler');
  assert.equal(f.q('.theme-choice[aria-checked="true"]').dataset.value, 'space', 'a disposed picker draws nothing');
});
