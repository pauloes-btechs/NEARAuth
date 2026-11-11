# NEARAuth

**Private email aliases for every signup, exposure tracking when an alias shows up somewhere unexpected, and a tamper-evident audit trail anchored to NEAR Protocol.**

> **Status: demo prototype** (presentation build, November 11, 2026). See [What is real vs. simulated](#what-is-real-vs-simulated).

| | |
|---|---|
| Live dashboard | https://pauloes-btechs.github.io/NEARAuth/ |
| Signup test page | https://pauloes-btechs.github.io/NEARAuth/demo/signup.html |
| Chrome extension | [`extension/`](extension/) (Manifest V3) · ZIP at `/downloads/nearauth-extension.zip` on the live site |

## 2-minute demo script

1. **Install the extension**: download the ZIP (or clone this repo) → `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select the `extension/` folder.
2. Open the **signup test page**. The top bar shows *Extension detected*.
3. Click the **Email address** field → **Generate Private Email**. A unique alias is filled in.
4. Click **Generate Password**. Password and confirmation are filled. Press *Create account* yourself — NEARAuth never submits forms.
5. Open the **dashboard → Identity vault**: the new account appears with its alias, domain, date and credential status.
6. **Exposure tracker → Simulate exposure**: Company A's alias receives mail from Company B; review evidence, confidence and recommended actions.
7. **Audit ledger**: each event has a SHA-256 commitment pinned to a live NEAR Testnet block. Click *Simulate tampering*, then *Verify integrity* to see a mismatch detected.

No extension installed? The test page has an **in-page preview** button that runs the same content script inside the page.

## What is real vs. simulated

| Capability | State |
|---|---|
| Extension detects signup email/password fields, generates and fills alias + password | **Functional** |
| Extension → dashboard account sync (local browser storage) | **Functional** |
| Alias generation (cryptographically random) | **Functional**, but aliases use the reserved `alias.nearauth.example` domain and **cannot receive email** |
| Password generation | **Functional**; the password is filled into the form only and is **never stored** — there is no vault yet |
| SHA-256 event commitments + integrity verification / tamper detection | **Functional**, local to the browser |
| NEAR Testnet connection | **Live, read-only**: the dashboard reads the latest final block over public RPC and pins commitments to it |
| NEAR transactions / smart contract | **Not implemented.** No transaction is ever broadcast and no transaction ID is shown |
| Exposure detection | **Simulated** scenario; no inbound mail is processed |
| Email forwarding, settings marked "planned", mobile apps | **Not implemented** |

## Browser tests

Install the dependencies and Playwright's Chromium browser, then run the browser tests:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The tests are in `tests/playwright/`. GitHub Actions runs the unit tests, lint checks,
and Playwright tests on pushes and pull requests. The custom reporter in `reporters/`
prints each test result and a summary to the console.

## Develop

```bash
npm test            # unit tests (Node 20+, no dependencies)
npm run test:e2e    # Playwright browser tests
npm run lint        # syntax checks
npm run build:zip   # downloads/nearauth-extension.zip
npm run serve       # http://localhost:8080  (dashboard + demo/signup.html)
node tests/e2e/demo.e2e.js   # optional end-to-end run, needs `playwright`
```

Docs: [Architecture](docs/ARCHITECTURE.md) · [Roadmap & suggested issues](docs/ROADMAP.md) · [Maintainers guide](docs/MAINTAINERS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

MIT — see [LICENSE](LICENSE).
