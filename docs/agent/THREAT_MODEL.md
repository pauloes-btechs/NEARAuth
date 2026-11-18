# NEARAuth agent — threat model

Scope: the agent service (`agent/`), its API, its Postgres data, the LangGraph checkpoints, the optional local model, and the dashboard's Privacy Assistant. The extension and vault are covered by `SECURITY.md`.

## Trust boundaries

```
 [User in browser] ──(1) bearer session, origin allowlist──▶ [Agent API :8787, loopback by default]
        │                                                        │
        │ dashboard (GitHub Pages / localhost)                   ├─(2) graph state + checkpoints ──▶ [Postgres + pgvector, RLS]
        │                                                        ├─(3) prompt: user request text only ──▶ [Ollama, local, optional]
        └─ extension (vault, provider keys) ── never crosses ─X  └─(4) trusted adapter ──▶ [Mock provider | SimpleLogin API]
```

| Boundary | What crosses | What must never cross |
|---|---|---|
| (1) Browser → API | request text, alias/sender **references**, approval decisions bound to an action hash | master password, vault key/ciphertext, provider keys |
| (2) API → Postgres | workflows, proposals, approvals (HMAC'd), sanitized receipts, sender observations, non-secret embeddings | credentials, tokens, message bodies, full unmasked aliases in embeddings |
| (3) API → model | the user's request sentence and the list of supported intents | vault data, provider secrets, retrieved email/web content as instructions |
| (4) API → provider | narrowly scoped calls through an adapter (list senders, block/unblock one sender, pause/resume one alias) | a generic HTTP client, shell, browser automation or raw credential access |

## Principles enforced in code

1. **The model never authorizes.** The LLM (if enabled) may only pick an intent from a fixed enum; its output is schema-validated and the deterministic parser is the fallback. Tools are invoked by graph nodes, not by the model; privileged tools additionally require a server-issued, consumed approval grant.
2. **Ownership is relational, never conversational.** Every alias/sender reference is resolved by `(user_id, id)` lookups under Postgres row-level security (`FORCE ROW LEVEL SECURITY`, `app.user_id` set per transaction).
3. **Default is read-only and approval-driven.** Any write requires approval unless the user created a standing policy that names the exact action, alias and sender domain, and it has not expired.
4. **Approvals are specific, expiring, user-bound and single-use.** HMAC-SHA-256 over `(approval id, user id, thread id, action hash, expiry)`; consumed with an atomic `UPDATE … WHERE status = 'pending'`; the client must echo the action hash it displayed.
5. **Revalidate after approval.** Node 8 re-reads ownership, provider state and the proposal hash; any change aborts.
6. **Idempotent execution.** Receipts are keyed by `(user_id, idempotency_key)`; the adapter reads current state before any toggle-style write; retries are bounded and only for transient errors on read-then-set operations.
7. **Report what is known.** Outcomes are `requested`, `verified`, `failed` or `unsupported`; local hash commitments are never described as on-chain.
8. **Untrusted data stays data.** Sender display names, subjects and tool responses are never concatenated into model instructions and are escaped in the UI.

## Threats and mitigations

| Threat | Mitigation | Test |
|---|---|---|
| Replayed approval | single-use atomic consume; HMAC binding to thread + action hash | `security.test.ts` › replay |
| Expired approval used | `expires_at` checked at consume; 10-minute TTL | › expired approval |
| Target changes after approval (alias reassigned, remote id swapped, sender removed) | Node 8 recomputes the action hash from fresh data | › target changes after approval |
| Cross-user access | RLS + per-request `SET LOCAL app.user_id`; API checks thread ownership | › cross-user (API) and › RLS (DB) |
| Model invokes a privileged tool | registry rejects callers without the scope; model output schema has no tool field | › LLM unauthorized tool |
| Prompt injection via sender name / subject | treated as data; parser reads only the user's request | › prompt injection in sender name |
| Forged headers / claimed DKIM | `trustedAuthResult` brand; plain objects rejected | `responder.test.js`, › forged headers |
| Malicious unsubscribe URL (SSRF, IP literal, credentials, non-443, misaligned host) | `checkUnsubscribeUrl`; manual redirects; never claims "unsubscribed" | › malicious unsubscribe URL |
| Duplicate side effects (double click, crash mid-execute, retry) | idempotency key + receipt row + read-before-toggle | › duplicate execution, › restart |
| Secrets in checkpoints/logs/embeddings | state holds references only; sanitizer + tests scan checkpoint rows and embeddings for secret markers | › no secrets in checkpoints |
| Provider outage | timeouts, bounded retry, `failed` with explanation | › provider unavailable |
| Local model offline | deterministic parser fallback | › model offline |
| Cross-origin requests | origin allowlist; bearer token in header (no cookies) | › CORS |

## Residual risks and remediation plan

- **R1 — provider keys at rest in the extension (S3).** Plan: (a) wrap provider keys with the vault key (AES-GCM, AAD = provider id) so they are readable only while the vault is unlocked; (b) the monitor alarm runs only while unlocked, or the user opts into a separate monitor-only key; (c) prefer provider tokens scoped to the minimum (SimpleLogin keys are account-wide today, so (a) is the main control). Until done, the agent does not accept keys from the extension.
- **R2 — single-tenant real-provider mode.** A real provider is configured by an environment variable for one account; the server refuses `PROVIDER=simplelogin` unless bound to a loopback address. Multi-tenant real mode needs per-user encrypted provider credentials and is not implemented.
- **R3 — session tokens are bearer secrets** stored in the dashboard's `sessionStorage`; XSS on the dashboard origin could use them. Tokens are short-lived (12 h), hashed at rest, and revocable.
- **R4 — checkpoint tables are library-managed** and not covered by RLS; access is only via `thread_id`s whose ownership is checked in `privacy_workflows` first.
- **R5 — sender classification without authentication data** remains heuristic; approvals show this explicitly.
