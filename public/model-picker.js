import { esc } from './util.js';
import { describe, plateArt, plateThumb, startGalaxy, themeOf, dotFor, starfield, clearGlyphCache } from './model-plates.js';

// New job's agent/model/effort picker: a ticket in the sidebar (the current
// model's art and name), an inline effort meter under it, and a cabinet that
// opens over the brief column (`cover`) for choosing a different model. It owns
// no form state: every change goes out through onChange({ agent, model, effort }),
// which the caller writes into the hidden inputs the form already submits.

const modelsOf = (a) => a?.models || [];
const effortsOf = (a, m) => (m?.efforts?.length ? (a.efforts || []).filter((e) => m.efforts.includes(e.value)) : a?.efforts || []);
const defaultOf = (a) => (modelsOf(a).find((m) => m.default) || modelsOf(a)[0])?.value || '';
const offers = (a, m, effort) => !!effort && effortsOf(a, m).some((e) => e.value === effort);

// The pick a fresh dialog opens on. Your usual wins while the catalog still has
// that agent AND model (its effort only if that model still offers it); a usual
// that has gone is ignored, and the first agent's default is used.
export function initialPick(agents, usual) {
  const ua = agents.find((x) => x.id === usual?.agent), um = modelsOf(ua).find((x) => x.value === usual?.model);
  if (ua && um) return { agent: ua.id, model: um.value, effort: offers(ua, um, usual.effort) ? usual.effort : '' };
  const a = agents[0];
  return a ? { agent: a.id, model: defaultOf(a), effort: '' } : { agent: '', model: '', effort: '' };
}

// Switching model or agent: the level stays when the new model offers it too.
export function switchPick(agents, pick, agentId, value) {
  const a = agents.find((x) => x.id === agentId), m = modelsOf(a).find((x) => x.value === value);
  return { agent: a.id, model: value, effort: offers(a, m, pick.effort) ? pick.effort : '' };
}

const attr = (v) => String(v).replace(/["\\]/g, '\\$&');
const sameCatalog = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mountModelPicker(el, { agents, usual, cover, onChange }) {
  const legend = el.querySelector('legend')?.outerHTML || '';
  const find = (id) => agents.find((a) => a.id === id);
  const modelOf = (a, v) => modelsOf(a).find((x) => x.value === v) || { value: v || '' };
  let pick = initialPick(agents, usual), stops = [], cab = null, hoverT = 0, disposed = false;

  const stopAll = (scope) => { stops = stops.filter(([s, stop]) => (s === scope ? (stop(), false) : true)); };
  const galaxies = (root, d, level, scope) => root.querySelectorAll('canvas').forEach((c) => stops.push([scope, startGalaxy(c, d, level)]));
  const usualLabel = () => {
    const ua = find(usual?.agent), um = modelsOf(ua).find((x) => x.value === usual?.model);
    return um ? describe(ua, um, modelsOf(ua)).short : '';
  };
  const isUsual = () => !!usual && usual.agent === pick.agent && usual.model === pick.model && (usual.effort || '') === pick.effort;

  function renderTicket(flutter) {
    stopAll('ticket');
    const a = find(pick.agent);
    if (!a) { el.innerHTML = `${legend}<div class="pick-usual">No agents available</div>`; onChange({ ...pick }); return; }
    const m = modelOf(a, pick.model), efforts = effortsOf(a, m), all = a.efforts || [], e = pick.effort;
    const d = describe(a, m, modelsOf(a)), cur = all.find((x) => x.value === e);
    const level = e ? efforts.findIndex((x) => x.value === e) + 1 : 0, at = all.findIndex((x) => x.value === e);
    const bars = all.map((x, i) => {
      const off = !efforts.some((y) => y.value === x.value);
      return `<button type="button" class="pick-bar${e && at >= i ? ' on' : ''}" role="radio" aria-checked="${x.value === e}" aria-label="${esc(x.label || x.value)}" title="${esc(x.label || x.value)}${off ? ` · not offered for ${esc(d.short)}` : ''}" data-effort="${esc(x.value)}" style="height:${6 + i * (16 / Math.max(1, all.length - 1))}px" tabindex="${x.value === e ? 0 : -1}" ${off ? 'disabled' : ''}></button>`;
    }).join('');
    const usualHtml = isUsual() ? 'Your usual'
      : usual && usualLabel() ? `Not your usual <button type="button" class="pick-reset">Use ${esc(usualLabel())}${usual.effort ? ` · ${esc(usual.effort)}` : ''}</button>`
        : `${esc(a.label || a.id)}'s default`;
    el.innerHTML = `${legend}
      <button type="button" class="pick-ticket ${themeOf(a)}" aria-haspopup="dialog" aria-expanded="${!!cab}" aria-label="${esc(d.name)}. Change model">
        <span class="pick-band">${plateArt(d, a, efforts, e, 'band')}</span>
        <span class="pick-trow"><span class="pick-tname">${esc(d.name)}</span><span class="pick-tchange">CHANGE</span></span>
      </button>
      <div class="pick-meter"><span class="pick-lab">Effort</span>
        <div class="pick-bars" role="radiogroup" aria-label="Effort"><button type="button" class="pick-bar auto${e ? '' : ' on'}" role="radio" aria-checked="${!e}" data-effort="" title="Leave it to the agent" tabindex="${e ? -1 : 0}">AUTO</button>${bars}</div>
        <span class="pick-val">${esc(cur ? cur.label || cur.value : 'auto')}</span></div>
      <div class="pick-usual">${usualHtml}</div>`;
    galaxies(el.querySelector('.pick-band'), d, level, 'ticket');
    if (flutter) el.querySelectorAll('.pick-band .wings').forEach((w) => w.classList.add('pick-flutter'));
    onChange({ ...pick });
  }

  function openCabinet(agentId = pick.agent, previewValue) {
    stopAll('cab');
    const a = find(agentId); if (!a) return;
    const models = modelsOf(a);
    const chosen = a.id === pick.agent ? pick.model : (a.id === usual?.agent && models.some((x) => x.value === usual.model) ? usual.model : defaultOf(a));
    const pv = models.find((x) => x.value === (previewValue || chosen)) || models[0] || { value: '' };
    const efforts = effortsOf(a, pv), e = efforts.some((x) => x.value === pick.effort) ? pick.effort : '';
    const d = describe(a, pv, models), t = themeOf(a);
    if (!cab) { cab = document.createElement('div'); cab.setAttribute('role', 'dialog'); cab.setAttribute('aria-label', 'Choose a model'); cover.appendChild(cab); }
    cab.className = `pick-cabinet ${t}`;
    const flank = d.flank ? `<span class="pick-flank l">${esc(d.flank[0])}</span><span class="pick-flank r">${esc(d.flank[1])}</span>` : '';
    const focusValue = previewValue || chosen;
    const tray = models.map((x) => {
      const dx = describe(a, x, models);
      return `<button type="button" class="pick-cell" role="radio" data-value="${esc(x.value)}" aria-checked="${x.value === chosen}" tabindex="${x.value === focusValue ? 0 : -1}"><span class="pick-thumb">${plateThumb(dx, a)}</span><span class="pick-tag">${esc(dx.short)}</span></button>`;
    }).join('');
    cab.innerHTML = `${t === 'codex' ? `<svg class="pick-sky" aria-hidden="true">${starfield(50, 'sky')}</svg>` : ''}
      <div class="pick-head" role="tablist" aria-label="Agent">${agents.map((x) => `<button type="button" class="pick-tab" role="tab" data-agent="${esc(x.id)}" aria-selected="${x === a}"><span class="pick-dot" style="background:${dotFor(x.id)}"></span>${esc(x.label || x.id)}</button>`).join('')}<button type="button" class="pick-close" aria-label="Close">ESC</button></div>
      <div class="pick-body">
        <div class="pick-preview">
          <div class="pick-art">${plateArt(d, a, efforts, e, 'preview')}${flank}</div>
          <div><div class="pick-pname">${esc(d.name)}</div><div class="pick-platin">${esc(d.latin)}</div></div>
          <p class="pick-pdesc">${esc(d.desc)}</p>
          <div class="pick-ids"><div><span>Sends</span><span>${esc(pv.value)}</span></div>${d.resolved && d.resolved !== pv.value ? `<div><span>Runs as</span><span>${esc(d.resolved)}</span></div>` : ''}</div>
        </div>
        <div class="pick-tray" role="radiogroup" aria-label="Model">${tray}</div>
      </div>`;
    galaxies(cab.querySelector('.pick-art'), d, e ? efforts.findIndex((x) => x.value === e) + 1 : 0, 'cab');
    cab.dataset.agent = a.id; cab.dataset.preview = pv.value;
    el.querySelector('.pick-ticket')?.setAttribute('aria-expanded', 'true');
  }
  function closeCabinet(refocus = true) {
    clearTimeout(hoverT); stopAll('cab'); cab?.remove(); cab = null;
    const tk = el.querySelector('.pick-ticket'); tk?.setAttribute('aria-expanded', 'false'); if (refocus) tk?.focus();
  }
  function choose(agentId, value) {
    pick = switchPick(agents, pick, agentId, value);
    closeCabinet(false); renderTicket(true); el.querySelector('.pick-ticket')?.focus();
  }
  const focusCell = (v) => cab?.querySelector(`.pick-cell[data-value="${attr(v)}"]`)?.focus();

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.pick-ticket')) { if (cab) closeCabinet(); else { openCabinet(); cab?.querySelector('.pick-cell[tabindex="0"]')?.focus(); } return; }
    const bar = ev.target.closest('.pick-bar:not([disabled])');
    if (bar) {
      pick = { ...pick, effort: bar.dataset.effort }; renderTicket(true);
      el.querySelector('.pick-bar[aria-checked="true"]')?.focus();
      if (cab) openCabinet(cab.dataset.agent, cab.dataset.preview);
      return;
    }
    if (ev.target.closest('.pick-reset')) { pick = initialPick(agents, usual); if (cab) closeCabinet(false); renderTicket(true); }
  });
  el.addEventListener('keydown', (ev) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    const group = dir && ev.target.closest('.pick-bars'); if (!group) return;
    ev.preventDefault();
    const items = [...group.querySelectorAll('.pick-bar:not([disabled])')];
    items[Math.max(0, Math.min(items.length - 1, items.indexOf(ev.target) + dir))]?.click();
  });
  cover.addEventListener('click', (ev) => {
    if (!cab) return;
    if (!cab.contains(ev.target)) { if (!el.contains(ev.target)) closeCabinet(false); return; }
    if (ev.target.closest('.pick-close')) return closeCabinet();
    const tab = ev.target.closest('.pick-tab'), cell = ev.target.closest('.pick-cell');
    if (tab) { openCabinet(tab.dataset.agent); cab.querySelector(`.pick-tab[data-agent="${attr(tab.dataset.agent)}"]`)?.focus(); }
    if (cell) choose(cab.dataset.agent, cell.dataset.value);
  });
  cover.addEventListener('pointerover', (ev) => {
    const cell = cab && ev.target.closest('.pick-cabinet .pick-cell'); if (!cell || cab.dataset.preview === cell.dataset.value) return;
    clearTimeout(hoverT); hoverT = setTimeout(() => { if (cab && !disposed) openCabinet(cab.dataset.agent, cell.dataset.value); }, 90);
  });
  cover.addEventListener('keydown', (ev) => {
    if (!cab) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return closeCabinet(); }
    const dir = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[ev.key];
    if (dir && ev.target.closest('.pick-cabinet .pick-tray')) {
      ev.preventDefault();
      const items = [...cab.querySelectorAll('.pick-cell')], next = items[Math.max(0, Math.min(items.length - 1, items.indexOf(ev.target) + dir))];
      if (!next) return;
      const v = next.dataset.value; openCabinet(cab.dataset.agent, v); focusCell(v);
    }
  });
  // Escape closes the cabinet, not the dialog around it.
  const dlg = cover.closest?.('dialog'), onCancel = (ev) => { if (cab) { ev.preventDefault(); closeCabinet(); } };
  dlg?.addEventListener('cancel', onCancel);

  renderTicket();
  return {
    pick: () => ({ ...pick }),
    // The catalog can change under an open dialog: a pick the new one no longer has
    // falls back to your usual, and an unchanged catalog costs nothing.
    agentsChanged(next) {
      if (disposed || sameCatalog(agents, next)) return;
      agents = next;
      const a = find(pick.agent);
      if (!a || !modelsOf(a).some((m) => m.value === pick.model)) pick = initialPick(agents, usual);
      else if (pick.effort && !offers(a, modelOf(a, pick.model), pick.effort)) pick = { ...pick, effort: '' };
      closeCabinet(false); renderTicket(true);
    },
    setUsual(u) { usual = u; renderTicket(); },
    rerender() { clearGlyphCache(); renderTicket(); if (cab) openCabinet(cab.dataset.agent, cab.dataset.preview); },
    dispose() { disposed = true; clearTimeout(hoverT); stopAll('ticket'); stopAll('cab'); cab?.remove(); cab = null; dlg?.removeEventListener('cancel', onCancel); },
  };
}
