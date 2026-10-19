// Live ticks rebuild the board and the open detail from markup, which would drop a
// text selection and snap sideways scrollers back to the start under the reader.

// Every horizontal scroller a redraw may replace.
export const SCROLLERS = ['.job-graph-scroll', '.job-msg-run', '.jobs-idea-cmd code'];

// A redraw waits while a selection or a press (mouse drag, finger swipe) is inside
// one of `regions()`, and the last one asked for runs once the reader lets go.
export function createRedrawHold(regions, doc = document) {
  let down = false, touches = 0, waiting = null;
  const inside = (node) => !!node && regions().some((r) => r?.contains(node));
  const selecting = () => {
    // A selection in a focused field is the field's own, and a redraw already leaves a focused field be.
    if (doc.activeElement?.matches?.('input, textarea')) return false;
    const s = doc.getSelection?.();
    return !!s && !s.isCollapsed && (inside(s.anchorNode) || inside(s.focusNode));
  };
  const held = () => down || touches > 0 || selecting();
  const release = () => {
    if (!waiting || held()) return;
    const run = waiting; waiting = null; run();
  };
  doc.addEventListener('pointerdown', (e) => { if (inside(e.target)) down = true; }, true);
  // A touch scroll cancels its pointer while the finger is still down; the touch count covers that.
  for (const t of ['pointerup', 'pointercancel']) doc.addEventListener(t, () => { down = false; release(); }, true);
  doc.addEventListener('touchstart', (e) => { if (inside(e.target)) touches = e.touches.length; }, { capture: true, passive: true });
  for (const t of ['touchend', 'touchcancel']) doc.addEventListener(t, (e) => { touches = e.touches.length; release(); }, { capture: true, passive: true });
  doc.addEventListener('selectionchange', release);
  doc.defaultView?.addEventListener('blur', () => { down = false; touches = 0; release(); });
  return {
    held,
    run(fn) {
      if (held()) { waiting = fn; return false; }
      waiting = null; fn(); return true;
    },
  };
}

// Notes where each scroller in `container` is scrolled sideways; the returned
// function puts the redrawn ones back. A scroller is known by its selector, the
// plate it sits on and its place among its kind there, so plates reordering
// between ticks does not hand one job's offset to another.
export function keepScrollX(container, scrollers = SCROLLERS) {
  const each = (fn) => {
    const seen = new Map();
    for (const sel of scrollers) for (const el of container.querySelectorAll(sel)) {
      const key = `${sel}|${el.closest('[data-board]')?.dataset.board ?? ''}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      fn(`${key}|${n}`, el);
    }
  };
  const at = new Map();
  each((key, el) => { if (el.scrollLeft) at.set(key, el.scrollLeft); });
  return () => { if (at.size) each((key, el) => { if (at.has(key)) el.scrollLeft = at.get(key); }); };
}
