import { THEME_IDS, DEFAULT_THEME } from './theme-ids.js';
import { mountMastSky } from './job-skylines.js';

// The Jobs view's themes, in the picker's order. Each one is an entry here, a
// [data-theme="<id>"] block of --jt-* tokens in jobs.css, and its id in theme-ids.js:
//   scheme   'dark' forces the board's dark palette on #jobs and its dialogs ([data-scheme="dark"]);
//            'host' follows the board's light or dark mode.
//   options  theme-only choices, drawn under the picker's list and saved in settings.themeOptions[id];
//            the server schema must list each one.
//   mount    optional live art for #jobs (or the picker's small copy of it, theme-preview.js);
//            returns its unmount. A theme without one runs no loops.
//   plateArt what a plate is drawn over (job-plates.js PLATE_ART), from the theme's options.

// The masthead's Gargantua glare (job-skylines.js), on a canvas only Space puts there.
function mountSpace(root) {
  const top = root.querySelector('.jobs-top');
  if (!top) return () => {};
  const canvas = document.createElement('canvas');
  canvas.className = 'jobs-mast-sky';
  canvas.setAttribute('aria-hidden', 'true');
  top.prepend(canvas);
  const stop = mountMastSky(canvas);
  return () => { stop(); canvas.remove(); };
}

export const THEMES = [
  {
    id: 'wrangler', name: 'Wrangler', scheme: 'host',
    blurb: 'Agent Wrangler’s own look: the board’s surfaces, system type and small radii, light or dark with the board. Nothing animates.',
    options: [],
    plateArt: () => 'plain',
  },
  {
    id: 'space', name: 'Space', scheme: 'dark',
    blurb: 'The night sky Jobs has always had: a Gargantua masthead, black-hole plates and serif titles. Always dark, whatever the board is set to.',
    options: [{ key: 'plateArt', label: 'Plate art', default: 'quiet', values: [['quiet', 'Skylines'], ['full', 'Launch scenes']] }],
    mount: mountSpace,
    plateArt: (o) => o.plateArt,
  },
];

export { THEME_IDS };
const fallback = () => THEMES.find((t) => t.id === DEFAULT_THEME);
export const themeById = (id) => THEMES.find((t) => t.id === id) || fallback();
// Settings the server has not migrated yet (or a theme this build lacks) open in the default.
export const themeOf = (settings) => themeById(settings?.theme);
// A theme's saved options, each falling back to its default when missing or no longer offered.
export function optionsOf(settings, theme) {
  const saved = settings?.themeOptions?.[theme.id] || {};
  return Object.fromEntries(theme.options.map((o) => [o.key, o.values.some(([v]) => v === saved[o.key]) ? saved[o.key] : o.default]));
}
// The theme #jobs last drew in, for the dialogs opened on <body> outside jobs-view (the intro, an image zoom).
let current = null;
export const currentTheme = () => current || fallback();
export const setCurrentTheme = (t) => { current = t; };
export function applyTheme(el, theme = currentTheme()) {
  if (!el) return;
  el.dataset.theme = theme.id;
  if (theme.scheme === 'dark') el.dataset.scheme = 'dark'; else delete el.dataset.scheme;
}
