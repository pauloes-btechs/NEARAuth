'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../extension/lib/vault.js');
const fast = { iterations: 1000 }; // keep tests quick; production default is asserted separately
const MASTER = 'unit-test-master-phrase';

test('defaults follow the documented parameters', () => {
  assert.equal(V.ITERATIONS, 600000);
  assert.equal(V.MIN_MASTER_LENGTH, 12);
});

test('create → put → unlock → get round-trips a credential', async () => {
  const { vault, key } = await V.create(MASTER, fast);
  await V.put(vault, key, 'acct1', { password: 'S3cret!-value', alias: 'a@b.example' });
  const stored = JSON.parse(JSON.stringify(vault)); // what would be persisted
  const key2 = await V.unlock(stored, MASTER);
  assert.deepEqual(await V.get(stored, key2, 'acct1'), { password: 'S3cret!-value', alias: 'a@b.example' });
});

test('persisted vault contains no plaintext', async () => {
  const { vault, key } = await V.create(MASTER, fast);
  await V.put(vault, key, 'acct1', { password: 'PlaintextNeedle-12345' });
  const json = JSON.stringify(vault);
  assert.ok(!json.includes('PlaintextNeedle'));
  assert.ok(!json.includes(MASTER));
  assert.deepEqual(Object.keys(vault).sort(), ['check', 'entries', 'kdf', 'v']);
});

test('wrong master password is rejected', async () => {
  const { vault } = await V.create(MASTER, fast);
  await assert.rejects(V.unlock(vault, 'not-the-master-pass'), (e) => e.code === 'bad_master');
  await assert.rejects(V.create('short'), (e) => e.code === 'weak_master');
});

test('tampered ciphertext and swapped entries fail authentication', async () => {
  const { vault, key } = await V.create(MASTER, fast);
  await V.put(vault, key, 'a', { password: 'one' });
  await V.put(vault, key, 'b', { password: 'two' });
  const swapped = JSON.parse(JSON.stringify(vault));
  swapped.entries.a = vault.entries.b; // move b's ciphertext under a's id
  await assert.rejects(V.get(swapped, key, 'a'), (e) => e.code === 'decrypt_failed');
  const flipped = JSON.parse(JSON.stringify(vault));
  const raw = Buffer.from(flipped.entries.a.ct, 'base64'); raw[0] ^= 1;
  flipped.entries.a.ct = raw.toString('base64');
  await assert.rejects(V.get(flipped, key, 'a'), (e) => e.code === 'decrypt_failed');
  await assert.rejects(V.get(vault, key, 'missing'), (e) => e.code === 'not_found');
});

test('every encryption uses a fresh IV and each vault a fresh salt', async () => {
  const a = await V.create(MASTER, fast), b = await V.create(MASTER, fast);
  assert.notEqual(a.vault.kdf.salt, b.vault.kdf.salt);
  await V.put(a.vault, a.key, 'x', { password: 'same' });
  const first = a.vault.entries.x;
  await V.put(a.vault, a.key, 'x', { password: 'same' });
  assert.notEqual(first.iv, a.vault.entries.x.iv);
  assert.notEqual(first.ct, a.vault.entries.x.ct);
});

test('session key export/import round-trips', async () => {
  const { vault, key } = await V.create(MASTER, fast);
  await V.put(vault, key, 'k', { password: 'p' });
  const key2 = await V.importKey(await V.exportKey(key));
  assert.deepEqual(await V.get(vault, key2, 'k'), { password: 'p' });
});
