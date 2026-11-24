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
/// `proc/wide_territory.rs`, accounts `wide_ix::TERRITORY_*`). The keeper's devnet role and the local runner's duty
/// (`itest::wide_territory`) send these; the claim itself (0xDA op 7) is a player's.
pub mod territory {
    use super::*;
    use frontier_abi::world_index::territory as wtr;

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
    /// [loser_player w] [captor_holding r] [captor_citizen r] [captor_player w] [system]`.
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
