import { plateHtml } from './job-plates.js';
import { mountSkies, releaseSkies } from './job-skylines.js';

// A theme's picture in the picker is the board itself, small: the real masthead and real
// plates (job-plates.js) for two made-up jobs, in the theme's own tokens and plate art, with
// its skies painted by job-skylines.js and its live art by the theme's own `mount`. So a new
// theme needs no art of its own to be previewed, and what the picker shows is what you get.
// Drawn at board size (`WIDTH`) and zoomed to the box it sits in.

const WIDTH = { band: 560, thumb: 420, preview: 860 };
const ago = (h) => Date.now() - h * 3600e3;
const sub = (id, title, extra) => ({ id, title, kind: 'pr', repo: '~/acme/widgets', after: [], sessions: [], repairs: [], stage: 'queued', ...extra });
const job = (id, title, h, subJobs, extra) => ({ id, title, intent: title, repos: ['~/acme/widgets'], stage: 'active', revision: 1, createdAt: ago(h), runs: [], moves: [], subJobs, plan: { context: '', stories: [], subJobs }, reviewCode: true, ...extra });
const JOBS = [
  job('theme-csv', 'Add CSV export to the reports page', 3, [
    sub('plan', 'Plan the export', { kind: 'session', stage: 'done' }), sub('api', 'Export endpoint', { after: ['plan'], stage: 'done' }),
    sub('button', 'Export button', { after: ['api'], stage: 'review', state: 'verified', ready: { checks: ['Tests pass'], receiptId: 'r1' } }),
    sub('docs', 'Document it', { after: ['button'], kind: 'session' })], { usd: 4.12 }),
  job('theme-rate', 'Rate-limit the public search API', 6, [
    sub('design', 'Design the limiter', { kind: 'session', stage: 'done' }), sub('bucket', 'Token bucket', { after: ['design'], stage: 'implementation' }),
    sub('routes', 'Wire the routes', { after: ['bucket'] })], { usd: 9.8, runs: [{ id: 'r2', subJobId: 'bucket', phase: 'implementation', stopped: false, status: 'working' }] }),
];

// A picture is only ever a preview: nothing in it is a button or link, and it is `inert`, so the
// plates' focusable graph nodes are never reached by Tab.
const inert = (html) => html.replace(/<(\/?)(?:button|a)\b/g, '<$1span');
const mast = (size) => `<header class="jobs-mast"><div class="jobs-top"><div><div class="jobs-kicker">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>Wrangler²</h1></div>
  ${size === 'band' ? '' : '<div class="jobs-telemetry"><span class="jobs-beacon"><b>2</b>&nbsp;working</span><span class="jobs-bays"><i class="on"></i><i class="on"></i><i></i><i></i></span></div><div class="jobs-tools"><span class="jobs-newjob">New idea</span></div>'}</div></header>`;

export function previewHtml(theme, size, options) {
  const art = theme.plateArt(options), jobs = size === 'preview' ? JOBS : size === 'thumb' ? JOBS.slice(0, 1) : [];
  const plates = jobs.map((j, i) => inert(plateHtml({ ...j, id: `${j.id}-${size}` }, ['opus', 'sonnet'][i], art))).join('');
  return `<div class="theme-mini ${size}" data-theme="${theme.id}" data-scheme="${theme.scheme}" data-plate-art="${art}" data-w="${WIDTH[size]}" style="width:${WIDTH[size]}px" aria-hidden="true" inert>${size === 'thumb' ? '' : mast(size)}${plates ? `<div class="jobs-plates">${plates}</div>` : ''}</div>`;
}

// Zooms each picture under `host` to its box (again whenever the box resizes: the settings
// dialog may not be laid out yet) and brings it to life: skies painted, the theme's live art
// mounted. Returns the unmount, which stops the art; `release` also drops the painted skies,
// which a redraw of the same host keeps (mountSkies puts them back by their parameters).
export function mountPreviews(host, themeOf) {
  const minis = [...host.querySelectorAll('.theme-mini')], stops = [];
  const fit = () => {
    for (const mini of minis) {
      const box = mini.parentElement, k = box.clientWidth / +mini.dataset.w;
      if (k > 0) { mini.style.zoom = k; mini.style.height = `${box.clientHeight / k}px`; }
    }
  };
  fit();
  for (const mini of minis) { const stop = themeOf(mini.dataset.theme)?.mount?.(mini); if (stop) stops.push(stop); }
  const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  for (const mini of minis) watch?.observe(mini.parentElement);
  mountSkies(host);
  return (release = true) => { watch?.disconnect(); for (const stop of stops) stop(); if (release) releaseSkies(host); };
}
