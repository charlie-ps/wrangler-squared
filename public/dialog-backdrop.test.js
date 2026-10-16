import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { closeOnBackdrop } from './dialog-backdrop.js';
import { createIntro } from './intro.js';
import { openZoom } from './job-images.js';
import client from './index.js';

const RECT = { left: 100, top: 50, right: 700, bottom: 550, width: 600, height: 500, x: 100, y: 50 };

function page(t) {
  const window = new Window({ url: 'http://localhost:7878/' });
  const prev = globalThis.document;
  globalThis.document = window.document;
  t.after(async () => { globalThis.document = prev; await window.happyDOM.close(); });
  const press = (el, x, y, button = 0) => el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button }));
  const modal = (el) => { el.getBoundingClientRect = () => RECT; return el; };
  return { window, doc: window.document, press, modal };
}

function dialogOn(p) {
  const d = p.modal(p.doc.createElement('dialog'));
  p.doc.body.appendChild(d);
  closeOnBackdrop(d);
  d.showModal();
  return d;
}

test('a press on the backdrop closes the dialog and runs its close handlers', (t) => {
  const p = page(t);
  const d = dialogOn(p);
  let closed = 0;
  d.addEventListener('close', () => closed++);
  p.press(d, 20, 20);
  assert.equal(d.open, false);
  assert.equal(closed, 1);
});

test('a press inside the card, its padding or scrollbar included, keeps it open', (t) => {
  const p = page(t);
  const d = dialogOn(p);
  d.innerHTML = '<p>text</p>';
  p.press(d.querySelector('p'), 300, 300);
  assert.equal(d.open, true, 'a child of the card');
  for (const [x, y] of [[110, 60], [695, 300], [100, 50], [700, 550]]) p.press(d, x, y);
  assert.equal(d.open, true, 'the dialog itself, inside its rect');
});

test('a right or middle press on the backdrop keeps it open', (t) => {
  const p = page(t);
  const d = dialogOn(p);
  p.press(d, 20, 20, 2);
  p.press(d, 20, 20, 1);
  assert.equal(d.open, true);
});

test('a selection that starts in the card and is released over the backdrop keeps it open', (t) => {
  const p = page(t);
  const d = dialogOn(p);
  d.innerHTML = '<p>text</p>';
  p.press(d.querySelector('p'), 300, 300);
  d.dispatchEvent(new p.window.MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 20 }));
  d.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
  assert.equal(d.open, true);
});

test('a press on a dialog stacked on top closes only that one', (t) => {
  const p = page(t);
  const d = dialogOn(p);
  const zoom = p.modal(openZoom('data:image/png;base64,', 'shot', p.doc));
  p.press(zoom, 5, 5);
  zoom.click();
  assert.equal(zoom.isConnected, false, 'the zoom closed');
  assert.equal(d.open, true, 'the dialog underneath stayed');
});

test('the job dialog closes on a backdrop press, the intro does not', (t) => {
  const p = page(t);
  const views = [];
  client.register({ register: (slot, c) => views.push(c), onMessage: () => () => {} });
  const el = p.doc.createElement('div');
  p.doc.body.appendChild(el);
  views[0].mount(el, { send() {}, openSession() {}, openDiff() {}, selectedSessionId: () => null, requestPanelRender() {}, agents: () => [], storage: null, version: '1.31.0' });
  t.after(() => views[0].unmount());
  const job = p.modal(p.doc.getElementById('job-dialog'));
  job.showModal();
  p.press(job, 20, 20);
  assert.equal(job.open, false, 'job dialog');

  createIntro({}).open(0);
  const intro = p.modal(p.doc.getElementById('jobs-intro'));
  p.press(intro, 20, 20);
  assert.equal(intro.open, true, 'intro');
});
