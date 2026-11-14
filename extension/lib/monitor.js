/* NEARAuth sender monitor.
 *
 * Works from sender METADATA only: for each alias, the alias provider reports which addresses have written to it.
 * No message content, no headers, and never the user's real mailbox or address.
 *
 * For every sender not seen before, run the detection engine; if the sender is an unexpected third party and
 * auto-block is on, ask the provider to block that one sender on that one alias. Everything else keeps flowing.
 */
(function (root) {
  'use strict';
  var Detection = root.NEARAuthDetection || (typeof require !== 'undefined' ? require('./detection.js') : null);

  /* opts: { accounts, provider, seen: { "<remoteId>:<senderId>": true }, history: [results], autoBlock: boolean, now?: () => Date }
   * -> { events: [new results, oldest first], seen: updated map, errors: [{ alias, message }] }                       */
  function scan(opts) {
    var provider = opts.provider, seen = Object.assign({}, opts.seen || {}), history = (opts.history || []).slice();
    var now = opts.now || function () { return new Date(); };
    var events = [], errors = [];
    if (!provider || typeof provider.senders !== 'function') return Promise.resolve({ events: events, seen: seen, errors: errors, unsupported: true });

    var accounts = (opts.accounts || []).filter(function (a) { return a.providerId === provider.id && a.remoteId !== null && a.remoteId !== undefined; });
    return accounts.reduce(function (chain, account) {
      return chain.then(function () { return provider.senders(account.remoteId); }).then(function (senders) {
        return senders.reduce(function (inner, sender) {
          var key = account.remoteId + ':' + sender.id;
          if (seen[key] || !sender.address) return inner;
          return inner.then(function () {
            var prior = history.filter(function (h) { return h.alias === account.alias; });
            var result = Detection.classify({ alias: account.alias, from: sender.address, receivedAt: now().toISOString() }, { account: account, history: prior });
            result.id = key; result.accountId = account.id; result.accountName = account.name;
            result.source = provider.id; result.senderId = sender.id; result.remoteId = account.remoteId;
            result.action = sender.blocked ? 'already-blocked' : 'none';
            var done = Promise.resolve();
            if (opts.autoBlock && result.classification === 'unexpected' && !sender.blocked) {
              done = provider.blockSender(sender).then(function () { result.action = 'blocked'; },
                function (e) { result.action = 'block-failed'; result.actionError = e.message; });
            }
            return done.then(function () { seen[key] = true; history.push(result); events.push(result); });
          });
        }, Promise.resolve());
      }).catch(function (e) { errors.push({ alias: account.alias, message: e.message, code: e.code }); });
    }, Promise.resolve()).then(function () { return { events: events, seen: seen, errors: errors }; });
  }

  var api = { scan: scan };
  root.NEARAuthMonitor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
