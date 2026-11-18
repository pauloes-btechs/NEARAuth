# Agent upgrade — next-phase backlog

Ordered by risk reduction first, then capability.

1. **Encrypt provider keys in the extension (THREAT_MODEL R1).** Wrap with the vault key; monitor only while unlocked or with a separate monitor-only key. Prerequisite for any remote (non-loopback) real-provider mode.
2. **Extension as the executor.** Instead of the agent holding a SimpleLogin key, the agent returns an approved, signed action; the extension's background worker verifies the grant and executes with its own key. Removes provider secrets from the server entirely.
3. **In-browser re-authentication** (WebAuthn) for high-risk approvals, replacing "issue a fresh token from the CLI".
4. **Real inbound pipeline** (Cloudflare Email Worker or similar on an owned domain) producing verifier-issued DKIM results → enables gated RFC 8058 unsubscribe (`propose_unsubscribe` → approval → `checkUnsubscribeUrl` → POST → report `requested`).
5. **Per-user provider credentials** (encrypted, RLS-scoped) for multi-tenant real mode.
6. **Live verification** of the SimpleLogin adapter against a real account (manual, owner-run).
7. **Real embedding model evaluation** (Ollama `nomic-embed-text`) with the user's own service names; tune the suggestion threshold only if wrong matches stay at zero.
8. **Streaming progress** (Server-Sent Events from `app.stream`) so the graph animates live instead of replaying the path.
9. **Audit anchoring of agent receipts** on NEAR via the existing relayer design (batch root of server-side commitments).
10. **MCP surface + delegated capabilities** for external agents: narrow, time-limited, per-alias scopes; read tools first; no vault access. Only after 1–3.
11. Mobile companions consuming the same API (see docs/MOBILE.md).
