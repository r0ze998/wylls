//! The playable lane's wide-land instructions (program version 0x4804,
//! `permutation-frontier/src/proc/wide.rs`) and the wide provinces a keeper
//! opens: ONE copy, used by the keeper's P6 wide-ring duty
//! ([`crate::rings`]), its P7 `wide-tickets` role ([`crate::widetickets`])
//! and the local play runner (`itest::wide_land`, `itest::wide_play`
//! re-export these; before this module the runner had the only copy).
//!
//! Account lists are the handlers' (source of truth: the doc comment of each
//! handler in `proc/wide.rs`); data are the `frontier_abi::world_index::
//! wide_ix` encoders. Pure: no read, no send.

use std::collections::BTreeMap;

use fclient::addr::Addresses;
use fclient::ix::{seed_pair, SeedSource};
use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::land::{self as wl, FIRST_WIDE_RING};
use frontier_abi::world_index::rules as wr;
use frontier_abi::world_index::ticket::{self as wt, WideTicket};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::wide_ix::WideIx as WideIxTag;
use frontier_abi::world_index::WideCoord;
use permutation_rules::frontier::geometry::R_MAX_HARD;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

pub use frontier_abi::world_index::land::FIRST_WIDE_RING as FIRST_RING;

pub fn ctx(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

fn adr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}

fn ix(a: &Addresses, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts,
        data,
    }
}

/// The wide provinces opened on `ring`: per wedge, the `per_wedge`
/// provinces in the middle of that wedge's arc (in the ring's walking
/// order), wedges in order. Pure. The local wide world's plan (`itest`
/// `wide_land::wide_plan` is this function) and the keeper's P6 plan.
pub fn wide_plan(ring: u64, per_wedge: usize) -> Vec<WideCoord> {
    let r = ring as i64;
    let mut by_wedge: BTreeMap<u8, Vec<(f64, WideCoord)>> = BTreeMap::new();
    for p in -r..=r {
        for q in (-r).max(-p - r)..=r.min(-p + r) {
            let Ok(c) = WideCoord::checked(p, q) else {
                continue;
            };
            if c.ring() != ring {
                continue;
            }
            let Some(w) = c.wedge() else { continue };
            // (the axial position's angle: a stable order along the ring)
            let (x, y) = (
                p as f64 + q as f64 / 2.0,
                q as f64 * 0.866_025_403_784_438_6,
            );
            by_wedge.entry(w).or_default().push((y.atan2(x), c));
        }
    }
    let mut out = vec![];
    for (_, mut v) in by_wedge {
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        // (a wedge straddling the angle's wrap: walk it from its largest gap so the arc is contiguous)
        if v.len() > 1 {
            let gap = (0..v.len())
                .max_by(|&i, &j| {
                    let g = |k: usize| {
                        (v[(k + 1) % v.len()].0 - v[k].0).rem_euclid(std::f64::consts::TAU)
                    };
                    g(i).total_cmp(&g(j))
                })
                .unwrap_or(0);
            let n = v.len();
            v.rotate_left((gap + 1) % n);
        }
        let n = per_wedge.min(v.len());
        let from = (v.len() - n) / 2;
        out.extend(v[from..from + n].iter().map(|x| x.1));
    }
    out
}

/// 0xD6 WideRequestRingSeed: `[payer s,w] [season r] [frontier r] [previous
/// ring seed r] [wide ring seed w] [pfund × 6 r] [system]`. The previous
/// seed is the legacy RingSeed(128) for ring 129, else the wide seed of
/// `ring − 1`. The record's rent comes from `payer`.
pub fn request_ring_seed(a: &Addresses, payer: Address, ring: u64) -> Instruction {
    let c = ctx(a);
    let previous = if ring == FIRST_WIDE_RING {
        a.ring_seed(R_MAX_HARD)
    } else {
        adr(wl::ring_seed_address(&c, ring - 1))
    };
    let mut m = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.frontier(), false),
        AccountMeta::new_readonly(previous, false),
        AccountMeta::new(adr(wl::ring_seed_address(&c, ring)), false),
    ];
    m.extend(
        a.province_funds()
            .into_iter()
            .map(|f| AccountMeta::new_readonly(f, false)),
    );
    m.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    ix(a, m, wix::RequestRingSeed { ring }.to_bytes().to_vec())
}

/// 0xD7 WideConsumeRingSeed: `[payer s,w] [season r] [wide ring seed w]`,
/// with the bound round's quicknet signature and its hints.
pub fn consume_ring_seed(
    a: &Addresses,
    payer: Address,
    ring: u64,
    round: u64,
    sig48: [u8; 48],
) -> Result<Instruction, String> {
    let hints: [u8; frontier_abi::ix::HINTS_LEN] = fclient::beacon::hints_bytes(round)
        .try_into()
        .map_err(|_| "hints length")?;
    Ok(ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&ctx(a), ring)), false),
        ],
        wix::ConsumeRingSeed {
            ring,
            round,
            sig48,
            hints,
        }
        .to_bytes()
        .to_vec(),
    ))
}

/// 0xD8 WideOpenProvince: `[payer s,w] [season r] [wide ring seed w] [pfund
/// w] [province w] [rules_config r] [system]`. The rent comes from the
/// wedge's fund.
pub fn open_province(
    a: &Addresses,
    payer: Address,
    coord: WideCoord,
) -> Result<Instruction, String> {
    let c = ctx(a);
    let wedge = coord.wedge().ok_or("a wide province has a wedge")?;
    Ok(ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&c, coord.ring())), false),
            AccountMeta::new(a.province_fund(wedge), false),
            AccountMeta::new(adr(wl::province_address(&c, coord)), false),
            AccountMeta::new_readonly(adr(wr::rules_config_address(&c)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::OpenProvince {
            p: coord.p(),
            q: coord.q(),
        }
        .to_bytes()
        .to_vec(),
    ))
}

/// The holder a WideSettleTicket displaces (the 13-account form): the
/// provisional holding's `RENT_PAYER`, its owner Citizen and that Citizen's
/// JoinShard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Displaced {
    pub rent_payer: Address,
    pub citizen: Address,
    pub shard: Address,
}

/// 0xDC WideSettleTicket(k = 0): `[payer s,w] [season r] [citizen w]
/// [record w] [holding w] [wide province w] [joinshard w] [seedcache|archive
/// r] [anchor|archive r]` then, displacing, `[displaced rent payer w,
/// displaced citizen w, displaced shard w]`, and `[system]`. An expired
/// ticket reads no seed: any `src` names the pair.
#[allow(clippy::too_many_arguments)]
pub fn settle_ticket(
    a: &Addresses,
    payer: Address,
    rec: &WideTicket,
    faction: u8,
    shard: u8,
    region: u8,
    src: SeedSource,
    displaced: Option<Displaced>,
) -> Instruction {
    let c = ctx(a);
    let mut m = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(adr(rec.citizen), false),
        AccountMeta::new(adr(wt::ticket_address(&c, &rec.citizen)), false),
        AccountMeta::new(adr(wh::holding_address(&c, rec.coord, rec.site)), false),
        AccountMeta::new(adr(wl::province_address(&c, rec.coord)), false),
        AccountMeta::new(a.join_shard(faction, shard), false),
    ];
    m.extend(seed_pair(a, rec.bell, region, src));
    if let Some(d) = displaced {
        m.push(AccountMeta::new(d.rent_payer, false));
        m.push(AccountMeta::new(d.citizen, false));
        m.push(AccountMeta::new(d.shard, false));
    }
    m.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    ix(a, m, wix::SettleTicket { k: 0 }.to_bytes().to_vec())
}

/// 0xDF WideFinalize: `[anyone s] [season r] [holding w] [wide province r]`.
pub fn finalize(a: &Addresses, payer: Address, coord: WideCoord, site: u8) -> Instruction {
    let c = ctx(a);
    ix(
        a,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wh::holding_address(&c, coord, site)), false),
            AccountMeta::new_readonly(adr(wl::province_address(&c, coord)), false),
        ],
        wix::Finalize {}.to_bytes().to_vec(),
    )
}

/// CU limits of the wide writes this keeper sends. The canonical budgets
/// tables have no wide rows, so without these a wide write would ask for
/// 1.4 M CU and pay the class's priority on all of it. Measured on the
/// devnet `.so` (stack `operator_playable` P5, keeper A's own sends):
/// WideRequestRingSeed 15,186–15,573 (3); WideConsumeRingSeed
/// 330,628–332,336 (3); WideOpenProvince 476,712–538,387 (108 provinces of
/// rings 129–131); WideSettleTicket 21,410 (the 10-account form; the
/// displacing form is not measured); WideFinalize 6,424. Limits: about
/// 20 % over the largest (more for the unmeasured displacing settle). The
/// engine's retry ladder doubles a limit that is exceeded (I-50).
pub const WIDE_BUDGETS: [(WideIxTag, u32); 6] = [
    (WideIxTag::RequestRingSeed, 25_000),
    (WideIxTag::ConsumeRingSeed, 400_000),
    (WideIxTag::OpenProvince, 650_000),
    (WideIxTag::SettleTicket, 45_000),
    (WideIxTag::Finalize, 15_000),
    // (P13: the expedition wrapper's ExpeditionReveal, class tag 0xEE, the `expeditions` role; its other steps are
    //  0xDC. Without this row the Reveal went out at the canonical default loaded-data limit and the runtime refused
    //  it, MaxLoadedAccountsDataSizeExceeded: P10 run 1)
    (WideIxTag::Reveal, crate::expeditions::CU_REVEAL),
];
/// Adds [`WIDE_BUDGETS`] to a table that has no row for them (an
/// operator's `budgets_file` row wins), at the lane's loaded limit.
pub fn fill_budgets(b: &mut fclient::budgets::Budgets) {
    for (ix, cu) in WIDE_BUDGETS {
        let tag = ix.tag();
        if b.get(tag).cu_limit == fclient::abi::CU_MAX {
            b.set(
                tag,
                fclient::budgets::Budget {
                    cu_limit: cu,
                    loaded_limit: fclient::budgets::RUNTIME_MAX_LOADED_LIMIT,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keeper's rim (Q-W1, `rings::rim_plan`, not feature-gated) is the
    /// ring-128 neighbourhood of this module's ring-129 plan with the same
    /// `n`: a rim village is within `outpost_range` of what P6 opens.
    #[test]
    fn the_rim_borders_the_first_wide_ring_of_the_same_plan() {
        for n in [1usize, 3, 6, 12] {
            let wide = wide_plan(FIRST_WIDE_RING, n);
            assert_eq!(wide.len(), 6 * n);
            let mut rim = vec![];
            for c in &wide {
                for (dp, dq) in [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)] {
                    let x = (c.p() as i32 + dp, c.q() as i32 + dq);
                    if permutation_rules::frontier::geometry::ProvinceCoord::new(x.0, x.1).ring()
                        == u32::from(R_MAX_HARD)
                        && !rim.contains(&x)
                    {
                        rim.push(x);
                    }
                }
            }
            assert_eq!(rim, crate::rings::rim_plan(n), "n = {n}");
        }
    }

    #[test]
    fn every_wide_ring_plan_is_per_wedge_on_its_ring() {
        for ring in [129u64, 130, 131, 136] {
            let v = wide_plan(ring, 6);
            assert_eq!(v.len(), 36);
            let mut per = [0usize; 6];
            for c in &v {
                assert_eq!(c.ring(), ring);
                per[c.wedge().unwrap() as usize] += 1;
            }
            assert_eq!(per, [6; 6]);
        }
    }

    #[test]
    fn the_settle_has_ten_accounts_or_thirteen_displacing() {
        let a = Addresses::new(Address::new_from_array([3; 32]), 1);
        let rec = WideTicket {
            season_id: 1,
            world: frontier_abi::world_index::WorldId::new(
                [5; frontier_abi::world_index::key::WORLD_ID_LEN],
            )
            .unwrap(),
            status: wt::TicketStatus::Open,
            citizen: [7; 32],
            coord: WideCoord::checked(129, 0).unwrap(),
            site: 2,
            slot: 2,
            bell: 40,
            next: 0,
            funder: [0; 32],
            rent_payer: [0; 32],
            escrow: 0,
        };
        let p = Address::new_from_array([9; 32]);
        let i = settle_ticket(&a, p, &rec, 1, 0, 4, SeedSource::Cache { nonce: 3 }, None);
        assert_eq!(i.accounts.len(), 10);
        assert_eq!(i.accounts[7].pubkey, a.seed_cache(40, 4, 3));
        assert_eq!(i.accounts[8].pubkey, a.anchor(40, 4));
        let d = Displaced {
            rent_payer: Address::new_from_array([1; 32]),
            citizen: Address::new_from_array([2; 32]),
            shard: Address::new_from_array([4; 32]),
        };
        let i = settle_ticket(
            &a,
            p,
            &rec,
            1,
            0,
            4,
            SeedSource::Cache { nonce: 0 },
            Some(d),
        );
        assert_eq!(i.accounts.len(), 13);
        assert_eq!(i.accounts[9].pubkey, d.rent_payer);
        assert_eq!(i.accounts[12].pubkey, fclient::addr::system_program());
        assert_eq!(finalize(&a, p, rec.coord, 2).accounts.len(), 4);
        assert_eq!(request_ring_seed(&a, p, 130).accounts.len(), 12);
    }
}

// ------------------------------------------------------------ territory (territory-impl)

/// Player territory's class-D cranks (territory-impl, owner 2026-11-24 12:09; program
/// `proc/wide_territory.rs`, accounts `wide_ix::TERRITORY_*`). The keeper's `territory` role
/// ([`crate::territory`], devnet-territory-dev) and the local runner's duty (`itest::wide_territory`) plan with
/// [`territory::plan`] and send these; the claim itself (0xDA op 7) is a player's.
pub mod territory {
    use super::*;
    use frontier_abi::world_index::territory as wtr;
    use frontier_abi::world_index::territory::{TerritoryPlayer, TerritoryProvince};

    // ---- the crank's plan (pure; one copy: the keeper's `territory` role and the local runner's duty)

    /// One crank step of [`plan`].
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Step {
        /// Settle `citizen`'s upkeep.
        Settle { citizen: [u8; 32] },
        /// Settle, then decay `tile` of `province`.
        Decay {
            citizen: [u8; 32],
            province: WideCoord,
            tile: u8,
        },
        /// Settle both, then move `loser`'s tiles of `province` to the captor.
        Conquer {
            province: WideCoord,
            loser: [u8; 32],
            captor: [u8; 32],
            captor_has_summary: bool,
            captor_holding: wl::KeepCaptor,
        },
    }

    /// The chain as [`plan`] sees it.
    #[derive(Clone, Default)]
    pub struct View {
        pub players: Vec<TerritoryPlayer>,
        pub provinces: Vec<TerritoryProvince>,
        /// Wide provinces with a captor record at the keep's current generation: (coord, captor, keep holder).
        pub captured: Vec<(WideCoord, wl::KeepCaptor, u8)>,
        /// The owner Citizen of each captor home village, by the captor record.
        pub captor_citizen: BTreeMap<(WideCoord, u8), ([u8; 32], u8)>,
        /// devnet-territory-dev: the tiles of each captured province with a village on them ([`village_tiles_of`]):
        /// they stay with their village (verify-pr206-209), so an owner holding only such tiles there is no loser
        /// (the program refuses that transfer `NotDue`/TooEarly; before, the plan asked it again every bell).
        pub village_tiles: BTreeMap<WideCoord, Vec<u8>>,
    }

    /// Pure: the bell's steps, conquest first (it moves tiles a decay would otherwise pick), then decay, then settle.
    pub fn plan(v: &View, bell: u32, now_ts: i64) -> Vec<Step> {
        let mut out = vec![];
        let by_tag: BTreeMap<u64, &TerritoryPlayer> =
            v.players.iter().map(|p| (p.citizen_tag, p)).collect();
        for (coord, cap, holder) in &v.captured {
            let Some((captor, cfaction)) = v.captor_citizen.get(&(cap.home, cap.site)) else {
                continue;
            };
            if cfaction != holder {
                continue;
            }
            let Some(tp) = v.provinces.iter().find(|p| p.coord == *coord) else {
                continue;
            };
            let captor_has_summary = v.players.iter().any(|p| p.citizen == *captor);
            let mut losers: Vec<[u8; 32]> = vec![];
            let villages = v.village_tiles.get(coord).map(Vec::as_slice).unwrap_or(&[]);
            for (i, o) in tp.owner.iter().enumerate().filter(|(_, o)| **o != 0) {
                if villages.contains(&(i as u8)) {
                    continue;
                }
                let Some(pl) = by_tag.get(o) else { continue };
                if pl.citizen != *captor && pl.faction != *cfaction && !losers.contains(&pl.citizen)
                {
                    losers.push(pl.citizen);
                }
            }
            for loser in losers {
                out.push(Step::Conquer {
                    province: *coord,
                    loser,
                    captor: *captor,
                    captor_has_summary,
                    captor_holding: *cap,
                });
            }
        }
        for pl in &v.players {
            if wtr::may_decay(pl, bell) {
                // a tile of the farthest bucket
                let b = pl.farthest_bucket();
                let pick = v.provinces.iter().find_map(|tp| {
                    (0..tp.owner.len()).find_map(|i| {
                        (tp.owner[i] == pl.citizen_tag
                            && Some((tp.dist[i] as usize).min(wtr::HIST_BUCKETS - 1)) == b)
                            .then_some((tp.coord, i as u8))
                    })
                });
                if let Some((province, tile)) = pick {
                    // the settle alone first (verify-pr206-209): a home that can
                    // pay again makes the decay refuse, and its transaction then
                    // rolled back its own settle too — upkeep was never taken
                    if pl.paid_to < now_ts {
                        out.push(Step::Settle {
                            citizen: pl.citizen,
                        });
                    }
                    out.push(Step::Decay {
                        citizen: pl.citizen,
                        province,
                        tile,
                    });
                    continue;
                }
            }
            if pl.tiles > 0 && pl.paid_to < now_ts {
                out.push(Step::Settle {
                    citizen: pl.citizen,
                });
            }
        }
        out
    }

    /// 0xDC op 12 WideTerritorySettle: `[payer s,w] [season r] [territory_player w] [citizen w] [home_holding w]`.
    pub fn settle(a: &Addresses, payer: Address, citizen: &[u8; 32], home: Address) -> Instruction {
        let c = ctx(a);
        ix(
            a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(wtr::player_address(&c, citizen)), false),
                AccountMeta::new(adr(*citizen), false),
                AccountMeta::new(home, false),
            ],
            wix::TerritorySettle.to_bytes().to_vec(),
        )
    }

    /// 0xDC op 13 WideTerritoryDecay: `[payer s,w] [season r] [territory_player w] [territory_province w]`.
    pub fn decay(
        a: &Addresses,
        payer: Address,
        citizen: &[u8; 32],
        province: WideCoord,
        tile: u8,
    ) -> Instruction {
        let c = ctx(a);
        ix(
            a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(wtr::player_address(&c, citizen)), false),
                AccountMeta::new(adr(wtr::province_address(&c, province)), false),
            ],
            wix::TerritoryDecay { tile }.to_bytes().to_vec(),
        )
    }

    /// 0xDC op 14 WideTerritoryConquer: `[payer s,w] [season r] [province r] [territory_province w]
    /// [loser_player w] [captor_holding r] [captor_citizen r|w] [captor_player w] [system]`. Listed read-only here;
    /// when the captor already has a summary the role puts the captor's WideTerritorySettle before it in the same
    /// transaction, which makes that Citizen (and its first home) writable in the message — accepted by the program
    /// since conquest-upkeep-fix (owner Q-VT-1 (b), `wix::TERRITORY_CONQUER` `captor_citizen` `Wr::Either`; the
    /// world-3 `.so` 31acbb59 refused it BadAccount, D-verifier-territory-1).
    pub fn conquer(
        a: &Addresses,
        payer: Address,
        province: WideCoord,
        loser_citizen: &[u8; 32],
        captor_holding: Address,
        captor_citizen: &[u8; 32],
    ) -> Instruction {
        let c = ctx(a);
        ix(
            a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new_readonly(adr(wl::province_address(&c, province)), false),
                AccountMeta::new(adr(wtr::province_address(&c, province)), false),
                AccountMeta::new(adr(wtr::player_address(&c, loser_citizen)), false),
                AccountMeta::new_readonly(captor_holding, false),
                AccountMeta::new_readonly(adr(*captor_citizen), false),
                AccountMeta::new(adr(wtr::player_address(&c, captor_citizen)), false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::TerritoryConquer.to_bytes().to_vec(),
        )
    }

    /// The tiles of a wide province (its account bytes) with a village on them: each site whose state is a holding
    /// (the program's `conquer` reads the same, `proc/wide_territory.rs`).
    pub fn village_tiles_of(pd: &[u8]) -> Vec<u8> {
        use frontier_abi::v2::layout::province::{province as PV, site as SM};
        let n = pd.get(PV::SITE_COUNT).map_or(0, |n| (*n as usize).min(12));
        (0..n)
            .filter(|&j| pd.get(PV::site(j) + SM::STATE) == Some(&SM::STATE_HOLDING))
            .filter_map(|j| pd.get(PV::SITES + j).copied())
            .collect()
    }

    /// The home village of a keep captor record: legacy (ring ≤ 128) or wide.
    pub fn captor_holding(a: &Addresses, cap: &wl::KeepCaptor) -> Address {
        let c = ctx(a);
        if cap.home.ring() < FIRST_WIDE_RING {
            a.holding(cap.home.p() as i32, cap.home.q() as i32, cap.site)
        } else {
            adr(wh::holding_address(&c, cap.home, cap.site))
        }
    }

    /// 0xDA op 7 WideClaimTile for `wallet` (actor and payer), witness/village flags as `wide_ix::ClaimTile`.
    #[allow(clippy::too_many_arguments)]
    pub fn claim_tile(
        a: &Addresses,
        wallet: Address,
        citizen: &[u8; 32],
        home: (i32, i32, u8),
        target: WideCoord,
        tile: u8,
        witness: Option<(u8, Address)>,
        village: Option<Address>,
    ) -> Instruction {
        let c = ctx(a);
        let mut accounts = vec![
            AccountMeta::new_readonly(wallet, true),
            AccountMeta::new(wallet, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(*citizen), false),
            AccountMeta::new_readonly(adr(wl::province_address(&c, target)), false),
            AccountMeta::new(adr(wtr::province_address(&c, target)), false),
            AccountMeta::new(adr(wtr::player_address(&c, citizen)), false),
            AccountMeta::new(a.holding(home.0, home.1, home.2), false),
            AccountMeta::new_readonly(a.province(home.0, home.1), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ];
        let wbyte = witness.map_or(0, |(b, _)| b);
        if let Some((_, w)) = witness {
            accounts.push(AccountMeta::new_readonly(w, false));
        }
        if let Some(v) = village {
            accounts.push(AccountMeta::new_readonly(v, false));
        }
        ix(
            a,
            accounts,
            wix::ClaimTile {
                p: target.p(),
                q: target.q(),
                tile,
                witness: wbyte,
                village: village.is_some() as u8,
            }
            .to_bytes()
            .to_vec(),
        )
    }
}

#[cfg(test)]
mod territory_plan_tests {
    use super::territory::*;
    use frontier_abi::world_index::key::WorldId;
    use frontier_abi::world_index::land as wl;
    use frontier_abi::world_index::territory::{self as wtr, TerritoryPlayer, TerritoryProvince};
    use frontier_abi::world_index::territory::{ClaimOk, TerritoryRule};
    use frontier_abi::world_index::WideCoord;

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    fn world() -> WorldId {
        WorldId::new([7; 32]).unwrap()
    }

    fn pl(tag: u64, faction: u8) -> TerritoryPlayer {
        TerritoryPlayer::new(
            1,
            TerritoryRule::V1,
            world(),
            [tag as u8; 32],
            tag,
            faction,
            0,
            [9; 32],
        )
    }

    #[test]
    fn settles_owners_decays_the_farthest_and_moves_conquered_tiles() {
        let mut tp = TerritoryProvince::new(1, TerritoryRule::V1, world(), c(130, 0), 30, [9; 32]);
        let mut a = pl(1, 0);
        let mut b = pl(2, 1);
        let mut mate = pl(3, 1);
        wtr::apply_claim(&mut tp, &mut a, 1, ClaimOk { cost: 0, dist: 2 }, 1).unwrap();
        wtr::apply_claim(&mut tp, &mut a, 2, ClaimOk { cost: 0, dist: 7 }, 2).unwrap();
        wtr::apply_claim(&mut tp, &mut mate, 3, ClaimOk { cost: 0, dist: 1 }, 1).unwrap();
        let mut v = View {
            players: vec![a.clone(), b.clone(), mate.clone()],
            provinces: vec![tp.clone()],
            ..View::default()
        };
        // settle: owners with tiles and a clock behind now; B owns nothing
        let s = plan(&v, 5, 100);
        assert_eq!(
            s,
            vec![
                Step::Settle { citizen: a.citizen },
                Step::Settle {
                    citizen: mate.citizen
                }
            ]
        );
        // A unpaid for 24 bells: its farthest tile (distance 7, tile 2) decays; the settle alone goes first
        // (verify-pr206-209: a home that can pay again refuses the decay, whose transaction would roll back its own
        // settle too). (devnet-territory-dev: this test, then in itest and only `cargo check`ed by CI, still expected
        // the decay first and failed on main ca317418.)
        a.unpaid_since = Some(10);
        v.players[0] = a.clone();
        let s = plan(&v, 34, 100);
        assert_eq!(s[0], Step::Settle { citizen: a.citizen });
        assert_eq!(
            s[1],
            Step::Decay {
                citizen: a.citizen,
                province: c(130, 0),
                tile: 2
            }
        );
        // a summary already settled this second: no settle-alone step, the decay only
        let mut paid = a.clone();
        paid.paid_to = 100;
        v.players[0] = paid;
        assert_eq!(
            plan(&v, 34, 100)[0],
            Step::Decay {
                citizen: a.citizen,
                province: c(130, 0),
                tile: 2
            }
        );
        v.players[0] = a.clone();
        // B's nation took the keep from B's home village: A's tiles move, the teammate's stay
        let cap = wl::KeepCaptor {
            home: c(128, 0),
            site: 1,
            gen: 1,
            keep_gen: 3,
        };
        v.captured.push((c(130, 0), cap, 1));
        v.captor_citizen.insert((c(128, 0), 1), (b.citizen, 1));
        b.tiles = 0;
        let s = plan(&v, 34, 100);
        assert_eq!(
            s[0],
            Step::Conquer {
                province: c(130, 0),
                loser: a.citizen,
                captor: b.citizen,
                captor_has_summary: true,
                captor_holding: cap
            }
        );
        assert_eq!(
            s.iter()
                .filter(|x| matches!(x, Step::Conquer { .. }))
                .count(),
            1
        );
        // (devnet-territory-dev) an owner whose only tile there carries its village is no loser
        let mut only_village = v.clone();
        only_village.village_tiles.insert(c(130, 0), vec![1, 2]);
        assert!(!plan(&only_village, 34, 100)
            .iter()
            .any(|x| matches!(x, Step::Conquer { .. })));
        only_village.village_tiles.insert(c(130, 0), vec![1]);
        assert!(plan(&only_village, 34, 100)
            .iter()
            .any(|x| matches!(x, Step::Conquer { loser, .. } if *loser == a.citizen)));
        // a captor whose nation no longer holds the keep moves nothing
        v.captured[0].2 = 4;
        assert!(!plan(&v, 34, 100)
            .iter()
            .any(|x| matches!(x, Step::Conquer { .. })));
    }
}

/// World goal ② research (research-impl, owner r0ze 2026-11-25 08:56): the
/// class-D crank's instructions and its pure plan — ONE copy for a keeper
/// `research` role (devnet, not built yet) and the local runner's duty
/// (`itest::wide_research`). Handlers: `permutation-frontier/src/proc/wide_research.rs`.
pub mod research {
    use super::*;
    use frontier_abi::world_index::research::{
        self as wre, NationResearch, ResearchWorld, VillageResearch, NATIONS, TECH_COUNT,
    };
    use permutation_rules::frontier::research as kr;

    /// 0xDB op 1 WideStartResearch (the Season authority): `[authority s,w]
    /// [season r] [research_world w] [nation_research w] × 6 [system]`.
    pub fn start(a: &Addresses, authority: Address, rule: u8, start_bell: u32) -> Instruction {
        let c = ctx(a);
        let mut accounts = vec![
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wre::world_address(&c)), false),
        ];
        accounts
            .extend((0..NATIONS).map(|f| AccountMeta::new(adr(wre::nation_address(&c, f)), false)));
        accounts.push(AccountMeta::new_readonly(
            fclient::addr::system_program(),
            false,
        ));
        ix(
            a,
            accounts,
            wix::StartResearch { rule, start_bell }.to_bytes().to_vec(),
        )
    }

    /// 0xDC op 15 WideResearchSettle: `[payer s,w] [season r] [research_world w] [nation_research w]`.
    pub fn settle(a: &Addresses, payer: Address, faction: u8, tech: u8) -> Instruction {
        let c = ctx(a);
        ix(
            a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(adr(wre::world_address(&c)), false),
                AccountMeta::new(adr(wre::nation_address(&c, faction)), false),
            ],
            wix::ResearchSettle { tech }.to_bytes().to_vec(),
        )
    }

    /// 0xDC op 16 WideResearchApply: `[payer s,w] [season r] [research_world r]
    /// [nation_research r] [holding w] [citizen w]`.
    pub fn apply(
        a: &Addresses,
        payer: Address,
        faction: u8,
        holding: Address,
        citizen: &[u8; 32],
    ) -> Instruction {
        let c = ctx(a);
        ix(
            a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new_readonly(adr(wre::world_address(&c)), false),
                AccountMeta::new_readonly(adr(wre::nation_address(&c, faction)), false),
                AccountMeta::new(holding, false),
                AccountMeta::new(adr(*citizen), false),
            ],
            wix::ResearchApply.to_bytes().to_vec(),
        )
    }

    /// A village as the plan sees it.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Village {
        pub address: Address,
        pub owner: [u8; 32],
        pub faction: u8,
        pub mask: VillageResearch,
    }

    /// The chain as [`plan`] sees it.
    #[derive(Clone, Default)]
    pub struct View {
        pub world: Option<ResearchWorld>,
        /// By faction (absent records: `None`).
        pub nations: Vec<Option<NationResearch>>,
        /// Final villages (first homes and wide villages) with an owner.
        pub villages: Vec<Village>,
    }

    /// One crank step.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Step {
        /// A nation whose total reaches the (discounted) cost learns the tech.
        Settle { faction: u8, tech: u8 },
        /// The nation's techs (and the banked-science cut) to a village.
        Apply {
            holding: Address,
            owner: [u8; 32],
            faction: u8,
        },
    }

    /// The steps due at `bell` (pure): every settle due, then every village
    /// whose mask is not the one its nation's knowledge gives (only from the
    /// start bell; nothing while paused or before research started).
    pub fn plan(v: &View, bell: u32) -> Vec<Step> {
        let Some(w) = v.world.as_ref() else {
            return vec![];
        };
        if w.paused || bell < w.start_bell {
            return vec![];
        }
        let p = w.rule.params();
        let mut out = vec![];
        for n in v.nations.iter().flatten() {
            for t in 0..TECH_COUNT as u8 {
                let others = w.others_discounting(t, n.faction, bell);
                if kr::judge_settle(p, t, w.era, &n.view(), others).is_ok() {
                    out.push(Step::Settle {
                        faction: n.faction,
                        tech: t,
                    });
                }
            }
        }
        for vil in &v.villages {
            let Some(Some(n)) = v.nations.get(vil.faction as usize) else {
                continue;
            };
            if vil.mask != VillageResearch::new(n.known, vil.faction, true) {
                out.push(Step::Apply {
                    holding: vil.address,
                    owner: vil.owner,
                    faction: vil.faction,
                });
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use frontier_abi::world_index::key::WorldId;
        use frontier_abi::world_index::research::ResearchRule;

        fn view() -> View {
            let w = ResearchWorld::new(
                1,
                ResearchRule::V1,
                WorldId::new([3; 32]).unwrap(),
                5,
                0,
                [0; 32],
            );
            let nations = (0..NATIONS)
                .map(|f| {
                    Some(NationResearch::new(
                        1,
                        ResearchRule::V1,
                        f,
                        WorldId::new([3; 32]).unwrap(),
                        [0; 32],
                    ))
                })
                .collect();
            View {
                world: Some(w),
                nations,
                villages: vec![],
            }
        }

        #[test]
        fn nothing_before_the_start_or_while_paused() {
            let mut v = view();
            v.villages.push(Village {
                address: Address::new_from_array([9; 32]),
                owner: [1; 32],
                faction: 2,
                mask: VillageResearch(0),
            });
            assert!(plan(&v, 4).is_empty());
            assert_eq!(plan(&v, 5).len(), 1, "the first apply: nation and the cut");
            v.world.as_mut().unwrap().paused = true;
            assert!(plan(&v, 9).is_empty());
        }

        #[test]
        fn settles_when_a_discount_brings_the_cost_under_the_total() {
            let mut v = view();
            v.nations[3].as_mut().unwrap().pledged[0] = 250;
            assert!(plan(&v, 6).is_empty());
            v.world.as_mut().unwrap().known_by[0] = 1; // nation 0 knows agriculture → 240
            v.nations[0].as_mut().unwrap().known = 1;
            assert_eq!(
                plan(&v, 6),
                vec![Step::Settle {
                    faction: 3,
                    tech: 0
                }]
            );
        }

        #[test]
        fn a_village_already_carrying_its_nations_techs_is_left_alone() {
            let mut v = view();
            v.nations[2].as_mut().unwrap().known = 0b11;
            let a = Address::new_from_array([9; 32]);
            v.villages.push(Village {
                address: a,
                owner: [1; 32],
                faction: 2,
                mask: VillageResearch::new(0b11, 2, true),
            });
            v.villages.push(Village {
                address: a,
                owner: [1; 32],
                faction: 2,
                mask: VillageResearch::new(0b01, 2, true),
            });
            // a captured village: the stored nation is another one
            v.villages.push(Village {
                address: a,
                owner: [1; 32],
                faction: 2,
                mask: VillageResearch::new(0b11, 4, true),
            });
            assert_eq!(plan(&v, 6).len(), 2);
        }
    }
}
