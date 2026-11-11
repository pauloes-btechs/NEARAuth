# Security Policy

## Status

NEARAuth is a **demo prototype**. It is not audited and must not be used to protect real accounts.

Current security properties of the prototype:

- The extension requests only the `storage` permission and makes **no network requests**.
- Generated passwords are filled into the page and are **never stored or transmitted**.
- Account associations (site, alias, timestamp) are kept in local browser storage, unencrypted.
- The content script runs on all pages so it can find signup fields. It only reads field *attributes* to detect email/password inputs and never reads values it did not write.
- The dashboard's NEAR connection is read-only public RPC; no keys exist anywhere in this repository.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting: *Security → Report a vulnerability* on this repository. Include reproduction steps and impact. Expect an acknowledgement within 7 days.

## Out of scope for now

Findings that amount to "the prototype has no encrypted vault / no real email backend" are known roadmap items (see docs/ROADMAP.md).
