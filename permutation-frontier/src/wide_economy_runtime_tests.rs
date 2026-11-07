//! Key-free host harness of the **host-only wide economy** (0xDA op 3,
//! `wide-world-experimental`), a child of
//! `map_growth_runtime_tests::wide_land` so it shares that harness's
//! accounts, syscall stubs, clock, log capture and serial lock. Filter:
//! `map_growth_runtime_tests::wide_land::wide_economy::`.
//!
//! What it shows, through the program's real `dispatch` (economy actions
//! and refusals are direct dispatches with no rollback, so a "nothing
//! changed" assertion after a refusal is the handler's own guarantee, not
//! the executor's; the opt-in transit test uses `run_tx` only for its
//! successful return, via the parent's settlement helper):
//!
//! - Harvest, all nine Build items and several Train units executing for
//!   the Citizen's wallet, its Frontier session, and an NFT resident's
//!   current owner and session through the band's act (0xDD), the lazy
//!   provisional → final flip carried by the receipt;
//! - exactly one `PSW1` record per action (`WIDE_ECONOMY`, or
//!   `WIDE_ECONOMY_MIRROR` for walls and the tier-up), its receipt
//!   recomputed from the complete account bytes before and after, its links
//!   recomputed by the verifier's chain walk, the province byte-identical
//!   (chain included) for every non-mirror action, the Citizen changed in
//!   its bucket and owner-action stamp alone with its PS2 header untouched;
//! - every refusal before any write: the account shape and the signers,
//!   the wire, the prologue gates (version, status, end bell, bucket,
//!   session), the holding's and province's identity, the live state and
//!   the capture lock, the S1 economic refusals, a chain sequence
//!   overflow, and borrows held by someone else — each with every account's
//!   lamports, bytes and owner and the log collectors as they were.
//!
//! **Fixtures** (what the program did not do here): the Season, the rim
//! home and the wide province are the parent's ([`Wide::rim`],
//! [`Wide::land`], [`Wide::fixture_rim_home`]); the wide holding itself is
//! the program's own (WideClaimSite, WideSettleTicket, WideFinalize). Its
//! **stores** are set by [`stock`] — the founding credits an outpost no
//! starter kit, and the S1 production over a few bells buys nothing — as
//! the parent's `set_stores` does for the rim home. A session key is a
//! literal written into the Citizen or the resident record in the shape
//! the real programs write. Identity, status and chain fields are patched
//! and restored by the tests that show their refusals. **Runtime
//! guarantees** are everything asserted after a dispatch: the state the
//! handler left, the record it logged and what it refused to touch.
//!
//! **Cross-check fixtures.** [`wide_economy_exports_cross_check_fixtures_when_asked`]
//! writes, for five cases, the binary pre- and post-state and the record
//! into `$WYLLS_WIDE_ECONOMY_FIXTURES_DIR/<case>/` **only when that
//! variable is set**; without it the test runs and asserts the same
//! outcomes and writes nothing. The files are synthetic fixed-state
//! fixtures for an independent verifier, no secrets. No test executes an
//! external command or touches the network.

use super::*;
use frontier_abi::layout::header;
use frontier_abi::prologue::bell_at;
use frontier_abi::resident_auth::resident_account as RR;
use frontier_abi::v2::presets::PROGRAM_VERSION_S1;
use frontier_abi::world_index::economy::{self as weco, Action, EconomyReceipt, Snapshots};
use frontier_abi::world_index::event::WideTarget;
use frontier_abi::world_index::holding::wide_holding as WH;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::catalog;

use crate::layout::player::queue_item as QI;
use crate::proc::holding::{queue_kind, ITEM_TIER_UP};

/// A literal session key (a Frontier session or an NFT resident's).
const SESSION_KEY: [u8; 32] = [0x5e; 32];
/// Fixture stock, whole units per store (under the Hamlet cap of 2,000).
const STOCK: i64 = 1_900;
/// One day of bells.
const DAY: u32 = 144;
const HARVEST: Action = Action::Harvest;
const WALLS: Action = Action::Build {
    item: catalog::ITEM_WALLS,
};
const TIER_UP: Action = Action::Build { item: ITEM_TIER_UP };

// ------------------------------------------------------------ wire

/// The canonical envelope of `action` (0xDA op 3).
fn bytes(action: Action) -> Vec<u8> {
    wix::Economy { action }.to_bytes().unwrap().to_vec()
}

/// A raw 0xDA op 3 datum with the six action bytes given (for the forms
/// the canonical encoder refuses to produce).
fn raw(action6: [u8; 6]) -> Vec<u8> {
    let mut d = vec![
        wix::TAG_DEPART,
        wix::ENVELOPE_ESCAPE,
        wix::ENVELOPE_VERSION,
        wix::OP_ECONOMY,
    ];
    d.extend_from_slice(&action6);
    d
}

/// 0xDD WideResidentAct(generation, WideEconomy(action)).
fn act_bytes(generation: u32, action: Action) -> Vec<u8> {
    let inner = wix::Economy { action }.to_bytes().unwrap();
    let mut d = [0u8; 32];
    let n = wix::ResidentAct {
        generation,
        inner: &inner,
    }
    .encode_into(&mut d)
    .unwrap();
    d[..n].to_vec()
}

// ------------------------------------------------------------ accounts

/// The six accounts of 0xDA op 3 for `m`'s wide holding at `(coord,
/// site)`: `[actor s] [payer s,w] [season r] [citizen w] [holding w]
/// [province r|w]`.
fn accounts(
    w: &mut Wide,
    m: &Member,
    actor: [u8; 32],
    coord: WideCoord,
    site: u8,
    province_w: bool,
) -> Vec<AccountInfo<'static>> {
    vec![
        wallet(actor, true, false, 0),
        w.w.payer.clone(),
        w.w.season.clone(),
        m.citizen.clone(),
        w.holding(coord, site),
        with_writable(&w.province(coord), province_w),
    ]
}

/// **Fixture** (module doc): every store of the wide holding at `(coord,
/// site)` set to `units` whole units.
fn stock(w: &mut Wide, coord: WideCoord, site: u8, units: i64) {
    let ai = w.holding(coord, site);
    let mut hd = ai.try_borrow_mut_data().unwrap();
    for r in 0..RESOURCES {
        put(
            &mut hd,
            H::store(r) + AC::VALUE,
            &(units * MILLI).to_le_bytes(),
        );
    }
}

// ------------------------------------------------------------ executor

/// One direct dispatch (no rollback): the program code of a refusal,
/// `u32::MAX` for a non-program error (a borrow the handler could not
/// take).
fn exec(accounts: &[AccountInfo<'static>], data: &[u8]) -> Result<(), u32> {
    crate::dispatch(&Pubkey::new_from_array(PROGRAM), accounts, data).map_err(|e| {
        match ProgramError::from(e) {
            ProgramError::Custom(c) => c,
            _ => u32::MAX,
        }
    })
}

/// Every account's lamports, bytes and owner.
fn snapshot(accounts: &[AccountInfo<'static>]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    accounts
        .iter()
        .map(|a| {
            (
                a.lamports(),
                a.try_borrow_data().unwrap().to_vec(),
                *a.owner,
            )
        })
        .collect()
}

fn log_lens() -> (usize, usize) {
    (LOGS.lock().unwrap().len(), WIDE_LOGS.lock().unwrap().len())
}

/// Runs a refusal: the dispatch fails, every account is exactly as it was
/// and nothing was logged. Returns the code.
fn refused(accounts: &[AccountInfo<'static>], data: &[u8]) -> u32 {
    let before = snapshot(accounts);
    let logs = log_lens();
    let code = exec(accounts, data).expect_err("refused");
    assert_eq!(snapshot(accounts), before, "code {code}: a refusal wrote");
    assert_eq!(log_lens(), logs, "code {code}: a refusal logged");
    code
}

/// The four record images an action reads or leaves (positions 2–5 of any
/// 0xDA op 3 list, the act's included).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Images {
    season: Vec<u8>,
    citizen: Vec<u8>,
    holding: Vec<u8>,
    province: Vec<u8>,
}

fn images(a: &[AccountInfo<'static>]) -> Images {
    let d = |i: usize| a[i].try_borrow_data().unwrap().to_vec();
    Images {
        season: d(2),
        citizen: d(3),
        holding: d(4),
        province: d(5),
    }
}

/// One successful action: what it saw, what it left, the one record it
/// logged and the clock it ran at.
struct Done {
    pre: Images,
    post: Images,
    record: Vec<u8>,
    ts: i64,
}

/// Runs a success: the dispatch passes, exactly one `PSW1` record and no
/// PS2 record were logged.
fn succeeded(accounts: &[AccountInfo<'static>], data: &[u8]) -> Done {
    let pre = images(accounts);
    let ts = crate::prologue::now().unwrap().ts;
    let (n_logs, n_wide) = log_lens();
    assert_eq!(n_wide, 0, "the wide collector is drained before a success");
    if let Err(c) = exec(accounts, data) {
        panic!("refused with code {c}");
    }
    let post = images(accounts);
    let mut wr = wide_records();
    assert_eq!(wr.len(), 1, "exactly one PSW1 record");
    assert_eq!(log_lens().0, n_logs, "no PS2 record of a wide action");
    Done {
        pre,
        post,
        record: wr.remove(0),
        ts,
    }
}

/// The holding a run of receipts is checked against.
struct Target {
    href: WideHostRef,
    pkey: ProvinceKey,
    genesis: i64,
    holding: AccountInfo<'static>,
    province: AccountInfo<'static>,
    /// The chains when the trace started.
    h0: (u64, [u8; 32]),
    p0: (u64, [u8; 32]),
}

/// Checks one receipt against the images, the chains and the trace.
fn check_receipt(
    t: &Target,
    d: &Done,
    action: Action,
    became_final: bool,
    trace: &mut Vec<Vec<u8>>,
) {
    let r = WideRecord::decode(&d.record).unwrap();
    assert_eq!(r.kind, action.kind());
    assert_eq!(r.bell, bell_at(t.genesis, d.ts).unwrap());
    assert_eq!(r.key, &weco::economy_key(&t.href).unwrap()[..]);
    let want = EconomyReceipt {
        action,
        now_ts: d.ts,
        became_final,
        input_digest: weco::input_digest(
            &t.href,
            action,
            d.ts,
            &d.pre.season,
            &Snapshots {
                citizen: &d.pre.citizen,
                holding: &d.pre.holding,
                province: &d.pre.province,
            },
        )
        .unwrap(),
        output_digest: weco::output_digest(
            &t.href,
            action,
            d.ts,
            became_final,
            &Snapshots {
                citizen: &d.post.citizen,
                holding: &d.post.holding,
                province: &d.post.province,
            },
        )
        .unwrap(),
    };
    assert_eq!(
        r.receipt(),
        Some(want),
        "the receipt over the complete state"
    );
    assert_eq!(d.post.season, d.pre.season, "the Season is read only");
    // the chains: the holding always, the province for the mirror items
    let (s0, _) = crate::layout::chain_of(&d.pre.holding).unwrap();
    let lh = r.link(WideEntity::Holding).unwrap();
    assert_eq!(lh.seq, s0 + 1);
    assert_eq!(chain(&t.holding), (lh.seq, lh.head));
    if action.mirror_write() {
        let (p0, _) = crate::layout::chain_of(&d.pre.province).unwrap();
        let lp = r.link(WideEntity::Province).unwrap();
        assert_eq!(lp.seq, p0 + 1);
        assert_eq!(chain(&t.province), (lp.seq, lp.head));
    } else {
        assert_eq!(r.link(WideEntity::Province), None);
        assert_eq!(
            d.post.province, d.pre.province,
            "a non-mirror action leaves the province byte-identical, chain included"
        );
    }
    // the Citizen: the bucket and the owner-action stamp, nothing else
    let allowed = [
        (C::BUCKET_MILLI, 4),
        (C::BUCKET_T, 4),
        (C::LAST_ACTION_TS, 8),
    ];
    for (i, (a, b)) in d.pre.citizen.iter().zip(&d.post.citizen).enumerate() {
        if a != b {
            assert!(
                allowed.iter().any(|(o, n)| i >= *o && i < o + n),
                "citizen byte {i} changed"
            );
        }
    }
    assert_eq!(rd_i64(&d.post.citizen, C::LAST_ACTION_TS), d.ts);
    assert_eq!(
        d.post.citizen[..header::H_SIZE],
        d.pre.citizen[..header::H_SIZE],
        "the Citizen's PS2 chain is untouched"
    );
    // the holding: identity, ticket, rent and trailer as they were
    let (pre, post) = (&d.pre.holding, &d.post.holding);
    assert_eq!(post[WH::TRAILER..], pre[WH::TRAILER..], "the trailer");
    assert_eq!(
        post[H::P..=H::TILE],
        pre[H::P..=H::TILE],
        "the prefix identity"
    );
    assert_eq!(
        post[H::OWNER_CITIZEN..H::ORDER],
        pre[H::OWNER_CITIZEN..H::ORDER]
    );
    assert_eq!(post[H::ORDER], pre[H::ORDER]);
    assert_eq!(
        post[H::TICKET_BELL..H::TICKET_BELL + 4],
        pre[H::TICKET_BELL..H::TICKET_BELL + 4]
    );
    assert_eq!(
        post[H::ESCROW..H::POOL_OWED + 8],
        pre[H::ESCROW..H::POOL_OWED + 8]
    );
    assert_eq!(
        post[header::MAGIC..header::EVENT_SEQ],
        pre[header::MAGIC..header::EVENT_SEQ]
    );
    assert_eq!(rd_i64(post, H::LAST_OWNER_ACTION), d.ts, "the owner touch");
    assert_eq!(
        post[H::STATE] == H::STATE_FINAL && pre[H::STATE] == H::STATE_PROVISIONAL,
        became_final,
        "the flip is exactly what the receipt says"
    );
    // the verifier's chain walk over every receipt of this holding so far
    trace.push(d.record.clone());
    assert_eq!(
        wev::verify_chain(
            WideTarget::Holding(t.href),
            t.h0,
            trace.iter().map(|b| b.as_slice())
        ),
        Ok(chain(&t.holding))
    );
    assert_eq!(
        wev::verify_chain(
            WideTarget::Province(t.pkey),
            t.p0,
            trace.iter().map(|b| b.as_slice())
        ),
        Ok(chain(&t.province))
    );
}

/// The queue of a holding's bytes: `(kind, done_at)` of every used slot.
fn queued(hd: &[u8]) -> Vec<(u8, i64)> {
    (0..H::QUEUE_N)
        .filter_map(|i| {
            let o = H::queue(i);
            let kind = hd[o + QI::KIND];
            (kind != queue_kind::FREE).then(|| (kind, rd_i64(hd, o + QI::DONE_AT)))
        })
        .collect()
}

/// Patches an account's bytes, runs `f`, restores the bytes.
fn patched<T>(
    ai: &AccountInfo<'static>,
    patch: impl FnOnce(&mut [u8]),
    f: impl FnOnce() -> T,
) -> T {
    let saved = ai.try_borrow_data().unwrap().to_vec();
    patch(&mut ai.try_borrow_mut_data().unwrap());
    let r = f();
    ai.try_borrow_mut_data().unwrap().copy_from_slice(&saved);
    r
}

// ------------------------------------------------------------ fixture

/// Member A's wide holding at `(coord, site)`, founded by the program
/// (file at bell 1, settle at bell 1; final at bell 3 when asked), the
/// collectors drained.
struct Econ {
    w: Wide,
    coord: WideCoord,
    site: u8,
    a: Member,
    t: Target,
}

fn founded(finalize: bool) -> Econ {
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    let payer = w.w.payer.clone();
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer, None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    if finalize {
        at_bell(3);
        assert_eq!(code(w.finalize(coord, site)), Ok(()));
    }
    records();
    wide_records();
    let t = target(&mut w, coord, site);
    Econ {
        w,
        coord,
        site,
        a,
        t,
    }
}

fn target(w: &mut Wide, coord: WideCoord, site: u8) -> Target {
    let pkey = ProvinceKey::new(w.world_id(), coord);
    let holding = w.holding(coord, site);
    let province = w.province(coord);
    Target {
        href: WideHostRef::new(pkey, site, 1, 0).unwrap(),
        pkey,
        genesis: w.genesis(),
        h0: chain(&holding),
        p0: chain(&province),
        holding,
        province,
    }
}

impl Econ {
    fn list(&mut self, actor: [u8; 32], province_w: bool) -> Vec<AccountInfo<'static>> {
        accounts(
            &mut self.w,
            &self.a,
            actor,
            self.coord,
            self.site,
            province_w,
        )
    }

    fn stock(&mut self, units: i64) {
        stock(&mut self.w, self.coord, self.site, units);
    }

    /// A success by `actor` (the province writable exactly for a mirror
    /// item), its receipt checked.
    fn ok(
        &mut self,
        actor: [u8; 32],
        action: Action,
        became_final: bool,
        trace: &mut Vec<Vec<u8>>,
    ) -> Done {
        let a = self.list(actor, action.mirror_write());
        let d = succeeded(&a, &bytes(action));
        check_receipt(&self.t, &d, action, became_final, trace);
        d
    }

    /// A refusal by `actor`, nothing changed.
    fn no(&mut self, actor: [u8; 32], action: Action) -> u32 {
        let a = self.list(actor, action.mirror_write());
        refused(&a, &bytes(action))
    }

    fn holding_data(&mut self) -> Vec<u8> {
        self.w.holding_data(self.coord, self.site)
    }
}

// ------------------------------------------------------------------ tests

/// Harvest under the wallet on the program's provisional holding: before
/// `final_ts` the receipt carries no flip and the state stays provisional;
/// at bell 3 (past `final_ts`, the cohort settled) the same action flips
/// the holding lazily and the receipt says so; the next one does not. The
/// province position is accepted read-only and writable and stays
/// byte-identical either way.
#[test]
fn wide_economy_harvest_runs_under_the_wallet_and_flips_finality_lazily() {
    let _g = begin();
    let mut e = founded(false);
    let mut trace = Vec::new();
    let hd = e.holding_data();
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    let final_ts = rd_i64(&hd, H::FINAL_TS);
    assert!(final_ts > GENESIS + 600 && final_ts < GENESIS + 1_800);
    // one second before the flip is due
    crate::prologue::set_test_clock(final_ts - 1, 1_002);
    let d = e.ok(WALLET_A, HARVEST, false, &mut trace);
    assert_eq!(d.post.holding[H::STATE], H::STATE_PROVISIONAL);
    // the filing debited one action at bell 1; the bucket refilled to its
    // burst since, and this action debits one: the deployed bucket rule
    assert_eq!(
        rd_u32(&d.post.citizen, C::BUCKET_MILLI),
        19_000,
        "one action debited from a full bucket"
    );
    // bell 3: due, and the flip is the holding's state byte alone
    at_bell(3);
    let flags = e.w.w.citizen_data(&e.a)[C::FLAGS];
    let a = e.list(WALLET_A, true);
    let d = succeeded(&a, &bytes(HARVEST));
    check_receipt(&e.t, &d, HARVEST, true, &mut trace);
    assert_eq!(d.post.holding[H::STATE], H::STATE_FINAL);
    assert_eq!(d.post.citizen[C::FLAGS], flags, "no first-home flag");
    // final: no further flip
    at_bell(4);
    let d = e.ok(WALLET_A, HARVEST, false, &mut trace);
    assert_eq!(d.post.holding[H::STATE], H::STATE_FINAL);
    assert_eq!(trace.len(), 3);
}

/// Every Build item executes on the final, stocked holding a day apart:
/// the six buildings and the workshop chain the holding alone and leave the
/// province untouched; walls and the tier-up chain the province too and
/// write its site mirror (the wall item, the next tier). Each leaves
/// exactly one new item in the queue.
#[test]
fn wide_economy_builds_every_item_and_chains_the_province_only_for_the_mirror_items() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    let mut bell = 3;
    let so = PV::site(e.site as usize);
    for item in 0..=arms::ITEM_WORKSHOP {
        bell += DAY;
        let ts = at_bell(bell);
        e.stock(STOCK);
        let action = Action::Build { item };
        let mirror = item == catalog::ITEM_WALLS || item == ITEM_TIER_UP;
        assert_eq!(action.mirror_write(), mirror);
        let d = e.ok(WALLET_A, action, false, &mut trace);
        let kind = match item {
            catalog::ITEM_WALLS => queue_kind::WALLS,
            ITEM_TIER_UP => queue_kind::TIER_UP,
            _ => queue_kind::PRODUCTION,
        };
        let q = queued(&d.post.holding);
        assert_eq!(q.len(), 1, "item {item}: one queued item");
        assert_eq!(q[0].0, kind, "item {item}");
        assert!(q[0].1 > ts, "item {item}: completes later");
        let pd = &d.post.province;
        if item == catalog::ITEM_WALLS {
            assert_eq!(rd_u32(pd, so + SM::WALL_ITEM0_DELTA), catalog::WALL_STEP);
            assert!(rd_u32(pd, so + SM::WALL_ITEM0_BELL) > bell);
        }
        if item == ITEM_TIER_UP {
            assert_eq!(pd[so + SM2::TIER_NEXT], Tier::Town as u8);
            assert!(rd_u32(pd, so + SM2::TIER_NEXT_BELL) > bell);
        }
    }
    assert_eq!(
        e.holding_data()[H::TIER],
        Tier::Town as u8,
        "the tier-up settled"
    );
    assert_eq!(trace.len(), 9);
}

/// Train credits whole troops to the reserve at once for several units
/// (the strong unit paying arms); a unit the S1 tables do not price and a
/// zero count are refused on the wire (`BadData`) before any account is
/// read.
#[test]
fn wide_economy_trains_several_units_and_refuses_the_invalid_unit_and_zero() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    e.stock(STOCK);
    let cases: [(u8, u32, u32); 4] = [(0, 10, 10), (3, 100, 100), (6, 5, 5), (0, 1, 11)];
    for (i, (unit, n, reserve)) in cases.into_iter().enumerate() {
        at_bell(4 + i as u32);
        let action = Action::Train { unit, n };
        let d = e.ok(WALLET_A, action, false, &mut trace);
        assert_eq!(
            rd_u32(&d.post.holding, H::reserve(unit as usize)),
            reserve,
            "unit {unit}"
        );
        let arms_before = rd_i64(&d.pre.holding, H::store(arms::ARMS as usize) + AC::VALUE);
        let arms_after = rd_i64(&d.post.holding, H::store(arms::ARMS as usize) + AC::VALUE);
        assert_eq!(
            arms_after < arms_before,
            arms::TRAIN_ARMS_PER_100[unit as usize] > 0,
            "unit {unit}: arms paid exactly by the strong units"
        );
    }
    let a = e.list(WALLET_A, false);
    for (label, six) in [
        ("unit 7", [weco::TAG_TRAIN, 7, 1, 0, 0, 0]),
        ("n = 0", [weco::TAG_TRAIN, 0, 0, 0, 0, 0]),
        ("padding", [weco::TAG_HARVEST, 1, 0, 0, 0, 0]),
        ("item 9", [weco::TAG_BUILD, 9, 0, 0, 0, 0]),
        ("tag 3", [3, 0, 0, 0, 0, 0]),
    ] {
        assert_eq!(refused(&a, &raw(six)), E::BadData as u32, "{label}");
    }
    assert_eq!(
        refused(&a, &bytes(HARVEST)[..9]),
        E::BadData as u32,
        "short"
    );
}

/// The Citizen's Frontier session acts as the wallet does; an expired
/// session and a stranger are refused before any write.
#[test]
fn wide_economy_runs_for_the_wallet_session_and_refuses_an_expired_one() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    let ts = at_bell(4);
    {
        let mut cd = e.a.citizen.try_borrow_mut_data().unwrap();
        put(&mut cd, C::SESSION, &SESSION_KEY);
        put(&mut cd, C::SESSION_EXPIRY, &(ts + 3_600).to_le_bytes());
    }
    e.ok(SESSION_KEY, HARVEST, false, &mut trace);
    {
        let mut cd = e.a.citizen.try_borrow_mut_data().unwrap();
        put(&mut cd, C::SESSION_EXPIRY, &ts.to_le_bytes());
    }
    assert_eq!(e.no(SESSION_KEY, HARVEST), E::SessionExpired as u32);
    assert_eq!(e.no(WALLET_B, HARVEST), E::Auth as u32);
    e.ok(WALLET_A, HARVEST, false, &mut trace);
}

/// An NFT resident's Citizen through the band's act: the wallet form is
/// refused by address; a stale generation, another wallet and an
/// unguarded path are the deployed resident refusals; the current owner
/// and its live session act; after a transfer the previous holder is
/// refused at both generations and the new holder acts at the new one.
#[test]
fn wide_economy_nft_resident_acts_as_owner_and_session_through_the_band_act() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, _a, template) = w.land();
    let (_, nation) = off_wedge_province();
    let mut n = w.nft(nation, OWNER_A);
    w.fixture_rim_home(&n.m, &template, 3, 1_500 * MILLI);
    assert_eq!(
        code(w.act_file(&n, OWNER_A, 0, coord, site, 2, 3, None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&n.m, 0, coord, site, 1, None)), Ok(()));
    at_bell(3);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    records();
    wide_records();
    let t = target(&mut w, coord, site);
    stock(&mut w, coord, site, STOCK);
    let mut trace = Vec::new();
    let ts = at_bell(4);
    let act = |w: &mut Wide, n: &Nft, actor: [u8; 32], mirror: bool| {
        let mut a = accounts(w, &n.m, actor, coord, site, mirror);
        a.extend([
            n.policy.clone(),
            n.link.clone(),
            n.asset.clone(),
            n.resident.clone(),
        ]);
        a
    };
    // the wallet form: an NFT Citizen has no wallet address
    assert_eq!(
        refused(
            &accounts(&mut w, &n.m, OWNER_A, coord, site, false),
            &bytes(HARVEST)
        ),
        E::BadAddress as u32
    );
    assert_eq!(
        refused(&act(&mut w, &n, OWNER_A, false), &act_bytes(1, HARVEST)),
        CE::ResidentStaleGeneration.code()
    );
    assert_eq!(
        refused(&act(&mut w, &n, OWNER_B, false), &act_bytes(0, HARVEST)),
        CE::ResidentNotCurrentAuthority.code()
    );
    assert_eq!(
        refused(&act(&mut w, &n, OWNER_A, false), &act_bytes(0, WALLS)),
        E::BadAccount as u32,
        "a mirror item needs the province writable, under the act too"
    );
    // the owner at the current generation
    let d = succeeded(&act(&mut w, &n, OWNER_A, false), &act_bytes(0, HARVEST));
    check_receipt(&t, &d, HARVEST, false, &mut trace);
    // the owner's live session in this generation
    {
        let mut rd = n.resident.try_borrow_mut_data().unwrap();
        put(&mut rd, RR::SESSION, &SESSION_KEY);
        put(&mut rd, RR::SESSION_EXPIRY, &(ts + 3_600).to_le_bytes());
        put(&mut rd, RR::SESSION_GENERATION, &0u32.to_le_bytes());
        put(&mut rd, RR::SESSION_SETTER, &OWNER_A);
    }
    let build = Action::Build { item: 0 };
    let d = succeeded(&act(&mut w, &n, SESSION_KEY, false), &act_bytes(0, build));
    check_receipt(&t, &d, build, false, &mut trace);
    {
        let mut rd = n.resident.try_borrow_mut_data().unwrap();
        put(&mut rd, RR::SESSION_EXPIRY, &ts.to_le_bytes());
    }
    assert_eq!(
        refused(&act(&mut w, &n, SESSION_KEY, false), &act_bytes(0, HARVEST)),
        CE::ResidentNotCurrentAuthority.code(),
        "an expired resident session"
    );
    // the transfer: the holder follows the pass, the session is cleared
    n.transfer(&OWNER_B);
    assert_eq!(
        refused(&act(&mut w, &n, OWNER_A, false), &act_bytes(0, HARVEST)),
        CE::ResidentStaleGeneration.code()
    );
    assert_eq!(
        refused(&act(&mut w, &n, OWNER_A, false), &act_bytes(1, HARVEST)),
        CE::ResidentNotCurrentAuthority.code()
    );
    assert_eq!(
        refused(&act(&mut w, &n, SESSION_KEY, false), &act_bytes(1, HARVEST)),
        CE::ResidentNotCurrentAuthority.code()
    );
    at_bell(5);
    let train = Action::Train { unit: 0, n: 10 };
    let d = succeeded(&act(&mut w, &n, OWNER_B, true), &act_bytes(1, train));
    check_receipt(&t, &d, train, false, &mut trace);
    assert_eq!(rd_u32(&d.post.holding, H::reserve(0)), 10);
    assert_eq!(trace.len(), 3);
}

/// The account shape, the signers, the wire and the Season gates refuse
/// before any write: a missing or wrong signer, a wrong count, a wrong or
/// aliased position, a read-only province for a mirror item, a production
/// program version, a Season that is not Running.
#[test]
fn wide_economy_refuses_the_shape_the_signers_and_the_season_gates_before_any_write() {
    let _g = begin();
    let mut e = founded(true);
    at_bell(4);
    e.stock(STOCK);
    let base = e.list(WALLET_A, false);
    let other_site = (0..12u8).find(|s| *s != e.site).unwrap();
    let absent_holding = e.w.holding(e.coord, other_site);
    let rim = with_writable(&e.w.w.province(RIM), false);
    let swap = |a: &[AccountInfo<'static>], i: usize, x: AccountInfo<'static>| {
        let mut v = a.to_vec();
        v[i] = x;
        v
    };
    let cases: Vec<(&str, Vec<AccountInfo<'static>>, Vec<u8>, u32)> = vec![
        (
            "actor unsigned",
            swap(&base, 0, unsigned(&base[0])),
            bytes(HARVEST),
            E::Auth as u32,
        ),
        (
            "payer unsigned",
            swap(&base, 1, unsigned(&base[1])),
            bytes(HARVEST),
            E::Auth as u32,
        ),
        (
            "a stranger signs",
            swap(&base, 0, wallet(WALLET_B, true, false, 0)),
            bytes(HARVEST),
            E::Auth as u32,
        ),
        (
            "five accounts",
            base[..5].to_vec(),
            bytes(HARVEST),
            E::TooManyAccounts as u32,
        ),
        (
            "seven accounts",
            {
                let mut v = base.clone();
                v.push(e.w.w.system.clone());
                v
            },
            bytes(HARVEST),
            E::TooManyAccounts as u32,
        ),
        (
            "an absent holding",
            swap(&base, 4, absent_holding),
            bytes(HARVEST),
            E::BadAccount as u32,
        ),
        (
            "the Citizen as holding",
            swap(&base, 4, e.a.citizen.clone()),
            bytes(HARVEST),
            E::BadAccount as u32,
        ),
        (
            "the holding as province",
            swap(&base, 5, base[4].clone()),
            bytes(HARVEST),
            E::BadAddress as u32,
        ),
        (
            "the rim province",
            swap(&base, 5, rim),
            bytes(HARVEST),
            E::BadAddress as u32,
        ),
        (
            "walls over a read-only province",
            base.clone(),
            bytes(WALLS),
            E::BadAccount as u32,
        ),
        (
            "tier-up over a read-only province",
            base.clone(),
            bytes(TIER_UP),
            E::BadAccount as u32,
        ),
    ];
    for (label, a, d, want) in cases {
        assert_eq!(refused(&a, &d), want, "{label}");
    }
    // the Season gates
    e.w.set_program_version(PROGRAM_VERSION_S1);
    assert_eq!(
        e.no(WALLET_A, HARVEST),
        E::RulesetMismatch as u32,
        "a production version"
    );
    e.w.set_program_version(crate::PROGRAM_VERSION);
    e.w.set_status(S::STATUS_ENDED);
    assert_eq!(
        e.no(WALLET_A, HARVEST),
        E::WrongStatus as u32,
        "not Running"
    );
    e.w.set_status(S::STATUS_RUNNING);
    let season = e.w.w.season.clone();
    let bell = bell_at(e.t.genesis, crate::prologue::now().unwrap().ts).unwrap();
    assert_eq!(
        patched(
            &season,
            |sd| put(sd, S::END_BELL, &bell.to_le_bytes()),
            || e.no(WALLET_A, HARVEST)
        ),
        E::WrongStatus as u32,
        "the end bell"
    );
    let citizen = e.a.citizen.clone();
    let t = (crate::prologue::now().unwrap().ts - GENESIS) as u32;
    assert_eq!(
        patched(
            &citizen,
            |cd| {
                put(cd, C::BUCKET_MILLI, &0u32.to_le_bytes());
                put(cd, C::BUCKET_T, &t.to_le_bytes());
            },
            || e.no(WALLET_A, HARVEST)
        ),
        E::Bucket as u32,
        "an empty bucket"
    );
    assert!(wide_records().is_empty());
}

/// The holding's and the province's identity and state, each patched in
/// turn and restored: another season, another world, another owner, a slot
/// the Citizen does not bind wide, a prefix order off the slot, a
/// generation the mirror does not show, a released state, a foreign
/// program owner; the mirror's capture lock and a free mirror.
#[test]
fn wide_economy_refuses_a_holding_that_is_not_the_citizens_canonical_live_one() {
    let _g = begin();
    let mut e = founded(true);
    at_bell(4);
    e.stock(STOCK);
    let holding = e.t.holding.clone();
    let province = e.t.province.clone();
    let so = PV::site(e.site as usize);
    let holding_cases: Vec<(&str, Box<dyn Fn(&mut [u8])>, u32)> = vec![
        (
            "another season",
            Box::new(|d: &mut [u8]| put(d, header::SEASON_ID, &99u64.to_le_bytes())),
            E::BadAccount as u32,
        ),
        (
            "another world",
            Box::new(|d: &mut [u8]| d[WH::WORLD] ^= 1),
            E::BadAccount as u32,
        ),
        (
            "another owner",
            Box::new(|d: &mut [u8]| put(d, H::OWNER_CITIZEN, &WALLET_B)),
            E::NotOwner as u32,
        ),
        (
            "a slot the Citizen leaves empty",
            Box::new(|d: &mut [u8]| d[WH::SLOT] = 3),
            E::TicketState as u32,
        ),
        (
            "an order off the slot",
            Box::new(|d: &mut [u8]| d[H::ORDER] = 3),
            E::BadAccount as u32,
        ),
        (
            "a generation the mirror does not show",
            Box::new(|d: &mut [u8]| d[H::GEN] = 2),
            E::BadAccount as u32,
        ),
        (
            "released",
            Box::new(|d: &mut [u8]| d[H::STATE] = H::STATE_RELEASED),
            E::NotFinal as u32,
        ),
        (
            "empty",
            Box::new(|d: &mut [u8]| d[H::STATE] = H::STATE_NONE),
            E::NotFinal as u32,
        ),
    ];
    for (label, patch, want) in holding_cases {
        assert_eq!(
            patched(&holding, patch, || e.no(WALLET_A, HARVEST)),
            want,
            "{label}"
        );
    }
    let province_cases: Vec<(&str, Box<dyn Fn(&mut [u8])>, u32)> = vec![
        (
            "the capture lock",
            Box::new(move |d: &mut [u8]| d[so + SM::GEN] = 2),
            CE::CapturePending.code(),
        ),
        (
            "a free mirror",
            Box::new(move |d: &mut [u8]| d[so + SM::STATE] = SM::STATE_FREE),
            E::BadAccount as u32,
        ),
        (
            "another season",
            Box::new(|d: &mut [u8]| put(d, header::SEASON_ID, &99u64.to_le_bytes())),
            E::BadAccount as u32,
        ),
    ];
    for (label, patch, want) in province_cases {
        assert_eq!(
            patched(&province, patch, || e.no(WALLET_A, WALLS)),
            want,
            "{label}"
        );
    }
    // a foreign program owner on the holding
    assign(&holding, SYSTEM).unwrap();
    assert_eq!(
        e.no(WALLET_A, HARVEST),
        E::BadAccount as u32,
        "a System-owned holding"
    );
    assign(&holding, PROGRAM).unwrap();
    // and the state is intact: the action runs
    let mut trace = Vec::new();
    e.ok(WALLET_A, HARVEST, false, &mut trace);
}

/// The S1 economic refusals and the chain's sequence bound, each before
/// any write: insufficient stores, a second tier-up while one is pending,
/// a reserve that would overflow, a holding or province chain at its last
/// sequence (the province's bound binds a mirror item only: a Harvest
/// leaves a saturated province chain exactly as it is).
#[test]
fn wide_economy_refuses_the_s1_refusals_and_a_chain_overflow_before_any_write() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    at_bell(4);
    assert_eq!(
        e.no(WALLET_A, Action::Build { item: 0 }),
        E::Insufficient as u32,
        "an outpost is founded with no starter kit"
    );
    e.stock(STOCK);
    e.ok(WALLET_A, TIER_UP, false, &mut trace);
    at_bell(5);
    e.stock(STOCK);
    assert_eq!(
        e.no(WALLET_A, TIER_UP),
        E::QueueFull as u32,
        "one tier-up at a time"
    );
    let holding = e.t.holding.clone();
    let province = e.t.province.clone();
    assert_eq!(
        patched(
            &holding,
            |d| put(d, H::reserve(0), &u32::MAX.to_le_bytes()),
            || e.no(WALLET_A, Action::Train { unit: 0, n: 1 })
        ),
        E::Overflow as u32,
        "the reserve"
    );
    assert_eq!(
        patched(
            &holding,
            |d| put(d, header::EVENT_SEQ, &u64::MAX.to_le_bytes()),
            || e.no(WALLET_A, HARVEST)
        ),
        E::Overflow as u32,
        "the holding's chain"
    );
    let saved = province.try_borrow_data().unwrap().to_vec();
    put(
        &mut province.try_borrow_mut_data().unwrap(),
        header::EVENT_SEQ,
        &u64::MAX.to_le_bytes(),
    );
    assert_eq!(
        e.no(WALLET_A, WALLS),
        E::Overflow as u32,
        "the province's chain, a mirror item"
    );
    at_bell(6);
    let a = e.list(WALLET_A, true);
    let d = succeeded(&a, &bytes(HARVEST));
    assert_eq!(
        d.post.province, d.pre.province,
        "a Harvest never touches the province"
    );
    assert_eq!(
        crate::layout::chain_of(&d.post.province).unwrap().0,
        u64::MAX
    );
    province
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&saved);
}

/// Borrows someone else holds: a read borrow on the holding or a mutable
/// borrow on the Citizen make the handler's write phase fail, and nothing
/// is written and nothing logged; a read borrow on the province fails a
/// mirror item the same way and leaves a Harvest untouched, which never
/// borrows the province for writing.
#[test]
fn wide_economy_refuses_held_borrows_and_writes_nothing() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    at_bell(4);
    e.stock(STOCK);
    let holding = e.t.holding.clone();
    let province = e.t.province.clone();
    let citizen = e.a.citizen.clone();
    let a = e.list(WALLET_A, false);
    let aw = e.list(WALLET_A, true);
    let before = snapshot(&aw);
    let logs = log_lens();
    {
        let _r = holding.try_borrow_data().unwrap();
        assert_eq!(
            exec(&a, &bytes(HARVEST)),
            Err(u32::MAX),
            "a held read on the holding"
        );
    }
    {
        let _m = citizen.try_borrow_mut_data().unwrap();
        assert_eq!(
            exec(&a, &bytes(HARVEST)),
            Err(u32::MAX),
            "a held write on the Citizen"
        );
    }
    {
        let _r = province.try_borrow_data().unwrap();
        assert_eq!(
            exec(&aw, &bytes(WALLS)),
            Err(u32::MAX),
            "a held read on the province, walls"
        );
    }
    assert_eq!(snapshot(&aw), before, "nothing written");
    assert_eq!(log_lens(), logs, "nothing logged");
    {
        let _r = province.try_borrow_data().unwrap();
        let d = succeeded(&a, &bytes(HARVEST));
        check_receipt(&e.t, &d, HARVEST, false, &mut trace);
    }
}

/// The five cross-check cases (module doc): Harvest, a building, walls,
/// the tier-up and a Train, each a real dispatch logging exactly one
/// `PSW1` record; exported as binary pre/post images and the record only
/// under `WYLLS_WIDE_ECONOMY_FIXTURES_DIR`.
#[test]
fn wide_economy_exports_cross_check_fixtures_when_asked() {
    let _g = begin();
    let mut e = founded(true);
    let mut trace = Vec::new();
    let dir = std::env::var_os("WYLLS_WIDE_ECONOMY_FIXTURES_DIR").map(std::path::PathBuf::from);
    let cases: [(&str, Action); 5] = [
        ("harvest", HARVEST),
        ("building", Action::Build { item: 0 }),
        ("wall", WALLS),
        ("tier", TIER_UP),
        ("train", Action::Train { unit: 0, n: 10 }),
    ];
    let mut bell = 3;
    for (name, action) in cases {
        bell += DAY;
        at_bell(bell);
        e.stock(STOCK);
        let d = e.ok(WALLET_A, action, false, &mut trace);
        assert_eq!(WideRecord::decode(&d.record).unwrap().kind, action.kind());
        if let Some(dir) = &dir {
            let p = dir.join(name);
            std::fs::create_dir_all(&p).unwrap();
            let files: [(&str, &[u8]); 8] = [
                ("season.bin", &d.pre.season),
                ("citizen_pre.bin", &d.pre.citizen),
                ("holding_pre.bin", &d.pre.holding),
                ("province_pre.bin", &d.pre.province),
                ("citizen_post.bin", &d.post.citizen),
                ("holding_post.bin", &d.post.holding),
                ("province_post.bin", &d.post.province),
                ("record.bin", &d.record),
            ];
            for (f, b) in files {
                std::fs::write(p.join(f), b).unwrap();
            }
        }
    }
    assert_eq!(trace.len(), 5);
}

/// A mirror item stages the province chain first and the holding chain
/// second: a holding chain at its last sequence refuses walls with
/// `Overflow` after the province link was already staged, and the live
/// province chain (well below its bound) is exactly as it was, with every
/// other account byte and both log collectors.
#[test]
fn wide_economy_mirror_staging_refuses_late_holding_chain_overflow() {
    let _g = begin();
    let mut e = founded(true);
    at_bell(4);
    e.stock(STOCK);
    let (pseq, _) = chain(&e.t.province);
    assert!(
        pseq < u64::MAX,
        "the province chain has room: only the holding's is saturated"
    );
    let holding = e.t.holding.clone();
    // `e.no` snapshots every account (the province's staged-first chain
    // included) and both log lengths, and asserts them unchanged.
    assert_eq!(
        patched(
            &holding,
            |d| put(d, header::EVENT_SEQ, &u64::MAX.to_le_bytes()),
            || e.no(WALLET_A, WALLS)
        ),
        E::Overflow as u32,
        "the holding's chain, staged after the province's, a mirror item"
    );
}

/// A finality flip that is due but whose action fails: the lazy
/// provisional → final flip is carried only by a successful action, so an
/// `Insufficient` payment and a `QueueFull` build on a due holding leave
/// the state byte provisional, the Citizen's bucket and stamp, every account
/// byte and both collectors as they were. No successful finality action runs
/// first: this is the flip + payment / queue atomicity on its own.
#[test]
fn wide_economy_due_finality_refusals_leave_state_and_bucket_unchanged() {
    let _g = begin();
    let mut e = founded(false);
    // bell 3: the flip is due (the Harvest test above flips here)
    let now = at_bell(3);
    let hd = e.holding_data();
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    assert!(rd_i64(&hd, H::FINAL_TS) <= now, "the flip is due");
    let build = Action::Build { item: 0 };
    // no stock: the payment fails after the flip would have been staged
    assert_eq!(
        e.no(WALLET_A, build),
        E::Insufficient as u32,
        "an unpaid build on a due holding"
    );
    assert_eq!(
        e.holding_data()[H::STATE],
        H::STATE_PROVISIONAL,
        "no flip without a success"
    );
    e.stock(STOCK);
    // the tier's queue capacity (not always all four slots)
    let slots = crate::proc::holding::read_holding(&e.holding_data())
        .unwrap()
        .tier
        .queue_slots() as usize;
    assert!(slots > 0 && slots <= H::QUEUE_N, "tier capacity {slots}");
    let holding = e.t.holding.clone();
    // **Synthetic fixture**: exactly `slots` future production items that
    // never mature, filling this tier's capacity so the paid build finds the
    // queue full. Restored by `patched`.
    assert_eq!(
        patched(
            &holding,
            |d| {
                for i in 0..slots {
                    let o = H::queue(i);
                    d[o + QI::KIND] = queue_kind::PRODUCTION;
                    d[o + QI::ARG] = 0;
                    put(d, o + QI::DONE_AT, &(now + 3_600).to_le_bytes());
                    put(d, o + QI::DELTA, &MILLI.to_le_bytes());
                }
            },
            || e.no(WALLET_A, build)
        ),
        E::QueueFull as u32,
        "a paid build into a full queue on a due holding"
    );
    assert_eq!(
        e.holding_data()[H::STATE],
        H::STATE_PROVISIONAL,
        "still provisional after both refusals"
    );
}

/// One holding through an active march, Train and a reserve return. The
/// Q3 scene runs Reveal/Gather/Resolve but stages departures (the debit
/// gate is closed); stock and the home faction's full roster are explicit
/// fixtures. No key is generated and no signature is produced. Only the
/// successful settlement uses the parent's rollback-capable helper;
/// economic refusals and the settlement replay use direct dispatch.
#[cfg(all(
    feature = "native-crypto-tests",
    not(feature = "test-beacon"),
    not(target_os = "solana")
))]
#[test]
fn wide_economy_train_during_transit_preserves_escrow_and_returns_into_changed_reserve() {
    use frontier_abi::log::{seal_code, transit_outcome as TO};
    use frontier_abi::world_index::march::{MarchState, WideTransit};

    let _g = begin();
    let Q3Scene {
        mut w,
        a,
        coord,
        site,
        dest,
        key,
        dkey,
        arrive,
        fee,
        bond,
        tip,
        total,
        rent_t,
        payer,
        payer2,
        payer3,
        payer4,
        hosts,
        marches,
        ..
    } = native_q3_scene(0);
    let host = hosts[3]; // E: unrevealed, 401 troops, routed by the real record.
    let (slot, commit, seal) = marches[3];
    w.at(23, 60);

    // A full home faction makes the return credit the holding reserve.
    // These are resident fixtures, not a claim that eight arrivals ran.
    let tiles = w.free_tiles(coord, PV::FACTION_CAP, &[]);
    for (i, tile) in tiles.into_iter().enumerate() {
        let resident = WideHostRef::new(key, site, 1, 50 + i as u32).unwrap();
        w.stage_resident(coord, resident, a.faction, tile, 1_000);
    }
    stock(&mut w, coord, site, STOCK);
    let t = target(&mut w, coord, site);
    assert_eq!(host.holding_ref(), t.href);
    let home = w.province(coord);
    let destination = w.province(dest);
    let dest_start = chain(&destination);
    let transit = w.transit(coord, site, slot);
    let transit_before = snapshot(&[transit.clone()]);
    let march = WideTransit::from_bytes(&transit.try_borrow_data().unwrap()).unwrap();
    assert_eq!((march.state, march.host), (MarchState::Settled, host));
    assert_eq!(march.troops_after, 401_000);
    let hd0 = w.holding_data(coord, site);
    let holding0 = WideHolding::read(&hd0).unwrap();
    assert_eq!(march.host_identity, holding0.host_identity);
    assert_eq!(holding0.open_transits, 3);
    assert_eq!(Ro(&hd0).u64(H::ESCROW).unwrap(), total * 3);
    assert_eq!(Ro(&hd0).u64(H::POOL_OWED).unwrap(), 0);
    let reserve0 = rd_u32(&hd0, H::reserve(0));

    // Prepare precisely the helper's account order once, outside every
    // refusal snapshot; stage_seed itself is a fixture write.
    let region = WideProvince::read(&w.province_data(dest)).unwrap().region;
    let anchor = w.stage_seed(arrive, region, &BELL_SEED).1;
    let settle_accounts = vec![
        payer.clone(),
        w.w.season.clone(),
        t.holding.clone(),
        destination.clone(),
        w.inputs(dest, arrive),
        w.slot(dest, arrive, a.faction, 0),
        home.clone(),
        anchor,
        unsigned(&payer2),
        unsigned(&payer3),
        unsigned(&payer),
        unsigned(&payer4),
        transit.clone(),
        w.roster(coord),
        w.w.system.clone(),
        w.roster(dest),
        unsigned(&payer),
    ];
    let econ_accounts = accounts(&mut w, &a, WALLET_A, coord, site, false);
    let mut watched = settle_accounts.clone();
    watched.extend(econ_accounts.iter().cloned());
    let all_logs = || {
        (
            LOGS.lock().unwrap().clone(),
            WIDE_LOGS.lock().unwrap().clone(),
        )
    };
    let refuse_unchanged = |action_accounts: &[AccountInfo<'static>], data: &[u8], want| {
        let before = snapshot(&watched);
        let action_before = snapshot(action_accounts);
        let logs = all_logs();
        assert_eq!(exec(action_accounts, data), Err(want));
        assert_eq!(
            snapshot(&watched),
            before,
            "direct refusal wrote state or lamports"
        );
        assert_eq!(snapshot(action_accounts), action_before);
        assert_eq!(all_logs(), logs, "direct refusal changed log contents");
    };
    let train = Action::Train { unit: 0, n: 10 };
    let mut stranger = econ_accounts.clone();
    stranger[0] = wallet(WALLET_B, true, false, 0);
    refuse_unchanged(&stranger, &bytes(train), E::Auth as u32);
    // Real payment refusal, with no patched auth or resource gate.
    refuse_unchanged(
        &econ_accounts,
        &bytes(Action::Train {
            unit: 0,
            n: 1_000_000,
        }),
        E::Insufficient as u32,
    );

    let lamports0: Vec<_> = watched.iter().map(AccountInfo::lamports).collect();
    let mut trace = Vec::new();
    let d = succeeded(&econ_accounts, &bytes(train));
    check_receipt(&t, &d, train, false, &mut trace);
    assert_eq!(
        trace.len(),
        1,
        "retain the drained economy record for the combined trace"
    );
    assert_eq!(WideHolding::read(&d.post.holding).unwrap(), holding0);
    assert_eq!(
        rd_u32(&d.post.holding, H::HOST_SEQ),
        rd_u32(&hd0, H::HOST_SEQ)
    );
    assert_eq!(snapshot(&[transit.clone()]), transit_before);
    assert_eq!(rd_u32(&d.post.holding, H::reserve(0)), reserve0 + 10);
    assert_eq!(
        watched
            .iter()
            .map(AccountInfo::lamports)
            .collect::<Vec<_>>(),
        lamports0
    );

    // Settlement sees exactly the trained holding, not a reconstructed one.
    let balances = || {
        [
            payer.lamports(),
            payer2.lamports(),
            payer3.lamports(),
            payer4.lamports(),
            t.holding.lamports(),
            transit.lamports(),
        ]
    };
    let before = balances();
    let n_entries = w.province_data(coord)[PV::N_ENTRIES];
    assert_eq!(
        code(w.settle_transit_home(
            host,
            slot,
            dest,
            arrive,
            a.faction,
            0,
            commit,
            seal,
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            home.clone()
        )),
        Ok(())
    );
    let after = balances();
    assert_eq!(after[0] - before[0], bond + rent_t);
    assert_eq!(after[2] - before[2], fee);
    assert_eq!((after[1], after[3]), (before[1], before[3]));
    assert_eq!(before[4] - after[4], fee + bond);
    assert_eq!((before[5], after[5]), (rent_t, 0));
    assert_eq!(
        before.iter().sum::<u64>(),
        after.iter().sum::<u64>(),
        "lamports conserved"
    );
    let hd1 = w.holding_data(coord, site);
    let mut expected_holding = holding0;
    expected_holding.open_transits -= 1;
    assert_eq!(WideHolding::read(&hd1).unwrap(), expected_holding);
    assert_eq!(rd_u32(&hd1, H::HOST_SEQ), rd_u32(&hd0, H::HOST_SEQ));
    assert_eq!(Ro(&hd1).u64(H::ESCROW).unwrap(), total * 2);
    assert_eq!(Ro(&hd1).u64(H::POOL_OWED).unwrap(), tip);
    assert_eq!(
        rd_u32(&hd1, H::reserve(0)),
        reserve0 + 10 + 200,
        "200 whole survivors add to the trained reserve, not its old value"
    );
    assert_eq!(w.province_data(coord)[PV::N_ENTRIES], n_entries);
    assert!(absent(&transit));
    assert!(
        records().is_empty(),
        "no PS2 diversion when the tip stays owed here"
    );
    let returned = wide_records();
    assert_eq!(returned.len(), 2);
    let settled = WideRecord::decode(&returned[0]).unwrap();
    assert_eq!(
        (settled.kind, settled.host()),
        (WideKind::TransitSettled, Some(host))
    );
    assert_eq!(&settled.payload[..3], &[slot, TO::ROUTED, seal_code::VALID]);
    assert_eq!(&settled.payload[3..7], &200_500u32.to_le_bytes());
    assert_eq!(&settled.payload[7..15], &tip.to_le_bytes());
    assert_eq!(settled.payload[31], 1, "home credited");
    let returned_home = WideRecord::decode(&returned[1]).unwrap();
    assert_eq!(
        (
            returned_home.kind,
            returned_home.host(),
            returned_home.standing()
        ),
        (WideKind::Return, Some(host), Some(key))
    );
    assert_eq!(&returned_home.payload[..4], &200_000u32.to_le_bytes());
    assert_eq!(&returned_home.payload[4..6], &[0, wev::RETURN_TO_RESERVE]);
    trace.extend(returned);

    // Independently recompute each prev-head -> next-head with the ABI,
    // including both return links after the saved economy receipt.
    for (target, start, end) in [
        (WideTarget::Holding(t.href), t.h0, chain(&t.holding)),
        (WideTarget::Province(key), t.p0, chain(&home)),
        (WideTarget::Province(dkey), dest_start, chain(&destination)),
    ] {
        let entity = target.entity();
        let mut previous = start;
        for body in &trace {
            let record = WideRecord::decode(body).unwrap();
            if record.concerns(target) && record.kind.links().contains(&entity) {
                let next = wev::advance(entity, previous.0, &previous.1, record.body_without_tail)
                    .unwrap();
                assert_eq!(record.link(entity), Some(next));
                previous = (next.seq, next.head);
            }
        }
        assert_eq!(previous, end);
        assert_eq!(
            wev::verify_chain(target, start, trace.iter().map(Vec::as_slice)),
            Ok(end)
        );
    }
    assert_eq!(chain(&t.holding).0, t.h0.0 + 3);
    assert_eq!(chain(&home).0, t.p0.0 + 1);
    assert_eq!(chain(&destination).0, dest_start.0 + 1);

    let replay = wix::SettleTransit {
        transit_slot: slot,
        commit,
        seal,
        beneficiary: *payer4.key.as_array(),
    }
    .to_bytes();
    refuse_unchanged(&settle_accounts, &replay, E::TransitState as u32);
}
