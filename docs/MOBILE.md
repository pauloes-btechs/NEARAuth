# Mobile companions (Milestone E) — design

**Status: design only. No iOS or Android code exists in this repository, and nothing here has been built or run on a device.** Building these needs Xcode / Android Studio, signing identities and store developer accounts, which are owner decisions.

## What the OS allows

| | iOS | Android |
|---|---|---|
| Fill credentials in apps and browsers | AutoFill Credential Provider extension (AuthenticationServices), enabled by the user in Settings → Passwords | Autofill framework service, or the newer Credential Manager provider API; enabled by the user in system settings |
| Offer a *new* alias while a signup form is open | Limited: the provider is invoked when the user taps the password/AutoFill prompt; it cannot draw arbitrary UI over other apps. Alias creation happens inside the provider sheet or in the NEARAuth app (copy / share) | Autofill service can present datasets and a save prompt for detected fields; inline suggestions in the keyboard on supported versions |
| Passkeys | Provider extensions can supply passkeys on recent iOS versions | Credential Manager supports passkey providers on recent Android versions |
| Background mail monitoring | Not on device — exposure detection must run server-side and arrive as push notifications | Same |

Consequences: the browser-extension experience ("button appears in the email field") cannot be copied 1:1. On mobile the flow is *system autofill prompt → NEARAuth sheet → generate alias + password → fill*. Exact API availability per OS version must be checked against Apple and Android documentation when work starts.

## Architecture

```
iOS app + Credential Provider ext ─┐
Android app + Autofill service ────┼──▶ Sync API (ciphertext only) ──▶ storage
Chrome extension ──────────────────┘            │
                                               ├──▶ Alias provider adapter (Milestone A)
                                               └──▶ Exposure pipeline (Milestone C) ──▶ push (APNs / FCM)
```

- **Shared core.** `generators`, `vault`, `detection` and `merkle` are dependency-free and specified by unit tests; port them to Swift/Kotlin (or share via Kotlin Multiplatform / Rust) and reuse the JS test vectors as conformance tests.
- **Vault on device.** Vault key in the Secure Enclave-backed Keychain (iOS) / Android Keystore, unlocked with biometrics. The master password remains the cross-device root; a passkey-derived key is the planned alternative.
- **End-to-end encryption.** The server stores only what `vault.js` already produces: KDF parameters, salt and AES-GCM ciphertext. Account↔alias lists are encrypted the same way before sync.

## Sync API (draft v0)

All bodies are JSON; every item is opaque ciphertext to the server.

| Endpoint | Purpose |
|---|---|
| `POST /v0/devices` | Register a device public key; returns a device id |
| `GET /v0/vault/meta` | KDF parameters + salt + check record (needed to unlock on a new device) |
| `GET /v0/items?since=<cursor>` | Changed items since a cursor: `{ id, rev, deleted, iv, ct }[]` |
| `PUT /v0/items/{id}` | Upsert one item with `If-Match: <rev>`; `409` on conflict |
| `POST /v0/aliases` | Create an alias through the configured provider (server-side adapter) |
| `GET /v0/incidents?since=<cursor>` | Classified exposure events for this user's aliases |

Conflict rule: last-writer-wins per item on `rev`, with the losing revision kept client-side until the user resolves it. Authentication, rate limits, account recovery and data-deletion endpoints are open design items.

## Proposed order of work
1. Sync API reference server + conformance tests (unblocks both platforms and multi-device extension use).
2. Android Autofill service spike (fewest platform restrictions).
3. iOS Credential Provider extension spike.
4. Push notifications for incidents.
