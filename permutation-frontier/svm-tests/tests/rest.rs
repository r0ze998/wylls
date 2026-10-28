//! FastForward (S1 map growth, `docs/frontier/map-growth/
//! keeper-load-rules.ja.md` §2.4): a resting Province advanced in closed
//! form (`frontier_abi::rest_model`) on the chain's evidence — the
//! Province's ArrivalDays and THE anchors of its region or their archives.
//!
//! Crafted accounts (`world::conquest::cq_province`, `world::holding`
//! `craft_anchor`, `craft_day`, `world::craft_archive`): a v2 Province
//! with a keep held by one faction and nobody on it, THE anchors as
//! PostAnchor leaves them, ArrivalDays as Reveal leaves them, archives as
//! ArchiveAnchors leaves them (entries empty: `a_off = 0`). Every test
//! that relies on one says so.

mod common;

use fclient::ix::v2 as fx;
use fclient::ix::AnchorSource;
use frontier_abi::conquest_model as cm;
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P};
use frontier_abi::v2::log::CqKind;
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Build, Chain};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::holding::u32_at;
use permutation_frontier_svm_tests::world::{archive_part, day_of, World};
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Signer};

/// The Province (ring 2, region of its own).
const DEST: (i32, i32) = (2, 1);
/// The bell the Province is resolved to when crafted (day 0, part 1).
const B0: u32 = 130;
/// The keep's holder.
const HOLDER: u8 = 2;

/// A running season, the Clock in bell `B0`, the Province crafted resolved
/// to `B0` with a calm keep of `HOLDER` (no contender, nobody on it).
fn world() -> (Chain, World, Address) {
    let mut c = Chain::new(Build::TestBeacon);
    let w = World::running(&mut c, 1);
    w.to_bell(&mut c, B0, 1);
    let k = w.cq_province(&mut c, DEST.0 as i16, DEST.1 as i16);
    c.edit(&k, |d| {
        d[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&B0.to_le_bytes());
        d[P::SCORE_NEXT_BELL..P::SCORE_NEXT_BELL + 4].copy_from_slice(&B0.to_le_bytes());
        let sites = &d[P::SITES..P::SITES + d[P::SITE_COUNT] as usize].to_vec();
        let tile = (0..61u8).find(|t| !sites.contains(t)).expect("a free tile");
        let keep = frontier_abi::v2::kernel::keep::Keep {
            tile,
            holder: HOLDER,
            contender: KP::NONE,
            progress: 0,
            required: 72,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: 50,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: KP::NONE,
        };
        cm::write_keep(d, &keep).expect("keep");
    });
    (c, w, k)
}

fn region() -> u8 {
    World::region(DEST.0, DEST.1)
}

/// THE anchors of `from..to` (crafted as PostAnchor leaves them, `A` just
/// after the bell) and the Clock past the last reveal close.
fn anchors(c: &mut Chain, w: &World, from: u32, to: u32) {
    for b in from..to {
        if w.anchor_a(c, b, region()).is_none() {
            w.craft_anchor(c, b, region(), w.bell_end(b) + 1, c.slot);
        }
    }
    past_closes(c, w, from, to);
}

/// The Clock past every reveal close of `from..to` (archived or not).
fn past_closes(c: &mut Chain, w: &World, from: u32, to: u32) {
    let close = (from..to)
        .map(|b| w.bell_end(b) + 1 + w.window(c, b) as i64)
        .max()
        .unwrap_or(0);
    if c.now <= close {
        c.set_time(close + 1);
    }
}

fn ff(w: &World, from: u32, to: u32, src: &[AnchorSource]) -> Instruction {
    fx::fast_forward(&w.a, w.keeper.pubkey(), DEST, from, to, src)
}

fn all_anchors(n: u32) -> Vec<AnchorSource> {
    vec![AnchorSource::Anchor; n as usize]
}

fn resolved_next(c: &Chain, k: &Address) -> u32 {
    u32_at(&c.data(k), P::RESOLVED_NEXT)
}

/// The Province's game state: every byte but the event header, the last
/// digest, the resolve summary and the quiet cache (G11's comparison in
/// `tests/clash.rs`).
fn state_bytes(c: &Chain, k: &Address) -> Vec<u8> {
    let d = c.data(k);
    let mut v = d[64..P::LAST_DIGEST].to_vec();
    v.extend_from_slice(&d[P::LAST_DIGEST + 32..P::QUIET_OK]);
    v.extend_from_slice(&d[P::QUIET_OK + 1..P::RESOLVE_SUMMARY]);
    v.extend_from_slice(&d[P::RESOLVE_SUMMARY + 32..]);
    v
}

fn territory(c: &Chain, k: &Address, f: u8) -> u64 {
    let d = c.data(k);
    let o = P::TERRITORY_BELLS + 8 * f as usize;
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

/// SkipQuiet in 24-bell runs from `from` to `to` (the keeper's way).
fn skip_to(c: &mut Chain, w: &World, from: u32, to: u32) -> u64 {
    let mut cu = 0;
    let mut b = from;
    while b < to {
        let n = (to - b).min(24) as u8;
        let l = expect_lands(c.send(&[w.skip_ix(DEST, b, n)], &[&w.keeper]), "SkipQuiet");
        cu += l.cu;
        b += n as u32;
    }
    cu
}

/// Bells of an anchors-only run: two ArrivalDays and 24 anchors fit the 28
/// evidence accounts, and `B0..B0 + 24` crosses day 1 (the camp's check).
const RUN: u32 = 24;

/// G11 for the rest: FastForward over a run crossing day 1 (so the camp's
/// daily check runs) leaves the Province's game state SkipQuiet's run
/// leaves, gives the keep's holder one territory bell per bell, and logs
/// one REST whose fields and tail match.
#[test]
fn g11_fast_forward_equals_skipping_every_bell() {
    let (mut c, w, k) = world();
    let to = B0 + RUN;
    anchors(&mut c, &w, B0, to);
    let before = territory(&c, &k, HOLDER);
    let mut a = c.fork();
    let mut b = c.fork();
    let l = expect_lands(
        a.send(&[ff(&w, B0, to, &all_anchors(RUN))], &[&w.keeper]),
        "FastForward",
    );
    let skip_cu = skip_to(&mut b, &w, B0, to);
    assert_eq!(resolved_next(&a, &k), to);
    assert_eq!(resolved_next(&b, &k), to);
    assert_eq!(
        state_bytes(&a, &k),
        state_bytes(&b, &k),
        "FastForward leaves what SkipQuiet leaves"
    );
    assert_eq!(territory(&a, &k, HOLDER), before + RUN as u64);
    let rest = records::one_cq(&l.logs, CqKind::REST);
    records::check_any_tail(&rest);
    assert_eq!(&rest.key[8..12], &B0.to_le_bytes());
    assert_eq!(&rest.payload[0..4], &to.to_le_bytes());
    assert_eq!(rest.payload[4], HOLDER);
    assert_eq!(&rest.payload[5..9], &RUN.to_le_bytes());
    let digest = frontier_abi::rest_model::rest_digest(&a.data(&k), B0, to).unwrap();
    assert_eq!(&rest.payload[10..42], &digest);
    println!(
        "FastForward {RUN} bells: {} CU, {} B; SkipQuiet: {skip_cu} CU",
        l.cu, l.tx_bytes
    );
}

/// Archived bells prove their windows through their half day's archive
/// (one account for up to 72 bells), the rest through THE anchors; the
/// result is the anchors-only one.
#[test]
fn fast_forward_proves_with_archives_and_anchors() {
    let (mut c, w, k) = world();
    let to = B0 + RUN;
    // bells 130..143 archived (part 1), 144..153 still anchored
    let part = archive_part(B0);
    let archived: Vec<u32> = (B0..(part + 1) * 72).collect();
    w.craft_archive(&mut c, region(), part, &archived);
    anchors(&mut c, &w, (part + 1) * 72, to);
    past_closes(&mut c, &w, B0, to);
    let mut plain = c.fork();
    anchors(&mut plain, &w, B0, to);
    let src: Vec<AnchorSource> = (B0..to)
        .map(|b| {
            if archive_part(b) == part {
                AnchorSource::Archive
            } else {
                AnchorSource::Anchor
            }
        })
        .collect();
    let ix = ff(&w, B0, to, &src);
    // payer, season, Province; two ArrivalDays; one archive; the anchors
    assert_eq!(
        ix.accounts.len(),
        3 + 2 + 1 + (to - (part + 1) * 72) as usize
    );
    expect_lands(c.send(&[ix], &[&w.keeper]), "FastForward");
    expect_lands(
        plain.send(&[ff(&w, B0, to, &all_anchors(RUN))], &[&w.keeper]),
        "FastForward",
    );
    assert_eq!(resolved_next(&c, &k), to);
    assert_eq!(state_bytes(&c, &k), state_bytes(&plain, &k));
}

/// The proof ends where the chain says something may happen, and the
/// refusals: an arrival bit (the rest stops before it; at the first bell,
/// `NotQuiet`), a window still open, evidence that ends early, a
/// Province that does not rest (a siege), `to ≤ resolved_next`
/// (`AlreadyDone`), no ArrivalDay (`BadData`), an absent or another
/// region's anchor (`BadAccount`), an ArrivalDay of another day
/// (`BadAddress`).
#[test]
fn fast_forward_stops_at_the_evidence_and_refuses() {
    let (mut c, w, k) = world();
    let to = B0 + RUN;
    anchors(&mut c, &w, B0, to);
    let send = |c: &mut Chain, ix: Instruction| c.send(&[ix], &[&w.keeper]);

    // an arrival at B0 + 20 (day 1): bells B0..B0 + 20 rest
    let mut x = c.fork();
    w.craft_day(&mut x, DEST, day_of(B0 + 20), &[B0 + 20]);
    expect_lands(
        send(&mut x, ff(&w, B0, to, &all_anchors(RUN))),
        "FastForward",
    );
    assert_eq!(resolved_next(&x, &k), B0 + 20);
    // ... and at the first bell: nothing to prove
    let mut x = c.fork();
    w.craft_day(&mut x, DEST, day_of(B0), &[B0]);
    assert_code(send(&mut x, ff(&w, B0, to, &all_anchors(RUN))), E::NotQuiet);

    // the window of B0 + 7 closes later than the Clock: the rest stops there
    let mut x = c.fork();
    let (far, slot) = (x.now + 100_000, x.slot);
    w.craft_anchor(&mut x, B0 + 7, region(), far, slot);
    expect_lands(
        send(&mut x, ff(&w, B0, to, &all_anchors(RUN))),
        "FastForward",
    );
    assert_eq!(resolved_next(&x, &k), B0 + 7);

    // evidence for 5 bells only
    let mut x = c.fork();
    expect_lands(send(&mut x, ff(&w, B0, to, &all_anchors(5))), "FastForward");
    assert_eq!(resolved_next(&x, &k), B0 + 5);

    // a siege record: the Province does not rest
    let mut x = c.fork();
    x.edit(&k, |d| {
        cm::Record {
            kind: CR::KIND_SIEGE,
            ..cm::Record::ZERO
        }
        .write(d, 0)
        .unwrap()
    });
    assert_code(send(&mut x, ff(&w, B0, to, &all_anchors(RUN))), E::NotQuiet);

    // `to` not past resolved_next: done already (a second copy of a
    // FastForward that landed, as a keeper's re-send finds it)
    let mut bad = ff(&w, B0, to, &all_anchors(RUN));
    bad.data = frontier_abi::v2::ix::FastForward { to: B0, days: 2 }
        .to_bytes()
        .to_vec();
    assert_code(send(&mut c.fork(), bad), E::AlreadyDone);
    let mut x = c.fork();
    expect_lands(
        send(&mut x, ff(&w, B0, to, &all_anchors(RUN))),
        "FastForward",
    );
    let again = ff(&w, B0, to, &all_anchors(RUN - 1));
    assert_code(send(&mut x, again), E::AlreadyDone);
    assert_eq!(resolved_next(&x, &k), to);
    // no ArrivalDay
    let mut bad = ff(&w, B0, to, &all_anchors(RUN));
    bad.data = frontier_abi::v2::ix::FastForward { to, days: 0 }
        .to_bytes()
        .to_vec();
    assert_code(send(&mut c.fork(), bad), E::BadData);

    // an absent anchor in the list
    let mut x = c.fork();
    x.remove(&w.a.anchor(B0 + 3, region()));
    assert_code(
        send(&mut x, ff(&w, B0, to, &all_anchors(RUN))),
        E::BadAccount,
    );

    // another region's anchor in THE anchor's place
    let mut x = c.fork();
    let other = (region() + 1) % 7;
    let slot = x.slot;
    let forged = w.craft_anchor(&mut x, B0, other, w.bell_end(B0) + 1, slot);
    let mut ix = ff(&w, B0, to, &all_anchors(RUN));
    let at = ix
        .accounts
        .iter()
        .position(|m| m.pubkey == w.a.anchor(B0, region()))
        .unwrap();
    ix.accounts[at].pubkey = forged;
    assert_code(send(&mut x, ix), E::BadAccount);

    // the second ArrivalDay replaced by the first's day + 5
    let mut ix = ff(&w, B0, to, &all_anchors(RUN));
    ix.accounts[4].pubkey = w.a.arrival_day(DEST.0, DEST.1, day_of(B0) + 5);
    assert_code(send(&mut c.fork(), ix), E::BadAddress);
}

/// G1 for the rest: a day of bells through two archives, and three days
/// through six (the camp's daily checks included), within the budget row;
/// nothing else in the Province changes their cost.
#[test]
fn g01_fast_forward_budget() {
    let row = frontier_abi::v2::budgets::budget(frontier_abi::v2::Ix::FastForward).cu_limit as u64;
    for days in [1u32, 3] {
        let (mut c, w, k) = world();
        let to = (day_of(B0) + days) * 144 + B0 % 144;
        for part in archive_part(B0)..=archive_part(to - 1) {
            let bells: Vec<u32> = (part * 72..(part + 1) * 72).collect();
            w.craft_archive(&mut c, region(), part, &bells);
        }
        past_closes(&mut c, &w, B0, to);
        let src = vec![AnchorSource::Archive; (to - B0) as usize];
        let l = expect_lands(c.send(&[ff(&w, B0, to, &src)], &[&w.keeper]), "FastForward");
        assert_eq!(resolved_next(&c, &k), to);
        println!(
            "FastForward {} bells ({days} days): {} CU (row {row}), {} B",
            to - B0,
            l.cu,
            l.tx_bytes
        );
        assert!(l.cu <= row, "{} CU over the row {row}", l.cu);
    }
}
