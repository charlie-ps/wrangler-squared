import { esc } from './util.js';
import { ICONS } from './icons.js';

// New job's Sandbox section: how a Codex step may touch the machine outside its
// worktree. It owns its own state and the form reads `value()` on submit. The
// modes and flags mirror server/manifest.js CODEX_POLICY and core's
// codexPolicyArgs (extensions/codex-policy.js), minus its network grant.
export const SANDBOX_MODES = [
  { id: 'locked', icon: 'lock', name: 'Locked to worktree', hint: 'Writes only inside the worktree. Anything else fails' },
  { id: 'auto', icon: 'shield', name: 'Auto-approve', hint: 'A reviewer model lets it step outside when the task needs it' },
  { id: 'full', icon: 'unlock', name: 'Full access', hint: 'No sandbox, no approvals. Trusted repos only' },
];
const FLAGS = { locked: '--sandbox workspace-write --ask-for-approval never', auto: '--approve-for-me', full: '--dangerously-bypass-approvals-and-sandbox' };
// Full access has no sandbox left to widen, so its folders are kept but not sent.
export const launchesLine = (mode, dirs) => `codex ${FLAGS[mode]}${mode === 'full' ? '' : dirs.map((d) => ` --add-dir ${d}`).join('')}`;
export const MAX_DIRS = 12;
const validDir = (d) => /^(\/|~\/)/.test(d) && !/[\r\n\0]/.test(d);

export function mountSandbox(el, { mode = 'auto', dirs = [] } = {}) {
  const state = { agent: 'claude', mode, dirs: [...dirs], adding: false };
  // Replacing the markup can blur the open input; that blur is not the human leaving it.
  let rendering = false;
  const render = () => { rendering = true; try { draw(); } finally { rendering = false; } };
  const draw = () => {
    const codex = state.agent === 'codex';
    const full = state.mode === 'full';
    const modes = SANDBOX_MODES.map((m) => `<button type="button" class="job-sbx tone-${m.id}" data-mode="${m.id}" aria-pressed="${m.id === state.mode}"><span class="job-review-row"><span class="job-review-stage">${ICONS[m.icon]}</span><span class="job-review-name">${m.name}<small>${m.hint}</small></span><span class="job-sbx-on">${m.id === state.mode ? ICONS.check : ''}</span></span></button>`).join('');
    const chips = state.dirs.map((d, i) => `<span class="job-sbx-chip">${esc(d)}<button type="button" data-remove="${i}" aria-label="${esc(`Remove ${d}`)}">${ICONS.x}</button></span>`).join('');
    const add = state.dirs.length >= MAX_DIRS ? '' : state.adding
      ? '<input class="job-sbx-input" aria-label="Folder path" placeholder="~/.docker" maxlength="1000" spellcheck="false" autocomplete="off">'
      : `<button type="button" class="job-sbx-add">${ICONS.plus}Folder</button>`;
    // Claude has no OS sandbox, so the whole section goes rather than saying so.
    el.hidden = !codex;
    el.innerHTML = codex ? `<legend>Sandbox</legend><div class="job-sbx-modes" role="group" aria-label="Codex sandbox">${modes}</div>
      <div class="job-sbx-dirs"${full ? ' hidden' : ''}><span class="job-sbx-label">Also writable</span><div class="job-sbx-chips">${chips}${add}</div></div>
      <div class="job-sbx-launch tone-${state.mode}"><span>Launches</span><code>${esc(launchesLine(state.mode, state.dirs))}</code></div>` : '';
    const input = el.querySelector('.job-sbx-input');
    if (input) input.focus();
  };
  const commit = (input, { keepOpen }) => {
    const d = input.value.trim().replace(/(?!^)\/+$/, '');
    if (d && !validDir(d)) { input.setAttribute('aria-invalid', 'true'); input.title = 'Use an absolute folder path or ~/path'; return; }
    if (d && !state.dirs.includes(d)) state.dirs.push(d);
    state.adding = keepOpen && Boolean(d) && state.dirs.length < MAX_DIRS;
    render();
    if (!state.adding) el.querySelector('.job-sbx-add')?.focus();
  };
  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-mode]');
    if (pick) { state.mode = pick.dataset.mode; render(); el.querySelector(`[data-mode="${state.mode}"]`)?.focus(); return; }
    const remove = e.target.closest('[data-remove]');
    if (remove) { state.dirs.splice(Number(remove.dataset.remove), 1); render(); el.querySelector('.job-sbx-add')?.focus(); return; }
    if (e.target.closest('.job-sbx-add')) { state.adding = true; render(); }
  });
  // Enter must not submit New job; it adds the chip and leaves the field open for the next.
  el.addEventListener('keydown', (e) => {
    if (!e.target.matches('.job-sbx-input')) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(e.target, { keepOpen: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.adding = false; render(); el.querySelector('.job-sbx-add')?.focus(); }
  });
  el.addEventListener('focusout', (e) => { if (e.target.matches('.job-sbx-input') && !rendering && state.adding) commit(e.target, { keepOpen: false }); });
  render();
  return {
    setAgent(agent) { if (agent !== state.agent) { state.agent = agent; state.adding = false; render(); } },
    value: () => ({ sandbox: state.mode, writableDirs: [...state.dirs] }),
  };
}
