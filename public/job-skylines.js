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
// Before the collapse (an idea's sky): the cloud's emission, violet to H-alpha rose to a
// peach core, and its cooler drift, OIII teal.
export const FORM = {
  form: ['#08031a', '#2a0f4d', '#6b2a8a', '#c0508f', '#f08a9a', '#ffd2c0', '#ffffff'],
  drift: ['#020c10', '#06303a', '#0f6a74', '#2fb4b4', '#86e6dc', '#dcfff9', '#ffffff'],
};
export const paletteOf = (tone) => PAL[tone] || PAL.idle;

// The cap grows as the job lands, but stays 14 units clear of the plan's lowest node or label.
export const capFor = (lvl, floor) => Math.min(36 + 5 * lvl, Math.max(13, 150 - floor - 14));

const FLOOR = 60;
export function skyHtml(seed, tone, lvl, floor = FLOOR, dim = false) {
  const t = PAL[tone] ? tone : 'idle';
  return `<div class="gx" data-seed="${hash(`${seed}${lvl}`).toString(36)}" data-tone="${t}" data-lvl="${lvl}" data-floor="${Math.round(floor)}"${dim ? ' data-dim' : ''}></div>`;
}

// An idea's formation sky (`stage` 0 thinking, 1 asking, 2 job suggested brightens its
// point) and the horizon a suggested job launches from. Both draw every frame.
export const INFLOW_STYLES = ['dust', 'filaments', 'clumps'];
export const inflowHtml = (seed, stage = 0, style = 'dust') => `<div class="gx nb" data-inflow data-seed="${hash(seed).toString(36)}" data-stage="${Math.max(0, Math.min(2, +stage || 0))}" data-style="${INFLOW_STYLES.includes(style) ? style : 'dust'}"></div>`;
export const arcHtml = (seed, tone = 'warn') => `<div class="gx" data-arc data-seed="${hash(seed).toString(36)}" data-tone="${PAL[tone] ? tone : 'warn'}"></div>`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function ramp(stops) {
  const c = stops.map(hex);
  return (t, a = 1) => {
    t = Math.max(0, Math.min(1, t)) * (c.length - 1);
    const i = Math.min(c.length - 2, Math.floor(t)), f = t - i, m = c[i].map((v, k) => Math.round(v + (c[i + 1][k] - v) * f));
    return `rgba(${m[0]},${m[1]},${m[2]},${a})`;
  };
}
export function rng(str) {
  let a = 2166136261;
  for (const ch of str) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const gauss = (r) => (r() + r() + r() + r() - 2) / .577;
const el = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; if (p) p.appendChild(e); return e; };
export function cv(w, h, dpr, parent, cls) {
  const c = el('canvas', cls, parent);
  c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  return [c, x];
}
// A blurred shape without ctx.filter (Safari): draw it off-canvas and let only its shadow land.
function soft(x, dpr, blur, color, draw) {
  x.save(); x.shadowColor = color; x.shadowBlur = blur * dpr; x.shadowOffsetX = 1e4 * dpr; x.translate(-1e4, 0); x.fillStyle = x.strokeStyle = '#000'; draw(x); x.restore();
}

// Where paint() puts a sky's hole, from the same first draws of its seed: the
// idea→job transition (job-forming.js) collapses at its top.
export function holeOf(sky, W) {
  const D = sky.dataset, H = W * 150 / 320, s = W / 320, R = 150 * s, lvl = +D.lvl || 1, r = rng(D.seed);
  const dir = r() < .5 ? -1 : 1, x = W * (.5 + dir * (.04 + r() * .04));
  return { x, y: H + R - capFor(lvl, +D.floor || FLOOR) * s, R, s, dir, heat: (.8 + .05 * lvl) * ('dim' in D ? .62 : 1), pal: ramp(paletteOf(D.tone)) };
}
// One shell of the lensed ring's arc streaks, around (0,0) of `x`.
function streaks(x, r, R, s, a0, a1, cnt, heat, pal) {
  x.globalCompositeOperation = 'lighter'; x.lineCap = 'round';
  for (let i = 0; i < cnt; i++) {
    const rho = R * (a0 + (a1 - a0) * r() ** 1.5), hot = Math.max(0, 1 - (rho / R - 1) / .5);
    const t = .16 + .83 * hot ** 1.4 * (.6 + .4 * r()), al = (.04 + .36 * r() ** 2.2) * heat * (a0 === 1 ? 1.35 : 1) * Math.max(.15, 1 - (rho / R - 1) * 2.5), st = r() * 6.283, len = .12 + r() ** 1.5 * 1.6;
    x.lineWidth = s * (.2 + 1.4 * r() ** 3);
    for (const [p0, p1, m] of [[0, .22, .35], [.2, .8, 1], [.78, 1, .35]]) { x.strokeStyle = pal(t, al * m); x.beginPath(); x.arc(0, 0, rho, st + len * p0, st + len * p1); x.stroke(); }
  }
}
// The black disc and its photon ring, brightest on the approaching side.
function horizon(F, cx, cy, R, s, dpr, dir, pal) {
  F.fillStyle = '#000'; F.beginPath(); F.arc(cx, cy, R, 0, 7); F.fill();
  soft(F, dpr, 3 * s, pal(.92, .85), (x) => { x.lineWidth = 1.4 * s; x.beginPath(); x.arc(cx, cy, R * 1.004, 0, 7); x.stroke(); });
  const cg = F.createConicGradient(dir > 0 ? 0 : Math.PI, cx, cy);
  cg.addColorStop(0, pal(1, 1)); cg.addColorStop(.25, pal(.92, .8)); cg.addColorStop(.5, pal(.8, .35)); cg.addColorStop(.75, pal(.92, .8)); cg.addColorStop(1, pal(1, 1));
  F.strokeStyle = cg; F.lineWidth = .9 * s; F.beginPath(); F.arc(cx, cy, R * 1.004, 0, 7); F.stroke();
  F.strokeStyle = pal(.9, .4); F.lineWidth = .45 * s; F.beginPath(); F.arc(cx, cy - .01 * R, R * 1.028, 0, 7); F.stroke();
}

// The idea→job transition (job-forming.js) has a sky paint the same picture into a frame reaching
// past the plate (`X0`/`Y0` of room left and above, `BW` × `BH` in all), so its camera can start
// out far enough to show the whole hole. Inside the plate every pixel is the plain sky's: the same
// draws, offset by whole pixels. The frame is kept until the sky next repaints on its own.
const wholes = new WeakMap();
export function paintWhole(sky, frame, onPaint) {
  if (wholes.get(sky)?.frame === frame) return;
  wholes.set(sky, { frame, onPaint });
  if (sky.firstChild) paint(sky);
}
export const dropWhole = (sky) => wholes.delete(sky);

function paint(art) {
  const W = art.clientWidth;
  if (!W) return false;
  const whole = wholes.get(art), fr = whole?.frame, ox = fr?.X0 || 0, oy = fr?.Y0 || 0;
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
  // A whole frame is the plate's canvases grown to it; a plain one keeps them exactly as they were.
  const root = fr ? el('div', 'whole', art) : art, FW = fr ? fr.BW : W, FH = fr ? fr.BH : H;
  if (fr) root.style.cssText = `position:absolute;left:${-ox}px;top:${-oy}px;width:${FW}px;height:${FH}px`;
  const tall = (dp, parent, cls) => {
    const [c, x] = fr ? cv(FW, FH, dp, parent, cls) : cv(W, 2 * H, dp, parent, cls);
    if (fr) x.translate(ox, oy); else { c.style.top = `${-H}px`; x.translate(0, H); }
    return [c, x, fr ? [-ox, -oy, FW, FH] : [0, -H, W, 2 * H]];
  };

  const [, b] = cv(FW, FH, dpr, root, 'l'); b.translate(ox, oy);
  const all = [-ox, -oy, FW, FH];
  const sky = b.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#020306'); sky.addColorStop(1, '#07070a'); b.fillStyle = sky; b.fillRect(...all);
  for (let i = 0; i < 2; i++) {
    const x = r() * W, y = r() * H * .6, rr = (.3 + r() * .4) * W, g = b.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, pal(.3, .06)); g.addColorStop(1, pal(.3, 0)); b.fillStyle = g; b.fillRect(...all);
  }
  const star = (q, x, y) => {
    const dx = x - cx, dy = y - cy, dd = Math.hypot(dx, dy);
    if (dd < R * 1.04) return;
    const sz = (.22 + q() ** 3 * 1.05) * s * .75, a = .2 + q() * .6, k = Math.max(0, (1.3 * R - dd) / (.26 * R));
    b.save(); b.translate(x, y); b.rotate(Math.atan2(dy, dx) + Math.PI / 2);
    b.fillStyle = q() < .2 ? `rgba(255,226,196,${a})` : `rgba(232,236,255,${a})`;
    b.beginPath(); b.ellipse(0, 0, sz * (1 + 2.2 * k * k), sz * Math.max(.35, 1 - .6 * k), 0, 0, 7); b.fill(); b.restore();
  };
  for (let i = 0; i < 120; i++) star(r, r() * W, r() * H);
  // Past the plate, as many again per area from their own draws, so the plate's own never move.
  if (fr) for (let i = 0, q = rng(`${D.seed}:far`), n = 120 * FW * FH / (W * H); i < n; i++) {
    const x = q() * FW - ox, y = q() * FH - oy;
    if (x < 0 || x > W || y < 0 || y > H) star(q, x, y);
  }

  // Everything bright sits in .fx, whose mask drops it to a third above the plan's floor.
  const fx = el('div', 'fx', root), fp = (v) => { const p = (Math.max(0, Math.min(150, v)) / 1.5).toFixed(1); return fr ? `${(oy + p / 100 * H).toFixed(2)}px` : `${p}%`; };
  fx.style.maskImage = fx.style.webkitMaskImage = `linear-gradient(rgba(0,0,0,.32) ${fp(floor - 6)}, #000 ${fp(floor + 10)})`;
  const bh = el('div', 'bh', fx);

  const [, G, gbox] = tall(1, bh, 'l'); G.globalCompositeOperation = 'lighter';
  const hg = G.createRadialGradient(cx, cy, R * .96, cx, cy, R * 2);
  hg.addColorStop(0, pal(.75, .5 * heat)); hg.addColorStop(.06, pal(.62, .16 * heat)); hg.addColorStop(.3, pal(.42, .04)); hg.addColorStop(1, pal(.3, 0));
  G.fillStyle = hg; G.fillRect(...gbox);
  soft(G, 1, .09 * R, pal(.72, .55 * heat), (x) => { x.lineWidth = .12 * R; x.beginPath(); x.arc(cx, cy - .03 * R, R * 1.08, 0, 7); x.stroke(); });
  soft(G, 1, .22 * R, pal(.62, .45 * heat), (x) => { x.lineWidth = .24 * R; x.lineCap = 'round'; x.beginPath(); x.moveTo(...at(.4)); x.lineTo(...at(1.2)); x.stroke(); });
  soft(G, 1, .25 * R, pal(.55, .4), (x) => { x.beginPath(); x.ellipse(cx, H + .16 * R, 2.2 * R, .14 * R, 0, 0, 7); x.fill(); });

  // Two shells of arc streaks turning at different speeds; a static conic mask keeps the approaching side bright.
  const rc = [cx, cy - .03 * R], bright = dir > 0 ? 90 : 270;
  const mask = `conic-gradient(from ${bright - 180}deg at ${rc[0] + ox}px ${rc[1] + oy}px, rgba(0,0,0,.16), rgba(0,0,0,.6) 25%, #000 44%, #000 56%, rgba(0,0,0,.6) 75%, rgba(0,0,0,.16))`;
  for (const [a0, a1, cnt, per] of [[1, 1.07, 340, 300], [1.03, 1.18, 200, 620]]) {
    const ro = a1 * R, box = el('div', 'l ring', bh); box.style.maskImage = box.style.webkitMaskImage = mask;
    const [c, x] = cv(ro * 2, ro * 2, dpr, box, `spin${dir < 0 ? ' rev' : ''}`);
    c.style.left = `${rc[0] - ro + ox}px`; c.style.top = `${rc[1] - ro + oy}px`; c.style.setProperty('--dur', `${per}s`); c.style.animationDelay = `${-r() * per}s`;
    x.translate(ro, ro);
    streaks(x, r, R, s, a0, a1, cnt, heat, pal);
  }

  const [, F] = cv(FW, FH, dpr, bh, 'l'); F.translate(ox, oy);
  horizon(F, cx, cy, R, s, dpr, dir, pal);

  // The beam: the disc's near side rising from the bottom edge, one tile of streaks sliding along it.
  const Lb = 2 * R, Hb = .8 * R, Tw = Lb * .5, mid = at(1.25);
  const box = el('div', 'band', bh);
  box.style.cssText = `left:${mid[0] - Lb / 2 + ox}px;top:${mid[1] - Hb / 2 + oy}px;width:${Lb}px;height:${Hb}px;transform:rotate(${Math.atan2(d[1], d[0])}rad)`;
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

  // Seen whole, the beam's foot and the flare would cross the disc and the flare's streak would run
  // the width of the frame: past the plate, the disc covers them and the streak fades out.
  const cover = fr && (() => {
    const [mc, M] = cv(FW, FH, dpr, null, ''), m = .25 * W;
    M.translate(ox, oy);
    const across = (g) => { g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(m / (W + 2 * m), '#000'); g.addColorStop(1 - m / (W + 2 * m), '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); return g; };
    M.fillStyle = across(M.createLinearGradient(-m, 0, W + m, 0)); M.fillRect(...all);
    M.globalCompositeOperation = 'destination-in';
    // Not below it: the flare sits just under the plate's foot, on the disc.
    const v = M.createLinearGradient(0, -m * H / W, 0, H + 1);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(m * H / W / (H + 1 + m * H / W), '#000'); v.addColorStop(H / (H + 1 + m * H / W), '#000'); v.addColorStop(1, 'rgba(0,0,0,0)');
    M.fillStyle = v; M.fillRect(...all);
    return (x, op) => { x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = op; x.drawImage(mc, 0, 0, x.canvas.width, x.canvas.height); x.restore(); };
  })();
  // The flare: a white-hot point where the beam crosses the photon ring, with an anamorphic streak.
  const [, X] = tall(1, bh, 'l glare'); X.globalCompositeOperation = 'lighter';
  const hr = .36 * R, bg = X.createRadialGradient(...hp, 0, ...hp, hr);
  bg.addColorStop(0, 'rgba(255,255,255,.95)'); bg.addColorStop(.1, pal(.96, .6 * heat)); bg.addColorStop(.42, pal(.75, .12 * heat)); bg.addColorStop(1, pal(.6, 0));
  X.fillStyle = bg; X.beginPath(); X.arc(...hp, hr, 0, 7); X.fill();
  for (const [sy, a, len] of [[.014, .7, 1.1], [.05, .18, .8]]) {
    X.save(); X.translate(...hp); X.scale(1, sy);
    const ag = X.createRadialGradient(0, 0, 0, 0, 0, W * len);
    ag.addColorStop(0, `rgba(255,255,255,${a * heat})`); ag.addColorStop(.12, pal(.92, a * .5 * heat)); ag.addColorStop(1, pal(.7, 0));
    X.fillStyle = ag; X.beginPath(); X.arc(0, 0, W * len, 0, 7); X.fill(); X.restore();
  }
  if (cover) {
    cover(X, 'destination-in');
    const [, C] = cv(FW, FH, dpr, bh, 'l'); C.translate(ox, oy);
    C.fillStyle = '#000'; C.beginPath(); C.arc(cx, cy, R * .995, 0, 7); C.fill();
    cover(C, 'destination-out');
  }
  whole?.onPaint(root);
  return true;
}

// Live skies draw every frame. Each keeps a speed easing to a target, so hover speeds
// them up through spinTo as it does the CSS-animated rings; an off-screen one (`.off`) and
// a disconnected one (between a re-render's replace and put-back) do not draw.
const live = new Set(), liveOf = new WeakMap();
let looping = false, lastFrame = 0;
const calmMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(t) {
  const dt = Math.min(.05, (t - (lastFrame || t)) / 1000); lastFrame = t;
  for (const st of live) {
    st.speed += (st.target - st.speed) * Math.min(1, dt * 2.5);
    if (st.art.isConnected && !st.art.classList.contains('off') && !calmMotion()) st.step(dt * st.speed);
  }
  if (live.size) requestAnimationFrame(frame); else { looping = false; lastFrame = 0; }
}
function goLive(art, step, gain) {
  const old = liveOf.get(art);
  if (old) live.delete(old);
  const st = { art, step, gain, speed: old?.speed || 1, target: old?.target || 1 };
  liveOf.set(art, st); live.add(st);
  if (!looping) { looping = true; requestAnimationFrame(frame); }
}
// A live sky's speed, set outright (the transition speeds an idea's infall up as it collapses).
export function pullSky(art, speed) { const st = liveOf.get(art); if (st) st.target = speed; }
const dropLive = (art) => { const st = liveOf.get(art); if (st) live.delete(st); liveOf.delete(art); };

// Infall: dust drifting in from the whole sky and collecting at one point, before there is
// a hole to fall into. Each mote takes 20 to 40 seconds to arrive, curling a little as it
// speeds up near the centre; faint clumps fall in with it and shrink, and the point
// brightens with the idea's stage. Filaments feed it along three arms; clumps is more cloud.
function paintInflow(art) {
  const W = art.clientWidth, H = art.clientHeight;
  if (!W || !H) return false;
  const D = art.dataset, r = rng(D.seed), dpr = Math.min(1.5, devicePixelRatio || 1), stage = +D.stage || 0, mode = D.style || 'dust';
  const warm = ramp(FORM.form), cool = ramp(FORM.drift), s = W / 320, dir = r() < .5 ? -1 : 1;
  const cx = W * (.5 + dir * (.06 + r() * .06)), cy = H * (.5 + (r() - .5) * .08), Rx = W * .62, Ry = Math.max(H * .8, Rx * .55);
  art.style.setProperty('--ox', `${(cx / W * 100).toFixed(1)}%`); art.style.setProperty('--oy', `${(cy / H * 100).toFixed(1)}%`);
  art.replaceChildren();
  const at = (rho, th) => [cx + Math.cos(th) * rho * Rx, cy + Math.sin(th) * rho * Ry];
  const [, b] = cv(W, H, dpr, art, 'l');
  const sky = b.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#020306'); sky.addColorStop(1, '#07070a'); b.fillStyle = sky; b.fillRect(0, 0, W, H);
  for (let i = 0; i < 130 * W * H / (320 * 150 * s * s); i++) {
    const sz = (.22 + r() ** 3 * 1.05) * s * .75, a = .15 + r() * .5;
    b.fillStyle = r() < .2 ? `rgba(255,226,196,${a})` : `rgba(232,236,255,${a})`; b.beginPath(); b.arc(r() * W, r() * H, sz, 0, 7); b.fill();
  }
  // The cloud's haze, contracting very slowly toward the point.
  const [hc, h] = cv(W, H, dpr, art, 'l drift'); hc.style.transformOrigin = `${cx}px ${cy}px`;
  h.globalCompositeOperation = 'lighter';
  const blob = (x, y, rx, ry, c, a) => { h.save(); h.translate(x, y); h.scale(1, ry / rx); const g = h.createRadialGradient(0, 0, 0, 0, 0, rx); g.addColorStop(0, c(.5, a)); g.addColorStop(1, c(.3, 0)); h.fillStyle = g; h.beginPath(); h.arc(0, 0, rx, 0, 7); h.fill(); h.restore(); };
  for (let i = 0; i < 7; i++) { const [x, y] = at(.35 + r() * .7, r() * 6.283); blob(x, y, (.2 + r() * .25) * W, (.12 + r() * .15) * H, r() < .45 ? cool : warm, .05 + r() * .05); }
  blob(cx, cy, Rx * .55, Ry * .5, warm, .1 + .04 * stage);
  const fx = el('div', 'fx', art), [, L] = cv(W, H, dpr, fx, 'l infall'), [, P] = cv(W, H, dpr, fx, 'l jets');
  const sprite = (c) => { const k = document.createElement('canvas'); k.width = k.height = 64; const x = k.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, c(.6, 1)); g.addColorStop(.4, c(.45, .45)); g.addColorStop(1, c(.3, 0)); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return k; };
  const puffW = sprite(warm), puffC = sprite(cool);
  const arms = mode === 'filaments' ? [0, 2.2, 4.1].map((a) => a + r() * 6.283) : null, clumpy = mode === 'clumps', curl = arms ? .022 : .01;
  const spawn = (p, fresh) => {
    p.r = fresh ? .08 + Math.sqrt(r()) * 1.15 : 1.05 + r() * .2;
    p.th = arms && !p.puff ? arms[Math.floor(r() * 3)] + gauss(r) * .09 * (1 + p.r) : r() * 6.283;
    p.life = fresh ? 1 : 0; p.k = .7 + .6 * r(); p.ph = r() * 6.283;
    p.c = r() < .3 ? cool : warm; p.w = (.5 + 1 * r() ** 3) * s;
    if (p.puff) { p.sz = (.12 + .2 * r()) * W; p.a = (.04 + .05 * r()) * (clumpy ? 1.5 : 1); }
  };
  const n = Math.round((clumpy ? 110 : 230 + 70 * stage) * Math.max(.7, s)), m = clumpy ? 26 : 12;
  const ps = Array.from({ length: n + m }, (_, i) => { const p = { puff: i >= n }; spawn(p, true); return p; });
  // Inflow speeds up toward the centre; the curl is slight, so it reads as a fall, not an orbit.
  const move = (p, dt) => {
    const q = Math.max(p.r, .03), v = .028 * p.k * (.35 + .55 / (q + .22)) * (p.puff ? .6 : 1);
    p.r -= v * dt; p.th += dir * curl * p.k / (q + .18) * dt; p.ph += dt * .6;
    p.life = Math.min(1, p.life + dt * .35);
    if (p.r < (p.puff ? .1 : .025)) { spawn(p, false); return false; }
    return v;
  };
  const step = (dt) => {
    L.clearRect(0, 0, W, H); L.globalCompositeOperation = 'lighter';
    for (const p of ps) {
      if (!move(p, dt)) continue;
      const wob = Math.sin(p.ph) * .012, [x, y] = at(p.r + wob, p.th), near = Math.max(0, 1 - p.r), edge = Math.min(1, (1.25 - p.r) / .3) * p.life;
      if (p.puff) {
        const z = p.sz * (.35 + .65 * Math.min(1, p.r)); L.globalAlpha = p.a * edge * (.6 + .8 * near);
        L.drawImage(p.c === cool ? puffC : puffW, x - z, y - z, 2 * z, 2 * z); L.globalAlpha = 1; continue;
      }
      // A mote warms as it nears the point and dims as the point takes it in.
      const sink = Math.min(1, (p.r - .025) / .12), rad = Math.max(.65, p.w * (.55 + .25 * near));
      L.fillStyle = p.c(.4 + .5 * near ** 1.3, edge * sink * (.34 + .3 * near ** 1.5) * (.8 + .1 * stage));
      L.beginPath(); L.arc(x, y, rad, 0, 7); L.fill();
    }
  };
  // The point it all collects at, breathing like the hole's glare.
  P.globalCompositeOperation = 'lighter';
  let g = P.createRadialGradient(cx, cy, 0, cx, cy, .3 * Ry); g.addColorStop(0, warm(.85, .3 + .08 * stage)); g.addColorStop(.4, warm(.65, .1)); g.addColorStop(1, warm(.5, 0));
  P.fillStyle = g; P.beginPath(); P.arc(cx, cy, .3 * Ry, 0, 7); P.fill();
  const pr = (9 + 3 * stage) * s; g = P.createRadialGradient(cx, cy, 0, cx, cy, pr);
  g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.18, warm(.96, .75)); g.addColorStop(.55, warm(.8, .18)); g.addColorStop(1, warm(.6, 0));
  P.fillStyle = g; P.beginPath(); P.arc(cx, cy, pr, 0, 7); P.fill();
  // Settle the fall before the first frame so the dust is already spread along its paths.
  for (let i = 0; i < 300; i++) ps.forEach((p) => move(p, .1));
  ps.forEach((p) => { p.life = 1; });
  step(1 / 60);
  goLive(art, step, .065);
  return true;
}

// The horizon a suggested job launches from, after the 100-PRs poster: a hole wider than
// the strip, its ring streaming over the limb with the approaching side brighter. paint()'s
// palette, photon ring and glare; the streaks are paint()'s ring streaks, drawn per frame.
function paintArc(art) {
  const W = art.clientWidth, H = art.clientHeight;
  if (!W || !H) return false;
  const D = art.dataset, pal = ramp(paletteOf(D.tone)), r = rng(D.seed), dpr = Math.min(2, devicePixelRatio || 1);
  const apex = H * .19, fall = H - apex, ex = W * .64, R = (ex * ex + fall * fall) / (2 * fall), cx = W / 2, cy = apex + R;
  art.replaceChildren();
  const [, b] = cv(W, H, dpr, art, 'l');
  b.fillStyle = '#020306'; b.fillRect(0, 0, W, H);
  for (let i = 0, n = W * H / 240; i < n; i++) {
    const x = r() * W, y = r() * H; if (Math.hypot(x - cx, y - cy) < R * 1.01) continue;
    b.fillStyle = `rgba(232,236,255,${(.12 + r() * .55).toFixed(2)})`; const z = r() < .93 ? .7 : 1.3; b.fillRect(x, y, z, z);
  }
  b.globalCompositeOperation = 'lighter';
  const hg = b.createRadialGradient(cx, cy, R * .985, cx, cy, R + H * 1.1);
  hg.addColorStop(0, pal(.8, .55)); hg.addColorStop(.06, pal(.66, .26)); hg.addColorStop(.3, pal(.5, .08)); hg.addColorStop(1, pal(.3, 0));
  b.fillStyle = hg; b.fillRect(0, 0, W, H);
  b.globalCompositeOperation = 'source-over';
  // The shadow, with the faintest warmth just inside the limb.
  const dg = b.createRadialGradient(cx, cy, R - 5, cx, cy, R);
  dg.addColorStop(0, '#010101'); dg.addColorStop(1, pal(.45, .6));
  b.fillStyle = dg; b.beginPath(); b.arc(cx, cy, R, 0, 7); b.fill();
  soft(b, dpr, 4, pal(.95, .95), (x) => { x.lineWidth = 1.6; x.beginPath(); x.arc(cx, cy, R * 1.0015, 0, 7); x.stroke(); });
  b.strokeStyle = 'rgba(255,250,240,.95)'; b.lineWidth = .9; b.beginPath(); b.arc(cx, cy, R * 1.0015, 0, 7); b.stroke();
  const fx = el('div', 'fx', art), [, L] = cv(W, H, dpr, fx, 'l');
  const top = -Math.PI / 2, sweep = (rho) => Math.asin(Math.min(.999, (W * .5 + 40) / rho));
  const streaks = Array.from({ length: Math.round(Math.min(1100, Math.max(420, W * 1.4))) }, () => {
    const k = r() ** 2.1, rho = R + 1.5 + k * H * .7, half = sweep(rho), len = (6 + r() ** 2 * 120) / rho;
    return { rho, half, len, ph: top - half + r() * (2 * half + len), w: .4 + 2.4 * r() ** 3,
      om: (34 + 26 * r()) * (1.6 - .9 * k) / rho, t: .45 + .55 * (1 - k) ** 1.2 * (.65 + .35 * r()), a: (.1 + .75 * r() ** 2) * (1 - .78 * k) };
  });
  const step = (dt) => {
    L.clearRect(0, 0, W, H); L.globalCompositeOperation = 'lighter'; L.lineCap = 'round';
    for (const q of streaks) {
      const lo = top - q.half - q.len, span = 2 * q.half + q.len;
      q.ph = lo + ((q.ph + q.om * dt - lo) % span + span) % span;
      const side = q.rho * Math.cos(q.ph + q.len / 2) / (W * .5), m = .5 + .5 * Math.max(-1, Math.min(1, side));
      L.strokeStyle = pal(q.t, q.a * (.45 + .75 * m)); L.lineWidth = q.w;
      L.beginPath(); L.arc(cx, cy, q.rho, q.ph, q.ph + q.len); L.stroke();
    }
  };
  // Glare where the approaching side meets the limb, breathing like the plates'.
  const [, X] = cv(W, H, dpr, fx, 'l glare'); X.globalCompositeOperation = 'lighter';
  const ga = top + sweep(R) * .62, gx = cx + Math.cos(ga) * R, gy = cy + Math.sin(ga) * R;
  let g = X.createRadialGradient(gx, gy, 0, gx, gy, H * .7); g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(.1, pal(.96, .55)); g.addColorStop(.45, pal(.75, .12)); g.addColorStop(1, pal(.6, 0));
  X.fillStyle = g; X.beginPath(); X.arc(gx, gy, H * .7, 0, 7); X.fill();
  X.save(); X.translate(gx, gy); X.rotate(ga + Math.PI / 2); X.scale(1, .03);
  g = X.createRadialGradient(0, 0, 0, 0, 0, W * .6); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(.15, pal(.92, .28)); g.addColorStop(1, pal(.7, 0));
  X.fillStyle = g; X.beginPath(); X.arc(0, 0, W * .6, 0, 7); X.fill(); X.restore();
  step(0);
  goLive(art, step, .26);
  return true;
}
const paintOf = (a) => ('inflow' in a.dataset ? paintInflow(a) : 'arc' in a.dataset ? paintArc(a) : paint(a));

// Hover: the hole spins up (playbackRate ramps, so nothing jumps) and settles back on leave. The ramp is
// keyed to the sky, which outlives a re-render, and re-reads its animations each frame, since a re-render replaces them.
const ramps = new WeakMap();
export function spinTo(plate, target) {
  for (const s of plate.querySelectorAll('.gx')) { const st = liveOf.get(s); if (st) st.target = 1 + (target - 1) * st.gain; }
  const sky = plate.querySelector('.gx'), anims = () => [...sky.querySelectorAll('.spin,.flow,.drift')].flatMap((e) => e.getAnimations());
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
// A launch strip under an idea's message sweeps its border the same way, keyed by its message.
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
  noteAnims([...host.querySelectorAll('.job-plate,.job-launch')].map(sweepOf).filter(Boolean), held);
  for (const sky of keptOf(host).values()) if (sky.isConnected) noteAnims(sky.getAnimations({ subtree: true }), held);
}

// Painted skies outlive a board re-render: the board rebuilds its plates' markup on every graph tick, so a
// painted sky is kept by its parameters and put back in place of the fresh placeholder. Painting is lazy
// (one plate per frame, as each nears the viewport) and an off-screen plate's animations pause.
// Kept per host: the board and the open dialog each render on every tick, and one's
// render must not drop the other's painted skies.
const keptBy = new WeakMap(), widths = new Map(), queue = [], hosts = new WeakSet();
const keptOf = (host) => { let k = keptBy.get(host); if (!k) keptBy.set(host, k = new Map()); return k; };
let near, seen, resize, pumping = false, timer;
const keyOf = (a) => Object.values(a.dataset).join('|');
function pump() {
  const a = queue.shift();
  if (!a) { pumping = false; return; }
  if (paintOf(a)) widths.set(a, a.clientWidth);
  requestAnimationFrame(pump);
}
function setup() {
  near = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { near.unobserve(e.target); queue.push(e.target); if (!pumping) { pumping = true; requestAnimationFrame(pump); } }
  }, { rootMargin: '400px' });
  seen = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('off', !e.isIntersecting); });
  resize = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => widths.forEach((w, a) => { if (a.isConnected && a.clientWidth !== w) { widths.set(a, a.clientWidth); paintOf(a); } }), 200);
  });
  resize.observe(document.body);
}
// `.hot` stands in for :hover on a freshly rendered plate, which the browser only marks hovered a frame later.
let hot = null;
function hover(host) {
  if (hosts.has(host) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  hosts.add(host);
  // A plate spins up to 24; anything else marked `data-spin` (the idea's header, a launch
  // strip) to its own number.
  const edge = (e, on) => {
    const plate = e.target.closest?.('.job-plate,[data-spin]');
    if (!plate || plate.contains(e.relatedTarget) || plate.closest('.firing')) return;
    const target = on ? +plate.dataset.spin || 24 : 1;
    if (plate.matches('.job-plate')) { hot = on ? plate.dataset.board : null; plate.classList.toggle('hot', on); }
    spinTo(plate, target);
  };
  host.addEventListener('pointerover', (e) => edge(e, true));
  host.addEventListener('pointerout', (e) => edge(e, false));
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
  const kept = keptOf(host), shown = new Set();
  for (const slot of host.querySelectorAll('.gx')) {
    const key = keyOf(slot), old = kept.get(key);
    shown.add(key);
    if (old && !old.isConnected && old.firstChild) {
      slot.replaceWith(old);
      if (old.clientWidth !== widths.get(old) && paintOf(old)) widths.set(old, old.clientWidth);
      else carryAnims(old.getAnimations({ subtree: true }), held);
      continue;
    }
    if (old === slot) continue;
    kept.set(key, slot);
    near.observe(slot); seen.observe(slot);
  }
  carryAnims([...host.querySelectorAll('.job-plate,.job-launch')].map(sweepOf).filter(Boolean), held);
  held.clear();
  for (const [key, a] of kept) if (!shown.has(key)) { near.unobserve(a); seen.unobserve(a); widths.delete(a); dropLive(a); kept.delete(key); }
}

// A host whose skies are gone for good (the dialog closed): stop drawing and forget them.
export function releaseSkies(host) {
  const kept = keptOf(host);
  for (const a of kept.values()) { near?.unobserve(a); seen?.unobserve(a); widths.delete(a); dropLive(a); }
  kept.clear();
}

// The masthead's sky: only the light from a plate's Gargantua, no disc, so the header doesn't repeat the
// plates. An anamorphic streak spans the width from a hot core at the right, with lens ghosts on the line
// through the frame's centre. Static: painted once per size, so it costs nothing between resizes.
function paintGlare(c) {
  const W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.ceil(W * dpr); c.height = Math.ceil(H * dpr);
  const x = c.getContext('2d');
  if (!x) return;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pal = ramp(PAL.warn), r = rng('mast'), fx = W * .87, fy = H * .34;
  x.fillStyle = '#020306'; x.fillRect(0, 0, W, H);
  for (let i = 0, n = W * H / 650; i < n; i++) { const s = r() < .93 ? .7 : 1.3; x.fillStyle = `rgba(255,255,255,${(.15 + r() * .6).toFixed(2)})`; x.fillRect(r() * W, r() * H, s, s); }
  x.globalCompositeOperation = 'lighter';
  let g = x.createRadialGradient(fx, fy, 0, fx, fy, Math.max(W, H) * .55);
  g.addColorStop(0, pal(.6, .42)); g.addColorStop(.3, pal(.34, .14)); g.addColorStop(1, pal(0, 0));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const oval = (rx, ry, stops) => { x.save(); x.translate(fx, fy); x.scale(1, ry / rx); const b = x.createRadialGradient(0, 0, 0, 0, 0, rx); stops(b); x.fillStyle = b; x.beginPath(); x.arc(0, 0, rx, 0, Math.PI * 2); x.fill(); x.restore(); };
  const streak = (rx, ry, a) => oval(rx, ry, (b) => { b.addColorStop(0, pal(.94, a)); b.addColorStop(.3, pal(.66, a * .55)); b.addColorStop(1, pal(0, 0)); });
  streak(W * 1.1, 34, .28); streak(W * .95, 7, .75); streak(W * .8, 1.6, 1);
  const spike = (len, ang, a) => { x.save(); x.translate(fx, fy); x.rotate(ang); x.scale(1, 1.2 / len); const b = x.createRadialGradient(0, 0, 0, 0, 0, len); b.addColorStop(0, `rgba(255,255,255,${a})`); b.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = b; x.beginPath(); x.arc(0, 0, len, 0, Math.PI * 2); x.fill(); x.restore(); };
  spike(H * .5, Math.PI / 2, .7); spike(H * .28, Math.PI / 4, .35); spike(H * .28, -Math.PI / 4, .35);
  g = x.createRadialGradient(fx, fy, 0, fx, fy, H * .34);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.1, 'rgba(255,255,255,.85)'); g.addColorStop(.22, pal(.86, .55)); g.addColorStop(1, pal(0, 0));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (const [k, rad, a, tone] of [[.5, H * .07, .22, .7], [1.3, H * .16, .1, .45], [1.8, H * .05, .3, .8], [-.3, H * .1, .08, .55]]) {
    const gx = fx + (W / 2 - fx) * k, gy = fy + (H * .3 - fy) * k;
    g = x.createRadialGradient(gx, gy, rad * .55, gx, gy, rad);
    g.addColorStop(0, pal(tone, a * .35)); g.addColorStop(.85, pal(tone, a)); g.addColorStop(1, pal(tone, 0));
    x.fillStyle = g; x.beginPath(); x.arc(gx, gy, rad, 0, Math.PI * 2); x.fill();
  }
  x.globalCompositeOperation = 'source-over';
}
// Returns its unmount: a theme switch away from Space stops watching the canvas.
export function mountMastSky(canvas) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let size = '';
  const watch = new ResizeObserver(() => {
    const now = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (now !== size) { size = now; paintGlare(canvas); }
  });
  watch.observe(canvas);
  return () => watch.disconnect();
}
