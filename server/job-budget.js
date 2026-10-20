import { jobUsd } from './job-spend.js';
import { DEFAULT_SPEND_LIMIT } from './jobs-schema.js';

// The per-job spend limit. Settings hold one figure, X (`spendLimit`, dollars,
// null for none, absent for the $100 default); a job holds only how many times the human has topped it up
// (`topUps`). Its limit is X × (1 + topUps), worked out on every read and never
// stored, so a new X in Settings reaches every job in flight on the next tick:
// raising it releases a job paused for budget, lowering it pauses one already
// over. Once a job's spend reaches its limit it is `budgetPaused` (claim and the
// runner's allowed() both refuse it, so no step, repair, replan, triage or mail
// starts) and every working session of its runs is interrupted. A plain Resume
// clears only the human's own pause; Add $X (the `top-up` action) is the way on.

// Minimum gap between two interrupts of one card. A card can still read
// `working` for a tick after an Escape lands, and a second Escape on an idle
// Claude composer opens its rewind menu, so one interrupt per card per window.
export const INTERRUPT_COOLDOWN_MS = 15_000;

const cents = (usd) => Math.round(usd * 100) / 100;
// Read off the raw settings (the store parses them only for a fresh file), so an
// older file with no `spendLimit` still gets the default.
export function limitStep(settings) {
  const x = settings?.spendLimit === undefined ? DEFAULT_SPEND_LIMIT : settings.spendLimit;
  return typeof x === 'number' && x > 0 ? x : null;
}
export function limitOf(settings, job) {
  const x = limitStep(settings);
  return x == null ? null : cents(x * (1 + (job?.topUps || 0)));
}
export const isOver = (usd, limit) => limit != null && typeof usd === 'number' && usd >= limit;
export const budgetHeld = (job) => !!job?.budgetPaused;

// What the limit makes of one job right now: null for a job it no longer
// governs (finished or cancelled: nothing of it can spend again).
export function budgetOf(settings, job, byCard) {
  if (job.stage === 'done' || job.cancelledAt) return null;
  const limit = limitOf(settings, job), usd = cents(jobUsd(job, byCard));
  return { limit, usd, over: isOver(usd, limit) };
}

// The board's copy: each job's limit as it stands (`spendLimit`, null for none)
// and the X that Add $X adds (`spendStep`), over the snapshot the graph contributor already priced.
export function withSpendLimit(snapshot) {
  const spendStep = limitStep(snapshot?.settings);
  return { ...snapshot, jobs: (snapshot?.jobs || []).map((job) => ({ ...job, spendLimit: limitOf(snapshot.settings, job), spendStep })) };
}

// The cards a budget-paused job may still have working: every live run's.
export const liveCards = (job) => job.runs.filter((r) => !r.stopped && r.sessionId).map((r) => r.sessionId);

export const budgetContinueMail = (job, limit) => `Wrangler² paused your job "${job.title}" at its spend limit and interrupted your turn. ${limit == null ? 'The limit is lifted' : `The limit is now $${limit.toFixed(2)}`}: carry on with your step from where you left off.`;

// One per process (server/jobs.js): the cooldown is per card, across ticks.
// `workingOf` is the card's own graph status, read raw: an idle card with a
// background shell must not get an Escape.
export class BudgetEnforcer {
  constructor({ host, workingOf, now = Date.now }) {
    Object.assign(this, { host, workingOf, now });
    this.last = new Map();
  }
  // Interrupts each working card outside its cooldown; the ids it interrupted.
  async interrupt(cards) {
    const done = [];
    for (const id of cards) {
      if (!this.workingOf(id)) continue;
      const at = this.last.get(id);
      if (at != null && this.now() - at < INTERRUPT_COOLDOWN_MS) continue;
      this.last.set(id, this.now());
      try { if (await this.host.sessions.interrupt(id)) done.push(id); } catch (e) { this.host.log('budget interrupt failed', id, e); }
    }
    return done;
  }
}
