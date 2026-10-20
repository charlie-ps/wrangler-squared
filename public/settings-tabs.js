// Automation settings' tab row, styled after core's own Settings dialog. Every panel
// stays in the DOM (hidden, not removed), so one form spans them and Save reads every
// field whichever tab is showing. Arrow keys, Home and End move between tabs with a
// roving tabindex; `onSelect(id)` lets the caller remember the last one per viewer.

export function tabsHtml(prefix, tabs, active) {
  const on = tabs.some((t) => t.id === active) ? active : tabs[0].id;
  const row = tabs.map((t) => `<button type="button" role="tab" class="settings-tab${t.id === on ? ' active' : ''}" id="${prefix}-tab-${t.id}" aria-controls="${prefix}-panel-${t.id}" aria-selected="${t.id === on}" tabindex="${t.id === on ? 0 : -1}" data-tab="${t.id}">${t.label}</button>`).join('');
  return `<div class="settings-tabs" role="tablist" aria-label="Settings sections">${row}</div>`;
}

export function panelHtml(prefix, id, active, body) {
  return `<div class="settings-panel" role="tabpanel" id="${prefix}-panel-${id}" aria-labelledby="${prefix}-tab-${id}" data-panel="${id}"${id === active ? '' : ' hidden'}>${body}</div>`;
}

export function bindTabs(root, { onSelect = () => {} } = {}) {
  const list = root.querySelector('[role="tablist"]');
  const tabs = () => [...list.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs()) {
      const on = t === tab;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      const panel = root.querySelector(`#${t.getAttribute('aria-controls')}`);
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
    onSelect(tab.dataset.tab);
  };
  list.onclick = (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t, false); };
  list.onkeydown = (e) => {
    const all = tabs(), i = all.indexOf(e.target);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(all[(to + all.length) % all.length], true);
  };
  return { select: (id) => { const t = tabs().find((x) => x.dataset.tab === id); if (t) select(t, false); } };
}
