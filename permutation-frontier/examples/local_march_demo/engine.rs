//! Private march sandbox (protocol v4; the recorded route since v2, a chosen
//! one since v4). Initial images are explicit
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
//!
//! **v4: one march binding.** `depart` binds the recorded order to the
//! recorded destination (unchanged handler path); `depart_route`
//! (`chosen_march.rs`) binds an order rebuilt from public material to a
//! chosen, session-opened province. The binding is separate from the map: the
//! `destination` image and every fixture name keep their bytes and meaning.
//! Every phase step after the departure follows the bound march. Receipt
//! chains are walked for the holding and **every** wide province held.
use crate::chosen_march::MarchBinding;
use crate::land_bootstrap as land;
use crate::runtime::{self, Image, Meta};
use frontier_abi::entry::read_entry;
use frontier_abi::prologue::bell_at;
use frontier_abi::world_index::economy::{self as weco, Action, EconomyReceipt, Snapshots};
use frontier_abi::world_index::index::{IndexEntry, IndexError, Lookup, ReportedState};
use frontier_abi::world_index::tiles::{
    verify_route, RouteBounds, RouteError, TileAddress, WideTile,
};
use frontier_abi::world_index::{
    arrival as wa, event as ev, march::wide_host_alias, wide_ix as wix,
};
use frontier_abi::world_index::{
    MarchState, ProvinceKey, WideCoord, WideHolding, WideHostRef, WideProvince, WideTransit,
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
/// Longest chosen path a route quote accepts (the legacy march limit).
pub const MAX_ROUTE_DIRS: usize = 32;
/// A province exported with the initial fixture (origin, destination).
pub const SOURCE_FIXTURE: &str = "fixture";
/// A province the real WideOpenProvince opened in this session.
pub const SOURCE_OPENED: &str = "opened";

/// One wide province the sandbox holds, decoded from its own bytes.
#[derive(Clone, Debug)]
pub struct KnownProvince {
    pub name: String,
    pub source: &'static str,
    pub province: WideProvince,
    pub passable_mask: u64,
    pub resolved_next: u32,
    pub opened_bell: u32,
}
impl KnownProvince {
    fn read(name: &str, source: &'static str, data: &[u8]) -> Result<Self, String> {
        let province = WideProvince::read(data).map_err(|_| format!("PROVINCE:{name}"))?;
        let r = Ro(data);
        Ok(Self {
            name: name.into(),
            source,
            province,
            passable_mask: r.u64(PV::PASSABLE_MASK).map_err(|_| "MASK")?,
            resolved_next: r.u32(PV::RESOLVED_NEXT).map_err(|_| "RESOLVED_NEXT")?,
            opened_bell: r
                .u32(frontier_abi::v2::layout::province::province::OPENED_BELL)
                .map_err(|_| "OPENED_BELL")?,
        })
    }
}
const _: () = assert!(MAX_ROUTE_DIRS == RouteBounds::LEGACY.max_steps());
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
    /// v4: the departed march (recorded or chosen); `None` while ready.
    pub march: Option<MarchBinding>,
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
            march: None,
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
        // The LOCAL land records (synthetic ring-129 seed, prototype candidate
        // rules, local funds), admitted only after the golden re-opening of
        // both exported provinces. Part of the baseline: Reset rebuilds it.
        let mut x = x;
        land::install(&mut x.images, &x.meta).map_err(|e| format!("LAND_INSTALL:{e}"))?;
        Ok(x)
    }
    /// Every wide province this sandbox holds, in a fixed order: the two
    /// exported fixtures (origin, destination), then the provinces opened in
    /// this session by the real WideOpenProvince, by name. Each with its
    /// decoded identity and real passability mask.
    pub fn provinces(&self) -> Result<Vec<KnownProvince>, String> {
        let mut out = Vec::with_capacity(2 + land::MAX_EXTRA_PROVINCES);
        for (name, source) in [("origin", SOURCE_FIXTURE), ("destination", SOURCE_FIXTURE)] {
            out.push(KnownProvince::read(name, source, self.data(name)?)?);
        }
        for (name, im) in &self.images {
            if name.starts_with(land::PROVINCE_PREFIX) {
                out.push(KnownProvince::read(name, SOURCE_OPENED, &im.data)?);
            }
        }
        if out.len() > 2 + land::MAX_EXTRA_PROVINCES {
            return Err("LAND_BUDGET_EXCEEDED".into());
        }
        Ok(out)
    }
    /// Provinces opened in this session (beyond the two fixtures).
    pub fn opened_count(&self) -> usize {
        self.images
            .keys()
            .filter(|n| n.starts_with(land::PROVINCE_PREFIX))
            .count()
    }
    /// Opens the ring-129 province `(p, q)` with the real WideOpenProvince at
    /// this sandbox's simulated clock (`slot = 1000 + bell`), through the
    /// land module's staged, judged, all-or-nothing path. It never moves the
    /// clock, touches the holding, the citizen or the march, or emits a
    /// receipt (the handler logs nothing). The demo budget of four is the
    /// module's.
    pub fn open_province(&mut self, p: i64, q: i64) -> Result<land::OpenedProvince, String> {
        let mut next = self.clone();
        next.records.clear();
        next.instructions.clear();
        let slot = 1000 + ((next.now - GENESIS) / 600) as u64;
        let opened = land::open_province(&mut next.images, p, q, next.now, slot)?;
        next.instructions.push("WideOpenProvince".into());
        *self = next;
        Ok(opened)
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
    pub(crate) fn bytes<const N: usize>(&self, n: &str) -> Result<[u8; N], String> {
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
        let mut v = Vec::with_capacity(8);
        v.extend(self.next_step());
        // v4: a chosen-route departure, while ready, once a province opened
        // in this session exists (no other province can be its destination).
        if self.phase == "ready" && self.opened_count() > 0 {
            v.push("depart_route");
        }
        if self.instant_used < ECONOMY_PER_INSTANT {
            v.extend(ECONOMY_COMMANDS);
        }
        if self.opened_count() < land::MAX_EXTRA_PROVINCES {
            v.push("open_province");
        }
        v.push("reset");
        v
    }
    pub(crate) fn invoke(
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
        // Independent receipt chain walking (v4): the holding and every wide
        // province the sandbox holds, opened ones included.
        let host = self.host()?;
        verify_chains(host, &before, &self.images, &recs)?;
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
        // Reset, opening and the chosen departure have their own entry points
        // (opening needs P, Q; `depart_route` needs DIRS).
        if cmd == "reset" || cmd == "open_province" || cmd == "depart_route" {
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
    pub(crate) fn step(&mut self, cmd: &str) -> Result<(), String> {
        let host = self.host()?;
        let faction = self.num("faction")? as u8;
        let region = self.num("region")? as u8;
        match cmd {
            // v4: a chosen march follows its own binding from here on
            // (`chosen_march.rs`); settle_departure is the origin's alone and
            // is shared. The recorded march keeps the arms below unchanged.
            "post_reveal" if self.is_chosen() => self.chosen_post_reveal()?,
            "resolve_arrival" if self.is_chosen() => self.chosen_resolve_arrival()?,
            "settle_transit" if self.is_chosen() => self.chosen_settle_transit()?,
            "dissolve_return" if self.is_chosen() => self.chosen_dissolve_return()?,
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
                let departed = self.standing_milli()?;
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
                // v4: the recorded order to the recorded destination, bound
                // explicitly (the map's `destination` is not repointed).
                self.march = Some(self.recorded_binding(departed)?);
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
        // The bound march's destination (v4: possibly a chosen province),
        // else the recorded one, as before.
        let dest = self
            .march
            .as_ref()
            .map_or("destination", |m| m.dest_name.as_str());
        for n in [dest, "origin"] {
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
    /// A read-only validation of a player-chosen path over every province this
    /// host holds (the two fixtures and any opened in this session by the real
    /// WideOpenProvince), using the shared ABI route model
    /// (`verify_route`) and the provinces' real passability bytes. It mutates
    /// nothing: no account, clock, phase, revision or record, and emits no
    /// receipt. It does **not** execute a march: `depart` sends the recorded
    /// order and `depart_route` (v4) recomputes this quote itself before it
    /// sends a rebuilt one. A step into a province
    /// this host did not return is refused as unknown land (`UNKNOWN_PROVINCE`),
    /// never treated as open ground; a step onto an impassable tile is
    /// `IMPASSABLE`, read from that province's real mask; a step past the
    /// ±2^62 world bound is `OFF_WORLD`.
    pub fn quote_route(&self, dirs: &[u8]) -> Result<Quote, String> {
        if dirs.len() > MAX_ROUTE_DIRS {
            return Err("ROUTE_LEN".into());
        }
        // Every province this host holds: the two fixtures and every province
        // opened in this session, each with its own real mask.
        let known = self.provinces()?;
        let origin = known[0].province;
        let world = origin.world;
        if known.iter().any(|k| k.province.world != world) {
            return Err("WORLD".into());
        }
        let keys: Vec<ProvinceKey> = known
            .iter()
            .map(|k| ProvinceKey::new(world, k.province.coord))
            .collect();
        let origin_key = keys[0];
        let start_tile = self.num("origin_tile")? as u8;
        let start = WideTile::of(TileAddress::new(origin_key, start_tile).map_err(|_| "TILE")?);
        let mask_of = |coord: WideCoord| -> Option<u64> {
            known
                .iter()
                .find(|k| k.province.coord == coord)
                .map(|k| k.passable_mask)
        };
        let passable = |coord: WideCoord, local: u8| -> Option<bool> {
            mask_of(coord).map(|m| local < 64 && ((m >> local) & 1) == 1)
        };
        let mut steps: Vec<WideTile> = Vec::with_capacity(dirs.len());
        let mut meta: Vec<QStep> = Vec::with_capacity(dirs.len());
        let mut cur = start;
        let start_meta = (origin.coord.p(), origin.coord.q(), start_tile);
        for (i, &d) in dirs.iter().enumerate() {
            if d >= 6 {
                return Err("DIRECTION".into());
            }
            let Some(next) = cur.neighbors()[d as usize] else {
                // The ±2^62 world bound, not infinity.
                return Ok(Quote {
                    start: start_meta,
                    reachable: false,
                    reason: Some("OFF_WORLD"),
                    blocked_step: Some(i),
                    steps: meta,
                    end: None,
                    provinces: vec![],
                });
            };
            let coord = next.province_coord();
            meta.push(QStep {
                p: coord.p(),
                q: coord.q(),
                tile: next.local(),
                known: mask_of(coord).is_some(),
                passable: passable(coord, next.local()),
            });
            steps.push(next);
            cur = next;
        }
        let src = |key: &ProvinceKey| -> Result<Lookup, IndexError> {
            for &k in &keys {
                if *key == k {
                    return Ok(Lookup::Known(IndexEntry {
                        key: k,
                        revision: 1,
                        state: ReportedState::Open,
                        observed_at: 1,
                    }));
                }
            }
            Ok(Lookup::Unknown)
        };
        match verify_route(world, &start, &steps, RouteBounds::LEGACY, &src) {
            Ok(route) => {
                // verify_route checks structure, not terrain; an impassable tile
                // (from the province's own mask) still makes the route unreachable.
                // The invariant held here and checked by the browser: reachable
                // iff there is an end and no reason.
                let blocked = meta.iter().position(|m| m.passable == Some(false));
                let reachable = blocked.is_none();
                let end = if reachable {
                    let c = route.end.key().coord();
                    Some((c.p(), c.q(), route.end.local()))
                } else {
                    None
                };
                let provinces = if reachable {
                    route
                        .provinces
                        .iter()
                        .map(|k| (k.coord().p(), k.coord().q()))
                        .collect()
                } else {
                    vec![]
                };
                Ok(Quote {
                    start: start_meta,
                    reachable,
                    reason: if reachable { None } else { Some("IMPASSABLE") },
                    blocked_step: blocked,
                    steps: meta,
                    end,
                    provinces,
                })
            }
            Err(e) => {
                let (reason, blocked) = route_reason(&e, &meta);
                Ok(Quote {
                    start: start_meta,
                    reachable: false,
                    reason: Some(reason),
                    blocked_step: blocked,
                    steps: meta,
                    end: None,
                    provinces: vec![],
                })
            }
        }
    }
}

/// One step of a route quote: the province coordinate and local tile it
/// enters, whether this host returned that province's bytes, and the tile's
/// passability read from that province's real mask (`None` when unknown).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QStep {
    pub p: i64,
    pub q: i64,
    pub tile: u8,
    pub known: bool,
    pub passable: Option<bool>,
}

/// The read-only result of [`Sandbox::quote_route`]. Not a sent march: no
/// account, clock, phase, revision or record changes to produce it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub start: (i64, i64, u8),
    pub reachable: bool,
    pub reason: Option<&'static str>,
    pub blocked_step: Option<usize>,
    pub steps: Vec<QStep>,
    pub end: Option<(i64, i64, u8)>,
    pub provinces: Vec<(i64, i64)>,
}

/// A fixed token (and the step it concerns, when the model names one) for a
/// route the shared model refused.
fn route_reason(e: &RouteError, meta: &[QStep]) -> (&'static str, Option<usize>) {
    let first_unknown = meta.iter().position(|m| !m.known);
    match e {
        RouteError::EmptyRoute => ("EMPTY", None),
        RouteError::Bounds { .. } => ("BOUNDS", None),
        RouteError::TooLong { .. } => ("TOO_LONG", None),
        RouteError::WorldMismatch { .. } => ("WORLD", None),
        RouteError::NotAdjacent { step } => ("NOT_ADJACENT", Some(*step as usize)),
        RouteError::TooManyProvinces { step, .. } => ("TOO_MANY_PROVINCES", Some(*step as usize)),
        RouteError::UnknownProvince { .. } => ("UNKNOWN_PROVINCE", first_unknown),
        RouteError::ClosedProvince { .. } => ("CLOSED_PROVINCE", first_unknown),
        RouteError::SourceKeyMismatch { .. } => ("SOURCE_MISMATCH", None),
        RouteError::Source(_) => ("SOURCE", None),
    }
}

/// Walks the receipt chain of the holding and of **every** wide province in
/// `before` (the two fixtures and every province opened in this session), each
/// from its bytes before to its bytes after, through `recs`
/// (`event::verify_chain` takes exactly the records that concern that
/// target). A chain that moved without its receipts, or a receipt whose link
/// does not follow, is `CHAIN_MISMATCH`; a walked image missing after is
/// `CHAIN_POST`. Images added by `recs`' instruction are not chained
/// accounts (none of the march's created records carries a wide chain).
pub(crate) fn verify_chains(
    host: WideHostRef,
    before: &BTreeMap<String, Image>,
    after: &BTreeMap<String, Image>,
    recs: &[Vec<u8>],
) -> Result<(), String> {
    for (n, pre) in before {
        let target = if n == "holding" {
            ev::WideTarget::Holding(host)
        } else if n == "origin" || n == "destination" || n.starts_with(land::PROVINCE_PREFIX) {
            let p = WideProvince::read(&pre.data).map_err(|_| "PROVINCE_IDENTITY")?;
            ev::WideTarget::Province(ProvinceKey::new(p.world, p.coord))
        } else {
            continue;
        };
        let post = &after.get(n).ok_or("CHAIN_POST")?.data;
        let a = chain_of(&pre.data).map_err(|_| "CHAIN_PRE")?;
        let b = chain_of(post).map_err(|_| "CHAIN_POST")?;
        if ev::verify_chain(target, a, recs.iter().map(|v| v.as_slice())) != Ok(b) {
            return Err("CHAIN_MISMATCH".into());
        }
    }
    Ok(())
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

#[cfg(test)]
mod route_quote_tests {
    use super::*;
    /// The recorded march's directions, hex-decoded from the fixture.
    fn recorded(c: &Sandbox) -> Vec<u8> {
        unhex(c.meta.get("directions").unwrap()).unwrap()
    }
    #[test]
    fn the_recorded_directions_reach_the_opened_destination_and_nothing_mutates() {
        let c = Sandbox::new().unwrap();
        let before = c.images.clone();
        let dirs = recorded(&c);
        let q = c.quote_route(&dirs).unwrap();
        // the fixture's own route ends at (129,-1, 34) on really-opened land
        assert_eq!(q.end, Some((129, -1, 34)));
        assert!(q.reachable, "reason {:?}", q.reason);
        assert_eq!(q.reason, None);
        assert_eq!(q.steps.len(), dirs.len());
        assert!(q.steps.iter().all(|s| s.known && s.passable == Some(true)));
        assert!(q.provinces.contains(&(129, -1)));
        // a query mutates nothing
        assert_eq!(c.images, before);
        assert_eq!(c.phase, "ready");
    }
    #[test]
    fn walking_past_the_two_known_provinces_is_refused_as_unknown_land() {
        let c = Sandbox::new().unwrap();
        // The recorded direction, continued exactly one step into the first
        // province this host did not return. The index comes from the real
        // fixture geometry (`first_unknown_step`), not from an assumed length.
        let d = recorded(&c)[0];
        let i = first_unknown_step(&c, d)
            .expect("a straight line leaves two radius-4 provinces within 32 steps");
        let q = c.quote_route(&vec![d; i + 1]).unwrap();
        assert!(!q.reachable);
        assert_eq!(q.end, None);
        assert_eq!(q.reason, Some("UNKNOWN_PROVINCE"));
        assert_eq!(q.blocked_step, Some(i));
        assert!(q.provinces.is_empty());
        assert!(q.steps[..i].iter().all(|s| s.known));
        assert!(!q.steps[i].known && q.steps[i].passable.is_none());
        // one step shorter stays on returned land: never refused as unknown
        if i > 0 {
            let short = c.quote_route(&vec![d; i]).unwrap();
            assert_ne!(short.reason, Some("UNKNOWN_PROVINCE"));
            assert!(short.steps.iter().all(|s| s.known));
        }
    }
    #[test]
    fn bounds_and_bad_directions_are_refused_without_a_quote() {
        let c = Sandbox::new().unwrap();
        assert_eq!(
            c.quote_route(&[0u8; MAX_ROUTE_DIRS + 1]),
            Err("ROUTE_LEN".into())
        );
        assert_eq!(c.quote_route(&[6]), Err("DIRECTION".into()));
        assert_eq!(c.quote_route(&[0, 9]), Err("DIRECTION".into()));
        // an empty path is the model's EmptyRoute, not a reachable destination
        let q = c.quote_route(&[]).unwrap();
        assert!(!q.reachable && q.reason == Some("EMPTY") && q.end.is_none());
    }
    #[test]
    fn the_longest_accepted_path_is_refused_at_its_first_unknown_step() {
        // NOT covered here: the OFF_WORLD branch (a step past the ±2^62 world
        // bound). The fixture's provinces lie at ring 129, far from the bound,
        // so no fixture test reaches it.
        let c = Sandbox::new().unwrap();
        let d = recorded(&c)[0];
        let i = first_unknown_step(&c, d).unwrap();
        let q = c.quote_route(&[d; MAX_ROUTE_DIRS]).unwrap();
        assert_eq!(q.steps.len(), MAX_ROUTE_DIRS);
        assert_eq!(q.reason, Some("UNKNOWN_PROVINCE"));
        assert_eq!(q.blocked_step, Some(i));
        assert_eq!(q.end, None);
    }
}

/// Test-only: the 0-based index of the first step, walking `d` from the
/// host's origin tile, whose province is none of those this host holds
/// (`None` if none within the 32-step bound). Real geometry via the ABI.
#[cfg(test)]
pub(crate) fn first_unknown_step(c: &Sandbox, d: u8) -> Option<usize> {
    first_unknown(c, d).map(|(i, _)| i)
}

/// Test-only: as [`first_unknown_step`], with that step's province.
#[cfg(test)]
pub(crate) fn first_unknown(c: &Sandbox, d: u8) -> Option<(usize, WideCoord)> {
    let known: Vec<WideCoord> = c
        .provinces()
        .ok()?
        .iter()
        .map(|k| k.province.coord)
        .collect();
    let o = WideProvince::read(c.data("origin").ok()?).ok()?;
    let tile = c.num("origin_tile").ok()? as u8;
    let mut cur = WideTile::of(TileAddress::new(ProvinceKey::new(o.world, o.coord), tile).ok()?);
    for i in 0..MAX_ROUTE_DIRS {
        cur = cur.neighbors()[d as usize]?;
        let p = cur.province_coord();
        if !known.contains(&p) {
            return Some((i, p));
        }
    }
    None
}

#[cfg(test)]
mod land_integration_tests {
    use super::*;
    fn recorded(c: &Sandbox) -> u8 {
        unhex(c.meta.get("directions").unwrap()).unwrap()[0]
    }
    #[test]
    fn the_baseline_carries_the_installed_land_records_and_reset_rebuilds_them() {
        let a = Sandbox::new().unwrap();
        for n in [land::RING_SEED_NAME, land::RULES_CONFIG_NAME] {
            assert!(a.images.contains_key(n), "{n}");
        }
        for w in 0..6u8 {
            assert!(a.images.contains_key(&land::fund_name(w)));
        }
        assert_eq!(a.opened_count(), 0);
        assert_eq!(a.provinces().unwrap().len(), 2);
        // a second construction is byte-identical (no clock or randomness)
        assert_eq!(a.images, Sandbox::new().unwrap().images);
    }
    #[test]
    fn opening_runs_the_real_handler_at_the_sandbox_clock_and_touches_nothing_else() {
        let mut c = Sandbox::new().unwrap();
        let before = c.clone();
        let o = c.open_province(129, -2).unwrap();
        assert_eq!((o.p, o.q, o.opened_bell), (129, -2, 6));
        assert_eq!(o.provenance, land::PROVENANCE_OPENED);
        assert_eq!(c.instructions, vec!["WideOpenProvince".to_string()]);
        assert!(c.records.is_empty(), "the handler emits no receipt");
        // the clock, phase, counters and the march/village images are untouched
        assert_eq!(
            (c.now, c.phase, c.instant_used),
            (before.now, before.phase, 0)
        );
        for n in [
            "holding",
            "citizen",
            "origin",
            "destination",
            "season",
            "payer",
        ] {
            assert_eq!(c.images[n], before.images[n], "{n}");
        }
        assert_eq!(c.opened_count(), 1);
        let ps = c.provinces().unwrap();
        assert_eq!(ps.len(), 3);
        assert_eq!(ps[2].source, SOURCE_OPENED);
        assert_eq!(
            (ps[2].province.coord.p(), ps[2].province.coord.q()),
            (129, -2)
        );
        assert_eq!((ps[2].opened_bell, ps[2].resolved_next), (6, 6));
        // the march still runs on the same sandbox afterwards
        c.apply("depart").unwrap();
        assert_eq!(c.phase, "departed");
    }
    #[test]
    fn a_quote_into_a_newly_opened_province_is_no_longer_unknown_land() {
        let mut c = Sandbox::new().unwrap();
        let d = recorded(&c);
        let (i, coord) = first_unknown(&c, d).expect("the line leaves the fixtures");
        assert_eq!(
            coord.ring(),
            land::LAND_RING,
            "the first unknown neighbour is ring 129"
        );
        let before = c.quote_route(&vec![d; i + 1]).unwrap();
        assert_eq!(before.reason, Some("UNKNOWN_PROVINCE"));
        c.open_province(coord.p(), coord.q()).unwrap();
        let after = c.quote_route(&vec![d; i + 1]).unwrap();
        // the step that was unknown now lies on host-returned land, with the
        // opened province's own passability bit
        assert!(after.steps[i].known);
        assert!(after.steps[i].passable.is_some());
        assert_ne!(after.reason, Some("UNKNOWN_PROVINCE"));
        if after.reachable {
            assert_eq!(after.end, Some((coord.p(), coord.q(), after.steps[i].tile)));
            assert!(after.provinces.contains(&(coord.p(), coord.q())));
        } else {
            assert_eq!(after.reason, Some("IMPASSABLE"));
        }
        // and the first unknown step moved further along the line, if any
        if let Some(j) = first_unknown_step(&c, d) {
            assert!(j > i);
        }
    }
    #[test]
    fn failed_openings_change_nothing() {
        let mut c = Sandbox::new().unwrap();
        let before = c.images.clone();
        for (p, q, want) in [
            (128, 0, "LAND_NOT_RING_129"),
            (130, 0, "LAND_NOT_RING_129"),
            (129, 0, "LAND_DUPLICATE_OPEN"),
            (129, -1, "LAND_DUPLICATE_OPEN"),
            (i64::MAX, 0, "LAND_COORD_BOUNDS"),
        ] {
            assert_eq!(c.open_province(p, q).unwrap_err(), want);
            assert_eq!(c.images, before);
        }
    }
}
