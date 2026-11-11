const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
