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
    // A selection in a focused field is the field's own, and keepFields carries it over a redraw.
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

// A field is known by its own attributes, the box it sits in (an idea box's
// conversation, a popup's `data-keep`) and its place among its kind there.
const FIELDS = 'input:not([type="file"]), textarea, select';
const signature = (el) => [el.tagName, el.type, el.id, el.name, ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`),
  el.closest('[data-change-convo]')?.dataset.changeConvo, el.closest('[data-keep]')?.dataset.keep, el.closest('[data-board]')?.dataset.board].join('|');
const checkable = (el) => el.type === 'checkbox' || el.type === 'radio';
// Only what the reader changed is theirs: a field still showing what was drawn takes the new markup's value.
const edited = (el) => checkable(el) ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.value !== el.defaultValue;

// Notes what the reader typed or ticked in `container`, and which field has the cursor
// and where; the returned function puts both back in the redrawn fields, firing `input`
// so a box re-derives its Send and height. A live tick then never has to wait for typing.
export function keepFields(container, doc = container.ownerDocument) {
  const each = (fn) => {
    const seen = new Map();
    for (const el of container.querySelectorAll(FIELDS)) {
      const sig = signature(el), n = seen.get(sig) ?? 0;
      seen.set(sig, n + 1);
      fn(`${sig}|${n}`, el);
    }
  };
  const values = new Map();
  let focus = null;
  each((key, el) => {
    if (edited(el)) values.set(key, checkable(el) ? el.checked : el.tagName === 'SELECT' ? [...el.options].map((o) => o.selected) : el.value);
    if (el === doc.activeElement) focus = { key, start: el.selectionStart, end: el.selectionEnd, dir: el.selectionDirection, top: el.scrollTop };
  });
  return () => {
    if (!values.size && !focus) return;
    each((key, el) => {
      if (values.has(key)) {
        const v = values.get(key);
        if (checkable(el)) el.checked = v;
        else if (el.tagName === 'SELECT') [...el.options].forEach((o, i) => { o.selected = !!v[i]; });
        else if (el.value !== v) { el.value = v; el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); }
      }
      if (focus?.key !== key) return;
      el.focus({ preventScroll: true });
      try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end, focus.dir || 'none'); } catch { /* a field type with no selection */ }
      el.scrollTop = focus.top;
    });
  };
}
