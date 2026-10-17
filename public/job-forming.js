import { FORM, holeOf, ramp, rng, cv, soft, streaks, horizon, pullSky } from './job-skylines.js';

// An accepted idea's plate forms its job's black hole: the cloud's mass spirals in and piles up
// at its point (0 to FL), implodes in a flash, and the job's own hole is born there and grows as
// it sinks to where the job's sky paints it (to LAND), handing over to that sky.
//
// The board rebuilds every plate's markup on each live tick, so every animation here is a Web
// Animation whose startTime is the moment the idea was accepted: one on a fresh element (the plan,
// the repo tag) is made again at the same instant, and one on a kept element (the cloud and the
// job's sky, which mountSkies puts back, and the overlay kept here by job id) carries on. Only
// transform and opacity move, so the compositor runs them without repainting the big canvases.
// Each ends where the plain job plate rests, so the render that drops `.forming` changes nothing.
export const FORM_MS = 5600, CALM_MS = 450;
const FL = .46, HAND = .86, LAND = .96;
const EASE_OUT = 'cubic-bezier(.215,.61,.355,1)', EASE_IN = 'cubic-bezier(.55,.055,.675,.19)';
export const formingClock = () => globalThis.document?.timeline?.currentTime ?? performance.now();
// Reduced motion trades the whole sequence for a short crossfade, chosen when the idea is accepted.
export const formingMs = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? CALM_MS : FORM_MS);

const clamp = (v) => Math.max(0, Math.min(1, v));
const seg = (u, a, b) => clamp((u - a) / (b - a));
const eio = (t) => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const ein = (t) => t * t * t, eout = (t) => 1 - (1 - t) ** 3;
// [offset, value, easing?] stops for one property.
const K = (prop, stops) => stops.map(([offset, v, easing]) => ({ offset, [prop]: v, ...(easing && { easing }) }));

const overlays = new Map(), owned = new Map();
let looping = false;

// Idempotent per element: a kept element that already runs this animation keeps it.
function play(id, el, name, frames, { start, ms }, opts) {
  if (!el || el.getAnimations().some((a) => a.id === name)) return;
  const a = el.animate(frames, { duration: ms, fill: 'both', ...opts });
  a.id = name; a.startTime = start;
  // Cancelled when the transition ends, which rejects `finished`; nothing waits on it.
  a.finished?.catch(() => {});
  if (!owned.has(id)) owned.set(id, new Set());
  owned.get(id).add(a);
}

export function mountForming(art, id, t) {
  if (typeof art.animate !== 'function') return;
  const nb = art.querySelector(':scope > .gx.nb'), sky = art.querySelector(':scope > .gx:not(.nb)');
  const under = [sky, ...art.querySelectorAll(':scope > :is(.scene,.scrim)')], top = art.querySelectorAll(':scope > :is(.job-plate-graph,.job-plate-tag,.job-plate-unplanned)');
  if (t.ms === CALM_MS) {
    play(id, nb, 'bhx-nb', K('opacity', [[0, 1, 'ease'], [1, 0]]), t);
    for (const e of [...under, ...top]) play(id, e, 'bhx-in', K('opacity', [[0, 0, 'ease'], [1, 1]]), t);
    return;
  }
  const ov = nb && overlayOf(art, id, nb, sky, t);
  if (ov) art.append(ov.node);
  // Collect: the haze pulls in toward the point; the cloud goes under the flash.
  play(id, nb.querySelector('.drift'), 'bhx-pull', K('transform', [[0, 'scale(1)', EASE_IN], [FL, 'scale(.3)'], [1, 'scale(.3)']]), t);
  play(id, nb, 'bhx-nb', K('opacity', [[0, 1], [FL - .02, 1], [FL + .01, 0], [1, 0]]), t);
  // The job's sky comes up behind the flash, and the plan over it at the end; the sky's own hole
  // (repainted whenever it likes, so a variable rather than an animation) waits for the travelling one.
  for (const e of under) play(id, e, 'bhx-sky', K('opacity', [[0, 0], [FL - .005, 0, EASE_OUT], [FL + .14, 1], [1, 1]]), t);
  for (const e of top) play(id, e, 'bhx-top', K('opacity', [[0, 0], [.8, 0, 'ease'], [1, 1]]), t);
  play(id, art, 'bhx-hole', K('--bhx-hole', ov?.hole ? [[0, 0], [HAND, 0, 'ease-in-out'], [LAND, 1], [1, 1]] : [[0, 1], [1, 1]]), t);
}

// The overlay is painted for one width and one sky; a resize or a sky that changed (the job's
// state moved mid-transition) paints it again, and the gather redraws its frame from the clock.
function overlayOf(art, id, nb, sky, t) {
  const W = art.clientWidth, H = art.clientHeight, key = `${W}|${sky ? Object.values(sky.dataset).join('|') : ''}`;
  if (!W || !H) return null;
  let ov = overlays.get(id);
  if (!ov || ov.key !== key) {
    const ox = parseFloat(nb.style.getPropertyValue('--ox')) / 100, oy = parseFloat(nb.style.getPropertyValue('--oy')) / 100;
    const px = W * (Number.isFinite(ox) ? ox : .5), py = H * (Number.isFinite(oy) ? oy : .5);
    ov = { key, ...buildOverlay(id, W, H, px, py, rng(nb.dataset.seed || id)() < .5 ? -1 : 1, sky, t) };
    overlays.set(id, ov);
  }
  Object.assign(ov.gather, { start: t.start, ms: t.ms, nb, drawn: false });
  if (!looping) { looping = true; requestAnimationFrame(loop); }
  return ov;
}

// Drop a finished transition: its overlay and its animations, which all rest where the plate does without them.
export function dropForming(id) {
  overlays.delete(id);
  for (const a of owned.get(id) || []) a.cancel();
  owned.delete(id);
}

function buildOverlay(id, W, H, px, py, dir, sky, t) {
  const s = W / 320, dpr = Math.min(1.5, devicePixelRatio || 1);
  const node = document.createElement('div'); node.className = 'bhx';
  node.insertAdjacentHTML('afterbegin', `<div class="bhx-wash" style="--px:${px}px;--py:${py}px"></div>`);
  const [, X] = cv(W, H, dpr, node, 'layer');
  const hole = sky ? buildHole(id, holeOf(sky, W), px, py, t) : null;
  if (hole) node.appendChild(hole);
  // Sized to just clear the plate from anywhere the point can sit; the plate clips the rest.
  const at = document.createElement('div'); at.className = 'bhx-at'; at.style.cssText = `left:${px}px;top:${py}px`;
  at.innerHTML = `<div class="bhx-flash" style="--w:${1.1 * W}px"></div><div class="bhx-streak" style="--w:${1.4 * W}px"></div><div class="bhx-wave" style="--w:${1.3 * Math.hypot(W, H)}px"></div>`;
  node.appendChild(at);
  // Flash: a wash over the plate, a bloom at the point, the anamorphic streak and a shock ring.
  const [wash, flash, streak, wave] = [node.firstChild, ...at.children], o = (stops) => K('opacity', stops), tf = (stops) => K('transform', stops);
  play(id, wash, 'bhx-wash', o([[0, 0], [FL - .015, 0, EASE_IN], [FL + .006, .9, EASE_OUT], [FL + .17, 0], [1, 0]]), t);
  play(id, flash, 'bhx-flash', o([[0, 0], [FL - .03, 0, EASE_IN], [FL, 1, EASE_OUT], [FL + .2, 0], [1, 0]]), t);
  play(id, flash, 'bhx-flash-k', tf([[0, 'scale(.15)'], [FL - .03, 'scale(.15)', EASE_IN], [FL, 'scale(.7)', EASE_OUT], [FL + .2, 'scale(1.6)'], [1, 'scale(1.6)']]), t);
  play(id, streak, 'bhx-streak', o([[0, 0], [FL - .01, 0, EASE_OUT], [FL + .03, 1], [FL + .13, 0], [1, 0]]), t);
  play(id, streak, 'bhx-streak-k', tf([[0, 'scaleX(.1)'], [FL - .01, 'scaleX(.1)', EASE_OUT], [FL + .03, 'scaleX(1)'], [FL + .13, 'scaleX(1.3)'], [1, 'scaleX(1.3)']]), t);
  play(id, wave, 'bhx-wave', o([[0, 0], [FL, .95, 'cubic-bezier(.1,.6,.3,1)'], [FL + .3, 0], [1, 0]]), t);
  play(id, wave, 'bhx-wave-k', tf([[0, 'scale(0)'], [FL, 'scale(0)', 'cubic-bezier(.1,.6,.3,1)'], [FL + .3, 'scale(1)'], [1, 'scale(1)']]), t);
  const r = rng(`${id}:gather`), ps = Array.from({ length: Math.round(340 * Math.max(.8, s)) }, () => {
    const d = r() * .26;
    return { r0: .3 + Math.sqrt(r()) * 1.05, th0: r() * 6.283, d, e: Math.min(FL - .01, d + .17 + r() * .08), k: .8 + .5 * r(), w: (.5 + 1.1 * r() ** 3) * s, cool: r() < .3 };
  });
  return { node, hole, gather: { node, X, W, H, s, ps, px, py, dir, Rx: W * .62, Ry: Math.max(H * .8, W * .62 * .55), warm: ramp(FORM.form), cool: ramp(FORM.drift) } };
}

// The job sky's hole (job-skylines.js paint()), whole around its centre so it can travel: the
// glow, two shells of arc streaks and the horizon. Born white-hot at the point, it cools and
// grows as it sinks into place.
function buildHole(id, h, px, py, t) {
  const { R, s, dir, heat, pal } = h, dpr = Math.min(1.25, devicePixelRatio || 1), r = rng(`${id}:hole`);
  const at = document.createElement('div'); at.className = 'bhx-at bhx-hole';
  at.style.cssText = `left:${h.x}px;top:${h.y}px`;
  const centre = (c, w) => { c.style.left = c.style.top = `${-w / 2}px`; };
  const gs = 3.6 * R, [gc, G] = cv(gs, gs, 1, at, 'layer'); centre(gc, gs);
  G.translate(gs / 2, gs / 2); G.globalCompositeOperation = 'lighter';
  const hg = G.createRadialGradient(0, 0, R * .96, 0, 0, R * 1.8);
  hg.addColorStop(0, pal(.75, .5 * heat)); hg.addColorStop(.06, pal(.62, .16 * heat)); hg.addColorStop(.3, pal(.42, .04)); hg.addColorStop(1, pal(.3, 0));
  G.fillStyle = hg; G.fillRect(-gs / 2, -gs / 2, gs, gs);
  soft(G, 1, .09 * R, pal(.72, .55 * heat), (x) => { x.lineWidth = .12 * R; x.beginPath(); x.arc(0, -.03 * R, R * 1.08, 0, 7); x.stroke(); });
  const bright = dir > 0 ? 90 : 270;
  for (const [a0, a1, cnt, turn] of [[1, 1.07, 340, 900], [1.03, 1.18, 200, 520]]) {
    const ro = a1 * R, box = document.createElement('div');
    box.className = 'ring layer'; at.appendChild(box);
    box.style.cssText = `left:${-ro}px;top:${-ro - .03 * R}px;width:${2 * ro}px;height:${2 * ro}px`;
    box.style.maskImage = box.style.webkitMaskImage = `conic-gradient(from ${bright - 180}deg, rgba(0,0,0,.16), rgba(0,0,0,.6) 25%, #000 44%, #000 56%, rgba(0,0,0,.6) 75%, rgba(0,0,0,.16))`;
    const [c, x] = cv(ro * 2, ro * 2, dpr, box, '');
    x.translate(ro, ro);
    streaks(x, r, R, s, a0, a1, cnt, heat, pal);
    play(id, c, 'bhx-spin', [{ rotate: '0deg' }, { rotate: `${dir * turn}deg` }], t, { delay: FL * t.ms, duration: (1 - FL) * t.ms, easing: 'cubic-bezier(.2,.7,.35,1)' });
  }
  const fs = 2.2 * R, [fc, F] = cv(fs, fs, dpr, at, ''); centre(fc, fs);
  horizon(F, fs / 2, fs / 2, R, s, dpr, dir, pal);
  const hot = document.createElement('div'); hot.className = 'bhx-heat'; hot.style.setProperty('--w', `${2.4 * R}px`); at.appendChild(hot);
  play(id, hot, 'bhx-heat', K('opacity', [[0, 1], [FL + .03, 1, 'ease-out'], [.8, 0], [1, 0]]), t);
  play(id, at, 'bhx-bh', K('opacity', [[0, 0], [FL, 0, EASE_OUT], [FL + .05, 1], [HAND, 1, 'ease-in-out'], [LAND, 0], [1, 0]]), t);
  play(id, at, 'bhx-scale', K('scale', [[0, .04], [FL + .02, .04, 'cubic-bezier(.3,0,.3,1)'], [.65, .24, 'cubic-bezier(.45,0,.2,1)'], [.88, 1], [1, 1]]), t);
  const from = `${px - h.x}px ${py - h.y}px`;
  play(id, at, 'bhx-sink', K('translate', [[0, from], [.55, from, 'cubic-bezier(.55,0,.2,1)'], [.88, '0px 0px'], [1, '0px 0px']]), t);
  return at;
}

// The gather's streams are a pure function of the time since acceptance, so a repainted overlay
// draws the same frame. Per-frame drawing runs only until the flash; after that it is all CSS.
function loop(t) {
  let more = false;
  for (const { gather: g } of overlays.values()) {
    if (g.drawn || !g.node.isConnected) continue;
    const u = (t - g.start) / g.ms;
    pullSky(g.nb, 1 + 16 * ein(seg(u, 0, FL)));
    drawGather(g, u);
    if (u > FL + .02) g.drawn = true; else more = true;
  }
  if (more) requestAnimationFrame(loop); else looping = false;
}

function drawGather(g, u) {
  const { X, W, H, px, py, Rx, Ry, dir, warm, cool, s } = g;
  X.clearRect(0, 0, W, H);
  if (u < 0 || u > FL + .015) return;
  X.globalCompositeOperation = 'lighter'; X.lineCap = 'round';
  // The infall flattens into a tilted disc as it nears the flash.
  const flat = 1 - .7 * eio(seg(u, .1, FL)), tilt = -dir * .2 * seg(u, .1, FL), ct = Math.cos(tilt), sn = Math.sin(tilt);
  const pos = (p, q) => {
    const rho = p.r0 * (1 - q) ** 1.7, th = p.th0 + dir * (1.4 * q + 5.5 * q ** 4) * p.k;
    const lx = Math.cos(th) * rho * Rx, ly = Math.sin(th) * rho * Ry * flat;
    return [px + lx * ct - ly * sn, py + lx * sn + ly * ct, rho];
  };
  for (const p of g.ps) {
    const v = seg(u, p.d, p.e);
    if (v <= 0 || v >= 1) continue;
    const [x0, y0] = pos(p, Math.max(0, v - .09) ** 1.5), [x1, y1, rho] = pos(p, v ** 1.5);
    const hot = clamp(1 - rho / .5), a = clamp(v / .18) * clamp(rho / .04) * (.22 + .62 * hot);
    X.strokeStyle = (p.cool ? cool : warm)(.45 + .52 * hot, a); X.lineWidth = p.w * (1 + .8 * hot);
    X.beginPath(); X.moveTo(x0, y0); X.lineTo(x1, y1); X.stroke();
  }
  // The knot: grows and brightens as mass arrives, then implodes into the flash.
  const grow = eout(seg(u, .03, FL - .06)), squeeze = ein(seg(u, FL - .07, FL)), disc = seg(u, .16, .32) * (1 - squeeze);
  if (disc > 0) {
    const dr = .17 * W * (1 - .45 * seg(u, .28, FL));
    X.save(); X.translate(px, py); X.rotate(tilt); X.scale(1, .3);
    const d = X.createRadialGradient(0, 0, dr * .35, 0, 0, dr);
    d.addColorStop(0, warm(.95, 0)); d.addColorStop(.45, warm(.9, .5 * disc)); d.addColorStop(.7, warm(.7, .22 * disc)); d.addColorStop(1, warm(.5, 0));
    X.fillStyle = d; X.beginPath(); X.arc(0, 0, dr, 0, 7); X.fill(); X.restore();
  }
  const cr = (16 + 30 * grow) * s * (1 - .75 * squeeze), b = (.35 + .65 * grow) * (1 + .6 * squeeze);
  const k = X.createRadialGradient(px, py, 0, px, py, cr);
  k.addColorStop(0, `rgba(255,255,255,${Math.min(1, .95 * b)})`); k.addColorStop(.2, warm(.96, .8 * b)); k.addColorStop(.55, warm(.82, .25 * b)); k.addColorStop(1, warm(.6, 0));
  X.fillStyle = k; X.beginPath(); X.arc(px, py, cr, 0, 7); X.fill();
}
