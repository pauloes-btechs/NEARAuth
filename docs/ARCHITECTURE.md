# Architecture

## Today (demo)

```
┌──────────────── Chrome extension (MV3) ────────────────┐      ┌──────── Static site (GitHub Pages) ────────┐
│ lib/generators.js  alias + password generation          │      │ index.html       dashboard (single file)   │
│ content.js         field detection, shadow-DOM UI,      │ ───▶ │ demo/signup.html signup test page          │
│                    fills fields, saves account record   │ sync │ downloads/*.zip  built by the Pages workflow│
│ popup.html/js      recent aliases, links, on/off        │      └───────────────┬────────────────────────────┘
└───────────── chrome.storage.local ─────────────────────┘                      │ read-only JSON-RPC (`block`)
                                                                                 ▼
                                                                        NEAR Testnet public RPC
```

- **Storage.** The extension keeps `nearauth_ext_accounts_v1` in `chrome.storage.local`. On pages carrying `<meta name="nearauth-dashboard">`, the content script mirrors that list into the page's `localStorage` and fires a `nearauth:sync` event; the dashboard merges it into its own state (`nearauth_demo_v1`).
- **In-page preview.** `demo/signup.html` can load the same `content.js` directly; without `chrome.storage` it falls back to `localStorage`.
- **Audit ledger.** Each event `{id,label,kind,ts,nonce}` is hashed with SHA-256 in the browser. The commitment is stored with the height/hash of the latest final NEAR Testnet block observed at commit time. Verification recomputes hashes and flags mismatches. Nothing is written on-chain.

## Target (production)

| Layer | Design direction |
|---|---|
| Alias service | `AliasProvider` adapter interface (`create`, `pause`, `delete`, `listInbound`) so the generator is independent of the forwarding backend (own domain + inbound mail provider, or a relay API). GitHub Pages cannot receive mail; the alias domain must be a separate, owned domain with MX records. |
| Credential vault | Client-side authenticated encryption (AES-GCM / XChaCha20-Poly1305), key derived with Argon2id or protected by a passkey (WebAuthn PRF). Server stores ciphertext only. Never plaintext on backend or chain. |
| Exposure detection | Inbound-mail metadata → sender organisation matching → classification (expected / unexpected / confirmed breach) → notification. Pluggable breach-intelligence sources. |
| NEAR | Minimal contract storing salted commitments or periodic Merkle roots — never personal data. Batch anchoring to control cost; a dedicated relayer account to limit account linkability; salts kept client-side to protect metadata. |
| Mobile | iOS Credential Provider extension and Android Autofill service sharing the backend API and encrypted sync. |
