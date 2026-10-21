import { ICONS } from './icons.js';
import { applyTheme } from './themes.js';
import { closeOnBackdrop } from './dialog-backdrop.js';
import { esc } from './util.js';

// The hidden early-adopter switch (host API 1.39). The host draws no UI for
// `api.earlyAdopter`, so we offer it behind a gesture nobody makes by accident:
// Wrangler²'s own theme (Automation settings) swapped back and forth between the
// same two themes, SWAPS changes inside WINDOW_MS: off yours, back on, off,
// back on again. Only the opt-in is ours; the host follows the
// branch on the next update and falls back to the default branch without it.
export const SWAPS = 4;
export const WINDOW_MS = 10000;

// note({ id, from? }) per theme choice; returns true on the change that
// completes the gesture, then starts over. `from` is the theme the choice left;
// without one the first change counts with an unknown `from` that any reverse
// matches. A repeat of the same id is not a change, and a change that is
// not the reverse of the last one starts a new chain from itself.
export function createSwapDetector({ swaps = SWAPS, windowMs = WINDOW_MS, now = () => Date.now() } = {}) {
  let current = null;
  let chain = [];
  return {
    note(theme) {
      const id = theme?.id;
      if (theme?.from) current = theme.from;
      if (!id || id === current) return false;
      const from = current;
      current = id;
      const at = now();
      const last = chain.at(-1);
      chain = last && (last.from == null || last.from === id) && last.to === from && at - chain[0].at <= windowMs ? [...chain, { from, to: id, at }] : [{ from, to: id, at }];
      if (chain.length < swaps) return false;
      chain = [];
      return true;
    },
  };
}

// A small dialog with the switch and the branch it tracks. `ea` is
// api.earlyAdopter: `enabled()` is re-read on every open, and the switch stays
// where the server put it, so a refused set() puts it back and says why.
export function createEarlyAdopterDialog({ ea, document: doc = globalThis.document }) {
  let dialog = null;
  let busy = false;
  let error = '';

  function render() {
    const on = ea.enabled();
    dialog.querySelector('.ea-body').innerHTML = `<label class="job-toggle ea-toggle">Early adopter<input type="checkbox" class="job-switch" name="earlyAdopter"${on ? ' checked' : ''}${busy ? ' disabled' : ''}></label>
      <p class="ea-state" data-ea-state>${on ? `Tracking <code class="ea-branch">${esc(ea.branch)}</code>: the next update installs early builds.` : 'Following the default branch.'}</p>
      ${error ? `<p class="ea-error" role="alert">${esc(error)}</p>` : ''}`;
    dialog.querySelector('[name=earlyAdopter]').onchange = (e) => toggle(e.target.checked);
  }

  async function toggle(on) {
    busy = true;
    error = '';
    render();
    try { await ea.set(on); } catch (err) { error = err?.message || String(err); }
    busy = false;
    if (dialog) render();
  }

  function build() {
    dialog = doc.createElement('dialog');
    dialog.className = 'job-dialog ea-dialog';
    dialog.setAttribute('aria-labelledby', 'jobs-ea-title');
    dialog.innerHTML = `<button class="job-dialog-close" aria-label="Close" title="Close">${ICONS.x}</button>
      <h2 id="jobs-ea-title">Early adopter</h2>
      <p>Get Wrangler² builds before they reach everyone. They may be rough. Turning it off returns to the default branch at the next update.</p>
      <div class="ea-body"></div>`;
    doc.body.appendChild(dialog);
    closeOnBackdrop(dialog);
    dialog.querySelector('.job-dialog-close').onclick = () => dialog.close();
  }

  return {
    open() {
      if (!dialog || !dialog.isConnected) build();
      error = '';
      render();
      applyTheme(dialog);
      if (!dialog.open) dialog.showModal();
    },
    get element() { return dialog; },
    remove() { dialog?.remove(); dialog = null; },
  };
}

// The gesture wired to the dialog: the Jobs view hands every theme choice to
// note(). A board older than 1.39, or a manifest the host read no branch from,
// has no api.earlyAdopter, and the gesture then does nothing.
export function createEarlyAdopterGesture(api, { document: doc = globalThis.document, now } = {}) {
  const detector = createSwapDetector({ now });
  let ui = null;
  return {
    note(choice) {
      if (!detector.note(choice) || !api?.earlyAdopter?.branch) return;
      (ui ||= createEarlyAdopterDialog({ ea: api.earlyAdopter, document: doc })).open();
    },
  };
}
