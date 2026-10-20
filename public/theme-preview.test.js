import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window } from 'happy-dom';
import { previewHtml, mountPreviews } from './theme-preview.js';
import { THEMES, themeById, optionsOf } from './themes.js';

function dom(t) {
  const window = new Window();
  const prev = globalThis.document; globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  return window.document;
}

test('a theme\'s picture is the board itself: its masthead and real plates in its own plate art', () => {
  const space = themeById('space'), wrangler = themeById('wrangler');
  const big = previewHtml(space, 'preview', { plateArt: 'quiet' });
  assert.match(big, /^<div class="theme-mini preview" data-theme="space" data-scheme="dark" data-plate-art="quiet" data-w="860" style="width:860px" aria-hidden="true" inert>/);
  assert.match(big, /<header class="jobs-mast">[\s\S]*<h1>Wrangler²<\/h1>/);
  assert.equal(big.match(/<article class="job-plate /g).length, 2);
  assert.equal(big.match(/class="gx"/g).length, 2, 'Space\'s plates carry their painted skies');
  assert.match(big, /Review code/, 'one plate asks for a review, the other is working');
  assert.match(big, /<span type="button" class="job-plate-go opens"[^>]*><span>Review<\/span><svg class="icon"/, 'its stub keeps the opens pill, inert');
  assert.match(previewHtml(space, 'preview', { plateArt: 'full' }), /<svg class="scene"/, 'the plate art option shows');
  const plain = previewHtml(wrangler, 'preview', {});
  assert.match(plain, /data-scheme="host" data-plate-art="plain"/);
  assert.doesNotMatch(plain, /class="gx"|class="scene"/, 'a theme with no art draws none');
  assert.equal(previewHtml(space, 'band', { plateArt: 'quiet' }).includes('job-plate'), false, 'the ticket band is only the masthead');
  assert.equal(previewHtml(space, 'thumb', { plateArt: 'quiet' }).includes('jobs-mast'), false, 'a thumb is one plate');
});

test('a picture holds no button or link, since the picker\'s own buttons wrap it', () => {
  for (const theme of THEMES) for (const size of ['band', 'thumb', 'preview']) {
    assert.doesNotMatch(previewHtml(theme, size, optionsOf({}, theme)), /<(button|a)\b/, `${theme.id} ${size}`);
  }
});

test('mounting runs each picture\'s theme\'s own live art, and the unmount stops it', (t) => {
  const document = dom(t);
  const host = document.createElement('div');
  host.innerHTML = `<span class="box">${previewHtml(themeById('space'), 'band', { plateArt: 'quiet' })}</span><span class="box">${previewHtml(themeById('wrangler'), 'band', {})}</span>`;
  document.body.appendChild(host);
  const mounted = [], stopped = [];
  const themes = { space: { mount: (el) => { mounted.push(el.dataset.theme); return () => stopped.push(el.dataset.theme); } }, wrangler: {} };
  const stop = mountPreviews(host, (id) => themes[id]);
  assert.deepEqual(mounted, ['space'], 'a theme without a mount runs nothing');
  stop();
  assert.deepEqual(stopped, ['space']);
});

test('a picture defines what #jobs defines for the plates inside it, or their text falls back to 16px', () => {
  const css = fs.readFileSync(new URL('./jobs.css', import.meta.url), 'utf8');
  const own = (sel) => { const at = css.indexOf(`\n${sel} {`); return new Set([...css.slice(at, css.indexOf('}', at)).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])); };
  const mini = own('.theme-mini');
  assert.ok(own('#jobs').size, 'jobs.css has a #jobs block');
  for (const name of own('#jobs')) assert.ok(mini.has(name), `.theme-mini sets ${name}`);
});
