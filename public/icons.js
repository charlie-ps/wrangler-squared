// The glyphs the jobs view draws. ROBOT_ICON is the board's own (public/icons.js
// in agent-wrangler); the rest are Lucide-style strokes kept here because the
// board exports none of them (see public/util.js for why these stay relative).
const svg = (body, cls = '') => `<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ROBOT_ICON = svg('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>');
export const PULL_REQUEST_ICON = svg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>');
export const PERSON_ICON = svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>');
export const TICKET_ICON = svg('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 7v2M14 11v2M14 15v2"/>');
// The places a job writes to (public/jobs.js PLACES): generic strokes, never a
// brand's logo. An artifact is ICONS.sparkle.
export const SLACK_ICON = svg('<path d="M9 4L7 20M17 4l-2 16M4 9h16M3.5 15h16"/>');
export const CONFLUENCE_ICON = svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 11h6M9 14.5h6M9 18h4"/>');
export const FILE_ICON = svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M10.5 12l-2 2.5 2 2.5M13.5 12l2 2.5-2 2.5"/>');
// Somewhere the presets do not name: a pin, since the human names the place.
export const PIN_ICON = svg('<path d="M19 10c0 5.5-7 11-7 11s-7-5.5-7-11a7 7 0 0 1 14 0z"/><circle cx="12" cy="10" r="2.5"/>');
export const GLOBE_ICON = svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>');
export const ROCKET_PATH = '<path d="M12 2.5c3 2 5 5.5 5 9.5l-1.8 4H8.8L7 12c0-4 2-7.5 5-9.5z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M9.5 19.5h5"/>';
// Wrangler's mark, the planner's face on the board: the Agent Wrangler app icon's hat
// ("Western hat" by Delapouite, game-icons.net, CC BY 3.0) knocked out of a disc in the
// theme's CTA colours. `busy` shrinks it inside a turning lasso while Wrangler thinks.
const HAT_PATH = 'M199.117 111.268c-2.435.007-4.816.524-7.117 1.675-18.365 9.194-38.59 129.65-50.16 164.987 45.64 13.262 87.106 16.556 115.314 16.425 28.21-.13 68.652-3.635 112.97-16.49C358.53 242.48 338.34 122.123 320 112.943c-21.065-10.53-48.73 31.998-64 32-13.6.002-37.05-33.734-56.883-33.675zM224 160c11.53 40.5 9.107 74.724 0 96-9.107 21.276-32 11.235-32 0 25.333-6.927 26.21-35.5 32-96zm64 0c5.79 60.5 6.667 89.073 32 96 0 11.235-22.893 21.276-32 0s-11.53-55.5 0-96zM46.79 263.127c-17.5.4-24.138 17.83-14.79 40.873 11.088 30.345 58.972 96.774 112 96 24.103-.352 31.438-15.483 112-16 80.562-.517 87.88 15.648 112 16 53.017.774 100.907-65.655 112-96 13.006-32.066-4.934-53.25-40.016-32.84-21.85 11.926-44.06 17.898-65.984 24.48-.02 0-.044.024-.064.024v-.006c-45.8 13.756-87.924 17.486-116.754 17.615-28.83.13-72.027-3.357-119.145-17.548-21.897-6.618-44.09-12.59-66.027-24.565-9.866-5.74-18.374-8.19-25.22-8.033z';
const LASSO = '<g class="wrangler-mark-rope"><circle cx="256" cy="256" r="226" stroke-width="30" stroke-dasharray="44 16" stroke-linecap="round"/><ellipse cx="416" cy="416" rx="38" ry="24" transform="rotate(-45 416 416)" stroke-width="24"/></g>';
export const wranglerMark = (cls = '', busy = false) => `<svg class="wrangler-mark${cls ? ` ${cls}` : ''}${busy ? ' busy' : ''}" viewBox="0 0 512 512" aria-hidden="true"><circle class="wrangler-mark-disk" cx="256" cy="256" r="${busy ? 196 : 256}"/><g class="wrangler-mark-hat"><path d="${HAT_PATH}" transform="translate(256 ${busy ? 266 : 270}) scale(${busy ? 0.5 : 0.66}) translate(-256 -256)"/></g>${busy ? LASSO : ''}</svg>`;
export const ICONS = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.9-1"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  play: svg('<path d="M7 5l12 7-12 7z"/>'),
  spin: svg('<path d="M12 3a9 9 0 1 0 9 9"/>', 'job-spin'),
  planned: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 3.3"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  story: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  rocket: svg(ROCKET_PATH),
  merge: svg('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2v9.6M6 7.5c0 3 3 4.5 9.8 4.5"/>'),
  wrench: svg('<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5L15 12l-3-3z"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  image: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>'),
  doc: svg('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>'),
  folder: svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  branch: svg('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 5-6 4-11 7.6"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  caret: svg('<path d="m6 9 6 6 6-6"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  back: svg('<path d="M20 12H5M11 6l-6 6 6 6"/>'),
  next: svg('<path d="M4 12h15M13 6l6 6-6 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  code: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  ff: svg('<path d="M13 19l9-7-9-7z"/><path d="M2 19l9-7-9-7z"/>'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  note: svg('<path d="M4 4h16v12H8l-4 4z"/>'),
  idea: svg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  // The rail button's glyph (index.js imports it) and the intro's picture of the rail,
  // one copy so they cannot drift: a step fanning out to two, as on the job graph.
  jobs: svg('<rect x="2" y="9" width="6" height="6" rx="1.5"/><rect x="16" y="3" width="6" height="6" rx="1.5"/><rect x="16" y="15" width="6" height="6" rx="1.5"/><path d="M8 12h3M11 6v12M11 6h5M11 18h5"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  robot: ROBOT_ICON, pr: PULL_REQUEST_ICON, person: PERSON_ICON, ticket: TICKET_ICON,
  slack: SLACK_ICON, confluence: CONFLUENCE_ICON, file: FILE_ICON, globe: GLOBE_ICON, pin: PIN_ICON,
};
