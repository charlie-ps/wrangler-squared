import { esc } from './util.js';

// Launch-plate art for the New job model picker. `describe()` turns one catalog
// entry into plain data (name, family, version, which plate to draw); the
// renderers return SVG/canvas markup for it. Every catalog string reaches markup
// through esc(). Claude and Codex art keep their own fixed palettes; the picker's
// chrome is CSS variables (jobs.css).

const SERIF = "Georgia, 'Iowan Old Style', serif", MONO = "ui-monospace, SFMono-Regular, Menlo, monospace", SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";
let uid = 0;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function rand(seed) { let s = 0; for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function hash(str) { let h = 2166136261; for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; }

const CLAUDE_DESC = {
  opus: 'Deep reasoning for planning, review and long jobs.', sonnet: 'Balanced speed and depth for everyday sub-jobs.', haiku: 'Small and quick. Good for triage and mechanical edits.',
  fable: 'The newest family on the board, for open-ended work where the brief is still forming.',
};
const SUFFIX_BODY = { sol: 'sun', luna: 'luna', terra: 'planet', astra: 'galaxy' };
const SUN_AGES = [['#ffffff', '#ffe2c4', '#f39a6b', '#7a3a6e'], ['#fff8ef', '#f6d3b4', '#d58a6a', '#4a2a44'], ['#ece6dc', '#cdb9a2', '#8b7462', '#2b2524']];

// Aliases from api.agents() ('opus', 'sonnet[1m]') carry no version, so only a
// full id ('claude-opus-6', 'claude-haiku-4-5-20251001') shows one; an alias is
// drawn by family alone.
// TODO(host-api agents-resolved-id): api.agents() should pass the id the wrangler resolves each alias to, so 'opus' can read 'Claude Opus 5.5'.
const versionOf = (id) => { const x = id.match(/-(\d+)(?:-(\d{1,2}))?(?:$|-\d{8})/); return x ? (x[2] ? `${x[1]}.${x[2]}` : x[1]) : ''; };

export function describe(agent, m, all = []) {
  const v = String(m.value), label = String(m.label || v);
  if (agent.id === 'claude' && v) {
    const bare = v.replace(/\[1m\]$/, ''), long = bare !== v;
    const fam = (bare.match(/^(?:claude-)?([a-z]+)/) || [])[1] || bare;
    const version = bare.startsWith('claude-') ? versionOf(bare) : '';
    if (/plan$/.test(fam)) {
      const lead = cap(fam.replace(/plan$/, '') || 'opus'), name = m.label ? cap(label.split('·')[0].trim()) : `${lead} plan`;
      return { name, short: name, desc: `${lead} writes the plan, then Sonnet carries it out. A cheaper way to run a long job.`, plate: 'plan', tag: `${lead} plans · Sonnet executes`.toUpperCase(), ctx: '', family: fam, version: '', resolved: '', seed: v, known: true };
    }
    const known = !!CLAUDE_DESC[fam], short = `${cap(fam)}${version ? ` ${version}` : ''}`;
    return {
      name: `Claude ${short}`, short, desc: known ? CLAUDE_DESC[fam] : 'A Claude family the picker has no launch art for yet, so it gets a plain page.',
      // An unknown family borrows Haiku's ivory page: it is the one plate that is just the name.
      plate: known ? fam : 'haiku', tag: (version ? bare : `claude-${fam}`).toUpperCase(), ctx: long ? '1M' : '200K',
      family: fam, version, resolved: bare.startsWith('claude-') ? bare : '', seed: v, known,
    };
  }
  if (agent.id === 'codex' && v) {
    const x = v.match(/^gpt-([\d.]+)(?:-([a-z]+))?/) || [], version = x[1] || '', suffix = x[2] || '';
    const kind = SUFFIX_BODY[suffix];
    const sameSuffix = suffix ? all.map((o) => String(o.value)).filter((o) => o.endsWith(`-${suffix}`)).sort((a, b) => parseFloat(b.slice(4)) - parseFloat(a.slice(4))) : [];
    const age = Math.min(2, Math.max(0, sameSuffix.indexOf(v)));
    const h = Math.floor(rand(v)() * 360);
    const orb = [`hsl(${h} 100% 97%)`, `hsl(${h} 90% 80%)`, `hsl(${(h + 40) % 360} 70% 58%)`, `hsl(${(h + 80) % 360} 50% 22%)`];
    const c = kind === 'sun' ? SUN_AGES[age] : kind === 'luna' ? ['#f4f6fb', '#c6ccdc', '#7c859c', '#1b1f2b'] : kind === 'planet' ? ['#e9fbf4', '#9ed8c4', '#3f8f86', '#123036'] : kind === 'galaxy' ? ['#ffffff', '#c9d0ff', '#7b86f0', '#2a2560'] : orb;
    // The live catalog folds the description into the label ('GPT-6.1-Sol · Latest workhorse…', trailing full stop dropped).
    const cut = label.indexOf(' · '), told = cut > 0 ? label.slice(cut + 3).trim() : '';
    const name = cut > 0 ? label.slice(0, cut).trim() : m.label ? label : version ? `GPT-${version}${suffix ? `-${cap(suffix)}` : ''}` : v;
    return {
      name, short: suffix ? cap(suffix) + (version ? ` ${version}` : '') : name, flank: version && suffix ? [`GPT-${version}`, cap(suffix)] : null, latin: `${v}${m.efforts?.length ? ` · efforts up to ${m.efforts.at(-1)}` : ''}`,
      desc: m.description || (told && (/[.!?]$/.test(told) ? told : `${told}.`)) || (kind ? `A ${suffix} model the board has just started offering.` : `Suffix “${suffix || v}” has no artwork here. Its orb is coloured from the id.`),
      plate: kind === 'galaxy' ? 'galaxy' : 'body', body: { kind: kind === 'galaxy' ? 'astra' : kind || 'sun', c, r: kind === 'sun' ? 1 - age * .14 : .85 },
      family: suffix, version, numeral: version.split('.')[0] || '?', resolved: '', seed: v, known: !!kind,
    };
  }
  const hue = Math.floor(rand(agent.id + v)() * 360);
  const own = label || String(agent.label || agent.id);
  return { name: own, short: own.replace(new RegExp(`^${String(agent.label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '') || own, latin: v, desc: `${agent.label || agent.id} has no artwork here, so its models get index cards.`, plate: 'card', hue, family: '', version: '', resolved: '', seed: v, known: false };
}

export const themeOf = (a) => (a.id === 'claude' || a.id === 'codex' ? a.id : 'generic');
export const DOTS = { claude: 'linear-gradient(180deg, #3f6fae 0 40%, #f39a4a 58%, #1a0f0e 66%)', codex: 'radial-gradient(circle, #fff 0, #c9d0ff 18%, #2a2f55 45%, #05070c 72%)' };
export const dotFor = (id) => DOTS[id] || `hsl(${hash(id) % 360} 45% 50%)`;

// effort → 1..5 detail level; an agent with fewer than two levels reads as mid.
export function effortScale(efforts, e) { if (!e) return 2; const i = efforts.findIndex((x) => x.value === e); return efforts.length < 2 ? 3 : 1 + Math.round(Math.max(0, i) / (efforts.length - 1) * 4); }

// ——— numerals as point clouds ———
// Sampled off a canvas so any version digit works; without a 2d context (node
// tests, a locked-down browser) there are simply no points and the plate is bare.
const glyphCache = new Map();
export function clearGlyphCache() { glyphCache.clear(); }
export function glyphPixels(text, font) {
  const key = text + font; if (glyphCache.has(key)) return glyphCache.get(key);
  const none = []; none.inside = () => false;
  const S = 200, c = typeof document !== 'undefined' && document.createElement('canvas'), x = c && c.getContext?.('2d', { willReadFrequently: true });
  if (!x || !x.getImageData) return none;
  c.width = c.height = S;
  x.fillStyle = '#000'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let size = 170;
  x.font = font.replace('SIZE', size + 'px');
  while (x.measureText(text).width > S * .9 && size > 40) { size -= 10; x.font = font.replace('SIZE', size + 'px'); }
  x.fillText(text, S / 2, S / 2 + 6);
  const data = x.getImageData(0, 0, S, S).data, raw = [];
  for (let y = 0; y < S; y += 2) for (let xx = 0; xx < S; xx += 2) if (data[(y * S + xx) * 4 + 3] > 128) raw.push([xx, y]);
  if (!raw.length) return none;
  const ys = raw.map((p) => p[1]), xs = raw.map((p) => p[0]), top = Math.min(...ys), bot = Math.max(...ys), mid = (Math.min(...xs) + Math.max(...xs)) / 2, k = 1.7 / Math.max(1, bot - top);
  const pts = raw.map(([px, py]) => [(px - mid) * k, (py - (top + bot) / 2) * k]), G = .04, cells = new Set(pts.map(([px, py]) => `${Math.round(px / G)},${Math.round(py / G)}`));
  pts.inside = (px, py) => cells.has(`${Math.round(px / G)},${Math.round(py / G)}`);
  glyphCache.set(key, pts); return pts;
}

// ——— Claude plates ———
// Each follows its model's launch page, in SVG with noise filters standing in for
// photo grain, rock, cloud and pencil, so nothing ships as an image. `lvl` is the
// effort's 1..5 detail level (glow, arc height); `mode` is 'full' (id and title),
// 'name' (title only, the tray) or '' (art only, the ticket band). Every plate
// declares the filters it uses in its own <defs>, so two plates never share an id.
const FX = {
  grain: '<feTurbulence type="fractalNoise" baseFrequency=".95" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values=".33 .33 .33 0 0  .33 .33 .33 0 0  .33 .33 .33 0 0  0 0 0 0 1"/>',
  streak: '<feTurbulence type="fractalNoise" baseFrequency=".003 .11" numOctaves="3" seed="5"/><feColorMatrix values=".33 .33 .33 0 0  .33 .33 .33 0 0  .33 .33 .33 0 0  0 0 0 0 1"/>',
  rock: '<feTurbulence type="fractalNoise" baseFrequency=".16 .035" numOctaves="4" seed="7" result="n"/><feDiffuseLighting in="n" surfaceScale="5" lighting-color="#e8813f" result="l"><feDistantLight azimuth="240" elevation="40"/></feDiffuseLighting><feComposite in="l" in2="SourceGraphic" operator="in"/>',
  crust: ['-5%', '-50%', '110%', '200%', '<feTurbulence type="fractalNoise" baseFrequency=".6" numOctaves="2" seed="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3.5"/>'],
  clouds: '<feTurbulence type="fractalNoise" baseFrequency=".012 .055" numOctaves="5" seed="11"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.2 0 0 0 -1.5"/><feComposite in2="SourceGraphic" operator="in"/>',
  sky1: '<feTurbulence type="fractalNoise" baseFrequency=".009 .015" numOctaves="4" seed="3" result="n"/><feColorMatrix in="n" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.4 0 0 0 -1.45" result="a"/><feGaussianBlur in="a" stdDeviation="1.4" result="ab"/><feComposite in="SourceGraphic" in2="ab" operator="in"/>',
  sky2: '<feTurbulence type="fractalNoise" baseFrequency=".014 .02" numOctaves="4" seed="17" result="n"/><feColorMatrix in="n" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.8 0 0 0 -1.9" result="a"/><feGaussianBlur in="a" stdDeviation=".8" result="ab"/><feComposite in="SourceGraphic" in2="ab" operator="in"/>',
  crater: '<feTurbulence type="fractalNoise" baseFrequency=".18" numOctaves="3" seed="21"/><feColorMatrix values="0 0 0 0 .35  0 0 0 0 .38  0 0 0 0 .48  2.6 0 0 0 -1.25"/><feComposite in2="SourceGraphic" operator="in"/>',
  sand: '<feTurbulence type="fractalNoise" baseFrequency=".05 .16" numOctaves="3" seed="9"/><feColorMatrix values="0 0 0 0 .13  0 0 0 0 .11  0 0 0 0 .1  4 0 0 0 -2.3"/><feComposite in2="SourceGraphic" operator="in"/>',
  pencil: ['-2%', '-20%', '104%', '140%', '<feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="1" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" result="d"/><feComposite in="d" in2="n" operator="arithmetic" k1="0" k2="1" k3="-.35" k4="0"/>'],
  ink: ['-2%', '-10%', '104%', '120%', '<feTurbulence type="fractalNoise" baseFrequency="1.8" numOctaves="1" seed="8"/><feDisplacementMap in="SourceGraphic" scale=".9"/>'],
  b1: ['-10%', '-10%', '120%', '120%', '<feGaussianBlur stdDeviation="1"/>'],
  b2: ['-20%', '-50%', '140%', '200%', '<feGaussianBlur stdDeviation="2.2"/>'],
  b4: ['-30%', '-30%', '160%', '160%', '<feGaussianBlur stdDeviation="3.5"/>'],
  b6: ['-30%', '-100%', '160%', '300%', '<feGaussianBlur stdDeviation="6"/>'],
};
export function fx() {
  const id = `p${uid++}`, used = new Set();
  return {
    id, f: (n) => (used.add(n), `url(#${id}${n})`),
    defs: () => [...used].map((n) => { const [x, y, w, h, body] = Array.isArray(FX[n]) ? FX[n] : ['0', '0', '100%', '100%', FX[n]]; return `<filter id="${id}${n}" x="${x}" y="${y}" width="${w}" height="${h}">${body}</filter>`; }).join(''),
  };
}
export const grainRect = (k, o, blend = 'overlay') => `<rect width="320" height="200" fill="#fff" filter="${k.f('grain')}" style="mix-blend-mode:${blend}" opacity="${o}"/>`;
const idLine = (t, y, fill) => `<text x="160" y="${y}" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="5.6" letter-spacing="1.5" fill="${fill}">${esc(t)}</text>`;
const fit = (name, size) => (name.length > 17 ? Math.round(size * 17 / name.length) : size);
const title = (name, y, size, fill, extra = '') => `<text x="160" y="${y}" text-anchor="middle" font-family="${SERIF}" font-weight="500" font-size="${fit(name, size)}" letter-spacing="-.5" fill="${fill}" ${extra}>${esc(name)}</text>`;
function jagged(x0, x1, y, amp, seed, step = 2) { const r = rand(seed); let d = `M${x0},200 L${x0},${y}`; for (let x = x0; x <= x1; x += step) d += ` L${x},${(y + (r() - .5) * amp - Math.sin(x / 3) * amp * .3).toFixed(1)}`; return d + ` L${x1},200 Z`; }
const edge = (d) => d.replace(/ L\d+,200 Z$/, '').replace(/^M\d+,200 L/, 'M');

// Opus: a grainy sunset over a dark planet, framed by collage strips; the title sits up in the blue, clear of the glow.
function opus(d, lvl, mode) {
  const k = fx(), id = k.id, hy = 136 - lvl * 2.5, rock = jagged(298, 320, 116, 6, 'rock' + d.seed);
  const body = `<rect width="320" height="200" fill="url(#${id}s)"/>
    <rect width="320" height="200" fill="#fff" filter="${k.f('streak')}" style="mix-blend-mode:soft-light" opacity=".5"/>
    <ellipse cx="160" cy="${hy}" rx="210" ry="${8 + lvl * 1.6}" fill="#ff7428" opacity="${.3 + lvl * .07}" filter="${k.f('b6')}"/>
    <ellipse cx="160" cy="${hy + 175}" rx="330" ry="175" fill="none" stroke="#ff5512" stroke-width="${2.5 + lvl * 1.2}" opacity="${.55 + lvl * .08}" filter="${k.f('b2')}"/>
    <ellipse cx="160" cy="${hy + 175}" rx="330" ry="175" fill="url(#${id}p)"/>
    <ellipse cx="160" cy="${hy + 175}" rx="330" ry="175" fill="none" stroke="#ffc08a" stroke-width=".6" opacity="${.35 + lvl * .08}"/>
    ${mode === 'full' ? idLine(d.tag, 56, '#f4ede2cc') : ''}${mode ? title(d.name, 86, 28, '#f4ede2') : ''}
    <rect width="22" height="200" fill="#efc21c"/><line x1="15.5" y1="0" x2="15.5" y2="124" stroke="#4a3d0c" stroke-width=".45"/>
    <g clip-path="url(#${id}d)"><rect width="22" height="200" fill="#d9ccb1"/><rect width="22" height="200" fill="#000" filter="${k.f('sand')}"/></g>
    <rect x="22" width="1.4" height="200" fill="#000" opacity=".55"/>
    <rect x="298" width="22" height="200" fill="#0c0b0a"/><rect x="297.4" width="1" height="200" fill="#000" opacity=".7"/>
    <g clip-path="url(#${id}r)"><rect x="298" y="100" width="22" height="100" fill="#000" filter="${k.f('rock')}"/><rect x="298" y="100" width="22" height="100" fill="#7a2a10" style="mix-blend-mode:multiply" opacity=".55"/></g>
    <path d="${edge(rock)}" fill="none" stroke="#f3dcae" stroke-width="2.2" stroke-dasharray="1.4 1" filter="${k.f('crust')}" opacity=".9"/>
    ${grainRect(k, .55)}`;
  return `<defs>${k.defs()}<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1836"/><stop offset=".22" stop-color="#244a8c"/><stop offset=".42" stop-color="#5d82c6"/><stop offset=".55" stop-color="#9c97c4"/>
      <stop offset="${(hy / 200 - .07).toFixed(3)}" stop-color="#f0a15c"/><stop offset="${(hy / 200 - .02).toFixed(3)}" stop-color="#ea4e17"/><stop offset="${(hy / 200 + .02).toFixed(3)}" stop-color="#4a160b"/><stop offset="1" stop-color="#120a08"/></linearGradient>
    <radialGradient id="${id}p" cx=".5" cy="0" r=".75"><stop offset="0" stop-color="#2a1510"/><stop offset=".35" stop-color="#150c0a"/><stop offset="1" stop-color="#080606"/></radialGradient>
    <clipPath id="${id}r"><path d="${rock}"/></clipPath><clipPath id="${id}d"><path d="M0,124 L22,127 L22,200 L0,200 Z"/></clipPath></defs>${body}`;
}
// Sonnet: Earth's limb through a spacecraft window, the frame out of focus.
function sonnet(d, lvl, mode) {
  const k = fx(), id = k.id, limb = 134 - lvl * 2, R = 330, r = rand(d.seed);
  const stars = Array.from({ length: 46 }, () => `<circle cx="${(30 + r() * 260).toFixed(1)}" cy="${(16 + r() * (limb - 20)).toFixed(1)}" r="${(.2 + r() * .45).toFixed(2)}" fill="#fff" opacity="${(.3 + r() * .6).toFixed(2)}"/>`).join('');
  const win = 'M52,22 Q160,10 268,22 Q285,24 283,40 L267,158 Q264,171 250,172 Q160,179 70,172 Q56,171 53,158 L37,40 Q35,24 52,22 Z';
  const body = `<rect width="320" height="200" fill="#040507"/>${stars}
    <circle cx="160" cy="${limb + R}" r="${R + 3}" fill="none" stroke="#4f97ff" stroke-width="${4 + lvl * 1.4}" opacity="${.5 + lvl * .08}" filter="${k.f('b2')}"/>
    <circle cx="160" cy="${limb + R}" r="${R}" fill="url(#${id}e)"/>
    <circle cx="160" cy="${limb + R}" r="${R}" fill="#fff" filter="${k.f('clouds')}" opacity=".62"/>
    <circle cx="160" cy="${limb + R}" r="${R}" fill="none" stroke="#d5ebff" stroke-width=".8" opacity="${.5 + lvl * .1}"/>
    ${mode === 'full' ? idLine(d.tag, 58, '#f4ede2cc') : ''}${mode ? title(d.name, 88, 27, '#f4ede2') : ''}
    <rect x="-10" y="20" width="12" height="160" fill="#262a34" filter="${k.f('b2')}" opacity=".7"/><rect x="306" y="30" width="14" height="150" fill="#262a34" filter="${k.f('b2')}" opacity=".6"/>
    <path d="M-10,-10 H330 V210 H-10 Z ${win}" fill="url(#${id}f)" fill-rule="evenodd" filter="${k.f('b1')}"/>
    <path d="${win}" fill="none" stroke="#8592c4" stroke-width="3" opacity=".38" filter="${k.f('b2')}"/>
    <path d="${win}" fill="none" stroke="#000" stroke-width="1"/>
    ${grainRect(k, .3)}`;
  return `<defs>${k.defs()}<radialGradient id="${id}e" cx="160" cy="${limb}" r="${R * 1.1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7aa7e6"/><stop offset=".03" stop-color="#3d72b8"/><stop offset=".1" stop-color="#1c4076"/><stop offset=".25" stop-color="#0b1a33"/></radialGradient>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1e26"/><stop offset=".5" stop-color="#0c0d12"/><stop offset="1" stop-color="#050608"/></linearGradient></defs>${body}`;
}
// Haiku: an ivory page, the name set on a curve over a pencil arc.
function haiku(d, lvl, mode) {
  const k = fx(), id = k.id, c = 22 + lvl * 7;
  const body = `<rect width="320" height="200" fill="#faf9f5"/>
    <path d="M14,154 Q160,${154 - c * 1.25} 306,154" fill="none" stroke="#1b1a18" stroke-width="1.15" filter="${k.f('pencil')}"/>
    ${mode === 'full' ? idLine(d.tag, 56 - lvl, '#1b1a18') : ''}
    ${mode ? `<text font-family="${SERIF}" font-weight="500" font-size="${fit(d.name, 29)}" letter-spacing="-.4" fill="#141413" filter="${k.f('ink')}"><textPath href="#${id}t" startOffset="50%" text-anchor="middle">${esc(d.name)}</textPath></text>` : ''}
    ${grainRect(k, .08, 'multiply')}`;
  return `<defs>${k.defs()}<path id="${id}t" d="M52,${120 + c * .15} Q160,${120 - c} 268,${120 + c * .15}"/></defs>${body}`;
}
// Fable: the launch sky. Pastel clouds parting onto blue, a waxing daytime moon, grass blurred in the foreground.
function fable(d, lvl, mode) {
  const k = fx(), id = k.id, lit = 7 + lvl * 2.6, r = rand('grass' + d.seed);
  const grass = Array.from({ length: 7 }, (_, i) => { const x = 214 + i * 15 + r() * 8, top = 98 + r() * 46, lean = 14 + r() * 26; return `<path d="M${x.toFixed(1)},212 Q${(x + lean * .3).toFixed(1)},${((top + 212) / 2).toFixed(1)} ${(x + lean).toFixed(1)},${top.toFixed(1)}" fill="none" stroke="#2c3550" stroke-width="${(2.6 + r() * 2.4).toFixed(1)}" stroke-linecap="round"/>`; }).join('');
  const body = `<rect width="320" height="200" fill="url(#${id}b)"/>
    <g mask="url(#${id}p)" opacity=".92"><circle cx="236" cy="50" r="17" fill="url(#${id}l)"/><g clip-path="url(#${id}k)"><rect x="219" y="33" width="34" height="34" fill="#fff" filter="${k.f('crater')}" opacity=".7"/></g></g>
    <g mask="url(#${id}m)"><rect width="320" height="200" fill="url(#${id}c)" filter="${k.f('sky1')}"/><rect width="320" height="200" fill="#fffaf0" filter="${k.f('sky2')}" opacity=".8"/></g>
    <g filter="${k.f('b4')}" opacity=".55">${grass}</g>
    ${mode === 'full' ? idLine(d.tag, 74, '#ffffffdd') : ''}${mode ? title(d.name, 106, 30, '#ffffff', 'style="text-shadow:0 1px 8px #3b5a9a55"') : ''}
    ${grainRect(k, .28)}`;
  return `<defs><linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f97d4"/><stop offset=".6" stop-color="#7aa0da"/><stop offset="1" stop-color="#8eafe0"/></linearGradient>
    <linearGradient id="${id}c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e2b8"/><stop offset=".45" stop-color="#efc9d6"/><stop offset=".75" stop-color="#f7e6c4"/><stop offset="1" stop-color="#eccbd8"/></linearGradient>
    <radialGradient id="${id}o" cx="160" cy="100" r="190" gradientUnits="userSpaceOnUse" gradientTransform="translate(160 100) scale(1 .62) translate(-160 -100)"><stop offset=".42" stop-color="#000"/><stop offset=".75" stop-color="#fff"/></radialGradient>
    <mask id="${id}m"><rect width="320" height="200" fill="url(#${id}o)"/></mask>
    <radialGradient id="${id}l" cx=".38" cy=".35" r=".75"><stop offset="0" stop-color="#eef1f8"/><stop offset=".7" stop-color="#c3cde3"/><stop offset="1" stop-color="#9eabc9"/></radialGradient>
    <clipPath id="${id}k"><circle cx="236" cy="50" r="17"/></clipPath>
    <mask id="${id}p"><rect width="320" height="200" fill="#fff"/><circle cx="${236 + lit}" cy="${50 - lit * .25}" r="18" fill="#000" filter="${k.f('b2')}"/></mask>${k.defs()}</defs>${body}`;
}
// Opus plan: the Opus horizon torn into the Sonnet window.
function plan(d, lvl, mode) {
  const id = `t${uid++}`, r = rand('tear' + d.seed);
  let tear = 'M158,0'; for (let y = 0; y <= 200; y += 4) tear += ` L${(158 + (r() - .5) * 5).toFixed(1)},${y}`;
  for (let y = 200; y >= 0; y -= 4) tear += ` L${(163 + (r() - .5) * 5).toFixed(1)},${y}`;
  return `<defs><clipPath id="${id}l"><rect width="160" height="200"/></clipPath><clipPath id="${id}r"><rect x="160" width="160" height="200"/></clipPath></defs>
    <g clip-path="url(#${id}l)">${opus(d, lvl, '')}</g><g clip-path="url(#${id}r)">${sonnet(d, lvl, '')}</g>
    <path d="${tear} Z" fill="#efe9dc"/>
    ${mode === 'full' ? idLine(d.tag, 68, '#f4ede2cc') : ''}${mode ? title(d.name, 98, 28, '#f4ede2', 'stroke="#0c0b0a" stroke-width="3" paint-order="stroke" stroke-opacity=".6"') : ''}`;
}
const CLAUDE_PLATES = { opus, sonnet, haiku, fable, plan };
// The Jobs board draws a job's plate from the same art, bare (mode ''), with its plan over it.
export const SCENES = ['opus', 'sonnet', 'fable', 'haiku'];
export const sceneArt = (scene, seed, lvl) => CLAUDE_PLATES[scene]({ seed }, lvl, '');
const claudePlate = (d, lvl, mode) => `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(d.name)}">${CLAUDE_PLATES[d.plate](d, lvl, mode)}</svg>`;

// ——— the board's own colours for an agent we have no art for ———
const grain = (id, a) => `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${a} 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;
function indexCard(d, detail, agent) {
  const id = `k${uid++}`, h = d.hue, label = String(agent.label || agent.id);
  return `<svg viewBox="0 0 320 200" role="img" aria-label="${esc(d.name)} card"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 45% 55%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360} 45% 30%)"/></linearGradient>${grain(id + 'g', .2)}</defs>
    <rect width="320" height="200" fill="url(#${id})"/>
    ${Array.from({ length: detail + 1 }, (_, i) => `<circle cx="270" cy="40" r="${18 + i * 16}" fill="none" stroke="#fff" stroke-opacity="${Math.max(.05, .35 - i * .04)}"/>`).join('')}
    <rect width="320" height="200" fill="#fff" filter="url(#${id}g)"/>
    <text x="24" y="40" font-family="${MONO}" font-size="8" letter-spacing="1.5" fill="#fff" opacity=".8">${esc(label.toUpperCase())}</text>
    <text x="24" y="170" font-family="${SANS}" font-weight="600" font-size="${d.short.length > 10 ? 24 : 32}" letter-spacing="-1" fill="#fff">${esc(d.short)}</text>
  </svg>`;
}

// ——— Codex plates ———
function body(d, orbits, big, label) {
  const id = `c${uid++}`, b = d.body, [c0, c1, c2, c3] = b.c, R = 34 * b.r, o = [];
  o.push(`<defs>
    <radialGradient id="${id}g" cx=".42" cy=".4" r=".62"><stop offset="0" stop-color="${c0}"/><stop offset=".35" stop-color="${c1}"/><stop offset=".72" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></radialGradient>
    <radialGradient id="${id}h" r=".5"><stop offset="0" stop-color="${c1}" stop-opacity=".55"/><stop offset=".5" stop-color="${c2}" stop-opacity=".18"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/></radialGradient>
    <filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${big ? 5 : 3}"/></filter>
    <filter id="${id}n"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .22 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <mask id="${id}m"><rect x="-100" y="-100" width="200" height="200" fill="#fff"/><circle cx="${R * .55}" cy="${-R * .3}" r="${R * .92}" fill="#000"/></mask>
    <clipPath id="${id}f"><rect x="-100" y="0" width="200" height="100"/></clipPath>
  </defs>`);
  for (let i = 0; i < orbits; i++) {
    const rr = R + 16 + i * (big ? 9 : 7), a = (i * 67) * Math.PI / 180;
    o.push(`<g class="plate-spin" style="--d:${18 + i * 9}s${i % 2 ? ';animation-direction:reverse' : ''}"><circle r="${rr}" fill="none" stroke="#fff" stroke-opacity="${Math.max(.05, .22 - i * .02)}" stroke-width=".7" ${i % 2 ? 'stroke-dasharray="1.5 3.5"' : ''}/><circle cx="${Math.cos(a) * rr}" cy="${Math.sin(a) * rr}" r="${i === 5 ? 3 : 2}" fill="${i === 5 ? c1 : '#fff'}"/></g>`);
  }
  o.push(`<circle r="${R * 2.1}" fill="url(#${id}h)"/>`);
  const sphere = `<circle r="${R}" fill="url(#${id}g)"/><circle r="${R}" fill="#fff" filter="url(#${id}n)"/>`;
  if (b.kind === 'sun') o.push(`<circle r="${R * 1.08}" fill="${c1}" opacity=".5" filter="url(#${id}b)"/>${sphere}`);
  else if (b.kind === 'luna') o.push(`<g mask="url(#${id}m)"><circle r="${R * 1.05}" fill="${c1}" opacity=".35" filter="url(#${id}b)"/>${sphere}</g>`);
  else if (b.kind === 'planet') {
    const ring = `<ellipse rx="${R * 1.75}" ry="${R * .42}" fill="none" stroke="${c1}" stroke-width="${R * .12}" stroke-opacity=".7"/>`;
    o.push(`<g transform="rotate(-16)">${ring}</g>${sphere}<g transform="rotate(-16)" clip-path="url(#${id}f)">${ring}</g>`);
  } else {
    const star = (s) => `M0,${-s} C${s * .12},${-s * .12} ${s * .12},${-s * .12} ${s},0 C${s * .12},${s * .12} ${s * .12},${s * .12} 0,${s} C${-s * .12},${s * .12} ${-s * .12},${s * .12} ${-s},0 C${-s * .12},${-s * .12} ${-s * .12},${-s * .12} 0,${-s} Z`;
    o.push(`<circle r="${R * .7}" fill="${c2}" opacity=".55" filter="url(#${id}b)"/><path d="${star(R * 1.25)}" fill="url(#${id}g)"/><path d="${star(R * .7)}" fill="#fff" transform="rotate(45)" opacity=".5"/>`);
  }
  return `<svg viewBox="-100 -100 200 200" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}">${o.join('')}</svg>`;
}
export function starfield(n, seed) { const r = rand(seed); return Array.from({ length: n }, (_, i) => `<circle class="${i % 4 ? '' : 'plate-twinkle'}" style="animation-delay:${(r() * 3).toFixed(2)}s" cx="${(r() * 100).toFixed(1)}%" cy="${(r() * 100).toFixed(1)}%" r="${(r() * .9 + .2).toFixed(2)}" fill="#fff" opacity="${(r() * .6 + .2).toFixed(2)}"/>`).join(''); }

// A "6" is drawn as a real spiral: one arm winds out of the core and becomes the stem.
function sixPoints(n, r) {
  const pts = [], bez = (t, a, b, c, d) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
  for (let i = 0; i < n; i++) {
    const u = r(), arm2 = r() < .22; let x, y, s;
    if (arm2) { s = Math.pow(r(), .8); const th = -.5 * Math.PI + s * 2.1 * Math.PI, rr = .05 + .38 * s; x = Math.cos(th) * rr; y = .25 + Math.sin(th) * rr; }
    else if (u < .62) { s = Math.pow(u / .62, .85); const th = -1.5 * Math.PI + s * 2.5 * Math.PI, rr = .05 + .51 * s; x = Math.cos(th) * rr; y = .25 + Math.sin(th) * rr; }
    else { s = (u - .62) / .38; x = bez(s, -.56, -.6, -.18, .42); y = bez(s, .25, -.42, -.98, -.86); }
    const j = .025 + .045 * (s || 0) * (arm2 ? 1.4 : 1);
    pts.push([x + (r() - .5) * 2 * j, y + (r() - .5) * 2 * j, arm2 ? .6 : 1]);
  }
  return { pts, core: [0, .25] };
}
function numeralPoints(text, n, r) {
  const px = glyphPixels(text, '500 SIZE ui-sans-serif, system-ui, sans-serif'), pts = [];
  let cx = 0, cy = 0;
  for (let i = 0; i < n && px.length; i++) { const [x, y] = px[Math.floor(r() * px.length)]; pts.push([x + (r() - .5) * .05, y + (r() - .5) * .05, 1]); cx += x; cy += y; }
  return { pts, core: [cx / Math.max(1, pts.length), cy / Math.max(1, pts.length)] };
}

// Draws one galaxy (the Astra plate) on `canvas` and returns its stop(). One
// requestAnimationFrame loop per call: the picker stops it on close and before
// every re-render, and a loop whose canvas has left the document ends itself.
export function startGalaxy(canvas, d, level) {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return () => {};
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const W = canvas.clientWidth || 600, H = canvas.clientHeight || 375; canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
  const r = rand(d.seed + level), N = Math.round((420 + level * 300) * Math.max(.18, Math.min(1, W * H / (560 * 350)))), R = H * .5, cols = ['#ffffff', '#dfe6ff', '#b9c6ff', '#ffd2b0', '#ffb98a', '#cfe2ff'];
  const { pts, core } = d.numeral === '6' ? sixPoints(N, r) : numeralPoints(d.numeral || '?', N, r);
  const stars = pts.map(([x, y, w]) => ({ x, y, s: r() < .035 ? 1.3 + r() * 1.5 : .3 + r() * .9, c: cols[Math.floor(r() * cols.length)], a: (.35 + r() * .65) * w, ph: r() * 6.3 }));
  const field = Array.from({ length: 140 }, () => ({ x: r() * W, y: r() * H, s: .3 + r() * .5, a: .15 + r() * .4, ph: r() * 6.3 }));
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches, oy = H / 2 + R * .04;
  let t = 0, raf = 0, stopped = false;
  const frame = () => {
    if (stopped) return;
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const f of field) { ctx.globalAlpha = f.a * (.7 + .3 * Math.sin(t * 1.3 + f.ph)); ctx.fillStyle = '#fff'; ctx.fillRect(f.x, f.y, f.s, f.s); }
    const gx = W / 2 + core[0] * R, gy = oy + core[1] * R, g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * .45);
    g.addColorStop(0, `rgba(255,250,240,${.5 + level * .05})`); g.addColorStop(.3, 'rgba(210,215,255,.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const x = W / 2 + s.x * R + Math.sin(t * .6 + s.ph) * .6, y = oy + s.y * R + Math.cos(t * .5 + s.ph) * .6;
      ctx.globalAlpha = s.a * (.75 + .25 * Math.sin(t * 2 + s.ph)); ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(x, y, s.s, 0, 7); ctx.fill();
      if (s.s > 1.3) { ctx.globalAlpha *= .3; ctx.beginPath(); ctx.arc(x, y, s.s * 3, 0, 7); ctx.fill(); ctx.globalAlpha = s.a * .5; ctx.fillRect(x - s.s * 5, y - .3, s.s * 10, .6); ctx.fillRect(x - .3, y - s.s * 5, .6, s.s * 10); }
    }
    ctx.globalAlpha = 1; t += .016;
    if (!still && canvas.isConnected) raf = requestAnimationFrame(frame);
  };
  frame();
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

// ——— entry points the picker uses ———
export function plateArt(d, agent, efforts, e, where) {
  const detail = effortScale(efforts, e), orbits = e ? efforts.findIndex((x) => x.value === e) + 1 : 0, big = where === 'preview';
  if (CLAUDE_PLATES[d.plate]) return claudePlate(d, detail, big ? 'full' : '');
  switch (d.plate) {
    case 'galaxy': return '<canvas aria-hidden="true"></canvas>';
    case 'card': return indexCard(d, detail, agent);
    default: return body(d, Math.min(6, Math.max(0, orbits)), big, d.name);
  }
}
// Claude thumbs follow the chosen effort like the preview does; the other agents' stay at rest.
export function plateThumb(d, agent, efforts = [], e = '') {
  if (CLAUDE_PLATES[d.plate]) return claudePlate(d, effortScale(efforts, e), 'name');
  if (d.plate === 'card') return indexCard(d, 1, agent);
  return body(d, 0, false, d.name);
}
