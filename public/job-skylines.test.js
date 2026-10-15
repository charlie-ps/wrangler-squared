import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAL, paletteOf, capFor, skyHtml, noteAnims, carryAnims } from './job-skylines.js';

test('the cap stays 14 units under the plan at every level, and grows as the job lands', () => {
  for (let floor = 20; floor <= 140; floor += 5) for (let lvl = 1; lvl <= 5; lvl++) {
    const cap = capFor(lvl, floor);
    assert.ok(cap <= Math.max(13, 150 - floor - 14), `floor ${floor} lvl ${lvl}: ${cap}`);
    assert.ok(cap >= 13);
  }
  assert.ok(capFor(5, 40) > capFor(1, 40));
  assert.equal(capFor(5, 140), 13, 'a plan reaching the foot leaves only the minimum');
});

test('a tone picks its palette, and an unknown one reads as idle', () => {
  for (const tone of Object.keys(PAL)) assert.equal(paletteOf(tone), PAL[tone]);
  assert.equal(paletteOf('nope'), PAL.idle);
  assert.ok(Object.values(PAL).every((p) => p.length === 7 && p.at(-1) === '#ffffff'));
  assert.match(skyHtml('job1', 'warn', 3, 90), /data-tone="warn"/);
  assert.match(skyHtml('job1', 'nope', 3, 90), /data-tone="idle"/);
});

test('the placeholder carries what the painter needs, and the same job paints the same sky', () => {
  const a = skyHtml('job1', 'run', 3, 88.4, true);
  assert.equal(a, skyHtml('job1', 'run', 3, 88.4, true));
  assert.match(a, /^<div class="gx" data-seed="\w+" data-tone="run" data-lvl="3" data-floor="88" data-dim><\/div>$/);
  assert.doesNotMatch(skyHtml('job1', 'run', 3, 88), /data-dim/);
  assert.notEqual(skyHtml('job1', 'run', 3, 88).match(/data-seed="(\w+)"/)[1], skyHtml('job2', 'run', 3, 88).match(/data-seed="(\w+)"/)[1]);
});

test('a re-render carries each animation\'s phase and rate over: a sky\'s by element, a plate\'s sweep by job', () => {
  const spin = {}, plate = (board) => ({ dataset: { board } });
  const anim = (target, t, rate, pseudoElement) => ({ effect: { target, pseudoElement }, currentTime: t, playbackRate: rate });
  const held = noteAnims([anim(spin, 5000, 18.5), anim(plate('j1'), 900, 1, '::before'), anim({}, null, 1)]);
  assert.equal(held.size, 2, 'an animation with no time yet is not noted');
  const fresh = [anim(spin, 0, 1), anim(plate('j1'), 0, 1, '::before'), anim(plate('j2'), 0, 1, '::before')];
  carryAnims(fresh, held);
  assert.deepEqual(fresh.map((a) => [a.currentTime, a.playbackRate]), [[5000, 18.5], [900, 1], [0, 1]]);
});
