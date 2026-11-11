/* NEARAuth background service worker.
 * The only place that talks to an alias provider over the network; content scripts just send messages. */
'use strict';
importScripts('lib/generators.js', 'lib/alias-provider.js', 'lib/vault.js');

const SETTINGS_KEY = 'nearauth_settings_v1';

async function getSettings() {
  return (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || { provider: 'demo' };
}

/* ---------- Credential vault ----------
 * Ciphertext lives in chrome.storage.local. The derived key lives only in chrome.storage.session
 * (memory-only, cleared when the browser closes, not readable by content scripts) and expires after 15 minutes idle. */
const VAULT_KEY = 'nearauth_vault_v1';
const SESSION_KEY = 'nearauth_vault_session';
const AUTO_LOCK_MS = 15 * 60 * 1000;

async function loadVault() { return (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY] || null; }
async function saveVault(vault) { await chrome.storage.local.set({ [VAULT_KEY]: vault }); }
async function openSession(key) { await chrome.storage.session.set({ [SESSION_KEY]: { raw: await NEARAuthVault.exportKey(key), at: Date.now() } }); }
async function sessionKey() {
  const s = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (!s) return null;
  if (Date.now() - s.at > AUTO_LOCK_MS) { await chrome.storage.session.remove(SESSION_KEY); return null; }
  await chrome.storage.session.set({ [SESSION_KEY]: { raw: s.raw, at: Date.now() } });
  return NEARAuthVault.importKey(s.raw);
}
const extensionOnly = (fn) => (msg, sender) => (isExtensionPage(sender) ? fn(msg, sender) : Promise.resolve({ ok: false, error: 'not_allowed' }));

const handlers = {
  async 'vault.status'() {
    const vault = await loadVault();
    return { ok: true, exists: !!vault, unlocked: !!vault && !!(await sessionKey()), entryIds: vault ? Object.keys(vault.entries) : [] };
  },
  'vault.create': extensionOnly(async (msg) => {
    if (await loadVault()) return { ok: false, error: 'exists' };
    const { vault, key } = await NEARAuthVault.create(msg.master);
    await saveVault(vault); await openSession(key);
    return { ok: true };
  }),
  'vault.unlock': extensionOnly(async (msg) => {
    const vault = await loadVault();
    if (!vault) return { ok: false, error: 'no_vault' };
    await openSession(await NEARAuthVault.unlock(vault, msg.master));
    return { ok: true };
  }),
  'vault.lock': extensionOnly(async () => { await chrome.storage.session.remove(SESSION_KEY); return { ok: true }; }),
  'vault.reveal': extensionOnly(async (msg) => {
    const vault = await loadVault(), key = await sessionKey();
    if (!vault || !key) return { ok: false, error: 'locked' };
    return { ok: true, entry: await NEARAuthVault.get(vault, key, msg.accountId) };
  }),
  'vault.export': extensionOnly(async () => ({ ok: true, vault: await loadVault() })),
  // Write-only from pages: a content script can hand over a password it just generated, but can never read one back.
  async 'vault.save'(msg, sender) {
    if (!sender.tab || isExtensionPage(sender) || typeof msg.secret !== 'string' || !msg.accountId) return { ok: false, error: 'bad_request' };
    const vault = await loadVault();
    if (!vault) return { ok: true, saved: false, reason: 'no_vault' };
    const key = await sessionKey();
    if (!key) return { ok: true, saved: false, reason: 'locked' };
    let site = '';
    try { site = new URL(sender.tab.url || sender.url).hostname; } catch (e) { /* file: or unknown */ }
    await NEARAuthVault.put(vault, key, msg.accountId, { password: msg.secret, alias: String(msg.alias || ''), site, savedAt: new Date().toISOString() });
    await saveVault(vault);
    return { ok: true, saved: true };
  },
  async 'alias.create'(msg) {
    const settings = await getSettings();
    let provider;
    try {
      provider = NEARAuthProviders.createProvider(settings);
      const created = await provider.create({ site: msg.site });
      return { ok: true, ...created };
    } catch (e) {
      // Never block a signup: fall back to a clearly labelled demo alias and say why.
      const demo = await NEARAuthProviders.DemoProvider().create();
      return { ok: true, ...demo, fallbackReason: e.code || 'provider_error', fallbackMessage: e.message };
    }
  },
  async 'alias.setActive'(msg, sender) {
    if (!isExtensionPage(sender)) return { ok: false, error: 'not_allowed' };
    const provider = NEARAuthProviders.createProvider(await getSettings());
    if (!msg.remoteId || provider.id !== msg.providerId) return { ok: false, error: 'provider_mismatch' };
    await (msg.active ? provider.resume(msg.remoteId) : provider.pause(msg.remoteId));
    return { ok: true };
  },
  async 'provider.status'() {
    const s = await getSettings();
    return { ok: true, provider: s.provider || 'demo', routable: s.provider === 'addy', domain: s.provider === 'addy' ? s.addy && s.addy.domain : NEARAuthGen.ALIAS_DOMAIN };
  },
};

function isExtensionPage(sender) {
  // sender.url is set by the browser: for content scripts it is the web page's URL, so it cannot be spoofed.
  return !!sender && sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.code || 'error', message: e.message }));
  return true; // async response
});
