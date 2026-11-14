'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../extension/lib/alias-provider.js');
const M = require('../extension/lib/monitor.js');

const res = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });

/* Minimal in-memory SimpleLogin: enough of the documented API to exercise the provider end to end. */
function fakeSimpleLogin() {
  const db = { aliases: { 7: { id: 7, email: 'calm.fox@simplelogin.com', enabled: true } }, contacts: { 7: [] }, calls: [], nextContact: 100 };
  db.receive = (aliasId, address, blocked = false) => db.contacts[aliasId].push({ id: db.nextContact++, contact: address, block_forward: blocked, creation_timestamp: 1 });
  db.fetch = async (url, init) => {
    const u = new URL(url); db.calls.push(init.method + ' ' + u.pathname + u.search);
    if (init.headers.Authentication !== 'KEY') return res(401, { error: 'Wrong api key' });
    let m;
    if (init.method === 'POST' && u.pathname === '/api/alias/random/new') { const a = { id: 8, email: 'new.alias@simplelogin.com', enabled: true, note: JSON.parse(init.body).note }; db.aliases[8] = a; db.contacts[8] = []; return res(201, a); }
    if ((m = /^\/api\/aliases\/(\d+)$/.exec(u.pathname)) && init.method === 'GET') return db.aliases[m[1]] ? res(200, db.aliases[m[1]]) : res(404, {});
    if ((m = /^\/api\/aliases\/(\d+)\/toggle$/.exec(u.pathname))) { const a = db.aliases[m[1]]; a.enabled = !a.enabled; return res(200, { enabled: a.enabled }); }
    if ((m = /^\/api\/aliases\/(\d+)\/contacts$/.exec(u.pathname))) return res(200, { contacts: db.contacts[m[1]] });
    if ((m = /^\/api\/contacts\/(\d+)\/toggle$/.exec(u.pathname))) { const c = Object.values(db.contacts).flat().find((x) => x.id === Number(m[1])); c.block_forward = !c.block_forward; return res(200, { block_forward: c.block_forward }); }
    if ((m = /^\/api\/aliases\/(\d+)$/.exec(u.pathname)) && init.method === 'DELETE') { delete db.aliases[m[1]]; return res(200, { deleted: true }); }
    return res(404, {});
  };
  return db;
}
const provider = (db, token = 'KEY') => P.createProvider({ provider: 'simplelogin', simplelogin: { token } }, { fetch: db.fetch });
const account = { id: 'acc1', name: 'Nova Market', domain: 'novamarket.com', alias: 'calm.fox@simplelogin.com', providerId: 'simplelogin', remoteId: 7 };

test('creates an alias with the documented request', async () => {
  const db = fakeSimpleLogin();
  const a = await provider(db).create({ site: 'shop.example.org' });
  assert.deepEqual(a, { alias: 'new.alias@simplelogin.com', remoteId: 8, providerId: 'simplelogin', routable: true });
  assert.equal(db.calls[0], 'POST /api/alias/random/new?hostname=shop.example.org');
  assert.equal(db.aliases[8].note, 'NEARAuth: shop.example.org');
});

test('pause and resume are idempotent even though the API only offers a flip', async () => {
  const db = fakeSimpleLogin(), p = provider(db);
  await p.pause(7); assert.equal(db.aliases[7].enabled, false);
  await p.pause(7); assert.equal(db.aliases[7].enabled, false, 'second pause must not re-enable');
  await p.resume(7); await p.resume(7); assert.equal(db.aliases[7].enabled, true);
  assert.equal(db.calls.filter((c) => c.endsWith('/toggle')).length, 2);
});

test('lists senders and blocks exactly one, idempotently', async () => {
  const db = fakeSimpleLogin(), p = provider(db);
  db.receive(7, 'News@NovaMarket.com'); db.receive(7, 'promo@bigadnetwork.com');
  const senders = await p.senders(7);
  assert.deepEqual(senders.map((s) => [s.address, s.blocked]), [['news@novamarket.com', false], ['promo@bigadnetwork.com', false]]);
  await p.blockSender(senders[1]);
  assert.deepEqual(db.contacts[7].map((c) => c.block_forward), [false, true]);
  await p.blockSender((await p.senders(7))[1]); // already blocked: no flip back
  assert.equal(db.contacts[7][1].block_forward, true);
  await p.unblockSender((await p.senders(7))[1]);
  assert.equal(db.contacts[7][1].block_forward, false);
});

test('errors are typed and config is validated', async () => {
  const db = fakeSimpleLogin();
  await assert.rejects(provider(db, 'WRONG').create({ site: 'x.com' }), (e) => e.code === 'unauthorized');
  assert.throws(() => P.SimpleLoginProvider({}), (e) => e.code === 'missing_token');
  assert.throws(() => P.SimpleLoginProvider({ token: 't', baseUrl: 'http://evil.example' }), (e) => e.code === 'insecure_url');
  assert.doesNotThrow(() => P.SimpleLoginProvider({ token: 't', baseUrl: 'http://localhost:9099' }));
});

test('monitor flags unexpected senders, leaves the original service alone, and only blocks when asked', async () => {
  const db = fakeSimpleLogin(), p = provider(db);
  db.receive(7, 'orders@mail.novamarket.com'); db.receive(7, 'promo@bigadnetwork.com');
  const off = await M.scan({ accounts: [account], provider: p, autoBlock: false });
  assert.deepEqual(off.events.map((e) => [e.sender, e.classification, e.action]), [['orders@mail.novamarket.com', 'expected', 'none'], ['promo@bigadnetwork.com', 'unexpected', 'none']]);
  assert.deepEqual(db.contacts[7].map((c) => c.block_forward), [false, false]);

  const on = await M.scan({ accounts: [account], provider: p, autoBlock: true });
  assert.deepEqual(on.events.map((e) => e.action), ['none', 'blocked']);
  assert.deepEqual(db.contacts[7].map((c) => c.block_forward), [false, true], 'only the third party is blocked');
});

test('monitor reports each sender once, raises confidence history-wise, and survives provider errors', async () => {
  const db = fakeSimpleLogin(), p = provider(db);
  db.receive(7, 'promo@bigadnetwork.com');
  const first = await M.scan({ accounts: [account], provider: p, autoBlock: true });
  assert.equal(first.events.length, 1);
  const again = await M.scan({ accounts: [account], provider: p, autoBlock: true, seen: first.seen, history: first.events });
  assert.equal(again.events.length, 0, 'nothing new');
  db.receive(7, 'hello@otherbroker.io');
  const third = await M.scan({ accounts: [account], provider: p, autoBlock: true, seen: again.seen, history: first.events });
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].sender, 'hello@otherbroker.io');
  assert.equal(third.events[0].action, 'blocked');

  const broken = await M.scan({ accounts: [account, { ...account, id: 'acc2', alias: 'gone@simplelogin.com', remoteId: 99 }], provider: p, seen: third.seen });
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.errors[0].alias, 'gone@simplelogin.com');
  assert.equal((await M.scan({ accounts: [account], provider: P.DemoProvider() })).unsupported, true);
  assert.equal((await M.scan({ accounts: [{ ...account, providerId: 'demo' }], provider: p })).events.length, 0, 'only this provider\'s aliases are scanned');
});
