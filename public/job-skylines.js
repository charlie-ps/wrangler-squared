import { fx, grainRect, rand, hash } from './model-plates.js';

// A job's quiet sky: one night for every plate, and along its foot a skyline
// seeded from the job's id. Three depths of smooth ridge (some jobs get a lake
// in place of the near one, some flatter dunes), a sun that sits behind the
// ridges while the job is young and clears them as it lands, and the sky's foot
// lit in the colour of the job's state. Art colours are fixed, like the scenes'.
export const GLOW = { run: '#8f9dff', warn: '#f2c14e', bad: '#ff6a3d', ok: '#6fd0a0', pause: '#c39af0', idle: '#6b7285' };
const LANDS = ['ridges', 'ridges', 'lake', 'dunes'];
export const landOf = (seed) => LANDS[hash(`land${seed}`) % LANDS.length];

// Summed sines rather than noise: a ridge line with no spikes in it.
function ridge(r, base, amp, freq) {
  const ph = [r() * 6.28, r() * 6.28, r() * 6.28], f = [freq, freq * 2.3, freq * 5.1];
  const y = (x) => base - amp * (.6 * Math.sin(x * f[0] + ph[0]) + .28 * Math.sin(x * f[1] + ph[1]) + .12 * Math.sin(x * f[2] + ph[2]));
  let d = `M0,${y(0).toFixed(1)}`;
  for (let x = 4; x <= 320; x += 4) d += ` L${x},${y(x).toFixed(1)}`;
  return { line: d, fill: `${d} L320,150 L0,150 Z` };
}

// `tone` is a STATES tone (job-state.js); `lvl` 1–5 is how far the job has landed.
export function skylineSvg(seed, tone, lvl) {
  const k = fx(), id = k.id, c = GLOW[tone] || GLOW.idle, r = rand(`sky${seed}`), land = landOf(seed);
  const glow = .22 + lvl * .07, sx = 50 + r() * 220, sy = 126 - lvl * 6, sr = 6 + r() * 3;
  const stars = Array.from({ length: 34 }, () => `<circle cx="${(r() * 320).toFixed(1)}" cy="${(3 + r() * 96).toFixed(1)}" r="${(.25 + r() * .5).toFixed(2)}" fill="#fff" opacity="${(.12 + r() * .45).toFixed(2)}"/>`).join('');
  const flat = land === 'dunes', far = ridge(r, 114, flat ? 4 : 10, flat ? .012 : .022), mid = ridge(r, 123, flat ? 3 : 7, flat ? .018 : .031);
  const near = land === 'lake' ? null : ridge(r, 133, flat ? 2.5 : 4, .045);
  const lake = near ? '' : `<rect y="131" width="320" height="19" fill="#05060a"/><rect y="131" width="320" height="19" fill="${c}" opacity=".07"/>
    ${Array.from({ length: 6 }, (_, i) => { const w = sr * (2.4 - i * .3) + r() * 4; return `<rect x="${(sx - w / 2).toFixed(1)}" y="${(133 + i * 2.6).toFixed(1)}" width="${w.toFixed(1)}" height=".9" rx=".45" fill="#fff4e2" opacity="${(.5 - i * .07).toFixed(2)}"/>`; }).join('')}
    <line x1="0" y1="131" x2="320" y2="131" stroke="${c}" stroke-width=".5" opacity=".35"/>`;
  const body = `<rect width="320" height="150" fill="url(#${id}g)"/>${stars}
    <ellipse cx="${sx.toFixed(1)}" cy="118" rx="230" ry="${10 + lvl * 2}" fill="${c}" opacity="${(glow * .8).toFixed(2)}" filter="${k.f('b6')}"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy}" r="${(sr * 3.2).toFixed(1)}" fill="${c}" opacity="${glow.toFixed(2)}" filter="${k.f('b6')}"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy}" r="${sr.toFixed(1)}" fill="#fff4e2" opacity=".92"/>
    <path d="${far.fill}" fill="#161a28"/><path d="${far.line}" fill="none" stroke="${c}" stroke-width=".6" opacity=".4"/>
    <path d="${mid.fill}" fill="#0d1019"/>
    ${near ? `<path d="${near.fill}" fill="#06070b"/>` : lake}
    ${grainRect(k, .18)}`;
  return `<svg class="skyline" viewBox="0 0 320 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>${k.defs()}<linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#07080e"/><stop offset=".6" stop-color="#0c0f19"/><stop offset=".85" stop-color="${c}" stop-opacity=".2"/><stop offset="1" stop-color="${c}" stop-opacity=".1"/></linearGradient></defs>${body}</svg>`;
}
