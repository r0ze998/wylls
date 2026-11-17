//! Fail-closed discovery boundary for the legacy keeper. A PSW1 record is
//! not an empty PS2 history. The first blocker survives later pages and
//! restarts; recovery requires an upgraded reader and an operator rebuild.

use base64::Engine as _;
use fclient::ports::{PortError, PortResult, TxRecord};
use serde_json::{json, Value};
use solana_address::Address;

use crate::journal::Journal;

const JOURNAL_KEY: &str = "unsupported-feed-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedBlock {
    pub seq: u64,
    pub slot: u64,
    pub signature: String,
    pub reason: String,
}

impl FeedBlock {
    pub fn status(&self) -> Value {
        json!({"seq": self.seq, "slot": self.slot, "signature": self.signature,
            "reason": self.reason, "recovery": "upgrade reader and replay discovery; preserve the transaction journal"})
    }

    pub fn save(&self, journal: &Journal) -> Result<(), String> {
        // Never overwrite the first durable blocker with a later page.
        if journal.cursor(JOURNAL_KEY)?.is_none() {
            journal.set_cursor(JOURNAL_KEY, &self.status().to_string())?;
        }
        Ok(())
    }

    pub fn restore(journal: &Journal) -> Result<Option<Self>, String> {
        let Some(raw) = journal.cursor(JOURNAL_KEY)? else {
            return Ok(None);
        };
        let v: Value =
            serde_json::from_str(&raw).map_err(|e| format!("invalid feed blocker: {e}"))?;
        let invalid = || "invalid feed blocker; refusing automatic writes".to_string();
        Ok(Some(Self {
            seq: v["seq"].as_u64().ok_or_else(invalid)?,
            slot: v["slot"].as_u64().ok_or_else(invalid)?,
            signature: v["signature"].as_str().ok_or_else(invalid)?.to_owned(),
            reason: v["reason"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?
                .to_owned(),
        }))
    }
}

#[derive(Clone, Debug)]
pub struct FeedGuard {
    blocked: Option<FeedBlock>,
    caught_up: bool,
}

impl Default for FeedGuard {
    fn default() -> Self {
        // Explicit in-memory models may ingest bodies without a feed. Live
        // pull always marks catch-up incomplete before its first read.
        Self {
            blocked: None,
            caught_up: true,
        }
    }
}

impl FeedGuard {
    pub fn blocked(&self) -> Option<&FeedBlock> {
        self.blocked.as_ref()
    }
    pub fn ready(&self) -> bool {
        self.blocked.is_none() && self.caught_up
    }
    pub fn begin_pull(&mut self) {
        self.caught_up = false;
    }
    pub fn caught_up(&mut self) {
        self.caught_up = true;
    }
    pub fn restore(&mut self, block: FeedBlock) {
        if self.blocked.is_none() {
            self.blocked = Some(block);
        }
    }
    pub fn status(&self) -> Value {
        json!({"state": if self.blocked.is_some() { "blocked" } else if self.caught_up { "legacy" } else { "catching_up" },
            "automatic_writes": self.ready(), "blocker": self.blocked.as_ref().map(FeedBlock::status),
            "provenance": "program invocation logs; account post-state not verified"})
    }
    pub fn check(&self) -> PortResult<()> {
        match &self.blocked {
            Some(b) => Err(PortError::Decode(format!(
                "keeper feed blocked at {}: {}",
                b.seq, b.reason
            ))),
            None => Ok(()),
        }
    }
    /// Raw-body library entry points must not reinterpret a wide version
    /// as an unrelated legacy kind. Their source is explicitly unverified.
    pub fn accept_version(&mut self, body: &[u8], seq: u64, slot: u64) -> bool {
        if self.blocked.is_some() {
            return false;
        }
        if body.first().is_some_and(|v| *v != fclient::log::VERSION) {
            self.restore(FeedBlock {
                seq,
                slot,
                signature: String::new(),
                reason: "unsupported raw record version; source unverified".into(),
            });
            return false;
        }
        true
    }

    /// Applies the latch before a direct library caller can plan or retry.
    pub fn gate(
        &self,
        engine: &mut crate::engine::Engine,
        journal: Option<&Journal>,
    ) -> PortResult<bool> {
        if let Err(error) = engine.restore_feed_block(journal) {
            engine.set_feed_ready(false);
            return Err(PortError::Io(error));
        }
        if let Some(block) = self.blocked() {
            engine.block_feed(block.clone());
        }
        engine.set_feed_ready(self.ready());
        engine.persist_feed_block(journal).map_err(PortError::Io)?;
        Ok(engine.feed_writes_allowed())
    }
    pub fn block(&mut self, tx: &TxRecord, reason: impl Into<String>) {
        self.restore(FeedBlock {
            seq: tx.seq,
            slot: tx.slot,
            signature: tx.signature.to_string(),
            reason: reason.into(),
        });
    }
}

/// Require complete invocation provenance before accepting any PS2 body.
/// Successful transactions with truncated/mismatched frames are unknown,
/// not proof that no work exists. Other programs' records remain ignored.
pub fn bodies(tx: &TxRecord, program: &Address) -> Result<Vec<Vec<u8>>, String> {
    if tx.logs.is_empty() {
        return Err("missing log provenance".into());
    }
    let id = program.to_string();
    let mut saw_frame = false;
    let mut stack: Vec<&str> = vec![];
    for line in &tx.logs {
        if line.contains("Log truncated") {
            return Err("incomplete log provenance".into());
        }
        if stack.last() == Some(&id.as_str()) {
            if let Some(data) = line.strip_prefix("Program data: ") {
                let parts: Vec<_> = data.split_whitespace().collect();
                let tag = parts
                    .first()
                    .and_then(|p| base64::engine::general_purpose::STANDARD.decode(p).ok());
                if tag.as_deref() == Some(b"PSW1") {
                    return Err("unsupported PSW1 record".into());
                }
                if tag.as_deref() == Some(b"PS2") && parts.len() != 2 {
                    return Err("incomplete PS2 record provenance".into());
                }
            }
        }
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        let Some((who, tail)) = rest.split_once(' ') else {
            continue;
        };
        if let Some(depth) = tail.strip_prefix("invoke [") {
            let depth = depth
                .strip_suffix(']')
                .and_then(|s| s.parse::<usize>().ok());
            if depth != Some(stack.len() + 1) {
                return Err("incomplete invocation provenance".into());
            }
            saw_frame = true;
            stack.push(who);
        } else if (tail == "success" || tail.starts_with("failed")) && stack.pop() != Some(who) {
            return Err("incomplete log provenance".into());
        }
    }
    if !saw_frame || !stack.is_empty() {
        return Err("incomplete log provenance".into());
    }
    let bodies = fclient::log::bodies_from_logs(&tx.logs, program).map_err(|e| match e {
        fclient::log::LogError::UnsupportedWideRecord => "unsupported PSW1 record".into(),
        e => format!("invalid program record: {e:?}"),
    })?;
    for body in &bodies {
        fclient::log::Record::decode_v2(body).map_err(|e| format!("invalid PS2 body: {e:?}"))?;
    }
    Ok(bodies)
}
