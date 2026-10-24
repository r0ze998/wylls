//! S2 stage 2d: use tickets (`docs/frontier/stage2/S2-2D-CONTRACT.md`) on
//! the test-beacon build: UseRun — a holder converts the workshop's hours in
//! its own vault in the workshop's Province, within the lot's and the
//! workshop's runs of the day — its effects (`g13_s2_*` with the lands
//! paths) and refusals.
//!
//! Crafted state (`world::conquest`): the Season's conquest block,
//! Province / Citizen / Holding v2, the workshop's production, a vault's
//! stores and the clock. Every instruction itself goes through the program,
//! built by fclient's builders.

mod common;

use fclient::ix::v2::{self as fx, IssueArgs, TicketSource};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::layout::s1::vault as VA;
use frontier_abi::v2::layout::s2::lot as LT;
use frontier_abi::v2::log::{AnyKind, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{i64_at, u32_at, u64_at, Estate};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair};
use permutation_rules::frontier::arms;
use permutation_rules::frontier::ticket::{self as kt, KIND_USE, NO_END};
use permutation_rules::frontier::travel::BELLS_PER_DAY;

const B0: u32 = 20;
const MILLI: i64 = 1_000;
const WOOD: usize = 1;
const ORE: usize = 3;
const ARMS: usize = arms::ARMS as usize;

fn s2_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    let loaded = permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

#[track_caller]
fn event(l: &Landed, k: CqKind) -> fclient::conquest::CqEvent {
    let _ = records::one_cq(&l.logs, k);
    let body = records::bodies(&l.logs)
        .into_iter()
        .find(|b| frontier_abi::v2::log::decode(b).is_ok_and(|r| r.kind == AnyKind::Cq(k)))
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

/// A (faction 0) owns site 0, a workshop of one copy, and issues a use
/// ticket of it; R (faction 1) owns site 1 of the same ring-4 Province.
/// Both have a vault there.
struct Cast {
    c: Chain,
    w: World,
    a: Estate,
    r: Estate,
    /// A's and R's vault tiles.
    vt: (u8, u8),
}

impl Cast {
    fn new() -> Cast {
        let mut c = Chain::new(Build::TestBeacon);
        let w = World::running(&mut c, 1);
        w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
        w.to_bell(&mut c, B0, 5);
        let t = provinces_of(4, Some(0))[0];
        let a = w.cq_estate(&mut c, "a", 0, t, 0);
        let r = w.cq_estate(&mut c, "r", 1, t, 1);
        w.open_tiles(&mut c, t.0, t.1, &(0..61).collect::<Vec<u8>>());
        w.enrich(&mut c, &a, 5_000);
        w.enrich(&mut c, &r, 5_000);
        let mut k = Cast {
            c,
            w,
            a,
            r,
            vt: (0, 0),
        };
        let pd = k.c.data(&k.a.province);
        let sites = pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize].to_vec();
        let build = |k: &mut Cast, e: &Estate, skip: Option<u8>| {
            (0..61u8)
                .filter(|t| !sites.contains(t) && Some(*t) != skip)
                .find(|&t| {
                    let ix = fx::build_vault(&k.w.a, &e.player(), e.href(), (e.p, e.q), t);
                    s2_send(&mut k.c, I2::BuildVault, ix, &[&e.wallet]).is_ok()
                })
                .expect("a vault tile")
        };
        let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
        k.vt.0 = build(&mut k, &a, None);
        let skip = Some(k.vt.0);
        k.vt.1 = build(&mut k, &r, skip);
        k.w.edit_kholding(&mut k.c, &a, |h| {
            h.production[ARMS] = arms::WORKSHOP_DELTA
        });
        // 3 units of 2 runs a day.
        let ix = fx::issue_tickets(
            &k.w.a,
            &a.player(),
            a.href(),
            TicketSource::Holding(a.href()),
            a.citizen_tag(),
            0,
            0,
            &IssueArgs {
                kind: KIND_USE,
                resource: 0,
                amount: 3,
                per_unit: 2,
                until_day: NO_END,
            },
        );
        expect_lands(
            s2_send(&mut k.c, I2::IssueTickets, ix, &[&a.wallet]),
            "IssueTickets",
        );
        k
    }

    fn vault_of(&self, e: &Estate) -> (Address, u8) {
        let t = if e.citizen == self.a.citizen {
            self.vt.0
        } else {
            self.vt.1
        };
        (self.w.a.vault(e.p as i32, e.q as i32, t), t)
    }

    fn set_store(&mut self, e: &Estate, r: usize, milli: i64) {
        let (v, _) = self.vault_of(e);
        self.c.edit(&v, |d| {
            d[VA::store(r)..VA::store(r) + 8].copy_from_slice(&milli.to_le_bytes())
        });
    }

    fn store(&self, e: &Estate, r: usize) -> i64 {
        i64_at(&self.c.data(&self.vault_of(e).0), VA::store(r))
    }

    fn lot(&self, seq: u32) -> Address {
        self.w.a.lot(self.a.citizen_tag(), seq)
    }

    fn run(&mut self, e: &Estate, lot: Address, runs: u8) -> SendResult {
        let (_, t) = self.vault_of(e);
        let ix = fx::use_run(
            &self.w.a,
            &e.player(),
            lot,
            (self.a.citizen_tag(), 0),
            self.a.href(),
            (e.p, e.q, t),
            runs,
        );
        s2_send(&mut self.c, I2::UseRun, ix, &[&e.wallet])
    }

    fn holding_runs(&self) -> (u16, u16) {
        let d = self.c.data(&self.a.holding);
        let u16_at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
        (u16_at(H::USE_DAY), u16_at(H::USE_RUNS))
    }

    fn today(&self) -> u32 {
        self.w.bell(&self.c) / BELLS_PER_DAY
    }
}

fn stock(k: &mut Cast, e: &Estate) {
    k.set_store(e, ORE, 200 * MILLI);
    k.set_store(e, WOOD, 200 * MILLI);
    k.set_store(e, ARMS, 0);
}

fn next_day(k: &mut Cast) {
    let day = k.w.bell(&k.c) / BELLS_PER_DAY + 1;
    k.w.to_bell(&mut k.c, day * BELLS_PER_DAY + 2, 5);
}

#[test]
fn g13_s2_use_runs_convert_in_the_holders_vault() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let (la, lr) = (k.lot(0), k.lot(1));
    // A gives 2 units (4 runs a day) to R.
    let ix = fx::give_lot(
        &k.w.a,
        &a.player(),
        la,
        (a.citizen_tag(), 0),
        TicketSource::Holding(a.href()),
        r.citizen,
        lr,
        2,
    );
    expect_lands(s2_send(&mut k.c, I2::GiveLot, ix, &[&a.wallet]), "GiveLot");
    stock(&mut k, &r);
    stock(&mut k, &a);
    // R runs 3 hours in its own vault: 24 ore + 12 wood → 12 arms.
    let l = expect_lands(k.run(&r, lr, 3), "UseRun");
    let (ore, wood, made) = kt::run_change(3);
    assert_eq!((ore, wood, made), (24 * MILLI, 12 * MILLI, 12 * MILLI));
    assert_eq!(
        (k.store(&r, ORE), k.store(&r, WOOD), k.store(&r, ARMS)),
        (200 * MILLI - ore, 200 * MILLI - wood, made)
    );
    let today = k.today();
    assert_eq!(
        (u32_at(&k.c.data(&lr), LT::DAY), u64_at(&k.c.data(&lr), LT::DAY_AMOUNT)),
        (today + 1, 3)
    );
    assert_eq!(k.holding_runs(), (today as u16 + 1, 3));
    match event(&l, CqKind::USE_RUN) {
        fclient::conquest::CqEvent::UseRun {
            day,
            runs,
            lot_runs,
            holding_runs,
            src,
            ..
        } => {
            assert_eq!((day, runs, lot_runs, holding_runs), (today, 3, 3, 3));
            assert_eq!((src.kind, src.at), (2, k.vt.1));
        }
        e => panic!("{e:?}"),
    }
    // The lot's 4 runs of the day: one more lands, a second does not.
    expect_lands(k.run(&r, lr, 1), "UseRun");
    assert_cq(k.run(&r, lr, 1), Cq::UseLimit);
    // A's own lot (1 unit, 2 runs) in A's vault; the owner's production is
    // untouched.
    let production = i64_at(&k.c.data(&a.holding), H::PRODUCTION + 8 * ARMS);
    expect_lands(k.run(&a, la, 2), "UseRun");
    assert_eq!(k.holding_runs().1, 6);
    assert_eq!(
        i64_at(&k.c.data(&a.holding), H::PRODUCTION + 8 * ARMS),
        production
    );
    // A's used unit given to R carries its 2 used runs: R's lot of 3 units
    // has used all 6 of the day.
    let ix = fx::give_lot(
        &k.w.a,
        &a.player(),
        la,
        (a.citizen_tag(), 0),
        TicketSource::Holding(a.href()),
        r.citizen,
        lr,
        1,
    );
    expect_lands(s2_send(&mut k.c, I2::GiveLot, ix, &[&a.wallet]), "GiveLot");
    assert_eq!(
        (u64_at(&k.c.data(&lr), LT::AMOUNT), u64_at(&k.c.data(&lr), LT::DAY_AMOUNT)),
        (3, 6)
    );
    assert_cq(k.run(&r, lr, 1), Cq::UseLimit);
    // A new day: the runs come back.
    next_day(&mut k);
    expect_lands(k.run(&r, lr, 6), "UseRun");
    assert_eq!(k.holding_runs(), (k.today() as u16 + 1, 6));
}

#[test]
fn g13_s2_use_run_refusals() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let la = k.lot(0);
    stock(&mut k, &a);
    // No runs, or more than the lot's 6.
    assert_code(k.run(&a, la, 0), E::BadData);
    assert_cq(k.run(&a, la, 7), Cq::UseLimit);
    // The workshop's 24 runs of the day across all its tickets.
    let today1 = (k.today() + 1) as u16;
    let h = a.holding;
    k.c.edit(&h, |d| {
        d[H::USE_DAY..H::USE_DAY + 2].copy_from_slice(&today1.to_le_bytes());
        d[H::USE_RUNS..H::USE_RUNS + 2].copy_from_slice(&23u16.to_le_bytes());
    });
    assert_cq(k.run(&a, la, 2), Cq::UseLimit);
    expect_lands(k.run(&a, la, 1), "UseRun (the 24th)");
    next_day(&mut k);
    // The materials, then the arms cap.
    k.set_store(&a, ORE, 7 * MILLI);
    assert_code(k.run(&a, la, 1), E::Insufficient);
    stock(&mut k, &a);
    let cap = i64_at(&k.c.data(&k.vault_of(&a).0), VA::CAP);
    k.set_store(&a, ARMS, cap - MILLI);
    assert_code(k.run(&a, la, 1), E::BadData);
    k.set_store(&a, ARMS, 0);
    // Another's vault.
    let (_, rt) = k.vault_of(&r);
    let ix = fx::use_run(
        &k.w.a,
        &a.player(),
        la,
        (a.citizen_tag(), 0),
        a.href(),
        (r.p, r.q, rt),
        1,
    );
    assert_code(s2_send(&mut k.c, I2::UseRun, ix, &[&a.wallet]), E::NotOwner);
    // A workshop gone: no runs.
    k.w.edit_kholding(&mut k.c, &a, |h| h.production[ARMS] = 0);
    assert_cq(k.run(&a, la, 1), Cq::UseLimit);
}

fn clone_estate(e: &Estate) -> Estate {
    Estate {
        wallet: e.wallet.insecure_clone(),
        ..*e
    }
}
