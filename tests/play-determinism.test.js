const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeBuilder, KIT: K } = require('..').load();

/* debris thrown by the same taps must land the same way on every run, so replays and agent renders are reproducible */
function throwDebris() {
  const B = makeBuilder(3, K.diorama.styles.slate.palette);
  const start = B.count();
  for (let i = 0; i < 40; i++) B.iso(i * 0.05, 1, 0, 0.06, B.P[4], 3, {});
  const pieces = K.shatter(B, 64);
  const world = B.finish({ cam: { target: [0, 1, 0], dist: 8, pitch: 0.2, yaw: 0.4 }, detail: 10 });
  const debrisStart = world.count - 64;
  pieces.bind(world, debrisStart);
  const list = Array.from({ length: 40 }, (_, i) => world.data.slice((start + i) * 16, (start + i + 1) * 16));
  pieces.burst(list, [0, 1, 0], 4, 0, undefined);
  for (let step = 0; step < 30; step++) pieces.update(1 / 30);
  return Array.from(world.data.slice(debrisStart * 16));
}

test('debris bursts are deterministic', () => {
  const first = throwDebris(), second = throwDebris();
  assert.ok(first.some(v => v !== 0), 'debris was thrown');
  assert.deepEqual(first, second);
});

test('the game pools draw no unseeded randomness', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'kit', 'kg-play.js'), 'utf8');
  assert.equal(/Math\.random\(/.test(source), false);
});
