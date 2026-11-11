//! NEARAuth audit ledger.
//!
//! Stores 32-byte Merkle roots of batches of audit-event commitments, together with the block height and
//! timestamp at which each root was anchored. Nothing else goes on chain: no email addresses, no aliases,
//! no site names, no per-user accounts. A root reveals nothing about the events beneath it; a user proves an
//! event existed at anchor time by presenting the event's salted commitment and a Merkle inclusion proof.
//!
//! Only the owner (a relayer account) may write, so individual users never transact and cannot be linked
//! to their audit trail through on-chain activity.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

pub type Root = [u8; 32];

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    /// Block height at which the root was recorded.
    pub block_height: u64,
    /// Block timestamp in nanoseconds since the Unix epoch.
    pub timestamp_ns: u64,
    /// Number of commitments in the batch (informational).
    pub leaf_count: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AuditLedger {
    owner: AccountId,
    anchors: LookupMap<Root, Anchor>,
    count: u64,
}

fn parse_root(hex: &str) -> Root {
    require!(hex.len() == 64, "root must be 64 hex characters (SHA-256)");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
            .unwrap_or_else(|_| env::panic_str("root must be hexadecimal"));
    }
    out
}

#[near]
impl AuditLedger {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, anchors: LookupMap::new(b"a"), count: 0 }
    }

    /// Anchor a Merkle root. Owner only. A root can be anchored once; the first anchor is permanent.
    pub fn commit(&mut self, root: String, leaf_count: u32) -> Anchor {
        require!(env::predecessor_account_id() == self.owner, "only the owner can anchor roots");
        require!(leaf_count > 0, "leaf_count must be positive");
        let key = parse_root(&root.to_ascii_lowercase());
        require!(!self.anchors.contains_key(&key), "root already anchored");
        let anchor = Anchor {
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
            leaf_count,
        };
        self.anchors.insert(key, anchor.clone());
        self.count += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nearauth-audit\",\"version\":\"1.0.0\",\"event\":\"anchor\",\"data\":{{\"root\":\"{}\",\"leaf_count\":{}}}}}",
            root.to_ascii_lowercase(),
            leaf_count
        ));
        anchor
    }

    /// Look up an anchored root. Returns `null` if it was never anchored.
    pub fn get(&self, root: String) -> Option<Anchor> {
        self.anchors.get(&parse_root(&root.to_ascii_lowercase())).cloned()
    }

    /// Number of anchored roots.
    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ROOT: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, height: u64, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(predecessor))
            .block_height(height)
            .block_timestamp(ts)
            .build());
    }

    #[test]
    fn owner_anchors_and_anyone_reads() {
        ctx("relayer.testnet", 42, 1_000);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        assert_eq!(c.get(ROOT.to_string()), None);
        let a = c.commit(ROOT.to_string(), 7);
        assert_eq!(a, Anchor { block_height: 42, timestamp_ns: 1_000, leaf_count: 7 });
        assert_eq!(c.count(), 1);
        ctx("someone-else.testnet", 50, 2_000);
        assert_eq!(c.get(ROOT.to_uppercase()), Some(a));
        assert_eq!(c.owner(), acct("relayer.testnet"));
    }

    #[test]
    #[should_panic(expected = "only the owner can anchor roots")]
    fn non_owner_cannot_anchor() {
        ctx("relayer.testnet", 1, 1);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        ctx("mallory.testnet", 2, 2);
        c.commit(ROOT.to_string(), 1);
    }

    #[test]
    #[should_panic(expected = "root already anchored")]
    fn first_anchor_is_permanent() {
        ctx("relayer.testnet", 1, 1);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        c.commit(ROOT.to_string(), 1);
        ctx("relayer.testnet", 9, 9);
        c.commit(ROOT.to_string(), 1);
    }

    #[test]
    #[should_panic(expected = "root must be 64 hex characters")]
    fn rejects_wrong_length() {
        ctx("relayer.testnet", 1, 1);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        c.commit("abc".to_string(), 1);
    }

    #[test]
    #[should_panic(expected = "root must be hexadecimal")]
    fn rejects_non_hex() {
        ctx("relayer.testnet", 1, 1);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        c.commit("z".repeat(64), 1);
    }

    #[test]
    #[should_panic(expected = "leaf_count must be positive")]
    fn rejects_empty_batch() {
        ctx("relayer.testnet", 1, 1);
        let mut c = AuditLedger::new(acct("relayer.testnet"));
        c.commit(ROOT.to_string(), 0);
    }
}
