/* End-to-end check of the Privacy Assistant against a real agent process (simulation mode, embedded Postgres).
 * Usage: `npm run serve` (port 8080), `cd agent && npm ci`, then `node tests/e2e/assistant.e2e.js`. No network, no live provider. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PORT = process.env.AGENT_PORT || '8799';

function startAgent() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearauth-agent-'));
  const child = spawn('npx', ['tsx', 'src/cli/demo.ts'], { cwd: path.join(__dirname, '..', '..', 'agent'),
    env: { ...process.env, NEARAUTH_DATA_DIR: dataDir, NEARAUTH_AGENT_PORT: PORT, NEARAUTH_PROVIDER: 'mock', NEARAUTH_LLM: 'off' }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('agent did not start: ' + out)), 60000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/^\s+([A-Za-z0-9_-]{43})\s*$/m);
      if (m) { clearTimeout(t); resolve({ child, token: m[1] }); }
    });
  });
}

(async () => {
  const { child, token } = await startAgent();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/index.html#assistant`);
    await page.fill('#as-url', `http://127.0.0.1:${PORT}`);
    await page.fill('#as-token', token);
    await page.click('[data-act=connect]');
    await page.waitForSelector('text=SIMULATION · mock provider');

    await page.click('[data-sug="0"]');
    await page.waitForSelector('text=WHICH ONE?');
    await page.click('[data-pick]:has-text("brightline")');
    await page.waitForSelector('text=APPROVAL NEEDED');
    if (await page.locator('.as-node.waiting:has-text("Request approval")').count() !== 1) throw new Error('graph does not show the approval node waiting');
    console.log('graph paused at Request approval');
    await page.click('[data-act=approve]');
    await page.waitForSelector('.as-chip:has-text("verified")');
    await page.waitForSelector('p:has-text("(not on-chain)")');
    console.log('approved action verified, receipt shown');

    await page.click('[data-tab=history]');
    await page.click('[data-undo]');
    await page.waitForSelector('text=APPROVAL NEEDED');
    await page.click('[data-act=decline]');
    await page.waitForSelector('.as-chip:has-text("declined")');
    console.log('undo proposed, then declined: nothing changed');

    await page.click('[data-sug="2"]');
    await page.waitForSelector('.as-chip:has-text("unsupported")');
    await page.waitForSelector('text=Instead I can');
    console.log('unsubscribe reported unsupported with a block offered instead');

    await page.click('[data-tab=explain]');
    await page.waitForSelector('text=Edges and conditions');
    if (errors.length) throw new Error('page errors: ' + errors.join('; '));
    console.log('ASSISTANT E2E PASS');
  } finally { await browser.close(); try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { child.kill(); } }
})().then(() => process.exit(0), (e) => { console.error('ASSISTANT E2E FAIL', e); process.exit(1); });
