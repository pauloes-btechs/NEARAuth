'use strict';
const ACCOUNTS_KEY = 'nearauth_ext_accounts_v1';
const ENABLED_KEY = 'nearauth_ext_enabled';
const DASHBOARD_URL = 'https://pauloes-btechs.github.io/NEARAuth/#accounts';
const TEST_PAGE_URL = 'https://pauloes-btechs.github.io/NEARAuth/demo/signup.html';

const $ = (id) => document.getElementById(id);
const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: 'unavailable' } : r)));

let vault = { exists: false, unlocked: false, entryIds: [] };

async function renderVault() {
  vault = await send({ type: 'vault.status' });
  if (!vault || !vault.ok) vault = { exists: false, unlocked: false, entryIds: [] };
  $('vaultState').textContent = !vault.exists ? '· not set up' : vault.unlocked ? '· unlocked' : '· locked';
  $('vaultState').style.color = vault.unlocked ? '#6ce7be' : '#f5c26b';
  $('vaultForm').style.display = vault.unlocked ? 'none' : 'block';
  $('vaultOpen').style.display = vault.unlocked ? 'block' : 'none';
  $('vaultSubmit').textContent = vault.exists ? 'Unlock vault' : 'Create vault';
  $('vaultHelp').textContent = !vault.exists
    ? 'Set a master password to store generated passwords encrypted on this device (AES-256-GCM). There is no recovery if you forget it.'
    : vault.unlocked ? `${vault.entryIds.length} encrypted credential(s). Auto-locks after 15 minutes idle.`
    : 'Unlock to save newly generated passwords and copy stored ones.';
}

async function render() {
  await renderVault();
  const data = await chrome.storage.local.get([ACCOUNTS_KEY, ENABLED_KEY]);
  const accounts = data[ACCOUNTS_KEY] || [];
  $('count').textContent = accounts.length;
  $('pw').textContent = accounts.filter((a) => a.credentials === 'vault-encrypted').length;
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
    if (vault.unlocked && vault.entryIds.includes(a.id)) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy password';
      copy.addEventListener('click', async () => {
        const r = await send({ type: 'vault.reveal', accountId: a.id });
        if (!r.ok) { copy.textContent = 'Locked'; return; }
        await navigator.clipboard.writeText(r.entry.password);
        copy.textContent = 'Copied';
        setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000); // best-effort clipboard clear
      });
      li.append(copy);
    }
    const name = document.createElement('b');
    name.textContent = a.name;
    const alias = document.createElement('code');
    alias.textContent = a.alias;
    const meta = document.createElement('small');
    meta.textContent = ` ${a.domain} · ${new Date(a.createdAt).toLocaleDateString()}${a.routable ? ' · forwarding' : ' · demo alias'}`;
    li.append(name, alias, document.createElement('br'), meta);
    list.append(li);
  }
}

$('vaultForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const master = $('master').value;
  $('vaultMsg').textContent = 'Working…';
  const r = await send({ type: vault.exists ? 'vault.unlock' : 'vault.create', master });
  $('master').value = '';
  $('vaultMsg').textContent = r.ok ? '' : r.error === 'bad_master' ? 'Wrong master password.' : r.error === 'weak_master' ? 'Use at least 12 characters.' : (r.message || 'Could not open the vault.');
  render();
});
$('lock').addEventListener('click', async () => { await send({ type: 'vault.lock' }); render(); });
$('export').addEventListener('click', async () => {
  const r = await send({ type: 'vault.export' });
  if (!r.ok || !r.vault) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(r.vault, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'nearauth-vault-backup.json' });
  a.click();
  URL.revokeObjectURL(url);
});

$('dashboard').addEventListener('click', () => chrome.tabs.create({ url: DASHBOARD_URL }));
$('testpage').addEventListener('click', () => chrome.tabs.create({ url: TEST_PAGE_URL }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
send({ type: 'provider.status' }).then((st) => {
  if (st && st.ok && st.routable) $('providerLine').textContent = `Aliases are created through ${st.provider} on ${st.domain} and forward real email.`;
});
$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ [ENABLED_KEY]: e.target.checked }));
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: [] });
  render();
});

render();
