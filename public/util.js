// Vendored from agent-wrangler public/util.js. Kept RELATIVE rather than imported
// from the board by absolute URL (`/util.js`) so these modules also load under
// node for the view tests; two functions is cheaper than a second import scheme.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function tildify(p) {
  return p ? p.replace(/^\/(?:Users|home)\/[^/]+/, '~') : '';
}
