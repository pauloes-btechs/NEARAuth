/* End-to-end check of the SimpleLogin provider and sender monitor with the real unpacked extension,
 * against a local mock of the SimpleLogin API (no real account or key involved).
 * Usage: `npm run serve`, then `node tests/e2e/simplelogin.e2e.js`. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');
const mock = require('./mock-simplelogin.js');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const EXT = path.join(__dirname, '..', '..', 'extension');

(async () => {
  const sl = await mock.start(9099);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nearauth-')), {
    headless: true, executablePath: process.env.CHROME_PATH || undefined,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
    const id = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ nearauth_settings_v1: { provider: 'simplelogin', simplelogin: { token: 'E2E_TEST_KEY', baseUrl: 'http://localhost:9099' }, autoBlock: true } }));

    const page = await ctx.newPage();
    await page.goto(`${BASE}/demo/signup.html`);
    await page.click('#email');
    await page.locator('#nearauth-extension-root >> text=Generate Private Email').click();
    await page.waitForFunction(() => /@simplelogin\.test$/.test(document.querySelector('#email').value));
    const alias = await page.inputValue('#email');
    console.log('alias created through the provider:', alias);

    // Mail arrives at the alias: one from the site itself, one from an unrelated third party.
    sl.db.receive(1, 'welcome@localhost');
    sl.db.receive(1, 'promo@bigadnetwork-e2e.com');

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.click('#monitorRun');
    await popup.waitForSelector('text=Checked: 2 new sender(s), 1 unexpected, 1 blocked.');
    const blocked = sl.db.contacts[1].map((c) => [c.contact, c.block_forward]);
    if (JSON.stringify(blocked) !== JSON.stringify([['welcome@localhost', false], ['promo@bigadnetwork-e2e.com', true]])) throw new Error('wrong block state: ' + JSON.stringify(blocked));
    console.log('third-party sender blocked at the provider; the site\'s own mail untouched');

    await popup.click('#monitorRun');
    await popup.waitForSelector('text=Checked: 0 new sender(s)');
    if (!sl.db.contacts[1][1].block_forward) throw new Error('second run flipped the block off');
    console.log('second run is a no-op');

    await page.goto(`${BASE}/index.html#exposure`);
    await page.waitForSelector('text=LIVE SENDER DATA', { timeout: 8000 });
    await page.waitForSelector('text=Sender blocked at simplelogin for this alias');
    await page.evaluate(() => route('ledger'));
    await page.waitForSelector('#ledger-list >> text=Unexpected sender blocked for');
    const n = await page.evaluate(() => state.events.filter((e) => e.kind === 'Sender monitor').length);
    if (n !== 1) throw new Error('expected exactly one ledger event, got ' + n);
    console.log('dashboard shows the live incident and the ledger event');
    console.log('SIMPLELOGIN E2E PASS');
  } finally { await ctx.close(); sl.close(); }
})().catch((e) => { console.error('SIMPLELOGIN E2E FAIL', e); process.exit(1); });
