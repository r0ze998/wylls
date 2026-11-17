//! Season facts every check reads: the season's parameters (from the
//! CreateSeason instruction the chain accepted), its clock, THE anchors
//! and the caches of every `(bell, region)`, the drand signatures the
//! transactions carried, and the land's owners over time.
//!
//! These are **inputs** to the checks, not conclusions: V3 judges the
//! anchors and signatures, V11 the land; the others read the facts and,
//! where a fact they depend on is missing, say so (`MissingData`).

use frontier_abi::v2::log::CqKind;
use std::collections::{BTreeMap, HashMap};

use frontier_abi::addr::AddrCtx;
use frontier_abi::ix as aix;
use frontier_abi::log::{settle_outcome, Kind};
use frontier_abi::presets::SeasonParams;
use frontier_abi::tags::Ix;
use permutation_rules::frontier::beacon::{self, WindowSchedule};
use permutation_rules::frontier::clash::BeaconClock;
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord};

use crate::input::Config;
use crate::world::{Key, World};

/// `(bell, region)`.
pub type BellRegion = (u32, u8);

/// THE anchor of a `(bell, region)` as its ANCHOR record states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnchorFact {
    pub rec: usize,
    pub round: u64,
    pub a: i64,
    pub slot: u64,
    pub beneficiary: [u8; 32],
}

/// A seed cache of a `(bell, region)` as its SEED record states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeedFact {
    pub rec: usize,
    pub nonce: u8,
    pub round: u64,
    pub seed: [u8; 32],
    pub a: i64,
}

/// A drand signature a transaction carried in its instruction data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SigFact {
    pub tx: usize,
    pub round: u64,
    pub sig: [u8; 48],
    pub ix: Ix,
}

/// A citizen as its JOIN record states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CitizenFact {
    pub rec: usize,
    pub addr: Key,
    pub tag15: [u8; 15],
    pub tag8: u64,
    pub wallet: [u8; 32],
    pub faction: u8,
    pub shard: u8,
}

/// One owner change of a site (SETTLE fresh/displace, RELEASE, CLOSE).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnerChange {
    pub rec: usize,
    pub owner: Option<Key>,
    pub gen: u8,
    pub score: u64,
    pub ticket_bell: u32,
    pub final_ts: i64,
    /// The ticket's funder (the Holding's rent payer, I-05/I-47).
    pub funder: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct Facts {
    pub ctx: AddrCtx,
    pub pk: [u8; 96],
    /// CreateSeason's parameters, the transaction and its time.
    pub params: Option<SeasonParams>,
    /// A conquest season's conquest block (CreateSeason v2; `None` for M1).
    pub cq: Option<frontier_abi::v2::presets::ConquestParams>,
    pub payout: Vec<u8>,
    pub create_tx: Option<usize>,
    pub announce_rec: Option<usize>,
    pub created_rec: Option<usize>,
    pub genesis_round: u64,
    pub genesis_ts: i64,
    pub clock: BeaconClock,
    pub window: WindowSchedule,
    pub margin: u32,
    pub genesis_seed: Option<[u8; 32]>,
    /// Every ANCHOR record per `(bell, region)` (more than one is a V3 FAIL).
    pub anchors: BTreeMap<BellRegion, Vec<AnchorFact>>,
    pub seeds: BTreeMap<BellRegion, Vec<SeedFact>>,
    /// ARCHIVE entries: `(a_off, seed, rec)`.
    pub archived: BTreeMap<BellRegion, (u32, [u8; 32], usize)>,
    /// Signatures carried by transactions, per round.
    pub sigs: BTreeMap<u64, Vec<SigFact>>,
    /// Ring seeds by ring (genesis rings from RING_OPEN, others from
    /// RING_SEED).
    pub ring_seeds: BTreeMap<u16, [u8; 32]>,
    pub citizens: HashMap<Key, CitizenFact>,
    pub by_tag8: HashMap<u64, Key>,
    /// Owner history per site `(P, Q, site)`, in record order.
    pub owners: BTreeMap<(i32, i32, u8), Vec<OwnerChange>>,
    /// The funder of each citizen's current ticket (TICKET.funder).
    pub ticket_funder: HashMap<Key, Vec<(usize, [u8; 32])>>,
    /// Province addresses (from PROVINCE_OPEN) → `(P, Q)`.
    pub provinces: HashMap<Key, (i32, i32)>,
    /// DEPART records per host id, in order.
    pub departs: HashMap<u64, Vec<usize>>,
}

impl Facts {
    /// The conquest step's parameters of a conquest season (the Season's
    /// genesis time and end, the CreateSeason conquest block); `None` for M1.
    pub fn step_params(&self) -> Option<frontier_abi::conquest_model::StepParams> {
        Some(frontier_abi::conquest_model::StepParams {
            genesis_ts: self.genesis_ts,
            end_bell: self.params?.end_bell,
            cq: self.cq?,
        })
    }

    pub fn build(w: &World, cfg: &Config) -> Facts {
        Facts::build_with_ctx(w, cfg, findex::addr_ctx(&cfg.program, cfg.season_id))
    }

    /// [`Facts::build`] over a given address context (tests pass a literal
    /// one instead of deriving the Season PDA).
    pub fn build_with_ctx(w: &World, cfg: &Config, ctx: AddrCtx) -> Facts {
        let mut f = Facts {
            ctx,
            pk: cfg.quicknet_pk,
            params: None,
            cq: None,
            payout: vec![],
            create_tx: None,
            announce_rec: None,
            created_rec: None,
            genesis_round: 0,
            genesis_ts: 0,
            clock: BeaconClock {
                genesis: fclient::beacon::QUICKNET_GENESIS,
                period: fclient::beacon::QUICKNET_PERIOD as i64,
            },
            window: WindowSchedule::fixed(600),
            margin: 60,
            genesis_seed: None,
            anchors: BTreeMap::new(),
            seeds: BTreeMap::new(),
            archived: BTreeMap::new(),
            sigs: BTreeMap::new(),
            ring_seeds: BTreeMap::new(),
            citizens: HashMap::new(),
            by_tag8: HashMap::new(),
            owners: BTreeMap::new(),
            ticket_funder: HashMap::new(),
            provinces: HashMap::new(),
            departs: HashMap::new(),
        };
        // Season parameters: the CreateSeason the chain accepted.
        for (i, t) in w.txs.iter().enumerate().filter(|(_, t)| t.ok) {
            for ix in &t.ixs {
                let Some(tag) = ix.tag().and_then(Ix::from_tag) else {
                    continue;
                };
                match tag {
                    Ix::CreateSeason if f.params.is_none() => {
                        // A conquest program's CreateSeason carries SeasonParams v2
                        // (M1's fields, then the conquest block).
                        use frontier_abi::v2::{ix::CreateSeasonV2, presets::PROGRAM_VERSION_V2};
                        if let Some(c) = CreateSeasonV2::decode(&ix.data)
                            .ok()
                            .filter(|c| c.params.base.program_version >= PROGRAM_VERSION_V2)
                        {
                            f.params = Some(c.params.base);
                            f.cq = Some(c.params.cq);
                            f.payout = c.payout.to_vec();
                            f.create_tx = Some(i);
                        } else if let Ok(c) = aix::CreateSeason::decode(&ix.data) {
                            f.params = Some(c.params);
                            f.payout = c.payout.to_vec();
                            f.create_tx = Some(i);
                        }
                    }
                    Ix::PostAnchor => {
                        if let Ok(x) = aix::PostAnchor::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    Ix::PostAnchorMulti => {
                        if let Ok(x) = aix::PostAnchorMulti::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    Ix::PostSeed => {
                        if let Ok(x) = aix::PostSeed::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    Ix::PostBeacon => {
                        if let Ok(x) = aix::PostBeacon::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    Ix::ConsumeGenesisSeed => {
                        if let Ok(x) = aix::ConsumeGenesisSeed::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    Ix::ConsumeRingSeed => {
                        if let Ok(x) = aix::ConsumeRingSeed::decode(&ix.data) {
                            f.sig(i, x.round, x.sig48, tag);
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(p) = &f.params {
            f.clock = BeaconClock {
                genesis: p.drand_genesis,
                period: p.drand_period as i64,
            };
            f.window = WindowSchedule::fixed(p.reveal_window);
            f.margin = p.seed_margin;
        }
        // ⑳ RESIDENT_JOINED (kind 130, in the conquest records): an
        // NFT-resident Citizen's start, at `citizen_by_tag15(resident id)`
        // with a zero wallet. Taken up front, so the record loop below finds
        // the Citizen by its tag as it finds a JOINed one; `rec` is the
        // index of the first M1 record after it. A record whose key is not
        // its asset's resident ID is not taken (V9 reports it).
        for c in w
            .cq_recs
            .iter()
            .filter(|c| c.kind == CqKind::RESIDENT_JOINED)
        {
            // Only a record that stands for its JoinResident, and only the
            // first one of a resident ID (V9 reports the rest).
            let Some(tag15) = resident_joined_valid(w, c) else {
                continue;
            };
            if f.citizens.contains_key(&f.ctx.citizen_by_tag15(&tag15)) {
                continue;
            }
            let addr = f.ctx.citizen_by_tag15(&tag15);
            let tag8 = u64::from_le_bytes(addr[..8].try_into().unwrap_or([0; 8]));
            let rec = w.recs.partition_point(|r| (r.tx, r.pos) < (c.tx, c.pos));
            f.citizens.insert(
                addr,
                CitizenFact {
                    rec,
                    addr,
                    tag15,
                    tag8,
                    wallet: [0; 32],
                    faction: c.field("faction", true).first().copied().unwrap_or(0),
                    shard: c.field("shard", true).first().copied().unwrap_or(0),
                },
            );
            f.by_tag8.insert(tag8, addr);
        }
        for (n, r) in w.recs.iter().enumerate() {
            match r.kind {
                Kind::ANNOUNCE if f.announce_rec.is_none() => f.announce_rec = Some(n),
                Kind::SEASON_CREATED if f.created_rec.is_none() => {
                    f.created_rec = Some(n);
                    f.genesis_round = r.pu64("genesis_round");
                    f.genesis_ts = r.pi64("genesis_ts");
                }
                Kind::WINDOW => {
                    f.window.window_next = r.pu32("window_next");
                    f.window.window_from_bell = r.pu32("window_from_bell");
                }
                Kind::GENESIS_SEED if f.genesis_seed.is_none() => {
                    f.genesis_seed = Some(r.p32("seed"))
                }
                Kind::ANCHOR => {
                    let k = (r.ku32("bell"), r.ku8("region"));
                    f.anchors.entry(k).or_default().push(AnchorFact {
                        rec: n,
                        round: r.pu64("round"),
                        a: r.pi64("a"),
                        slot: r.pu64("slot"),
                        beneficiary: r.p32("beneficiary"),
                    });
                }
                Kind::SEED => {
                    let k = (r.ku32("bell"), r.ku8("region"));
                    f.seeds.entry(k).or_default().push(SeedFact {
                        rec: n,
                        nonce: r.ku8("nonce"),
                        round: r.pu64("round"),
                        seed: r.p32("seed"),
                        a: r.pi64("a"),
                    });
                }
                Kind::ARCHIVE => {
                    let k = (r.pu32("bell"), r.ku8("region"));
                    f.archived.insert(k, (r.pu32("a_off"), r.p32("seed"), n));
                }
                Kind::RING_OPEN => {
                    let d = r.k("d");
                    let d = u16::from_le_bytes([d[0], d[1]]);
                    if r.pu64("round") == 0 {
                        f.ring_seeds.insert(d, r.p32("seed"));
                    }
                }
                Kind::RING_SEED => {
                    let d = r.k("d");
                    let d = u16::from_le_bytes([d[0], d[1]]);
                    f.ring_seeds.insert(d, r.p32("seed"));
                }
                Kind::JOIN => {
                    let tag15: [u8; 15] = r.k("citizen_tag15").try_into().unwrap_or([0; 15]);
                    let addr = f.ctx.citizen_by_tag15(&tag15);
                    let tag8 = u64::from_le_bytes(addr[..8].try_into().unwrap_or([0; 8]));
                    f.citizens.insert(
                        addr,
                        CitizenFact {
                            rec: n,
                            addr,
                            tag15,
                            tag8,
                            wallet: r.p32("wallet"),
                            faction: r.pu8("faction"),
                            shard: r.pu8("shard"),
                        },
                    );
                    f.by_tag8.insert(tag8, addr);
                }
                Kind::TICKET => {
                    let tag15: [u8; 15] = r.k("citizen_tag15").try_into().unwrap_or([0; 15]);
                    let addr = f.ctx.citizen_by_tag15(&tag15);
                    f.ticket_funder
                        .entry(addr)
                        .or_default()
                        .push((n, r.p32("funder")));
                }
                Kind::SETTLE => {
                    let o = r.pu8("outcome");
                    if o == settle_outcome::FRESH || o == settle_outcome::DISPLACE {
                        let owner = f.by_tag8.get(&r.pu64("citizen_tag")).copied();
                        let funder = owner.and_then(|c| f.funder_at(&c, n)).unwrap_or([0; 32]);
                        f.owners.entry(r.pqs()).or_default().push(OwnerChange {
                            rec: n,
                            owner,
                            gen: r.pu8("gen"),
                            score: r.pu64("score"),
                            ticket_bell: r.pu32("ticket_bell"),
                            final_ts: r.pi64("final_ts"),
                            funder,
                        });
                    }
                }
                Kind::HOME_PLACED => {
                    let owner = f.by_tag8.get(&r.pu64("citizen_tag")).copied();
                    f.owners.entry(r.pqs()).or_default().push(OwnerChange {
                        rec: n,
                        owner,
                        gen: r.pu8("gen"),
                        score: 0,
                        ticket_bell: frontier_abi::layout::player::citizen::NO_TICKET,
                        final_ts: r.pi64("final_ts"),
                        funder: r.p32("funder"),
                    });
                }
                Kind::PROVINCE_OPEN => {
                    let (p, q) = r.pq();
                    f.provinces.insert(f.ctx.province(p, q), (p, q));
                }
                Kind::DEPART => {
                    f.departs.entry(r.ku64("host_id")).or_default().push(n);
                }
                Kind::RELEASE => {
                    let gen = f.owner_at(r.pqs(), n).map(|c| c.gen).unwrap_or(0);
                    f.owners.entry(r.pqs()).or_default().push(OwnerChange {
                        rec: n,
                        owner: None,
                        gen,
                        score: 0,
                        ticket_bell: 0,
                        final_ts: 0,
                        funder: [0; 32],
                    });
                }
                _ => {}
            }
        }
        f
    }

    fn sig(&mut self, tx: usize, round: u64, sig: [u8; 48], ix: Ix) {
        self.sigs
            .entry(round)
            .or_default()
            .push(SigFact { tx, round, sig, ix });
    }

    /// The funder of `citizen`'s ticket as of record `n`.
    pub fn funder_at(&self, citizen: &Key, n: usize) -> Option<[u8; 32]> {
        self.ticket_funder
            .get(citizen)?
            .iter()
            .rev()
            .find(|(r, _)| *r < n)
            .map(|x| x.1)
    }

    /// The owner record of a site in force just before record `n`.
    pub fn owner_at(&self, site: (i32, i32, u8), n: usize) -> Option<&OwnerChange> {
        self.owners.get(&site)?.iter().rev().find(|c| c.rec < n)
    }

    /// The owner record of the holding of `host_id` before record `n`.
    pub fn owner_of_host(&self, host_id: u64, n: usize) -> Option<&OwnerChange> {
        let h = frontier_abi::addr::split_host_id(host_id)?;
        self.owner_at((h.province.p, h.province.q, h.site), n)
            .filter(|c| c.owner.is_some())
    }

    /// The DEPART of `host` in force at record `n`: the latest before it
    /// (with arrival bell `arrive` when given).
    pub fn depart_of(&self, w: &World, host: u64, n: usize, arrive: Option<u32>) -> Option<usize> {
        self.departs
            .get(&host)?
            .iter()
            .rev()
            .copied()
            .filter(|&d| d < n)
            .find(|&d| arrive.is_none_or(|a| w.recs[d].pu32("arrive_bell") == a))
    }

    /// `W(b)`.
    pub fn w(&self, b: u32) -> u32 {
        beacon::window(&self.window, b)
    }

    /// `T(b)`.
    pub fn tlock_round(&self, b: u32) -> u64 {
        beacon::tlock_round(&self.clock, self.genesis_ts, b)
    }

    /// `S(b, r)` for THE anchor landed at `a`.
    pub fn seed_round(&self, b: u32, a: i64) -> u64 {
        beacon::seed_round(&self.clock, beacon::reveal_close(a, self.w(b)), self.margin)
    }

    /// `A + W(b)`.
    pub fn close(&self, b: u32, a: i64) -> i64 {
        beacon::reveal_close(a, self.w(b))
    }

    pub fn round_time(&self, r: u64) -> i64 {
        beacon::round_time(self.clock.genesis, self.clock.period as u32, r)
    }

    /// THE anchor of `(bell, region)`: the first ANCHOR record.
    pub fn anchor(&self, bell: u32, region: u8) -> Option<AnchorFact> {
        self.anchors
            .get(&(bell, region))
            .and_then(|v| v.first())
            .copied()
    }

    /// `A` of `(bell, region)`, from the anchor or its archive entry.
    pub fn anchor_a(&self, bell: u32, region: u8) -> Option<i64> {
        self.anchor(bell, region).map(|a| a.a).or_else(|| {
            self.archived
                .get(&(bell, region))
                .map(|(off, _, _)| beacon::bell_end(self.genesis_ts, bell) + *off as i64)
        })
    }

    /// `S(bell, region)`'s seed: a SEED record of THE anchor with the
    /// rule's round, or the archive entry. The value is the chain's
    /// (V3 judges it).
    pub fn bell_seed(&self, bell: u32, region: u8) -> Option<[u8; 32]> {
        if let Some(a) = self.anchor(bell, region) {
            let want = self.seed_round(bell, a.a);
            if let Some(s) = self
                .seeds
                .get(&(bell, region))
                .and_then(|v| v.iter().find(|s| s.round == want && s.a == a.a))
            {
                return Some(s.seed);
            }
        }
        self.archived.get(&(bell, region)).map(|x| x.1)
    }

    /// A signature a transaction carried for `round` that verifies under
    /// the pinned key (cached by the caller through [`SigCache`]).
    pub fn good_sig(&self, round: u64, cache: &mut SigCache) -> Option<[u8; 48]> {
        let pk = self.pk;
        self.sigs
            .get(&round)?
            .iter()
            .map(|s| s.sig)
            .find(|s| cache.ok(round, s, &pk))
    }

    pub fn region(p: i32, q: i32) -> u8 {
        region_of(ProvinceCoord::new(p, q))
    }
}

/// Memoised BLS verification (a pairing is ≈ 1 ms).
#[derive(Default, Debug)]
pub struct SigCache {
    seen: HashMap<(u64, [u8; 48]), bool>,
}

impl SigCache {
    pub fn ok(&mut self, round: u64, sig: &[u8; 48], pk: &[u8; 96]) -> bool {
        *self
            .seen
            .entry((round, *sig))
            .or_insert_with(|| fclient::beacon::verify(round, sig, pk))
    }
}

/// The key of a RESIDENT_JOINED record when it is its asset's resident ID
/// (`sha256("PSF-RES" ‖ asset)[0..15]`), else `None`.
pub fn resident_joined_tag(c: &crate::world::CqRec) -> Option<[u8; 15]> {
    let asset: [u8; 32] = c.field("asset", true).try_into().ok()?;
    let tag15: [u8; 15] = c.key.as_slice().try_into().ok()?;
    (tag15 == frontier_abi::resident_citizen::resident_tag15(&asset)).then_some(tag15)
}

/// JoinResident's tag (workstream 4's allocation) and its asset account's
/// position: `[owner] [payer] [season] [frontier] [citizen] [system]
/// [policy] [link] [asset] [resident] [join_gate?]`.
const JOIN_RESIDENT: u8 = frontier_abi::resident_wire::JOIN_RESIDENT;
const JOIN_RESIDENT_ASSET: usize = 8;

/// Why a RESIDENT_JOINED record does not stand for the JoinResident that
/// must have written it (`None`: it does). The record's key is its asset's
/// resident ID; its transaction has a top-level JoinResident (0xE1) naming
/// that asset, with the record's generation and faction; the shard is the
/// asset's; `join_bell` is the record's own bell. Only JoinResident writes
/// this kind (workstream 11's review: a well-formed record in any other
/// transaction must not create a Citizen).
pub fn resident_joined_problem(
    c: &crate::world::CqRec,
    tx: &crate::world::Tx,
) -> Option<&'static str> {
    if resident_joined_tag(c).is_none() {
        return Some("the record's key is not its asset's resident ID");
    }
    let bad = Some("the record's payload does not decode");
    let Ok(asset) = <[u8; 32]>::try_from(c.field("asset", true)) else {
        return bad;
    };
    let le32 = |b: &[u8]| <[u8; 4]>::try_from(b).ok().map(u32::from_le_bytes);
    let (Some(generation), Some(&faction), Some(&shard), Some(join_bell)) = (
        le32(c.field("generation", true)),
        c.field("faction", true).first(),
        c.field("shard", true).first(),
        le32(c.field("join_bell", true)),
    ) else {
        return bad;
    };
    if shard != frontier_abi::addr::join_shard_of(&asset) {
        return Some("the record's shard is not its asset's");
    }
    if join_bell != c.bell {
        return Some("the record's join bell is not its own bell");
    }
    let joined = tx.ixs.iter().any(|ix| {
        ix.data.len() == 6
            && ix.data[0] == JOIN_RESIDENT
            && u32::from_le_bytes([ix.data[1], ix.data[2], ix.data[3], ix.data[4]]) == generation
            && ix.data[5] == faction
            && ix.key(JOIN_RESIDENT_ASSET) == Some(asset)
    });
    if !joined {
        return Some("no JoinResident in its transaction names this asset, generation and faction");
    }
    None
}

/// `resident_joined_tag` for a record that also stands for its JoinResident
/// (the only records the facts take a Citizen from).
pub fn resident_joined_valid(w: &World, c: &crate::world::CqRec) -> Option<[u8; 15]> {
    let tx = w.txs.get(c.tx)?;
    if resident_joined_problem(c, tx).is_some() {
        return None;
    }
    resident_joined_tag(c)
}

#[cfg(test)]
pub(crate) mod resident_tests {
    //! ⑳: literal bytes and a literal address context only (no key is
    //! generated, derived or signed; the Season address is written in).
    use super::*;
    use crate::world::{CqRec, Ix, Tx};

    /// A RESIDENT_JOINED as JoinResident writes it: the asset's shard, the
    /// record's own bell as the join bell.
    pub(crate) fn joined(
        key: [u8; 15],
        asset: [u8; 32],
        faction: u8,
        generation: u32,
        tx: usize,
    ) -> CqRec {
        let mut payload = asset.to_vec();
        payload.extend_from_slice(&[faction, frontier_abi::addr::join_shard_of(&asset)]);
        payload.extend_from_slice(&generation.to_le_bytes());
        payload.extend_from_slice(&40u32.to_le_bytes());
        CqRec {
            kind: CqKind::RESIDENT_JOINED,
            bell: 40,
            key: key.to_vec(),
            payload,
            tx,
            pos: 0,
        }
    }

    /// A transaction whose top-level program instructions are `ixs`.
    pub(crate) fn tx_with(ixs: Vec<Ix>) -> Tx {
        Tx {
            seq: 0,
            slot: 0,
            time: 0,
            sig: String::new(),
            ok: true,
            code: None,
            fee_payer: None,
            keys: vec![],
            ixs,
            recs: vec![],
            post: BTreeMap::new(),
            cu_price: 0,
            cu_limit: 0,
            loaded_limit: 0,
        }
    }

    /// JoinResident's instruction naming `asset` (accounts by position; the
    /// other keys are literal fill).
    pub(crate) fn join_ix(asset: [u8; 32], generation: u32, faction: u8) -> Ix {
        let mut data = vec![frontier_abi::resident_wire::JOIN_RESIDENT];
        data.extend_from_slice(&generation.to_le_bytes());
        data.push(faction);
        let accounts = (0..10u8)
            .map(|i| (if i == 8 { asset } else { [0x70 + i; 32] }, false))
            .collect();
        Ix {
            index: 0,
            data,
            accounts,
        }
    }

    fn cfg() -> Config {
        Config {
            program: solana_address::Address::new_from_array([0x11; 32]),
            season_id: 7,
            quicknet_pk: [0; 96],
            ruleset_hash: [0; 32],
            program_hash: None,
        }
    }
    const CTX: AddrCtx = AddrCtx {
        season: [0x22; 32],
        program: [0x11; 32],
    };

    #[test]
    fn resident_joined_makes_the_nft_citizen_known_by_its_tag() {
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let w = World {
            cq_recs: vec![
                joined(tag15, asset, 4, 2, 0),
                joined([9; 15], [0x6b; 32], 1, 0, 0),
            ],
            txs: vec![tx_with(vec![join_ix(asset, 2, 4)])],
            ..Default::default()
        };
        let f = Facts::build_with_ctx(&w, &cfg(), CTX);
        let addr = CTX.citizen_by_tag15(&tag15);
        let cf = f.citizens.get(&addr).expect("the NFT Citizen is known");
        assert_eq!(
            (cf.wallet, cf.faction, cf.shard, cf.tag15),
            ([0; 32], 4, frontier_abi::addr::join_shard_of(&asset), tag15)
        );
        assert_eq!(f.by_tag8.get(&cf.tag8), Some(&addr));
        // The forged record (key not its asset's resident ID) is not taken.
        assert_eq!(f.citizens.len(), 1);
        assert_eq!(resident_joined_tag(&w.cq_recs[1]), None);
    }

    #[test]
    fn a_resident_joined_without_its_join_resident_creates_no_citizen() {
        // Workstream 11's case: a well-formed record in a transaction that
        // never ran JoinResident (or ran it for something else).
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let rec = joined(tag15, asset, 4, 2, 0);
        let cases: Vec<(Vec<Ix>, &str)> = vec![
            (vec![], "no JoinResident"),
            (vec![join_ix([0x5b; 32], 2, 4)], "another asset"),
            (vec![join_ix(asset, 3, 4)], "another generation"),
            (vec![join_ix(asset, 2, 5)], "another faction"),
        ];
        for (ixs, what) in cases {
            let tx = tx_with(ixs);
            assert!(resident_joined_problem(&rec, &tx).is_some(), "{what}");
            let w = World {
                cq_recs: vec![rec.clone()],
                txs: vec![tx],
                ..Default::default()
            };
            assert!(
                Facts::build_with_ctx(&w, &cfg(), CTX).citizens.is_empty(),
                "{what}"
            );
        }
        // The record's own fields: the shard and the join bell.
        let tx = tx_with(vec![join_ix(asset, 2, 4)]);
        assert_eq!(resident_joined_problem(&rec, &tx), None);
        let mut shard = rec.clone();
        shard.payload[33] ^= 1;
        assert!(resident_joined_problem(&shard, &tx).is_some());
        let mut bell = rec.clone();
        bell.bell = 41;
        assert!(resident_joined_problem(&bell, &tx).is_some());
    }
}
