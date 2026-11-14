/* NEARAuth automatic response (Milestone C follow-up).
 *
 * Decides what to do when the detection engine flags an inbound message, and can carry out a standards-based
 * one-click unsubscribe (RFC 8058).
 *
 * Safety rules — unsubscribing is only automated when ALL of these hold:
 *   1. the message was classified `unexpected` (never for the original service or its mail provider);
 *   2. it carries a DKIM signature (RFC 8058 requires the List-Unsubscribe headers to be DKIM-covered);
 *   3. it advertises `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an https:// unsubscribe URL.
 * Otherwise nothing is requested: following arbitrary unsubscribe links in unauthenticated or forged mail
 * confirms the address to the sender and can be dangerous. Pausing the alias stops the mail regardless of
 * whether the sender honours an unsubscribe.
 */
(function (root) {
  'use strict';

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
   * message:  { headers, dkimDomain }
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
      if (!message.dkimDomain) {
        actions.push({ type: 'skip-unsubscribe', reason: 'No DKIM signature, so the unsubscribe headers cannot be trusted. Nothing was requested.' });
      } else if (u.oneClick && u.https.length) {
        actions.push({ type: 'one-click-unsubscribe', url: u.https[0], method: 'POST', body: 'List-Unsubscribe=One-Click', sender: result.senderDomain });
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
    if (!action || action.type !== 'one-click-unsubscribe' || !/^https:\/\//i.test(action.url)) {
      return Promise.reject(new Error('Not a one-click https unsubscribe action'));
    }
    var doFetch = (deps && deps.fetch) || root.fetch;
    return doFetch(action.url, {
      method: 'POST', mode: 'no-cors', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click'
    }).then(function () { return { sent: true, url: action.url }; });
  }

  var api = { parseListUnsubscribe: parseListUnsubscribe, plan: plan, unsubscribe: unsubscribe };
  root.NEARAuthResponder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
