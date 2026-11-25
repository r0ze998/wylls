//! **TEST-ONLY research duty** in a local wide world (world goal ②, research-impl; owner r0ze 2026-11-25 08:56 JST:
//! every Q-RS recommendation; program `proc/wide_research.rs`). The world starts research at its genesis (bell 0;
//! `natural_play` sends WideStartResearch with the Season authority right after the wide land's growth), so every
//! nation starts from 0 science at the same bell (Q-RS-3 (b)).
//!
//! The pledges are the players' (page, AI residents). What the program leaves to a class-D crank — on devnet a keeper
//! `research` role (not built yet), here this duty because play-local runs no keeper crate — is, once a bell:
//!
//! 1. **settle**: a nation whose pledged total reaches a cost another nation's learning has since discounted learns it
//!    (WideResearchSettle);
//! 2. **apply**: every final village whose two research bytes are not its nation's knowledge (a new tech, a capture,
//!    the first touch after the start that cuts the banked science) gets them (WideResearchApply).
//!
//! [`keeper_core::widelane::research::plan`] is pure over the program's accounts; nothing is written directly. Every
//! line printed says `test_only: true`.
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{Instruction, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::layout::player::holding as H2;
use frontier_abi::world_index::holding::WideHolding;
use frontier_abi::world_index::research::{
    self as wre, NationResearch, ResearchWorld, VillageResearch,
};
use keeper_core::widelane::research::{self as kr, Step, View, Village};
use localnet::server::{lock, Shared};
use localnet::Chain;
use serde_json::{json, Value};

pub const RESEARCH_SCHEMA: &str = "frontier-localnet-wide-research-v1";
/// Transactions sent per bell at most (the rest wait for the next bell).
pub const SENDS_PER_BELL: usize = 24;
/// The research rule a local wide world plays (V1, the owner's 08:56 answers).
pub const RULE: u8 = 1;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

/// The research records and the final villages of this season.
fn scan(c: &Chain, a: &Addresses) -> View {
    let ctx = ctx_of(a);
    let mut v = View {
        nations: vec![None; wre::NATIONS as usize],
        ..View::default()
    };
    let magic = frontier_abi::v2::layout::player::holding::MAGIC;
    for (k, acc) in c.program_accounts(&a.program) {
        let kb = k.to_bytes();
        let d = &acc.data;
        if let Ok(w) = ResearchWorld::read(d) {
            if w.season_id == a.season_id && kb == wre::world_address(&ctx) {
                v.world = Some(w);
            }
        } else if let Ok(n) = NationResearch::read(d) {
            if n.season_id == a.season_id && kb == wre::nation_address(&ctx, n.faction) {
                let f = n.faction as usize;
                v.nations[f] = Some(n);
            }
        } else if d.len() >= H2::SIZE && d[..8] == magic {
            // a first home or a wide village: the deployed Holding head
            let wide_ok = WideHolding::read(d)
                .map(|w| w.season_id == a.season_id)
                .unwrap_or(false);
            let season_ok =
                u64::from_le_bytes(d[8..16].try_into().unwrap_or_default()) == a.season_id;
            if !(wide_ok || season_ok) || d[H2::STATE] != H2::STATE_FINAL {
                continue;
            }
            let owner: [u8; 32] = d[H2::OWNER_CITIZEN..H2::OWNER_CITIZEN + 32]
                .try_into()
                .unwrap_or([0; 32]);
            if owner == [0; 32] || d[H2::FACTION] >= wre::NATIONS {
                continue;
            }
            v.villages.push(Village {
                address: k,
                owner,
                faction: d[H2::FACTION],
                mask: VillageResearch::from_le([d[H2::RSV_1258], d[H2::RSV_1258 + 1]]),
            });
        }
    }
    v
}

fn ixs_of(a: &Addresses, payer: fclient::Address, s: &Step) -> Vec<Instruction> {
    match s {
        Step::Settle { faction, tech } => vec![kr::settle(a, payer, *faction, *tech)],
        Step::Apply {
            holding,
            owner,
            faction,
        } => vec![kr::apply(a, payer, *faction, *holding, owner)],
    }
}

/// The world's WideStartResearch (the Season authority), sent once at the world's preparation (start bell 0).
pub fn start_ix(a: &Addresses, authority: fclient::Address) -> Instruction {
    kr::start(a, authority, RULE, 0)
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
        json!({"schema": RESEARCH_SCHEMA, "wide_research_step": "duty", "test_only": true, "per_bell": SENDS_PER_BELL}),
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
                let mut steps = kr::plan(&scan(&c, &a), bell);
                if steps.len() > SENDS_PER_BELL {
                    let k = (bell as usize).wrapping_mul(SENDS_PER_BELL) % steps.len();
                    steps.rotate_left(k);
                }
                steps.truncate(SENDS_PER_BELL);
                (bell, steps)
            }
        };
        if last_bell != Some(bell) {
            last_bell = Some(bell);
            for step in work {
                let what = format!("{step:?}");
                let sent = crate::keeper_loop::submit_ixs_and_wait(
                    &state,
                    &payer,
                    ixs_of(&a, payer.pubkey(), &step),
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await;
                let ok = matches!(sent, crate::keeper_loop::Sent::Landed(_));
                let kind = match step {
                    Step::Settle { .. } => "settle",
                    Step::Apply { .. } => "apply",
                };
                out(
                    json!({"schema": RESEARCH_SCHEMA, "wide_research_step": kind, "test_only": true,
                    "bell": bell, "landed": ok, "what": what, "result": format!("{sent:?}")}),
                );
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
            _ = stop.changed() => {}
        }
    }
}
