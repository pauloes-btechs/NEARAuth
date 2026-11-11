/* NEARAuth Merkle batching (Milestone D).
 *
 * Audit-event commitments (SHA-256, hex) are batched into a Merkle tree; only the 32-byte root is anchored
 * on NEAR. An inclusion proof lets anyone check that one commitment belongs to an anchored root without
 * seeing any other event.
 *
 *   leaf  = SHA-256(0x00 || commitment)
 *   node  = SHA-256(0x01 || left || right)      (domain separation prevents leaf/node confusion)
 *   an unpaired node is promoted unchanged to the next level
 */
(function (root) {
  'use strict';
  function subtle() { return (root.crypto && root.crypto.subtle) || require('node:crypto').webcrypto.subtle; }
  function fromHex(hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('expected a 64-character hex SHA-256 value');
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(bytes) { return Array.prototype.map.call(new Uint8Array(bytes), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function hash(prefix, parts) {
    var len = 1 + parts.reduce(function (n, p) { return n + p.length; }, 0), buf = new Uint8Array(len), off = 1;
    buf[0] = prefix;
    parts.forEach(function (p) { buf.set(p, off); off += p.length; });
    return subtle().digest('SHA-256', buf).then(function (d) { return new Uint8Array(d); });
  }

  function levels(commitments) {
    if (!commitments.length) return Promise.reject(new Error('cannot build a tree with no commitments'));
    return Promise.all(commitments.map(function (c) { return hash(0, [fromHex(c)]); })).then(function build(level) {
      var all = [level];
      function next(cur) {
        if (cur.length === 1) return Promise.resolve(all);
        var jobs = [];
        for (var i = 0; i < cur.length; i += 2) jobs.push(i + 1 < cur.length ? hash(1, [cur[i], cur[i + 1]]) : Promise.resolve(cur[i]));
        return Promise.all(jobs).then(function (up) { all.push(up); return next(up); });
      }
      return next(level);
    });
  }

  /* -> { root: hex, leafCount, proofs: [ [ { side: 'left'|'right', hash: hex }, ... ] per commitment ] } */
  function build(commitments) {
    return levels(commitments).then(function (all) {
      var proofs = commitments.map(function (_, index) {
        var proof = [], i = index;
        for (var l = 0; l < all.length - 1; l++) {
          var sibling = i % 2 ? i - 1 : i + 1;
          if (sibling < all[l].length) proof.push({ side: i % 2 ? 'left' : 'right', hash: toHex(all[l][sibling]) });
          i = Math.floor(i / 2);
        }
        return proof;
      });
      return { root: toHex(all[all.length - 1][0]), leafCount: commitments.length, proofs: proofs };
    });
  }

  function verify(commitment, proof, expectedRoot) {
    return Promise.resolve().then(function () { return hash(0, [fromHex(commitment)]); }).then(function step(node) {
      return proof.reduce(function (p, s) {
        return p.then(function (cur) { var sib = fromHex(s.hash); return hash(1, s.side === 'left' ? [sib, cur] : [cur, sib]); });
      }, Promise.resolve(node));
    }).then(function (rootBytes) { return toHex(rootBytes) === String(expectedRoot).toLowerCase(); }, function () { return false; });
  }

  var api = { build: build, verify: verify };
  root.NEARAuthMerkle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
