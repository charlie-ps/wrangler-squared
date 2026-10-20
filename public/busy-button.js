// A press that waits on the server shows it at once: aria-busy plus disabled,
// so a second click cannot send it again. The next broadcast redraws the button
// and with it the state; a refusal redraws nothing, so a timer hands it back.
// `also` are its alternatives (a stub's Skip beside Approve): held, not busy.
export const BUSY_MS = 8000;

// False when the button is already busy or disabled: the caller sends nothing.
export function pressBusy(button, { ms = BUSY_MS, also = [] } = {}) {
  if (!button || button.disabled || isBusy(button)) return false;
  const held = [...also].filter((b) => b !== button && !b.disabled);
  button.setAttribute('aria-busy', 'true');
  for (const b of [button, ...held]) b.disabled = true;
  (button.ownerDocument?.defaultView || globalThis).setTimeout(() => {
    if (!isBusy(button)) return;
    button.removeAttribute('aria-busy');
    for (const b of [button, ...held]) b.disabled = false;
  }, ms);
  return true;
}

export const isBusy = (button) => button?.getAttribute('aria-busy') === 'true';
// The button that sent a form, else its primary one (requestSubmit with no submitter).
export const submitterOf = (e) => (e.submitter?.tagName === 'BUTTON' ? e.submitter : e.target.querySelector('button.primary'));
