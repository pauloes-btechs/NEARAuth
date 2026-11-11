/* End-to-end check of the encrypted vault with the real unpacked extension.
 * Usage: `npm run serve`, then `node tests/e2e/vault.e2e.js` (needs `playwright` and a Chromium that loads extensions). */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const EXT = path.join(__dirname, '..', '..', 'extension');
const MASTER = 'e2e-test-master-phrase'; // throwaway value for a throwaway browser profile

(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nearauth-')), {
    headless: true, executablePath: process.env.CHROME_PATH || undefined,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const id = new URL(sw.url()).host;
  const send = (page, msg) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.fill('#master', 'short');
  await popup.click('#vaultSubmit');
  await popup.waitForSelector('text=Use at least 12 characters.');
  await popup.fill('#master', MASTER);
  await popup.click('#vaultSubmit');
  await popup.waitForSelector('text=· unlocked', { timeout: 20000 });
  console.log('vault created and unlocked');

  const page = await ctx.newPage();
  await page.goto(`${BASE}/demo/signup.html`);
  await page.click('#email');
  await page.locator('#nearauth-extension-root >> text=Generate Private Email').click();
  await page.locator('#nearauth-extension-root >> text=Generate Password').click();
  await page.locator('#nearauth-extension-root >> text=Password encrypted in your NEARAuth vault.').waitFor();
  const filled = await page.inputValue('#password');

  await popup.reload();
  await popup.waitForSelector('text=Copy password');
  const status = await send(popup, { type: 'vault.status' });
  const revealed = await send(popup, { type: 'vault.reveal', accountId: status.entryIds[0] });
  if (revealed.entry.password !== filled) throw new Error('vault returned a different password');
  console.log('password stored encrypted and revealed only to the extension page');

  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  if (JSON.stringify(stored).includes(filled)) throw new Error('plaintext password found in extension storage');
  console.log('no plaintext password in chrome.storage.local');

  await popup.click('#lock');
  await popup.waitForSelector('text=· locked');
  if ((await send(popup, { type: 'vault.reveal', accountId: status.entryIds[0] })).ok) throw new Error('reveal worked while locked');
  await popup.fill('#master', 'wrong-master-password');
  await popup.click('#vaultSubmit');
  await popup.waitForSelector('text=Wrong master password.', { timeout: 20000 });
  await popup.fill('#master', MASTER);
  await popup.click('#vaultSubmit');
  await popup.waitForSelector('text=· unlocked', { timeout: 20000 });
  console.log('lock / wrong password / unlock OK');

  await page.goto(`${BASE}/index.html#accounts`);
  await page.waitForSelector('text=Password encrypted in extension vault', { timeout: 8000 });
  console.log('dashboard shows vault status');
  await ctx.close();
  console.log('VAULT E2E PASS');
})().catch((e) => { console.error('VAULT E2E FAIL', e); process.exit(1); });
