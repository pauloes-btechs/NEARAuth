/* NEARAuth in-browser anchoring (Testnet demo).
 *
 * Signs a `commit(root, leaf_count)` transaction for the audit-ledger contract directly in the browser, using a
 * FUNCTION-CALL access key: a NEAR key that can only call the listed method on the listed contract. It cannot
 * transfer tokens, deploy code, add keys, or attach a deposit.
 *
 * The key pair is generated here with WebCrypto (Ed25519). The private key stays in this browser's localStorage;
 * only the public key is shown, to be registered on the contract account once (workflow mode `add-anchor-key`).
 *
 * No dependencies: Borsh transaction encoding, base58 and RPC calls are implemented below.
 */
(function (root) {
  'use strict';
  var STORE_KEY = 'nearauth_anchor_key_v1';
  var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var GAS = 30000000000000n; // 30 Tgas

  function subtle() { return (root.crypto && root.crypto.subtle) || require('node:crypto').webcrypto.subtle; }
  function storage() { return root.localStorage; }

  /* ---------- encoding helpers ---------- */
  function b58encode(bytes) {
    var n = 0n, out = '';
    bytes.forEach(function (b) { n = (n << 8n) | BigInt(b); });
    while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    for (var i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
    return out;
  }
  function b58decode(str) {
    var n = 0n;
    for (var i = 0; i < str.length; i++) {
      var v = ALPHABET.indexOf(str[i]);
      if (v < 0) throw new Error('invalid base58');
      n = n * 58n + BigInt(v);
    }
    var bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
    for (var j = 0; j < str.length && str[j] === '1'; j++) bytes.unshift(0);
    return new Uint8Array(bytes);
  }
  function b64(bytes) { var s = ''; new Uint8Array(bytes).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s); }
  function unb64(str) { return Uint8Array.from(atob(str), function (c) { return c.charCodeAt(0); }); }
  function concat(parts) {
    var len = parts.reduce(function (n, p) { return n + p.length; }, 0), out = new Uint8Array(len), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }
  function u32(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
  function u64(n) { var b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
  function u128(n) { n = BigInt(n); return concat([u64(n & 0xffffffffffffffffn), u64(n >> 64n)]); }
  function str(s) { var b = new TextEncoder().encode(s); return concat([u32(b.length), b]); }

  /* ---------- Borsh: Transaction with a single FunctionCall action ----------
   * Transaction { signer_id, public_key (0 = ed25519 + 32 bytes), nonce u64, receiver_id, block_hash [32], actions }
   * Action::FunctionCall (enum index 2) { method_name, args (bytes), gas u64, deposit u128 }                    */
  function encodeTransaction(tx) {
    var args = new TextEncoder().encode(JSON.stringify(tx.args));
    return concat([
      str(tx.signerId), new Uint8Array([0]), tx.publicKey, u64(tx.nonce), str(tx.receiverId), tx.blockHash,
      u32(1), new Uint8Array([2]), str(tx.methodName), u32(args.length), args, u64(tx.gas), u128(tx.deposit || 0)
    ]);
  }
  function encodeSigned(txBytes, signature) { return concat([txBytes, new Uint8Array([0]), signature]); }

  /* ---------- key management ---------- */
  function supported() {
    return subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(function () { return true; }, function () { return false; });
  }
  function load() { try { return JSON.parse(storage().getItem(STORE_KEY)); } catch (e) { return null; } }
  function publicKey() { var k = load(); return k ? k.publicKey : null; }
  function hasKey() { return !!publicKey(); }
  function removeKey() { storage().removeItem(STORE_KEY); }
  function generateKey() {
    return subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (pair) {
      return Promise.all([subtle().exportKey('raw', pair.publicKey), subtle().exportKey('pkcs8', pair.privateKey)]);
    }).then(function (out) {
      var pub = 'ed25519:' + b58encode(new Uint8Array(out[0]));
      storage().setItem(STORE_KEY, JSON.stringify({ publicKey: pub, pkcs8: b64(out[1]), createdAt: new Date().toISOString() }));
      return pub;
    });
  }
  function signer() {
    var k = load();
    if (!k) return Promise.reject(new Error('No anchor key in this browser'));
    return subtle().importKey('pkcs8', unb64(k.pkcs8), { name: 'Ed25519' }, false, ['sign']).then(function (priv) {
      return { publicKey: k.publicKey, raw: b58decode(k.publicKey.slice(8)), sign: function (msg) { return subtle().sign({ name: 'Ed25519' }, priv, msg).then(function (s) { return new Uint8Array(s); }); } };
    });
  }

  /* ---------- RPC ---------- */
  function rpc(url, method, params) {
    return root.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nearauth', method: method, params: params }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { var c = j.error.cause || {}; var e = new Error((c.name || j.error.name || 'RPC error') + (j.error.data ? ': ' + JSON.stringify(j.error.data).slice(0, 200) : '')); e.code = c.name; throw e; }
        return j.result;
      });
  }

  /* Is this browser's key registered on the account, and what may it do? */
  function keyStatus(rpcUrl, accountId) {
    var pub = publicKey();
    if (!pub) return Promise.resolve({ state: 'no-key' });
    return rpc(rpcUrl, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: pub }).then(function (k) {
      var perm = k.permission;
      if (perm === 'FullAccess') return { state: 'full-access', publicKey: pub }; // never expected: we refuse to use it
      var fc = perm.FunctionCall || {};
      return { state: 'ready', publicKey: pub, receiver: fc.receiver_id, methods: fc.method_names, allowance: fc.allowance };
    }, function (e) {
      if (/UNKNOWN_ACCESS_KEY/.test(e.code || e.message)) return { state: 'not-registered', publicKey: pub };
      throw e;
    });
  }

  /* Sign and send commit(root, leaf_count). Resolves { hash, anchor } once the transaction has executed. */
  function anchor(opts) {
    var s;
    return signer().then(function (sg) {
      s = sg;
      return rpc(opts.rpcUrl, 'query', { request_type: 'view_access_key', finality: 'final', account_id: opts.contractId, public_key: s.publicKey });
    }).then(function (key) {
      if (key.permission === 'FullAccess') throw new Error('Refusing to sign: this key has full access. Use a function-call key.');
      var txBytes = encodeTransaction({
        signerId: opts.contractId, publicKey: s.raw, nonce: BigInt(key.nonce) + 1n, receiverId: opts.contractId,
        blockHash: b58decode(key.block_hash), methodName: 'commit', args: { root: String(opts.root).toLowerCase(), leaf_count: opts.leafCount }, gas: GAS, deposit: 0
      });
      return subtle().digest('SHA-256', txBytes).then(function (hash) { return s.sign(new Uint8Array(hash)); })
        .then(function (sig) { return rpc(opts.rpcUrl, 'broadcast_tx_commit', [b64(encodeSigned(txBytes, sig))]); });
    }).then(function (res) {
      var status = res.status || {};
      if (status.Failure) throw new Error('Contract rejected the anchor: ' + JSON.stringify(status.Failure).slice(0, 220));
      var value = null;
      try { value = JSON.parse(new TextDecoder().decode(unb64(status.SuccessValue || ''))); } catch (e) { /* no return value */ }
      return { hash: res.transaction && res.transaction.hash, anchor: value };
    });
  }

  var api = { supported: supported, hasKey: hasKey, publicKey: publicKey, generateKey: generateKey, removeKey: removeKey, keyStatus: keyStatus, anchor: anchor,
    _internal: { encodeTransaction: encodeTransaction, encodeSigned: encodeSigned, b58encode: b58encode, b58decode: b58decode } };
  root.NEARAuthAnchor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
