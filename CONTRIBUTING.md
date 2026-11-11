# Contributing to NEARAuth

Thanks for helping. NEARAuth is early: small, focused pull requests are the fastest way to land work.

## Getting started

1. Fork the repository and clone your fork.
2. `npm test` and `npm run lint` (Node 20+; there are no dependencies to install).
3. `npm run serve`, open http://localhost:8080/demo/signup.html, and load `extension/` via `chrome://extensions` → Developer mode → Load unpacked.
4. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and pick an issue from [docs/ROADMAP.md](docs/ROADMAP.md).

## Workflow

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`.
- Add or update tests for behaviour you change. CI (lint + unit tests) must pass.
- Open a pull request using the template; link the issue; describe what is functional versus simulated.
- A maintainer reviews and merges. Please do not force-push after review starts.

## Ground rules

- **Honest labelling.** Anything simulated must say so in the UI. Never display invented NEAR transaction IDs or imply that `.example` aliases receive email.
- **Privacy first.** No analytics, no network calls from the extension, no new permissions without discussion in an issue.
- **No secrets.** Never commit keys, tokens, real inboxes or personal credentials — including in issues and screenshots.
- The extension must never submit forms or read fields it did not fill.

Security problems: follow [SECURITY.md](SECURITY.md), not public issues. Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
