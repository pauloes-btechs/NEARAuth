'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../near-anchor.js');
const I = A._internal;

// Reference bytes produced with near-api-js 5 (transactions.createTransaction(...).encode()) for the same inputs.
const REFERENCE_HEX = '170000006e656172617574682d6c65646765722e746573746e657400000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2a00000000000000170000006e656172617574682d6c65646765722e746573746e6574202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f010000000206000000636f6d6d69745a0000007b22726f6f74223a2261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162222c226c6561665f636f756e74223a397d00e057eb481b000000000000000000000000000000000000';
const REFERENCE_PUBLIC_KEY = 'ed25519:1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE';

test('transaction encoding matches near-api-js byte for byte', () => {
  const bytes = I.encodeTransaction({
    signerId: 'nearauth-ledger.testnet', publicKey: Uint8Array.from({ length: 32 }, (_, i) => i), nonce: 42n,
    receiverId: 'nearauth-ledger.testnet', blockHash: Uint8Array.from({ length: 32 }, (_, i) => i + 32),
    methodName: 'commit', args: { root: 'ab'.repeat(32), leaf_count: 9 }, gas: 30000000000000n, deposit: 0,
  });
  assert.equal(Buffer.from(bytes).toString('hex'), REFERENCE_HEX);
  const signed = I.encodeSigned(bytes, new Uint8Array(64).fill(7));
  assert.equal(signed.length, bytes.length + 65);
  assert.equal(signed[bytes.length], 0, 'ed25519 signature tag');
});

test('base58 matches the reference and round-trips, including leading zeros', () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal('ed25519:' + I.b58encode(key), REFERENCE_PUBLIC_KEY);
  assert.deepEqual(I.b58decode(I.b58encode(key)), key);
  assert.deepEqual(I.b58decode(I.b58encode(new Uint8Array([0, 0, 255]))), new Uint8Array([0, 0, 255]));
  assert.throws(() => I.b58decode('0OIl'));
});

function fakeStorage() { const s = {}; return { s, getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = v; }, removeItem: (k) => { delete s[k]; } }; }
const rpcReply = (result) => ({ json: async () => ({ jsonrpc: '2.0', id: 'nearauth', result }) });

test('generates a key, signs a verifiable commit transaction, and refuses full-access keys', async () => {
  const store = fakeStorage();
  globalThis.localStorage = store;
  assert.equal(A.hasKey(), false);
  const pub = await A.generateKey();
  assert.match(pub, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.deepEqual(Object.keys(JSON.parse(store.s.nearauth_anchor_key_v1)).sort(), ['createdAt', 'pkcs8', 'publicKey']);

  const blockHash = I.b58encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  let sent = null, permission = { FunctionCall: { receiver_id: 'c.testnet', method_names: ['commit'], allowance: '1' } };
  globalThis.fetch = async (url, init) => {
    const q = JSON.parse(init.body);
    if (q.method === 'query') return rpcReply({ nonce: 100, block_hash: blockHash, permission });
    sent = Buffer.from(q.params[0], 'base64');
    return rpcReply({ status: { SuccessValue: Buffer.from(JSON.stringify({ block_height: 5, timestamp_ns: 6, leaf_count: 2 })).toString('base64') }, transaction: { hash: 'HASH' } });
  };
  const out = await A.anchor({ rpcUrl: 'https://rpc.invalid', contractId: 'c.testnet', root: 'CD'.repeat(32), leafCount: 2 });
  assert.deepEqual(out, { hash: 'HASH', anchor: { block_height: 5, timestamp_ns: 6, leaf_count: 2 } });

  // the broadcast transaction is correctly signed by the generated key, uses nonce + 1 and a lower-cased root
  const txBytes = sent.subarray(0, sent.length - 65), signature = sent.subarray(sent.length - 64);
  const rawPub = I.b58decode(pub.slice(8));
  const key = await crypto.subtle.importKey('raw', rawPub, { name: 'Ed25519' }, false, ['verify']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', txBytes));
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, digest), true);
  const expected = I.encodeTransaction({ signerId: 'c.testnet', publicKey: rawPub, nonce: 101n, receiverId: 'c.testnet', blockHash: I.b58decode(blockHash),
    methodName: 'commit', args: { root: 'cd'.repeat(32), leaf_count: 2 }, gas: 30000000000000n, deposit: 0 });
  assert.deepEqual(new Uint8Array(txBytes), expected);

  assert.equal((await A.keyStatus('https://rpc.invalid', 'c.testnet')).state, 'ready');
  permission = 'FullAccess';
  await assert.rejects(A.anchor({ rpcUrl: 'https://rpc.invalid', contractId: 'c.testnet', root: 'cd'.repeat(32), leafCount: 2 }), /full access/);
  A.removeKey();
  assert.equal(A.hasKey(), false);
  assert.equal((await A.keyStatus('https://rpc.invalid', 'c.testnet')).state, 'no-key');
});

test('contract failures and RPC errors surface as errors', async () => {
  globalThis.localStorage = fakeStorage();
  await A.generateKey();
  const bh = I.b58encode(new Uint8Array(32).fill(9));
  globalThis.fetch = async (url, init) => {
    const q = JSON.parse(init.body);
    if (q.method === 'query') return rpcReply({ nonce: 1, block_hash: bh, permission: { FunctionCall: {} } });
    return rpcReply({ status: { Failure: { ActionError: { kind: 'root already anchored' } } }, transaction: { hash: 'H' } });
  };
  await assert.rejects(A.anchor({ rpcUrl: 'u', contractId: 'c.testnet', root: 'cd'.repeat(32), leafCount: 1 }), /rejected the anchor/);
  globalThis.fetch = async () => ({ json: async () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } }) });
  assert.equal((await A.keyStatus('u', 'c.testnet')).state, 'not-registered');
});
