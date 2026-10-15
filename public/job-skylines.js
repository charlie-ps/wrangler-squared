import { hash } from './model-plates.js';

// A job's quiet sky: a Gargantua painted on canvas. The lensed ring of gas turns
// over a black cap rising from the plate's foot, a beam streams off to one side,
// and a white-hot flare sits where they meet. The gas takes the job's state
// colour and the cap grows as the job lands, but never into the plan: the graph
// reports its `floor` (the lowest node or label, in plate units of 320 × 150) and
// everything bright fades to a third above it. Art colours are fixed.
// plateHtml only writes a placeholder; `mountSkies` paints it on the client.
export const PAL = {
  run: ['#070220', '#22128a', '#4530d8', '#6f7cff', '#9eabff', '#d9deff', '#ffffff'],
  warn: ['#1c0c00', '#663800', '#c07406', '#f59e1b', '#ffc85c', '#ffeec4', '#ffffff'],
  bad: ['#1e0100', '#6c0a02', '#c41c06', '#f43a12', '#ff6a3c', '#ffc0a6', '#ffffff'],
  ok: ['#011410', '#054a2e', '#12935c', '#2ccf87', '#7aefb6', '#d4ffec', '#ffffff'],
  pause: ['#0f041f', '#3c1477', '#6c38c8', '#a06af2', '#c59cff', '#ecdcff', '#ffffff'],
  idle: ['#0b0d12', '#2a2f3b', '#525a6b', '#8a90a0', '#cfd2da', '#f4f4f6', '#ffffff'],
};
export const paletteOf = (tone) => PAL[tone] || PAL.idle;

// The cap grows as the job lands, but stays 14 units clear of the plan's lowest node or label.
export const capFor = (lvl, floor) => Math.min(36 + 5 * lvl, Math.max(13, 150 - floor - 14));

const FLOOR = 60;
export function skyHtml(seed, tone, lvl, floor = FLOOR, dim = false) {
  const t = PAL[tone] ? tone : 'idle';
  return `<div class="gx" data-seed="${hash(`${seed}${lvl}`).toString(36)}" data-tone="${t}" data-lvl="${lvl}" data-floor="${Math.round(floor)}"${dim ? ' data-dim' : ''}></div>`;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function ramp(stops) {
  const c = stops.map(hex);
  return (t, a = 1) => {
    t = Math.max(0, Math.min(1, t)) * (c.length - 1);
    const i = Math.min(c.length - 2, Math.floor(t)), f = t - i, m = c[i].map((v, k) => Math.round(v + (c[i + 1][k] - v) * f));
    return `rgba(${m[0]},${m[1]},${m[2]},${a})`;
  };
}
function rng(str) {
  let a = 2166136261;
  for (const ch of str) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const gauss = (r) => (r() + r() + r() + r() - 2) / .577;
const el = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; if (p) p.appendChild(e); return e; };
function cv(w, h, dpr, parent, cls) {
  const c = el('canvas', cls, parent);
  c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  return [c, x];
}
// A blurred shape without ctx.filter (Safari): draw it off-canvas and let only its shadow land.
function soft(x, dpr, blur, color, draw) {
  x.save(); x.shadowColor = color; x.shadowBlur = blur * dpr; x.shadowOffsetX = 1e4 * dpr; x.translate(-1e4, 0); x.fillStyle = x.strokeStyle = '#000'; draw(x); x.restore();
}

function paint(art) {
  const W = art.clientWidth;
  if (!W) return false;
  const H = W * 150 / 320, s = W / 320, R = 150 * s, D = art.dataset;
  const pal = ramp(paletteOf(D.tone)), lvl = +D.lvl || 1, floor = +D.floor || FLOOR;
  const r = rng(D.seed), dpr = Math.min(1.25, devicePixelRatio || 1);
  const dir = r() < .5 ? -1 : 1, heat = (.8 + .05 * lvl) * ('dim' in D ? .62 : 1);
  const cap = capFor(lvl, floor);
  const cx = W * (.5 + dir * (.04 + r() * .04)), cy = H + R - cap * s;
  const phi = (36 + r() * 8) * Math.PI / 180, d = [dir * Math.cos(phi), -Math.sin(phi)];
  // The hot point sits on the rim just below the bottom edge, off to the side: only the beam and the flare's spill reach into view.
  const th = Math.acos(Math.max(-1, 1 - (cap + 5) * s / R)), hp = [cx + dir * R * 1.01 * Math.sin(th), cy - R * 1.01 * Math.cos(th)];
  const P0 = [hp[0] - d[0] * R, hp[1] - d[1] * R], at = (q) => [P0[0] + d[0] * q * R, P0[1] + d[1] * q * R];
  art.replaceChildren();

  const [, b] = cv(W, H, dpr, art, 'l');
  const sky = b.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#020306'); sky.addColorStop(1, '#07070a'); b.fillStyle = sky; b.fillRect(0, 0, W, H);
  for (let i = 0; i < 2; i++) {
    const x = r() * W, y = r() * H * .6, rr = (.3 + r() * .4) * W, g = b.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, pal(.3, .06)); g.addColorStop(1, pal(.3, 0)); b.fillStyle = g; b.fillRect(0, 0, W, H);
  }
  for (let i = 0; i < 120; i++) {
    const x = r() * W, y = r() * H, dx = x - cx, dy = y - cy, dd = Math.hypot(dx, dy);
    if (dd < R * 1.04) continue;
    const sz = (.22 + r() ** 3 * 1.05) * s * .75, a = .2 + r() * .6, k = Math.max(0, (1.3 * R - dd) / (.26 * R));
    b.save(); b.translate(x, y); b.rotate(Math.atan2(dy, dx) + Math.PI / 2);
    b.fillStyle = r() < .2 ? `rgba(255,226,196,${a})` : `rgba(232,236,255,${a})`;
    b.beginPath(); b.ellipse(0, 0, sz * (1 + 2.2 * k * k), sz * Math.max(.35, 1 - .6 * k), 0, 0, 7); b.fill(); b.restore();
  }

  // Everything bright sits in .fx, whose mask drops it to a third above the plan's floor.
  const fx = el('div', 'fx', art), fp = (v) => `${(Math.max(0, Math.min(150, v)) / 1.5).toFixed(1)}%`;
  fx.style.maskImage = fx.style.webkitMaskImage = `linear-gradient(rgba(0,0,0,.32) ${fp(floor - 6)}, #000 ${fp(floor + 10)})`;
  const bh = el('div', 'bh', fx);

  const [gw, G] = cv(W, 2 * H, 1, bh, 'l'); gw.style.top = `${-H}px`; G.translate(0, H); G.globalCompositeOperation = 'lighter';
  const hg = G.createRadialGradient(cx, cy, R * .96, cx, cy, R * 2);
  hg.addColorStop(0, pal(.75, .5 * heat)); hg.addColorStop(.06, pal(.62, .16 * heat)); hg.addColorStop(.3, pal(.42, .04)); hg.addColorStop(1, pal(.3, 0));
  G.fillStyle = hg; G.fillRect(0, -H, W, 2 * H);
  soft(G, 1, .09 * R, pal(.72, .55 * heat), (x) => { x.lineWidth = .12 * R; x.beginPath(); x.arc(cx, cy - .03 * R, R * 1.08, 0, 7); x.stroke(); });
  soft(G, 1, .22 * R, pal(.62, .45 * heat), (x) => { x.lineWidth = .24 * R; x.lineCap = 'round'; x.beginPath(); x.moveTo(...at(.4)); x.lineTo(...at(1.2)); x.stroke(); });
  soft(G, 1, .25 * R, pal(.55, .4), (x) => { x.beginPath(); x.ellipse(cx, H + .16 * R, 2.2 * R, .14 * R, 0, 0, 7); x.fill(); });

  // Two shells of arc streaks turning at different speeds; a static conic mask keeps the approaching side bright.
  const rc = [cx, cy - .03 * R], bright = dir > 0 ? 90 : 270;
  const mask = `conic-gradient(from ${bright - 180}deg at ${rc[0]}px ${rc[1]}px, rgba(0,0,0,.16), rgba(0,0,0,.6) 25%, #000 44%, #000 56%, rgba(0,0,0,.6) 75%, rgba(0,0,0,.16))`;
  for (const [a0, a1, cnt, per] of [[1, 1.07, 340, 300], [1.03, 1.18, 200, 620]]) {
    const ro = a1 * R, box = el('div', 'l ring', bh); box.style.maskImage = box.style.webkitMaskImage = mask;
    const [c, x] = cv(ro * 2, ro * 2, dpr, box, `spin${dir < 0 ? ' rev' : ''}`);
    c.style.left = `${rc[0] - ro}px`; c.style.top = `${rc[1] - ro}px`; c.style.setProperty('--dur', `${per}s`); c.style.animationDelay = `${-r() * per}s`;
    x.translate(ro, ro); x.globalCompositeOperation = 'lighter'; x.lineCap = 'round';
    for (let i = 0; i < cnt; i++) {
      const rho = R * (a0 + (a1 - a0) * r() ** 1.5), hot = Math.max(0, 1 - (rho / R - 1) / .5);
      const t = .16 + .83 * hot ** 1.4 * (.6 + .4 * r()), al = (.04 + .36 * r() ** 2.2) * heat * (a0 === 1 ? 1.35 : 1) * Math.max(.15, 1 - (rho / R - 1) * 2.5), st = r() * 6.283, len = .12 + r() ** 1.5 * 1.6;
      x.lineWidth = s * (.2 + 1.4 * r() ** 3);
      for (const [p0, p1, m] of [[0, .22, .35], [.2, .8, 1], [.78, 1, .35]]) { x.strokeStyle = pal(t, al * m); x.beginPath(); x.arc(0, 0, rho, st + len * p0, st + len * p1); x.stroke(); }
    }
  }

  const [, F] = cv(W, H, dpr, bh, 'l');
  F.fillStyle = '#000'; F.beginPath(); F.arc(cx, cy, R, 0, 7); F.fill();
  soft(F, dpr, 3 * s, pal(.92, .85), (x) => { x.lineWidth = 1.4 * s; x.beginPath(); x.arc(cx, cy, R * 1.004, 0, 7); x.stroke(); });
  const cg = F.createConicGradient(dir > 0 ? 0 : Math.PI, cx, cy);
  cg.addColorStop(0, pal(1, 1)); cg.addColorStop(.25, pal(.92, .8)); cg.addColorStop(.5, pal(.8, .35)); cg.addColorStop(.75, pal(.92, .8)); cg.addColorStop(1, pal(1, 1));
  F.strokeStyle = cg; F.lineWidth = .9 * s; F.beginPath(); F.arc(cx, cy, R * 1.004, 0, 7); F.stroke();
  F.strokeStyle = pal(.9, .4); F.lineWidth = .45 * s; F.beginPath(); F.arc(cx, cy - .01 * R, R * 1.028, 0, 7); F.stroke();

  // The beam: the disc's near side rising from the bottom edge, one tile of streaks sliding along it.
  const Lb = 2 * R, Hb = .8 * R, Tw = Lb * .5, mid = at(1.25);
  const box = el('div', 'band', bh);
  box.style.cssText = `left:${mid[0] - Lb / 2}px;top:${mid[1] - Hb / 2}px;width:${Lb}px;height:${Hb}px;transform:rotate(${Math.atan2(d[1], d[0])}rad)`;
  const mc = document.createElement('canvas'); mc.width = 128; mc.height = 48;
  const mx = mc.getContext('2d'), md = mx.createImageData(128, 48);
  for (let i = 0; i < 128; i++) {
    const q = .25 + i / 127 * 2, w = Math.max(.07, .21 - .08 * (q - 1)), along = (q < 1 ? 1 : Math.exp(-(q - 1) * 1.8)) * Math.min(1, (2.25 - q) / .3);
    for (let j = 0; j < 48; j++) { const y = (j / 47 - .5) * .8 / w, a = along * (Math.exp(-2 * y * y) + .25 * Math.exp(-.12 * y * y)); md.data[(j * 128 + i) * 4 + 3] = Math.min(255, a * 255); }
  }
  mx.putImageData(md, 0, 0);
  box.style.maskImage = box.style.webkitMaskImage = `url(${mc.toDataURL()})`; box.style.maskSize = box.style.webkitMaskSize = '100% 100%';
  const [, bx] = cv(Lb, Hb, 1, box, ''), bodyG = bx.createLinearGradient(0, 0, 0, Hb);
  for (const [o, t, a] of [[0, .4, 0], [.28, .5, .2], [.42, .78, .6], [.5, .98, 1], [.58, .78, .6], [.72, .5, .2], [1, .4, 0]]) bodyG.addColorStop(o, pal(t, a * heat));
  bx.fillStyle = bodyG; bx.fillRect(0, 0, Lb, Hb);
  const tile = document.createElement('canvas'); tile.width = Math.ceil(Tw); tile.height = Math.ceil(Hb);
  const tx = tile.getContext('2d'); tx.globalCompositeOperation = 'lighter'; tx.lineCap = 'round';
  for (let i = 0; i < 700; i++) {
    const g = gauss(r), y = Hb / 2 + g * Hb * .13, hot = Math.max(0, 1 - Math.min(1, Math.abs(g) / 1.4));
    const t = .16 + .83 * hot ** 1.3 * (.6 + .4 * r()), len = Tw * (.04 + .4 * r() ** 2), x0 = r() * Tw, al = (.05 + .32 * r() ** 2) * heat, wob = (r() - .5) * s * 4;
    tx.lineWidth = s * (.15 + 1.2 * r() ** 3);
    for (const off of [0, -Tw]) {
      const a = x0 + off, lg = tx.createLinearGradient(a, 0, a + len, 0);
      lg.addColorStop(0, pal(t, 0)); lg.addColorStop(.3, pal(t, al)); lg.addColorStop(.7, pal(t, al)); lg.addColorStop(1, pal(t, 0));
      tx.strokeStyle = lg; tx.beginPath(); tx.moveTo(a, y); tx.quadraticCurveTo(a + len / 2, y + wob, a + len, y + wob * .4); tx.stroke();
    }
  }
  const [fc, fl] = cv(Lb + Tw, Hb, 1, box, 'flow');
  fc.style.setProperty('--dur', '150s'); fc.style.setProperty('--tw', `${Tw}px`); fc.style.animationDelay = `${-r() * 150}s`;
  for (let k = 0; k * Tw < Lb + Tw; k++) fl.drawImage(tile, k * Tw, 0, Tw, Hb);

  // The flare: a white-hot point where the beam crosses the photon ring, with an anamorphic streak.
  const [gc, X] = cv(W, 2 * H, 1, bh, 'l glare'); gc.style.top = `${-H}px`; X.translate(0, H); X.globalCompositeOperation = 'lighter';
  const hr = .36 * R, bg = X.createRadialGradient(...hp, 0, ...hp, hr);
  bg.addColorStop(0, 'rgba(255,255,255,.95)'); bg.addColorStop(.1, pal(.96, .6 * heat)); bg.addColorStop(.42, pal(.75, .12 * heat)); bg.addColorStop(1, pal(.6, 0));
  X.fillStyle = bg; X.beginPath(); X.arc(...hp, hr, 0, 7); X.fill();
  for (const [sy, a, len] of [[.014, .7, 1.1], [.05, .18, .8]]) {
    X.save(); X.translate(...hp); X.scale(1, sy);
    const ag = X.createRadialGradient(0, 0, 0, 0, 0, W * len);
    ag.addColorStop(0, `rgba(255,255,255,${a * heat})`); ag.addColorStop(.12, pal(.92, a * .5 * heat)); ag.addColorStop(1, pal(.7, 0));
    X.fillStyle = ag; X.beginPath(); X.arc(0, 0, W * len, 0, 7); X.fill(); X.restore();
  }
  return true;
}

// Hover: the hole spins up (playbackRate ramps, so nothing jumps) and settles back on leave. The ramp is
// keyed to the sky, which outlives a re-render, and re-reads its animations each frame, since a re-render replaces them.
const ramps = new WeakMap();
function spinTo(plate, target) {
  const sky = plate.querySelector('.gx'), anims = () => [...sky.querySelectorAll('.spin,.flow')].flatMap((e) => e.getAnimations());
  if (!sky || !anims().length) return;
  const from = anims()[0].playbackRate, t0 = performance.now(), id = {};
  ramps.set(sky, id);
  const step = (t) => {
    if (ramps.get(sky) !== id) return;
    const k = Math.min(1, (t - t0) / 900), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    for (const a of anims()) a.playbackRate = from + (target - from) * e;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Re-attaching an element restarts its CSS animations at rest (phase 0, rate 1), and the board rebuilds its
// plates (and their border sweeps) on every graph tick: note where each stands before, and carry it over after.
const held = new Map();
const sweepOf = (plate) => plate.getAnimations({ subtree: true }).find((a) => a.animationName === 'gx-sweep');
export function noteAnims(anims, into = new Map()) {
  for (const a of anims) if (a.currentTime != null) into.set(a.effect.pseudoElement ? a.effect.target.dataset.board : a.effect.target, { t: a.currentTime, rate: a.playbackRate });
  return into;
}
export function carryAnims(anims, from) {
  for (const a of anims) {
    const h = from.get(a.effect.pseudoElement ? a.effect.target.dataset.board : a.effect.target);
    if (h) { a.currentTime = h.t; a.playbackRate = h.rate; }
  }
}
// Call just before a board render replaces the plates mountSkies will be handed.
export function holdSkies(host) {
  held.clear();
  if (typeof IntersectionObserver === 'undefined') return;
  noteAnims([...host.querySelectorAll('.job-plate')].map(sweepOf).filter(Boolean), held);
  for (const sky of kept.values()) if (sky.isConnected) noteAnims(sky.getAnimations({ subtree: true }), held);
}

// Painted skies outlive a board re-render: the board rebuilds its plates' markup on every graph tick, so a
// painted sky is kept by its parameters and put back in place of the fresh placeholder. Painting is lazy
// (one plate per frame, as each nears the viewport) and an off-screen plate's animations pause.
const kept = new Map(), widths = new Map(), queue = [], hosts = new WeakSet();
let near, seen, resize, pumping = false, timer;
const keyOf = (a) => Object.values(a.dataset).join('|');
function pump() {
  const a = queue.shift();
  if (!a) { pumping = false; return; }
  if (paint(a)) widths.set(a, a.clientWidth);
  requestAnimationFrame(pump);
}
function setup() {
  near = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { near.unobserve(e.target); queue.push(e.target); if (!pumping) { pumping = true; requestAnimationFrame(pump); } }
  }, { rootMargin: '400px' });
  seen = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('off', !e.isIntersecting); });
  resize = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => widths.forEach((w, a) => { if (a.isConnected && a.clientWidth !== w) { widths.set(a, a.clientWidth); paint(a); } }), 200);
  });
  resize.observe(document.body);
}
// `.hot` stands in for :hover on a freshly rendered plate, which the browser only marks hovered a frame later.
let hot = null;
function hover(host) {
  if (hosts.has(host) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  hosts.add(host);
  const edge = (e, target) => {
    const plate = e.target.closest?.('.job-plate');
    if (!plate || plate.contains(e.relatedTarget)) return;
    hot = target > 1 ? plate.dataset.board : null;
    plate.classList.toggle('hot', target > 1);
    spinTo(plate, target);
  };
  host.addEventListener('pointerover', (e) => edge(e, 24));
  host.addEventListener('pointerout', (e) => edge(e, 1));
}

// Call after a board render: put back the skies already painted for these plates and paint the rest.
export function mountSkies(host) {
  if (typeof IntersectionObserver === 'undefined') return;
  if (!near) setup();
  hover(host);
  const lit = hot && host.querySelector(`.job-plate[data-board="${CSS.escape(hot)}"]`);
  if (lit) {
    lit.classList.add('hot');
    // The pointer may have left while the plate was being replaced, so no pointerout will ever reach it.
    requestAnimationFrame(() => { if (lit.isConnected && !lit.matches(':hover')) { if (hot === lit.dataset.board) hot = null; lit.classList.remove('hot'); spinTo(lit, 1); } });
  }
  const live = new Set();
  for (const slot of host.querySelectorAll('.gx')) {
    const key = keyOf(slot), old = kept.get(key);
    live.add(key);
    if (old && !old.isConnected && old.firstChild) {
      slot.replaceWith(old);
      if (old.clientWidth !== widths.get(old) && paint(old)) widths.set(old, old.clientWidth);
      else carryAnims(old.getAnimations({ subtree: true }), held);
      continue;
    }
    if (old === slot) continue;
    kept.set(key, slot);
    near.observe(slot); seen.observe(slot);
  }
  carryAnims([...host.querySelectorAll('.job-plate')].map(sweepOf).filter(Boolean), held);
  held.clear();
  for (const [key, a] of kept) if (!live.has(key)) { near.unobserve(a); seen.unobserve(a); widths.delete(a); kept.delete(key); }
}
