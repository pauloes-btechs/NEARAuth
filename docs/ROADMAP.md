# Roadmap and suggested issues

Milestone status (2026-11-11): **A** adapter + addy.io backend shipped, live verification pending · **B** local encrypted vault shipped, unaudited · **C** classification engine shipped, no real inbound mail yet · **D** contract + Merkle proofs shipped, not deployed · **E** design only.

Remaining work per milestone:

- **A:** live-test `AddyProvider` with an owner token; encrypt the provider token with the vault key; pause/resume from the dashboard; SimpleLogin adapter; Cloudflare Email Worker on an owned domain.
- **B:** security review; Argon2id; passkey (WebAuthn PRF) unlock; recovery kit; change-master-password flow; encrypt the account list.
- **C:** inbound webhook/Email Worker feeding `investigate()`; full Public Suffix List; organisation graph (parent companies, known processors); push/email notifications; breach-intelligence source interface.
- **D:** Wasm build + Testnet deploy (owner key); relayer service; sandbox integration tests; show real transaction links once anchors exist.
- **E:** everything in docs/MOBILE.md.

The lists below are the original issue breakdown.

Each item is sized to be an independent GitHub issue. Labels in brackets.

## Milestone A — Real email aliases
- Define `AliasProvider` adapter interface and a `DemoProvider` implementing it [architecture]
- Evaluate free-tier inbound/forwarding options and a dedicated alias domain; write a decision record [research]
- Implement first real provider behind the adapter; pause/resume alias from dashboard [backend]

## Milestone B — Secure credentials
- Threat model for the vault [security]
- Client-side encrypted vault (authenticated encryption, memory-hard KDF) [security]
- Passkey unlock (WebAuthn PRF) and recovery-flow design [security]

## Milestone C — Real exposure detection
- Inbound event schema and alias↔account correlation [backend]
- Sender-organisation matching and evidence/confidence classification [detection]
- Notifications; breach-intelligence integration interface [detection]

## Milestone D — NEAR Protocol
- Minimal Testnet contract: `commit(root)` / `get(root)` storing Merkle roots only [near] [contract]
- Relayer design: batching, cost model, account-linkability analysis [near]
- Dashboard: verify inclusion proof against on-chain root; show real transaction links [near] [frontend]

## Milestone E — Mobile companions
- Shared sync API specification [mobile]
- iOS Credential Provider extension spike; Android Autofill service spike [mobile]

## Good first issues
- Split `index.html` into modules with a small build step, keeping the single-file fallback
- Extension options page (alias format, per-site disable)
- Detect email fields inside open shadow roots and same-origin iframes
- Accessibility pass on the dashboard (focus order, contrast)
- Playwright end-to-end test in CI
