//! P4: owner decision Q-W1 (2026-11-20 t398u, "おすすめで"): on a devnet configuration that includes the wide land
//! (`S1_DEVNET_WIDE_7D`, playable lane 0x4804) a player's FIRST village may also be founded on the RIM (rings
//! 126–128, beside the wide land), as in local wide play; from it, a wide claim.
//!
//! After P3's real setup (the operator's 10 transactions, keeper A seeding the season from a shipped quicknet round,
//! the herald) on the exact devnet `.so`, with keeper A configured as the devnet profile now says (roles `beacon`,
//! `rings`, `fold`, **`tickets`**; rings duty `extend`, `lazy_provinces`, **`rim_per_wedge` 6**):
//!
//! 1. **Declared patch** (`set_account`, like `verify/tests/playable_wide_land.rs`): the map grown to the rim, i.e.
//!    Frontier `rings_opened` 129, `r_max_ext` 128, the wedge counters (θ), and RingSeed(128) seeded with a copy of
//!    the genesis ring 3's seed. On devnet keeper A's rings duty reaches this by its own ExtendFrontier / OpenRing /
//!    ConsumeRingSeed, one ring per bell (~21 h), each on its own drand round; the workspace ships 32 rounds
//!    around the genesis, so the 125 rings in between are declared, not replayed.
//! 2. REAL, keeper A: the `rim_per_wedge` duty opens the rim's provinces (OpenProvince, rent from the wedge funds).
//! 3. REAL, a test participant: Join (the nation of a rim province) and **FileTicket** for one rim site.
//! 4. **Declared patch**: THE anchor (BellAnchor) and the SeedCache of the ticket's bell and region, in the shapes
//!    PostAnchor / PostSeed leave (`wide_land_runtime_tests::stage_seed`, as `playable_wide_claims.rs`): the
//!    ticket's bell has no shipped round (no T(b) of a season whose genesis is a shipped round is shipped; checked
//!    for every shipped genesis). On devnet keeper A's `beacon` role posts both from the live rounds.
//! 5. REAL, keeper A's **`tickets` role**: SettleTicket → the participant's FIRST village on the rim (provisional),
//!    the herald shows it.
//! 6. REAL: the wide ring 129 by its own instructions (WideRequestRingSeed bound to a SHIPPED round,
//!    WideConsumeRingSeed with that round's real signature, WideOpenProvince beside the rim village), sent by this
//!    test as any permissionless payer would (no keeper duty opens the wide rings yet: runbook §7 P6).
//! 7. REAL: the clock past the home's `final_ts`; the participant's Harvest flips it final (the lazy flip) and
//!    collects its production; then **WideClaimSite (0xD9) from the rim Hamlet** (`outpost_tier_min` 0, Q-W1).
//! 8. **Declared patch** of the claim bell's anchor and seed (as 4), then REAL WideSettleTicket (0xDC) and, once
//!    due, WideFinalize (0xDF), sent by this test (the itest `run_claims` duty's instructions; no production
//!    keeper role sends them yet: runbook §7 P7).
//!
//! Every instruction's compute units and lamports are recorded.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::ports::Account;
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS, season as S};
use frontier_abi::v2::layout::province::{province as PV, site as SM};
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::presets::ConquestParams;
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::land::{self as wl, WideProvince, FIRST_WIDE_RING};
use frontier_abi::world_index::rules as wr;
use frontier_abi::world_index::ticket::{self as wt, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::WideCoord;
use permutation_rules::frontier::beacon::{self as kb, round_time, BeaconClock, WindowSchedule};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord, R_MAX_HARD};
use serde_json::{json, Value};

/// keeper A's `rim_per_wedge` (the devnet profile's value).
pub const PER_WEDGE: usize = 6;
const SOL: u64 = 1_000_000_000;
const SEASON_ID: u64 = 1;

pub struct Ctx<'a> {
    pub state: Arc<Mutex<localnet::Chain>>,
    pub a: Addresses,
    pub program: Address,
    pub herald: u16,
    pub dir: std::path::PathBuf,
    pub keeper: &'a mut std::process::Child,
}

struct Run<'a> {
    c: Ctx<'a>,
    rows: Vec<Value>,
    patches: Vec<String>,
    /// While recording the wide claim's witnessed segment (as `verify/tests/playable_wide_claims.rs`): the state of
    /// every account a segment instruction names, read before its first use; the accounts the segment wrote; its
    /// transactions.
    witness: Option<Witness>,
}

#[derive(Default)]
struct Witness {
    snapshot: std::collections::BTreeMap<[u8; 32], Option<Account>>,
    written: std::collections::BTreeSet<[u8; 32]>,
    txs: Vec<fclient::ports::TxRecord>,
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

fn budget() -> tx::TxBudget {
    tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: None,
    }
}

fn le_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn le_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

impl<'a> Run<'a> {
    fn lock(&self) -> MutexGuard<'_, localnet::Chain> {
        self.c.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn ctx(&self) -> AddrCtx {
        AddrCtx {
            program: self.c.program.to_bytes(),
            season: self.c.a.season.to_bytes(),
        }
    }
    fn data(&self, k: &Address) -> Option<Vec<u8>> {
        self.lock().account(k).map(|a| a.data)
    }
    fn now(&self) -> i64 {
        self.lock().unix_timestamp()
    }
    fn season(&self) -> Vec<u8> {
        self.data(&self.c.a.season).expect("the Season")
    }
    fn clock(&self) -> (BeaconClock, WindowSchedule, u32, i64) {
        let sd = self.season();
        (
            BeaconClock {
                genesis: le_i64(&sd, S::DRAND_GENESIS),
                period: le_u32(&sd, S::DRAND_PERIOD) as i64,
            },
            WindowSchedule {
                reveal_window: le_u32(&sd, S::REVEAL_WINDOW),
                window_next: le_u32(&sd, S::WINDOW_NEXT),
                window_from_bell: le_u32(&sd, S::WINDOW_FROM_BELL),
            },
            le_u32(&sd, S::SEED_MARGIN),
            le_i64(&sd, S::GENESIS_TS),
        )
    }
    fn bell(&self) -> u32 {
        let g = self.clock().3;
        ((self.now() - g).max(0) / 600) as u32
    }
    /// Stops the chain's own slots and moves its clock to exactly `t` (a slot's length is 0.4 s × the scale).
    fn advance_exact(&self, t: i64) {
        let mut c = self.lock();
        c.set_paused(true);
        while c.unix_timestamp() < t {
            let gap_ms = t * 1_000 - c.game_ms();
            c.set_scale((gap_ms as f64 / 400.0).max(1.0));
            c.produce_block();
        }
        c.set_scale(1.0);
    }
    /// Lets the chain (and so keeper A) run at `scale` until `done` or `secs` wall seconds.
    async fn run_until(
        &self,
        scale: f64,
        secs: u64,
        what: &str,
        mut done: impl FnMut(&Self) -> bool,
    ) {
        {
            let mut c = self.lock();
            c.set_scale(scale);
            c.set_paused(false);
        }
        let t0 = Instant::now();
        while !done(self) {
            if t0.elapsed() > Duration::from_secs(secs) {
                let log =
                    std::fs::read_to_string(self.c.dir.join("keeper.log")).unwrap_or_default();
                let tail: Vec<_> = log.lines().rev().take(60).collect();
                let fails: Vec<String> = self
                    .lock()
                    .feed(0, 1_000_000, Some(&self.c.program))
                    .into_iter()
                    .filter(|l| l.err.is_some())
                    .rev()
                    .take(12)
                    .map(|l| {
                        format!(
                            "{:?} {:?}",
                            l.err,
                            l.logs.iter().rev().take(4).collect::<Vec<_>>()
                        )
                    })
                    .collect();
                panic!(
                    "{what}: not reached in {secs} s (chain clock {}, bell {})\nlast failed program txs:\n{}\nkeeper log tail:\n{}",
                    self.now(),
                    self.bell(),
                    fails.join("\n"),
                    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
                );
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let mut c = self.lock();
        c.set_scale(1.0);
    }
    /// Sends one transaction on the paused chain (this slot), records its CU and lamports, returns its row.
    fn try_send(
        &mut self,
        what: &str,
        ixs: &[Instruction],
        signers: &[&Keypair],
        who: &str,
    ) -> Value {
        let mut c = self.c.state.lock().unwrap_or_else(|e| e.into_inner());
        c.set_paused(true);
        if let Some(wit) = self.witness.as_mut() {
            for i in ixs {
                for m in &i.accounts {
                    let k = m.pubkey.to_bytes();
                    if wit.written.contains(&k) || wit.snapshot.contains_key(&k) {
                        continue;
                    }
                    let acct = c.account(&m.pubkey).filter(|x| x.owner == self.c.program);
                    wit.snapshot.insert(k, acct);
                }
            }
        }
        let (bh, _) = c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &bh).expect("build");
        let payer = signers[0].pubkey();
        let before = c.balance(&payer);
        let row = match c.submit(&tx::wire(&t)) {
            Ok(sig) => {
                c.produce_block();
                let l = c.transaction(&sig).cloned().expect("landed");
                if let Some(wit) = self.witness.as_mut() {
                    if l.err.is_none() {
                        for i in ixs {
                            for m in i.accounts.iter().filter(|m| m.is_writable) {
                                wit.written.insert(m.pubkey.to_bytes());
                            }
                        }
                    }
                    wit.txs.push(l.record());
                }
                json!({"tx": what, "by": who, "ok": l.err.is_none(), "err": l.err, "code": l.code,
                    "compute_units": l.units, "fee": l.fee, "slot": l.slot, "chain_ts": c.unix_timestamp(),
                    "lamports_from_payer": before.saturating_sub(c.balance(&payer)),
                    "logs_tail": if l.err.is_some() { json!(l.logs.iter().rev().take(6).collect::<Vec<_>>()) } else { Value::Null }})
            }
            Err(e) => {
                json!({"tx": what, "by": who, "ok": false, "err": format!("refused before landing: {e}")})
            }
        };
        drop(c);
        self.rows.push(row.clone());
        row
    }
    fn send(&mut self, what: &str, ixs: &[Instruction], signers: &[&Keypair], who: &str) -> Value {
        let r = self.try_send(what, ixs, signers, who);
        assert_eq!(r["ok"], true, "{what}: {r:#}");
        r
    }
    fn simulate_ok(&self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
        let c = self.lock();
        let (bh, _) = c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &bh).expect("build");
        match c.simulate(&tx::wire(&t), false) {
            Ok(r) if r.err.is_none() => Ok(r.units),
            Ok(r) => Err(format!("{:?} code {:?}", r.err, r.code)),
            Err(e) => Err(format!("{e}")),
        }
    }
    /// A declared fixture patch (not an instruction).
    fn patch(&mut self, k: Address, a: Account, what: &str) {
        self.lock().set_account(k, a).expect("patch");
        self.patches.push(format!("PATCH (set_account): {what}"));
    }
    /// THE anchor and the SeedCache (nonce 0) of `(bell, region)` in the shapes PostAnchor / PostSeed leave, with a
    /// literal seed; the anchor's `A` is 100 s after the bell's end (`playable_wide_claims.rs` `stage_seed`).
    fn stage_seed(&mut self, bell: u32, region: u8, seed: [u8; 32]) {
        let ctx = self.ctx();
        let (clock, sched, margin, genesis_ts) = self.clock();
        let a_ts = genesis_ts + 600 * (bell as i64 + 1) + 100;
        let round = kb::seed_round(
            &clock,
            kb::reveal_close(a_ts, kb::window(&sched, bell)),
            margin,
        );
        let anchor_key = ctx.bell_anchor(bell, region);
        let mut ad = vec![0u8; K2::BellAnchor.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut ad,
            K2::BellAnchor,
            SEASON_ID
        ));
        ad[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        ad[BA::REGION] = region;
        ad[BA::ROUND..BA::ROUND + 8].copy_from_slice(&round.to_le_bytes());
        ad[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        ad[BA::SLOT..BA::SLOT + 8].copy_from_slice(&1u64.to_le_bytes());
        let mut cd = vec![0u8; K2::SeedCache.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut cd,
            K2::SeedCache,
            SEASON_ID
        ));
        cd[SC::BELL..SC::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        cd[SC::REGION] = region;
        cd[SC::ROUND..SC::ROUND + 8].copy_from_slice(&round.to_le_bytes());
        cd[SC::SEED..SC::SEED + 32].copy_from_slice(&seed);
        cd[SC::ANCHOR_KEY..SC::ANCHOR_KEY + 32].copy_from_slice(&anchor_key);
        cd[SC::A..SC::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        let program = self.c.program;
        let acct = |data: Vec<u8>| Account {
            lamports: SOL,
            data,
            owner: program,
            executable: false,
        };
        self.patch(
            adr(anchor_key),
            acct(ad),
            &format!("BellAnchor(bell {bell}, region {region}), round {round}"),
        );
        self.patch(
            adr(ctx.seed_cache(bell, region, 0)),
            acct(cd),
            &format!("SeedCache(bell {bell}, region {region}, nonce 0), literal seed"),
        );
    }
    fn feed_rows(&self, since_slot: u64, tags: &[u8], who: &str) -> Vec<Value> {
        self.lock()
            .feed(0, 1_000_000, Some(&self.c.program))
            .into_iter()
            .filter(|l| l.slot > since_slot)
            .filter_map(|l| {
                let t = fclient::tx::from_wire(&l.wire).ok()?;
                let ix = t.message.instructions.iter().find(|i| {
                    t.message.account_keys.get(i.program_id_index as usize) == Some(&self.c.program)
                })?;
                let tag = *ix.data.first()?;
                // (OpenProvince: its P, Q)
                let pq = (tag == fclient::abi::tag::OPEN_PROVINCE && ix.data.len() >= 5).then(|| {
                    (
                        i16::from_le_bytes([ix.data[1], ix.data[2]]),
                        i16::from_le_bytes([ix.data[3], ix.data[4]]),
                    )
                });
                tags.contains(&tag).then(|| {
                    json!({"tag": format!("0x{tag:02X}"), "by": who, "ok": l.err.is_none(), "err": l.err,
                        "p": pq.map(|x| x.0), "q": pq.map(|x| x.1),
                        "compute_units": l.units, "fee": l.fee, "slot": l.slot,
                        "lamports_from_payer": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
                })
            })
            .collect()
    }
}

fn wide_ix(a: &Addresses, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts,
        data,
    }
}

pub async fn run(c: Ctx<'_>) -> Value {
    let mut r = Run {
        c,
        rows: vec![],
        patches: vec![],
        witness: None,
    };
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    assert_eq!(
        cq.outpost_tier_min, 0,
        "Q-W1: the devnet wide preset's Hamlet anchor"
    );
    assert_eq!(cq.r_max_ceiling, R_MAX_HARD);
    let (clock, _, margin, genesis_ts) = r.clock();
    let rounds = FixtureDrand::load(&fb::fixture_dir(), fb::quicknet_info())
        .expect("the shipped rounds verify")
        .rounds;
    let payer = Keypair::new(); // TEST key: the permissionless sender of the wide ring's instructions
    r.lock().airdrop(&payer.pubkey(), 50 * SOL).unwrap();

    // 1. Declared: the map grown to the rim.
    let rs3 = r
        .lock()
        .account(&adr(ctx.ring_seed(cq.heartland_max_ring as u16)))
        .expect("a real seeded genesis RingSeed");
    assert_eq!(rs3.data[RS::STATUS], RS::STATUS_SEEDED);
    let mut rs = rs3.clone();
    rs.data[RS::D..RS::D + 2].copy_from_slice(&R_MAX_HARD.to_le_bytes());
    rs.data[RS::OPENED_BELL..RS::OPENED_BELL + 4].copy_from_slice(&0u32.to_le_bytes());
    r.patch(
        adr(ctx.ring_seed(R_MAX_HARD)),
        rs,
        "RingSeed(128) seeded (the genesis ring's seed, opened_bell 0)",
    );
    let mut fr = r.lock().account(&a.frontier()).expect("the Frontier");
    fr.data[FR::RINGS_OPENED..FR::RINGS_OPENED + 2]
        .copy_from_slice(&(R_MAX_HARD + 1).to_le_bytes());
    fr.data[FR::R_MAX_EXT..FR::R_MAX_EXT + 2].copy_from_slice(&R_MAX_HARD.to_le_bytes());
    for w in 0..6 {
        let o = FR::WEDGE_OPEN + 4 * w;
        let open = le_u32(&fr.data, o).max(1);
        fr.data[o..o + 4].copy_from_slice(&open.to_le_bytes());
        let oc = FR::WEDGE_OCCUPIED + 4 * w;
        fr.data[oc..oc + 4].copy_from_slice(&open.to_le_bytes());
    }
    r.patch(
        a.frontier(),
        fr,
        "Frontier rings_opened 129, r_max_ext 128, wedge_occupied = wedge_open",
    );
    let patched_slot = r.lock().slot();

    // 2. keeper A's rim duty opens the rim's provinces.
    let plan = keeper_core::rings::rim_plan(PER_WEDGE);
    let t_rim = Instant::now();
    r.run_until(5.0, 240, "keeper A opens the rim's provinces", |r| {
        plan.iter()
            .all(|&(p, q)| r.lock().account(&r.c.a.province(p, q)).is_some())
    })
    .await;
    let rim_secs = t_rim.elapsed().as_secs_f64();
    let rim_open: Vec<Value> = r
        .feed_rows(
            patched_slot,
            &[fclient::abi::tag::OPEN_PROVINCE],
            "keeper A",
        )
        .into_iter()
        .filter(|x| {
            let (p, q) = (x["p"].as_i64().unwrap_or(0), x["q"].as_i64().unwrap_or(0));
            ProvinceCoord::new(p as i32, q as i32).ring() == u32::from(R_MAX_HARD)
        })
        .collect();
    let rim_ok: Vec<&Value> = rim_open.iter().filter(|x| x["ok"] == true).collect();
    assert_eq!(rim_ok.len(), plan.len(), "{rim_open:#?}");

    // The participant's rim province: the first of the plan whose mixed nation has a free site.
    let (rp, rq, nation) = plan
        .iter()
        .find_map(|&(p, q)| {
            let n = home_nation(
                ProvinceCoord::new(p, q),
                cq.placement,
                cq.heartland_max_ring,
                &gseed,
            )?;
            Some((p, q, n))
        })
        .expect("a rim province with a nation");
    let pd = r.data(&a.province(rp, rq)).unwrap();
    let rsite = (0..pd[PV::SITE_COUNT] as usize)
        .find(|i| {
            matches!(
                pd[PV::site(*i) + SM::STATE],
                SM::STATE_FREE | SM::STATE_RELEASED_FREE
            )
        })
        .expect("a free rim site") as u8;
    // The wide target: a ring-129 neighbour of the rim province.
    let target = [(1i64, 0i64), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
        .iter()
        .map(|(dp, dq)| WideCoord::checked(rp as i64 + dp, rq as i64 + dq).unwrap())
        .find(|c| c.ring() == FIRST_WIDE_RING)
        .expect("the rim province borders ring 129");

    // 6 (first, while the shipped rounds last): the wide ring 129, bound to a shipped round.
    let bound = rounds
        .keys()
        .copied()
        .find(|&rr| {
            let t = round_time(clock.genesis, clock.period as u32, rr)
                - permutation_rules::frontier::beacon::SEED_LEAD_SECS
                - margin as i64
                - 1;
            t > r.now() + 2 && t >= genesis_ts + 600
        })
        .expect("a shipped round after now");
    let t_req = round_time(clock.genesis, clock.period as u32, bound)
        - permutation_rules::frontier::beacon::SEED_LEAD_SECS
        - margin as i64
        - 1;
    r.advance_exact(t_req - 1);
    assert_eq!(
        kb::ring_seed_round(&clock, r.now(), margin),
        bound,
        "the request binds a shipped round"
    );
    let mut req = vec![
        AccountMeta::new(payer.pubkey(), true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.frontier(), false),
        AccountMeta::new_readonly(adr(ctx.ring_seed(R_MAX_HARD)), false),
        AccountMeta::new(adr(wl::ring_seed_address(&ctx, FIRST_WIDE_RING)), false),
    ];
    for w in 0..6u8 {
        req.push(AccountMeta::new_readonly(adr(ctx.province_fund(w)), false));
    }
    req.push(AccountMeta::new_readonly(
        fclient::addr::system_program(),
        false,
    ));
    let ix_req = wide_ix(
        &a,
        req,
        wix::RequestRingSeed {
            ring: FIRST_WIDE_RING,
        }
        .to_bytes()
        .to_vec(),
    );
    r.send(
        "WideRequestRingSeed(129)",
        &[ix_req],
        &[&payer],
        "permissionless payer (test)",
    );
    r.advance_exact(round_time(clock.genesis, clock.period as u32, bound) + 1);
    let beacon = rounds.get(&bound).expect("the bound round");
    let hints: [u8; frontier_abi::ix::HINTS_LEN] =
        fb::hints_bytes(bound).try_into().expect("hints");
    let ix_consume = wide_ix(
        &a,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&ctx, FIRST_WIDE_RING)), false),
        ],
        wix::ConsumeRingSeed {
            ring: FIRST_WIDE_RING,
            round: bound,
            sig48: beacon.sig48,
            hints,
        }
        .to_bytes()
        .to_vec(),
    );
    r.send(
        &format!("WideConsumeRingSeed(129) on shipped round {bound}"),
        &[ix_consume],
        &[&payer],
        "permissionless payer (test)",
    );
    let wedge = target.wedge().expect("a wedge");
    let ix_open = wide_ix(
        &a,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(adr(wl::ring_seed_address(&ctx, FIRST_WIDE_RING)), false),
            AccountMeta::new(adr(ctx.province_fund(wedge)), false),
            AccountMeta::new(adr(wl::province_address(&ctx, target)), false),
            AccountMeta::new_readonly(adr(wr::rules_config_address(&ctx)), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::OpenProvince {
            p: target.p(),
            q: target.q(),
        }
        .to_bytes()
        .to_vec(),
    );
    r.send(
        &format!("WideOpenProvince({}, {})", target.p(), target.q()),
        &[ix_open],
        &[&payer],
        "permissionless payer (test)",
    );

    // 3. The participant: Join (the rim province's nation) and a one-site FileTicket on the rim.
    let player = Keypair::new(); // TEST key
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let now = r.now();
    let join = r.send(
        "Join",
        &[ix::join(&a, w, w, nation, &w, now + 30 * 86_400, None)],
        &[&player],
        "rim participant",
    );
    let me = ix::Player {
        actor: w,
        payer: w,
        wallet: w,
    };
    let site = ix::Site {
        p: rp as i16,
        q: rq as i16,
        site: rsite,
    };
    let file = r.send(
        &format!("FileTicket(rim {rp}, {rq} site {rsite})"),
        &[ix::file_ticket(&a, &me, &[site])],
        &[&player],
        "rim participant",
    );
    let cd = r.data(&a.citizen(&w)).expect("the Citizen");
    let ticket_bell = le_u32(&cd, C::TICKET_BELL);
    assert_eq!(ticket_bell, r.bell());
    let region = ix::region_of(rp, rq);

    // 4. Declared: the ticket bell's anchor and seed (after the bell ended), then 5. keeper A's tickets role.
    r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
    r.stage_seed(ticket_bell, region, [0x5A; 32]);
    let before_settle = r.lock().slot();
    let holding = a.holding(rp, rq, rsite);
    r.run_until(
        2.0,
        180,
        "keeper A's tickets role settles the rim ticket",
        |r| {
            r.lock()
                .account(&holding)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    let settle = r.feed_rows(
        before_settle,
        &[fclient::abi::tag::SETTLE_TICKET],
        "keeper A (tickets role)",
    );
    assert!(settle.iter().any(|x| x["ok"] == true), "{settle:#?}");
    r.lock().set_paused(true);
    let hd = r.data(&holding).unwrap();
    assert_eq!(
        hd[H::STATE],
        H::STATE_PROVISIONAL,
        "a provisional first holding"
    );
    assert_eq!(hd[H::ORDER], 1, "the first village");
    assert_eq!(
        adr(hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32]
            .try_into()
            .unwrap()),
        a.citizen(&w)
    );
    let ring = ProvinceCoord::new(rp, rq).ring();
    assert!((126..=128).contains(&ring), "on the rim: ring {ring}");
    let final_ts = le_i64(&hd, H::FINAL_TS);

    // The herald (devnet mode) shows the rim village.
    r.lock().set_paused(false);
    let t0 = Instant::now();
    let mut last = Value::Null;
    let (me_view, herald_shows_rim) = loop {
        if let Some(m) = super::http_get(r.c.herald, &format!("/h/me/{w}")) {
            if m["holdings"]
                .as_array()
                .is_some_and(|h| h.iter().any(|x| x["address"] == holding.to_string()))
            {
                break (m, true);
            }
            last = m;
        }
        if t0.elapsed() > Duration::from_secs(60) {
            break (last, false);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert!(
        herald_shows_rim,
        "the herald did not show the rim village: {me_view}"
    );
    let herald_season = super::http_get(r.c.herald, "/h/season").unwrap_or(Value::Null);

    // 7. Final, harvested, then the wide claim from the rim Hamlet.
    let hold_ref = ix::HoldingRef {
        p: rp as i16,
        q: rq as i16,
        site: rsite,
    };
    // (the settler cost of slot 2 out of a Hamlet's stores: the clock runs on; each try harvests first)
    let mut claim = None;
    let mut harvests = vec![];
    let mut t = final_ts.max(r.now()) + 600;
    let cd = r.data(&a.citizen(&w)).unwrap();
    let citizen = a.citizen(&w);
    let claim_ix = |site: u8| {
        let anchor = a.holding(rp, rq, rsite);
        let anchor_p = a.province(rp, rq);
        wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(w, true),
                AccountMeta::new(w, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new_readonly(a.frontier(), false),
                AccountMeta::new(adr(wl::province_address(&ctx, target)), false),
                AccountMeta::new(adr(wt::ticket_address(&ctx, &citizen.to_bytes())), false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::ClaimSite {
                p: target.p(),
                q: target.q(),
                site,
                slot: 2,
            }
            .to_bytes()
            .to_vec(),
        )
    };
    let _ = cd;
    let mut last_err = String::new();
    for _ in 0..12 {
        r.advance_exact(t);
        let h = r.send(
            "Harvest (rim village)",
            &[fclient::ix::v2::harvest(&a, &me, hold_ref)],
            &[&player],
            "rim participant",
        );
        harvests.push(h);
        let hd = r.data(&holding).unwrap();
        assert_eq!(hd[H::STATE], H::STATE_FINAL, "the lazy flip");
        // the first free site the program takes (a keep or Free City site refuses)
        for s in 0..16u8 {
            match r.simulate_ok(&[claim_ix(s)], &[&player]) {
                Ok(_) => {
                    claim = Some(s);
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        if claim.is_some() {
            break;
        }
        t += 4 * 3_600;
    }
    let csite = claim.unwrap_or_else(|| panic!("no wide claim fits ({last_err})"));
    let hd = r.data(&holding).unwrap();
    let tier = hd[H::TIER];
    r.witness = Some(Witness::default());
    let cl = r.send(
        &format!(
            "WideClaimSite({}, {} site {csite}, slot 2) from the rim Hamlet",
            target.p(),
            target.q()
        ),
        &[claim_ix(csite)],
        &[&player],
        "rim participant",
    );
    let tk = adr(wt::ticket_address(&ctx, &citizen.to_bytes()));
    let rec = WideTicket::read(&r.data(&tk).unwrap()).expect("a wide ticket");
    assert_eq!(rec.status, TicketStatus::Open);

    // 8. Declared: the claim bell's anchor and seed in the wide province's region; then WideSettleTicket and
    //    WideFinalize (the itest run_claims duty's instructions).
    let wp = WideProvince::read(&r.data(&adr(wl::province_address(&ctx, target))).unwrap())
        .expect("wide province");
    r.advance_exact(genesis_ts + 600 * (rec.bell as i64 + 1) + 200);
    r.stage_seed(rec.bell, wp.region, [0xA5; 32]);
    let cdn = r.data(&citizen).unwrap();
    let (faction, shard) = (cdn[C::FACTION], cdn[C::JOIN_SHARD]);
    let wholding = adr(wh::holding_address(&ctx, target, csite));
    let settle_ix = wide_ix(
        &a,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(citizen, false),
            AccountMeta::new(tk, false),
            AccountMeta::new(wholding, false),
            AccountMeta::new(adr(wl::province_address(&ctx, target)), false),
            AccountMeta::new(a.join_shard(faction, shard), false),
            AccountMeta::new_readonly(a.seed_cache(rec.bell, wp.region, 0), false),
            AccountMeta::new_readonly(a.anchor(rec.bell, wp.region), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ],
        wix::SettleTicket { k: 0 }.to_bytes().to_vec(),
    );
    let ws = r.send(
        "WideSettleTicket(k 0)",
        &[settle_ix],
        &[&payer],
        "permissionless payer (test)",
    );
    let whd = r.data(&wholding).expect("the wide village's Holding");
    assert_eq!(whd[H::STATE], H::STATE_PROVISIONAL);
    let wfinal_ts = le_i64(&whd, H::FINAL_TS);
    let finalize_ix = wide_ix(
        &a,
        vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(wholding, false),
            AccountMeta::new_readonly(adr(wl::province_address(&ctx, target)), false),
        ],
        wix::Finalize {}.to_bytes().to_vec(),
    );
    r.advance_exact(wfinal_ts.max(r.now()) + 1);
    let wf = r.send(
        "WideFinalize",
        &[finalize_ix],
        &[&payer],
        "permissionless payer (test)",
    );
    let whd = r.data(&wholding).unwrap();
    assert_eq!(whd[H::STATE], H::STATE_FINAL);
    let wide = wh::WideHolding::read(&whd).expect("a wide holding");
    assert_eq!(wide.slot, 2);
    assert_eq!(wide.owner_citizen, citizen.to_bytes());
    // The verifier's VWL judges the claim, its settlement and the finalize from the execution witness (the
    // claim bell's anchor and seed are in it as the declared patch left them): no FAIL, nothing UNVERIFIABLE.
    let wit = r.witness.take().expect("the witness");
    let so_hash: [u8; 32] = hex::decode(super::DEVNET_SO_SHA256)
        .unwrap()
        .try_into()
        .unwrap();
    let segment = verify_core::input::Input {
        cfg: verify_core::input::Config {
            program: r.c.program,
            season_id: SEASON_ID,
            quicknet_pk: fb::quicknet_info().public_key,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so_hash),
        },
        txs: wit.txs.clone(),
        finals: Default::default(),
        final_slot: r.lock().slot(),
        program_hashes: vec![(0, so_hash)],
        provenance: "stack/tests/operator_playable.rs P4: the rim Hamlet's wide claim segment"
            .into(),
        scenarios: vec!["p4-rim-claim-segment".into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared: vec![],
        chain: Default::default(),
    };
    let found = verify_core::checks::vwl_wide_land::judge_segment(&segment, &wit.snapshot);
    let vwl: Vec<Value> = found
        .iter()
        .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity, "detail": f.detail}))
        .collect();
    assert!(
        found
            .iter()
            .all(|f| f.severity == verify_core::Severity::Warn),
        "VWL on the rim claim segment: {vwl:#?}"
    );
    // ...and it does judge them: (a) the Season read as a Town-anchor season (`outpost_tier_min` 1, every other
    // preset's rule) makes the rim Hamlet's claim a FAIL; (b) a forged owner of the settled wide village is a FAIL.
    let fails = |f: &[verify_core::Finding]| f.iter().filter(|x| x.fail()).count();
    let mut town = wit.snapshot.clone();
    {
        let sk = r.c.a.season.to_bytes();
        let acct = town
            .get_mut(&sk)
            .and_then(|x| x.as_mut())
            .expect("the Season in the witness");
        let o = frontier_abi::v2::presets::SEASON_CQ_OFFSET
            + frontier_abi::v2::presets::cq_layout::OUTPOST_TIER_MIN;
        assert_eq!(acct.data[o], 0);
        acct.data[o] = 1;
    }
    let town_fails = fails(&verify_core::checks::vwl_wide_land::judge_segment(
        &segment, &town,
    ));
    assert!(
        town_fails > 0,
        "a Hamlet claim in a Town-anchor season must FAIL"
    );
    let mut forged = segment.clone();
    let wk = wholding.to_bytes();
    let settle_at = forged
        .txs
        .iter()
        .position(|t| {
            t.post
                .iter()
                .any(|(k, a)| k.to_bytes() == wk && a.is_some())
        })
        .expect("the settlement wrote the wide village");
    {
        let (_, a) = forged.txs[settle_at]
            .post
            .iter_mut()
            .find(|(k, _)| k.to_bytes() == wk)
            .unwrap();
        let a = a.as_mut().unwrap();
        a.data[H::OWNER_CITIZEN] ^= 0xFF;
    }
    let forged_fails = fails(&verify_core::checks::vwl_wide_land::judge_segment(
        &forged,
        &wit.snapshot,
    ));
    assert!(forged_fails > 0, "a forged wide village must FAIL");
    r.lock().set_paused(false);

    let keeper_alive = r.c.keeper.try_wait().ok().flatten().is_none();
    assert!(keeper_alive, "keeper A exited");
    json!({
        "q_w1": "rim first village by FileTicket + keeper A's tickets role; wide claim from the rim Hamlet (outpost_tier_min 0)",
        "rim_plan": {"per_wedge": PER_WEDGE, "provinces": plan.len(), "opened_by": "keeper A rings duty (rim_per_wedge)",
                     "wall_secs": rim_secs, "open_province_txs": rim_open},
        "participant": {"wallet": w.to_string(), "nation": nation},
        "rim_village": {"p": rp, "q": rq, "site": rsite, "ring": ring, "ticket_bell": ticket_bell, "region": region,
                        "tier_at_claim": tier, "final_ts": final_ts},
        "herald_me": me_view, "herald_shows_rim_village": herald_shows_rim, "herald_season_after": herald_season,
        "keeper_settle_ticket": settle,
        "wide_village": {"p": target.p(), "q": target.q(), "site": csite, "ring": target.ring(), "slot": 2,
                         "ticket_bell": rec.bell, "region": wp.region},
        "transactions": r.rows,
        "join": join, "file_ticket": file, "harvests": harvests, "wide_claim": cl, "wide_settle": ws, "wide_finalize": wf,
        "declared_patches": r.patches,
        "wide_ring_bound_round": bound,
        "verifier_vwl_segment": {"transactions": wit.txs.len(), "snapshot_accounts": wit.snapshot.len(), "findings": vwl,
            "mutation_town_season_fails": town_fails, "mutation_forged_owner_fails": forged_fails},
    })
}
