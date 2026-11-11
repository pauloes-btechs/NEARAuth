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

  /* settings: { provider: 'demo' | 'addy', addy: { token, domain, format } } */
  function createProvider(settings, deps) {
    settings = settings || {};
    if (settings.provider === 'addy') {
      var a = settings.addy || {};
      return AddyProvider({ token: a.token, domain: a.domain, format: a.format, fetch: deps && deps.fetch });
    }
    return DemoProvider();
  }

  var api = { DemoProvider: DemoProvider, AddyProvider: AddyProvider, createProvider: createProvider, PROVIDER_ORIGINS: { addy: 'https://app.addy.io/*' } };
  root.NEARAuthProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
