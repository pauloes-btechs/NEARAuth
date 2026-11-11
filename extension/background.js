/* NEARAuth background service worker.
 * The only place that talks to an alias provider over the network; content scripts just send messages. */
'use strict';
importScripts('lib/generators.js', 'lib/alias-provider.js');

const SETTINGS_KEY = 'nearauth_settings_v1';

async function getSettings() {
  return (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || { provider: 'demo' };
}

const handlers = {
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
  return !!sender && sender.id === chrome.runtime.id && !sender.tab && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.code || 'error', message: e.message }));
  return true; // async response
});
