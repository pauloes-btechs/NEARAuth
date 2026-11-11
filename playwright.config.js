const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  reporter: './reporters/console-reporter.js',
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
