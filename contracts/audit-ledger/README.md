# NEARAuth audit ledger contract

Stores Merkle roots of batches of audit-event commitments. **Status: deployed to NEAR Testnet at [`nearauth-ledger.testnet`](https://testnet.nearblocks.io/address/nearauth-ledger.testnet) on 2026-11-11.** Deploy + init: transaction `F2wYBs58DwGUhhMNubbFoiNPbmQUSn2vvAn1DECDd9Xf`. First anchored root (5 events, block 277274812): transaction `GXqgLXYN6zuAKrEp3pj3HfpWmeFegTpxKx712RkecVgn`. Testnet only; unaudited.

| Method | Kind | Who | Purpose |
|---|---|---|---|
| `new(owner)` | init | deployer | Sets the relayer account allowed to write |
| `commit(root, leaf_count)` | change | owner only | Anchors a 64-hex-char SHA-256 Merkle root once; records block height and timestamp |
| `get(root)` | view | anyone | Returns `{ block_height, timestamp_ns, leaf_count }` or `null` |
| `count()` / `owner()` | view | anyone | Bookkeeping |

## Design choices

- **Privacy.** Only 32-byte roots go on chain. Event commitments are salted (each event carries a random nonce), so a root or a leaf cannot be brute-forced back to an alias or site name.
- **Account linkability.** Users never sign transactions. One relayer account anchors batches for everyone, so on-chain activity cannot be tied to a person. The trade-off is trust in the relayer's liveness, not its honesty: it cannot forge or alter events, only fail to anchor them.
- **Metadata.** `leaf_count` and anchor timing leak aggregate activity volume. Anchoring on a fixed schedule (rather than per event) hides individual timing.
- **Cost.** One small transaction and one fixed-size storage entry per batch, regardless of how many events it covers. Batch size and interval are the cost dials; measure real gas and storage deposits on Testnet before choosing them.
- **Long-term integrity.** The first anchor of a root is permanent and cannot be overwritten. Verification needs only SHA-256 and public RPC — see `extension/lib/merkle.js` for the tree format (domain-separated leaves and nodes).

## Deploy to Testnet with GitHub Actions

The workflow `.github/workflows/near-deploy.yml` builds the contract with cargo-near, deploys it, optionally anchors one Merkle root, and reads the result back. It only accepts `.testnet` accounts. It has completed one successful `deploy-and-init` run with an anchor; `deploy-only` and `anchor-only` modes have not been exercised.

**1. Create a Testnet account (once, on your machine).** Needs Node.js; pick your own name.

```bash
npx near-cli-rs account create-account sponsor-by-faucet-service nearauth-ledger.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

**2. Store its key as a repository secret.** The key file is `~/.near-credentials/testnet/nearauth-ledger.testnet.json`.

```bash
pbcopy < ~/.near-credentials/testnet/nearauth-ledger.testnet.json     # macOS: copies the file to the clipboard
```

GitHub → repository **Settings → Secrets and variables → Actions → New repository secret** → name `NEAR_TESTNET_CREDENTIALS_JSON`, paste, save. Do not paste the key anywhere else (issues, chat, commits).

**3. Run it.** GitHub → **Actions → "NEAR Testnet — deploy & anchor" → Run workflow**:

| Input | First run |
|---|---|
| `account_id` | `nearauth-ledger.testnet` |
| `mode` | `deploy-and-init` |
| `root` | the 64-character Merkle root shown in the dashboard's *Batch anchor* panel (optional) |
| `leaf_count` | the event count shown next to it |

Later: `anchor-only` to anchor another root, `deploy-only` to upgrade the code.

**4. Point the dashboard at it.** Open `https://pauloes-btechs.github.io/NEARAuth/?contract=nearauth-ledger.testnet#ledger`. The contract id is remembered in that browser. The panel shows *Anchored on Testnet* only when the contract returns a record for the current root. To make it the default for every visitor, set `NEAR_CONTRACT_DEFAULT` in `index.html`.

Notes
- The root is specific to the browser that produced it (events and their nonces live in local storage). Anchor the root from the browser you will demo with, and do not add events between copying the root and showing the result — each new event changes the root.
- The deploying account is also the contract owner, so the same key anchors roots. A production relayer should use a separate function-call-only key.
- A Testnet key controls faucet tokens only. Rotate or delete the account after the event if you like.

### Manual alternative

```bash
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
cd contracts/audit-ledger && cargo near deploy     # interactive; init call `new` with {"owner":"<account>"}
```

## Not done yet
- Relayer service that batches commitments from many users and calls `commit` on a schedule.
- Sandbox integration tests.
