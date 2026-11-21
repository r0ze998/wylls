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
//! identity, a PS2 body the legacy codec refuses (the playable lane's
//! kinds 145..=149: `Record::decode_v2` refuses every one of them, 149
//! included), incomplete frames or truncated logs. New with P8,
//! in every build: a record of any other format in the program's frame
//! (`PSWC`, `PSWR`, `PSFF`, `PSFT`, … : the playable lane's conquest and
//! expedition receipts, some logged alone while they write a legacy Holding
//! or Citizen) is a blocker too; before, this reader skipped them as if they
//! were another program's. The legacy
//! indexes never read wide state from these records: the wide duties plan
//! from chain reads ([`crate::rings`] P6, [`crate::widetickets`] P7). A
//! keeper built without `playable-lane` refuses every PSW1 record as before.
//!
//! **Devnet gap P10 (feature `playable-lane`): the rim → wide expedition's
//! records.** The version-2 dispatch wrapper's kinds 0–11 log, in the
//! program's own frame (one instruction each; the records as the pinned
//! devnet `.so` logs them, `fixtures/verify/playable-*.json.gz`):
//!
//! | kind | records |
//! |---|---|
//! | 0 Depart, 1 SettleOrigin | PS2 146 |
//! | 2 Reveal, 3 Gather | PS2 147 |
//! | 6 SettleMember, 7 SettleCamp | 0–3 PS2 DIVERT, then PS2 148 + PSW1 25 |
//! | 4 Dissolve, 5 Return (resident) | PS2 149 + PSW1 26 |
//! | 8, 9, 11 failure / forfeit / retained failure | 0–1 PS2 DIVERT, then PSFF v1 / v2 / v3 |
//! | 10 CloseTerminal | PSFT v1 |
//!
//! A `playable-lane` reader **applies** these ([`WideScope::expedition`],
//! [`ExpeditionFact`]) only when each decodes exactly with its own codec
//! (`frontier_abi::world_index::expedition_*_event`, the canonical identity
//! checks included: the host's home a LEGACY province of this Season's world,
//! the destination / standing a WIDE one, the holding, transit and province
//! addresses canonical) and the two parts of a pair are adjacent and carry the
//! same identity and receipt (a 148 without its 25, a 25 alone, a 149 without
//! its 26: blocker). What they change that the legacy indexes keep is applied
//! conservatively, as a hint the duties re-read: the home province touched
//! (a Depart's pending Spend, a SettleOrigin's freed entry, a member
//! settlement's returning host), a settled or failed holding's `pool_owed`
//! (`owes`), and the expedition's transit for keeper A's `expeditions` role
//! (P13, [`crate::expeditions`]). Still a blocker: PS2 145 (the legacy
//! source receipt of the wide CONQUEST kinds 12–18 only), the conquest PSW1
//! kinds 18–24, PSWC, PSWR and every other format, and anything that does not
//! decode or pair exactly.

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
    /// P9: the wide province `(P, Q)` each accounted PSW1 record names (`WideRecord::province_of`), for the
    /// `wide-resolve` role's province set; never applied to legacy state.
    pub wide_provinces: Vec<(i64, i64)>,
    /// The expedition records applied (P10), in log order.
    pub expedition: Vec<ExpeditionFact>,
}

/// The format of one expedition record line (P10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpTag {
    Ps2,
    Psw1,
    Psff,
    Psft,
}

/// What one decoded, paired expedition record tells the legacy indexes
/// (P10; module doc). Addresses are canonical (the codecs' identity checks);
/// `home` is the host's LEGACY home province.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpeditionFact {
    /// PS2 146: the Depart (`settle_origin` false) or the SettleOrigin of
    /// `holding`'s transit `slot` (record `external`) at bell `bell`.
    Source {
        settle_origin: bool,
        holding: Address,
        slot: u8,
        external: Address,
        home: (i16, i16),
        bell: u32,
    },
    /// PS2 147: a Reveal of `holding`'s transit `slot` (`Some`) or a Gather
    /// (`None`) at the wide destination `dest`.
    Producer {
        reveal: Option<(Address, u8, Address)>,
        dest: (i64, i64),
        bell: u32,
    },
    /// PS2 148 + PSW1 25: the member (or camp) settlement of the transit.
    Settled {
        holding: Address,
        external: Address,
        home: (i16, i16),
        camp: bool,
    },
    /// PS2 149 + PSW1 26: a resident Dissolve or Return of the host.
    Resident { holding: Address, home: (i16, i16) },
    /// PSFF v1/v2/v3: a failure, forfeit or retained-failure settlement.
    Failure {
        holding: Address,
        home: (i16, i16),
        slot: u8,
    },
    /// PSFT: the terminal close of the transit marker.
    Terminal { holding: Address, slot: u8 },
}

impl ExpeditionFact {
    /// The status counter name (`wide_accounted`).
    pub fn name(&self) -> &'static str {
        match self {
            Self::Source {
                settle_origin: false,
                ..
            } => "EXPEDITION_DEPART",
            Self::Source { .. } => "EXPEDITION_SETTLE_ORIGIN",
            Self::Producer {
                reveal: Some(_), ..
            } => "EXPEDITION_REVEAL",
            Self::Producer { .. } => "EXPEDITION_GATHER",
            Self::Settled { camp: false, .. } => "EXPEDITION_SETTLE_MEMBER",
            Self::Settled { .. } => "EXPEDITION_SETTLE_CAMP",
            Self::Resident { .. } => "EXPEDITION_RESIDENT",
            Self::Failure { .. } => "EXPEDITION_FAILURE",
            Self::Terminal { .. } => "EXPEDITION_TERMINAL",
        }
    }
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
    let mut wide_provinces = vec![];
    // (the accounted PSW1 lines and the expedition lines, left out of the PS2 extraction below)
    let mut skip = std::collections::BTreeSet::new();
    // (P10: the expedition record lines, decoded and paired after the frame check)
    let mut exp: Vec<(ExpTag, Vec<u8>)> = vec![];
    let b64 = |p: &str| base64::engine::general_purpose::STANDARD.decode(p).ok();
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
                // P10: the expedition kinds (PS2 146..=149, PSW1 25/26) and PSFF / PSFT, with a scope only
                // (PS2 145, the conquest kinds' legacy source receipt, is left to the PS2 codec: a blocker)
                if let (Some(_), Some(t), [_, b]) = (scope, tag.as_deref(), parts.as_slice()) {
                    let body = b64(b);
                    let kind = body.as_ref().and_then(|x| x.get(1).copied());
                    let et = match (t, kind) {
                        (b"PS2", Some(146..=149)) => Some(ExpTag::Ps2),
                        (b"PSW1", Some(25 | 26)) => Some(ExpTag::Psw1),
                        (b"PSFF", Some(_)) => Some(ExpTag::Psff),
                        (b"PSFT", Some(_)) => Some(ExpTag::Psft),
                        _ => None,
                    };
                    if let (Some(et), Some(body)) = (et, body) {
                        exp.push((et, body));
                        skip.insert(i);
                        continue;
                    }
                }
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
                    wide_provinces.extend(scope.province(&body));
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
    // (verify-pr121: the program never logs one record twice in an accepted transaction — every record carries
    //  its operation's receipt and entity links — so an exact repeat is a replay: blocker)
    if exp.iter().enumerate().any(|(i, a)| exp[..i].contains(a)) {
        return Err("unsupported expedition record: a record repeated in one transaction".into());
    }
    let expedition = match (scope, exp.is_empty()) {
        (_, true) => vec![],
        (Some(scope), false) => scope
            .expedition(&exp)
            .map_err(|e| format!("unsupported expedition record: {e}"))?,
        (None, false) => unreachable!("expedition lines are collected with a scope only"),
    };
    wide.extend(expedition.iter().map(ExpeditionFact::name));
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
    Ok(Bodies {
        ps2: bodies,
        wide,
        wide_provinces,
        expedition,
    })
}

/// What a legacy reader may account for in the wide world (P8). Without
/// `playable-lane` there is none: [`WideScope::of`] is `None` and every
/// PSW1 record is refused.
pub struct WideScope {
    #[cfg(feature = "playable-lane")]
    resolver: frontier_abi::world_index::expedition::AccountResolver,
    #[cfg(feature = "playable-lane")]
    ctx: frontier_abi::addr::AddrCtx,
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
                .map(|resolver| Self { resolver, ctx })
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

    /// P9: the wide province `(P, Q)` an ACCOUNTED PSW1 body names (call after [`Self::account`] accepted it).
    pub fn province(&self, body: &[u8]) -> Option<(i64, i64)> {
        #[cfg(feature = "playable-lane")]
        {
            let w = frontier_abi::world_index::event::WideRecord::decode(body).ok()?;
            let c = w.province_of()?.coord();
            Some((c.p(), c.q()))
        }
        #[cfg(not(feature = "playable-lane"))]
        {
            let _ = body;
            None
        }
    }

    /// P10 (module doc): the expedition records of ONE accepted transaction,
    /// in log order, decoded exactly and paired, as the facts the legacy
    /// indexes apply; any record that does not decode, pair or name this
    /// world's legacy home and wide destination is an error (a blocker).
    pub fn expedition(&self, lines: &[(ExpTag, Vec<u8>)]) -> Result<Vec<ExpeditionFact>, String> {
        #[cfg(feature = "playable-lane")]
        {
            self.expedition_lane(lines)
        }
        #[cfg(not(feature = "playable-lane"))]
        {
            let _ = lines;
            Err("this keeper reads no expedition record".into())
        }
    }

    #[cfg(feature = "playable-lane")]
    fn legacy_home(
        &self,
        host: &frontier_abi::world_index::WideHostRef,
    ) -> Result<(Address, (i16, i16)), String> {
        use frontier_abi::world_index::expedition::AccountFamily;
        let key = host.key();
        match self.resolver.family(key) {
            Ok(AccountFamily::Legacy) => {}
            Ok(AccountFamily::Wide) => {
                return Err("the host's home is not a legacy province".into())
            }
            Err(_) => return Err("the host is of another world".into()),
        }
        let holding = self
            .resolver
            .holding_address(host)
            .map_err(|e| format!("holding: {e:?}"))?;
        let c = key.coord();
        let (p, q) = (
            i16::try_from(c.p()).map_err(|_| "home coordinate")?,
            i16::try_from(c.q()).map_err(|_| "home coordinate")?,
        );
        Ok((Address::new_from_array(holding), (p, q)))
    }

    #[cfg(feature = "playable-lane")]
    fn wide_dest(&self, key: frontier_abi::world_index::ProvinceKey) -> Result<(i64, i64), String> {
        use frontier_abi::world_index::expedition::AccountFamily;
        match self.resolver.family(key) {
            Ok(AccountFamily::Wide) => Ok((key.coord().p(), key.coord().q())),
            Ok(AccountFamily::Legacy) => Err("the destination is not a wide province".into()),
            Err(_) => Err("the destination is of another world".into()),
        }
    }

    #[cfg(feature = "playable-lane")]
    fn expedition_lane(&self, lines: &[(ExpTag, Vec<u8>)]) -> Result<Vec<ExpeditionFact>, String> {
        use frontier_abi::world_index::{
            expedition_event as source, expedition_failure_event as failure,
            expedition_forfeit_event as forfeit, expedition_producer_event as producer,
            expedition_resident_event as resident, expedition_retained_failure_event as retained,
            expedition_settlement_event as settlement, expedition_terminal_event as terminal,
        };
        let ctx = &self.ctx;
        let adr = Address::new_from_array;
        let mut out = vec![];
        let mut i = 0;
        while i < lines.len() {
            let (tag, body) = (&lines[i].0, &lines[i].1);
            let kind = body.get(1).copied();
            match (tag, kind) {
                (ExpTag::Ps2, Some(source::KIND)) => {
                    let r =
                        source::Record::decode(ctx, body).map_err(|e| format!("PS2 146: {e:?}"))?;
                    let id = r.source.identity;
                    id.validate(ctx, r.source.receipt.action)
                        .map_err(|e| format!("PS2 146 identity: {e:?}"))?;
                    let (holding, _) = self.legacy_home(&id.host)?;
                    // (the province whose bell holds the host's pending Spend: the origin, validated legacy above)
                    let o = id.origin.coord();
                    let home = (
                        i16::try_from(o.p()).map_err(|_| "origin coordinate")?,
                        i16::try_from(o.q()).map_err(|_| "origin coordinate")?,
                    );
                    if holding.to_bytes() != id.holding {
                        return Err("PS2 146: the holding is not the host's".into());
                    }
                    out.push(ExpeditionFact::Source {
                        settle_origin: r.source.receipt.action == source::Action::SettleOrigin,
                        holding,
                        slot: id.slot,
                        external: adr(id.external),
                        home,
                        bell: r.source.bell,
                    });
                    i += 1;
                }
                (ExpTag::Ps2, Some(producer::KIND)) => {
                    let r = producer::Record::decode(ctx, body)
                        .map_err(|e| format!("PS2 147: {e:?}"))?;
                    r.target
                        .validate(ctx)
                        .map_err(|e| format!("PS2 147 identity: {e:?}"))?;
                    let dest = self.wide_dest(r.target.destination())?;
                    let reveal = match r.target {
                        producer::Target::Reveal { identity, .. } => {
                            let (holding, _) = self.legacy_home(&identity.host)?;
                            if holding.to_bytes() != identity.holding {
                                return Err("PS2 147: the holding is not the host's".into());
                            }
                            Some((holding, identity.transit_slot, adr(identity.external)))
                        }
                        producer::Target::Gather { .. } => None,
                    };
                    out.push(ExpeditionFact::Producer {
                        reveal,
                        dest,
                        bell: r.bell,
                    });
                    i += 1;
                }
                (ExpTag::Ps2, Some(settlement::ORIGINAL_KIND)) => {
                    // (a member or camp settlement: the PS2 part, then at once its PSW1 25 part)
                    let camp = body.get(6) == Some(&settlement::camp_v2::VERSION);
                    let decode = |b: &[u8]| -> Result<settlement::Record, String> {
                        if camp {
                            settlement::camp_v2::CampRecord::decode(ctx, b)
                                .map(|c| c.record)
                                .map_err(|e| format!("{e:?}"))
                        } else {
                            settlement::Record::decode(ctx, b).map_err(|e| format!("{e:?}"))
                        }
                    };
                    let a = decode(body).map_err(|e| format!("PS2 148: {e}"))?;
                    let Some((ExpTag::Psw1, wb)) = lines.get(i + 1) else {
                        return Err("PS2 148 without its PSW1 25 part".into());
                    };
                    if wb.get(1) != Some(&settlement::WIDE_KIND)
                        || (wb.get(6) == Some(&settlement::camp_v2::VERSION)) != camp
                    {
                        return Err("PS2 148 without its PSW1 25 part".into());
                    }
                    let b = decode(wb).map_err(|e| format!("PSW1 25: {e}"))?;
                    if a.identity != b.identity || a.receipt != b.receipt || a.bell != b.bell {
                        return Err("PS2 148 and PSW1 25 are not one settlement".into());
                    }
                    a.identity
                        .validate(ctx)
                        .map_err(|e| format!("PS2 148 identity: {e:?}"))?;
                    let (holding, home) = self.legacy_home(&a.identity.host)?;
                    self.wide_dest(a.identity.destination)?;
                    if holding.to_bytes() != a.identity.holding {
                        return Err("PS2 148: the holding is not the host's".into());
                    }
                    out.push(ExpeditionFact::Settled {
                        holding,
                        external: adr(a.identity.external),
                        home,
                        camp,
                    });
                    i += 2;
                }
                (ExpTag::Ps2, Some(resident::ORIGINAL_KIND)) => {
                    let a = resident::Record::decode(ctx, body)
                        .map_err(|e| format!("PS2 149: {e:?}"))?;
                    let Some((ExpTag::Psw1, wb)) = lines.get(i + 1) else {
                        return Err("PS2 149 without its PSW1 26 part".into());
                    };
                    if wb.get(1) != Some(&resident::WIDE_KIND) {
                        return Err("PS2 149 without its PSW1 26 part".into());
                    }
                    let b =
                        resident::Record::decode(ctx, wb).map_err(|e| format!("PSW1 26: {e:?}"))?;
                    if a.identity != b.identity
                        || a.receipt.operation_id != b.receipt.operation_id
                        || a.action != b.action
                        || a.bell != b.bell
                    {
                        return Err("PS2 149 and PSW1 26 are not one resident operation".into());
                    }
                    let (holding, home) = self.legacy_home(&a.identity.host)?;
                    self.wide_dest(a.identity.standing)?;
                    if holding.to_bytes() != a.identity.holding {
                        return Err("PS2 149: the holding is not the host's".into());
                    }
                    out.push(ExpeditionFact::Resident { holding, home });
                    i += 2;
                }
                (ExpTag::Psff, _) => {
                    let (host, dest, slot) = match body.get(4) {
                        Some(1) => failure::Receipt::decode(ctx, body)
                            .map(|r| (r.host, r.destination, r.slot))
                            .map_err(|e| format!("PSFF v1: {e:?}"))?,
                        Some(2) => forfeit::Receipt::decode(ctx, body)
                            .map(|r| (r.host, r.destination, r.slot))
                            .map_err(|e| format!("PSFF v2: {e:?}"))?,
                        Some(3) => retained::Receipt::decode(ctx, body)
                            .map(|r| (r.host, r.destination, r.slot))
                            .map_err(|e| format!("PSFF v3: {e:?}"))?,
                        v => return Err(format!("PSFF version {v:?}")),
                    };
                    let (holding, home) = self.legacy_home(&host)?;
                    self.wide_dest(dest)?;
                    out.push(ExpeditionFact::Failure {
                        holding,
                        home,
                        slot,
                    });
                    i += 1;
                }
                (ExpTag::Psft, _) => {
                    let r =
                        terminal::Receipt::decode(ctx, body).map_err(|e| format!("PSFT: {e:?}"))?;
                    let (holding, _) = self.legacy_home(&r.host)?;
                    out.push(ExpeditionFact::Terminal {
                        holding,
                        slot: r.slot,
                    });
                    i += 1;
                }
                (ExpTag::Psw1, k) => return Err(format!("PSW1 {k:?} without its PS2 part")),
                (ExpTag::Ps2, k) => return Err(format!("PS2 {k:?} is not an expedition record")),
            }
        }
        Ok(out)
    }
}
