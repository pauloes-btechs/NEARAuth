/* NEARAuth alias providers (Milestone A).
 *
 * Alias generation is separated from the forwarding backend through one small contract:
 *
 *   provider.id          string
 *   provider.routable    boolean — true only if aliases can really receive mail
 *   provider.create({ site, description }) -> Promise<{ alias, remoteId, providerId, routable }>
 *   provider.pause(remoteId) / provider.resume(remoteId) / provider.remove(remoteId) -> Promise<void>
 *
 * DemoProvider  — offline, non-routable `.example` aliases (default).
 * AddyProvider  — real forwarding aliases through the addy.io REST API (open-source service, user supplies
 *                 their own API token and domain). Network calls happen only from the background worker.
 */
(function (root) {
  'use strict';
  var Gen = root.NEARAuthGen || (typeof require !== 'undefined' ? require('./generators.js') : null);

  function ProviderError(message, code) {
    var e = new Error(message);
    e.name = 'ProviderError';
    e.code = code || 'provider_error';
    return e;
  }

  function DemoProvider() {
    return {
      id: 'demo',
      label: 'Demo (non-routable .example aliases)',
      routable: false,
      create: function () {
        return Promise.resolve({ alias: Gen.alias(), remoteId: null, providerId: 'demo', routable: false });
      },
      pause: function () { return Promise.resolve(); },
      resume: function () { return Promise.resolve(); },
      remove: function () { return Promise.resolve(); }
    };
  }

  /* addy.io — API reference: https://app.addy.io/docs/
   * POST   /api/v1/aliases            { domain, description, format }  -> 201 { data: { id, email, active, ... } }
   * DELETE /api/v1/active-aliases/:id                                  -> 204   (deactivate)
   * POST   /api/v1/active-aliases     { id }                           -> 200   (activate)
   * DELETE /api/v1/aliases/:id                                         -> 204   (delete)                     */
  function AddyProvider(config) {
    config = config || {};
    var base = (config.baseUrl || 'https://app.addy.io').replace(/\/+$/, '');
    var doFetch = config.fetch || root.fetch;
    if (!config.token) throw ProviderError('addy.io API token is required', 'missing_token');
    if (!config.domain) throw ProviderError('addy.io alias domain is required', 'missing_domain');
    if (!/^https:\/\//.test(base)) throw ProviderError('Provider base URL must use https', 'insecure_url');

    function call(method, path, body) {
      return doFetch(base + path, {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + config.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        if (res.status === 401) throw ProviderError('addy.io rejected the API token', 'unauthorized');
        if (res.status === 403) throw ProviderError('addy.io refused the request (plan limit or permissions)', 'forbidden');
        if (res.status === 429) throw ProviderError('addy.io rate limit reached', 'rate_limited');
        if (!res.ok) throw ProviderError('addy.io request failed with HTTP ' + res.status, 'http_' + res.status);
        return res.status === 204 ? null : res.json();
      });
    }

    return {
      id: 'addy',
      label: 'addy.io (' + config.domain + ')',
      routable: true,
      create: function (opts) {
        opts = opts || {};
        var description = String(opts.description || ('NEARAuth: ' + (opts.site || 'unknown site'))).slice(0, 200);
        return call('POST', '/api/v1/aliases', { domain: config.domain, description: description, format: config.format || 'random_characters' })
          .then(function (json) {
            var d = json && json.data;
            if (!d || !d.email || !d.id) throw ProviderError('addy.io returned an unexpected response', 'bad_response');
            return { alias: d.email, remoteId: d.id, providerId: 'addy', routable: true };
          });
      },
      pause: function (remoteId) { return call('DELETE', '/api/v1/active-aliases/' + encodeURIComponent(remoteId)).then(function () {}); },
      resume: function (remoteId) { return call('POST', '/api/v1/active-aliases', { id: remoteId }).then(function () {}); },
      remove: function (remoteId) { return call('DELETE', '/api/v1/aliases/' + encodeURIComponent(remoteId)).then(function () {}); }
    };
  }

  /* SimpleLogin — API reference: https://github.com/simple-login/app/blob/master/docs/api.md
   * Auth header:  Authentication: <api key>
   * POST   /api/alias/random/new?hostname=<site>   { note }   -> 201 { id, email, enabled, ... }
   * GET    /api/aliases/:id                                    -> { id, email, enabled, ... }
   * POST   /api/aliases/:id/toggle                             -> { enabled }          (a flip, not a set)
   * DELETE /api/aliases/:id
   * GET    /api/aliases/:id/contacts?page_id=0                 -> { contacts: [{ id, contact, block_forward, ... }] }
   * POST   /api/contacts/:id/toggle                            -> { block_forward }    (a flip, not a set)   */
  function SimpleLoginProvider(config) {
    config = config || {};
    var base = (config.baseUrl || 'https://app.simplelogin.io').replace(/\/+$/, '');
    var doFetch = config.fetch || root.fetch;
    if (!config.token) throw ProviderError('SimpleLogin API key is required', 'missing_token');
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw ProviderError('Provider base URL must use https', 'insecure_url');

    function call(method, path, body) {
      return doFetch(base + path, {
        method: method,
        headers: { 'Authentication': config.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        if (res.status === 401) throw ProviderError('SimpleLogin rejected the API key', 'unauthorized');
        if (res.status === 403) throw ProviderError('SimpleLogin refused the request (plan limit or permissions)', 'forbidden');
        if (res.status === 429) throw ProviderError('SimpleLogin rate limit reached', 'rate_limited');
        if (!res.ok) throw ProviderError('SimpleLogin request failed with HTTP ' + res.status, 'http_' + res.status);
        return res.json().catch(function () { return null; });
      });
    }
    var id = function (v) { return encodeURIComponent(v); };

    // Toggle endpoints flip the current value, so read first and only flip when needed.
    function setEnabled(remoteId, want) {
      return call('GET', '/api/aliases/' + id(remoteId)).then(function (alias) {
        if (!alias || typeof alias.enabled !== 'boolean') throw ProviderError('SimpleLogin returned an unexpected response', 'bad_response');
        if (alias.enabled === want) return;
        return call('POST', '/api/aliases/' + id(remoteId) + '/toggle').then(function (r) {
          if (!r || r.enabled !== want) throw ProviderError('SimpleLogin did not apply the change', 'bad_response');
        });
      });
    }

    return {
      id: 'simplelogin',
      label: 'SimpleLogin',
      routable: true,
      create: function (opts) {
        opts = opts || {};
        var q = opts.site ? '?hostname=' + encodeURIComponent(opts.site) : '';
        var note = String(opts.description || ('NEARAuth: ' + (opts.site || 'unknown site'))).slice(0, 200);
        return call('POST', '/api/alias/random/new' + q, { note: note }).then(function (a) {
          if (!a || !a.email || a.id === undefined) throw ProviderError('SimpleLogin returned an unexpected response', 'bad_response');
          return { alias: a.email, remoteId: a.id, providerId: 'simplelogin', routable: true };
        });
      },
      pause: function (remoteId) { return setEnabled(remoteId, false); },
      resume: function (remoteId) { return setEnabled(remoteId, true); },
      remove: function (remoteId) { return call('DELETE', '/api/aliases/' + id(remoteId)).then(function () {}); },
      /* Senders that have written to this alias: [{ id, address, blocked, lastSeen }] (first page, newest 20). */
      senders: function (remoteId) {
        return call('GET', '/api/aliases/' + id(remoteId) + '/contacts?page_id=0').then(function (r) {
          if (!r || !Array.isArray(r.contacts)) throw ProviderError('SimpleLogin returned an unexpected response', 'bad_response');
          return r.contacts.map(function (c) {
            return { id: c.id, address: String(c.contact || '').toLowerCase(), blocked: !!c.block_forward, lastSeen: c.last_email_sent_timestamp || c.creation_timestamp || null };
          });
        });
      },
      /* Stop one sender reaching this alias; everyone else is unaffected. `sender` comes from senders(). */
      blockSender: function (sender) {
        if (sender.blocked) return Promise.resolve();
        return call('POST', '/api/contacts/' + id(sender.id) + '/toggle').then(function (r) {
          if (r && r.block_forward === true) return;
          // Flipped the wrong way (it was already blocked elsewhere): flip back and report.
          return call('POST', '/api/contacts/' + id(sender.id) + '/toggle').then(function () { throw ProviderError('SimpleLogin did not apply the block', 'bad_response'); });
        });
      },
      unblockSender: function (sender) {
        return call('POST', '/api/contacts/' + id(sender.id) + '/toggle').then(function (r) {
          if (r && r.block_forward === false) return;
          return call('POST', '/api/contacts/' + id(sender.id) + '/toggle').then(function () { throw ProviderError('SimpleLogin did not apply the unblock', 'bad_response'); });
        });
      }
    };
  }

  /* settings: { provider: 'demo' | 'addy' | 'simplelogin', addy: { token, domain, format }, simplelogin: { token, baseUrl? } } */
  function createProvider(settings, deps) {
    settings = settings || {};
    if (settings.provider === 'addy') {
      var a = settings.addy || {};
      return AddyProvider({ token: a.token, domain: a.domain, format: a.format, fetch: deps && deps.fetch });
    }
    if (settings.provider === 'simplelogin') {
      var sl = settings.simplelogin || {};
      return SimpleLoginProvider({ token: sl.token, baseUrl: sl.baseUrl, fetch: deps && deps.fetch });
    }
    return DemoProvider();
  }

  var api = { DemoProvider: DemoProvider, AddyProvider: AddyProvider, SimpleLoginProvider: SimpleLoginProvider, createProvider: createProvider,
    PROVIDER_ORIGINS: { addy: 'https://app.addy.io/*', simplelogin: 'https://app.simplelogin.io/*' } };
  root.NEARAuthProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
