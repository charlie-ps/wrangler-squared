import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { tabsHtml, panelHtml, bindTabs } from './settings-tabs.js';
import { initJobsView, SETTINGS_TABS, SETTINGS_TAB_KEY } from './jobs-view.js';
import { createUpdates } from './updates.js';

const memoryStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { map: m, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }; };

function page(t) {
  const window = new Window({ url: 'http://localhost:7878/' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const q = (s) => document.querySelector(s);
  const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  return { window, q, key };
}

const TABS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
const shown = () => [...document.querySelectorAll('[role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.dataset.panel);
const selected = () => [...document.querySelectorAll('[role="tab"]')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.tab);

function mount(p, active = 'a', onSelect) {
  document.body.innerHTML = `<div id="root">${tabsHtml('x', TABS, active)}${TABS.map((t) => panelHtml('x', t.id, active, t.label)).join('')}</div>`;
  return bindTabs(p.q('#root'), { onSelect });
}

test('the tab row is a tablist whose tabs control labelled panels, one showing', (t) => {
  const p = page(t); mount(p, 'b');
  const tab = p.q('#x-tab-b'), panel = p.q('#x-panel-b');
  assert.equal(p.q('.settings-tabs').getAttribute('role'), 'tablist');
  assert.deepEqual([tab.getAttribute('aria-controls'), panel.getAttribute('aria-labelledby'), panel.getAttribute('role')], ['x-panel-b', 'x-tab-b', 'tabpanel']);
  assert.deepEqual([selected(), shown()], [['b'], ['b']]);
  assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map((b) => b.tabIndex), [-1, 0, -1], 'only the active tab is in the tab order');
  document.body.innerHTML = tabsHtml('x', TABS, 'gone');
  assert.deepEqual(selected(), ['a'], 'an unknown tab falls back to the first');
});

test('a click switches tab and panel, and reports the pick', (t) => {
  const p = page(t); const picks = []; mount(p, 'a', (id) => picks.push(id));
  p.q('#x-tab-c').click();
  assert.deepEqual([selected(), shown(), picks], [['c'], ['c'], ['c']]);
  assert.ok(p.q('#x-tab-c').classList.contains('active')); assert.ok(!p.q('#x-tab-a').classList.contains('active'));
});

test('arrow keys move between tabs and wrap, Home and End jump, and focus follows', (t) => {
  const p = page(t); mount(p, 'a');
  p.key(p.q('#x-tab-a'), 'ArrowRight'); assert.deepEqual([selected(), document.activeElement.id], [['b'], 'x-tab-b']);
  p.key(p.q('#x-tab-b'), 'ArrowRight'); p.key(p.q('#x-tab-c'), 'ArrowRight'); assert.deepEqual(selected(), ['a'], 'right from the last wraps');
  p.key(p.q('#x-tab-a'), 'ArrowLeft'); assert.deepEqual(selected(), ['c'], 'left from the first wraps');
  p.key(p.q('#x-tab-c'), 'Home'); assert.deepEqual(shown(), ['a']);
  p.key(p.q('#x-tab-a'), 'End'); assert.deepEqual(shown(), ['c']);
  p.key(p.q('#x-tab-c'), 'Enter'); assert.deepEqual(shown(), ['c'], 'other keys do nothing');
});

function settings(p, storage, settingsData = {}) {
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [];
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), getAgents: () => [], onSession: () => {}, onDiff: () => {}, onBoard: () => false, updates: createUpdates({ storage: null, updates: [{ id: 'a', date: '2026-09-01', title: 'A release', body: '' }] }), storage });
  view.update({ jobs: [], settings: { concurrency: 2, maxRepairs: 2, ...settingsData } });
  p.q('#jobs-settings').click();
  return sent;
}

test('Automation settings groups its fields into General, Automation, Review defaults, Appearance and What’s new', (t) => {
  const p = page(t); settings(p, null);
  assert.deepEqual([...document.querySelectorAll('#job-dialog [role="tab"]')].map((b) => b.textContent), SETTINGS_TABS.map((x) => x.label));
  assert.deepEqual(shown(), ['general'], 'General opens first');
  const inPanel = (id) => p.q(`#job-settings-panel-${id}`);
  const form = p.q('#job-settings-form');
  assert.deepEqual(['ideApp', 'updateMain', 'maxRepairs', 'maxReplans', 'deploymentStaleMinutes', 'reviewPlan'].map((n) => form.elements[n].closest('[role="tabpanel"]').dataset.panel), ['general', 'general', 'automation', 'automation', 'automation', 'review']);
  assert.deepEqual([...inPanel('general').querySelectorAll('.job-settings-section h3')].map((h) => h.textContent), ['Editor', 'Local checkout']);
  assert.deepEqual([...inPanel('automation').querySelectorAll('.job-settings-section h3')].map((h) => h.textContent), ['Repairs and replans', 'Deployments']);
  assert.ok(inPanel('appearance').querySelector('#job-theme-pick .theme-ticket'), 'the theme picker mounts in its hidden panel');
  assert.ok(inPanel('updates').querySelector('.update-item'));
  assert.ok(p.q('#job-settings-form .job-actions'), 'Save sits under every tab');
});

test('Save from another tab sends every field, including those on tabs not showing', (t) => {
  const p = page(t); const sent = settings(p, null);
  const form = p.q('#job-settings-form');
  form.elements.ideApp.value = 'Rider'; form.elements.updateMain.checked = false;
  p.q('#job-settings-tab-automation').click(); form.elements.maxRepairs.value = '4';
  p.q('#job-settings-tab-updates').click();
  assert.deepEqual(shown(), ['updates']);
  form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(sent.at(-1).patch, { maxRepairs: 4, maxReplans: 2, deploymentStaleMinutes: 30, ideApp: 'Rider', updateMain: false, reviewDefaults: { reviewPlan: true, reviewCode: true, reviewMerge: true, reviewSessions: true, reviewWrites: false, reviewRed: true } });
});

test('the last tab is remembered per viewer and reopens next time', (t) => {
  const p = page(t); const storage = memoryStorage();
  settings(p, storage);
  p.q('#job-settings-tab-appearance').click();
  assert.equal(storage.get(SETTINGS_TAB_KEY), 'appearance');
  p.q('#job-dialog').close(); p.q('#jobs-settings').click();
  assert.deepEqual(shown(), ['appearance']);
  const broken = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); } };
  settings(p, broken);
  assert.deepEqual(shown(), ['general'], 'storage that throws falls back to General');
  p.q('#job-settings-tab-review').click(); assert.deepEqual(shown(), ['review']);
});
