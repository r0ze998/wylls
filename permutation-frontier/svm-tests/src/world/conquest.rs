//! MC worlds for the conquest instructions (MC §3.4–§3.6, §3.10, §5.5;
//! CQ2-C).
//!
//! **Crafted, and why.** On this branch CreateSeason v2, OpenProvince v2,
//! Join v2 and FileOutpost / SettleTicket into slots 2–3 are CQ2-A's and
//! ResolveFromInputs / SkipQuiet with the conquest step are CQ2-B's (same
//! wave, §11). So this module writes, byte for byte in the frozen ABI v2
//! layouts (`frontier_abi::v2::layout`), what those instructions leave:
//!
//! - **The MC Season** ([`World::cq_set_params`]): a running season with the
//!   conquest block of a preset at 896..1,024 (CreateSeason v2 writes the
//!   same bytes); the Season keeps the program's `RULESET_HASH`, so the
//!   season is the program's on this branch and after CQ2-A's switch.
//! - **Province v2** ([`World::cq_province`]): `World::province_bytes` (the
//!   kernel terrain) in a 4,736-B account with `layout_version = 2`, no keep
//!   (a keep is CQ2-A's and CQ2-B's; the conquest instructions never read it).
//! - **Citizen, Holding, JoinShard v2** ([`World::cq_estate`],
//!   [`World::cq_outpost`]): `World::craft_estate`'s accounts with
//!   `layout_version = 2`, the slot-indexed `holding[]` (empty entries
//!   `gen = 0xFF`), and outposts in slots 2–3 as SettleTicket's order 2–3
//!   path leaves them (§5.6).
//! - **A Free City** ([`World::cq_free_city`]): the genesis site OpenProvince
//!   places (state 5, NEUTRAL, Hamlet, `held_since_hour = 0`).
//! - **The resolve** ([`World::cq_resolve`]): the conquest step as CQ2-B's
//!   ResolveFromInputs runs it, through the **shared** model the program
//!   calls (`clash_model::settle_bell`, `conquest_model::step`,
//!   `clash_model::finish_bell`), with the clash's report given or the quiet
//!   model's (`conquest_model::report_quiet`). No clash is fought here; the
//!   report stands in for its `GarrisonResult`s.
//!
//! Every test that relies on a crafted account says so. Method names carry
//! `cq_` so they never collide with CQ2-B's `World` additions in
//! `world/clash.rs` at the merge.

use frontier_abi::conquest_model::{self as cm, BellReport, Record, SiteReport, StepOut};
use frontier_abi::layout::header::{H_SIZE, LAYOUT_VERSION};
use frontier_abi::layout::province::province as P1;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use frontier_abi::v2::layout::world::join_shard as JS2;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::presets::{ConquestParams, SEASON_CQ_OFFSET};
use frontier_abi::v2::CqError;
use solana_address::Address;
use solana_signer::Signer;

use super::holding::{founded, u32_at, write_kholding, Estate};
use super::World;
use crate::chain::{program_id, Chain, Fail, SendResult};
use crate::FrontierError;

/// Little-endian put.
fn put(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

/// Asserts that the program itself refused with the MC code `e` (62–78,
/// MC §5.3): `assert_code`'s check for an ABI v2 code.
#[track_caller]
pub fn assert_cq(r: SendResult, e: CqError) -> Fail {
    let program = program_id();
    match r {
        Ok(l) => panic!(
            "expected {e:?} ({}), landed:\n{}",
            e.code(),
            l.logs.join("\n")
        ),
        Err(f) => {
            assert_eq!(
                f.code,
                Some(e.code()),
                "expected {e:?} ({}), got {} / {:?} ({:?})\n{}",
                e.code(),
                f.err,
                f.code,
                f.code.and_then(FrontierError::from_code).map(|x| x.name()),
                f.logs.join("\n")
            );
            let line = format!(
                "Program {program} failed: custom program error: {:#x}",
                e.code()
            );
            assert!(
                f.logs.iter().any(|l| l == &line),
                "{e:?} not raised by the Frontier program itself:\n{}",
                f.logs.join("\n")
            );
            f
        }
    }
}

/// An outpost (order 2–3) or any other holding of a citizen, addressed
/// like an [`Estate`] (the owner's wallet and Citizen, this holding's site).
pub fn estate_view(
    owner: &Estate,
    holding: &Address,
    province: &Address,
    pqs: (i16, i16, u8),
    gen: u8,
    tile: u8,
) -> Estate {
    Estate {
        wallet: owner.wallet.insecure_clone(),
        faction: owner.faction,
        p: pqs.0,
        q: pqs.1,
        site: pqs.2,
        gen,
        tile,
        holding: *holding,
        province: *province,
        citizen: owner.citizen,
    }
}

impl World {
    /// Writes `cq` into the Season's conquest block (module note).
    pub fn cq_set_params(&self, c: &mut Chain, cq: &ConquestParams) {
        let b = cq.to_bytes();
        c.edit(&self.a.season, |d| put(d, SEASON_CQ_OFFSET, &b));
    }

    /// The step parameters of the Season (genesis, `end_bell`, the block).
    pub fn cq_step_params(&self, c: &Chain) -> cm::StepParams {
        cm::StepParams::of_season(&c.data(&self.a.season)).expect("an MC Season")
    }

    /// Sets `layout_version = 2` on a chained account (module note).
    pub fn cq_upgrade(&self, c: &mut Chain, k: &Address) {
        c.edit(k, |d| put(d, LAYOUT_VERSION, &2u16.to_le_bytes()));
    }

    /// A crafted Province v2 at `(p, q)` (module note): a v1 Province already
    /// crafted there is carried over byte for byte into the v2 account.
    pub fn cq_province(&self, c: &mut Chain, p: i16, q: i16) -> Address {
        let k = self.a.province(p as i32, q as i32);
        let v1 = if c.is_absent(&k) {
            let b = self.bell_at(c.now).unwrap_or(0);
            self.province_bytes(p, q, b)
        } else {
            let d = c.data(&k);
            if d.len() == P2::SIZE {
                return k;
            }
            d
        };
        let mut d = vec![0u8; P2::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut d,
            K2::Province,
            self.id
        ));
        d[H_SIZE..P1::SIZE].copy_from_slice(&v1[H_SIZE..P1::SIZE]);
        cm::write_no_keep(&mut d).expect("no keep");
        c.remove(&k);
        c.put_program_account(k, d);
        k
    }

    /// The vigil start (minutes of day) whose window is furthest from
    /// `bell_start(b)`: 12 hours after it (a test that counts siege
    /// progress around bell `b` is never inside the owner's vigil).
    pub fn cq_vigil_away(&self, b: u32) -> u16 {
        let tod = self.bell_start(b).rem_euclid(86_400);
        (((tod + 12 * 3_600).rem_euclid(86_400)) / 60) as u16
    }

    /// A player with a final first holding in a crafted Province v2 (module
    /// note): `craft_estate`'s accounts at `layout_version = 2`, slots 2–3
    /// empty, the vigil 12 h away from the current bell, the JoinShard v2.
    pub fn cq_estate(
        &self,
        c: &mut Chain,
        label: &str,
        faction: u8,
        pq: (i16, i16),
        site: u8,
    ) -> Estate {
        self.cq_province(c, pq.0, pq.1);
        let e = self.craft_estate(c, label, faction, pq, site);
        self.cq_upgrade(c, &e.holding);
        self.cq_upgrade(c, &e.citizen);
        let away = self.cq_vigil_away(self.bell_at(c.now).unwrap_or(0));
        c.edit(&e.citizen, |d| {
            for s in 2..=3u8 {
                let o = C2::holding_of_slot(s);
                d[o..o + 6].copy_from_slice(&[0, 0, 0, 0, 0, C2::EMPTY_GEN]);
            }
            put(d, C2::VIGIL_START_MIN, &away.to_le_bytes());
            put(d, C2::VIGIL_NEXT_MIN, &away.to_le_bytes());
        });
        let shard = c.data(&e.citizen)[C2::JOIN_SHARD];
        let js = self.a.join_shard(faction, shard);
        self.cq_upgrade(c, &js);
        e
    }

    /// The JoinShard of an estate's Citizen.
    pub fn cq_join_shard(&self, c: &Chain, e: &Estate) -> Address {
        let shard = c.data(&e.citizen)[C2::JOIN_SHARD];
        self.a.join_shard(e.faction, shard)
    }

    /// An outpost of `owner` in slot `slot` (2 or 3) on site `site` of a
    /// crafted Province v2, as SettleTicket's order 2–3 path leaves it
    /// (§5.6): the Holding (order = slot, final, shield over), the mirror
    /// (`held_since_hour` = the current hour), the Citizen's
    /// `holding[slot − 1]` and `holdings_n`, the JoinShard's
    /// `extra_holdings` and `outposts`. Returns it as an [`Estate`] view.
    pub fn cq_outpost(
        &self,
        c: &mut Chain,
        owner: &Estate,
        pq: (i16, i16),
        site: u8,
        slot: u8,
    ) -> Estate {
        assert!((2..=3).contains(&slot));
        let (p, q) = pq;
        let province = self.cq_province(c, p, q);
        let pd = c.data(&province);
        assert!(site < pd[P2::SITE_COUNT], "site {site} exists");
        let tile = pd[P2::SITES + site as usize];
        let gen = 1u8;
        let now = c.now;
        let bell = self.bell_at(now).unwrap_or(0);
        let holding = self.a.holding(p as i32, q as i32, site);
        c.edit(&province, |d| {
            let o = P2::site(site as usize);
            d[o + SM2::STATE] = SM2::STATE_HOLDING;
            d[o + SM2::FACTION] = owner.faction;
            d[o + SM2::ORDER] = slot;
            d[o + SM2::GEN] = gen;
            put(
                d,
                o + SM2::HELD_SINCE_HOUR,
                &((bell / 6) as u16).to_le_bytes(),
            );
            d[P2::N_SITES_USED] += 1;
        });
        let mut kh = founded(now, bell / 144);
        kh.order = slot;
        let mut hd = vec![0u8; H2::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut hd,
            K2::Holding,
            self.id
        ));
        put(&mut hd, H2::P, &p.to_le_bytes());
        put(&mut hd, H2::Q, &q.to_le_bytes());
        hd[H2::SITE] = site;
        hd[H2::GEN] = gen;
        hd[H2::TILE] = tile;
        hd[H2::STATE] = H2::STATE_FINAL;
        put(&mut hd, H2::OWNER_CITIZEN, owner.citizen.as_ref());
        hd[H2::FACTION] = owner.faction;
        put(&mut hd, H2::TICKET_BELL, &bell.to_le_bytes());
        put(&mut hd, H2::RENT_PAYER, owner.wallet.pubkey().as_ref());
        put(&mut hd, H2::FINAL_TS, &now.to_le_bytes());
        write_kholding(&mut hd, &kh);
        put(&mut hd, H2::SHIELD_UNTIL, &0i64.to_le_bytes());
        c.put_program_account(holding, hd);
        c.edit(&owner.citizen, |d| {
            let o = C2::holding_of_slot(slot);
            put(d, o, &p.to_le_bytes());
            put(d, o + 2, &q.to_le_bytes());
            d[o + 4] = site;
            d[o + 5] = gen;
            d[C2::HOLDINGS_N] += 1;
        });
        let js = self.cq_join_shard(c, owner);
        c.edit(&js, |d| {
            for f in [JS2::EXTRA_HOLDINGS, JS2::OUTPOSTS] {
                let v = u32_at(d, f) + 1;
                put(d, f, &v.to_le_bytes());
            }
        });
        estate_view(owner, &holding, &province, (p, q, site), gen, tile)
    }

    /// A genesis Free City on site `site` of a crafted Province v2 (module
    /// note): state 5, NEUTRAL, Hamlet, the garrison in whole troops,
    /// `held_since_hour = 0`, walls 0, generation `gen`.
    pub fn cq_free_city(
        &self,
        c: &mut Chain,
        pq: (i16, i16),
        site: u8,
        garrison: u32,
        gen: u8,
    ) -> Address {
        let province = self.cq_province(c, pq.0, pq.1);
        c.edit(&province, |d| {
            let o = P2::site(site as usize);
            d[o + SM2::STATE] = SM2::STATE_FREE_CITY;
            d[o + SM2::FACTION] = permutation_rules::frontier::clash::NEUTRAL;
            d[o + SM2::ORDER] = 0;
            d[o + SM2::GEN] = gen;
            d[o + SM2::TIER] = 0;
            put(d, o + SM2::GARRISON, &garrison.to_le_bytes());
            put(d, o + SM2::HELD_SINCE_HOUR, &0u16.to_le_bytes());
        });
        province
    }

    /// The conquest record of `site`.
    pub fn cq_record(&self, c: &Chain, province: &Address, site: u8) -> Record {
        Record::read(&c.data(province), site as usize).expect("record")
    }

    /// Writes the conquest record of `site` (crafted).
    pub fn cq_put_record(&self, c: &mut Chain, province: &Address, site: u8, r: &Record) {
        c.edit(province, |d| r.write(d, site as usize).expect("record"));
    }

    /// Bell `b` of a crafted Province v2 resolved as CQ2-B's
    /// ResolveFromInputs leaves it (module note): the report given (the
    /// clash's) or the quiet model's, `settle_bell(b)`, the conquest step,
    /// `finish_bell`. Requires `resolved_next == b`.
    pub fn cq_resolve(
        &self,
        c: &mut Chain,
        province: &Address,
        b: u32,
        rep: Option<BellReport>,
    ) -> StepOut {
        let prm = self.cq_step_params(c);
        let mut out = None;
        c.edit(province, |d| {
            assert_eq!(u32_at(d, P2::RESOLVED_NEXT), b, "resolve in order");
            let rep = rep.unwrap_or_else(|| cm::report_quiet(d, b).expect("quiet report"));
            let changed = frontier_abi::clash_model::settle_bell(d, b).expect("settle_bell");
            let o = cm::step(d, b, &rep, &prm).expect("step");
            frontier_abi::clash_model::finish_bell(d, b, changed || o.roster_changed)
                .expect("finish_bell");
            out = Some(o);
        });
        out.expect("step ran")
    }

    /// [`World::cq_resolve`] for every bell `from..=to`, each with the quiet
    /// model's report.
    pub fn cq_resolve_quiet(
        &self,
        c: &mut Chain,
        province: &Address,
        from: u32,
        to: u32,
    ) -> Vec<StepOut> {
        (from..=to)
            .map(|b| self.cq_resolve(c, province, b, None))
            .collect()
    }
}

/// A report in which faction `holder` (alone) holds site `s`'s hex, with or
/// without a defender.
pub fn site_report(s: u8, holders: u8, defender_present: bool) -> BellReport {
    let mut r = BellReport::default();
    r.sites[s as usize] = SiteReport {
        holders,
        defender_present,
    };
    r
}

/// The bit of faction `f` in a report's `holders`.
pub const fn bit(f: u8) -> u8 {
    1 << f
}

/// A record of kind 1 (siege) as DeclareSiege writes it (for crafted
/// states; the tests that check DeclareSiege read the program's).
#[allow(clippy::too_many_arguments)]
pub fn siege_record(
    attacker: u8,
    target: u8,
    slot: u8,
    required: u8,
    progress: u8,
    bell: u32,
    actor: u64,
    src: u64,
) -> Record {
    Record {
        kind: CR::KIND_SIEGE,
        faction: attacker,
        flags: CR::FLAG_HELD
            | if target == CR::TARGET_FREE_CITY {
                CR::FLAG_NEUTRAL
            } else {
                0
            },
        progress,
        required,
        target: CR::target(target, slot),
        bell,
        actor,
        src,
        ..Record::ZERO
    }
}
