/* NEARAuth credential vault (Milestone B) — client-side authenticated encryption with WebCrypto.
 *
 *   master password --PBKDF2-HMAC-SHA-256 (600k iterations, 16-byte random salt)--> 256-bit AES-GCM key
 *   each entry      = AES-256-GCM(key, random 96-bit IV, plaintext JSON, AAD = "nearauth-vault-v1|<entryId>")
 *
 * Only ciphertext, salt and KDF parameters are ever persisted. The AAD binds a ciphertext to its entry id,
 * so records cannot be swapped between accounts. There is NO recovery: a lost master password means lost data.
 * Prototype — not audited. Planned upgrades: Argon2id, passkey (WebAuthn PRF) unlock, recovery kit.
 */
(function (root) {
  'use strict';
  var VERSION = 1;
  var ITERATIONS = 600000;
  var MIN_MASTER_LENGTH = 12;
  var CHECK_ID = '__vault_check__';
  var CHECK_VALUE = 'nearauth-vault-ok';

  function cryptoApi() { return root.crypto && root.crypto.subtle ? root.crypto : require('node:crypto').webcrypto; }
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64(bytes) { var s = ''; bytes = new Uint8Array(bytes); for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(str) { var s = atob(str), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  function VaultError(message, code) { var e = new Error(message); e.name = 'VaultError'; e.code = code; return e; }

  function deriveKey(master, salt, iterations) {
    var c = cryptoApi();
    return c.subtle.importKey('raw', enc.encode(master.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, base,
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    });
  }

  function aad(entryId) { return enc.encode('nearauth-vault-v' + VERSION + '|' + entryId); }

  function encrypt(key, entryId, value) {
    var c = cryptoApi(), iv = c.getRandomValues(new Uint8Array(12));
    return c.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(entryId) }, key, enc.encode(JSON.stringify(value)))
      .then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }

  function decrypt(key, entryId, record) {
    return cryptoApi().subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv), additionalData: aad(entryId) }, key, unb64(record.ct))
      .then(function (pt) { return JSON.parse(dec.decode(pt)); },
            function () { throw VaultError('Could not decrypt: wrong key or tampered data', 'decrypt_failed'); });
  }

  /* Creates a new vault. Returns { vault, key } — persist `vault`, keep `key` only in memory/session. */
  function create(master, opts) {
    if (typeof master !== 'string' || master.length < MIN_MASTER_LENGTH) {
      return Promise.reject(VaultError('Master password must be at least ' + MIN_MASTER_LENGTH + ' characters', 'weak_master'));
    }
    var iterations = (opts && opts.iterations) || ITERATIONS;
    var salt = cryptoApi().getRandomValues(new Uint8Array(16));
    return deriveKey(master, salt, iterations).then(function (key) {
      return encrypt(key, CHECK_ID, CHECK_VALUE).then(function (check) {
        return { key: key, vault: { v: VERSION, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: iterations, salt: b64(salt) }, check: check, entries: {} } };
      });
    });
  }

  /* Returns the key if the master password is correct; rejects with code `bad_master` otherwise. */
  function unlock(vault, master) {
    if (!vault || vault.v !== VERSION) return Promise.reject(VaultError('Unsupported vault format', 'bad_format'));
    return deriveKey(String(master), unb64(vault.kdf.salt), vault.kdf.iterations).then(function (key) {
      return decrypt(key, CHECK_ID, vault.check).then(function (v) {
        if (v !== CHECK_VALUE) throw VaultError('Wrong master password', 'bad_master');
        return key;
      }, function () { throw VaultError('Wrong master password', 'bad_master'); });
    });
  }

  function put(vault, key, entryId, value) {
    return encrypt(key, entryId, value).then(function (rec) { vault.entries[entryId] = rec; return vault; });
  }
  function get(vault, key, entryId) {
    var rec = vault.entries[entryId];
    if (!rec) return Promise.reject(VaultError('No vault entry for this account', 'not_found'));
    return decrypt(key, entryId, rec);
  }

  function exportKey(key) { return cryptoApi().subtle.exportKey('raw', key).then(b64); }
  function importKey(raw) { return cryptoApi().subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }

  var api = { VERSION: VERSION, ITERATIONS: ITERATIONS, MIN_MASTER_LENGTH: MIN_MASTER_LENGTH,
    create: create, unlock: unlock, put: put, get: get, exportKey: exportKey, importKey: importKey };
  root.NEARAuthVault = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
