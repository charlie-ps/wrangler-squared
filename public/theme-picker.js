import { esc } from './util.js';
import { THEMES, applyTheme } from './themes.js';
import { previewHtml, mountPreviews } from './theme-preview.js';

// Automation settings' theme picker, built like New job's model picker (model-picker.js):
// a ticket with the current theme's art and name, that theme's options under it, and a
// cabinet over the whole dialog (`cover`) with a plate per theme. Hovering or arrowing to a
// plate previews it in the cabinet, which wears the look it previews; choosing one goes
// out at once through onChange(id), and an option through onOption(theme, key, value).
// `optionsOf(theme)` reads the saved options, so the ticket always draws what is stored.

const attr = (v) => String(v).replace(/["\\]/g, '\\$&');
const schemeTag = (t) => (t.scheme === 'dark' ? 'DARK' : 'LIGHT · DARK');
const themeAttrs = (t) => `data-theme="${esc(t.id)}"${t.scheme === 'dark' ? ' data-scheme="dark"' : ''}`;

export function mountThemePicker(el, { themes = THEMES, value, optionsOf, cover, onChange, onOption }) {
  const legend = el.querySelector('legend')?.outerHTML || '';
  const find = (id) => themes.find((t) => t.id === id) || themes[0];
  let cab = null, hoverT = 0, disposed = false, drawn = null, stopBand = null, stopCab = null;
  value = find(value).id;

  function renderTicket() {
    const t = find(value), opts = optionsOf(t);
    const optsHtml = t.options.map((o) => `<span class="pick-lab">${esc(o.label)}</span>
      <div class="theme-segs" role="radiogroup" aria-label="${esc(o.label)}">${o.values.map(([v, label]) => `<button type="button" role="radio" data-opt-key="${esc(o.key)}" data-opt="${esc(v)}" aria-checked="${v === opts[o.key]}" tabindex="${v === opts[o.key] ? 0 : -1}">${esc(label)}</button>`).join('')}</div>`).join('');
    const html = `${legend}<div class="theme-pick-row">
      <button type="button" class="pick-ticket theme-ticket" ${themeAttrs(t)} aria-haspopup="dialog" aria-expanded="${!!cab}" aria-label="${esc(t.name)} theme. Change theme">
        <span class="pick-band">${previewHtml(t, 'band', opts)}</span>
        <span class="pick-trow"><span class="pick-tname">${esc(t.name)}</span><span class="pick-tchange">CHANGE</span></span>
      </button>
      <div class="theme-opts">${optsHtml}<div class="pick-usual">${t.options.length ? `Only for ${esc(t.name)}. Kept if you switch away and back.` : `Follows the board’s light and dark mode. ${esc(t.name)} has no options.`}</div></div></div>`;
    // Unchanged markup is left alone, so a tick never takes focus off the ticket.
    if (html === drawn) return;
    stopBand?.(); el.innerHTML = drawn = html;
    stopBand = mountPreviews(el.querySelector('.pick-band'), find);
  }

  function openCabinet(previewId = value) {
    const t = find(previewId);
    if (!cab) {
      cab = document.createElement('div');
      cab.className = 'theme-cabinet';
      cab.setAttribute('role', 'dialog'); cab.setAttribute('aria-label', 'Choose a theme');
      cover.appendChild(cab);
      // Over what is in view of a scrolled dialog, which holds still while it is open.
      cab.style.top = `${cover.scrollTop || 0}px`;
      if (cover.clientHeight) cab.style.height = `${cover.clientHeight}px`;
      cover.classList.add('theme-cab-open');
    }
    applyTheme(cab, t);
    cab.dataset.preview = t.id;
    const tray = themes.map((x) => `<button type="button" class="pick-cell" role="radio" data-value="${esc(x.id)}" aria-checked="${x.id === value}" tabindex="${x.id === t.id ? 0 : -1}"><span class="pick-thumb" ${themeAttrs(x)}>${previewHtml(x, 'thumb', optionsOf(x))}</span><span class="pick-tag">${esc(x.name)}<small>${schemeTag(x)}</small></span></button>`).join('');
    cab.innerHTML = `<div class="pick-head"><b>Theme</b><small>${themes.length} available</small><button type="button" class="pick-close" aria-label="Close">ESC</button></div>
      <div class="pick-body">
        <div class="pick-preview"><div class="pick-art">${previewHtml(t, 'preview', optionsOf(t))}</div><div class="pick-pname">${esc(t.name)}</div><p class="pick-pdesc">${esc(t.blurb)}</p>
          <div class="pick-rows">${t.facts.map(([k, v]) => `<div><span>${esc(k)}</span><i></i><span>${esc(v)}</span></div>`).join('')}</div></div>
        <div class="pick-tray" role="radiogroup" aria-label="Theme">${tray}</div>
      </div>`;
    stopCab?.(false); stopCab = mountPreviews(cab, find);
    el.querySelector('.theme-ticket')?.setAttribute('aria-expanded', 'true');
  }
  function closeCabinet(refocus = true) {
    clearTimeout(hoverT); stopCab?.(); stopCab = null; cab?.remove(); cab = null; cover.classList.remove('theme-cab-open');
    const tk = el.querySelector('.theme-ticket'); tk?.setAttribute('aria-expanded', 'false'); if (refocus) tk?.focus();
  }
  function choose(id) {
    const changed = id !== value;
    value = id;
    closeCabinet(false); renderTicket(); el.querySelector('.theme-ticket')?.focus();
    if (changed) onChange(id);
  }
  const focusCell = (id) => cab?.querySelector(`.pick-cell[data-value="${attr(id)}"]`)?.focus();

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.theme-ticket')) { if (cab) closeCabinet(); else { openCabinet(); cab.querySelector('.pick-cell[tabindex="0"]')?.focus(); } return; }
    const seg = ev.target.closest('[data-opt]');
    if (!seg || seg.getAttribute('aria-checked') === 'true') return;
    const t = find(value), key = seg.dataset.optKey, v = seg.dataset.opt;
    onOption(t, key, v);
    renderTicket();
    el.querySelector(`[data-opt-key="${attr(key)}"][aria-checked="true"]`)?.focus();
  });
  el.addEventListener('keydown', (ev) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    const group = dir && ev.target.closest('.theme-segs'); if (!group) return;
    ev.preventDefault();
    const items = [...group.querySelectorAll('[data-opt]')];
    items[Math.max(0, Math.min(items.length - 1, items.indexOf(ev.target) + dir))]?.click();
  });
  cover.addEventListener('click', (ev) => {
    if (!cab) return;
    if (!cab.contains(ev.target)) { if (!el.contains(ev.target)) closeCabinet(false); return; }
    if (ev.target.closest('.pick-close')) return closeCabinet();
    const cell = ev.target.closest('.pick-cell');
    if (cell) choose(cell.dataset.value);
  });
  cover.addEventListener('pointerover', (ev) => {
    const cell = cab && ev.target.closest('.theme-cabinet .pick-cell'); if (!cell || cab.dataset.preview === cell.dataset.value) return;
    clearTimeout(hoverT); hoverT = setTimeout(() => { if (cab && !disposed) openCabinet(cell.dataset.value); }, 90);
  });
  cover.addEventListener('keydown', (ev) => {
    if (!cab) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return closeCabinet(); }
    const dir = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[ev.key];
    if (!dir || !ev.target.closest('.theme-cabinet .pick-tray')) return;
    ev.preventDefault();
    const items = [...cab.querySelectorAll('.pick-cell')], next = items[Math.max(0, Math.min(items.length - 1, items.indexOf(ev.target) + dir))];
    if (!next) return;
    const id = next.dataset.value; openCabinet(id); focusCell(id);
  });
  // Escape closes the cabinet, not the dialog around it.
  const dlg = cover.closest?.('dialog'), onCancel = (ev) => { if (cab) { ev.preventDefault(); closeCabinet(); } };
  dlg?.addEventListener('cancel', onCancel);

  renderTicket();
  return {
    value: () => value,
    // Settings changed under the open dialog (another tab, or the save landing): redraw the ticket.
    sync(id) { if (disposed || cab) return; value = find(id).id; renderTicket(); },
    dispose() { disposed = true; clearTimeout(hoverT); closeCabinet(false); stopBand?.(); dlg?.removeEventListener('cancel', onCancel); },
  };
}
