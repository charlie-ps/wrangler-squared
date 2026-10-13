import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createJobImages, imagesPanelHtml } from './job-images.js';

const PNG = Buffer.from('png-bytes').toString('base64');

function fixture(t, { stage, frameOf } = {}) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prev = { document: globalThis.document, URL: globalThis.URL };
  const created = [], revoked = [];
  globalThis.document = window.document;
  globalThis.URL = Object.assign(function (...a) { return new prev.URL(...a); }, { createObjectURL: () => { const u = `blob:${created.length}`; created.push(u); return u; }, revokeObjectURL: (u) => revoked.push(u) });
  t.after(async () => { globalThis.document = prev.document; globalThis.URL = prev.URL; await window.happyDOM.close(); });
  document.body.innerHTML = `<div class="job-outcome"><textarea></textarea>${imagesPanelHtml()}</div>`;
  const root = document.querySelector('.job-outcome');
  const staged = [];
  const images = createJobImages({
    root, input: root.querySelector('textarea'), attach: root.querySelector('.job-images-attach'), fileInput: root.querySelector('input[type=file]'),
    stage: stage || (async (blob) => { staged.push(blob); return { name: `paste-1700000000000-aaaa111${staged.length}.png` }; }),
    frameOf: frameOf || (async () => ({ mime: 'image/png', dataBase64: PNG })),
  });
  const file = (name, type = 'image/png') => new window.File(['x'], name, { type });
  const drop = (files) => { const e = new window.Event('drop', { bubbles: true, cancelable: true }); e.dataTransfer = { files, types: ['Files'], items: [], getData: () => '' }; root.dispatchEvent(e); return e; };
  const paste = (files) => { const e = new window.Event('paste', { bubbles: true, cancelable: true }); e.clipboardData = { files, items: [], types: ['Files'], getData: () => '' }; root.querySelector('textarea').dispatchEvent(e); return e; };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { window, root, images, file, drop, paste, settle, staged, created, revoked, q: (s) => root.querySelector(s), qa: (s) => [...root.querySelectorAll(s)] };
}

test('a pasted screenshot shows a numbered thumbnail with a spinner until it is staged, and planning is held back meanwhile', async (t) => {
  let release;
  const f = fixture(t, { stage: () => new Promise((r) => { release = () => r({ name: 'paste-1700000000000-aaaa1111.png' }); }) });
  const e = f.paste([f.file('Screenshot.png')]);
  assert.equal(e.defaultPrevented, true);
  assert.equal(f.images.busy(), true, 'busy while decoding');
  await f.settle();
  assert.equal(f.qa('.job-image').length, 1);
  assert.ok(f.q('.job-image').classList.contains('uploading'));
  assert.equal(f.q('.job-image-num').textContent, '1');
  assert.equal(f.q('.job-image-name').textContent, 'Screenshot.png');
  assert.equal(f.q('.job-image-thumb img').getAttribute('src'), 'blob:0');
  assert.equal(f.images.busy(), true);
  assert.deepEqual(f.images.names(), []);
  release(); await f.settle();
  assert.equal(f.images.busy(), false);
  assert.ok(!f.q('.job-image').classList.contains('uploading'));
  assert.deepEqual(f.images.names(), ['paste-1700000000000-aaaa1111.png']);
  assert.equal(f.q('.job-images-count').textContent, '1 of 8');
});

test('a text-only paste is left alone', (t) => {
  const f = fixture(t);
  assert.equal(f.paste([]).defaultPrevented, false);
});

test('a drop names every non-image file and still takes the images beside it', async (t) => {
  const f = fixture(t);
  const e = f.drop([f.file('a.png'), f.file('notes.txt', 'text/plain'), f.file('spec.pdf', 'application/pdf')]);
  assert.equal(e.defaultPrevented, true);
  await f.settle();
  assert.equal(f.q('.job-images-error').hidden, false);
  assert.equal(f.q('.job-images-error').textContent, 'notes.txt, spec.pdf are not images');
  assert.equal(f.images.names().length, 1);
});

test('at most 8 images: the rest are skipped with a message and Attach is disabled', async (t) => {
  const f = fixture(t);
  f.drop(Array.from({ length: 10 }, (_, i) => f.file(`s${i}.png`)));
  await f.settle();
  assert.equal(f.images.names().length, 8);
  assert.equal(f.q('.job-images-count').textContent, '8 of 8');
  assert.equal(f.q('.job-images-error').textContent, '2 images were skipped — a job holds 8');
  assert.equal(f.q('.job-images-attach').disabled, true);
});

test('removing a picture frees its slot and its object URL, and numbers close up', async (t) => {
  const f = fixture(t);
  f.drop([f.file('a.png'), f.file('b.png')]);
  await f.settle();
  f.q('.job-image-remove').click();
  assert.deepEqual(f.qa('.job-image-name').map((n) => n.textContent), ['b.png']);
  assert.equal(f.q('.job-image-num').textContent, '1');
  assert.equal(f.revoked.length, 1);
  assert.equal(f.images.names().length, 1);
});

test('a failed upload drops the tile and says which file', async (t) => {
  const f = fixture(t, { stage: async () => { throw new Error('not an image'); } });
  f.drop([f.file('bad.png')]);
  await f.settle();
  assert.equal(f.qa('.job-image').length, 0);
  assert.equal(f.q('.job-images-error').textContent, 'bad.png: not an image');
  assert.equal(f.images.busy(), false);
});

test('clicking a thumbnail enlarges it in a nested dialog that removes itself on close', async (t) => {
  const f = fixture(t, {});
  const window = f.window;
  f.drop([f.file('a.png')]);
  await f.settle();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'dialog') { el.showModal = () => { el.open = true; }; el.close = () => { el.open = false; el.dispatchEvent(new window.Event('close')); }; }
    return el;
  };
  f.q('.job-image-thumb').click();
  const zoom = document.querySelector('.job-image-zoom');
  assert.equal(zoom.querySelector('img').getAttribute('src'), 'blob:0');
  zoom.click();
  assert.equal(document.querySelector('.job-image-zoom'), null);
});

test('dispose drops pending uploads so a closed dialog attaches nothing', async (t) => {
  const f = fixture(t);
  f.drop([f.file('a.png')]);
  f.images.dispose();
  await f.settle();
  assert.equal(f.qa('.job-image').length, 0);
  assert.deepEqual(f.images.names(), []);
});
