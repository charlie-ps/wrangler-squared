import { usdByCard, withLiveUsd } from './job-spend.js';

// Per-job price, refreshed on its OWN slow cadence and never on the graph tick —
// core's `refreshJobSpendIfStale` (job-system server/index.js) over the façade.
// `host.usage.byCard()` walks every transcript on disk behind the wrangler's
// usage memo, so the ~4s graph serves whatever map the last refresh produced:
// `byCard()` returns synchronously and only KICKS a refresh, so the first graph
// after startup carries no cost, which is the right trade for never stalling a
// rebuild. A refresh is not paid for until some run has bound a card (nothing
// could be attributed before), and a failed read keeps the previous map with the
// timestamp backing it off like a success.
export const JOB_SPEND_REFRESH_MS = 60_000;

export class JobSpendRefresh {
  constructor({ host, refreshMs = JOB_SPEND_REFRESH_MS, now = Date.now }) {
    Object.assign(this, { host, refreshMs, now });
    this.map = new Map();
    this.at = null; // when the last read settled; null is "never"
    this.inflight = null;
    this.live = new Map();
  }

  byCard(jobs) {
    if (!this.inflight && (this.at == null || this.now() - this.at >= this.refreshMs)
      && (jobs || []).some((j) => (j.runs || []).some((r) => r.sessionId))) {
      // The executor runs synchronously, so the read starts on this tick and a
      // throw from it is a rejection rather than an escape.
      this.inflight = new Promise((resolve) => resolve(this.host.usage.byCard()))
        .then((rows) => { this.map = usdByCard(rows); })
        .catch((e) => this.host.log('job spend refresh failed', e))
        .finally(() => { this.at = this.now(); this.inflight = null; });
    }
    return this.map;
  }

  // Every card's highest live price off the graph (manifest.js `graph`).
  noteLive(sessions) {
    for (const s of sessions || []) {
      if (typeof s?.usd === 'number' && s.usd > (this.live.get(s.sessionId) ?? 0)) this.live.set(s.sessionId, s.usd);
    }
  }

  // The scan's map with each live card's fresher price folded in: what the board
  // shows and what the spend limit (job-budget.js) is held to.
  current(jobs) { return withLiveUsd(this.byCard(jobs), this.live); }

  // The refresh in flight, if any — so a caller (a test, a graph consumer that
  // wants the price NOW) can wait for the map the next tick will serve.
  settled() { return this.inflight ?? Promise.resolve(); }
}
