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
