'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Gen = require('../extension/lib/generators.js');

test('alias is unique, well-formed and non-routable', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const a = Gen.alias();
    assert.match(a, /^[a-z2-9]{10}@alias\.nearauth\.example$/);
    seen.add(a);
  }
  assert.equal(seen.size, 500);
  assert.ok(Gen.ALIAS_DOMAIN.endsWith('.example'), 'demo aliases must use the reserved .example TLD');
});

test('password has requested length and all character classes', () => {
  for (let i = 0; i < 200; i++) {
    const p = Gen.password(20);
    assert.equal(p.length, 20);
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#$%*\-_+=]/);
  }
  assert.equal(Gen.password(4).length, 12, 'minimum length is enforced');
  assert.notEqual(Gen.password(), Gen.password());
});

test('siteName derives a readable label', () => {
  assert.equal(Gen.siteName('www.novamarket.com'), 'Novamarket');
  assert.equal(Gen.siteName('pauloes-btechs.github.io'), 'Pauloes-btechs');
  assert.equal(Gen.siteName('localhost'), 'Localhost');
  assert.equal(Gen.siteName(''), 'Local test page');
});

test('manifest is valid MV3 with minimal permissions and existing files', () => {
  const dir = path.join(__dirname, '..', 'extension');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ['storage']);
  assert.equal(m.host_permissions, undefined);
  const files = [m.action.default_popup, ...m.content_scripts[0].js, ...Object.values(m.icons)];
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
});

test('content script never submits forms, stores passwords or makes network calls', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
  assert.doesNotMatch(src, /\.submit\(|requestSubmit|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.doesNotMatch(src, /saveAccount\(\{[^}]*(password|secret)\s*:/);
});

test('dashboard never invents NEAR transaction ids', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /On-chain transaction: none — SIMULATED, not broadcast/);
  assert.match(html, /name="nearauth-dashboard"/);
});
