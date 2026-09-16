// Leaf logging for the modules that run before any host façade exists (store
// construction, atomic-json's corrupt-file backup). Everything that HAS a host
// should log through `host.log`, which the wrangler timestamps and prefixes
// `[ext:jobs]`; these are the few call sites that cannot.
export function log(...args) { console.log('[ext:jobs]', ...args); }
export function logWarn(...args) { console.warn('[ext:jobs]', ...args); }
export function logError(...args) { console.error('[ext:jobs]', ...args); }
