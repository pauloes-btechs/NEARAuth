const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test.beforeEach(async ({ page }) => {
  const demoUrl = pathToFileURL(path.resolve(__dirname, '../../index.html')).href;
  await page.goto(demoUrl);
});

test('completes a new user demo journey', async ({ page }) => {
  await expect(page).toHaveTitle(/NEARAuth/);
  await expect(page.getByRole('heading', { name: /Your identity\.\s*Your rules\./ })).toBeVisible();

  const demoVideo = page.locator('#demo-video');
  await expect(demoVideo).toBeVisible();
  await expect(demoVideo).toHaveAttribute('controls', '');
  await expect(page.locator('#demo-video source')).toHaveAttribute('src', 'demo/demoMas.mp4');
  await expect.poll(() => demoVideo.evaluate((video) => video.readyState)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Try signup' }).click();
  await page.getByRole('button', { name: /Generate private email/ }).click();

  const email = page.locator('#signupEmail');
  await expect(email).toHaveValue(/^[a-z0-9]{10}@alias\.nearauth\.example$/);
  const alias = await email.inputValue();
  await expect(page.locator('#signupPassword')).not.toHaveValue('');

  await page.getByRole('button', { name: /Create my account/ }).click();

  await expect(page.getByRole('heading', { name: 'Your protected accounts' })).toBeVisible();
  await expect(page.locator('#account-table tr')).toHaveCount(4);
  await expect(page.locator('#account-table')).toContainText('Nova Market');
  await expect(page.locator('#account-table')).toContainText(alias);
  await expect(page.locator('#account-table')).toContainText('No credentials stored');

  await page.getByRole('button', { name: 'Exposure tracker' }).click();
  await page.getByRole('button', { name: /Simulate exposure/ }).click();
  await expect(page.locator('#incident-list')).toContainText('Inbound activity (simulated)');
  await expect(page.locator('#incident-list tbody tr')).toHaveCount(1);

  await page.getByRole('button', { name: 'Audit ledger' }).click();
  await expect(page.getByRole('heading', { name: 'Trust, with receipts.' })).toBeVisible();
  await expect(page.locator('#ledger-list')).toContainText('Signed up with a protected Nova Market identity');
  await expect(page.locator('#ledger-list')).toContainText('Exposure simulation');
  await expect(page.locator('#ledger-list')).toContainText('Merkle inclusion proof: valid');
  await expect(page.locator('#ledger-list')).toContainText('On-chain transaction: none — SIMULATED');
});
