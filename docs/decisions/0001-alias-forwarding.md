# Decision record 0001 — Alias forwarding backend (Milestone A)

Status: **adapter implemented; real provider untested against a live account** · 2026-11-11

## Constraint
GitHub Pages only serves static files. `pauloes-btechs.github.io` cannot receive email, so real aliases need a separate mail domain with MX records, or a relay service that already owns one.

## Options reviewed

| Option | What the free tier offers (checked 2026-11-11 — re-verify before committing) | Fit |
|---|---|---|
| **addy.io** (open source, self-hostable) | Unlimited standard aliases on a username subdomain, 10 shared-domain aliases, 1 recipient, 10 MB/month bandwidth ([pricing](https://addy.io/#pricing)). REST API with bearer tokens ([docs](https://app.addy.io/docs/)). One third-party comparison claims the free plan has no API access — **unconfirmed; test with a real token**. | Fastest path: no domain needed, per-user accounts, API maps 1:1 to our adapter. Implemented as `AddyProvider`. |
| **SimpleLogin** (open source, Proton) | 10 aliases, 1 mailbox on the free plan, per third-party comparisons. | Same shape as addy.io; 10-alias cap is too small for one-alias-per-site. Good second adapter. |
| **Cloudflare Email Routing** + owned domain | Free forwarding on a domain using Cloudflare DNS; 200 rules and 200 destination addresses; 25 MiB message limit; forward-only ([limits](https://developers.cloudflare.com/email-routing/limits/)). Email Workers can process inbound mail in code. | Best fit for a NEARAuth-operated domain: a catch-all Email Worker gives us inbound metadata for exposure detection (Milestone C). Costs a domain registration and needs a NEARAuth backend to map alias → user. |
| Self-hosted addy.io / Postfix | No per-alias limits. | Highest control and highest ops burden; needs a server with port 25 and deliverability work. Later. |

## Decision
1. Ship the **adapter contract** (`extension/lib/alias-provider.js`): `create / pause / resume / remove`, returning `{ alias, remoteId, providerId, routable }`. `DemoProvider` stays the default.
2. Ship **`AddyProvider`** as the first real backend: bring-your-own account, token entered in the extension options page, calls made only from the background worker, with `https://app.addy.io/*` requested as an optional host permission at save time.
3. For a NEARAuth-operated service, target **Cloudflare Email Routing + Email Worker on a dedicated domain**. This needs a purchased domain and a Cloudflare account — owner approval required.

## What is verified
- Request/response shapes follow the published addy.io API reference and are covered by unit tests with a mocked `fetch` (`tests/alias-provider.test.js`).
- **Not verified:** a live call with a real addy.io token. Nobody has created a real alias through this code yet.

## Follow-ups
- Live test with an owner-supplied token; confirm free-plan API access and rate limits.
- Encrypt the stored provider token with the vault key (Milestone B) instead of plain extension storage.
- `SimpleLoginProvider`; Cloudflare Worker reference implementation once a domain exists.
