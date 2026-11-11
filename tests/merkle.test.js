'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const M = require('../extension/lib/merkle.js');

const sha = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();
const commit = (s) => createHash('sha256').update(s).digest('hex');
const leaf = (c) => sha(Buffer.from([0]), Buffer.from(c, 'hex'));
const node = (l, r) => sha(Buffer.from([1]), l, r);

test('root matches an independent reference implementation', async () => {
  const c = ['a', 'b', 'c'].map(commit);
  const expected = node(node(leaf(c[0]), leaf(c[1])), leaf(c[2])).toString('hex'); // third leaf promoted
  assert.equal((await M.build(c)).root, expected);
  assert.equal((await M.build([c[0]])).root, leaf(c[0]).toString('hex'));
});

test('every proof verifies for batch sizes 1..17', async () => {
  for (let n = 1; n <= 17; n++) {
    const c = Array.from({ length: n }, (_, i) => commit('event-' + n + '-' + i));
    const t = await M.build(c);
    assert.equal(t.leafCount, n);
    for (let i = 0; i < n; i++) assert.equal(await M.verify(c[i], t.proofs[i], t.root), true, `n=${n} i=${i}`);
  }
});

test('proofs fail for a different commitment, a different root, or a tampered path', async () => {
  const c = Array.from({ length: 6 }, (_, i) => commit('e' + i));
  const t = await M.build(c);
  assert.equal(await M.verify(commit('not-in-batch'), t.proofs[2], t.root), false);
  assert.equal(await M.verify(c[2], t.proofs[3], t.root), false);
  assert.equal(await M.verify(c[2], t.proofs[2], commit('other-root')), false);
  const bad = t.proofs[2].map((s, i) => (i === 0 ? { ...s, side: s.side === 'left' ? 'right' : 'left' } : s));
  assert.equal(await M.verify(c[2], bad, t.root), false);
  assert.equal(await M.verify('zz', t.proofs[2], t.root), false);
});

test('changing any event changes the root; a leaf cannot pose as an inner node', async () => {
  const c = Array.from({ length: 4 }, (_, i) => commit('e' + i));
  const a = await M.build(c);
  const b = await M.build([c[0], c[1], c[2], commit('changed')]);
  assert.notEqual(a.root, b.root);
  const pair = await M.build([c[0], c[1]]);
  assert.notEqual((await M.build([pair.root])).root, pair.root);
  await assert.rejects(M.build([]));
});
