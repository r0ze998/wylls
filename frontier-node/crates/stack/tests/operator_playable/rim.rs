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
//!    test as any permissionless payer would (P5: keeper A's rings duty does it instead, `wide_rings`).
//! 7. REAL: the clock past the home's `final_ts`; the participant's Harvest flips it final (the lazy flip) and
//!    collects its production; then **WideClaimSite (0xD9) from the rim Hamlet** (`outpost_tier_min` 0, Q-W1).
//! 8. **Declared patch** of the claim bell's anchor and seed (as 4), then REAL WideSettleTicket (0xDC) and, once
//!    due, WideFinalize (0xDF), sent by this test (the itest `run_claims` duty's instructions; P5: keeper A's
//!    `wide-tickets` role sends them instead).
//!
//! Every instruction's compute units and lamports are recorded.
//!
//! **P5** (devnet runbook gaps P6 + P7, `Ctx::keeper_wide`): the same run with keeper A built with
//! `--features playable-lane` and configured as the devnet profile now says (role **`wide-tickets`**; rings duty
//! **`wide_rings` 3**, **`wide_per_wedge` 6**). Steps 6 and 8 are then keeper A's, not this test's: its rings duty
//! opens the wide rings 129, 130 and 131 (WideRequestRingSeed, WideConsumeRingSeed on the bound round,
//! WideOpenProvince × 36 each) and its `wide-tickets` role sends WideSettleTicket and WideFinalize. The test sends
//! no wide-ring, settle or finalize instruction; it only moves the chain's clock so that each ring's request binds
//! one of the 32 SHIPPED quicknet rounds (on devnet every round is published, so the keeper's own timing is the
//! schedule). The verifier's VWL judges two segments: the wide rings, and the claim → settle → finalize.

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

/// keeper A's `rim_per_wedge` (the devnet profile's value; P5: also its `wide_per_wedge`).
pub const PER_WEDGE: usize = 6;
/// P5: keeper A's `wide_rings` (the devnet profile's value: rings 129–131).
pub const WIDE_RINGS: u64 = 3;
const SOL: u64 = 1_000_000_000;
const SEASON_ID: u64 = 1;

/// P6 (gap P8): how to restart keeper A (the same binary and config; `wide_rings` raised by one).
pub struct Restart {
    pub bin: std::path::PathBuf,
    pub config: std::path::PathBuf,
    pub api: u16,
    pub token: String,
}

/// P6: the bells of the window in which keeper A must fold every bell after the wide village's actions.
pub const P8_BELLS: u32 = 6;

/// P7 (devnet gap P1): the web page plays the participant's part instead of this test (see [`page_flow`]).
#[derive(Clone)]
pub struct Page {
    /// The herald serving the page (`--web`) and proxying `/gw/*` to the gateway's devnet play routes.
    pub herald: u16,
    /// The driver's inspection listener (loopback).
    pub inspect: u16,
    /// `node` and the driver script (Playwright, headless Chromium).
    pub driver: std::path::PathBuf,
    /// Where the driver writes its stills and log.
    pub out: std::path::PathBuf,
    /// PFOG (fog-devnet): two observer players of other nations look through the devnet page too (`war_fog.rs`).
    pub fog: bool,
    /// PPOST (devnet-page-outpost): the page founds its second village (FileOutpost) instead of the wide claim
    /// ([`outpost_page`]).
    pub outpost: bool,
    /// P17 (devnet-p17): after the wide village is final, the page sends its own acts ([`wide_acts_page`]).
    pub wide_acts: bool,
    /// P18 (devnet-territory-dev): a territory world — the wide village on the page's own tile, then
    /// [`territory_page`] (tiles, keeper A's settle / conquest / decay).
    pub territory: Option<territory_page::Input>,
    /// PCAP (devnet-72bell-pair): P9's keep march held through all 72 bells; the capture on chain, in the herald and on
    /// the page (`war_page.rs` [`war::PCAP_AFTER_BELLS`]).
    pub capture: bool,
    /// PPAIR (devnet-72bell-pair): an out-and-back march pair — out to a neighbouring province, then the page's march
    /// home ([`war`] `pair`).
    pub pair: bool,
    /// PLOAD (herald-load-50): the stack is held open for an external load generator ([`load`]).
    pub load: bool,
}

/// PLOAD (herald-load-50): the devnet stack held open for a load test.
#[path = "end.rs"]
pub mod end;
/// P11 (devnet-expedition-keeper): the rim → wide expedition.
#[path = "expedition.rs"]
pub mod expedition;

#[path = "load.rs"]
pub mod load;
/// PPOST (devnet-page-outpost): the page's second village ([`outpost_page`]).
#[path = "outpost_page.rs"]
pub mod outpost_page;
/// PPROV (devnet-open-province): keeper A's provinces on demand ([`provinces`]).
#[path = "provinces.rs"]
pub mod provinces;
/// P18 (devnet-territory-dev): player territory on the devnet page and keeper A's `territory` role.
#[path = "territory_page.rs"]
pub mod territory_page;
/// P17 (devnet-p17): the page's wide village's own acts ([`wide_acts_page`]).
#[path = "wide_acts_page.rs"]
pub mod wide_acts_page;

/// P14 (devnet-guard-conquest): a third party's wide Free City conquest after P11's expedition.
#[path = "conquest.rs"]
pub mod conquest;
/// P8/P9 (devnet-page-war): the legacy war after the rim opened ([`war`]).
#[path = "war.rs"]
pub mod war;

/// P8/P9: keeper A's API (its `/v1/reveal` takes a participant's reveal material; `/v1/status`).
#[derive(Clone)]
pub struct War {
    pub keeper_api: u16,
    pub token: String,
    /// P10 (devnet-page-war-2): how to stop and restart keeper A and drand-replay ([`war::Outage`]).
    pub outage: Option<war::Outage>,
    /// PGWF (fix-gw-highs): the `/gw` flood during the war ([`war::Flood`]).
    pub flood: Option<war::Flood>,
}

pub struct Ctx<'a> {
    /// P5: keeper A runs the wide rings (P6) and the `wide-tickets` role (P7).
    pub keeper_wide: bool,
    /// P5: the wide rings keeper A opens ([`WIDE_RINGS`]; P11: 1).
    pub wide_rings: u64,
    /// P11: the rim → wide expedition ([`expedition`]).
    pub expedition: bool,
    /// P14: after P11's expedition (onto a Free City's tile), a third party's Free City conquest ([`conquest`]).
    pub conquest: bool,
    /// The sha256 of the `.so` this run deployed (P18: the new build from `OPERATOR_TERRITORY_SO`; else the fixture's).
    pub so_sha256: &'static str,
    /// P6 (gap P8): after P5, the wide village acts and keeper A must keep every duty.
    pub after_wide: Option<Restart>,
    /// P11 with `OPERATOR_P11_RESTARTS=1` (verify-pr121): keeper A is killed and restarted from the same config and
    /// journal at three points of the expedition; every step must still land exactly once.
    pub p11_restarts: Option<Restart>,
    /// P7: the page is the participant.
    pub page: Option<Page>,
    /// P8/P9: the legacy war (P9 with `page`).
    pub war: Option<War>,
    /// PPROV (devnet-open-province): the participant's growth into provinces keeper A opens on demand.
    pub provinces: Option<provinces::Input>,
    /// PEND (devnet-end-season): after P5, the season's end with `frontier-operator end-season` ([`end`]).
    pub end: Option<end::End>,
    pub state: Arc<Mutex<localnet::Chain>>,
    pub a: Addresses,
    pub program: Address,
    pub herald: u16,
    pub dir: std::path::PathBuf,
    pub keeper: &'a mut std::process::Child,
    /// drand-replay (P10 restarts it with and without T(21)).
    pub drand: &'a mut std::process::Child,
}

struct Run<'a> {
    c: Ctx<'a>,
    rows: Vec<Value>,
    patches: Vec<String>,
    /// (verify-pr118) Every [`Run::patch`] as the verifier reads a declared state: in force from before the program
    /// transaction `at` of the whole feed.
    declared: Vec<verify_core::input::Declared>,
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
        self.try_send_budget(what, ixs, signers, who, budget())
    }
    /// [`Run::try_send`] with its own budget (P14: DeclareSiege needs the 256 KiB heap frame).
    fn try_send_budget(
        &mut self,
        what: &str,
        ixs: &[Instruction],
        signers: &[&Keypair],
        who: &str,
        budget: tx::TxBudget,
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
        let t = tx::build(ixs, &budget, signers, &bh).expect("build");
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
    /// P5: the witness snapshot (as [`Run::try_send`] takes it) of the program accounts `ixs` name, on the paused
    /// chain, just before keeper A sends them (`ixs` are built here with a dummy payer only for their accounts).
    fn witness_before(&mut self, ixs: &[Instruction]) {
        let c = self.c.state.lock().unwrap_or_else(|e| e.into_inner());
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
    }
    /// P5: the program transactions (keeper A's) whose first program instruction has a tag in `tags`, landed after
    /// `since_slot`, appended to the witness in order; a landed one's written accounts are marked.
    fn witness_landed(&mut self, since_slot: u64, tags: &[u8]) -> usize {
        let program = self.c.program;
        let c = self.c.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut n = 0;
        if let Some(wit) = self.witness.as_mut() {
            for l in c
                .feed(0, 1_000_000, Some(&program))
                .into_iter()
                .filter(|l| l.slot > since_slot)
            {
                let Ok(t) = fclient::tx::from_wire(&l.wire) else {
                    continue;
                };
                let tag = t.message.instructions.iter().find_map(|i| {
                    (t.message.account_keys.get(i.program_id_index as usize) == Some(&program))
                        .then(|| i.data.first().copied())
                        .flatten()
                });
                if !tag.is_some_and(|x| tags.contains(&x)) {
                    continue;
                }
                if wit.txs.iter().any(|x| x.signature == l.signature) {
                    continue;
                }
                if l.err.is_none() {
                    for (k, _) in &l.post {
                        wit.written.insert(k.to_bytes());
                    }
                }
                wit.txs.push(l.record());
                n += 1;
            }
        }
        n
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
        let program = self.c.program;
        let at = {
            let mut c = self.lock();
            let at = c.feed(0, usize::MAX, Some(&program)).len();
            c.set_account(k, a.clone()).expect("patch");
            at
        };
        self.declared.push(verify_core::input::Declared {
            at,
            key: k.to_bytes(),
            account: Some(a),
            what: what.to_string(),
        });
        self.patches.push(format!("PATCH (set_account): {what}"));
    }
    /// (verify-pr118) The verifier's judgement of the WHOLE season as the chain recorded it: every program transaction
    /// from CreateSeason on (failed ones too), the final state of every written account, the exact devnet `.so` for
    /// re-execution, and every patch of this run as a declared state. Saved as `{tag}-season.json.gz` under
    /// `OPERATOR_EVIDENCE_DIR` when set. → `{verdict, counts by (severity, check, code), the non-WARN findings}`.
    fn judge_season(&self, tag: &str) -> Value {
        let so = super::devnet_so_of(self.c.conquest);
        let so_sha256 = super::devnet_build(self.c.conquest).0;
        let so_hash: [u8; 32] = hex::decode(so_sha256).unwrap().try_into().unwrap();
        let program = self.c.program;
        // (verify-pr150) the chain's Rent sysvar, as `frontier-verify --rpc` reads it: VX / VG re-execute under the
        // season's rent (OPERATOR_LAMPORTS_PER_BYTE may make it 6,960), never the assumed 5,080.
        let rent = {
            let c = self.lock();
            let slot = c.slot();
            c.account(&fclient::rent::rent_sysvar()).map(|a| {
                verify_core::input::RentRead::from_chain(&a.data, slot)
                    .expect("the chain's Rent sysvar")
            })
        };
        assert!(rent.is_some(), "the chain serves its Rent sysvar");
        let (txs, finals, final_slot) = {
            let c = self.lock();
            let txs: Vec<fclient::ports::TxRecord> = c
                .feed(0, usize::MAX, Some(&program))
                .into_iter()
                .map(|l| l.record())
                .collect();
            let finals: std::collections::BTreeMap<[u8; 32], Option<Account>> =
                verify_core::input::written_keys(&txs)
                    .into_iter()
                    .map(|k| (k.to_bytes(), c.account(&k)))
                    .collect();
            (txs, finals, c.slot())
        };
        let input = verify_core::input::Input {
            cfg: verify_core::input::Config {
                program,
                season_id: SEASON_ID,
                quicknet_pk: fb::quicknet_info().public_key,
                ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
                program_hash: Some(so_hash),
            },
            txs,
            finals,
            final_slot,
            program_hashes: vec![(0, so_hash)],
            provenance: format!(
                "stack/tests/operator_playable.rs {tag} (verify-pr118): the whole season on the devnet .so (sha256 {}), keeper A's play roles; {}",
                so_sha256,
                self.patches.join("; ")
            ),
            scenarios: vec![format!("{tag}-legacy-war")],
            history: Default::default(),
            resident_feed: None,
            program_so: Some(Arc::new(so)),
            declared: self.declared.clone(),
            chain: verify_core::input::ChainWitness {
                rent,
                ..Default::default()
            },
        };
        if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
            let out = std::path::Path::new(&d).join(format!("{tag}-season.json.gz"));
            input.save(&out).expect("save the season archive");
        }
        let rep = verify_core::verify(&input);
        let mut counts: std::collections::BTreeMap<String, u64> = Default::default();
        for f in &rep.findings {
            *counts
                .entry(format!("{:?} {} {}", f.severity, f.check, f.code))
                .or_default() += 1;
        }
        let bad: Vec<Value> = rep
            .findings
            .iter()
            .filter(|f| f.severity != verify_core::Severity::Warn)
            .take(200)
            .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity,
                "bell": f.bell, "signature": f.signature, "detail": f.detail}))
            .collect();
        json!({"verdict": format!("{:?}", rep.verdict), "transactions": input.txs.len(), "declared": input.declared.len(),
            "fails": rep.findings.iter().filter(|f| f.fail()).count(), "counts": counts, "not_warn": bad,
            "checks_run": rep.checks_run})
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
    /// (devnet-72bell-pair, PPAIR) THE anchor of `(bell, region)` declared WITH a signature: `sig48` is the TEST
    /// beacon key's signature of the bell's time-lock round T(bell) ([`fb::TestKey`]), and the anchor's round is T(bell)
    /// — offline there is no second real quicknet round in reach of one season (only T(21) of the war genesis, see
    /// `war.rs` [`war::PAIR_REST_BELLS`]), so the HOME leg of the pair is sealed to the TEST key and settles over this
    /// declared anchor; the OUT leg is the real one. Its SeedCache (nonce 0) with a literal seed, as [`Run::stage_seed`].
    fn stage_signed(&mut self, bell: u32, region: u8, sig48: [u8; 48], seed: [u8; 32]) {
        let ctx = self.ctx();
        let (clock, sched, margin, genesis_ts) = self.clock();
        let a_ts = genesis_ts + 600 * (bell as i64 + 1) + 100;
        let t_round = kb::tlock_round(&clock, genesis_ts, bell);
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
        ad[BA::ROUND..BA::ROUND + 8].copy_from_slice(&t_round.to_le_bytes());
        ad[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        ad[BA::SLOT..BA::SLOT + 8].copy_from_slice(&1u64.to_le_bytes());
        ad[BA::SIG48..BA::SIG48 + 48].copy_from_slice(&sig48);
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
            &format!("BellAnchor(bell {bell}, region {region}), round T({bell}) = {t_round}, signed by the TEST beacon key (no real quicknet round offline)"),
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

/// A witnessed segment as the verifier reads it (the exact devnet `.so`'s hash).
fn segment_of(r: &Run<'_>, wit: &Witness, scenario: &str) -> verify_core::input::Input {
    let so_hash: [u8; 32] = hex::decode(r.c.so_sha256).unwrap().try_into().unwrap();
    verify_core::input::Input {
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
        provenance: format!("stack/tests/operator_playable.rs: {scenario}"),
        scenarios: vec![scenario.into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared: vec![],
        chain: Default::default(),
    }
}

/// VWL's judgement of a witnessed segment.
fn judge(r: &Run<'_>, wit: &Witness, scenario: &str) -> Vec<verify_core::Finding> {
    verify_core::checks::vwl_wide_land::judge_segment(&segment_of(r, wit, scenario), &wit.snapshot)
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
        declared: vec![],
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
    // (P5: the request time of a wide ring whose round is `rr`, and the first shipped round requestable after `after`
    //  in a bell later than `prev_bell`: keeper A requests a ring as soon as the program allows it, and only a SHIPPED
    //  round can be consumed offline, so the clock stops at the start of that round's window)
    let keeper_wide = r.c.keeper_wide;
    let t_req_of = |rr: u64| {
        round_time(clock.genesis, clock.period as u32, rr)
            - permutation_rules::frontier::beacon::SEED_LEAD_SECS
            - margin as i64
            - 1
    };
    let bell_of = |t: i64| ((t - genesis_ts).max(0) / 600) as u32;
    let shipped_after = |after: i64, prev_bell: Option<u32>| {
        rounds
            .keys()
            .copied()
            .find(|&rr| {
                let t = t_req_of(rr);
                t > after + 2 && t >= genesis_ts + 600 && prev_bell.is_none_or(|b| bell_of(t) > b)
            })
            .expect("a shipped round after now")
    };
    let dummy = adr([0xEE; 32]); // (an address only: the witness reads the accounts keeper A's writes name)
    let mut ring_rounds: Vec<Value> = vec![];
    // (P5: ring 128 "opened" in this bell, so keeper A may request ring 129 only from the next bell on — the
    //  program's rule — and the rim's 42 legacy openings, which spend the same wedge funds, are done before the
    //  wide rings' witnessed segment starts)
    let rim_bell = if keeper_wide { r.bell() } else { 0 };
    rs.data[RS::OPENED_BELL..RS::OPENED_BELL + 4].copy_from_slice(&rim_bell.to_le_bytes());
    r.patch(
        adr(ctx.ring_seed(R_MAX_HARD)),
        rs,
        &format!("RingSeed(128) seeded (the genesis ring's seed, opened_bell {rim_bell})"),
    );
    let patched_slot = r.lock().slot();
    // PPROV: the provinces a nation grows into (keeper A's `provinces_reach`), from the heartland home.
    if let Some(inp) = r.c.provinces.take() {
        return provinces::flow(&mut r, inp).await;
    }
    let seed_of = |r: &Run<'_>, ring: u64| {
        r.data(&adr(wl::ring_seed_address(&r.ctx(), ring)))
            .and_then(|d| wl::WideRingSeed::read(&d).ok())
    };

    // 2. keeper A's rim duty opens the rim's provinces (P5: and its rings duty requests ring 129's seed).
    let plan = keeper_core::rings::rim_plan(PER_WEDGE);
    let t_rim = Instant::now();
    r.run_until(
        if keeper_wide { 0.01 } else { 5.0 },
        240,
        "keeper A opens the rim's provinces",
        |r| {
            plan.iter()
                .all(|&(p, q)| r.lock().account(&r.c.a.province(p, q)).is_some())
        },
    )
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

    // P5 (P6): keeper A's rings duty opens the wide rings 129..=131, one a bell apart; this test only moves the clock.
    let wide_tags = [
        wix::WideIx::RequestRingSeed.tag(),
        wix::WideIx::ConsumeRingSeed.tag(),
        wix::WideIx::OpenProvince.tag(),
    ];
    let mut wide_ring_txs = vec![];
    let mut vwl_rings = Value::Null;
    let funds = |r: &Run<'_>| -> Vec<u64> {
        (0..6u8)
            .map(|w| r.lock().balance(&adr(r.ctx().province_fund(w))))
            .collect()
    };
    let funds_before = funds(&r);
    let mut first_bound = None;
    if keeper_wide {
        assert!(
            seed_of(&r, FIRST_WIDE_RING).is_none(),
            "ring 129 waits a bell"
        );
        assert_eq!(r.bell(), rim_bell, "the rim opened within ring 128's bell");
        r.lock().set_paused(true);
        r.witness = Some(Witness::default());
        for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + r.c.wide_rings {
            let since = r.lock().slot();
            let prev = if ring == FIRST_WIDE_RING {
                rim_bell
            } else {
                seed_of(&r, ring - 1)
                    .expect("the previous wide ring")
                    .opened_bell
            };
            let bound = shipped_after(r.now(), Some(prev));
            first_bound.get_or_insert(bound);
            r.advance_exact(t_req_of(bound) - 1);
            r.witness_before(&[keeper_core::widelane::request_ring_seed(&a, dummy, ring)]);
            r.run_until(
                0.002,
                240,
                &format!("keeper A requests ring {ring}'s seed"),
                |r| seed_of(r, ring).is_some(),
            )
            .await;
            r.lock().set_paused(true);
            r.witness_landed(patched_slot, &wide_tags);
            let rec = seed_of(&r, ring).expect("requested");
            assert_eq!(
                rec.round, bound,
                "keeper A's request of ring {ring} bound the shipped round"
            );
            let t_seeded = Instant::now();
            r.advance_exact(round_time(clock.genesis, clock.period as u32, bound) + 1);
            let wplan = keeper_core::rings::wide_plan(ring, PER_WEDGE);
            let mut ixs =
                vec![
                    keeper_core::widelane::consume_ring_seed(&a, dummy, ring, bound, [0; 48])
                        .expect("consume"),
                ];
            for c in &wplan {
                ixs.push(keeper_core::widelane::open_province(&a, dummy, *c).expect("open"));
            }
            r.witness_before(&ixs);
            r.run_until(
                0.05,
                300,
                &format!("keeper A seeds ring {ring} and opens its plan"),
                |r| {
                    seed_of(r, ring).is_some_and(|s| s.status == wl::SeedStatus::Seeded)
                        && wplan
                            .iter()
                            .all(|c| r.data(&adr(wl::province_address(&r.ctx(), *c))).is_some())
                },
            )
            .await;
            r.lock().set_paused(true);
            r.witness_landed(patched_slot, &wide_tags);
            let rows = r.feed_rows(since, &wide_tags, "keeper A (rings duty, wide_rings)");
            assert!(
                rows.iter().filter(|x| x["ok"] == true).count() > wplan.len(),
                "{rows:#?}"
            );
            ring_rounds.push(json!({"ring": ring, "bound_shipped_round": bound, "request_bell": rec.opened_bell,
                "provinces": wplan.len(), "seed_and_open_wall_secs": t_seeded.elapsed().as_secs_f64()}));
            wide_ring_txs.extend(rows);
        }
        // VWL on the wide rings' segment (keeper A's 0xD6 / 0xD7 / 0xD8): no FAIL, nothing UNVERIFIABLE.
        let wit = r.witness.take().expect("the rings' witness");
        let found = judge(&r, &wit, "p5-keeper-wide-rings-segment");
        let vwl: Vec<Value> = found
            .iter()
            .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity, "detail": f.detail}))
            .collect();
        assert!(
            found
                .iter()
                .all(|f| f.severity == verify_core::Severity::Warn),
            "VWL on keeper A's wide rings: {vwl:#?}"
        );
        vwl_rings = json!({"transactions": wit.txs.len(), "snapshot_accounts": wit.snapshot.len(), "findings": vwl});
    }
    let funds_after_rings = funds(&r);

    // The participant's rim province: the first of the plan whose mixed nation has a free site.
    // (P14: and whose ring-129 neighbour, opened by keeper A, has a Free City: the siege's target.)
    let plan129 = keeper_core::rings::wide_plan(FIRST_WIDE_RING, PER_WEDGE);
    let neighbours = |rp: i32, rq: i32| -> Vec<WideCoord> {
        [(1i64, 0i64), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
            .iter()
            .map(|(dp, dq)| WideCoord::checked(rp as i64 + dp, rq as i64 + dq).unwrap())
            .filter(|c| c.ring() == FIRST_WIDE_RING && (!keeper_wide || plan129.contains(c)))
            .collect()
    };
    let free_city_of = |r: &Run<'_>, c: WideCoord| -> Option<(u8, u8)> {
        let d = r.data(&adr(wl::province_address(&r.ctx(), c)))?;
        (0..d[PV::SITE_COUNT] as usize)
            .find(|&s| {
                d[PV::site(s) + SM::STATE]
                    == frontier_abi::v2::layout::province::site::STATE_FREE_CITY
            })
            .map(|s| (s as u8, d[PV::SITES + s]))
    };
    let free_rim_site = |r: &Run<'_>, rp: i32, rq: i32| -> Option<u8> {
        let pd = r.data(&a.province(rp, rq))?;
        (0..pd[PV::SITE_COUNT] as usize)
            .find(|i| {
                matches!(
                    pd[PV::site(*i) + SM::STATE],
                    SM::STATE_FREE | SM::STATE_RELEASED_FREE
                )
            })
            .map(|i| i as u8)
    };
    let (rp, rq, nation, rsite, target, free_city) = plan
        .iter()
        .find_map(|&(p, q)| {
            let n = home_nation(
                ProvinceCoord::new(p, q),
                cq.placement,
                cq.heartland_max_ring,
                &gseed,
            )?;
            let site = free_rim_site(&r, p, q)?;
            let ns = neighbours(p, q);
            if r.c.conquest {
                ns.into_iter()
                    .find_map(|c| free_city_of(&r, c).map(|fc| (p, q, n, site, c, Some(fc))))
            } else {
                ns.first().map(|c| (p, q, n, site, *c, None))
            }
        })
        .expect("a rim province with a nation, a free site and a ring-129 neighbour (P14: with a Free City)");

    // P11: the rim → wide expedition into `target` (keeper A drives every step after the Depart);
    // P14: onto the Free City's tile, then a third party's conquest.
    if r.c.expedition {
        let extra = json!({
            "rim_plan": {"per_wedge": PER_WEDGE, "provinces": plan.len(), "opened_by": "keeper A rings duty (rim_per_wedge)",
                         "wall_secs": rim_secs, "open_province_txs": rim_open},
            "wide_rings": ring_rounds, "wide_ring_txs": wide_ring_txs.len(), "verifier_vwl_rings_segment": vwl_rings,
        });
        return expedition::flow(&mut r, (rp, rq, rsite, nation), target, free_city, extra).await;
    }
    // P8/P9: the legacy war from the rim (P9: the page is the participant).
    if r.c.war.is_some() {
        let extra = json!({
            "rim_plan": {"per_wedge": PER_WEDGE, "provinces": plan.len(), "opened_by": "keeper A rings duty (rim_per_wedge)",
                         "wall_secs": rim_secs, "open_province_txs": rim_open},
        });
        return war::flow(&mut r, &plan, extra).await;
    }
    // P7: from here the web page is the participant (Join, the rim FileTicket, Harvest, WideClaimSite), signed by its
    // connected wallet and sent through the gateway's devnet play routes; this test only moves the clock and declares
    // the bells' anchors and seeds; keeper A settles and finalizes.
    if let Some(pg) = r.c.page.clone() {
        let extra = json!({
            "rim_plan": {"per_wedge": PER_WEDGE, "provinces": plan.len(), "opened_by": "keeper A rings duty (rim_per_wedge)",
                         "wall_secs": rim_secs, "open_province_txs": rim_open},
            "wide_rings": ring_rounds, "wide_ring_txs": wide_ring_txs, "verifier_vwl_rings_segment": vwl_rings,
            "province_funds_before_rings": funds_before, "province_funds_after_rings": funds_after_rings,
        });
        // (PPOST: the second village by FileOutpost instead of the wide claim)
        if pg.outpost {
            return outpost_page::flow(&mut r, &pg, &plan, nation, extra).await;
        }
        if pg.load {
            return load::flow(&mut r, &pg, &plan, extra).await;
        }
        return page_flow(&mut r, &pg, &plan, nation, extra).await;
    }

    // 6 (P4 only; P5's wide rings are keeper A's, above).
    let bound = if keeper_wide {
        first_bound.expect("ring 129's round")
    } else {
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
        bound
    };

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
    let finalize_ix = |payer: Address| {
        wide_ix(
            &a,
            vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(wholding, false),
                AccountMeta::new_readonly(adr(wl::province_address(&ctx, target)), false),
            ],
            wix::Finalize {}.to_bytes().to_vec(),
        )
    };
    let (ws, wf) = if keeper_wide {
        // P5 (P7): keeper A's `wide-tickets` role settles the claim on the bell's seed, then finalizes the village.
        let since = r.lock().slot();
        let mut dummy_settle = settle_ix.clone();
        dummy_settle.accounts[0].pubkey = dummy;
        r.witness_before(&[dummy_settle]);
        r.run_until(
            2.0,
            180,
            "keeper A's wide-tickets role settles the wide claim",
            |r| {
                r.lock()
                    .account(&wholding)
                    .is_some_and(|h| h.owner == r.c.program)
            },
        )
        .await;
        r.lock().set_paused(true);
        r.witness_landed(since, &[wix::WideIx::SettleTicket.tag()]);
        let ws = r.feed_rows(
            since,
            &[wix::WideIx::SettleTicket.tag()],
            "keeper A (wide-tickets role)",
        );
        assert!(ws.iter().any(|x| x["ok"] == true), "{ws:#?}");
        let whd = r.data(&wholding).expect("the wide village's Holding");
        assert_eq!(whd[H::STATE], H::STATE_PROVISIONAL);
        let wfinal_ts = le_i64(&whd, H::FINAL_TS);
        r.advance_exact(wfinal_ts.max(r.now()) + 1);
        let since = r.lock().slot();
        r.witness_before(&[finalize_ix(dummy)]);
        r.run_until(
            2.0,
            180,
            "keeper A's wide-tickets role finalizes the wide village",
            |r| {
                r.data(&wholding)
                    .is_some_and(|h| h[H::STATE] == H::STATE_FINAL)
            },
        )
        .await;
        r.lock().set_paused(true);
        r.witness_landed(since, &[wix::WideIx::Finalize.tag()]);
        let wf = r.feed_rows(
            since,
            &[wix::WideIx::Finalize.tag()],
            "keeper A (wide-tickets role)",
        );
        assert!(wf.iter().any(|x| x["ok"] == true), "{wf:#?}");
        (json!(ws), json!(wf))
    } else {
        let ws = r.send(
            "WideSettleTicket(k 0)",
            &[settle_ix],
            &[&payer],
            "permissionless payer (test)",
        );
        let whd = r.data(&wholding).expect("the wide village's Holding");
        assert_eq!(whd[H::STATE], H::STATE_PROVISIONAL);
        let wfinal_ts = le_i64(&whd, H::FINAL_TS);
        r.advance_exact(wfinal_ts.max(r.now()) + 1);
        let wf = r.send(
            "WideFinalize",
            &[finalize_ix(payer.pubkey())],
            &[&payer],
            "permissionless payer (test)",
        );
        (ws, wf)
    };
    let whd = r.data(&wholding).unwrap();
    assert_eq!(whd[H::STATE], H::STATE_FINAL);
    let wide = wh::WideHolding::read(&whd).expect("a wide holding");
    assert_eq!(wide.slot, 2);
    assert_eq!(wide.owner_citizen, citizen.to_bytes());
    // The verifier's VWL judges the claim, its settlement and the finalize from the execution witness (the
    // claim bell's anchor and seed are in it as the declared patch left them): no FAIL, nothing UNVERIFIABLE.
    let wit = r.witness.take().expect("the witness");
    let segment = segment_of(
        &r,
        &wit,
        if keeper_wide {
            "p5-keeper-wide-claim-segment"
        } else {
            "p4-rim-claim-segment"
        },
    );
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

    let p8 = if r.c.after_wide.is_some() {
        after_wide(
            &mut r,
            AfterWide {
                player: &player,
                citizen,
                target,
                csite,
                rim: (rp, rq, rsite),
                nation,
                dummy,
            },
        )
        .await
    } else {
        Value::Null
    };

    let keeper_alive = r.c.keeper.try_wait().ok().flatten().is_none();
    assert!(keeper_alive, "keeper A exited");
    // PEND: the season's end and clean-up (end.rs), after everything above.
    let pend = match r.c.end.take() {
        Some(e) => end::flow(&mut r, &e).await,
        None => Value::Null,
    };
    json!({
        "pend": pend,
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
        "p5_keeper_wide": if keeper_wide { json!({
            "wide_rings": ring_rounds, "wide_ring_txs": wide_ring_txs, "verifier_vwl_rings_segment": vwl_rings,
            "province_funds_before_rings": funds_before, "province_funds_after_rings": funds_after_rings,
            "settle_and_finalize_by": "keeper A wide-tickets role",
        }) } else { Value::Null },
        "p6_after_wide_village_acts": p8,
        "verifier_vwl_segment": {"transactions": wit.txs.len(), "snapshot_accounts": wit.snapshot.len(), "findings": vwl,
            "mutation_town_season_fails": town_fails, "mutation_forged_owner_fails": forged_fails},
    })
}

/// P6's inputs from the P5 run.
struct AfterWide<'k> {
    player: &'k Keypair,
    citizen: Address,
    /// The wide village (slot 2), final.
    target: WideCoord,
    csite: u8,
    /// The participant's rim village (the anchor).
    rim: (i32, i32, u8),
    nation: u8,
    dummy: Address,
}

/// keeper A's `/v1/status` (its bearer token).
fn keeper_status(api: u16, token: &str) -> Option<Value> {
    keeper_get(api, token, "/v1/status")
}

/// GET `path` of keeper A's API (loopback, the TEST token): the JSON body of a 200, else None.
fn keeper_get(api: u16, token: &str, path: &str) -> Option<Value> {
    use std::io::{Read, Write};
    let mut c = std::net::TcpStream::connect(("127.0.0.1", api)).ok()?;
    c.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        c,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{api}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut b = vec![];
    c.read_to_end(&mut b).ok()?;
    let t = String::from_utf8_lossy(&b);
    let (head, body) = t.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body.split("\r\n")
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, x)| x)
            .collect::<String>()
    } else {
        body.to_string()
    };
    serde_json::from_str(&body).ok()
}

/// The PSW1 kinds keeper A's land index accounted for (`discovery.land.wide_accounted`).
fn accounted(st: &Value, kind: &str) -> u64 {
    st["discovery"]["land"]["wide_accounted"][kind]
        .as_u64()
        .unwrap_or(0)
}

/// P6 (devnet gap P8): the wide village acts after its claim is final, then keeper A keeps every duty.
async fn after_wide(r: &mut Run<'_>, k: AfterWide<'_>) -> Value {
    use frontier_abi::layout::player::accrual as AC;
    use frontier_abi::layout::province::province as PV1;
    use frontier_abi::world_index::roster as wro;
    use frontier_abi::world_index::{EconomyAction as Action, ProvinceKey, WorldId};
    use permutation_rules::frontier::holding::RESOURCES;
    const STORES: i64 = 5_000_000_000;
    // (the smallest host: `permutation_rules::frontier::host::MIN_HOST_TROOPS`)
    const MUSTER: u32 = 100;

    let restart = r.c.after_wide.take().expect("P6");
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let program = r.c.program;
    let (_, _, _, genesis_ts) = r.clock();
    let w = k.player.pubkey();
    let wholding = adr(wh::holding_address(&ctx, k.target, k.csite));
    let wprov = adr(wl::province_address(&ctx, k.target));
    let world = WorldId::derive_legacy_season(&a.season.to_bytes(), &a.program.to_bytes())
        .expect("the season's world");
    let pkey = ProvinceKey::new(world, k.target);
    let status = || keeper_status(restart.api, &restart.token).unwrap_or(Value::Null);
    let edit = |r: &mut Run<'_>, key: Address, what: &str, f: &dyn Fn(&mut Vec<u8>)| {
        let mut acct = r.lock().account(&key).expect("an account to patch");
        f(&mut acct.data);
        r.patch(key, acct, what);
    };
    r.lock().set_paused(true);

    // 1. Declared patches (as `verify/tests/playable_wide_next.rs` step 5): the wide province's `resolved_next` = the
    //    current bell, standing in for WideResolve (no keeper duty sends it yet); the wide village's stores filled and
    //    400 Spearmen in reserve (the means of the actions; natural production would take days of chain time).
    let now_b = r.bell();
    edit(
        r,
        wprov,
        &format!(
            "wide province ({}, {}) resolved_next = bell {now_b} (stands in for WideResolve)",
            k.target.p(),
            k.target.q()
        ),
        &|d| d[PV1::RESOLVED_NEXT..PV1::RESOLVED_NEXT + 4].copy_from_slice(&now_b.to_le_bytes()),
    );
    edit(
        r,
        wholding,
        "the wide village's stores filled, 400 Spearmen in reserve",
        &|d| {
            for res in 0..RESOURCES {
                let so = H::store(res);
                d[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&STORES.to_le_bytes());
                let cap = i64::from_le_bytes(d[so + AC::CAP..so + AC::CAP + 8].try_into().unwrap());
                if cap < STORES {
                    d[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&STORES.to_le_bytes());
                }
            }
            let ro = H::reserve(0);
            d[ro..ro + 4].copy_from_slice(&400u32.to_le_bytes());
        },
    );
    let metas = |extra: Vec<AccountMeta>| {
        let mut v = vec![
            AccountMeta::new_readonly(w, true),
            AccountMeta::new(w, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(k.citizen, false),
        ];
        v.extend(extra);
        v
    };
    let economy_ix = |action: Action| {
        wide_ix(
            &a,
            metas(vec![
                AccountMeta::new(wholding, false),
                if action.mirror_write() {
                    AccountMeta::new(wprov, false)
                } else {
                    AccountMeta::new_readonly(wprov, false)
                },
            ]),
            wix::Economy { action }.to_bytes().expect("action").to_vec(),
        )
    };
    let garrison_ix = |delta: i64| {
        wide_ix(
            &a,
            metas(vec![
                AccountMeta::new(wholding, false),
                AccountMeta::new(wprov, false),
            ]),
            wix::Garrison { delta }.to_bytes().expect("delta").to_vec(),
        )
    };
    let muster_ix = |troops: u32, tile: u8| {
        wide_ix(
            &a,
            metas(vec![
                AccountMeta::new(wholding, false),
                AccountMeta::new(wprov, false),
                AccountMeta::new(adr(wro::roster_address(&ctx, pkey)), false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ]),
            wix::Muster {
                unit: 0,
                troops,
                tile,
            }
            .to_bytes()
            .to_vec(),
        )
    };

    // 2. REAL, the participant: the wide village's own actions, each its own transaction (one PSW1 record each).
    //    Before P8 the first of them latched keeper A's feed guard for good.
    let first_psw1_slot = r.lock().slot();
    r.witness = Some(Witness::default());
    let mut acts = vec![];
    for (action, what) in [
        (Action::Harvest, "WideEconomy Harvest (PSW1 WIDE_ECONOMY)"),
        (
            Action::Build { item: 0 },
            "WideEconomy Build item 0 (PSW1 WIDE_ECONOMY)",
        ),
        (
            Action::Build { item: 6 },
            "WideEconomy Build walls (PSW1 WIDE_ECONOMY_MIRROR)",
        ),
        (
            Action::Train { unit: 0, n: 5 },
            "WideEconomy Train 5 Spearmen (PSW1 WIDE_ECONOMY)",
        ),
    ] {
        acts.push(r.send(
            what,
            &[economy_ix(action)],
            &[k.player],
            "wide village owner",
        ));
    }
    acts.push(r.send(
        "WideGarrison +7 (PSW1 WIDE_GARRISON)",
        &[garrison_ix(7)],
        &[k.player],
        "wide village owner",
    ));
    let pd = r.data(&wprov).expect("the wide province");
    let passable = u64::from_le_bytes(
        pd[PV1::PASSABLE_MASK..PV1::PASSABLE_MASK + 8]
            .try_into()
            .unwrap(),
    );
    let tile = (0..64u8)
        .filter(|t| passable & (1u64 << t) != 0)
        .find(|t| r.simulate_ok(&[muster_ix(MUSTER, *t)], &[k.player]).is_ok())
        .unwrap_or_else(|| {
            let t = (0..64u8).find(|t| passable & (1u64 << t) != 0).unwrap_or(0);
            let row = r.try_send(
                "WideMuster (probe)",
                &[muster_ix(MUSTER, t)],
                &[k.player],
                "wide village owner",
            );
            panic!("no tile takes a muster: {row:#}")
        });
    acts.push(r.send(
        &format!("WideMuster {MUSTER} Spearmen onto tile {tile} (PSW1 WIDE_MUSTER)"),
        &[muster_ix(MUSTER, tile)],
        &[k.player],
        "wide village owner",
    ));
    // The verifier's VWL judges the economy segment: no FAIL; a forged post-state of the village FAILs.
    let wit = r.witness.take().expect("the economy witness");
    let found = judge(r, &wit, "p6-wide-village-economy-segment");
    let vwl_economy: Vec<Value> = found
        .iter()
        .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity, "detail": f.detail}))
        .collect();
    assert!(
        found
            .iter()
            .all(|f| f.severity == verify_core::Severity::Warn),
        "VWL on the wide village's actions: {vwl_economy:#?}"
    );
    let mut forged = segment_of(r, &wit, "p6-wide-village-economy-segment");
    {
        let wk = wholding.to_bytes();
        let t = forged
            .txs
            .iter_mut()
            .rev()
            .find(|t| {
                t.post
                    .iter()
                    .any(|(k, a)| k.to_bytes() == wk && a.is_some())
            })
            .expect("an action wrote the village");
        let (_, acct) = t.post.iter_mut().find(|(k, _)| k.to_bytes() == wk).unwrap();
        let ro = H::reserve(0);
        acct.as_mut().unwrap().data[ro] ^= 0x55;
    }
    let forged_fails = verify_core::checks::vwl_wide_land::judge_segment(&forged, &wit.snapshot)
        .iter()
        .filter(|f| f.fail())
        .count();
    assert!(forged_fails > 0, "a forged wide village reserve must FAIL");
    let psw1_logged: usize = wit
        .txs
        .iter()
        .map(|t| {
            t.logs
                .iter()
                .filter(|l| l.starts_with("Program data: UFNXMQ=="))
                .count()
        })
        .sum();
    assert_eq!(psw1_logged, 6, "one PSW1 record per action");
    // Control on these very records: the strict reader (every build before P8) refuses each of them, which is
    // what latched keeper A; the playable-lane scope accounts for each.
    let scope = keeper_core::feedguard::WideScope::of(&a).expect("a playable-lane scope");
    let mut strict_refusals = vec![];
    for t in &wit.txs {
        let strict = keeper_core::feedguard::bodies(t, &program)
            .expect_err("the strict reader refuses PSW1");
        assert_eq!(strict, "unsupported PSW1 record");
        strict_refusals.push(strict);
        let got = keeper_core::feedguard::bodies_scoped(t, &program, Some(&scope))
            .expect("accounted for");
        assert_eq!(got.wide.len(), 1);
        assert!(got.ps2.is_empty());
    }

    // 3. keeper A reads them: accounted for, not latched, writes still allowed.
    let t0 = Instant::now();
    let st_after_acts = loop {
        {
            let mut c = r.lock();
            c.set_scale(2.0);
            c.set_paused(false);
        }
        let st = status();
        if accounted(&st, "WIDE_ECONOMY") >= 3 && accounted(&st, "WIDE_MUSTER") >= 1 {
            break st;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "keeper A did not read the PSW1 records: {st:#}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    r.lock().set_paused(true);
    assert_eq!(
        st_after_acts["discovery"]["automatic_writes"], true,
        "{st_after_acts:#}"
    );
    assert_eq!(st_after_acts["discovery"]["land"]["state"], "legacy");
    assert_eq!(st_after_acts["discovery"]["play"]["state"], "legacy");
    assert!(st_after_acts["discovery"]["blocker"].is_null());
    for (kind, n) in [
        ("WIDE_ECONOMY", 3),
        ("WIDE_ECONOMY_MIRROR", 1),
        ("WIDE_GARRISON", 1),
        ("WIDE_MUSTER", 1),
    ] {
        assert_eq!(
            accounted(&st_after_acts, kind),
            n,
            "{kind}: {:#}",
            st_after_acts["discovery"]
        );
    }

    // 4. keeper A's `tickets` role after the PSW1 records: a second participant's rim FileTicket, settled.
    let (rp, rq, rsite) = k.rim;
    let pd = r.data(&a.province(rp, rq)).unwrap();
    let site2 = (0..pd[PV::SITE_COUNT] as usize)
        .find(|i| {
            *i as u8 != rsite
                && matches!(
                    pd[PV::site(*i) + SM::STATE],
                    SM::STATE_FREE | SM::STATE_RELEASED_FREE
                )
        })
        .expect("a second free rim site") as u8;
    let p2 = Keypair::new(); // TEST key
    let w2 = p2.pubkey();
    r.lock().airdrop(&w2, 5 * SOL).unwrap();
    let now = r.now();
    let join2 = r.send(
        "Join (second participant)",
        &[ix::join(&a, w2, w2, k.nation, &w2, now + 30 * 86_400, None)],
        &[&p2],
        "second participant",
    );
    let me2 = ix::Player {
        actor: w2,
        payer: w2,
        wallet: w2,
    };
    let file2 = r.send(
        &format!("FileTicket(rim {rp}, {rq} site {site2}) (second participant)"),
        &[ix::file_ticket(
            &a,
            &me2,
            &[ix::Site {
                p: rp as i16,
                q: rq as i16,
                site: site2,
            }],
        )],
        &[&p2],
        "second participant",
    );
    let tb2 = le_u32(&r.data(&a.citizen(&w2)).unwrap(), C::TICKET_BELL);
    r.advance_exact(genesis_ts + 600 * (tb2 as i64 + 1) + 200);
    r.stage_seed(tb2, ix::region_of(rp, rq), [0x6B; 32]);
    let since = r.lock().slot();
    let holding2 = a.holding(rp, rq, site2);
    r.run_until(
        2.0,
        180,
        "keeper A's tickets role settles a rim ticket after the PSW1 records",
        |r| {
            r.lock()
                .account(&holding2)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    r.lock().set_paused(true);
    let settle2 = r.feed_rows(
        since,
        &[fclient::abi::tag::SETTLE_TICKET],
        "keeper A (tickets role)",
    );
    assert!(settle2.iter().any(|x| x["ok"] == true), "{settle2:#?}");

    // 5. keeper A's `wide-tickets` role after the PSW1 records: the first participant's slot-3 wide claim (its slot 2
    //    is the final wide village), settled and finalized. Declared: the rim anchor's stores (the settler cost).
    let anchor = a.holding(rp, rq, rsite);
    let anchor_p = a.province(rp, rq);
    edit(
        r,
        anchor,
        "the rim anchor's stores filled (slot 3's settler cost)",
        &|d| {
            for res in 0..RESOURCES {
                let so = H::store(res);
                d[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&STORES.to_le_bytes());
                let cap = i64::from_le_bytes(d[so + AC::CAP..so + AC::CAP + 8].try_into().unwrap());
                if cap < STORES {
                    d[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&STORES.to_le_bytes());
                }
            }
        },
    );
    let tk = adr(wt::ticket_address(&ctx, &k.citizen.to_bytes()));
    let claim3 = |c: WideCoord, site: u8| {
        wide_ix(
            &a,
            vec![
                AccountMeta::new_readonly(w, true),
                AccountMeta::new(w, true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(k.citizen, false),
                AccountMeta::new_readonly(a.frontier(), false),
                AccountMeta::new(adr(wl::province_address(&ctx, c)), false),
                AccountMeta::new(tk, false),
                AccountMeta::new(anchor, false),
                AccountMeta::new_readonly(anchor_p, false),
                AccountMeta::new(wholding, false),
                AccountMeta::new_readonly(wprov, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            wix::ClaimSite {
                p: c.p(),
                q: c.q(),
                site,
                slot: 3,
            }
            .to_bytes()
            .to_vec(),
        )
    };
    let plan129 = keeper_core::rings::wide_plan(FIRST_WIDE_RING, PER_WEDGE);
    let mut near: Vec<WideCoord> = plan129.clone();
    near.sort_by_key(|c| c.distance(k.target));
    let mut found3 = None;
    let mut last_err = String::new();
    'outer: for c in near.iter().take(8) {
        for s in 0..16u8 {
            if *c == k.target && s == k.csite {
                continue;
            }
            match r.simulate_ok(&[claim3(*c, s)], &[k.player]) {
                Ok(_) => {
                    found3 = Some((*c, s));
                    break 'outer;
                }
                Err(e) => last_err = e,
            }
        }
    }
    let (c3, s3) = found3.unwrap_or_else(|| panic!("no slot-3 wide claim fits ({last_err})"));
    r.witness = Some(Witness::default());
    let cl3 = r.send(
        &format!(
            "WideClaimSite({}, {} site {s3}, slot 3) from the rim Hamlet",
            c3.p(),
            c3.q()
        ),
        &[claim3(c3, s3)],
        &[k.player],
        "rim participant",
    );
    let rec3 = WideTicket::read(&r.data(&tk).unwrap()).expect("a wide ticket");
    assert_eq!(rec3.status, TicketStatus::Open);
    let wp3 = WideProvince::read(&r.data(&adr(wl::province_address(&ctx, c3))).unwrap())
        .expect("wide province");
    r.advance_exact(genesis_ts + 600 * (rec3.bell as i64 + 1) + 200);
    r.stage_seed(rec3.bell, wp3.region, [0xC3; 32]);
    let wholding3 = adr(wh::holding_address(&ctx, c3, s3));
    let cdn = r.data(&k.citizen).unwrap();
    let (faction, shard) = (cdn[C::FACTION], cdn[C::JOIN_SHARD]);
    let dummy_settle = keeper_core::widelane::settle_ticket(
        &a,
        k.dummy,
        &rec3,
        faction,
        shard,
        wp3.region,
        fclient::ix::SeedSource::Cache { nonce: 0 },
        None,
    );
    let since = r.lock().slot();
    r.witness_before(&[dummy_settle]);
    r.run_until(
        2.0,
        180,
        "keeper A's wide-tickets role settles the slot-3 claim after the PSW1 records",
        |r| {
            r.lock()
                .account(&wholding3)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    r.lock().set_paused(true);
    r.witness_landed(since, &[wix::WideIx::SettleTicket.tag()]);
    let ws3 = r.feed_rows(
        since,
        &[wix::WideIx::SettleTicket.tag()],
        "keeper A (wide-tickets role)",
    );
    assert!(ws3.iter().any(|x| x["ok"] == true), "{ws3:#?}");
    let whd3 = r.data(&wholding3).unwrap();
    assert_eq!(whd3[H::STATE], H::STATE_PROVISIONAL);
    r.advance_exact(le_i64(&whd3, H::FINAL_TS).max(r.now()) + 1);
    let since = r.lock().slot();
    r.witness_before(&[keeper_core::widelane::finalize(&a, k.dummy, c3, s3)]);
    r.run_until(
        2.0,
        180,
        "keeper A's wide-tickets role finalizes the slot-3 village",
        |r| {
            r.data(&wholding3)
                .is_some_and(|h| h[H::STATE] == H::STATE_FINAL)
        },
    )
    .await;
    r.lock().set_paused(true);
    r.witness_landed(since, &[wix::WideIx::Finalize.tag()]);
    let wf3 = r.feed_rows(
        since,
        &[wix::WideIx::Finalize.tag()],
        "keeper A (wide-tickets role)",
    );
    assert!(wf3.iter().any(|x| x["ok"] == true), "{wf3:#?}");
    let wit3 = r.witness.take().expect("the slot-3 witness");
    let found3 = judge(r, &wit3, "p6-slot3-claim-segment");
    let vwl_slot3: Vec<Value> = found3
        .iter()
        .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity, "detail": f.detail}))
        .collect();
    assert!(
        found3
            .iter()
            .all(|f| f.severity == verify_core::Severity::Warn),
        "VWL on the slot-3 claim: {vwl_slot3:#?}"
    );
    // ...and the wide village acts again (more PSW1 records while keeper A runs).
    let harvest_again = r.send(
        "WideEconomy Harvest again (PSW1 WIDE_ECONOMY)",
        &[economy_ix(Action::Harvest)],
        &[k.player],
        "wide village owner",
    );

    // 6. Restart keeper A with `wide_rings` 4: the new process re-reads the whole feed (every PSW1 record above), its
    //    journal holds no latch, and its rings duty requests ring 132's seed.
    {
        let child = &mut *r.c.keeper;
        let _ = child.kill();
        let _ = child.wait();
    }
    let toml = std::fs::read_to_string(&restart.config).unwrap();
    let toml = toml.replace(
        &format!("wide_rings = {WIDE_RINGS}\n"),
        &format!("wide_rings = {}\n", WIDE_RINGS + 1),
    );
    assert!(toml.contains(&format!("wide_rings = {}\n", WIDE_RINGS + 1)));
    std::fs::write(&restart.config, &toml).unwrap();
    *r.c.keeper = std::process::Command::new(&restart.bin)
        .args(["--config", restart.config.to_str().unwrap()])
        .env("FRONTIER_KEEPER_TICK_LOG", "1")
        .stdout(std::fs::File::create(r.c.dir.join("keeper-restarted.out.log")).unwrap())
        .stderr(std::fs::File::create(r.c.dir.join("keeper-restarted.log")).unwrap())
        .spawn()
        .expect("frontier-keeper (restarted)");
    let ring132 = FIRST_WIDE_RING + WIDE_RINGS;
    let seed_of = |r: &Run<'_>, ring: u64| {
        r.data(&adr(wl::ring_seed_address(&r.ctx(), ring)))
            .and_then(|d| wl::WideRingSeed::read(&d).ok())
    };
    assert!(seed_of(r, ring132).is_none());
    let since = r.lock().slot();
    r.run_until(
        2.0,
        240,
        "the restarted keeper A requests ring 132's seed",
        |r| seed_of(r, ring132).is_some(),
    )
    .await;
    r.lock().set_paused(true);
    let req132 = r.feed_rows(
        since,
        &[wix::WideIx::RequestRingSeed.tag()],
        "keeper A (rings duty, restarted)",
    );
    assert!(req132.iter().any(|x| x["ok"] == true), "{req132:#?}");
    let rec132 = seed_of(r, ring132).unwrap();

    // 7. keeper A folds every bell of a window of P8_BELLS bells (the `fold` role: three FoldOccupancy parts a bell),
    //    with the PSW1 records in its feed, and reads them all again (restart).
    let fold_since = r.lock().slot();
    let b0 = r.bell();
    let mut folded = vec![];
    for b in b0 + 1..=b0 + P8_BELLS {
        r.advance_exact(genesis_ts + 600 * b as i64 + 5);
        r.run_until(1.0, 180, &format!("keeper A folds bell {b}"), |r| {
            r.data(&r.c.a.frontier())
                .is_some_and(|d| le_u32(&d, FR::FOLD_BELL) == b && d[FR::FOLD_PART] == 0)
        })
        .await;
        r.lock().set_paused(true);
        folded.push(b);
    }
    let folds = r.feed_rows(
        fold_since,
        &[fclient::abi::tag::FOLD_OCCUPANCY],
        "keeper A (fold role)",
    );
    let folds_ok = folds.iter().filter(|x| x["ok"] == true).count();
    assert!(folds_ok >= 3 * P8_BELLS as usize, "{folds:#?}");
    let st_end = status();
    assert_eq!(st_end["discovery"]["automatic_writes"], true, "{st_end:#}");
    assert!(st_end["discovery"]["blocker"].is_null(), "{st_end:#}");
    assert_eq!(
        accounted(&st_end, "WIDE_ECONOMY"),
        4,
        "{:#}",
        st_end["discovery"]
    );
    // keeper A's writes after the first PSW1 record, by duty
    let after = |tags: &[u8]| {
        r.feed_rows(first_psw1_slot, tags, "keeper A")
            .into_iter()
            .filter(|x| x["ok"] == true)
            .count()
    };
    json!({
        "gap": "P8: the legacy feed guard accounts for the wide village's PSW1 records instead of latching",
        "declared_patches": ["wide province resolved_next = the current bell (stands in for WideResolve)",
            "the wide village's stores filled, 400 Spearmen in reserve", "the rim anchor's stores filled (slot 3's settler cost)",
            "the ticket bells' anchors and seeds (as P4/P5)"],
        "wide_village_actions": acts, "harvest_again": harvest_again, "psw1_records_logged": psw1_logged + 1,
        "strict_reader_refusals_of_these_records": strict_refusals,
        "verifier_vwl_economy_segment": {"transactions": wit.txs.len(), "snapshot_accounts": wit.snapshot.len(),
            "findings": vwl_economy, "mutation_forged_reserve_fails": forged_fails},
        "keeper_status_after_actions": st_after_acts["discovery"],
        "second_participant": {"join": join2, "file_ticket": file2, "rim_site": site2, "keeper_settle_ticket": settle2},
        "slot3": {"p": c3.p(), "q": c3.q(), "site": s3, "claim": cl3, "keeper_wide_settle": ws3, "keeper_wide_finalize": wf3,
            "verifier_vwl_segment": {"transactions": wit3.txs.len(), "snapshot_accounts": wit3.snapshot.len(), "findings": vwl_slot3}},
        "restart": {"wide_rings": WIDE_RINGS + 1, "feed_reread_from": 0,
            "ring132_request": req132, "ring132_round": rec132.round, "ring132_request_bell": rec132.opened_bell,
            "ring132_consume": "waits for its round, which is after the 32 shipped rounds (offline only; on devnet every round exists)"},
        "fold_window": {"bells": folded, "fold_txs_ok": folds_ok},
        "keeper_status_end": st_end["discovery"],
        "keeper_a_ok_writes_after_first_psw1": {
            "fold": after(&[fclient::abi::tag::FOLD_OCCUPANCY]),
            "settle_ticket": after(&[fclient::abi::tag::SETTLE_TICKET]),
            "wide_settle_ticket": after(&[wix::WideIx::SettleTicket.tag()]),
            "wide_finalize": after(&[wix::WideIx::Finalize.tag()]),
            "wide_request_ring_seed": after(&[wix::WideIx::RequestRingSeed.tag()]),
        },
        "program": program.to_string(),
    })
}

/// Kills the page driver this test started (never anything else) on drop.
struct KillChild(std::process::Child);
impl Drop for KillChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// P7 (devnet gap P1): the PAGE plays the participant on the exact devnet `.so`, served by the herald (`--cluster
/// devnet`) with the gateway's devnet play routes behind its `/gw`. The driver (headless Chromium) connects a Wallet
/// Standard TEST wallet on `solana:devnet`, chooses `nation`, confirms the page's own first-village choice (an opened rim
/// province, so the page files a one-site FileTicket), harvests, and presses the village screen's wide-claim button.
/// This test sends NO player transaction: it moves the clock, declares each bell's anchor and seed (as P4/P5, the
/// shipped rounds do not cover these bells), and keeper A settles (`tickets`, `wide-tickets`) and finalizes.
async fn page_flow(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    nation: u8,
    extra: Value,
) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let sd = r.season();
    let regions = sd[S::REGIONS];
    let genesis_ts = r.clock().3;
    let sync = r.c.dir.join("page");
    std::fs::create_dir_all(&sync).unwrap();
    std::fs::create_dir_all(&pg.out).unwrap();
    // (the page reads the opened wide provinces from the herald's recorded wide world: a herald built without
    //  `--features wide-world-experimental` answers 503 there, and the page never offers the wide claim)
    assert!(
        super::http_get(pg.herald, "/h/world/wide").is_some(),
        "the herald serves no wide world: build it with `cargo build -p herald --features wide-world-experimental,expedition-records-experimental`"
    );
    let player = Keypair::new(); // TEST key: the page's wallet (this chain only)
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let seed_file = sync.join("player.seed");
    std::fs::write(&seed_file, hex::encode(&player.to_bytes()[..32])).unwrap();
    std::fs::set_permissions(&seed_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let mut driver = KillChild(
        std::process::Command::new("node")
            .arg(&pg.driver)
            .args([
                "--url",
                &format!("http://127.0.0.1:{}/frontier/frontier/", pg.herald),
                "--out",
                pg.out.to_str().unwrap(),
                "--seed-file",
                seed_file.to_str().unwrap(),
                "--nation",
                &nation.to_string(),
                "--inspect",
                &pg.inspect.to_string(),
                "--sync",
                sync.to_str().unwrap(),
            ])
            .args(pg.wide_acts.then_some("--wide-acts"))
            .args(pg.territory.is_some().then_some("--territory"))
            .stdout(std::fs::File::create(pg.out.join("driver.out.log")).unwrap())
            .stderr(std::fs::File::create(pg.out.join("driver.err.log")).unwrap())
            .spawn()
            .expect("node (the page driver)"),
    );
    let citizen = a.citizen(&w);
    let alive = |d: &mut KillChild| d.0.try_wait().ok().flatten().is_none();
    let wait_for = |what: &str, secs: u64| {
        let what = what.to_string();
        (what, Instant::now(), Duration::from_secs(secs))
    };
    // 1. The page Joins and files the rim ticket (its own planner picks the province and site).
    let (what, t0, lim) = wait_for("the page joins and files a rim ticket", 420);
    let ticket_bell = loop {
        if let Some(cd) = r.data(&citizen) {
            // (`NO_TICKET` (u32::MAX) right after the Join: no ticket yet)
            let tb = le_u32(&cd, C::TICKET_BELL);
            if tb != C::NO_TICKET {
                break tb;
            }
        }
        assert!(alive(&mut driver), "{what}: the driver exited");
        assert!(t0.elapsed() < lim, "{what}: not in {lim:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let cd = r.data(&citizen).unwrap();
    let joined_nation = cd[C::FACTION];
    // 2. Declared: the ticket bell's anchor and seed in every region (the page chose the province); keeper A settles.
    r.advance_exact(genesis_ts + 600 * (ticket_bell as i64 + 1) + 200);
    for region in 0..regions {
        r.stage_seed(ticket_bell, region, [0x5A; 32]);
    }
    let since = r.lock().slot();
    let find_home = |r: &Run<'_>| -> Option<(i32, i32, u8, Address)> {
        for &(p, q) in plan {
            for s in 0..12u8 {
                let h = a.holding(p, q, s);
                if let Some(d) = r.data(&h) {
                    if d.len() > H::OWNER_CITIZEN + 32
                        && d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] == citizen.to_bytes()
                    {
                        return Some((p, q, s, h));
                    }
                }
            }
        }
        None
    };
    r.run_until(
        2.0,
        240,
        "keeper A's tickets role settles the page's rim ticket",
        |r| find_home(r).is_some(),
    )
    .await;
    let settle = r.feed_rows(
        since,
        &[fclient::abi::tag::SETTLE_TICKET],
        "keeper A (tickets role)",
    );
    let (rp, rq, rsite, holding) = find_home(r).unwrap();
    let hd = r.data(&holding).unwrap();
    assert_eq!(
        hd[H::STATE],
        H::STATE_PROVISIONAL,
        "a provisional first village"
    );
    assert_eq!(hd[H::ORDER], 1, "the first village");
    let ring = ProvinceCoord::new(rp, rq).ring();
    assert!((126..=128).contains(&ring), "on the rim: ring {ring}");
    let final_ts = le_i64(&hd, H::FINAL_TS);
    // (P18: a territory world's village stands on the page's own tile, and a tile costs ore (10 + 2 % a tile owned);
    //  a rim first village's terrain yields none. Declared: the first home's ore.)
    if pg.territory.is_some() {
        territory_page::declare_ore(r, holding);
    }
    // 3. The clock runs on in 4-hour steps; the page harvests after each (its own button), and presses the wide claim
    //    once the village's stores cover the settler cost.
    let tk = adr(wt::ticket_address(&ctx, &citizen.to_bytes()));
    let mut t = final_ts.max(r.now()) + 600;
    let mut steps = vec![];
    let mut claimed = false;
    for _ in 0..16 {
        r.advance_exact(t);
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        let t0 = Instant::now();
        let mut harvested = false;
        while t0.elapsed() < Duration::from_secs(150) {
            assert!(alive(&mut driver), "the driver exited while harvesting");
            if r.data(&tk)
                .is_some_and(|d| WideTicket::read(&d).is_ok_and(|x| x.status == TicketStatus::Open))
            {
                claimed = true;
                break;
            }
            if !harvested
                && r.data(&holding)
                    .is_some_and(|d| le_i64(&d, H::LAST_OWNER_ACTION) >= t)
            {
                harvested = true;
                // (a little longer: the page reads its stores again and may press the claim)
                tokio::time::sleep(Duration::from_secs(20)).await;
                if r.data(&tk).is_some_and(|d| {
                    WideTicket::read(&d).is_ok_and(|x| x.status == TicketStatus::Open)
                }) {
                    claimed = true;
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let hd = r.data(&holding).unwrap();
        steps.push(json!({"clock": t, "harvested_by_page": harvested, "state": hd[H::STATE], "tier": hd[H::TIER]}));
        if claimed {
            break;
        }
        t += 4 * 3_600;
    }
    assert!(claimed, "the page did not file the wide claim: {steps:#?}");
    let rec = WideTicket::read(&r.data(&tk).unwrap()).unwrap();
    // 4. Declared: the claim bell's anchor and seed; keeper A's wide-tickets role settles, then finalizes.
    r.advance_exact(genesis_ts + 600 * (rec.bell as i64 + 1) + 200);
    for region in 0..regions {
        r.stage_seed(rec.bell, region, [0xA5; 32]);
    }
    let wholding = adr(wh::holding_address(&ctx, rec.coord, rec.site));
    let since = r.lock().slot();
    r.run_until(
        2.0,
        240,
        "keeper A's wide-tickets role settles the page's wide claim",
        |r| {
            r.lock()
                .account(&wholding)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    let ws = r.feed_rows(
        since,
        &[wix::WideIx::SettleTicket.tag()],
        "keeper A (wide-tickets role)",
    );
    let whd = r.data(&wholding).expect("the wide village");
    let wfinal_ts = le_i64(&whd, H::FINAL_TS);
    r.advance_exact(wfinal_ts.max(r.now()) + 1);
    let since = r.lock().slot();
    r.run_until(
        2.0,
        240,
        "keeper A's wide-tickets role finalizes the page's wide village",
        |r| {
            r.data(&wholding)
                .is_some_and(|h| h[H::STATE] == H::STATE_FINAL)
        },
    )
    .await;
    let wf = r.feed_rows(
        since,
        &[wix::WideIx::Finalize.tag()],
        "keeper A (wide-tickets role)",
    );
    let wide = wh::WideHolding::read(&r.data(&wholding).unwrap()).expect("a wide holding");
    assert_eq!(wide.owner_citizen, citizen.to_bytes());
    // 5. The page shows the wide village as final (the driver says so, then takes its last stills).
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    std::fs::write(
        sync.join("go-final"),
        format!("{} {} {}\n", rec.coord.p(), rec.coord.q(), rec.site),
    )
    .unwrap();
    let t0 = Instant::now();
    let done = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("done.json")) {
            break serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        assert!(
            alive(&mut driver),
            "the driver exited before it saw the wide village"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(300),
            "the page did not show the final wide village"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert_eq!(done["wideVillageFinal"], true, "{done}");
    // P18 (devnet-territory-dev): tiles, keeper A's settle, conquest transfer and decay, from the page.
    let p18 = if let Some(ti) = &pg.territory {
        territory_page::phase(
            r,
            ti,
            &sync,
            &mut || alive(&mut driver),
            w,
            holding,
            joined_nation,
            rec.coord,
            rec.site,
        )
        .await
    } else {
        Value::Null
    };
    // P17 (devnet-p17): the wide village's own acts, from the page.
    let p17 = if pg.wide_acts {
        wide_acts_page::phase(r, &sync, &mut || alive(&mut driver), w, rec.coord, rec.site).await
    } else {
        Value::Null
    };
    drop(driver);
    // Every page transaction: the participant wallet is fee payer and the only signer.
    let page_txs: Vec<Value> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            (t.message.account_keys.first() == Some(&w)).then(|| {
                json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "signatures": t.signatures.len(),
                       "tag": t.message.instructions.last().and_then(|i| i.data.first().copied()),
                       "compute_units": l.units, "fee": l.fee,
                       "lamports_from_wallet": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
            })
        })
        .collect();
    assert!(
        page_txs.iter().all(|x| x["signatures"] == 1),
        "{page_txs:#?}"
    );
    let keeper_alive = r.c.keeper.try_wait().ok().flatten().is_none();
    assert!(keeper_alive, "keeper A exited");
    json!({
        "p7_page": "the web page as the participant: Join, rim FileTicket, Harvest, WideClaimSite — wallet-signed, wallet-paid, via the gateway's devnet play routes",
        "participant": {"wallet": w.to_string(), "nation_hint": nation, "nation": joined_nation},
        "rim_village": {"p": rp, "q": rq, "site": rsite, "ring": ring, "ticket_bell": ticket_bell, "final_ts": final_ts},
        "keeper_settle_ticket": settle, "harvest_steps": steps,
        "wide_village": {"p": rec.coord.p(), "q": rec.coord.q(), "site": rec.site, "ring": rec.coord.ring(), "slot": rec.slot, "ticket_bell": rec.bell},
        "keeper_wide_settle": ws, "keeper_wide_finalize": wf,
        "page_transactions": page_txs, "driver": done, "declared_patches": r.patches, "setup": extra,
        "p17": p17,
        "p18": p18,
    })
}
