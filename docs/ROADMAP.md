# Roadmap and suggested issues

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
