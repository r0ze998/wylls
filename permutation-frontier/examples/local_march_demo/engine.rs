//! Private fixed-route sandbox (protocol v2). Initial images are explicit
//! fixtures; every transition is a real dispatcher call on a staged copy.
//! No network or keys.
//!
//! **One holding, one clock, one revision (v2).** The village economy —
//! Harvest, the fixed Farm Build (item 0) and the fixed Train (unit 0, 10
//! troops) — dispatches the program's real 0xDA op 3 `WideEconomy` handler
//! on the SAME citizen and holding images that Depart, SettleDeparture,
//! SettleTransit, Dissolve and Return write, inside the same serialized
//! controller. An economy command never moves the clock: it runs at the
//! instant the last phase step left. The clock moves only through the fixed
//! phase steps (bell 6 -> 8 -> 21 -> 22 -> 23 -> 25). There is no free time
//! advance, so no command can extend the destination's precomputed future
//! (it was resolved through bell 19 before export, while the session starts
//! at origin bell 6; see the protocol document's horizon section).
//!
//! **Economy judgement.** On top of the runtime's account, signer, lamport,
//! log and CPI checks and the receipt-kind and chain walk every handler gets
//! in [`Sandbox::invoke`], each economy command is judged by
//! [`judge_economy`]: every image other than the citizen and the holding is
//! byte-identical; the citizen changed only in its action bucket and action
//! stamp; the holding changed only in its chain header, its state
//! (provisional -> final only), tier, flags, owner-action stamp, kernel block
//! (stores, production, upkeep, queue, walls, shortfall) and, for Train, the
//! trained unit's reserve by exactly the count; the one receipt is
//! recomputed from the complete before/after bytes with the ABI digests and
//! its holding link walked. Transit, escrow, host identity and the wide
//! trailer are therefore provably untouched by the economy.
//!
//! **Per-instant budget.** At most [`ECONOMY_PER_INSTANT`] economy commands
//! run at one simulated instant (a demo transport budget, not a game rule).
//! Without a time control, an emptied action bucket at `ready` or `settled`
//! would otherwise leave Depart or Dissolve refused for good. The Season's
//! burst is 20 actions and refills one per minute; eight economy actions
//! plus the one player step at an instant always fit, and the phase steps
//! between those instants are at least ten simulated minutes apart.
use crate::runtime::{self, Image, Meta};
use frontier_abi::entry::read_entry;
use frontier_abi::prologue::bell_at;
use frontier_abi::world_index::economy::{self as weco, Action, EconomyReceipt, Snapshots};
use frontier_abi::world_index::{
    arrival as wa, event as ev, march::wide_host_alias, wide_ix as wix,
};
use frontier_abi::world_index::{
    MarchState, ProvinceKey, WideHolding, WideHostRef, WideProvince, WideTransit,
};
use permutation_frontier::layout::{
    chain_of, citizen as C, header, holding as H, province as PV, Ro,
};
use std::collections::BTreeMap;

pub const GENESIS: i64 = 1_790_444_847;
pub const INITIAL: i64 = GENESIS + 6 * 600 + 60;
/// The last bell any fixed phase step reaches (Return at bell 25 + 60 s).
pub const FINAL_BELL: u32 = 25;
/// Demo transport budget, not a game rule (module doc).
pub const ECONOMY_PER_INSTANT: u32 = 8;
/// The one Build this session offers: item 0, the Farm.
pub const FARM_ITEM: u8 = 0;
/// The one Train this session offers: unit 0, ten troops.
pub const TRAIN_UNIT: u8 = 0;
pub const TRAIN_COUNT: u32 = 10;
pub const ECONOMY_COMMANDS: [&str; 3] = ["harvest", "build_farm", "train"];
const FARM: Action = Action::Build { item: FARM_ITEM };
const TRAIN: Action = Action::Train {
    unit: TRAIN_UNIT,
    n: TRAIN_COUNT,
};
// The fixed actions write the holding alone (their table names the
// province read-only) and are in the handler's argument ranges.
const _: () = {
    assert!(!FARM.mirror_write());
    assert!(FARM.is_valid());
    assert!(TRAIN.is_valid());
    assert!(!TRAIN.mirror_write());
    assert!(!Action::Harvest.mirror_write());
};

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("FIXTURE_HEX".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "FIXTURE_HEX".into()))
        .collect()
}
fn r(n: &str) -> Meta {
    Meta {
        name: n.into(),
        signer: false,
        writable: false,
    }
}
fn w(n: &str) -> Meta {
    Meta {
        name: n.into(),
        signer: false,
        writable: true,
    }
}
fn s(n: &str, wr: bool) -> Meta {
    Meta {
        name: n.into(),
        signer: true,
        writable: wr,
    }
}
#[derive(Clone)]
pub struct Sandbox {
    pub images: BTreeMap<String, Image>,
    pub meta: BTreeMap<String, String>,
    pub now: i64,
    pub phase: &'static str,
    /// Committed economy commands of this session (since the last reset).
    pub harvests: u32,
    pub farm_builds: u32,
    pub trains: u32,
    /// Economy commands committed at the current simulated instant.
    pub instant_used: u32,
    pub records: Vec<Vec<u8>>,
    pub instructions: Vec<String>,
    pub arrival_survivors: Option<u32>,
    pub engagements: u32,
    pub credited: u32,
}
impl Sandbox {
    pub fn new() -> Result<Self, String> {
        let mut images = BTreeMap::new();
        for line in include_str!("fixtures/accounts.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let p: Vec<_> = line.split('\t').collect();
            if p.len() != 5 || images.len() >= 96 {
                return Err("FIXTURE_ACCOUNTS".into());
            }
            let a = Image {
                key: unhex(p[1])?.try_into().map_err(|_| "FIXTURE_KEY")?,
                owner: unhex(p[2])?.try_into().map_err(|_| "FIXTURE_OWNER")?,
                lamports: p[3].parse().map_err(|_| "FIXTURE_LAMPORTS")?,
                data: unhex(p[4])?,
            };
            if a.data.len() > 65536 || images.insert(p[0].into(), a).is_some() {
                return Err("FIXTURE_BOUND".into());
            }
        }
        let mut meta = BTreeMap::new();
        for line in include_str!("fixtures/metadata.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (k, v) = line.split_once('\t').ok_or("FIXTURE_META")?;
            if meta.insert(k.into(), v.into()).is_some() {
                return Err("FIXTURE_META".into());
            }
        }
        let x = Self {
            images,
            meta,
            now: INITIAL,
            phase: "ready",
            harvests: 0,
            farm_builds: 0,
            trains: 0,
            instant_used: 0,
            records: vec![],
            instructions: vec![],
            arrival_survivors: None,
            engagements: 0,
            credited: 0,
        };
        let host = x.host()?;
        let p = WideProvince::read(x.data("origin")?).map_err(|_| "FIXTURE_ORIGIN")?;
        let h = WideHolding::read(x.data("holding")?).map_err(|_| "FIXTURE_HOLDING")?;
        if host.key() != ProvinceKey::new(p.world, p.coord)
            || h.world != p.world
            || h.coord != p.coord
            || x.num("genesis")? != GENESIS as u64
        {
            return Err("FIXTURE_IDENTITY".into());
        }
        if x.num("origin_tile")? > 60 || x.num("destination_tile")? > 60 {
            return Err("FIXTURE_TILE".into());
        }
        // The economy acts on the holding the march departs from: its owner
        // is the fixture citizen and its reference is the host's holding.
        if h.owner_citizen != x.images["citizen"].key
            || h.site != host.site()
            || h.gen != host.gen()
        {
            return Err("FIXTURE_HOLDING_OWNER".into());
        }
        Ok(x)
    }
    pub fn data(&self, n: &str) -> Result<&[u8], String> {
        Ok(&self
            .images
            .get(n)
            .ok_or_else(|| format!("MISSING_{n}"))?
            .data)
    }
    pub fn num(&self, n: &str) -> Result<u64, String> {
        self.meta
            .get(n)
            .ok_or("MISSING_META")?
            .parse()
            .map_err(|_| "FIXTURE_NUMBER".into())
    }
    fn bytes<const N: usize>(&self, n: &str) -> Result<[u8; N], String> {
        unhex(self.meta.get(n).ok_or("MISSING_META")?)?
            .try_into()
            .map_err(|_| "FIXTURE_LENGTH".into())
    }
    pub fn host(&self) -> Result<WideHostRef, String> {
        WideHostRef::from_bytes(&self.bytes::<56>("host")?).map_err(|_| "FIXTURE_HOST".into())
    }
    /// The phase step this phase offers, if any.
    pub fn next_step(&self) -> Option<&'static str> {
        match self.phase {
            "ready" => Some("depart"),
            "departed" => Some("settle_departure"),
            "travelling" => Some("post_reveal"),
            "revealed" => Some("resolve_arrival"),
            "resolved" => Some("settle_transit"),
            "settled" => Some("dissolve_return"),
            _ => None,
        }
    }
    pub fn allowed(&self) -> Vec<&'static str> {
        let mut v = Vec::with_capacity(5);
        v.extend(self.next_step());
        if self.instant_used < ECONOMY_PER_INSTANT {
            v.extend(ECONOMY_COMMANDS);
        }
        v.push("reset");
        v
    }
    fn invoke(
        &mut self,
        name: &str,
        accounts: Vec<Meta>,
        data: impl AsRef<[u8]>,
        beacon: bool,
    ) -> Result<(), String> {
        let before = self.images.clone();
        let recs = runtime::dispatch(
            &mut self.images,
            &accounts,
            data.as_ref(),
            self.now,
            1000 + ((self.now - GENESIS) / 600) as u64,
            beacon,
        )
        .map_err(|e| format!("{e}:{name}"))?;
        if beacon {
            if !recs.is_empty() {
                return Err("BEACON_WIDE_RECEIPT".into());
            }
        } else {
            let expected = match name {
                "Depart" => ev::WideKind::Departed,
                "Harvest" | "BuildFarm" | "Train" => ev::WideKind::Economy,
                "Resolve" => ev::WideKind::Resolve,
                "SettleDeparture" => ev::WideKind::DepartureSettled,
                "Reveal" => ev::WideKind::Revealed,
                "Gather" => ev::WideKind::Gathered,
                "SettleTransit" => ev::WideKind::TransitSettled,
                "Dissolve" => ev::WideKind::Dissolve,
                "Return" => ev::WideKind::Return,
                _ => return Err("UNKNOWN_HANDLER".into()),
            };
            if recs.len() != 1
                || ev::WideRecord::decode(&recs[0]).map_err(|_| "RECORD")?.kind != expected
            {
                return Err("RECORD_KIND".into());
            }
        }
        // Independent receipt chain walking for all three affected wide identities.
        let host = self.host()?;
        for n in ["holding", "origin", "destination"] {
            let pre = &before[n].data;
            let post = self.data(n)?;
            let target = if n == "holding" {
                ev::WideTarget::Holding(host)
            } else {
                let p = WideProvince::read(pre).map_err(|_| "PROVINCE_IDENTITY")?;
                ev::WideTarget::Province(ProvinceKey::new(p.world, p.coord))
            };
            let a = chain_of(pre).map_err(|_| "CHAIN_PRE")?;
            let b = chain_of(post).map_err(|_| "CHAIN_POST")?;
            if ev::verify_chain(target, a, recs.iter().map(|v| v.as_slice())) != Ok(b) {
                return Err("CHAIN_MISMATCH".into());
            }
        }
        if !beacon && recs.is_empty() {
            return Err("MISSING_RECEIPT".into());
        }
        self.records.extend(recs);
        self.instructions.push(name.into());
        Ok(())
    }
    fn resolve(&mut self, where_: &str, bell: u32) -> Result<(), String> {
        let (c, a) = if bell == 20 {
            ("arrival_cache".into(), "arrival_anchor".into())
        } else {
            (
                format!("{where_}_cache_{bell}"),
                format!("{where_}_anchor_{bell}"),
            )
        };
        self.invoke(
            "Resolve",
            vec![
                s("payer", true),
                r("season"),
                w(where_),
                w(&format!("{where_}_roster")),
                r(&c),
                r(&a),
                w(&format!("{where_}_inputs_{bell}")),
                r(&format!("{where_}_day")),
                r("system"),
            ],
            wix::Resolve {
                bell,
                beneficiary: [0xd4; 32],
            }
            .to_bytes(),
            false,
        )
    }
    /// One economy action on the march's own holding: the real handler,
    /// then [`judge_economy`] over the complete before/after images.
    fn economy(&mut self, name: &str, action: Action) -> Result<(), String> {
        let data = wix::Economy { action }.to_bytes().ok_or("ECONOMY_ENCODE")?;
        let pre = self.images.clone();
        let first = self.records.len();
        self.invoke(
            name,
            vec![
                s("actor", false),
                s("payer", true),
                r("season"),
                w("citizen"),
                w("holding"),
                r("origin"),
            ],
            data,
            false,
        )?;
        let fresh = &self.records[first..];
        if fresh.len() != 1 {
            return Err("ECONOMY_RECORD_COUNT".into());
        }
        let record = fresh[0].clone();
        judge_economy(&pre, &self.images, action, self.now, &record)?;
        self.instant_used = self.instant_used.checked_add(1).ok_or("COUNTER")?;
        Ok(())
    }
    pub fn apply(&mut self, cmd: &str) -> Result<(), String> {
        if cmd == "reset" {
            return Err("BAD_PHASE".into());
        }
        if ECONOMY_COMMANDS.contains(&cmd) && self.instant_used >= ECONOMY_PER_INSTANT {
            return Err("INSTANT_BUDGET".into());
        }
        if !self.allowed().contains(&cmd) {
            return Err("BAD_PHASE".into());
        }
        let mut next = self.clone();
        next.records.clear();
        next.instructions.clear();
        next.step(cmd)?;
        if next.now < self.now {
            return Err("CLOCK_REGRESSION".into());
        }
        if next.now != self.now {
            next.instant_used = 0;
        }
        *self = next;
        Ok(())
    }
    fn step(&mut self, cmd: &str) -> Result<(), String> {
        let host = self.host()?;
        let faction = self.num("faction")? as u8;
        let region = self.num("region")? as u8;
        match cmd {
            "harvest" => {
                self.economy("Harvest", Action::Harvest)?;
                self.harvests = self.harvests.checked_add(1).ok_or("COUNTER")?;
            }
            "build_farm" => {
                self.economy("BuildFarm", FARM)?;
                self.farm_builds = self.farm_builds.checked_add(1).ok_or("COUNTER")?;
            }
            "train" => {
                self.economy("Train", TRAIN)?;
                self.trains = self.trains.checked_add(1).ok_or("COUNTER")?;
            }
            "depart" => {
                let mut a = vec![
                    s("actor", false),
                    s("payer", true),
                    r("season"),
                    w("citizen"),
                    w("holding"),
                    w("origin"),
                    r("system"),
                    r("origin"),
                ];
                for i in 0..4 {
                    a.push(if i == 0 {
                        w(&format!("transit_{i}"))
                    } else {
                        r(&format!("transit_{i}"))
                    })
                }
                a.push(r("origin_roster"));
                self.invoke(
                    "Depart",
                    a,
                    wix::Depart {
                        host: host.to_bytes(),
                        transit_slot: 0,
                        arrive_bell: 20,
                        tip: self.num("tip")?,
                        commit: self.bytes("commit")?,
                        seal: self.bytes("seal")?,
                    }
                    .to_bytes(),
                    false,
                )?;
                let t = WideTransit::from_bytes(self.data("transit_0")?)
                    .map_err(|_| "DEPART_TRANSIT")?;
                if t.state != MarchState::Departed || t.host != host {
                    return Err("DEPART_MISMATCH".into());
                }
                self.phase = "departed";
            }
            "settle_departure" => {
                self.now = GENESIS + 8 * 600 + 60;
                self.resolve("origin", 5)?;
                self.resolve("origin", 6)?;
                self.invoke(
                    "SettleDeparture",
                    vec![
                        s("payer", true),
                        r("season"),
                        w("origin"),
                        w("holding"),
                        w("origin_roster"),
                        w("transit_0"),
                    ],
                    wix::SettleDeparture {
                        host: host.to_bytes(),
                        transit_slot: 0,
                    }
                    .to_bytes(),
                    false,
                )?;
                if WideTransit::from_bytes(self.data("transit_0")?)
                    .map_err(|_| "TRANSIT")?
                    .state
                    != MarchState::Settled
                {
                    return Err("DEPART_SETTLEMENT".into());
                }
                self.phase = "travelling";
            }
            "post_reveal" => {
                self.now = GENESIS + 21 * 600 + 213;
                self.invoke(
                    "PostAnchor",
                    vec![
                        s("payer", true),
                        r("season"),
                        w("arrival_anchor"),
                        r("archive"),
                        r("ix_sysvar"),
                        r("system"),
                    ],
                    frontier_abi::ix::PostAnchor {
                        region,
                        bell: 20,
                        round: 32_551_361,
                        sig48: self.bytes("sig_t")?,
                        hints: self.bytes("hints_t")?,
                        beneficiary: [0xd4; 32],
                    }
                    .to_bytes(),
                    true,
                )?;
                self.now = GENESIS + 21 * 600 + 300;
                let mut a = vec![
                    s("payer", true),
                    r("season"),
                    r("holding"),
                    r("transit_0"),
                    r("arrival_anchor"),
                    r("archive"),
                    w("beacon_log"),
                    r("destination_inputs_20"),
                    r("destination"),
                    w("destination_day"),
                ];
                for i in 0..4 {
                    a.push(if i == 0 {
                        w(&format!("slot_{faction}_{i}"))
                    } else {
                        r(&format!("slot_{faction}_{i}"))
                    })
                }
                a.push(r("ix_sysvar"));
                a.push(r("system"));
                a.push(r("origin"));
                self.invoke(
                    "Reveal",
                    a,
                    wix::Reveal {
                        transit_slot: 0,
                        target_i: 0,
                        plain: self.bytes("plain")?,
                        salt: self.bytes("salt")?,
                        ct_hash: self.bytes("ct_hash")?,
                        beneficiary: [0xd4; 32],
                    }
                    .to_bytes(),
                    false,
                )?;
                self.phase = "revealed";
            }
            "resolve_arrival" => {
                self.now = GENESIS + 22 * 600 + 300;
                self.invoke(
                    "PostSeed",
                    vec![
                        s("payer", true),
                        r("season"),
                        r("arrival_anchor"),
                        w("arrival_cache"),
                        r("ix_sysvar"),
                        r("system"),
                    ],
                    frontier_abi::ix::PostSeed {
                        region,
                        bell: 20,
                        nonce: 0,
                        round: 32_551_652,
                        sig48: self.bytes("sig_s")?,
                        hints: self.bytes("hints_s")?,
                        beneficiary: [0xd4; 32],
                    }
                    .to_bytes(),
                    true,
                )?;
                let mut a = vec![
                    s("payer", true),
                    r("season"),
                    r("destination"),
                    r("arrival_anchor"),
                    w("destination_inputs_20"),
                    r("destination_day"),
                    r("ix_sysvar"),
                    r("system"),
                ];
                for j in 0..24 {
                    a.push(r(&format!("slot_{}_{}", j / 4, j % 4)));
                    a.push(if j == faction as usize * 4 {
                        w("transit_0")
                    } else {
                        r("system")
                    });
                }
                self.invoke(
                    "Gather",
                    a,
                    wix::Gather {
                        bell: 20,
                        start: 0,
                        n: 24,
                    }
                    .to_bytes(),
                    false,
                )?;
                self.resolve("destination", 20)?;
                let ar = wa::WideArrival::read_at(
                    self.data("destination_inputs_20")?,
                    faction as usize * 4,
                )
                .map_err(|_| "ARRIVAL")?
                .ok_or("ARRIVAL")?;
                if ar.host != host
                    || ar.fate != wa::wide_arrival::FATE_STAYS
                    || ar.troops_after == 0
                    || ar.troops_after >= 300_000
                {
                    return Err("HOSTILE_OUTCOME".into());
                }
                self.arrival_survivors = Some(ar.troops_after);
                self.engagements = Ro(self.data("destination")?)
                    .u32(PV::RESOLVE_SUMMARY + frontier_abi::layout::province::summary::ENGAGEMENTS)
                    .map_err(|_| "SUMMARY")?;
                if self.engagements == 0 {
                    return Err("NO_ENGAGEMENT".into());
                }
                self.phase = "resolved";
            }
            "settle_transit" => {
                self.now = GENESIS + 23 * 600 + 300;
                self.invoke(
                    "SettleTransit",
                    vec![
                        s("payer", true),
                        r("season"),
                        w("holding"),
                        w("destination"),
                        w("destination_inputs_20"),
                        w(&format!("slot_{faction}_0")),
                        w("origin"),
                        r("arrival_anchor"),
                        w("payer"),
                        w("payer"),
                        w("payer"),
                        w("payer"),
                        w("transit_0"),
                        w("origin_roster"),
                        r("system"),
                        w("destination_roster"),
                        w("payer"),
                    ],
                    wix::SettleTransit {
                        transit_slot: 0,
                        commit: self.bytes("commit")?,
                        seal: self.bytes("seal")?,
                        beneficiary: [0xd4; 32],
                    }
                    .to_bytes(),
                    false,
                )?;
                if !self.data("transit_0")?.is_empty()
                    || Ro(self.data("holding")?)
                        .u64(H::ESCROW)
                        .map_err(|_| "HOLDING")?
                        != 0
                {
                    return Err("SETTLEMENT_MISMATCH".into());
                }
                self.phase = "settled";
            }
            "dissolve_return" => {
                self.resolve("destination", 21)?;
                let mut a = vec![
                    s("actor", false),
                    s("payer", true),
                    r("season"),
                    w("citizen"),
                    w("holding"),
                    w("destination"),
                    r("destination_roster"),
                    r("origin"),
                ];
                for i in 0..4 {
                    a.push(r(&format!("transit_{i}")))
                }
                self.invoke(
                    "Dissolve",
                    a,
                    wix::Dissolve {
                        host: host.to_bytes(),
                    }
                    .to_bytes(),
                    false,
                )?;
                self.now = GENESIS + 24 * 600 + 60;
                self.resolve("destination", 22)?;
                self.now = GENESIS + FINAL_BELL as i64 * 600 + 60;
                self.resolve("destination", 23)?;
                let left = self.standing_milli()?;
                let old = Ro(self.data("holding")?)
                    .u32(H::reserve(0))
                    .map_err(|_| "HOLDING")?;
                let mut a = vec![
                    s("payer", true),
                    r("season"),
                    w("destination"),
                    w("destination_roster"),
                    w("holding"),
                ];
                for i in 0..4 {
                    a.push(r(&format!("transit_{i}")))
                }
                a.push(r("origin"));
                self.invoke("Return", a, wix::Return.to_bytes(), false)?;
                let new = Ro(self.data("holding")?)
                    .u32(H::reserve(0))
                    .map_err(|_| "HOLDING")?;
                // The credit is judged against the reserve just before Return,
                // whatever earlier Trains in this session added to it.
                if left == 0 || left >= 300_000 || new != old + left / 1000 {
                    return Err("RETURN_MISMATCH".into());
                }
                self.credited = left / 1000;
                self.phase = "returned";
            }
            _ => return Err("BAD_COMMAND".into()),
        }
        Ok(())
    }
    pub fn standing_milli(&self) -> Result<u32, String> {
        let alias = wide_host_alias(&self.host()?);
        for n in ["destination", "origin"] {
            for i in 0..PV::ENTRIES_N {
                let e = read_entry(self.data(n)?, i).map_err(|_| "ENTRY")?;
                if e.id == alias && e.state != 0 {
                    return Ok(e.troops);
                }
            }
        }
        Ok(0)
    }
    pub fn current_milli(&self) -> Result<u32, String> {
        if self.phase == "returned" {
            return Ok(self.credited * 1000);
        }
        if !self.data("transit_0")?.is_empty() {
            let t = WideTransit::from_bytes(self.data("transit_0")?).map_err(|_| "TRANSIT")?;
            if let Some(n) = self.arrival_survivors {
                return Ok(n);
            }
            // Depart has not resolved the origin clash yet: troops_after is
            // intentionally zero. The pending Spend entry is authoritative.
            if t.state == MarchState::Departed {
                return self.standing_milli();
            }
            return Ok(t.troops_after);
        }
        self.standing_milli()
    }
}

/// Whether every differing byte lies in an allowed `(offset, len)` range.
fn only_within(pre: &[u8], post: &[u8], allowed: &[(usize, usize)]) -> bool {
    pre.len() == post.len()
        && pre
            .iter()
            .zip(post)
            .enumerate()
            .all(|(i, (a, b))| a == b || allowed.iter().any(|(o, n)| i >= *o && i < o + n))
}

/// Judges one committed-candidate economy dispatch (module doc). `Err` is a
/// fault code; nothing of the stage is committed then.
pub(crate) fn judge_economy(
    pre: &BTreeMap<String, Image>,
    post: &BTreeMap<String, Image>,
    action: Action,
    now: i64,
    record: &[u8],
) -> Result<(), String> {
    if pre.len() != post.len() {
        return Err("ECONOMY_IMAGE_SET".into());
    }
    for (name, a) in pre {
        let b = post.get(name).ok_or("ECONOMY_IMAGE_SET")?;
        let village = name == "citizen" || name == "holding";
        if !village && a != b {
            return Err("ECONOMY_FOREIGN_WRITE".into());
        }
        if a.key != b.key
            || a.owner != b.owner
            || a.lamports != b.lamports
            || a.data.len() != b.data.len()
        {
            return Err("ECONOMY_ACCOUNT_META".into());
        }
    }
    let get = |m: &BTreeMap<String, Image>, n: &str| -> Result<Vec<u8>, String> {
        Ok(m.get(n).ok_or("ECONOMY_IMAGE_SET")?.data.clone())
    };
    let (c0, c1) = (get(pre, "citizen")?, get(post, "citizen")?);
    let (h0, h1) = (get(pre, "holding")?, get(post, "holding")?);
    let (p0, p1) = (get(pre, "origin")?, get(post, "origin")?);
    let season = get(pre, "season")?;
    // the citizen: its action bucket and action stamp only
    let citizen_allowed = [
        (C::BUCKET_MILLI, 4),
        (C::BUCKET_T, 4),
        (C::LAST_ACTION_TS, 8),
    ];
    if !only_within(&c0, &c1, &citizen_allowed) {
        return Err("ECONOMY_CITIZEN_BYTES".into());
    }
    if Ro(&c1)
        .i64(C::LAST_ACTION_TS)
        .map_err(|_| "ECONOMY_CITIZEN")?
        != now
    {
        return Err("ECONOMY_CITIZEN_STAMP".into());
    }
    // the holding: chain header, state, tier, flags, owner stamp, kernel
    // block, and for Train the trained unit's reserve; nothing else
    let mut holding_allowed = vec![
        (
            header::EVENT_SEQ,
            header::EVENT_HEAD + 32 - header::EVENT_SEQ,
        ),
        (H::STATE, 1),
        (H::TIER, 1),
        (H::FLAGS, 1),
        (H::LAST_OWNER_ACTION, 8),
        (H::STORES, H::FOOD_SHORTFALL + 8 - H::STORES),
    ];
    if let Action::Train { unit, .. } = action {
        holding_allowed.push((H::reserve(unit as usize), 4));
    }
    if !only_within(&h0, &h1, &holding_allowed) {
        return Err("ECONOMY_HOLDING_BYTES".into());
    }
    let (r0, r1) = (Ro(&h0), Ro(&h1));
    if r1
        .i64(H::LAST_OWNER_ACTION)
        .map_err(|_| "ECONOMY_HOLDING")?
        != now
    {
        return Err("ECONOMY_HOLDING_STAMP".into());
    }
    let (s0, s1) = (h0[H::STATE], h1[H::STATE]);
    let became_final = s0 == H::STATE_PROVISIONAL && s1 == H::STATE_FINAL;
    if s0 != s1 && !became_final {
        return Err("ECONOMY_HOLDING_STATE".into());
    }
    if let Action::Train { unit, n } = action {
        let at = H::reserve(unit as usize);
        let before = r0.u32(at).map_err(|_| "ECONOMY_HOLDING")?;
        let after = r1.u32(at).map_err(|_| "ECONOMY_HOLDING")?;
        if Some(after) != before.checked_add(n) {
            return Err("ECONOMY_RESERVE".into());
        }
    }
    // exactly the one receipt, recomputed over the complete bytes
    let rec = ev::WideRecord::decode(record).map_err(|_| "ECONOMY_RECORD")?;
    if rec.kind != action.kind() {
        return Err("ECONOMY_RECORD_KIND".into());
    }
    if Some(rec.bell) != bell_at(GENESIS, now) {
        return Err("ECONOMY_RECORD_BELL".into());
    }
    let hw = WideHolding::read(&h0).map_err(|_| "ECONOMY_HOLDING")?;
    let href = WideHostRef::new(ProvinceKey::new(hw.world, hw.coord), hw.site, hw.gen, 0)
        .map_err(|_| "ECONOMY_REF")?;
    let key = weco::economy_key(&href).map_err(|_| "ECONOMY_KEY")?;
    if rec.key != &key[..] {
        return Err("ECONOMY_RECORD_KEY".into());
    }
    let input = weco::input_digest(
        &href,
        action,
        now,
        &season,
        &Snapshots {
            citizen: &c0,
            holding: &h0,
            province: &p0,
        },
    )
    .map_err(|_| "ECONOMY_DIGEST")?;
    let output = weco::output_digest(
        &href,
        action,
        now,
        became_final,
        &Snapshots {
            citizen: &c1,
            holding: &h1,
            province: &p1,
        },
    )
    .map_err(|_| "ECONOMY_DIGEST")?;
    let want = EconomyReceipt {
        action,
        now_ts: now,
        became_final,
        input_digest: input,
        output_digest: output,
    };
    if rec.receipt() != Some(want) {
        return Err("ECONOMY_RECEIPT".into());
    }
    // the holding chain advanced by exactly this record; no province link
    let h_pre = chain_of(&h0).map_err(|_| "ECONOMY_CHAIN")?;
    let h_post = chain_of(&h1).map_err(|_| "ECONOMY_CHAIN")?;
    let lh = rec.link(ev::WideEntity::Holding).ok_or("ECONOMY_CHAIN")?;
    if Some(lh.seq) != h_pre.0.checked_add(1) || (lh.seq, lh.head) != h_post {
        return Err("ECONOMY_HOLDING_CHAIN".into());
    }
    if rec.link(ev::WideEntity::Province).is_some() {
        return Err("ECONOMY_PROVINCE_LINK".into());
    }
    if ev::verify_chain(
        ev::WideTarget::Holding(href),
        h_pre,
        std::iter::once(record),
    ) != Ok(h_post)
    {
        return Err("ECONOMY_CHAIN_WALK".into());
    }
    Ok(())
}

#[cfg(test)]
mod economy_judge_tests {
    use super::*;
    /// A real Harvest on a staged copy; the judge accepts it, and refuses
    /// every hand-made deviation from it. Nothing here is committed.
    #[test]
    fn judge_accepts_the_real_dispatch_and_refuses_tampering() {
        let base = Sandbox::new().unwrap();
        let mut staged = base.clone();
        staged.economy("Harvest", Action::Harvest).unwrap();
        let record = staged.records.last().unwrap().clone();
        let (pre, post) = (&base.images, &staged.images);
        assert_eq!(
            judge_economy(pre, post, Action::Harvest, base.now, &record),
            Ok(())
        );
        // the same bytes are not a Train's (no reserve credit, other receipt)
        assert!(judge_economy(pre, post, TRAIN, base.now, &record).is_err());
        // another instant is not the receipt's
        assert!(judge_economy(pre, post, Action::Harvest, base.now + 1, &record).is_err());
        // a write anywhere else (the destination) is a fault
        let mut foreign = post.clone();
        foreign.get_mut("destination").unwrap().data[100] ^= 1;
        assert_eq!(
            judge_economy(pre, &foreign, Action::Harvest, base.now, &record),
            Err("ECONOMY_FOREIGN_WRITE".into())
        );
        // escrow, transit and trailer bytes of the holding are not the economy's
        for at in [H::ESCROW, H::transit(0), H::POOL_OWED, 1286] {
            let mut t = post.clone();
            t.get_mut("holding").unwrap().data[at] ^= 1;
            assert_eq!(
                judge_economy(pre, &t, Action::Harvest, base.now, &record),
                Err("ECONOMY_HOLDING_BYTES".into()),
                "offset {at}"
            );
        }
        // a lamport move is a fault even on a writable account
        let mut lam = post.clone();
        lam.get_mut("holding").unwrap().lamports += 1;
        assert_eq!(
            judge_economy(pre, &lam, Action::Harvest, base.now, &record),
            Err("ECONOMY_ACCOUNT_META".into())
        );
        // a stage the handler did not produce is not the receipt's output
        let mut store = post.clone();
        store.get_mut("holding").unwrap().data[H::store(1)] ^= 1;
        assert!(judge_economy(pre, &store, Action::Harvest, base.now, &record).is_err());
        // a tampered record is no receipt
        let mut bad = record.clone();
        let n = bad.len();
        bad[n - 40] ^= 1;
        assert!(judge_economy(pre, post, Action::Harvest, base.now, &bad).is_err());
        // and the base sandbox never changed
        assert_eq!(base.images, Sandbox::new().unwrap().images);
    }
}
