import { esc } from './util.js';
import { THEMES } from './themes.js';
import { previewHtml, mountPreviews } from './theme-preview.js';

// Automation settings' theme picker: the themes as a radio list (each a row with its name,
// scheme and a swatch), the chosen theme's options under it, and beside them a captioned
// picture of the board in that theme, which is only ever a preview. Choosing a theme goes out
// at once through onChange(id), and an option through onOption(theme, key, value).
// `optionsOf(theme)` reads the saved options, so what is drawn is always what is stored.

const attr = (v) => String(v).replace(/["\\]/g, '\\$&');
const schemeTag = (t) => (t.scheme === 'dark' ? 'DARK' : 'LIGHT · DARK');
const themeAttrs = (t) => `data-theme="${esc(t.id)}"${t.scheme === 'dark' ? ' data-scheme="dark"' : ''}`;

export function mountThemePicker(el, { themes = THEMES, value, optionsOf, onChange, onOption }) {
  const legend = el.querySelector('legend')?.outerHTML || '';
  const find = (id) => themes.find((t) => t.id === id) || themes[0];
  let disposed = false, drawn = null, stopArt = null;
  value = find(value).id;

  function render() {
    const t = find(value), opts = optionsOf(t);
    const list = themes.map((x) => `<button type="button" class="theme-choice" role="radio" data-value="${esc(x.id)}" aria-checked="${x.id === value}" tabindex="${x.id === value ? 0 : -1}">
        <span class="theme-radio" aria-hidden="true"></span><span class="theme-cname"><b>${esc(x.name)}</b><small>${schemeTag(x)}</small></span><span class="theme-swatch" ${themeAttrs(x)} aria-hidden="true"></span></button>`).join('');
    const optsHtml = t.options.map((o) => `<span class="pick-lab">${esc(o.label)}</span>
      <div class="theme-segs" role="radiogroup" aria-label="${esc(o.label)}">${o.values.map(([v, label]) => `<button type="button" role="radio" data-opt-key="${esc(o.key)}" data-opt="${esc(v)}" aria-checked="${v === opts[o.key]}" tabindex="${v === opts[o.key] ? 0 : -1}">${esc(label)}</button>`).join('')}</div>`).join('');
    const html = `${legend}<div class="theme-pick-row">
      <div class="theme-side">
        <div class="theme-list" role="radiogroup" aria-label="Theme">${list}</div>
        <div class="theme-opts">${optsHtml}<div class="pick-usual">${t.options.length ? `Only for ${esc(t.name)}. Kept if you switch away and back.` : `Follows the board’s light and dark mode. ${esc(t.name)} has no options.`}</div></div>
      </div>
      <figure class="theme-preview" aria-label="Preview of ${esc(t.name)}">
        <figcaption class="theme-cap">Preview · ${esc(t.name)}</figcaption>
        <div class="theme-art">${previewHtml(t, 'preview', opts)}</div>
        <p class="theme-blurb">${esc(t.blurb)}</p>
      </figure></div>`;
    // Unchanged markup is left alone, and a redraw (a tick, or the save landing) puts focus back
    // on the checked radio of the group it was in, so the arrow keys keep working.
    if (html === drawn) return;
    const at = document.activeElement, group = el.contains(at) ? (at.matches('.theme-choice') ? '.theme-choice' : at.dataset.optKey ? `[data-opt-key="${attr(at.dataset.optKey)}"]` : null) : null;
    stopArt?.(false); el.innerHTML = drawn = html;
    stopArt = mountPreviews(el.querySelector('.theme-art'), find);
    if (group) focusChecked(group);
  }
  const focusChecked = (group) => el.querySelector(`${group}[aria-checked="true"]`)?.focus();

  function choose(id) {
    if (id === value) return;
    value = id;
    render(); focusChecked('.theme-choice');
    onChange(id);
  }
  function option(seg) {
    if (seg.getAttribute('aria-checked') === 'true') return;
    const key = seg.dataset.optKey;
    onOption(find(value), key, seg.dataset.opt);
    render(); focusChecked(`[data-opt-key="${attr(key)}"]`);
  }

  el.addEventListener('click', (ev) => {
    const choice = ev.target.closest('.theme-choice'); if (choice) return choose(choice.dataset.value);
    const seg = ev.target.closest('[data-opt]'); if (seg) option(seg);
  });
  // Each radiogroup (the themes, and every option's segments) moves and selects by arrow key.
  el.addEventListener('keydown', (ev) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    const group = dir && ev.target.closest('[role="radiogroup"]'); if (!group) return;
    ev.preventDefault();
    const items = [...group.querySelectorAll('[role="radio"]')];
    items[Math.max(0, Math.min(items.length - 1, items.indexOf(ev.target) + dir))]?.click();
  });

  render();
  return {
    value: () => value,
    // Settings changed under the open dialog (another tab, or the save landing): redraw.
    sync(id) { if (disposed) return; value = find(id).id; render(); },
    dispose() { disposed = true; stopArt?.(); stopArt = null; },
  };
}
