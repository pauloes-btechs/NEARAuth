/* NEARAuth automatic response (Milestone C follow-up).
 *
 * Decides what to do when the detection engine flags an inbound message, and can carry out a standards-based
 * one-click unsubscribe (RFC 8058).
 *
 * Safety rules — an unsubscribe is only planned when ALL of these hold:
 *   1. the message was classified `unexpected` (never for the original service or its mail provider);
 *   2. it carries a DKIM result from a TRUSTED VERIFIER (`trustedAuthResult`, see detection.js) that passed,
 *      is aligned with the sender's domain, and covers both List-Unsubscribe headers (RFC 8058 §4).
 *      A `dkimDomain` string in the input is a claim, not a verification, and is ignored;
 *   3. it advertises `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an https:// URL that passes
 *      `checkUnsubscribeUrl` (no IP literals, local names, credentials or odd ports; host aligned with the signer).
 * A sent unsubscribe is reported as "requested" — the sender's response is opaque, so cancellation is never claimed.
 * Otherwise nothing is requested: following arbitrary unsubscribe links in unauthenticated or forged mail
 * confirms the address to the sender and can be dangerous. Pausing the alias stops the mail regardless of
 * whether the sender honours an unsubscribe.
 */
(function (root) {
  'use strict';
  var Detection = root.NEARAuthDetection || (typeof require !== 'undefined' ? require('./detection.js') : null);
  var MAX_URL = 2048;

  /* Is this URL safe to POST an unsubscribe to, on behalf of a message signed by `alignedDomain`?
   * -> { ok: true, url } | { ok: false, reason }                                                              */
  function checkUnsubscribeUrl(raw, opts) {
    var aligned = Detection.registrableDomain((opts && opts.alignedDomain) || '');
    var u;
    if (typeof raw !== 'string' || raw.length > MAX_URL) return { ok: false, reason: 'URL missing or too long' };
    try { u = new URL(raw); } catch (e) { return { ok: false, reason: 'URL does not parse' }; }
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (u.protocol !== 'https:') return { ok: false, reason: 'Only https URLs are allowed' };
    if (u.username || u.password) return { ok: false, reason: 'URLs with embedded credentials are refused' };
    if (u.port && u.port !== '443') return { ok: false, reason: 'Only the default https port is allowed' };
    if (/^\[.*\]$/.test(u.hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^(0x[0-9a-f]+|\d+)$/i.test(host)) return { ok: false, reason: 'IP-address hosts are refused' };
    if (host.indexOf('.') === -1 || /(^|\.)(localhost|local|internal|intranet|lan|home|arpa|test|invalid|example)$/.test(host)) return { ok: false, reason: 'Local or reserved host names are refused' };
    if (!aligned) return { ok: false, reason: 'No verified signing domain to align the URL with' };
    if (Detection.registrableDomain(host) !== aligned) return { ok: false, reason: 'URL host ' + host + ' is not under the signing domain ' + aligned };
    return { ok: true, url: u.href };
  }

  function header(headers, name) {
    if (!headers) return '';
    var wanted = name.toLowerCase(), value = '';
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === wanted) value = String(headers[k]); });
    return value;
  }

  /* -> { https: [url], mailto: [address], oneClick: boolean } */
  function parseListUnsubscribe(headers) {
    var out = { https: [], mailto: [], oneClick: false };
    var raw = header(headers, 'List-Unsubscribe').replace(/\r?\n[ \t]+/g, ' ');
    (raw.match(/<[^<>]+>/g) || []).forEach(function (part) {
      var uri = part.slice(1, -1).trim();
      if (/^https:\/\//i.test(uri)) {
        try { out.https.push(new URL(uri).href); } catch (e) { /* malformed: ignore */ }
      } else if (/^mailto:/i.test(uri)) {
        out.mailto.push(uri.slice(7).split('?')[0]);
      } // http:// and anything else is ignored on purpose
    });
    out.oneClick = /^\s*List-Unsubscribe=One-Click\s*$/i.test(header(headers, 'List-Unsubscribe-Post'));
    return out;
  }

  /* result:   output of NEARAuthDetection.classify / investigate
   * message:  { headers, auth: trustedAuthResult(...) }   (a bare `dkimDomain` is ignored)
   * policy:   { autoPause: boolean, autoUnsubscribe: boolean }
   * -> [ { type, ... } ] in the order they should be carried out                                              */
  function plan(result, message, policy) {
    policy = policy || {};
    message = message || {};
    var actions = [];
    if (!result || result.classification !== 'unexpected') {
      if (result && result.classification === 'unverified' && policy.autoUnsubscribe) {
        actions.push({ type: 'skip-unsubscribe', reason: 'Sender could not be authenticated, so its unsubscribe link is not trusted. Nothing was requested.' });
      }
      return actions;
    }

    if (policy.autoPause) {
      if (result.confidence === 'low') actions.push({ type: 'skip-pause', reason: 'Confidence is low, so the alias was left active for you to review.' });
      else actions.push({ type: 'pause-alias', accountId: result.accountId, reason: 'Unexpected sender with ' + result.confidence + ' confidence.' });
    }

    if (policy.autoUnsubscribe) {
      var u = parseListUnsubscribe(message.headers);
      var auth = Detection.isTrustedAuth(message.auth) ? message.auth : null;
      var signed = auth && auth.signedHeaders.indexOf('list-unsubscribe') !== -1 && auth.signedHeaders.indexOf('list-unsubscribe-post') !== -1;
      var aligned = auth && auth.dkim === 'pass' && auth.dkimDomain === Detection.registrableDomain(result.senderDomain || '');
      var check = u.https.length ? checkUnsubscribeUrl(u.https[0], { alignedDomain: auth ? auth.dkimDomain : '' }) : null;
      if (!auth || auth.dkim !== 'pass') {
        actions.push({ type: 'skip-unsubscribe', reason: 'No verified DKIM signature, so the unsubscribe headers cannot be trusted. Nothing was requested.' });
      } else if (!aligned) {
        actions.push({ type: 'skip-unsubscribe', reason: 'The DKIM signature is not from the sender\'s domain, so its unsubscribe link is not trusted. Nothing was requested.' });
      } else if (u.oneClick && u.https.length && !signed) {
        actions.push({ type: 'skip-unsubscribe', reason: 'The unsubscribe headers are not covered by the DKIM signature, so they may have been added in transit. Nothing was requested.' });
      } else if (u.oneClick && check && !check.ok) {
        actions.push({ type: 'skip-unsubscribe', reason: 'The unsubscribe link was refused: ' + check.reason + '. Nothing was requested.' });
      } else if (u.oneClick && check && check.ok) {
        actions.push({ type: 'one-click-unsubscribe', url: check.url, method: 'POST', body: 'List-Unsubscribe=One-Click', sender: result.senderDomain, alignedDomain: auth.dkimDomain });
      } else if (u.https.length || u.mailto.length) {
        actions.push({ type: 'manual-unsubscribe', url: u.https[0] || null, mailto: u.mailto[0] || null,
          reason: 'The sender offers an unsubscribe link but not the one-click standard, so it needs you to confirm.' });
      } else {
        actions.push({ type: 'skip-unsubscribe', reason: 'The message has no List-Unsubscribe header.' });
      }
    }
    return actions;
  }

  /* Carries out a one-click unsubscribe exactly as RFC 8058 describes: an HTTPS POST with the fixed body,
   * no cookies or other context. Cross-origin, so the response is opaque — "sent" is all we can report. */
  function unsubscribe(action, deps) {
    if (!action || action.type !== 'one-click-unsubscribe') return Promise.reject(new Error('Not a one-click https unsubscribe action'));
    var check = checkUnsubscribeUrl(action.url, { alignedDomain: action.alignedDomain });
    if (!check.ok) return Promise.reject(new Error('Unsubscribe URL refused: ' + check.reason));
    var doFetch = (deps && deps.fetch) || root.fetch;
    return doFetch(action.url, {
      method: 'POST', mode: 'no-cors', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click'
    }).then(function () { return { sent: true, status: 'requested', url: check.url }; });
  }

  var api = { parseListUnsubscribe: parseListUnsubscribe, plan: plan, unsubscribe: unsubscribe, checkUnsubscribeUrl: checkUnsubscribeUrl,
    trustedAuthResult: Detection.trustedAuthResult, isTrustedAuth: Detection.isTrustedAuth };
  root.NEARAuthResponder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
