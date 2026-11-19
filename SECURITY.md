# Security Policy

## Status

NEARAuth is a **demo prototype**. It is not audited and must not be used to protect real accounts.

Current security properties of the prototype:

- **Permissions:** `storage` and `alarms` (for the 5-minute sender check). `https://app.addy.io/*` and `https://app.simplelogin.io/*` are optional host permissions, requested only if you choose that alias provider. With the default demo provider the extension makes no network requests.
- **Sender monitor (SimpleLogin):** reads only the list of sender addresses per alias from your SimpleLogin account. It never reads message content or headers and never needs your real mailbox. Auto-block is off unless you enable it; a block affects one sender on one alias and can be undone in SimpleLogin. Classification without authentication results can be wrong, so legitimate third parties (payment processors, couriers) may be flagged.
- **Credential vault:** generated passwords are stored only if you create a vault. Entries are encrypted with AES-256-GCM; the key is derived from your master password with PBKDF2-HMAC-SHA-256 (600,000 iterations, random 16-byte salt). Each ciphertext is bound to its account id.
- **Key handling:** the derived key is held in `chrome.storage.session` (memory only, cleared on browser exit, not readable by content scripts) and discarded after 15 minutes idle. The master password is never stored.
- **Isolation:** web pages and content scripts can only *hand over* a freshly generated password (`vault.save`); reading (`vault.reveal`), unlocking and exporting are accepted only from the extension's own pages.
- **No recovery:** a forgotten master password cannot be reset. "Export encrypted backup" saves ciphertext only.
- **Known gaps:** not audited; PBKDF2 rather than a memory-hard KDF (Argon2id planned); no passkey unlock yet; the addy.io / SimpleLogin API keys and the account↔alias list are stored unencrypted in extension storage; a generated password is visible to the page it is filled into (by design).
- The content script runs on all pages so it can find signup fields. It only reads field *attributes* to detect email/password inputs and never reads values it did not write.
- The dashboard's NEAR connection is read-only public RPC; no keys exist anywhere in this repository.

## Agent service (`agent/`)

- Read-only and approval-driven by default. A provider write needs a single-use, expiring, HMAC-bound approval of the exact action hash, or a narrow standing policy (one alias, one sender domain, expiry; never for high-risk senders).
- The language model (optional, local Ollama) can only choose an intent from a fixed list; it cannot call tools or authorize anything. Policy rules are deterministic.
- Graph state and checkpoints hold references only (ids, masked aliases, hashes). Tests scan checkpoints, receipts and embeddings for the provider key and session token.
- Postgres row-level security (forced) isolates users; the API checks workflow ownership and an origin allow-list, and uses bearer tokens stored as SHA-256 hashes.
- Real-provider mode is refused unless the agent binds to a loopback address, because provider keys in the extension are not yet encrypted at rest. Full threat model and remediation plan: [docs/agent/THREAT_MODEL.md](docs/agent/THREAT_MODEL.md).

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting: *Security → Report a vulnerability* on this repository. Include reproduction steps and impact. Expect an acknowledgement within 7 days.

## Out of scope for now

Findings that amount to "the prototype has no encrypted vault / no real email backend" are known roadmap items (see docs/ROADMAP.md).
