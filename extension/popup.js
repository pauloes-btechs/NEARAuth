'use strict';
const ACCOUNTS_KEY = 'nearauth_ext_accounts_v1';
const ENABLED_KEY = 'nearauth_ext_enabled';
const DASHBOARD_URL = 'https://pauloes-btechs.github.io/NEARAuth/#accounts';
const TEST_PAGE_URL = 'https://pauloes-btechs.github.io/NEARAuth/demo/signup.html';

const $ = (id) => document.getElementById(id);

async function render() {
  const data = await chrome.storage.local.get([ACCOUNTS_KEY, ENABLED_KEY]);
  const accounts = data[ACCOUNTS_KEY] || [];
  $('count').textContent = accounts.length;
  $('pw').textContent = accounts.filter((a) => a.credentials === 'generated-not-stored').length;
  $('enabled').checked = data[ENABLED_KEY] !== false;

  const list = $('list');
  list.textContent = '';
  if (!accounts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No aliases yet. Focus an email field on a signup form.';
    list.append(li);
    return;
  }
  for (const a of accounts.slice(-5).reverse()) {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = a.name;
    const alias = document.createElement('code');
    alias.textContent = a.alias;
    const meta = document.createElement('small');
    meta.textContent = ` ${a.domain} · ${new Date(a.createdAt).toLocaleDateString()}`;
    li.append(name, alias, document.createElement('br'), meta);
    list.append(li);
  }
}

$('dashboard').addEventListener('click', () => chrome.tabs.create({ url: DASHBOARD_URL }));
$('testpage').addEventListener('click', () => chrome.tabs.create({ url: TEST_PAGE_URL }));
$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ [ENABLED_KEY]: e.target.checked }));
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: [] });
  render();
});

render();
