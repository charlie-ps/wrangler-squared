// A press on a modal's ::backdrop closes it, like its X. mousedown rather than
// click, so a text selection or drag that starts in the card and ends outside
// keeps it open (core Agent Wrangler's settings/usage modals do the same). The
// backdrop's target is the dialog itself, but so is the card's own padding and
// scrollbar, hence the rect check. A dialog stacked on top is its own target.
export function closeOnBackdrop(dialog) {
  dialog.addEventListener('mousedown', (e) => {
    if (e.target !== dialog || e.button !== 0) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}

// A double-click that opens a modal lands its second press on whatever the new
// dialog put under the pointer (Discard, Cancel job), so pointer presses within
// OPEN_GUARD_MS of opening are swallowed before any button, link or backdrop
// sees them. A keyboard click has detail 0 and passes. Returns the mark to call
// when the dialog goes from closed to open; a redraw of an open one must not.
export const OPEN_GUARD_MS = 500;
export function guardOpen(dialog, { now = () => Date.now(), ms = OPEN_GUARD_MS } = {}) {
  let openedAt = -Infinity;
  const swallow = (e) => {
    if (e.type === 'click' && !e.detail) return;
    if (now() - openedAt < ms) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) dialog.addEventListener(type, swallow, true);
  return () => { openedAt = now(); };
}
