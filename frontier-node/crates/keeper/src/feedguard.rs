//! Fail-closed discovery boundary for the legacy keeper. A PSW1 record is
//! not an empty PS2 history. The first blocker survives later pages and
//! restarts; recovery requires an upgraded reader and an operator rebuild.
//!
//! **Devnet gap P8 (feature `playable-lane`).** On a playable-lane season
//! (program version 0x4804) the wide land's own actions log `PSW1`
//! records: a wide village's Harvest / Build / Train (`WIDE_ECONOMY`,
//! `WIDE_ECONOMY_MIRROR`), WideGarrison, WideMuster, WideDissolve and the
//! wide march's later stages. Before this boundary knew them, the first such
//! record latched the guard for good and stopped every non-beacon duty of
//! keeper A (rings, fold, tickets, wide-tickets). A `playable-lane` reader
//! now **accounts for** a PSW1 record, i.e. counts it by kind and applies
//! nothing, only when all of these hold ([`WideScope::account`]):
//!
//! 1. the body decodes exactly (`WideRecord::decode`: version 0x82, a known
//!    kind, the kind's widths, its exact link tail, nothing after it);
//! 2. its kind is one of [`ACCOUNTED_KINDS`]: the kinds whose handlers write
//!    only wide accounts (the wide holding, province, roster, transit and
//!    march records) and never an account this reader indexes (a Citizen's
//!    JOIN, a legacy TICKET, a legacy Holding's SETTLE / RELEASE / EXPLORE /
//!    `pool_owed`, a legacy PROVINCE_OPEN);
//! 3. every province it names (the record's province, the host's or the
//!    holding's home, a settlement's sealed destination) is of this
//!    Season's world and of the **wide** family (ring > `R_MAX_HARD`): a
//!    PSW1 record that names a legacy province or another world is
//!    refused, so a bridge between the two worlds (a rim-to-wide
//!    expedition's records, a conquest from a legacy source) still latches.
//!
//! Anything else stays a blocker exactly as before: a PSW1 body that does
//! not decode, an unknown or not-accounted kind, a legacy or foreign
//! identity, a PS2 body the legacy codec refuses (the expedition kinds
//! 145..=148 among them), incomplete frames or truncated logs. New with P8,
//! in every build: a record of any other format in the program's frame
//! (`PSWC`, `PSWR`, `PSFF`, `PSFT`, … : the playable lane's conquest and
//! expedition receipts, some logged alone while they write a legacy Holding
//! or Citizen) is a blocker too; before, this reader skipped them as if they
//! were another program's. The legacy
//! indexes never read wide state from these records: the wide duties plan
//! from chain reads ([`crate::rings`] P6, [`crate::widetickets`] P7). A
//! keeper built without `playable-lane` refuses every PSW1 record as before.

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
    /// PSW1 records accounted for (not applied), by kind (P8).
    wide_accounted: std::collections::BTreeMap<&'static str, u64>,
}

impl Default for FeedGuard {
    fn default() -> Self {
        // Explicit in-memory models may ingest bodies without a feed. Live
        // pull always marks catch-up incomplete before its first read.
        Self {
            blocked: None,
            caught_up: true,
            wide_accounted: Default::default(),
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
            "wide_accounted": self.wide_accounted,
            "provenance": "program invocation logs; account post-state not verified"})
    }
    /// The PSW1 records of one accepted transaction, counted by kind (P8).
    pub fn account_wide(&mut self, kinds: &[&'static str]) {
        for k in kinds {
            *self.wide_accounted.entry(k).or_default() += 1;
        }
    }
    /// PSW1 records accounted for so far, by kind.
    pub fn wide_accounted(&self) -> &std::collections::BTreeMap<&'static str, u64> {
        &self.wide_accounted
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
/// Every PSW1 record is refused (the strict reader; see [`bodies_scoped`]).
pub fn bodies(tx: &TxRecord, program: &Address) -> Result<Vec<Vec<u8>>, String> {
    bodies_scoped(tx, program, None).map(|b| b.ps2)
}

/// One accepted transaction: its PS2 bodies (to apply) and the kinds of the
/// PSW1 records accounted for and not applied (P8).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bodies {
    pub ps2: Vec<Vec<u8>>,
    pub wide: Vec<&'static str>,
}

/// [`bodies`], plus: with a [`WideScope`] (a `playable-lane` keeper), a
/// PSW1 record in the program's frame that the scope accounts for is
/// counted instead of refused. Without a scope this is [`bodies`].
pub fn bodies_scoped(
    tx: &TxRecord,
    program: &Address,
    scope: Option<&WideScope>,
) -> Result<Bodies, String> {
    if tx.logs.is_empty() {
        return Err("missing log provenance".into());
    }
    let id = program.to_string();
    let mut saw_frame = false;
    let mut stack: Vec<&str> = vec![];
    let mut wide = vec![];
    // (the accounted PSW1 lines, left out of the PS2 extraction below)
    let mut skip = std::collections::BTreeSet::new();
    for (i, line) in tx.logs.iter().enumerate() {
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
                    let Some(scope) = scope else {
                        return Err("unsupported PSW1 record".into());
                    };
                    let body = match parts.as_slice() {
                        [_, b] => base64::engine::general_purpose::STANDARD
                            .decode(b)
                            .map_err(|_| "unsupported PSW1 record: base64".to_string())?,
                        _ => return Err("unsupported PSW1 record: incomplete provenance".into()),
                    };
                    wide.push(
                        scope
                            .account(&body)
                            .map_err(|e| format!("unsupported PSW1 record: {e}"))?,
                    );
                    skip.insert(i);
                    continue;
                }
                if tag.as_deref() == Some(b"PS2") && parts.len() != 2 {
                    return Err("incomplete PS2 record provenance".into());
                }
                // (P8 audit: the playable lane's other record formats — PSWC, PSWR, PSFF,
                //  PSFT, … — can be a transaction's only record while they write a legacy
                //  Holding or Citizen; this reader knows none of them)
                if let Some(t) = tag.as_deref().filter(|t| *t != b"PS2") {
                    return Err(format!(
                        "unsupported {} record",
                        String::from_utf8_lossy(t).escape_default()
                    ));
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
    let logs: Vec<String> = if skip.is_empty() {
        tx.logs.clone()
    } else {
        tx.logs
            .iter()
            .enumerate()
            .filter(|(i, _)| !skip.contains(i))
            .map(|(_, l)| l.clone())
            .collect()
    };
    let bodies = fclient::log::bodies_from_logs(&logs, program).map_err(|e| match e {
        fclient::log::LogError::UnsupportedWideRecord => "unsupported PSW1 record".into(),
        e => format!("invalid program record: {e:?}"),
    })?;
    for body in &bodies {
        fclient::log::Record::decode_v2(body).map_err(|e| format!("invalid PS2 body: {e:?}"))?;
    }
    Ok(Bodies { ps2: bodies, wide })
}

/// What a legacy reader may account for in the wide world (P8). Without
/// `playable-lane` there is none: [`WideScope::of`] is `None` and every
/// PSW1 record is refused.
pub struct WideScope {
    #[cfg(feature = "playable-lane")]
    resolver: frontier_abi::world_index::expedition::AccountResolver,
}

/// The PSW1 kinds a `playable-lane` legacy reader accounts for (module doc,
/// rule 2): the wide march lifecycle (1..=14) and the wide holding's owner
/// actions (15 economy, 16 economy with the province mirror, 17 garrison).
/// The provisional conquest kinds (18..=24) are not here: their receipts
/// carry a source that may be a legacy Holding, so they still latch.
#[cfg(feature = "playable-lane")]
pub const ACCOUNTED_KINDS: [frontier_abi::world_index::event::WideKind; 17] = {
    use frontier_abi::world_index::event::WideKind as K;
    [
        K::Muster,
        K::Dissolve,
        K::Resolve,
        K::Return,
        K::Stranded,
        K::RosterClosed,
        K::Departed,
        K::TransitSettled,
        K::DepartureSettled,
        K::Revealed,
        K::Gathered,
        K::RecordClosed,
        K::TransitClosed,
        K::ProvinceClosed,
        K::Economy,
        K::EconomyMirror,
        K::Garrison,
    ]
};

impl WideScope {
    /// The scope of this keeper's Season (`playable-lane` only).
    pub fn of(addrs: &fclient::addr::Addresses) -> Option<Self> {
        #[cfg(feature = "playable-lane")]
        {
            let ctx = crate::widelane::ctx(addrs);
            frontier_abi::world_index::expedition::AccountResolver::for_season(&ctx)
                .ok()
                .map(|resolver| Self { resolver })
        }
        #[cfg(not(feature = "playable-lane"))]
        {
            let _ = addrs;
            None
        }
    }

    /// The kind of a PSW1 body this reader accounts for, or why it does not.
    pub fn account(&self, body: &[u8]) -> Result<&'static str, String> {
        #[cfg(feature = "playable-lane")]
        {
            use frontier_abi::world_index::expedition::AccountFamily;
            let w = frontier_abi::world_index::event::WideRecord::decode(body)
                .map_err(|e| format!("{e:?}"))?;
            if !ACCOUNTED_KINDS.contains(&w.kind) {
                return Err(format!("{} is not accounted for", w.kind.name()));
            }
            let named = [
                w.province_of(),
                w.home_of(),
                w.holding_of().map(|h| h.key()),
                w.sealed_dest(),
            ];
            if named[0].is_none() {
                return Err(format!("{} names no province", w.kind.name()));
            }
            for k in named.into_iter().flatten() {
                match self.resolver.family(k) {
                    Ok(AccountFamily::Wide) => {}
                    Ok(AccountFamily::Legacy) => {
                        return Err(format!("{} names a legacy province", w.kind.name()))
                    }
                    Err(_) => return Err(format!("{} names another world", w.kind.name())),
                }
            }
            Ok(w.kind.name())
        }
        #[cfg(not(feature = "playable-lane"))]
        {
            let _ = body;
            Err("this keeper reads no PSW1 record".into())
        }
    }
}
