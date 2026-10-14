import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skylineSvg, landOf, GLOW } from './job-skylines.js';

const strip = (svg) => svg.replace(/id="p\d+/g, 'id="p').replace(/#p\d+/g, '#p');

test('a job keeps its skyline, and the wall varies between jobs', () => {
  assert.equal(strip(skylineSvg('job1', 'run', 3)), strip(skylineSvg('job1', 'run', 3)));
  assert.ok(new Set(Array.from({ length: 20 }, (_, i) => landOf(`j${i}`))).size >= 3, 'ridges, lakes and dunes all turn up');
});

test('the light is the state, and the sun climbs as the job lands', () => {
  assert.ok(skylineSvg('job1', 'warn', 3).includes(GLOW.warn));
  assert.ok(skylineSvg('job1', 'nope', 3).includes(GLOW.idle), 'an unknown tone reads as idle');
  const sunY = (lvl) => Number(skylineSvg('job1', 'run', lvl).match(/<circle cx="[\d.]+" cy="([\d.]+)" r="[\d.]+" fill="#fff4e2"/)[1]);
  assert.ok(sunY(5) < sunY(1));
});

test('ridges are smooth: no step between neighbouring points jumps like a spike', () => {
  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    for (const [, d] of skylineSvg(seed, 'ok', 3).matchAll(/<path d="(M0,[^"]+?)(?: L320,150 L0,150 Z)?"/g)) {
      const ys = [...d.matchAll(/[ML](\d+),([\d.]+)/g)].map((m) => Number(m[2]));
      ys.slice(1).forEach((y, i) => assert.ok(Math.abs(y - ys[i]) < 3, `${seed}: ${ys[i]} → ${y}`));
    }
  }
});
