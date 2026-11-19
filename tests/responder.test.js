'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../extension/lib/responder.js');

const ONE_CLICK = { 'List-Unsubscribe': '<https://news.ads-network.com/u/abc?x=1>, <mailto:unsub@ads-network.com?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
const SIGNED = ['from', 'list-unsubscribe', 'list-unsubscribe-post'];
const verified = (domain = 'ads-network.com', signedHeaders = SIGNED) => R.trustedAuthResult({ dkim: 'pass', dkimDomain: domain, signedHeaders, verifier: 'unit-test' });
const unexpected = (confidence = 'medium') => ({ classification: 'unexpected', confidence, accountId: 'a1', senderDomain: 'ads-network.com' });
const all = { autoPause: true, autoUnsubscribe: true };
const types = (actions) => actions.map((a) => a.type);

test('parses List-Unsubscribe headers case-insensitively, with folding, ignoring http and junk', () => {
  assert.deepEqual(R.parseListUnsubscribe(ONE_CLICK), { https: ['https://news.ads-network.com/u/abc?x=1'], mailto: ['unsub@ads-network.com'], oneClick: true });
  assert.deepEqual(R.parseListUnsubscribe({ 'list-unsubscribe': '<http://insecure.example/u>,\r\n <https://ok.example/u>, <javascript:alert(1)>' }),
    { https: ['https://ok.example/u'], mailto: [], oneClick: false });
  assert.deepEqual(R.parseListUnsubscribe({}), { https: [], mailto: [], oneClick: false });
  assert.equal(R.parseListUnsubscribe({ 'List-Unsubscribe': '<https://a.example/u>', 'List-Unsubscribe-Post': 'something-else' }).oneClick, false);
});

test('verified, aligned, signed one-click headers: pause, then one-click unsubscribe', () => {
  const actions = R.plan(unexpected(), { headers: ONE_CLICK, auth: verified() }, all);
  assert.deepEqual(types(actions), ['pause-alias', 'one-click-unsubscribe']);
  assert.deepEqual(actions[1], { type: 'one-click-unsubscribe', url: 'https://news.ads-network.com/u/abc?x=1', method: 'POST', body: 'List-Unsubscribe=One-Click', sender: 'ads-network.com', alignedDomain: 'ads-network.com' });
});

test('a dkimDomain string or look-alike object is a claim, not a verification', () => {
  assert.deepEqual(types(R.plan(unexpected(), { headers: ONE_CLICK, dkimDomain: 'ads-network.com' }, all)), ['pause-alias', 'skip-unsubscribe']);
  const lookalike = { verifier: 'x', dkim: 'pass', dkimDomain: 'ads-network.com', signedHeaders: SIGNED };
  assert.deepEqual(types(R.plan(unexpected(), { headers: ONE_CLICK, auth: lookalike }, all)), ['pause-alias', 'skip-unsubscribe']);
  assert.equal(R.isTrustedAuth(lookalike), false);
  assert.equal(R.isTrustedAuth(verified()), true);
});

test('never unsubscribes when the signature is misaligned, does not cover the headers, or failed', () => {
  const plan = (auth) => R.plan(unexpected(), { headers: ONE_CLICK, auth }, { autoUnsubscribe: true });
  assert.match(plan(verified('other-esp.com'))[0].reason, /not from the sender/);
  assert.match(plan(verified('ads-network.com', ['from']))[0].reason, /not covered by the DKIM signature/);
  assert.equal(plan(R.trustedAuthResult({ dkim: 'fail', verifier: 't' }))[0].type, 'skip-unsubscribe');
  assert.equal(plan(undefined)[0].type, 'skip-unsubscribe');
});

test('mailto-only or missing headers never become an automatic request', () => {
  const auth = verified();
  assert.deepEqual(types(R.plan(unexpected(), { headers: { 'List-Unsubscribe': '<mailto:unsub@ads-network.com>' }, auth }, all)), ['pause-alias', 'manual-unsubscribe']);
  assert.deepEqual(types(R.plan(unexpected(), { headers: {}, auth }, all)), ['pause-alias', 'skip-unsubscribe']);
  assert.deepEqual(types(R.plan({ classification: 'unverified', confidence: 'low' }, { headers: ONE_CLICK }, all)), ['skip-unsubscribe']);
});

test('never acts on the original service, its mail provider, or related senders', () => {
  for (const classification of ['expected', 'processor', 'related']) {
    assert.deepEqual(R.plan({ classification, confidence: 'high' }, { headers: ONE_CLICK, auth: verified() }, all), []);
  }
  assert.deepEqual(R.plan(null, {}, all), []);
});

test('policy switches are respected and low confidence does not auto-pause', () => {
  const msg = { headers: ONE_CLICK, auth: verified() };
  assert.deepEqual(R.plan(unexpected(), msg, {}), []);
  assert.deepEqual(types(R.plan(unexpected(), msg, { autoPause: true })), ['pause-alias']);
  assert.deepEqual(types(R.plan(unexpected(), msg, { autoUnsubscribe: true })), ['one-click-unsubscribe']);
  assert.deepEqual(types(R.plan(unexpected('low'), msg, { autoPause: true })), ['skip-pause']);
});

test('checkUnsubscribeUrl refuses SSRF-shaped and misaligned URLs', () => {
  const ok = (u) => R.checkUnsubscribeUrl(u, { alignedDomain: 'ads-network.com' });
  assert.equal(ok('https://news.ads-network.com/u/1').ok, true);
  for (const bad of ['http://ads-network.com/u', 'https://user:pw@ads-network.com/u', 'https://ads-network.com:8443/u', 'https://127.0.0.1/u',
    'https://[::1]/u', 'https://2130706433/u', 'https://0x7f000001/u', 'https://localhost/u', 'https://unsub.internal/u', 'https://printer.local/u',
    'https://evil.example/u', 'https://ads-network.com.evil.net/u', 'https://other.com/u', 'javascript:alert(1)', 'https://' + 'a'.repeat(2100) + '.com/']) {
    assert.equal(ok(bad).ok, false, bad);
  }
  assert.equal(R.checkUnsubscribeUrl('https://news.ads-network.com/u', { alignedDomain: '' }).ok, false, 'no aligned domain → refuse');
});

test('unsubscribe sends the RFC 8058 request with no cookies or referrer, reports "requested", and rechecks the URL', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return {}; };
  const [, action] = R.plan(unexpected(), { headers: ONE_CLICK, auth: verified() }, all);
  assert.deepEqual(await R.unsubscribe(action, { fetch }), { sent: true, status: 'requested', url: 'https://news.ads-network.com/u/abc?x=1' });
  assert.deepEqual(calls[0].init, { method: 'POST', mode: 'no-cors', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  await assert.rejects(R.unsubscribe({ type: 'manual-unsubscribe', url: 'https://x.example' }, { fetch }));
  await assert.rejects(R.unsubscribe({ ...action, url: 'https://169.254.169.254/latest/meta-data' }, { fetch }), /refused/);
  await assert.rejects(R.unsubscribe({ ...action, alignedDomain: 'elsewhere.com' }, { fetch }), /refused/);
  assert.equal(calls.length, 1);
});
