# NEARAuth audit ledger contract

Stores Merkle roots of batches of audit-event commitments. **Status: written and unit-tested (`cargo test`, 6 tests); not yet compiled to Wasm in this repo's history and not deployed to any network.**

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

## Deploy to Testnet (owner action)

This needs a Testnet account and its key, which only the repository owner should create and hold. Check the commands against the current NEAR docs (https://docs.near.org/smart-contracts/quickstart) — the CLI syntax changes between releases.

```bash
# 1. tools
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh

# 2. test and build
cd contracts/audit-ledger
cargo test
cargo near build non-reproducible-wasm

# 3. create a Testnet account funded by the faucet (pick your own name)
near account create-account sponsor-by-faucet-service nearauth-ledger.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

# 4. deploy (interactive: choose the init call `new` with {"owner":"nearauth-ledger.testnet"})
cargo near deploy
```

Then set `NEAR_CONTRACT_ID` in `index.html` to the account name. The dashboard will query `get(root)` and show an *Anchored* status only when the contract returns a record. Anchoring itself (`commit`) is done by the relayer key from a trusted machine — never from the public web page.

## Not done yet
- Wasm build and Testnet deployment.
- Relayer service that batches commitments from many users and calls `commit` on a schedule.
- Sandbox integration tests.
