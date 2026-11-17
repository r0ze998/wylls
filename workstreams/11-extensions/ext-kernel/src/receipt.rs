//! Calls and receipts (contract §5): what a caller asks and what the core
//! records it did. Receipts form one chain per (manifest, user).

use alloc::vec::Vec;

use permutation_rules::frontier::holding::RESOURCES;
use permutation_rules::hash::{sha256, Digest32};

use crate::exec::Key;
use crate::manifest::ManifestId;

pub const RECEIPT_VERSION: u8 = 1;
/// The core-defined exit's entry id (no manifest may name it: entry ids
/// are the manifest's own, and this one is reserved).
pub const WITHDRAW: u8 = 0xFF;
const ID_DOMAIN: &[u8] = b"WYLLS-EXT-RECEIPT\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub manifest_id: ManifestId,
    pub citizen: Key,
    pub holding: Key,
    pub entry: u8,
    pub args: Vec<i64>,
    pub seq: u64,
    pub signer: Key,
    pub now_ts: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub receipt_version: u8,
    pub effect_set: u8,
    pub manifest_id: ManifestId,
    pub citizen: Key,
    pub holding: Key,
    pub entry: u8,
    pub args: Vec<i64>,
    pub seq: u64,
    pub now_ts: i64,
    pub pre_state: Digest32,
    pub post_state: Digest32,
    pub holding_delta: [i64; RESOURCES],
    pub escrow_delta: [i64; RESOURCES],
    pub burned: [i64; RESOURCES],
    pub events: Vec<u8>,
    pub prev_receipt: Digest32,
}

impl Receipt {
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::new();
        o.push(self.receipt_version);
        o.push(self.effect_set);
        o.extend_from_slice(&self.manifest_id);
        o.extend_from_slice(&self.citizen);
        o.extend_from_slice(&self.holding);
        o.push(self.entry);
        o.push(self.args.len() as u8);
        for a in &self.args {
            o.extend_from_slice(&a.to_le_bytes());
        }
        o.extend_from_slice(&self.seq.to_le_bytes());
        o.extend_from_slice(&self.now_ts.to_le_bytes());
        o.extend_from_slice(&self.pre_state);
        o.extend_from_slice(&self.post_state);
        for arr in [&self.holding_delta, &self.escrow_delta, &self.burned] {
            for v in arr.iter() {
                o.extend_from_slice(&v.to_le_bytes());
            }
        }
        o.push(self.events.len() as u8);
        o.extend_from_slice(&self.events);
        o.extend_from_slice(&self.prev_receipt);
        o
    }

    pub fn id(&self) -> Digest32 {
        sha256(&[ID_DOMAIN, &self.encode()])
    }
}
