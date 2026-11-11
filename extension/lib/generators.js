/* NEARAuth shared generators — used by the content script, popup, test page preview and unit tests.
 * Demo aliases use the reserved `.example` TLD (RFC 2606): they are NOT routable and cannot receive email. */
(function (root) {
  'use strict';

  var ALIAS_DOMAIN = 'alias.nearauth.example';
  var ALIAS_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  var PW_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%*-_+='];

  function randomInts(n) {
    var b = new Uint32Array(n);
    (root.crypto || require('node:crypto').webcrypto).getRandomValues(b);
    return Array.prototype.slice.call(b);
  }

  // Unbiased pick: rejection sampling so every character is equally likely.
  function pick(chars) {
    var limit = Math.floor(0x100000000 / chars.length) * chars.length;
    for (;;) {
      var v = randomInts(1)[0];
      if (v < limit) return chars[v % chars.length];
    }
  }

  function randomString(chars, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += pick(chars);
    return out;
  }

  function alias() {
    return randomString(ALIAS_CHARS, 10) + '@' + ALIAS_DOMAIN;
  }

  function password(length) {
    length = Math.max(12, length || 20);
    var all = PW_SETS.join('');
    var chars = PW_SETS.map(pick); // at least one from every set
    while (chars.length < length) chars.push(pick(all));
    for (var i = chars.length - 1; i > 0; i--) { // Fisher–Yates shuffle
      var j = randomInts(1)[0] % (i + 1);
      var t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    return chars.join('');
  }

  function siteName(hostname) {
    if (!hostname) return 'Local test page';
    var parts = hostname.replace(/^www\./, '').split('.');
    var core = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    if (/^(github|gitlab)$/.test(core) && parts.length > 2) core = parts[0];
    return core.charAt(0).toUpperCase() + core.slice(1);
  }

  function id() {
    return randomString(ALIAS_CHARS, 12);
  }

  var api = { ALIAS_DOMAIN: ALIAS_DOMAIN, alias: alias, password: password, siteName: siteName, id: id };
  root.NEARAuthGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
