/* NEARAuth exposure detection (Milestone C).
 *
 * Pure functions: given an inbound message's metadata and the account an alias was issued to, decide whether
 * the sender is expected, and say how sure we are and why. No message bodies are needed.
 *
 * Wording rule: the strongest thing this engine ever claims is "unexpected use". It never claims an address
 * was sold — a processor, a parent company, a breach, or a guessed address can all look identical from here.
 */
(function (root) {
  'use strict';

  // Second-level public suffixes we need to recognise without shipping the full Public Suffix List.
  var TWO_LEVEL = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
  // Email service providers that send on behalf of other organisations. Seeing one is not, by itself, a signal.
  var PROCESSORS = ['sendgrid.net', 'mailchimp.com', 'mcsv.net', 'mailgun.org', 'amazonses.com', 'sparkpostmail.com',
    'mandrillapp.com', 'postmarkapp.com', 'klaviyomail.com', 'hubspotemail.net', 'sendinblue.com', 'brevo.com',
    'constantcontact.com', 'customeriomail.com', 'salesforce.com', 'exacttarget.com', 'mailjet.com', 'rsgsv.net'];

  function registrableDomain(host) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    var parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    return parts.slice(TWO_LEVEL.test(host) ? -3 : -2).join('.');
  }

  function parseSender(from) {
    if (from && typeof from === 'object') return { address: String(from.address || '').toLowerCase(), name: String(from.name || '') };
    var m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(String(from || ''));
    return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: '', address: String(from || '').trim().toLowerCase() };
  }

  function brandTokens(account) {
    var core = registrableDomain(account.domain || '').split('.')[0] || '';
    var words = String(account.name || '').toLowerCase().split(/[^a-z0-9]+/);
    return [core, words.join('')].concat(words).filter(function (t, i, all) { return t && t.length >= 4 && all.indexOf(t) === i; });
  }

  var ACTIONS = {
    expected: ['No action needed.'],
    processor: ['No action needed. The sender is a mail service acting for the company you signed up with.'],
    related: ['Check whether this sender belongs to the same company (a brand, parent or regional site).', 'If you do not recognise it, treat it as a look-alike and do not click links.'],
    unverified: ['Do not click links: the sender could not be authenticated and may be forged.', 'No conclusion about the original company can be drawn from a message like this.'],
    unexpected: ['Pause this alias so nothing else reaches your inbox through it.', 'Create a fresh alias for the original service and update your account there.',
      'Ask the original service which partners or processors received your address.', 'Keep this event in the audit ledger as dated evidence.']
  };

  /* event:   { alias, from, dkimDomain?, spf?: 'pass'|'fail'|'none', receivedAt? }
   * context: { account: { name, domain }, history?: previous results for the same alias }                */
  function classify(event, context) {
    var account = (context && context.account) || {};
    var history = (context && context.history) || [];
    var sender = parseSender(event.from);
    var senderDomain = registrableDomain(sender.address.split('@')[1] || '');
    var accountDomain = registrableDomain(account.domain || '');
    var dkim = registrableDomain(event.dkimDomain || '');
    var authenticated = !!dkim || event.spf === 'pass';
    var tokens = brandTokens(account);
    var evidence = [];
    var out = { alias: event.alias, sender: sender.address, senderName: sender.name, senderDomain: senderDomain, accountDomain: accountDomain,
      receivedAt: event.receivedAt || null, authenticated: authenticated };

    function finish(classification, confidence, summary) {
      out.classification = classification; out.confidence = confidence; out.summary = summary;
      out.isIncident = classification === 'unexpected';
      out.evidence = evidence; out.recommendedActions = ACTIONS[classification];
      return out;
    }
    function note(signal, detail) { evidence.push({ signal: signal, detail: detail }); }

    note('alias-issued-to', 'This alias was only given to ' + (account.name || accountDomain) + ' (' + accountDomain + ').');

    if (!senderDomain) { note('no-sender', 'The message has no usable sender address.'); return finish('unverified', 'none', 'Sender could not be determined.'); }

    if (senderDomain === accountDomain) {
      note('same-domain', 'Sender domain ' + senderDomain + ' matches the service the alias was created for.');
      return finish('expected', 'high', 'Message from the service this alias belongs to.');
    }
    if (dkim && dkim === accountDomain) {
      note('dkim-aligned', 'Sent through ' + senderDomain + ' but cryptographically signed (DKIM) by ' + accountDomain + '.');
      return finish('processor', 'high', 'Sent by a mail provider on behalf of the original service.');
    }

    var isProcessor = PROCESSORS.indexOf(senderDomain) !== -1;
    var haystack = (senderDomain + ' ' + sender.name).toLowerCase().replace(/[^a-z0-9 .-]/g, '');
    var brandHit = tokens.filter(function (t) { return haystack.replace(/[ .-]/g, '').indexOf(t) !== -1; })[0];

    if (isProcessor && brandHit) {
      note('known-processor', senderDomain + ' is a bulk mail provider and the sender name references "' + brandHit + '".');
      return finish('processor', 'medium', 'Probably the original service using a mail provider.');
    }
    if (!authenticated && event.spf === 'fail') {
      note('auth-failed', 'SPF failed and there is no DKIM signature, so the sender address may be forged.');
      return finish('unverified', 'low', 'Unauthenticated message; the visible sender cannot be trusted.');
    }
    if (brandHit) {
      note('brand-similarity', 'Sender "' + (sender.name || senderDomain) + '" references "' + brandHit + '" but uses a different domain (' + senderDomain + ').');
      return finish('related', 'low', 'Possibly the same company under another domain, or a look-alike.');
    }

    note('different-organisation', 'Sender domain ' + senderDomain + ' has no relationship we can establish with ' + accountDomain + '.');
    if (isProcessor) note('known-processor', senderDomain + ' is a bulk mail provider, so the real sender is someone using it.');
    var priorOrgs = history.filter(function (h) { return h.classification === 'unexpected' && h.senderDomain !== senderDomain; })
      .map(function (h) { return h.senderDomain; }).filter(function (d, i, a) { return a.indexOf(d) === i; });
    var repeat = history.filter(function (h) { return h.classification === 'unexpected' && h.senderDomain === senderDomain; }).length;

    if (!authenticated) {
      note('not-authenticated', 'No SPF/DKIM result is available, so the sender identity is unconfirmed.');
      return finish('unexpected', 'low', 'Unexpected sender, identity unconfirmed.');
    }
    note('authenticated', 'The message passed sender authentication (' + (dkim ? 'DKIM ' + dkim : 'SPF') + '), so it really came from ' + (dkim || senderDomain) + '.');
    if (repeat) note('repeat-sender', 'This sender has used the alias ' + repeat + ' time(s) before.');
    if (priorOrgs.length) {
      note('multiple-organisations', 'Other unrelated senders have already used this alias: ' + priorOrgs.join(', ') + '.');
      return finish('unexpected', 'high', 'Several unrelated organisations are using an address only one company was given.');
    }
    return finish('unexpected', 'medium', 'An unrelated organisation is using an address only one company was given.');
  }

  /* Account-to-alias correlation: which account does an inbound recipient address belong to? */
  function correlate(accounts, recipient) {
    var r = String(recipient || '').trim().toLowerCase();
    return (accounts || []).find(function (a) { return String(a.alias).toLowerCase() === r; }) || null;
  }

  /* Full pipeline for one inbound event. Returns null when the recipient is not one of our aliases. */
  function investigate(accounts, event, history) {
    var account = correlate(accounts, event.alias);
    if (!account) return null;
    var prior = (history || []).filter(function (h) { return String(h.alias).toLowerCase() === String(account.alias).toLowerCase(); });
    var result = classify(event, { account: account, history: prior });
    result.accountId = account.id; result.accountName = account.name;
    return result;
  }

  var api = { registrableDomain: registrableDomain, parseSender: parseSender, classify: classify, correlate: correlate, investigate: investigate, PROCESSORS: PROCESSORS };
  root.NEARAuthDetection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
