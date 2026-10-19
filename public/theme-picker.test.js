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
    themes: THEMES, value, cover: dialog, optionsOf: (th) => optionsOf(settings, th),
    onChange: (id) => changes.push(id),
    onOption: (th, key, v) => { options.push([th.id, key, v]); settings.themeOptions = { ...settings.themeOptions, [th.id]: { ...optionsOf(settings, th), [key]: v } }; },
  });
  const key = (target, k) => { const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
  const q = (s) => dialog.querySelector(s);
  return { window, dialog, el, picker, changes, options, key, q };
}

test('the ticket shows the current theme\'s art and name, with that theme\'s options under it', (t) => {
  const f = fixture(t);
  const tk = f.q('.theme-ticket');
  assert.equal(f.el.querySelector('legend').textContent, 'Theme', 'the legend is kept');
  assert.deepEqual([tk.dataset.theme, tk.dataset.scheme, tk.getAttribute('aria-expanded')], ['space', 'dark', 'false']);
  assert.equal(tk.querySelector('.pick-tname').textContent, 'Space');
  assert.deepEqual([tk.querySelector('.pick-band .theme-mini').dataset.theme, tk.querySelector('.pick-band h1').textContent], ['space', 'Wrangler²'], 'the band is the theme\'s own masthead');
  assert.deepEqual([...f.el.querySelectorAll('[data-opt]')].map((b) => [b.textContent, b.getAttribute('aria-checked'), b.tabIndex]), [['Skylines', 'true', 0], ['Launch scenes', 'false', -1]]);
});

test('an option saves at once, and the arrow keys move along its segments', (t) => {
  const f = fixture(t);
  f.q('[data-opt="full"]').click();
  assert.deepEqual(f.options, [['space', 'plateArt', 'full']]);
  assert.equal(f.q('[data-opt="full"]').getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, f.q('[data-opt="full"]'), 'focus stays on the choice');
  f.key(f.q('[data-opt="full"]'), 'ArrowLeft');
  assert.deepEqual(f.options.at(-1), ['space', 'plateArt', 'quiet']);
  f.q('[data-opt="quiet"]').click();
  assert.equal(f.options.length, 2, 'the current value is not saved again');
});

test('the cabinet opens on the current theme, previews by arrow key and hover in the look it previews, and a click chooses', async (t) => {
  const f = fixture(t);
  f.q('.theme-ticket').click();
  const cab = f.q('.theme-cabinet');
  assert.deepEqual([cab.getAttribute('role'), cab.dataset.theme, cab.dataset.scheme, cab.dataset.preview], ['dialog', 'space', 'dark', 'space']);
  assert.equal(f.q('.theme-ticket').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...cab.querySelectorAll('.pick-cell')].map((c) => [c.dataset.value, c.getAttribute('aria-checked'), c.querySelector('.pick-thumb').dataset.theme]), [['wrangler', 'false', 'wrangler'], ['space', 'true', 'space']]);
  assert.equal(document.activeElement, cab.querySelector('.pick-cell[data-value="space"]'), 'focus lands on the current plate');
  assert.equal(cab.querySelector('.pick-pname').textContent, 'Space');
  assert.deepEqual([...cab.querySelectorAll('.pick-rows span:first-child')].map((s) => s.textContent), ['Scheme', 'Motion', 'Options']);
  f.key(document.activeElement, 'ArrowLeft');
  assert.deepEqual([cab.dataset.preview, cab.dataset.theme, cab.dataset.scheme], ['wrangler', 'wrangler', undefined], 'the cabinet wears the theme it previews');
  assert.equal(document.activeElement, cab.querySelector('.pick-cell[data-value="wrangler"]'));
  assert.equal(cab.querySelector('.pick-cell[data-value="space"]').getAttribute('aria-checked'), 'true', 'previewing is not choosing');
  assert.deepEqual(f.changes, []);
  f.key(document.activeElement, 'ArrowLeft');
  assert.equal(cab.dataset.preview, 'wrangler', 'the first plate holds');
  cab.querySelector('.pick-cell[data-value="space"]').dispatchEvent(new f.window.Event('pointerover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(cab.dataset.preview, 'space', 'hover previews after a beat');
  cab.querySelector('.pick-cell[data-value="wrangler"]').click();
  assert.deepEqual(f.changes, ['wrangler']);
  assert.equal(f.q('.theme-cabinet'), null);
  assert.equal(f.picker.value(), 'wrangler');
  assert.deepEqual([f.q('.theme-ticket').dataset.theme, f.q('.theme-ticket').dataset.scheme], ['wrangler', undefined]);
  assert.equal(document.activeElement, f.q('.theme-ticket'), 'focus returns to the ticket');
  assert.equal(f.el.querySelector('[data-opt]'), null, 'Wrangler has no options');
  assert.match(f.el.querySelector('.pick-usual').textContent, /light and dark mode/);
});

test('Escape closes the cabinet and not the dialog around it', (t) => {
  const f = fixture(t);
  f.q('.theme-ticket').click();
  let escaped = false;
  document.addEventListener('keydown', () => { escaped = true; });
  const esc = f.key(f.q('.theme-cabinet .pick-cell'), 'Escape');
  assert.equal(esc.defaultPrevented, true); assert.equal(escaped, false, 'it goes no further than the dialog');
  assert.equal(f.q('.theme-cabinet'), null);
  assert.equal(document.activeElement, f.q('.theme-ticket'));
  f.q('.theme-ticket').click();
  const cancel = new f.window.Event('cancel', { cancelable: true });
  f.dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true, 'the dialog\'s own Escape (cancel) only closes the cabinet');
  assert.equal(f.q('.theme-cabinet'), null);
  const next = new f.window.Event('cancel', { cancelable: true });
  f.dialog.dispatchEvent(next);
  assert.equal(next.defaultPrevented, false, 'with the cabinet shut, Escape closes the dialog');
});

test('the close button, a click outside and the ticket again all shut the cabinet; choosing the current theme saves nothing', (t) => {
  const f = fixture(t);
  f.q('.theme-ticket').click(); f.q('.theme-cabinet .pick-close').click();
  assert.equal(f.q('.theme-cabinet'), null);
  f.q('.theme-ticket').click(); f.dialog.querySelector('form').click();
  assert.equal(f.q('.theme-cabinet'), null, 'a click elsewhere in the dialog');
  f.q('.theme-ticket').click(); f.q('.theme-ticket').click();
  assert.equal(f.q('.theme-cabinet'), null);
  f.q('.theme-ticket').click(); f.q('.theme-cabinet .pick-cell[data-value="space"]').click();
  assert.deepEqual(f.changes, []);
});

test('sync redraws the ticket for a theme chosen elsewhere, and dispose removes the cabinet', (t) => {
  const f = fixture(t);
  f.picker.sync('wrangler');
  assert.equal(f.q('.theme-ticket').dataset.theme, 'wrangler');
  f.picker.sync('nebula');
  assert.equal(f.q('.theme-ticket').dataset.theme, 'wrangler', 'an unknown id falls back to the first theme');
  f.q('.theme-ticket').click();
  f.picker.dispose();
  assert.equal(f.q('.theme-cabinet'), null);
  assert.equal(f.dialog.classList.contains('theme-cab-open'), false);
});
