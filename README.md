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
| Extension detects signup email/password fields, generates and fills alias + password | **Functional** (end-to-end tested) |
| Extension → dashboard account sync (local browser storage) | **Functional** |
| Alias provider adapter + demo provider | **Functional**. Default aliases use `alias.nearauth.example` and **cannot receive email** |
| Real forwarding aliases via addy.io (`AddyProvider`) | **Implemented, not verified live** — tested against the documented API with a mocked `fetch`; needs your own addy.io token |
| Encrypted credential vault (AES-256-GCM, PBKDF2 600k, auto-lock) | **Functional** (unit + end-to-end tested). **Not audited**; no recovery |
| Exposure classification engine (sender/org matching, evidence, confidence) | **Functional** as a library; the dashboard feeds it **simulated** inbound messages. No real mail is processed |
| SHA-256 event commitments, Merkle batching, inclusion proofs, tamper detection | **Functional**, local to the browser |
| Auto-anchor: every new event (including extension signups) is anchored a few seconds later | **Functional** when switched on in Settings, with a registered browser key and the dashboard open in a tab |
| Automatic response to unexpected senders: pause alias, RFC 8058 one-click unsubscribe | **Decision logic functional and tested**; in the dashboard the inbound mail is simulated, so unsubscribe requests are prepared but **not sent**, and pausing affects dashboard state only |
| NEAR Testnet connection | **Live, read-only**: latest final block over public RPC |
| NEAR audit-ledger contract | **Written and unit-tested; not deployed.** No transaction is ever broadcast and no transaction ID is shown |
| Inbound mail pipeline, notifications, relayer, sync backend | **Not implemented** |
| iOS / Android apps | **Design only** ([docs/MOBILE.md](docs/MOBILE.md)) |

## Develop

```bash
npm test            # unit tests (Node 20+, no dependencies)
npm run test:e2e    # Playwright browser tests
npm run lint        # syntax checks
npm run build:zip   # downloads/nearauth-extension.zip
npm run serve       # http://localhost:8080  (dashboard + demo/signup.html)
npm run test:e2e:demo # extension E2E (headless by default)
PW_HEADED=1 PW_SLOW_MO=800 npm run test:e2e:demo # visible browser, slowed for demos
node tests/e2e/vault.e2e.js  # encrypted-vault end-to-end run
(cd contracts/audit-ledger && cargo test)   # NEAR contract unit tests
```

Docs: [Architecture](docs/ARCHITECTURE.md) · [Alias backend decision](docs/decisions/0001-alias-forwarding.md) · [NEAR contract](contracts/audit-ledger/README.md) · [Mobile design](docs/MOBILE.md) · [Roadmap & suggested issues](docs/ROADMAP.md) · [Maintainers guide](docs/MAINTAINERS.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

MIT — see [LICENSE](LICENSE).
## Team

Built at the NEAR Private AI Hackathon NYC (Build City × NEAR Legion), November 11, 2026.
