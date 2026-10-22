import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createRedrawHold, keepFields, keepScrollX } from './redraw-hold.js';

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

test('fields redrawn keep what was typed, the cursor and focus, matched per box; untouched ones take the new markup', (t) => {
  const box = (convo, draft = '') => `<div class="job-change" data-change-convo="${convo}"><textarea>${draft}</textarea></div>`;
  const drawn = (status) => `<p>${status}</p>${box('c1')}${box('')}<details data-keep="approve-note"><textarea data-approve-note></textarea></details><input id="count" value="${status}"><input type="checkbox" id="tick">`;
  const { window, doc, $ } = page(t, `<div id="host">${drawn('Running')}</div>`);
  const host = $('#host'), inputs = [];
  const c1 = () => host.querySelector('[data-change-convo="c1"] textarea');
  c1().value = 'Half a thought'; c1().focus(); c1().setSelectionRange(2, 6);
  host.querySelector('[data-approve-note]').value = 'Use the v2 table';
  $('#tick').checked = true;
  const restore = keepFields(host);
  host.innerHTML = `<div class="job-change" data-change-convo="new"><textarea></textarea></div>${drawn('Passing')}`;
  host.querySelectorAll('textarea').forEach((el) => el.addEventListener('input', () => inputs.push(el)));
  restore();
  assert.equal(host.querySelector('p').textContent, 'Passing', 'the status moved on');
  assert.equal(c1().value, 'Half a thought', 'the words followed their conversation, not their place');
  assert.equal(host.querySelector('[data-change-convo="new"] textarea').value, '');
  assert.equal(host.querySelector('[data-change-convo=""] textarea').value, '');
  assert.equal(doc.activeElement, c1(), 'focus is back in it');
  assert.deepEqual([c1().selectionStart, c1().selectionEnd], [2, 6], 'with the cursor where it was');
  assert.equal(host.querySelector('[data-approve-note]').value, 'Use the v2 table', 'a popup\'s note survives');
  assert.equal($('#tick').checked, true);
  assert.equal($('#count').value, 'Passing', 'a field nobody changed shows the new value');
  assert.deepEqual(inputs, [c1(), host.querySelector('[data-approve-note]')], 'a restored box hears input, so it re-derives its Send');
  assert.ok(window);
});
