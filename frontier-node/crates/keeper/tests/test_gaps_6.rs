//! test-gaps-6: key-free tests for #282 (never-landed versions settled, so
//! payer care is not blocked) and #280 (S1 / playable-lane Reveal requested
//! at 32,000 CU).
//!
//! Literal journal rows, literal addresses and an in-memory chain port only.
//! No key is generated, derived or signed: the port refuses `send`, and the
//! #280 test builds the keeper's message unsigned. The send-pass blockhash
//! refresh (#282) and the Keeper-level care tests sign with seed-derived
//! test payers, so they live in the keeper's lib tests (key-tests job).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::Mutex;

use fclient::abi::{self, tag, Class};
use fclient::budgets::{Budgets, REVEAL_REQUEST_CU_S1, RUNTIME_MAX_LOADED_LIMIT};
use fclient::ports::*;
use fclient::Hash;
use fclient::{fees, tx, Address};
use keeper_core::config::KeeperConfig;
use keeper_core::engine::{
    BuildCtx, Engine, EngineParams, WriteSpec, BLOCKHASH_VALID_BLOCKS, EXPIRED_MARGIN_BLOCKS,
    PAYER_CARE_KIND,
};
use keeper_core::journal::{Attempt, Journal};

/// `RpcPort`'s history search proves at most this many signatures absent
/// per status read (`fclient::rpc::HISTORY_PER_CALL`).
const HISTORY_PER_CALL: usize = 32;

/// A chain that knows which signatures landed. Like `RpcPort`, a status read
/// proves an unknown signature absent (history `null`) only for the first
/// [`HISTORY_PER_CALL`] unknown signatures of the call, and never in
/// `cache_only` mode (a status-cache `null` proves nothing).
#[derive(Default)]
struct Chain {
    slot: AtomicU64,
    /// `getLatestBlockhash`'s `lastValidBlockHeight` (= block height + 150).
    valid_height: AtomicU64,
    landed: Mutex<HashMap<Signature, Status>>,
    cache_only: AtomicBool,
    status_reads: AtomicU64,
    proven_absent: AtomicU64,
}

impl ChainPort for Chain {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(ClockSysvar {
            slot: self.slot.load(SeqCst),
            ..ClockSysvar::default()
        })
    }
    async fn accounts(&self, keys: &[Address], _: u64) -> PortResult<Vec<Option<Account>>> {
        Ok(vec![None; keys.len()])
    }
    async fn simulate(&self, _: &[u8]) -> PortResult<SimResult> {
        Ok(SimResult::default())
    }
    async fn send(&self, _: &[u8]) -> PortResult<Signature> {
        panic!("key-free: nothing is signed or sent in this file");
    }
    async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        let m = self.landed.lock().unwrap();
        Ok(sigs.iter().map(|s| m.get(s).cloned()).collect())
    }
    async fn statuses_absent(
        &self,
        sigs: &[Signature],
    ) -> PortResult<(Vec<Option<Status>>, Vec<bool>)> {
        self.status_reads.fetch_add(1, SeqCst);
        let v = self.statuses(sigs).await?;
        let mut budget = if self.cache_only.load(SeqCst) {
            0
        } else {
            HISTORY_PER_CALL
        };
        let absent: Vec<bool> = v
            .iter()
            .map(|s| {
                let proven = s.is_none() && budget > 0;
                if proven {
                    budget -= 1;
                }
                proven
            })
            .collect();
        self.proven_absent
            .fetch_add(absent.iter().filter(|a| **a).count() as u64, SeqCst);
        Ok((v, absent))
    }
    async fn feed(&self, _: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((
            Hash::new_from_array([3; 32]),
            self.valid_height.load(SeqCst),
        ))
    }
}

fn sig(i: usize) -> Signature {
    let mut b = [0u8; 64];
    b[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
    b[63] = 0x62;
    Signature::from(b)
}

fn addr(i: usize) -> Address {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
    b[31] = 0x62;
    Address::new_from_array(b)
}

const FUNDER: usize = 9_000;

/// The 11-26 15:04 care pass as the journal held it after a restart: 134
/// transfers signed in groups of 16 per blockhash (#282's refresh), the
/// first 41 landed, the other 93 never reached the chain.
const CARE_ROWS: usize = 134;
const CARE_LANDED: usize = 41;
const SENT_SLOT: u64 = 526_412_965;
const FIRST_VALID_HEIGHT: u64 = 1_000_000;

fn valid_height_of(i: usize) -> u64 {
    FIRST_VALID_HEIGHT + (i / 16) as u64 * 8
}

fn care_row(i: usize) -> Attempt {
    Attempt {
        sig: sig(i).to_string(),
        write_id: None,
        tag: None,
        kind: PAYER_CARE_KIND.into(),
        object_key: format!("care:{}:{}:{SENT_SLOT}", addr(FUNDER), addr(i)),
        bell: None,
        region: None,
        class: "N".into(),
        payer: addr(FUNDER).to_string(),
        bid_milli: 100,
        fee: 5_000 + i as u64,
        cu_limit: 2_000,
        heap: None,
        first_valid_slot: SENT_SLOT,
        sent_slot: SENT_SLOT,
        last_valid_block_height: Some(valid_height_of(i)),
        landed_slot: None,
        status: "sent".into(),
        code: None,
    }
}

fn status_of(j: &Journal, i: usize) -> String {
    let rows = j.attempts_of(&care_row(i).object_key).unwrap();
    assert_eq!(rows.len(), 1);
    rows[0].status.clone()
}

/// The keeper's care gate, as `Keeper::tick` evaluates it (`care_due` with
/// `care_pending = engine.care_unresolved()`), long after the last care
/// pass, with the delay pool low.
fn care_would_run(e: &Engine, slot: u64) -> bool {
    let cfg = KeeperConfig::new(Address::new_from_array([5; 32]), 3, addr(FUNDER));
    keeper_core::care_due(
        &cfg,
        Some((SENT_SLOT, 0, CARE_ROWS)),
        slot,
        1_000_000,
        true,
        e.care_unresolved(),
    )
}

fn engine_with_backlog(j: &Journal, chain: &Chain) -> Engine {
    for i in 0..CARE_ROWS {
        j.record_attempt(&care_row(i)).unwrap();
    }
    let mut landed = chain.landed.lock().unwrap();
    for i in 0..CARE_LANDED {
        landed.insert(
            sig(i),
            Status {
                slot: SENT_SLOT + 3,
                err: None,
                code: None,
            },
        );
    }
    drop(landed);
    let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
    e.adopt(&j.in_flight().unwrap()).unwrap();
    e
}

/// The chain's block height when the newest row is exactly at the margin.
fn at_margin() -> u64 {
    valid_height_of(CARE_ROWS - 1) + EXPIRED_MARGIN_BLOCKS
}

/// #282 / keeper-stall-investigate: a backlog of unknown care transfers
/// (adopted after a restart) is settled once the chain is past every row's
/// validity + 300 blocks and the history search answered `null`, 32 per
/// read as on a remote RPC. Care stays blocked until the last one is
/// proven, then the next top-up may go out at once. Landed rows are
/// landed, the never-landed ones `superseded`, their fees never charged.
#[tokio::test]
async fn expired_care_backlog_settles_never_landed_and_care_resumes() {
    let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
    let chain = Chain::default();
    let mut e = engine_with_backlog(&j, &chain);
    let mut slot = SENT_SLOT + 1_000;
    assert!(e.care_unresolved());
    assert!(
        !care_would_run(&e, slot),
        "unknown care blocks every top-up"
    );

    // Exactly at the oldest never-landed row's margin (its group's
    // validity + 300, not past it; no row is past its own): the landed 41
    // resolve, nothing else.
    chain.valid_height.store(
        valid_height_of(CARE_LANDED) + EXPIRED_MARGIN_BLOCKS + BLOCKHASH_VALID_BLOCKS,
        SeqCst,
    );
    e.poll(&chain, Some(&j), slot).await;
    assert_eq!(j.in_flight().unwrap().len(), CARE_ROWS - CARE_LANDED);
    assert_eq!(e.never_landed, 0, "the margin is not passed yet");
    assert!(!care_would_run(&e, slot));
    assert_eq!(e.care_settled_slot(), Some(SENT_SLOT + 3));

    // One block past the newest row's margin: 32 rows proven per read.
    chain
        .valid_height
        .store(at_margin() + 1 + BLOCKHASH_VALID_BLOCKS, SeqCst);
    let never = CARE_ROWS - CARE_LANDED;
    let polls = never.div_ceil(HISTORY_PER_CALL);
    assert_eq!(polls, 3);
    for n in 1..=polls {
        slot += 10;
        e.poll(&chain, Some(&j), slot).await;
        let settled = (n * HISTORY_PER_CALL).min(never);
        assert_eq!(e.never_landed, settled as u64, "poll {n}");
        assert_eq!(j.in_flight().unwrap().len(), never - settled, "poll {n}");
        assert_eq!(care_would_run(&e, slot), n == polls, "poll {n}");
    }
    assert!(!e.care_unresolved());

    for i in 0..CARE_ROWS {
        let want = if i < CARE_LANDED {
            "landed"
        } else {
            "superseded"
        };
        assert_eq!(status_of(&j, i), want, "row {i}");
    }
    let charged = e.stats[PAYER_CARE_KIND].fees_charged;
    let landed_fees: u64 = (0..CARE_LANDED).map(|i| care_row(i).fee).sum();
    assert_eq!(charged, landed_fees, "never-landed fees are not charged");

    // The top-up now proceeds: a new care transfer is admitted and is a send
    // candidate (care is one of the kinds a blocked feed lets through).
    let to = addr(77);
    let ix = tx::transfer(addr(FUNDER), to, 50_000_000);
    let key = format!("care:{}:{to}:{slot}", addr(FUNDER));
    assert!(e.ensure(
        WriteSpec {
            key: key.clone(),
            kind: PAYER_CARE_KIND,
            tag: 0,
            class: Class::N,
            bell: None,
            region: None,
            build: std::sync::Arc::new(move |_: &BuildCtx| vec![ix.clone()]),
            deadline_slot: None,
            not_before_slot: 0,
            fixed_payer: Some(addr(FUNDER)),
        },
        slot,
    ));
    assert!(e.allows_write_kind(PAYER_CARE_KIND));
    assert_eq!(e.send_candidates(None), vec![key]);
    // A further poll changes nothing (settled rows are never re-read).
    let reads = chain.status_reads.load(SeqCst);
    e.poll(&chain, Some(&j), slot + 1).await;
    assert_eq!(e.never_landed, never as u64);
    assert_eq!(
        chain.status_reads.load(SeqCst),
        reads,
        "nothing left to read"
    );
}

/// verify-pr282's safety fix: a status-cache `null` (no history answer)
/// never settles a row, however far past its validity the chain is; care
/// stays blocked rather than mislabel a landed transfer.
#[tokio::test]
async fn cache_only_nulls_never_settle_the_backlog() {
    let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
    let chain = Chain::default();
    chain.cache_only.store(true, SeqCst);
    let mut e = engine_with_backlog(&j, &chain);
    chain
        .valid_height
        .store(at_margin() + 10_000 + BLOCKHASH_VALID_BLOCKS, SeqCst);
    for n in 0..8 {
        e.poll(&chain, Some(&j), SENT_SLOT + 1_000 + n).await;
    }
    assert_eq!(chain.proven_absent.load(SeqCst), 0);
    assert_eq!(e.never_landed, 0);
    assert_eq!(j.in_flight().unwrap().len(), CARE_ROWS - CARE_LANDED);
    assert!(!care_would_run(&e, SENT_SLOT + 2_000));
    // History comes back: the same rows settle (32 per read).
    chain.cache_only.store(false, SeqCst);
    for n in 0..3 {
        e.poll(&chain, Some(&j), SENT_SLOT + 3_000 + n).await;
    }
    assert_eq!(e.never_landed, (CARE_ROWS - CARE_LANDED) as u64);
    assert!(care_would_run(&e, SENT_SLOT + 3_010));
}

/// Rows of a backlog sent with different blockhashes expire one hash group at
/// a time: a row is settled only once ITS validity + 300 has passed.
#[tokio::test]
async fn each_row_waits_for_its_own_validity_height() {
    let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
    let chain = Chain::default();
    let mut e = engine_with_backlog(&j, &chain);
    // Past the first never-landed row's group (rows 41..47 share the hash of
    // rows 32..47) but not the next group's (48..).
    let h = valid_height_of(CARE_LANDED) + EXPIRED_MARGIN_BLOCKS + 1;
    assert!(h <= valid_height_of(48) + EXPIRED_MARGIN_BLOCKS);
    chain.valid_height.store(h + BLOCKHASH_VALID_BLOCKS, SeqCst);
    for n in 0..5 {
        e.poll(&chain, Some(&j), SENT_SLOT + 1_000 + n).await;
    }
    assert_eq!(e.never_landed, (48 - CARE_LANDED) as u64);
    for i in CARE_LANDED..CARE_ROWS {
        let want = if i < 48 { "superseded" } else { "sent" };
        assert_eq!(status_of(&j, i), want, "row {i}");
    }
    assert!(e.care_unresolved());
}

/// The budgets table a keeper follows for a world of `version`, exactly as
/// `Keeper::follow_abi` builds it (canonical_for, the care row kept, the wide
/// rows filled on a playable-lane world when built with that feature).
fn followed(version: u16) -> Budgets {
    let mut b = Budgets::canonical_for(version);
    b.set(0, Budgets::placeholder().get(0));
    #[cfg(feature = "playable-lane")]
    if version & fclient::budgets::LANE_VERSION_BIT != 0 {
        keeper_core::widelane::fill_budgets(&mut b);
    }
    b
}

/// The worst S1 Reveal measured at the keeper's own 3-instruction profile on
/// the devnet world-3 build 245ce1ab (reveal-cu-investigate, verify-pr280).
const WORST_REVEAL_CU: u32 = 27_823;

/// #280: the Reveal message the keeper signs carries `SetComputeUnitLimit`
/// 32,000 for an S1 world and for each playable-lane version (0x4804 the
/// devnet world 3, 0xC804 with the coexist bit), the worst measured Reveal
/// stays ≥ 10 % under it, the loaded limit is the lane's 64 MiB (S1: its own
/// row); MC (v2) and M1 worlds keep their rows. Built unsigned with the
/// engine's own budget prefix (`tx::message`), read back with the parser the
/// fee code uses (`tx::parse_budget`).
#[test]
fn reveal_message_requests_32000_cu_on_every_s1_lane() {
    let payer = addr(1);
    let bh = Hash::new_from_array([7; 32]);
    let s1_limit = frontier_abi::v2::budgets::REVEAL_CU_LIMIT_S1;
    let s1_loaded = frontier_abi::v2::budgets::loaded_limit_s1(frontier_abi::v2::Ix::Reveal);
    let cases: [(u16, u32, u32); 5] = [
        (abi::PROGRAM_VERSION_S1, REVEAL_REQUEST_CU_S1, s1_loaded),
        (0x4804, REVEAL_REQUEST_CU_S1, RUNTIME_MAX_LOADED_LIMIT),
        (0xC804, REVEAL_REQUEST_CU_S1, RUNTIME_MAX_LOADED_LIMIT),
        (
            abi::PROGRAM_VERSION_V2,
            frontier_abi::v2::budgets::budget(frontier_abi::v2::Ix::Reveal).cu_limit,
            Budgets::canonical_v2().get(tag::REVEAL).loaded_limit,
        ),
        (
            abi::PROGRAM_VERSION_V1,
            Budgets::canonical().get(tag::REVEAL).cu_limit,
            Budgets::canonical().get(tag::REVEAL).loaded_limit,
        ),
    ];
    assert_eq!(REVEAL_REQUEST_CU_S1, 32_000);
    assert_eq!(
        s1_limit, 28_000,
        "the on-chain reveal_cu_limit (the tip limit) is not moved"
    );
    for (v, want_cu, want_loaded) in cases {
        let b = followed(v);
        let e = Engine::new(b, EngineParams::default());
        let row = e.budgets.get(tag::REVEAL);
        // The engine's send path: TxBudget from the row, price from the bid.
        let mut budget = tx::TxBudget {
            cu_limit: row.cu_limit,
            cu_price: 0,
            loaded_limit: row.loaded_limit,
            heap: None,
        };
        let reveal = fclient::Instruction {
            program_id: Address::new_from_array([0x5f; 32]),
            accounts: vec![
                fclient::AccountMeta::new(payer, true),
                fclient::AccountMeta::new(addr(2), false),
                fclient::AccountMeta::new(addr(3), false),
            ],
            data: vec![tag::REVEAL],
        };
        let shape = tx::shape(&tx::message(
            std::slice::from_ref(&reveal),
            &budget,
            &payer,
            &bh,
        ));
        let cost = fees::cost(
            budget.cu_limit,
            shape.sigs as u8,
            shape.writes as u8,
            budget.loaded_limit,
        );
        budget.cu_price = fees::cu_price_for(433, cost, budget.cu_limit);
        let msg = tx::message(std::slice::from_ref(&reveal), &budget, &payer, &bh);
        let parsed = tx::parse_budget(&msg);
        assert_eq!(parsed.effective_cu_limit(), want_cu, "version {v:#x}");
        assert_eq!(
            parsed.effective_loaded_limit(),
            want_loaded,
            "version {v:#x}"
        );
        // The wire's first instruction is SetComputeUnitLimit (relay order).
        let ix0 = &msg.instructions[0];
        let key = msg.account_keys[ix0.program_id_index as usize];
        assert_eq!(
            key,
            fclient::addr::compute_budget_program(),
            "version {v:#x}"
        );
        assert_eq!(ix0.data[0], 2, "SetComputeUnitLimit");
        assert_eq!(
            u32::from_le_bytes(ix0.data[1..5].try_into().unwrap()),
            want_cu
        );
        if want_cu == REVEAL_REQUEST_CU_S1 {
            assert!(want_cu > s1_limit, "version {v:#x}");
            assert!(
                WORST_REVEAL_CU < s1_limit && WORST_REVEAL_CU < want_cu,
                "version {v:#x}"
            );
            assert!(
                u64::from(WORST_REVEAL_CU) * 10 <= u64::from(want_cu) * 9,
                "version {v:#x}: < 10 % headroom over the worst Reveal"
            );
            assert_eq!(want_cu - WORST_REVEAL_CU, 4_177);
        }
    }
}

/// verify-pr280 §4 (D-verify-pr280-1): at p 433 the lane's first-of-bell
/// Reveal (1 signature, 3 write locks, 64 MiB loaded) costs 46,004 → 50,004
/// units and its priority fee rises 17,420 → 19,152 lamports: +1,732 (+9.9 %
/// of the priority fee), not the CU ratio's +14 %.
#[test]
fn lane_reveal_fee_rise_is_1732_lamports_at_p433() {
    let cost28 = fees::cost(28_000, 1, 3, RUNTIME_MAX_LOADED_LIMIT);
    let cost32 = fees::cost(REVEAL_REQUEST_CU_S1, 1, 3, RUNTIME_MAX_LOADED_LIMIT);
    assert_eq!((cost28, cost32), (46_004, 50_004));
    let (f28, f32) = (fees::fee_for(433, cost28), fees::fee_for(433, cost32));
    assert_eq!((f28, f32), (17_420, 19_152));
    assert_eq!(f32 - f28, 1_732);
    assert!((f32 - f28) * 1_000 / f28 < 100, "+9.9 %, under 10 %");
    // At the p_def cap (2,000 milli): +8,000.
    assert_eq!(
        fees::fee_for(2_000, cost32) - fees::fee_for(2_000, cost28),
        8_000
    );
    // The charged fee goes through the µlamport price and rounds up: never
    // under the bid's fee, and within one lamport per 10⁶/limit µlamport.
    for (cost, limit, f) in [(cost28, 28_000u32, f28), (cost32, 32_000, f32)] {
        let charged = fees::priority_fee(fees::cu_price_for(433, cost, limit), limit);
        assert!(charged >= f && charged <= f + 1, "{charged} vs {f}");
    }
}
