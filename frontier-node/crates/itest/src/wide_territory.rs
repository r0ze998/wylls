//! **TEST-ONLY player territory duty** in a local wide world (territory-impl, owner decisions 2026-11-24 12:09 JST:
//! single-tile claims, food upkeep from the first home, unpaid → claims stop → after 24 turns the farthest tile returns
//! one per turn, a captured keep moves its province's tiles; program `proc/wide_territory.rs`).
//!
//! The claims are the players' (page, AI residents). What the program leaves to a class-D crank — on devnet a keeper
//! role, here this duty because play-local runs no keeper crate — is, once a bell:
//!
//! 1. **settle** every territory's upkeep (WideTerritorySettle: paid, or unpaid since this bell);
//! 2. **decay**: a territory unpaid for the grace returns one tile of its farthest distance (WideTerritorySettle then
//!    WideTerritoryDecay in ONE transaction: the program requires the settle in the same second);
//! 3. **conquest**: a wide province whose keep was taken (the captor record the resolve wrote, at the keep's current
//!    generation) moves every tile of each non-teammate owner to the captor (settle both, then WideTerritoryConquer,
//!    one transaction per loser).
//!
//! [`plan`] is pure over the program's accounts; nothing is written directly. Every line printed says
//! `test_only: true`.
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{Instruction, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::player::holding as H;
use frontier_abi::world_index::holding::{self as wh, SlotBinding};
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::territory::{self as wtr, TerritoryPlayer, TerritoryProvince};
use keeper_core::widelane::territory as kt;
use localnet::server::{lock, Shared};
use localnet::Chain;
use serde_json::{json, Value};

pub const TERRITORY_SCHEMA: &str = "frontier-localnet-wide-territory-v1";
/// Transactions sent per bell at most (the rest wait for the next bell).
pub const SENDS_PER_BELL: usize = 24;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

pub use keeper_core::widelane::territory::{plan, Step, View};

/// The program's territory records and captured wide provinces of this season.
fn scan(c: &Chain, a: &Addresses) -> View {
    let ctx = ctx_of(a);
    let mut v = View::default();
    for (k, acc) in c.program_accounts(&a.program) {
        let kb = k.to_bytes();
        if let Ok(p) = TerritoryPlayer::read(&acc.data) {
            if p.season_id == a.season_id && kb == wtr::player_address(&ctx, &p.citizen) {
                v.players.push(p);
            }
        } else if let Ok(p) = TerritoryProvince::read(&acc.data) {
            if p.season_id == a.season_id && kb == wtr::province_address(&ctx, p.coord) {
                v.provinces.push(p);
            }
        } else if let Ok(p) = WideProvince::read(&acc.data) {
            if p.season_id != a.season_id || kb != wl::province_address(&ctx, p.coord) {
                continue;
            }
            let Ok(Some(cap)) = wl::captor_of(&acc.data) else {
                continue;
            };
            let Ok(Some(keep)) = frontier_abi::conquest_model::read_keep(&acc.data) else {
                continue;
            };
            if keep.gen == cap.keep_gen {
                v.captured.push((p.coord, cap, keep.holder));
                v.village_tiles
                    .insert(p.coord, kt::village_tiles_of(&acc.data));
            }
        }
    }
    for (_, cap, _) in &v.captured {
        let hk = kt::captor_holding(a, cap);
        let Some(h) = c.account(&hk).filter(|x| x.owner == a.program) else {
            continue;
        };
        let (Some(owner), Some(gen)) = (
            h.data.get(H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32),
            h.data.get(H::GEN),
        ) else {
            continue;
        };
        if *gen != cap.gen {
            continue;
        }
        let mut o = [0u8; 32];
        o.copy_from_slice(owner);
        let faction = c
            .account(&fclient::Address::new_from_array(o))
            .and_then(|x| {
                x.data
                    .get(frontier_abi::layout::player::citizen::FACTION)
                    .copied()
            });
        if let Some(f) = faction {
            v.captor_citizen.insert((cap.home, cap.site), (o, f));
        }
    }
    v
}

/// The first home of a Citizen (its slot-1 binding), as a Holding address.
fn home_of(c: &Chain, a: &Addresses, citizen: &[u8; 32]) -> Option<fclient::Address> {
    let acc = c.account(&fclient::Address::new_from_array(*citizen))?;
    match wh::bindings_of(&acc.data).ok()?[0] {
        SlotBinding::Legacy(h) => Some(a.holding(h.p as i32, h.q as i32, h.site)),
        _ => None,
    }
}

fn ixs_of(c: &Chain, a: &Addresses, payer: fclient::Address, s: &Step) -> Option<Vec<Instruction>> {
    match s {
        Step::Settle { citizen } => {
            Some(vec![kt::settle(a, payer, citizen, home_of(c, a, citizen)?)])
        }
        Step::Decay {
            citizen,
            province,
            tile,
        } => Some(vec![
            kt::settle(a, payer, citizen, home_of(c, a, citizen)?),
            kt::decay(a, payer, citizen, *province, *tile),
        ]),
        Step::Conquer {
            province,
            loser,
            captor,
            captor_has_summary,
            captor_holding,
        } => {
            let mut v = vec![kt::settle(a, payer, loser, home_of(c, a, loser)?)];
            if *captor_has_summary {
                v.push(kt::settle(a, payer, captor, home_of(c, a, captor)?));
            }
            v.push(kt::conquer(
                a,
                payer,
                *province,
                loser,
                kt::captor_holding(a, captor_holding),
                captor,
            ));
            Some(v)
        }
    }
}

/// The duty (module doc), until `stop`.
pub async fn run(
    state: Shared,
    a: Addresses,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    let payer = crate::keeper_loop::fund_fresh(&state, &mut stop).await?;
    out(
        json!({"schema": TERRITORY_SCHEMA, "wide_territory_step": "duty", "test_only": true,
        "per_bell": SENDS_PER_BELL}),
    );
    let mut last_bell = None;
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let (bell, work) = {
            let c = lock(&state);
            let clock = crate::local_keeper::season_clock(&c, &a)?;
            let now = c.unix_timestamp();
            let bell = clock.bell_at(now).unwrap_or(0);
            if last_bell == Some(bell) {
                (bell, vec![])
            } else {
                let v = scan(&c, &a);
                let mut steps = plan(&v, bell, now);
                // (verify-pr206-209) more steps than a bell's sends: start at
                // another place each bell, so the last players are not starved
                if steps.len() > SENDS_PER_BELL {
                    let k = (bell as usize).wrapping_mul(SENDS_PER_BELL) % steps.len();
                    steps.rotate_left(k);
                }
                let work: Vec<(Step, Vec<Instruction>)> = steps
                    .into_iter()
                    .filter_map(|s| match ixs_of(&c, &a, payer.pubkey(), &s) {
                        Some(i) => Some((s, i)),
                        None => {
                            println!("territory: {s:?} skipped (no first home to name)");
                            None
                        }
                    })
                    .take(SENDS_PER_BELL)
                    .collect();
                (bell, work)
            }
        };
        if last_bell != Some(bell) {
            last_bell = Some(bell);
            for (step, ixs) in work {
                let what = format!("{step:?}");
                let sent = crate::keeper_loop::submit_ixs_and_wait(
                    &state,
                    &payer,
                    ixs,
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await;
                let (kind, ok) = match (&step, &sent) {
                    (Step::Settle { .. }, s) => {
                        ("settle", matches!(s, crate::keeper_loop::Sent::Landed(_)))
                    }
                    (Step::Decay { .. }, s) => {
                        ("decay", matches!(s, crate::keeper_loop::Sent::Landed(_)))
                    }
                    (Step::Conquer { .. }, s) => {
                        ("conquer", matches!(s, crate::keeper_loop::Sent::Landed(_)))
                    }
                };
                // settles are routine: only decay, conquest and failures are printed
                if kind != "settle" || !ok {
                    out(
                        json!({"schema": TERRITORY_SCHEMA, "wide_territory_step": kind, "test_only": true,
                        "bell": bell, "landed": ok, "what": what, "result": format!("{sent:?}")}),
                    );
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
            _ = stop.changed() => {}
        }
    }
}
