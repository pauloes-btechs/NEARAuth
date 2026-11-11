/* End-to-end check of the demo. Usage: `npm run serve` in one shell, then `node tests/e2e/demo.e2e.js`.
 * Tries the real unpacked extension first; falls back to the in-page preview if the browser refuses to load it. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const EXT = path.join(__dirname, '..', '..', 'extension');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearauth-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: process.env.PW_CHANNEL || undefined, executablePath: process.env.CHROME_PATH || undefined,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/demo/signup.html`);
  await page.waitForTimeout(1200);
  let mode = 'extension';
  if (!(await page.evaluate(() => document.documentElement.dataset.nearauthExtension))) {
    mode = 'in-page preview';
    await page.click('text=Or run in-page preview');
    await page.waitForFunction(() => window.__nearauthLoaded);
  }
  console.log('mode:', mode);

  await page.click('#email');
  await page.locator('#nearauth-extension-root >> text=Generate Private Email').click();
  const email = await page.inputValue('#email');
  if (!/^[a-z2-9]{10}@alias\.nearauth\.example$/.test(email)) throw new Error('alias not filled: ' + email);
  await page.locator('#nearauth-extension-root >> text=Generate Password').click();
  const pw = await page.inputValue('#password');
  if (pw.length !== 20 || pw !== (await page.inputValue('#confirm'))) throw new Error('password not filled in both fields');
  if (await page.isVisible('#success')) throw new Error('form was submitted automatically');
  console.log('alias + password filled, form not auto-submitted:', email);

  await page.click('button.submit');
  await page.waitForSelector('#success', { state: 'visible' });

  await page.goto(`${BASE}/index.html#accounts`);
  await page.waitForFunction((a) => document.getElementById('account-table').textContent.includes(a), email, { timeout: 8000 });
  console.log('account visible in dashboard vault');

  await page.evaluate(() => { route('exposure'); simulateExposure(); });
  await page.waitForSelector('text=not proof of a data sale');
  console.log('exposure investigation rendered');

  await page.evaluate(() => route('ledger'));
  await page.waitForSelector('text=Merkle inclusion proof: valid');
  await page.evaluate(() => tamperDemo());
  await page.waitForSelector('text=MISMATCH');
  console.log('ledger integrity + tamper detection OK; NEAR chip:', await page.textContent('#near-chip'));

  await page.evaluate(() => route('settings'));
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('mobile horizontal overflow px:', overflow);
  await page.screenshot({ path: process.env.SHOT || path.join(os.tmpdir(), 'nearauth-mobile.png') });
  await ctx.close();
  if (errors.length) { console.error('console errors:', errors); process.exit(1); }
  console.log('E2E PASS');
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });
