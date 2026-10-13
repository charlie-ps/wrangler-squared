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

const SPECIES = {
  opus: { latin: 'Ornithoptera opus', sp: { len: 1.15, tip: .85, hw: .95, tail: 0, base: '#2b2a27', band: '#e2b740', spot: '#e9cf6a', eye: null, sheen: '#9ad1a0', size: 1.05, invert: true } },
  fable: { latin: 'Morpho fabulosa', sp: { len: 1.05, tip: 1, hw: 1, tail: 0, base: '#c4552e', band: '#3a1d14', spot: '#f3d7a8', eye: '#2c6e74', sheen: '#7fc4c0', size: 1 } },
  sonnet: { latin: 'Graphium sonnetum', sp: { len: .95, tip: 1.1, hw: .9, tail: 14, base: '#3d7f86', band: '#1c2a2c', spot: '#c8e3d8', eye: '#c4552e', sheen: '#b6e6ff', size: .9 } },
  haiku: { latin: 'Gonepteryx brevis', sp: { len: .75, tip: .9, hw: 1.05, tail: 0, base: '#e3bd4f', band: '#7a5320', spot: '#fff1c9', eye: '#c4552e', sheen: '#fff6c0', size: .7 } },
};
const CLAUDE_DESC = { opus: 'Deep reasoning for planning, review and long jobs.', fable: 'The newest family on the board.', sonnet: 'Balanced speed and depth for everyday sub-jobs.', haiku: 'Small and quick. Good for triage and mechanical edits.' };
const CLAUDE_PLATE = { opus: 'horizon', haiku: 'arc', fable: 'swarm', sonnet: 'specimen' };
const SUFFIX_BODY = { sol: 'sun', luna: 'luna', terra: 'planet', astra: 'galaxy' };
const SUN_AGES = [['#ffffff', '#ffe2c4', '#f39a6b', '#7a3a6e'], ['#fff8ef', '#f6d3b4', '#d58a6a', '#4a2a44'], ['#ece6dc', '#cdb9a2', '#8b7462', '#2b2524']];

function breedSpecies(seed) {
  const r = rand(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const base = pick(['#7b5a8c', '#5b7a3a', '#a33b3b', '#2f5d9c', '#b9822e', '#46606e']);
  const genus = pick(['Papilio', 'Heliconius', 'Danaus', 'Parnassius', 'Charaxes', 'Vanessa']);
  return { genus, sp: { len: .85 + r() * .3, tip: .85 + r() * .3, hw: .85 + r() * .2, tail: r() < .45 ? 10 + r() * 18 : 0, base, band: pick(['#24180f', '#1c2a2c', '#2e1a2e']), spot: pick(['#f3e3c0', '#d9efe6', '#fbe1d0']), eye: r() < .6 ? pick(['#c4552e', '#2c6e74', '#e3bd4f']) : null, sheen: pick(['#b6e6ff', '#ffd6f0', '#d8ffc0']), size: .85 + r() * .15 } };
}

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
      const fams = Object.keys(SPECIES).filter((f) => label.toLowerCase().includes(f));
      const pair = fams.length >= 2 ? fams.slice(0, 2) : [fam.replace(/plan$/, ''), 'sonnet'].filter((f) => SPECIES[f]);
      return { name: cap(label.split('·')[0].trim()), short: 'Opus plan', latin: `gynandromorph, ${pair.join(' × ')}`, desc: `${label}. Drawn as a split specimen: each half is a different species.`, plate: 'specimen', split: pair.map((f) => SPECIES[f].sp), family: fam, version: '', resolved: '', seed: v, known: true };
    }
    const known = SPECIES[fam], bred = known ? null : breedSpecies(v);
    let sp = known ? known.sp : bred.sp;
    if (long) sp = { ...sp, tail: (sp.tail || 10) + 16 };
    return {
      name: `Claude ${cap(fam)}${version ? ` ${version}` : ''}${long ? ' · 1M' : ''}`, short: `${cap(fam)}${long ? ' 1M' : ''}${version ? ` ${version}` : ''}`,
      latin: known ? (long ? `${known.latin}, long-tailed form` : known.latin) : `${bred.genus} ${fam}a · unrecorded species`,
      desc: known ? CLAUDE_DESC[fam] + (long ? ' 1M context window.' : '') : 'A family the picker has no artwork for. Its butterfly is bred from the id, so it looks the same every time.',
      plate: CLAUDE_PLATE[fam] || 'specimen', sp, family: fam, version, numeral: version ? version.split('.')[0] : fam[0].toUpperCase(),
      resolved: bare.startsWith('claude-') ? bare : '', seed: v, known: !!known,
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

// ——— butterflies ———
function wingPaths(sp) {
  const L = 70 * sp.len, H = 62 * sp.hw, tx = 85 * sp.len, ty = -48 * sp.len * sp.tip;
  const fore = `M2,-4 C${.25 * L},${-.62 * L} ${.75 * L},${-.9 * L} ${tx},${ty} C${tx + 7},${ty + 20} ${.95 * L},${-.05 * L} 2,3 Z`;
  const hind = `M2,3 C${.7 * H},${-.05 * H} ${1.15 * H},${.3 * H} ${.98 * H},${.68 * H} C${.72 * H},${.98 * H} ${.25 * H},${.72 * H} 2,12 Z`;
  const tail = sp.tail ? `M${.62 * H},${.78 * H} Q${.7 * H},${.82 * H + sp.tail} ${.6 * H},${.8 * H + sp.tail} Q${.52 * H},${.8 * H + sp.tail * .6} ${.5 * H},${.84 * H} Z` : '';
  return { fore, hind, tail, L, H, tx, ty };
}
function half(sp, detail, id, seed) {
  const r = rand(seed), p = wingPaths(sp), out = [];
  out.push(`<clipPath id="${id}f"><path d="${p.fore}"/></clipPath><clipPath id="${id}h"><path d="${p.hind}"/></clipPath>`);
  if (p.tail) out.push(`<path d="${p.tail}" fill="${sp.band}"/>`);
  out.push(`<path d="${p.hind}" fill="${sp.base}"/><path d="${p.fore}" fill="${sp.base}"/>`);
  if (sp.invert) out.push(`<g clip-path="url(#${id}f)"><path d="M10,-10 L${p.tx * .9},${p.ty * .7} L${p.tx * .7},${p.ty * .1} Z" fill="${sp.band}" opacity=".95"/></g><g clip-path="url(#${id}h)"><ellipse cx="${p.H * .55}" cy="${p.H * .35}" rx="${p.H * .38}" ry="${p.H * .26}" fill="${sp.band}"/></g>`);
  if (detail >= 1) out.push(`<g clip-path="url(#${id}f)"><path d="${p.fore}" fill="none" stroke="${sp.invert ? sp.base : sp.band}" stroke-width="13"/></g><g clip-path="url(#${id}h)"><path d="${p.hind}" fill="none" stroke="${sp.invert ? sp.base : sp.band}" stroke-width="11"/></g>`);
  if (detail >= 2) {
    const v = [];
    for (let i = 0; i < 6; i++) { const a = -1.25 + i * .22; v.push(`M3,-2 Q${Math.cos(a) * p.L * .5},${Math.sin(a) * p.L * .45} ${Math.cos(a) * p.L * 1.3},${Math.sin(a) * p.L * 1.1}`); }
    out.push(`<g clip-path="url(#${id}f)" stroke="${sp.band}" stroke-width=".9" fill="none" opacity=".55"><path d="${v.join(' ')}"/></g>`);
    const hv = [];
    for (let i = 0; i < 5; i++) { const a = .05 + i * .28; hv.push(`M3,6 L${Math.cos(a) * p.H * 1.2},${Math.sin(a) * p.H * 1.2}`); }
    out.push(`<g clip-path="url(#${id}h)" stroke="${sp.band}" stroke-width=".8" fill="none" opacity=".5"><path d="${hv.join(' ')}"/></g>`);
  }
  if (detail >= 3) {
    const s = [];
    for (let i = 0; i < 5; i++) { const t = .55 + i * .09; s.push(`<circle cx="${p.tx * t}" cy="${p.ty * (1.05 - i * .2) + 4}" r="${2.2 + r() * 1.6}"/>`); }
    for (let i = 0; i < 4; i++) { const a = .25 + i * .3; s.push(`<circle cx="${Math.cos(a) * p.H * .82}" cy="${Math.sin(a) * p.H * .82}" r="${1.8 + r() * 1.4}"/>`); }
    out.push(`<g fill="${sp.spot}" opacity=".95">${s.join('')}</g>`);
  }
  if (detail >= 4 && sp.eye) {
    const ex = p.H * .55, ey = p.H * .45;
    out.push(`<g clip-path="url(#${id}h)"><circle cx="${ex}" cy="${ey}" r="9" fill="${sp.spot}"/><circle cx="${ex}" cy="${ey}" r="6.5" fill="${sp.eye}"/><circle cx="${ex}" cy="${ey}" r="3.2" fill="${sp.band}"/><circle cx="${ex - 1.2}" cy="${ey - 1.4}" r="1.1" fill="#fff"/></g>`);
  } else if (detail >= 4) {
    out.push(`<g clip-path="url(#${id}f)" fill="${sp.spot}">${[0, 1, 2].map((i) => `<circle cx="${p.tx * (.32 + i * .14)}" cy="${p.ty * (.62 - i * .05)}" r="3.4"/>`).join('')}</g>`);
  }
  if (detail >= 5) {
    out.push(`<radialGradient id="${id}g" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="${sp.sheen}" stop-opacity=".75"/><stop offset=".6" stop-color="${sp.sheen}" stop-opacity="0"/></radialGradient>`);
    out.push(`<path d="${p.fore}" fill="url(#${id}g)" style="mix-blend-mode:screen"/><path d="${p.hind}" fill="url(#${id}g)" style="mix-blend-mode:screen"/>`);
    const m = [];
    for (let i = 0; i < 9; i++) { const t = i / 8, x = p.tx * (.98 - t * .08) - t * 4, y = p.ty + t * (p.L * .92); m.push(`<circle cx="${x - 5}" cy="${y + 2}" r="1.1"/>`); }
    out.push(`<g fill="${sp.spot}" opacity=".9" clip-path="url(#${id}f)">${m.join('')}</g>`);
  }
  out.push(`<path d="${p.fore}" fill="none" stroke="#2a211833" stroke-width=".6"/><path d="${p.hind}" fill="none" stroke="#2a211833" stroke-width=".6"/>`);
  return out.join('');
}
function bflyGroup(right, left, detail, seed, pin) {
  const id = `b${uid++}`, c = '#2a2118';
  return `<g class="wings"><g>${half(right, detail, id + 'r', seed + 'r')}</g><g transform="scale(-1,1)">${half(left, detail, id + 'l', seed + (left === right ? 'r' : 'l'))}</g></g>
    <path d="M-1,-10 Q-8,-34 -16,-42 M1,-10 Q8,-34 16,-42" stroke="${c}" stroke-width="1.1" fill="none"/><circle cx="-16" cy="-42" r="1.8" fill="${c}"/><circle cx="16" cy="-42" r="1.8" fill="${c}"/>
    <ellipse cx="0" cy="-5" rx="4" ry="7" fill="${c}"/><ellipse cx="0" cy="14" rx="3" ry="15" fill="${c}"/>
    ${pin ? '<circle cx="0" cy="-6" r="2.6" fill="#b08a3e" stroke="#6e5428" stroke-width=".6"/><circle cx="-.7" cy="-6.8" r=".8" fill="#f6e6b8"/>' : ''}`;
}
function specimen(d, detail) {
  const [r, l] = d.split || [d.sp, d.sp];
  return `<div class="plate-specimen"><svg viewBox="-100 -70 200 140" style="width:100%;height:100%;overflow:visible" role="img" aria-label="${esc(d.name)} specimen"><g transform="scale(${d.split ? 1 : d.sp.size})">${bflyGroup(r, l, detail, d.seed, true)}</g></svg></div>`;
}

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
const grain = (id, a) => `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${a} 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;
function horizon(d, detail, title = true) {
  const id = `h${uid++}`, cy = 318 - detail * 5, glow = 1.6 + detail * .9;
  return `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(d.name)} horizon"><defs>
      <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1730"/><stop offset=".3" stop-color="#2f5d9c"/><stop offset=".48" stop-color="#7f8fd6"/><stop offset="${.6 - detail * .012}" stop-color="#f0a060"/><stop offset="${.66 - detail * .01}" stop-color="#e2502a"/><stop offset=".72" stop-color="#5a1c12"/></linearGradient>
      <radialGradient id="${id}p" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#2a1612"/><stop offset=".4" stop-color="#140c0b"/><stop offset="1" stop-color="#0a0707"/></radialGradient>
      <filter id="${id}b" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${glow}"/></filter>${grain(id + 'g', .28)}</defs>
    <rect width="320" height="200" fill="url(#${id}s)"/>
    <ellipse cx="160" cy="${cy}" rx="330" ry="190" fill="none" stroke="#ff7a2e" stroke-width="${3 + detail * 1.6}" opacity="${.45 + detail * .1}" filter="url(#${id}b)"/>
    <ellipse cx="160" cy="${cy}" rx="330" ry="190" fill="url(#${id}p)"/><ellipse cx="160" cy="${cy}" rx="330" ry="190" fill="none" stroke="#ffb27a" stroke-width=".5" opacity="${.3 + detail * .1}"/>
    <rect width="320" height="200" fill="#fff" filter="url(#${id}g)"/>
    <rect width="10" height="110" fill="#f2c230"/><line x1="7" y1="0" x2="7" y2="110" stroke="#5a4a10" stroke-width=".4"/><rect y="110" width="10" height="90" fill="#cfc2a8"/>
    <rect x="310" width="10" height="200" fill="#141210"/><path d="M310,120 l4,-4 l3,3 l3,-5 v86 h-10 Z" fill="#a0442a"/>
    ${title ? `<text x="160" y="${70 - detail * 1.5}" text-anchor="middle" font-family="${MONO}" font-size="5.2" letter-spacing="1" fill="#f4ece0" opacity=".75">${esc((d.resolved || d.seed).toUpperCase())}</text>
    <text x="160" y="${100 - detail * 1.5}" text-anchor="middle" font-family="${SERIF}" font-weight="500" font-size="${d.name.length > 16 ? 23 : 27}" letter-spacing="-.4" fill="#f4ece0">${esc(d.name)}</text>` : ''}
  </svg>`;
}
function arc(d, detail, title = true) {
  const id = `a${uid++}`, k = 18 + detail * 11;
  return `<svg viewBox="0 0 320 200" role="img" aria-label="${esc(d.name)} arc"><defs>
      <filter id="${id}r"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="4"/><feDisplacementMap in="SourceGraphic" scale="1.3"/></filter>
      <path id="${id}t" d="M44,136 Q160,${136 - k * 1.25} 276,136"/></defs>
    <rect width="320" height="200" fill="#f8f7f3"/>
    <path d="M24,160 Q160,${160 - k * 1.2} 296,160" fill="none" stroke="#1b1a18" stroke-width="1.1" filter="url(#${id}r)"/>
    ${title ? `<text font-family="${SERIF}" font-weight="500" font-size="${d.name.length > 16 ? 25 : 29}" fill="#1b1a18" letter-spacing="-.3"><textPath href="#${id}t" startOffset="50%" text-anchor="middle">${esc(d.name)}</textPath></text>
    <text x="160" y="${136 - k * .62 - 32}" text-anchor="middle" font-family="${MONO}" font-size="5.2" letter-spacing="1" fill="#1b1a18">${esc((d.resolved || d.seed).toUpperCase())}</text>` : ''}
  </svg>`;
}
const COLLAGE = [
  SPECIES.fable.sp, SPECIES.fable.sp, SPECIES.sonnet.sp, SPECIES.haiku.sp, SPECIES.opus.sp,
  { len: 1.25, tip: .5, hw: .6, tail: 0, base: '#8a845c', band: '#3b3424', spot: '#d9cba0', eye: '#b8543a', sheen: '#e0f0c0', size: 1 },
  { len: 1.1, tip: .65, hw: .7, tail: 0, base: '#2e2724', band: '#c8452a', spot: '#e9c9a0', eye: null, sheen: '#ffd0b0', size: 1, invert: true },
  { len: 1, tip: 1, hw: .95, tail: 0, base: '#5a9bbd', band: '#1f2a33', spot: '#e7f1f5', eye: '#e3bd4f', sheen: '#d0f0ff', size: 1 },
  { len: 1.05, tip: 1.05, hw: .95, tail: 20, base: '#e8d36a', band: '#24211c', spot: '#f7efc6', eye: '#2f5d9c', sheen: '#fff6c0', size: 1 },
  { len: .9, tip: .95, hw: 1, tail: 0, base: '#f1ead8', band: '#45413a', spot: '#ffffff', eye: '#e07b3a', sheen: '#ffffff', size: 1 },
  { len: .95, tip: 1, hw: .95, tail: 0, base: '#e07b3a', band: '#2a1d14', spot: '#fbe3c4', eye: null, sheen: '#ffe0b0', size: 1 },
  { len: 1, tip: 1.05, hw: .9, tail: 8, base: '#3f8a74', band: '#16302a', spot: '#d8efe2', eye: '#c4552e', sheen: '#c0ffe8', size: 1 },
  { len: 1.15, tip: .6, hw: .65, tail: 0, base: '#8a6a4a', band: '#3a2a1a', spot: '#e6d2b0', eye: '#5a7a8a', sheen: '#f0e0c0', size: 1 },
];
// Fable: a specimen collage packed into the version numeral (the family initial
// for an alias), big pieces first, then smaller ones filling the gaps.
function swarm(d, detail) {
  const id = `s${uid++}`, r = rand(d.seed + 'collage'), px = glyphPixels(d.numeral, '900 SIZE "Arial Black", "Helvetica Neue", Arial, sans-serif'), U = 88;
  const tiers = [.2, .15, .115, .088, .068, .052].slice(0, 2 + detail), placed = [];
  for (const rr of tiers) for (let k = 0; k < 420 && px.length; k++) {
    const [x, y] = px[Math.floor(r() * px.length)];
    const f = rr * .62, fits = [[f, 0], [-f, 0], [0, f * .7], [0, -f * .7], [f * .7, f * .5], [-f * .7, -f * .5], [f * .7, -f * .5], [-f * .7, f * .5]].every(([dx, dy]) => px.inside(x + dx, y + dy));
    if (fits && placed.every((o) => Math.hypot(o.x - x, o.y - y) > (rr + o.rr) * .7)) placed.push({ x, y, rr, sp: COLLAGE[Math.floor(r() * COLLAGE.length)], rot: (r() - .5) * 56, i: placed.length });
  }
  placed.sort(() => r() - .5);
  const flock = placed.map((b) => `<g transform="translate(${(160 + b.x * U).toFixed(1)},${(100 + b.y * U).toFixed(1)}) rotate(${b.rot.toFixed(0)}) scale(${(b.rr * U / 82).toFixed(3)})">${bflyGroup(b.sp, b.sp, Math.min(5, detail + (b.rr > .12 ? 2 : 1)), d.seed + b.i, false)}</g>`);
  return `<svg viewBox="0 0 320 200" role="img" aria-label="Butterflies and moths forming ${esc(d.numeral)}"><defs>
      <radialGradient id="${id}" cx=".5" cy=".46" r=".78"><stop offset="0" stop-color="#f6ecd3"/><stop offset=".7" stop-color="#eedcb4"/><stop offset="1" stop-color="#dfc28c"/></radialGradient>
      <filter id="${id}d" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx=".5" dy="1.1" stdDeviation=".8" flood-color="#3a2a10" flood-opacity=".32"/></filter>${grain(id + 'g', .22)}</defs>
    <rect width="320" height="200" fill="url(#${id})"/><rect width="320" height="200" fill="#7a5a2a" filter="url(#${id}g)" opacity=".45"/>
    <g filter="url(#${id}d)">${flock.join('')}</g>
  </svg>`;
}

// ——— the board's own colours for an agent we have no art for ———
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
  switch (d.plate) {
    case 'horizon': return horizon(d, detail, big);
    case 'arc': return arc(d, detail, big);
    case 'swarm': return swarm(d, detail);
    case 'specimen': return specimen(d, detail);
    case 'galaxy': return '<canvas aria-hidden="true"></canvas>';
    case 'card': return indexCard(d, detail, agent);
    default: return body(d, Math.min(6, Math.max(0, orbits)), big, d.name);
  }
}
export function plateThumb(d, agent) {
  if (d.plate === 'horizon') return horizon(d, 2, false);
  if (d.plate === 'arc') return arc(d, 2, false);
  if (d.plate === 'card') return indexCard(d, 1, agent);
  if (d.body) return body(d, 0, false, d.name);
  return specimen(d, 2);
}
