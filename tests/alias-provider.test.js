'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../extension/lib/alias-provider.js');

const res = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });

test('default provider is the non-routable demo provider', async () => {
  const p = P.createProvider({});
  assert.equal(p.id, 'demo');
  assert.equal(p.routable, false);
  const a = await p.create({ site: 'shop.test' });
  assert.match(a.alias, /@alias\.nearauth\.example$/);
  assert.equal(a.routable, false);
});

test('addy provider creates an alias with the documented request', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return res(201, { data: { id: 'abc-123', email: 'x9k2p@user.anonaddy.com', active: true } }); };
  const p = P.createProvider({ provider: 'addy', addy: { token: 'TEST_TOKEN', domain: 'user.anonaddy.com' } }, { fetch });
  const a = await p.create({ site: 'novamarket.com' });
  assert.deepEqual(a, { alias: 'x9k2p@user.anonaddy.com', remoteId: 'abc-123', providerId: 'addy', routable: true });
  assert.equal(calls[0].url, 'https://app.addy.io/api/v1/aliases');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TEST_TOKEN');
  assert.deepEqual(JSON.parse(calls[0].init.body), { domain: 'user.anonaddy.com', description: 'NEARAuth: novamarket.com', format: 'random_characters' });
});

test('addy provider pause / resume / remove use the documented endpoints', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push([init.method, url, init.body]); return init.method === 'POST' ? res(200, { data: {} }) : res(204); };
  const p = P.AddyProvider({ token: 't', domain: 'd.example', fetch });
  await p.pause('id 1'); await p.resume('id 1'); await p.remove('id 1');
  assert.deepEqual(calls, [
    ['DELETE', 'https://app.addy.io/api/v1/active-aliases/id%201', undefined],
    ['POST', 'https://app.addy.io/api/v1/active-aliases', '{"id":"id 1"}'],
    ['DELETE', 'https://app.addy.io/api/v1/aliases/id%201', undefined],
  ]);
});

test('addy provider maps failures to typed errors and validates config', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'http_500']]) {
    const p = P.AddyProvider({ token: 't', domain: 'd.example', fetch: async () => res(status, {}) });
    await assert.rejects(p.create({}), (e) => e.code === code);
  }
  const bad = P.AddyProvider({ token: 't', domain: 'd.example', fetch: async () => res(201, { data: {} }) });
  await assert.rejects(bad.create({}), (e) => e.code === 'bad_response');
  assert.throws(() => P.AddyProvider({ domain: 'd' }), (e) => e.code === 'missing_token');
  assert.throws(() => P.AddyProvider({ token: 't' }), (e) => e.code === 'missing_domain');
  assert.throws(() => P.AddyProvider({ token: 't', domain: 'd', baseUrl: 'http://x' }), (e) => e.code === 'insecure_url');
});
