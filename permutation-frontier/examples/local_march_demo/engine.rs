//! Private fixed-route sandbox. Initial images are explicit fixtures; every
//! transition is a real dispatcher call on a staged copy. No network or keys.
use crate::runtime::{self, Image, Meta};
use frontier_abi::entry::read_entry;
use frontier_abi::world_index::{
    arrival as wa, event as ev, march::wide_host_alias, wide_ix as wix,
};
use frontier_abi::world_index::{
    MarchState, ProvinceKey, WideHolding, WideHostRef, WideProvince, WideTransit,
};
use permutation_frontier::layout::{holding as H, province as PV, Ro};
use std::collections::BTreeMap;

pub const GENESIS: i64 = 1_790_444_847;
pub const INITIAL: i64 = GENESIS + 6 * 600 + 60;
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
    pub trained: bool,
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
            trained: false,
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
    pub fn allowed(&self) -> Vec<&'static str> {
        let mut v = vec![];
        match self.phase {
            "ready" => v.push("depart"),
            "departed" => {
                if !self.trained {
                    v.push("train")
                }
                v.push("settle_departure")
            }
            "travelling" => v.push("post_reveal"),
            "revealed" => v.push("resolve_arrival"),
            "resolved" => v.push("settle_transit"),
            "settled" => v.push("dissolve_return"),
            _ => {}
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
                "Train" => ev::WideKind::Economy,
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
            let a = permutation_frontier::layout::chain_of(pre).map_err(|_| "CHAIN_PRE")?;
            let b = permutation_frontier::layout::chain_of(post).map_err(|_| "CHAIN_POST")?;
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
    pub fn apply(&mut self, cmd: &str) -> Result<(), String> {
        if !self.allowed().contains(&cmd) || cmd == "reset" {
            return Err("BAD_PHASE".into());
        }
        let mut next = self.clone();
        next.records.clear();
        next.instructions.clear();
        next.step(cmd)?;
        *self = next;
        Ok(())
    }
    fn step(&mut self, cmd: &str) -> Result<(), String> {
        let host = self.host()?;
        let faction = self.num("faction")? as u8;
        let region = self.num("region")? as u8;
        match cmd {
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
            "train" => {
                let old = Ro(self.data("holding")?)
                    .u32(H::reserve(0))
                    .map_err(|_| "HOLDING")?;
                let transit = self.images["transit_0"].clone();
                let escrow = Ro(self.data("holding")?)
                    .u64(H::ESCROW)
                    .map_err(|_| "HOLDING")?;
                self.invoke(
                    "Train",
                    vec![
                        s("actor", false),
                        s("payer", true),
                        r("season"),
                        w("citizen"),
                        w("holding"),
                        r("origin"),
                    ],
                    wix::Economy {
                        action: frontier_abi::world_index::economy::Action::Train {
                            unit: 0,
                            n: 10,
                        },
                    }
                    .to_bytes()
                    .ok_or("TRAIN_ENCODE")?,
                    false,
                )?;
                if self.images["transit_0"] != transit
                    || Ro(self.data("holding")?)
                        .u32(H::reserve(0))
                        .map_err(|_| "HOLDING")?
                        != old + 10
                    || Ro(self.data("holding")?)
                        .u64(H::ESCROW)
                        .map_err(|_| "HOLDING")?
                        != escrow
                {
                    return Err("TRAIN_MISMATCH".into());
                }
                self.trained = true;
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
                self.now = GENESIS + 25 * 600 + 60;
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
