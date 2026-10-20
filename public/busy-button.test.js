import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { pressBusy, isBusy, submitterOf, BUSY_MS } from './busy-button.js';

function page(t, html) {
  const window = new Window();
  window.document.body.innerHTML = html;
  t.after(() => window.happyDOM.close());
  return window;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a press is busy and disabled at once, and a second press is refused', (t) => {
  const b = page(t, '<button>Merge</button>').document.querySelector('button');
  assert.equal(pressBusy(b), true);
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.equal(b.disabled, true);
  assert.equal(isBusy(b), true);
  assert.equal(pressBusy(b), false, 'a double-click sends once');
  assert.ok(BUSY_MS >= 5000, 'long enough for a slow broadcast');
});

test('with no redraw the timeout hands the button back, alternatives included', async (t) => {
  const d = page(t, '<div><button id="go">Approve</button><button id="skip">Skip</button><button id="off" disabled>Off</button></div>').document;
  const [go, skip, off] = ['#go', '#skip', '#off'].map((s) => d.querySelector(s));
  assert.equal(pressBusy(go, { ms: 20, also: d.querySelectorAll('button') }), true);
  assert.deepEqual([go.disabled, skip.disabled, isBusy(skip)], [true, true, false], 'Skip is held, not busy');
  await wait(60);
  assert.deepEqual([isBusy(go), go.disabled, skip.disabled, off.disabled], [false, false, false, true], 'a button disabled before stays disabled');
  assert.equal(pressBusy(go, { ms: 20 }), true, 'pressable again');
});

test('a redraw that replaces the button clears the state, and the old timer is harmless', async (t) => {
  const d = page(t, '<div id="host"><button>Retry</button></div>').document;
  pressBusy(d.querySelector('button'), { ms: 20 });
  d.querySelector('#host').innerHTML = '<button>Retry</button>';
  assert.equal(isBusy(d.querySelector('button')), false);
  await wait(60);
  assert.equal(d.querySelector('button').disabled, false);
});

test('an already disabled button is never pressed', (t) => {
  const b = page(t, '<button disabled>Approve</button>').document.querySelector('button');
  assert.equal(pressBusy(b), false);
  assert.equal(b.hasAttribute('aria-busy'), false);
  assert.equal(pressBusy(null), false);
});

test('a form is sent by its submitter, else its primary button', (t) => {
  const d = page(t, '<form><button type="button">Back</button><button class="primary">Save</button><button name="alt">Alt</button></form>').document;
  const form = d.querySelector('form');
  assert.equal(submitterOf({ submitter: d.querySelector('[name="alt"]'), target: form }).textContent, 'Alt');
  assert.equal(submitterOf({ submitter: form, target: form }).textContent, 'Save');
  assert.equal(submitterOf({ submitter: null, target: form }).textContent, 'Save');
});
