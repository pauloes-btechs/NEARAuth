'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../extension/lib/detection.js');

const account = { id: 'a1', name: 'Nova Market', domain: 'shop.novamarket.com', alias: 'k7p92n@alias.nearauth.example' };
const dkim = (domain) => D.trustedAuthResult({ dkim: 'pass', dkimDomain: domain, verifier: 'unit-test' });
const spfPass = () => D.trustedAuthResult({ dkim: 'none', spf: 'pass', verifier: 'unit-test' });
const run = (event, history) => D.classify({ alias: account.alias, ...event }, { account, history });

test('registrableDomain handles subdomains and two-level suffixes', () => {
  assert.equal(D.registrableDomain('mail.shop.novamarket.com'), 'novamarket.com');
  assert.equal(D.registrableDomain('news.example.co.uk'), 'example.co.uk');
  assert.equal(D.registrableDomain('Example.COM.'), 'example.com');
  assert.equal(D.registrableDomain('localhost'), 'localhost');
});

test('parseSender accepts header strings and objects', () => {
  assert.deepEqual(D.parseSender('"Nova Market" <News@Novamarket.com>'), { name: 'Nova Market', address: 'news@novamarket.com' });
  assert.deepEqual(D.parseSender('plain@x.org'), { name: '', address: 'plain@x.org' });
  assert.deepEqual(D.parseSender({ address: 'A@B.io', name: 'N' }), { address: 'a@b.io', name: 'N' });
});

test('mail from the original service is expected', () => {
  const r = run({ from: 'orders@mail.novamarket.com', auth: spfPass() });
  assert.equal(r.classification, 'expected');
  assert.equal(r.isIncident, false);
});

test('ESP mail signed by the original domain is a processor, not an incident', () => {
  const r = run({ from: 'bounce@sendgrid.net', auth: dkim('novamarket.com') });
  assert.equal(r.classification, 'processor');
  assert.equal(r.confidence, 'high');
  assert.equal(r.isIncident, false);
});

test('ESP mail with a matching brand name is a probable processor', () => {
  const r = run({ from: 'Nova Market <news@mailchimp.com>', auth: spfPass() });
  assert.equal(r.classification, 'processor');
  assert.equal(r.confidence, 'medium');
});

test('look-alike domain is related with low confidence', () => {
  const r = run({ from: 'deals@novamarket-offers.net', auth: spfPass() });
  assert.equal(r.classification, 'related');
  assert.equal(r.isIncident, false);
});

test('failed authentication is unverified, never an accusation', () => {
  const r = run({ from: 'promo@bigadnetwork.com', spf: 'fail' });
  assert.equal(r.classification, 'unverified');
  assert.equal(r.isIncident, false);
});

test('authenticated unrelated organisation is an unexpected-use incident (medium)', () => {
  const r = run({ from: 'Promotions <promo@bigadnetwork.com>', auth: dkim('bigadnetwork.com') });
  assert.equal(r.classification, 'unexpected');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.isIncident, true);
  assert.ok(r.recommendedActions.length >= 3);
  assert.ok(r.evidence.some((e) => e.signal === 'authenticated'));
});

test('a second unrelated organisation raises confidence to high', () => {
  const first = run({ from: 'promo@bigadnetwork.com', auth: dkim('bigadnetwork.com') });
  const second = run({ from: 'hello@otherbroker.io', auth: spfPass() }, [first]);
  assert.equal(second.confidence, 'high');
  assert.ok(second.evidence.some((e) => e.signal === 'multiple-organisations'));
});

test('unrelated sender without authentication results stays low confidence', () => {
  const r = run({ from: 'x@unknown-sender.org' });
  assert.equal(r.classification, 'unexpected');
  assert.equal(r.confidence, 'low');
});

test('no output ever claims a sale', () => {
  const samples = [run({ from: 'promo@bigadnetwork.com', auth: dkim('bigadnetwork.com') }), run({ from: 'a@novamarket.com' }), run({ from: 'x@y.org', spf: 'fail' })];
  for (const r of samples) assert.doesNotMatch(JSON.stringify(r), /\b(sold|sale|selling)\b/i);
});

test('investigate correlates the recipient alias to an account', () => {
  const accounts = [account, { id: 'a2', name: 'Other', domain: 'other.org', alias: 'zzz@alias.nearauth.example' }];
  const r = D.investigate(accounts, { alias: 'K7P92N@alias.nearauth.example', from: 'promo@bigadnetwork.com', auth: spfPass() }, []);
  assert.equal(r.accountId, 'a1');
  assert.equal(D.investigate(accounts, { alias: 'nobody@elsewhere.com', from: 'a@b.com' }, []), null);
});

test('claimed authentication in plain input is ignored, never trusted', () => {
  const claimed = run({ from: 'Promotions <promo@bigadnetwork.com>', dkimDomain: 'bigadnetwork.com', spf: 'pass' });
  assert.equal(claimed.authenticated, false);
  assert.equal(claimed.confidence, 'low');
  assert.ok(claimed.evidence.some((e) => e.signal === 'claimed-auth-ignored'));
  const forgedObject = run({ from: 'bounce@sendgrid.net', auth: { verifier: 'me', dkim: 'pass', dkimDomain: 'novamarket.com', spf: 'pass', signedHeaders: [] } });
  assert.equal(forgedObject.authenticated, false, 'a look-alike plain object is not a trusted result');
  assert.notEqual(forgedObject.confidence, 'high');
  assert.throws(() => D.trustedAuthResult({ dkim: 'pass', verifier: 'x' }), /signing domain/);
  assert.throws(() => D.trustedAuthResult({ dkim: 'pass', dkimDomain: 'a.com' }), /verifier/);
  assert.ok(Object.isFrozen(dkim('a.com')));
});
