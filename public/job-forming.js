import { FORM, holeOf, ramp, rng, cv, pullSky, paintWhole, dropWhole } from './job-skylines.js';

// An accepted idea's plate forms its job's black hole: the cloud's mass spirals in and piles up
// at its point (0 to FL) and implodes in a flash. Under it the job's own sky comes up seen from
// far out, its whole hole centred on the point, and the camera closes in on the plate in one
// eased move. The hole on screen from the flash on is the sky's own, so it never changes as it
// moves, and the plate the transition ends on is that same sky, so nothing is swapped.
//
// The board rebuilds every plate's markup on each live tick, so every animation here is a Web
// Animation whose startTime is the moment the idea was accepted: one on a fresh element (the plan,
// the repo tag) is made again at the same instant, and one on a kept element (the cloud and the
// job's sky, which mountSkies puts back, and the overlay kept here by job id) carries on. Only
// transform and opacity move, so the compositor runs them without repainting the big canvases.
// Each ends where the plain job plate rests, so the render that drops `.forming` changes nothing.
export const FORM_MS = 5600, CALM_MS = 450;
const FL = .46, HOLD = FL + .1, LAND = .88;
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
  // Collect: the haze pulls in toward the point (on top of its own slow drift, so accepting moves
  // nothing); the cloud goes under the flash.
  play(id, nb.querySelector('.drift'), 'bhx-pull', K('transform', [[0, 'scale(1)', EASE_IN], [FL, 'scale(.3)'], [1, 'scale(.3)']]), t, { composite: 'add' });
  play(id, nb, 'bhx-nb', K('opacity', [[0, 1], [FL - .02, 1], [FL + .01, 0], [1, 0]]), t);
  // The job's sky comes up under the flash, held far out for a moment, and the plan over it as
  // the camera lands. Both sky animations end early and hold nothing after (their last frames are
  // the plate's own): a sky an animation still holds keeps the raster it was given for the zoom, a
  // shade softer than the plate's, so it lets go mid-move rather than at the end.
  const up = FL + .14;
  for (const e of under) play(id, e, 'bhx-sky', K('opacity', [[0, 0], [(FL - .005) / up, 0, EASE_OUT], [1, 1]]), t, { duration: up * t.ms, fill: 'backwards' });
  for (const e of top) play(id, e, 'bhx-top', K('opacity', [[0, 0], [.76, 0, 'ease'], [.94, 1], [1, 1]]), t);
  const cam = ov?.cam;
  if (cam) paintWhole(sky, cam, (root) => {
    root.style.transformOrigin = `${cam.X0}px ${cam.Y0}px`;
    play(id, root, 'bhx-cam', K('transform', [[0, cam.from], [HOLD / LAND, cam.from, 'cubic-bezier(.45,0,.25,1)'], [1, 'translate(0px, 0px) scale(1)']]), t, { duration: LAND * t.ms, fill: 'backwards' });
  });
}

// The camera's start, far enough out that the hole, its rings and their glow fit the plate around
// the point, and the frame the sky must paint so that no edge of it shows at any moment of the
// move (the zoom and the pan run on one curve, so the move is one straight path to sample).
function frameOf(h, W, H, px, py) {
  const z = Math.min(.6, .9 * Math.min(py, H - py) / (1.25 * h.R)), T = [px - z * h.x, py - z * h.y];
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  for (let i = 0; i <= 32; i++) {
    const w = i / 32, k = z + (1 - z) * w, tx = T[0] * (1 - w), ty = T[1] * (1 - w);
    x0 = Math.min(x0, -tx / k); y0 = Math.min(y0, -ty / k); x1 = Math.max(x1, (W - tx) / k); y1 = Math.max(y1, (H - ty) / k);
  }
  // Whole pixels at the canvases' 1.25 scale, so the plate's part of the frame lands on the same pixels.
  const X0 = 4 * Math.ceil(1 - x0 / 4), Y0 = 4 * Math.ceil(1 - y0 / 4);
  return { X0, Y0, BW: X0 + Math.ceil(x1) + 4, BH: Y0 + Math.ceil(y1) + 4, from: `translate(${T[0].toFixed(2)}px, ${T[1].toFixed(2)}px) scale(${z.toFixed(4)})` };
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
    ov = { key, sky, cam: sky && frameOf(holeOf(sky, W), W, H, px, py), ...buildOverlay(id, W, H, px, py, rng(nb.dataset.seed || id)() < .5 ? -1 : 1, t) };
    overlays.set(id, ov);
  }
  Object.assign(ov.gather, { start: t.start, ms: t.ms, nb, drawn: false });
  if (!looping) { looping = true; requestAnimationFrame(loop); }
  return ov;
}

// Drop a finished transition: its overlay and its animations, which all rest where the plate does without them.
export function dropForming(id) {
  if (overlays.get(id)?.sky) dropWhole(overlays.get(id).sky);
  overlays.delete(id);
  for (const a of owned.get(id) || []) a.cancel();
  owned.delete(id);
}

function buildOverlay(id, W, H, px, py, dir, t) {
  const s = W / 320, dpr = Math.min(1.5, devicePixelRatio || 1);
  const node = document.createElement('div'); node.className = 'bhx';
  node.insertAdjacentHTML('afterbegin', `<div class="bhx-wash" style="--px:${px}px;--py:${py}px"></div>`);
  const [, X] = cv(W, H, dpr, node, 'layer');
  // Sized to just clear the plate from anywhere the point can sit; the plate clips the rest.
  const at = document.createElement('div'); at.className = 'bhx-at'; at.style.cssText = `left:${px}px;top:${py}px`;
  at.innerHTML = `<div class="bhx-flash" style="--w:${1.1 * W}px"></div><div class="bhx-wave" style="--w:${1.3 * Math.hypot(W, H)}px"></div>`;
  node.appendChild(at);
  // Flash: a wash over the plate, a bloom at the point and a shock ring.
  const [wash, flash, wave] = [node.firstChild, ...at.children], o = (stops) => K('opacity', stops), tf = (stops) => K('transform', stops);
  play(id, wash, 'bhx-wash', o([[0, 0], [FL - .015, 0, EASE_IN], [FL + .006, .9, EASE_OUT], [FL + .17, 0], [1, 0]]), t);
  play(id, flash, 'bhx-flash', o([[0, 0], [FL - .03, 0, EASE_IN], [FL, 1, EASE_OUT], [FL + .2, 0], [1, 0]]), t);
  play(id, flash, 'bhx-flash-k', tf([[0, 'scale(.15)'], [FL - .03, 'scale(.15)', EASE_IN], [FL, 'scale(.7)', EASE_OUT], [FL + .2, 'scale(1.6)'], [1, 'scale(1.6)']]), t);
  play(id, wave, 'bhx-wave', o([[0, 0], [FL, .95, 'cubic-bezier(.1,.6,.3,1)'], [FL + .3, 0], [1, 0]]), t);
  play(id, wave, 'bhx-wave-k', tf([[0, 'scale(0)'], [FL, 'scale(0)', 'cubic-bezier(.1,.6,.3,1)'], [FL + .3, 'scale(1)'], [1, 'scale(1)']]), t);
  const r = rng(`${id}:gather`), ps = Array.from({ length: Math.round(340 * Math.max(.8, s)) }, () => {
    const d = r() * .26;
    return { r0: .3 + Math.sqrt(r()) * 1.05, th0: r() * 6.283, d, e: Math.min(FL - .01, d + .17 + r() * .08), k: .8 + .5 * r(), w: (.5 + 1.1 * r() ** 3) * s, cool: r() < .3 };
  });
  return { node, gather: { node, X, W, H, s, ps, px, py, dir, Rx: W * .62, Ry: Math.max(H * .8, W * .62 * .55), warm: ramp(FORM.form), cool: ramp(FORM.drift) } };
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
