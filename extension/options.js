'use strict';
const SETTINGS_KEY = 'nearauth_settings_v1';
const ADDY_ORIGIN = 'https://app.addy.io/*';
const $ = (id) => document.getElementById(id);
const radios = () => [...document.querySelectorAll('input[name=provider]')];
const selected = () => radios().find((r) => r.checked).value;

function say(text, err) { $('status').textContent = text; $('status').className = err ? 'err' : ''; }
function sync() { $('addy').style.display = selected() === 'addy' ? 'block' : 'none'; }

async function load() {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || { provider: 'demo' };
  radios().forEach((r) => { r.checked = r.value === (s.provider || 'demo'); });
  $('domain').value = (s.addy && s.addy.domain) || '';
  $('token').value = (s.addy && s.addy.token) || '';
  sync();
}

async function save() {
  const provider = selected();
  const settings = { provider };
  if (provider === 'addy') {
    const domain = $('domain').value.trim().toLowerCase();
    const token = $('token').value.trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return say('Enter a valid alias domain.', true);
    if (!token) return say('Enter your addy.io API token.', true);
    const granted = await chrome.permissions.request({ origins: [ADDY_ORIGIN] });
    if (!granted) return say('Access to app.addy.io was not granted — nothing saved.', true);
    settings.addy = { domain, token };
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  say(provider === 'addy' ? 'Saved. New aliases will be created through addy.io.' : 'Saved. Using offline demo aliases.');
}

radios().forEach((r) => r.addEventListener('change', sync));
$('save').addEventListener('click', () => save().catch((e) => say(e.message, true)));
load();
