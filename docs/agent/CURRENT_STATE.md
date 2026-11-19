# NEARAuth — state before the agent upgrade (Phase 0 audit)

Audited on 2026-11-18 at `main` commit `9516b67` (after PR #14). Baseline: `npm test` → **49/49 pass**; Playwright and CI workflows green on `main`.

## What actually works

| Area | Implementation | Evidence |
|---|---|---|
| Alias generation + autofill | `extension/content.js`, `lib/generators.js` (MV3) | unit + extension E2E |
| Alias providers | `lib/alias-provider.js`: `DemoProvider` (non-routable `.example`), `AddyProvider`, `SimpleLoginProvider` | mocked-`fetch` unit tests; SimpleLogin E2E against a **local mock**; one manual `user_info` call with a real key succeeded |
| Encrypted vault | `lib/vault.js`: PBKDF2-SHA-256 (600k) → AES-256-GCM, AAD-bound entries; key only in `chrome.storage.session`, 15-min idle lock | unit + E2E |
| Sender monitor | `lib/monitor.js` + 5-minute alarm in `background.js`: classifies sender **addresses** per SimpleLogin alias; optional auto-block | unit + mock E2E |
| Classification | `lib/detection.js`: registrable-domain matching, ESP list, evidence + confidence | unit |
| Response policy | `lib/responder.js`: pause / RFC 8058 one-click plan | unit (see gap S1) |
| Audit ledger | dashboard SHA-256 commitments, `lib/merkle.js` batching + proofs | unit |
| NEAR | `contracts/audit-ledger` **deployed on Testnet** at `nearauth-ledger.testnet`; roots anchored from the browser with a function-call key (`near-anchor.js`) | live Testnet transactions on 2026-11-11 |

## What does not exist (do not claim it)

- **No inbound-message pipeline.** NEARAuth never receives email bodies or headers. Every "message" in the dashboard is simulated; the SimpleLogin monitor sees sender addresses only.
- **No real DKIM verification anywhere.** See S1.
- **No server-side component** before this upgrade; GitHub Pages is static.
- **No mobile apps** (design doc only).
- SimpleLogin integration has **not been exercised end-to-end against a real account** (only `user_info`).
- NEAR anchoring is Testnet only, from one browser profile's key; the contract is unaudited.

## Security gaps found

| # | Gap | Severity | Where | Action in this upgrade |
|---|---|---|---|---|
| S1 | `responder.js` and `detection.js` treat a non-empty `dkimDomain` **string** as proof of DKIM authentication. Anyone who can shape the input (a forged header, a caller bug) gets "authenticated" treatment, including an automated unsubscribe POST. | High | `responder.js` `plan()`, `detection.js` `classify()` | **Fixed:** only branded results from a trusted verifier count (`trustedAuthResult`). Unsubscribe additionally requires URL safety checks and host alignment. |
| S2 | Unsubscribe URL is used after an `https://` prefix check only — no host, port, IP-literal, credential or redirect constraints (SSRF / open-redirect surface once real mail exists). | High (latent) | `responder.js` | **Fixed:** `checkUnsubscribeUrl()` |
| S3 | Provider API keys (addy.io, SimpleLogin) stored **unencrypted** in `chrome.storage.local`, readable by anyone with the browser profile. | High | `options.js`, `background.js` | **Not fixed yet.** Remediation plan in `THREAT_MODEL.md` §R1. Because of this, the agent service never receives extension-held keys, and real-provider execution is restricted to a loopback-bound agent configured by its owner. |
| S4 | Account↔alias list and sender events stored unencrypted (extension + dashboard `localStorage`). | Medium | extension, dashboard | Documented; agent stores only references and masked aliases. |
| S5 | Auto-block (monitor) acts without per-action approval when enabled; classification without auth data can flag legitimate processors. | Medium | `monitor.js` | Agent path is approval-driven by default; monitor behaviour unchanged (opt-in). |
| S6 | Anchor function-call key lives in `localStorage` of the dashboard origin; any script on that origin can use it (bounded to `commit()` and a 1 NEAR allowance). | Low (Testnet) | `near-anchor.js` | Documented. |
| S7 | Dashboard is a single static page with inline scripts; no CSP. | Low | `index.html` | Documented; agent API enforces origin allowlist + bearer auth. |

## Dependencies

Root: no runtime deps; `@playwright/test` for E2E. Contract: `near-sdk` 5. The extension and dashboard load nothing from CDNs.
