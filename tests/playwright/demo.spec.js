const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test.beforeEach(async ({ page }) => {
  const demoUrl = pathToFileURL(path.resolve(__dirname, '../../index.html')).href;
  await page.goto(demoUrl);
});

test('renders the overview and opens the identity vault', async ({ page }) => {
  await expect(page).toHaveTitle(/NEARAuth/);
  await expect(page.getByRole('heading', { name: /Your identity\.\s*Your rules\./ })).toBeVisible();
  const demoVideo = page.locator('#demo-video');
  await expect(demoVideo).toBeVisible();
  await expect(demoVideo).toHaveAttribute('controls', '');
  await expect(page.locator('#demo-video source')).toHaveAttribute('src', 'demo/demoMas.mp4');
  await expect.poll(() => demoVideo.evaluate((video) => video.readyState)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Identity vault' }).click();

  await expect(page.getByRole('heading', { name: 'Your protected accounts' })).toBeVisible();
  await expect(page.locator('#account-table tr')).toHaveCount(3);
});

test('generates a demo alias and adds it to the vault', async ({ page }) => {
  await page.getByRole('button', { name: 'Try signup' }).click();
  await page.getByRole('button', { name: /Generate private email/ }).click();

  const email = page.locator('#signupEmail');
  await expect(email).toHaveValue(/^[a-z0-9]{10}@alias\.nearauth\.example$/);
  await expect(page.locator('#signupPassword')).not.toHaveValue('');

  await page.getByRole('button', { name: /Create my account/ }).click();

  await expect(page.getByRole('heading', { name: 'Your protected accounts' })).toBeVisible();
  await expect(page.locator('#account-table')).toContainText('Nova Market');
});
