# Maintainers guide (repository owner)

## Inviting collaborators
*Settings → Collaborators → Add people.* Choose the lowest role that works:

| Role | Use for |
|---|---|
| Read / Triage | Issue triage, labelling |
| Write | Trusted contributors who push branches and merge PRs |
| Maintain | Co-maintainers (manage issues, some settings) |
| Admin | Owner only — do not grant routinely |

Outside contributors need no access: they fork and open pull requests.

## Recommended protections for `main`
*Settings → Branches (or Rules → Rulesets) → Add rule for `main`:* require a pull request, require the **CI / test** status check, block force pushes and deletions. Add required reviews once there is a second maintainer.

## GitHub Pages
*Settings → Pages → Build and deployment → Source: **GitHub Actions***. The `Deploy NEARAuth demo to GitHub Pages` workflow publishes on every push to `main` and packages the extension ZIP into `/downloads/`.

## Security settings worth enabling
*Settings → Code security:* private vulnerability reporting, secret scanning with push protection, Dependabot alerts.

## Secrets
None are required today. When NEAR Testnet writes are added, store the relayer key as an environment secret with required reviewers — never in the repository.
