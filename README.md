# NEARAuth — Interactive demo

**Demo-only prototype**, created for a live product presentation on November 11, 2026.

NEARAuth imagines browser-native email aliases, a protected-account dashboard, a data-sharing investigation feed, and verifiable NEAR audit commitments.

## View the demo

Once GitHub Pages is enabled with **GitHub Actions** as the build/deployment source, visit:

https://pauloes-btechs.github.io/NEARAuth/

If the link is not live, in this repository go to **Settings → Pages → Build and deployment → Source: GitHub Actions**, and run **Actions → Deploy NEARAuth demo to GitHub Pages → Run workflow**.

## Run locally

Open `index.html` in a browser. No build, packages, accounts, or credentials are required.

## Run browser tests

Install the project dependencies and Playwright's Chromium browser, then run the test suite:

```sh
npm install
npx playwright install chromium
npm test
```

The Playwright tests are in `tests/playwright/`.
GitHub Actions runs them on pushes and pull requests.
The custom reporter in `reporters/` prints each test result and a summary to the console.

## Presentation guidance

This is an **interactive UI simulation**. Illustrative aliases do **not** receive emails. Exposure events are synthetic examples. The NEAR integration is not live and no transactions are sent on-chain. Do not enter actual passwords or private account details.

## Next engineering milestones

1. Manifest V3 Chrome extension for detection and one-click signup form autofill.
2. Verified inbound email alias routing using an owned domain and authenticated backend.
3. Client-side encrypted credential vault, with audited design.
4. NEAR Testnet commitment anchoring without publishing personal identifiers.
5. Native iOS and Android credential-provider companion apps.

## Collaborating

Contributors can fork and open pull requests. Maintainer access is granted by repository owner through GitHub Settings → Collaborators. Please avoid posting personal credentials, sample inboxes, or secrets in issues.

## Licensing

See LICENSE.
