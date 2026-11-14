'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../extension/lib/responder.js');

const ONE_CLICK = { 'List-Unsubscribe': '<https://news.ads.example/u/abc?x=1>, <mailto:unsub@ads.example?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
const unexpected = (confidence = 'medium') => ({ classification: 'unexpected', confidence, accountId: 'a1', senderDomain: 'ads.example' });
const all = { autoPause: true, autoUnsubscribe: true };

test('parses List-Unsubscribe headers case-insensitively, with folding, ignoring http and junk', () => {
  assert.deepEqual(R.parseListUnsubscribe(ONE_CLICK), { https: ['https://news.ads.example/u/abc?x=1'], mailto: ['unsub@ads.example'], oneClick: true });
  assert.deepEqual(R.parseListUnsubscribe({ 'list-unsubscribe': '<http://insecure.example/u>,\r\n <https://ok.example/u>, <javascript:alert(1)>' }),
    { https: ['https://ok.example/u'], mailto: [], oneClick: false });
  assert.deepEqual(R.parseListUnsubscribe({}), { https: [], mailto: [], oneClick: false });
  assert.equal(R.parseListUnsubscribe({ 'List-Unsubscribe': '<https://a.example/u>', 'List-Unsubscribe-Post': 'something-else' }).oneClick, false);
});

test('authenticated unexpected sender with one-click headers: pause, then one-click unsubscribe', () => {
  const actions = R.plan(unexpected(), { headers: ONE_CLICK, dkimDomain: 'ads.example' }, all);
  assert.deepEqual(actions.map((a) => a.type), ['pause-alias', 'one-click-unsubscribe']);
  assert.deepEqual(actions[1], { type: 'one-click-unsubscribe', url: 'https://news.ads.example/u/abc?x=1', method: 'POST', body: 'List-Unsubscribe=One-Click', sender: 'ads.example' });
});

test('never unsubscribes without DKIM, without the one-click header, or from forged mail', () => {
  assert.deepEqual(R.plan(unexpected(), { headers: ONE_CLICK }, all).map((a) => a.type), ['pause-alias', 'skip-unsubscribe']);
  const mailtoOnly = { 'List-Unsubscribe': '<mailto:unsub@ads.example>' };
  assert.deepEqual(R.plan(unexpected(), { headers: mailtoOnly, dkimDomain: 'ads.example' }, all).map((a) => a.type), ['pause-alias', 'manual-unsubscribe']);
  assert.deepEqual(R.plan(unexpected(), { headers: {}, dkimDomain: 'ads.example' }, all).map((a) => a.type), ['pause-alias', 'skip-unsubscribe']);
  assert.deepEqual(R.plan({ classification: 'unverified', confidence: 'low' }, { headers: ONE_CLICK }, all).map((a) => a.type), ['skip-unsubscribe']);
});

test('never acts on the original service, its mail provider, or related senders', () => {
  for (const classification of ['expected', 'processor', 'related']) {
    assert.deepEqual(R.plan({ classification, confidence: 'high' }, { headers: ONE_CLICK, dkimDomain: 'x.example' }, all), []);
  }
  assert.deepEqual(R.plan(null, {}, all), []);
});

test('policy switches are respected and low confidence does not auto-pause', () => {
  const msg = { headers: ONE_CLICK, dkimDomain: 'ads.example' };
  assert.deepEqual(R.plan(unexpected(), msg, {}), []);
  assert.deepEqual(R.plan(unexpected(), msg, { autoPause: true }).map((a) => a.type), ['pause-alias']);
  assert.deepEqual(R.plan(unexpected(), msg, { autoUnsubscribe: true }).map((a) => a.type), ['one-click-unsubscribe']);
  assert.deepEqual(R.plan(unexpected('low'), msg, { autoPause: true }).map((a) => a.type), ['skip-pause']);
});

test('unsubscribe sends the RFC 8058 request with no cookies or referrer, and refuses anything else', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return {}; };
  const [, action] = R.plan(unexpected(), { headers: ONE_CLICK, dkimDomain: 'ads.example' }, all);
  assert.deepEqual(await R.unsubscribe(action, { fetch }), { sent: true, url: 'https://news.ads.example/u/abc?x=1' });
  assert.deepEqual(calls[0].init, { method: 'POST', mode: 'no-cors', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  await assert.rejects(R.unsubscribe({ type: 'manual-unsubscribe', url: 'https://x.example' }, { fetch }));
  await assert.rejects(R.unsubscribe({ type: 'one-click-unsubscribe', url: 'http://x.example' }, { fetch }));
  assert.equal(calls.length, 1);
});
