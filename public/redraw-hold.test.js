import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createRedrawHold, keepScrollX } from './redraw-hold.js';

function page(t, html = '<div id="board"><p id="text">Some words to select</p><input id="field" value="typed"></div><p id="outside">Elsewhere</p>') {
  const window = new Window({ url: 'http://localhost:7878' });
  t.after(() => window.happyDOM.close());
  const doc = window.document;
  doc.body.innerHTML = html;
  const fire = (target, type, init = {}) => target.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), init));
  const select = (node) => { const r = doc.createRange(); r.selectNodeContents(node); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r); };
  return { window, doc, fire, select, $: (s) => doc.querySelector(s) };
}

test('a redraw runs at once when nothing holds it', (t) => {
  const { doc, $ } = page(t);
  const hold = createRedrawHold(() => [$('#board')], doc);
  let ran = 0;
  assert.equal(hold.run(() => ran++), true);
  assert.equal(ran, 1);
});

test('a selection inside waits the redraw, and the last one asked runs once it is cleared', (t) => {
  const { doc, fire, select, $ } = page(t);
  const hold = createRedrawHold(() => [$('#board')], doc);
  const ran = [];
  select($('#text'));
  assert.equal(hold.held(), true);
  assert.equal(hold.run(() => ran.push('first')), false);
  hold.run(() => ran.push('second'));
  assert.deepEqual(ran, []);
  fire(doc, 'selectionchange');
  assert.deepEqual(ran, [], 'still selected');
  doc.getSelection().removeAllRanges();
  fire(doc, 'selectionchange');
  assert.deepEqual(ran, ['second'], 'only the latest redraw, once');
  fire(doc, 'selectionchange');
  assert.deepEqual(ran, ['second']);
});

test('a selection outside the regions, or in a focused field, holds nothing', (t) => {
  const { doc, select, $ } = page(t);
  const hold = createRedrawHold(() => [$('#board')], doc);
  select($('#outside'));
  assert.equal(hold.held(), false);
  select($('#text'));
  $('#field').focus();
  assert.equal(hold.held(), false);
});

test('a press inside holds until it lets go, even when a touch scroll cancels the pointer', (t) => {
  const { doc, fire, $ } = page(t);
  const hold = createRedrawHold(() => [$('#board')], doc);
  let ran = 0;
  fire($('#outside'), 'pointerdown');
  assert.equal(hold.held(), false, 'a press outside is not ours');
  fire($('#text'), 'pointerdown');
  hold.run(() => ran++);
  fire($('#text'), 'pointerup');
  assert.equal(ran, 1, 'mouse up flushes');
  fire($('#text'), 'touchstart', { touches: [{}] });
  fire($('#text'), 'pointerdown');
  hold.run(() => ran++);
  fire($('#text'), 'pointercancel');
  assert.equal(ran, 1, 'the finger is still down');
  fire($('#text'), 'touchend', { touches: [] });
  assert.equal(ran, 2);
});

test('scrollers redrawn keep their sideways offset, matched per plate', (t) => {
  const plate = (id) => `<div data-board="${id}"><div class="job-graph-scroll"></div></div>`;
  const { $ } = page(t, `<div id="host">${plate('a')}${plate('b')}<pre class="job-msg-run"></pre></div>`);
  const host = $('#host');
  host.querySelector('[data-board="b"] .job-graph-scroll').scrollLeft = 240;
  host.querySelector('.job-msg-run').scrollLeft = 30;
  const restore = keepScrollX(host);
  host.innerHTML = `${plate('b')}${plate('a')}${plate('c')}<pre class="job-msg-run"></pre>`;
  restore();
  assert.equal(host.querySelector('[data-board="b"] .job-graph-scroll').scrollLeft, 240, 'follows its plate to a new place');
  assert.equal(host.querySelector('[data-board="a"] .job-graph-scroll').scrollLeft, 0);
  assert.equal(host.querySelector('[data-board="c"] .job-graph-scroll').scrollLeft, 0);
  assert.equal(host.querySelector('.job-msg-run').scrollLeft, 30);
});
