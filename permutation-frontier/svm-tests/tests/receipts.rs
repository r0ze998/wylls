//! S2 stage 2c: receipt tickets (`docs/frontier/stage2/S2-2C-CONTRACT.md`)
//! on the test-beacon build: ClaimReceipt and WithdrawReceipt — the daily
//! pro-rata at the day boundary, the reservation the owner's sends may not
//! take, the gift rule and the seizure — their effects (`g13_s2_*` with the
//! lands paths) and refusals.
//!
//! Crafted state (`world::conquest`): the Season's conquest block,
//! Province / Citizen / Holding v2, a vault's stores and the clock. Every
//! instruction itself goes through the program, built by fclient's builders.

mod common;

use fclient::ix::v2::{
    self as fx, IssueArgs, PlaceRef, SendCaravanArgs, TicketSource, WithdrawReceiptArgs,
};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::layout::s2::lot as LT;
use frontier_abi::v2::log::{AnyKind, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{i64_at, trace, u32_at, u64_at, Estate};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair};
use permutation_rules::frontier::caravan::{self as kc, CARAVAN_FEE};
use permutation_rules::frontier::ticket::{KIND_RECEIPT, NO_END, RATIO_ONE};
use permutation_rules::frontier::travel::BELLS_PER_DAY;

const B0: u32 = 20;
const MILLI: i64 = 1_000;
const ORE: usize = 3;

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

/// A shortest path from `from` to `to` over the passable tiles of the
/// estate's Province, never leaving it.
fn local_path(c: &Chain, e: &Estate, from: u8, to: u8) -> (u8, [u8; 12]) {
    use std::collections::{HashMap, VecDeque};
    let pass = u64_at(&c.data(&e.province), P::PASSABLE_MASK);
    let (p, q) = (e.p as i32, e.q as i32);
    let mut prev: HashMap<u8, (u8, u8)> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    prev.insert(from, (from, 9));
    while let Some(t) = queue.pop_front() {
        if t == to {
            let mut dirs = vec![];
            let mut x = t;
            while x != from {
                let (pr, d) = prev[&x];
                dirs.push(d);
                x = pr;
            }
            dirs.reverse();
            return (dirs.len() as u8, kc::pack(&dirs).expect("packs"));
        }
        for d in 0..6u8 {
            let s = trace((p, q, t), &[d])[0];
            if (s.p, s.q) != (p, q) || pass & (1u64 << s.tile) == 0 || prev.contains_key(&s.tile) {
                continue;
            }
            prev.insert(s.tile, (t, d));
            queue.push_back(s.tile);
        }
    }
    panic!("no path {from} → {to}")
}

/// A (faction 0) owns sites 0 and a vault; R (faction 1) owns site 1 of
/// the same ring-4 Province, every tile opened.
struct Cast {
    c: Chain,
    w: World,
    a: Estate,
    r: Estate,
    vt: u8,
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
        let mut k = Cast { c, w, a, r, vt: 0 };
        let pd = k.c.data(&k.a.province);
        let sites = pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize].to_vec();
        k.vt = (0..61u8)
            .filter(|t| !sites.contains(t))
            .find(|&t| {
                let ix = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), t);
                s2_send(&mut k.c, I2::BuildVault, ix, &[&k.a.wallet]).is_ok()
            })
            .expect("a vault tile");
        k
    }

    fn vault(&self) -> Address {
        self.w.a.vault(self.a.p as i32, self.a.q as i32, self.vt)
    }

    fn vault_place(&self, gen: u8) -> PlaceRef {
        PlaceRef::Vault {
            p: self.a.p,
            q: self.a.q,
            tile: self.vt,
            gen,
        }
    }

    fn set_store(&mut self, r: usize, units: i64) {
        let v = self.vault();
        self.c.edit(&v, |d| {
            d[VA::store(r)..VA::store(r) + 8].copy_from_slice(&(units * MILLI).to_le_bytes())
        });
    }

    fn store(&self, r: usize) -> i64 {
        i64_at(&self.c.data(&self.vault()), VA::store(r))
    }

    fn tag(&self) -> u64 {
        self.a.citizen_tag()
    }
}

// ------------------------------------------------------------ receipts

/// A's receipt on ore: `amount` units of `per_unit` milli a day.
fn issue_receipt(k: &mut Cast, amount: u64, per_unit: u64) {
    let a = clone_estate(&k.a);
    let seq = u32_at(&k.c.data(&a.citizen), C::ISSUES);
    let lots = u32_at(&k.c.data(&a.citizen), C::LOTS);
    let ix = fx::issue_tickets(
        &k.w.a,
        &a.player(),
        a.href(),
        TicketSource::Vault {
            p: a.p,
            q: a.q,
            tile: k.vt,
        },
        a.citizen_tag(),
        seq,
        lots,
        &IssueArgs {
            kind: KIND_RECEIPT,
            resource: ORE as u8,
            amount,
            per_unit,
            until_day: NO_END,
        },
    );
    expect_lands(
        s2_send(&mut k.c, I2::IssueTickets, ix, &[&a.wallet]),
        "IssueTickets",
    );
}

fn receipt_issue(k: &Cast) -> (u64, u32) {
    (k.tag(), 0)
}

fn lot(k: &Cast, seq: u32) -> Address {
    k.w.a.lot(k.tag(), seq)
}

fn claim(k: &mut Cast, e: &Estate, lot: Address) -> SendResult {
    let ix = fx::claim_receipt(
        &k.w.a,
        &e.player(),
        lot,
        receipt_issue(k),
        (k.a.p, k.a.q, k.vt),
    );
    s2_send(&mut k.c, I2::ClaimReceipt, ix, &[&e.wallet])
}

fn withdraw_args(k: &Cast, e: &Estate, lot: Address) -> WithdrawReceiptArgs {
    let (steps, path) = local_path(&k.c, e, k.vt, e.tile);
    WithdrawReceiptArgs {
        lot,
        issue: receipt_issue(k),
        vault: (k.a.p, k.a.q, k.vt),
        seq: u32_at(&k.c.data(&e.citizen), C::CARAVANS),
        dst: PlaceRef::Holding {
            h: e.href(),
            gen: e.gen,
        },
        steps,
        path,
        fee: CARAVAN_FEE,
        provinces: vec![(e.p, e.q)],
    }
}

fn withdraw(k: &mut Cast, e: &Estate, lot: Address) -> SendResult {
    let x = withdraw_args(k, e, lot);
    let ix = fx::withdraw_receipt(&k.w.a, &e.player(), &x);
    s2_send(&mut k.c, I2::WithdrawReceipt, ix, &[&e.wallet])
}

/// A gives `amount` units of its lot `from` to R's lot `to`.
fn give(k: &mut Cast, from: Address, to: Address, amount: u64) -> SendResult {
    let a = clone_estate(&k.a);
    let ix = fx::give_lot(
        &k.w.a,
        &a.player(),
        from,
        receipt_issue(k),
        TicketSource::Vault {
            p: a.p,
            q: a.q,
            tile: k.vt,
        },
        k.r.citizen,
        to,
        amount,
    );
    s2_send(&mut k.c, I2::GiveLot, ix, &[&a.wallet])
}

fn next_day(k: &mut Cast) {
    let b = k.w.bell(&k.c);
    let day = b / BELLS_PER_DAY + 1;
    k.w.to_bell(&mut k.c, day * BELLS_PER_DAY + 2, 5);
}

/// The owner sends `units` ore from the vault home.
fn owner_send(k: &mut Cast, units: u32) -> SendResult {
    let a = clone_estate(&k.a);
    let (steps, path) = local_path(&k.c, &a, k.vt, a.tile);
    let mut cargo = [0u32; 8];
    cargo[ORE] = units;
    let x = SendCaravanArgs {
        seq: u32_at(&k.c.data(&a.citizen), C::CARAVANS),
        src: k.vault_place(1),
        dst: PlaceRef::Holding {
            h: a.href(),
            gen: a.gen,
        },
        steps,
        path,
        cargo,
        fee: CARAVAN_FEE,
        provinces: vec![(a.p, a.q)],
    };
    let ix = fx::send_caravan(&k.w.a, &a.player(), &x);
    s2_send(&mut k.c, I2::SendCaravan, ix, &[&a.wallet])
}

fn day_amount(k: &Cast, l: &Address) -> u64 {
    u64_at(&k.c.data(l), LT::DAY_AMOUNT)
}

#[test]
fn g13_s2_receipts_claim_prorate_and_withdraw() {
    let mut k = Cast::new();
    k.set_store(ORE, 30);
    // 4 units of 10 ore a day; A gives 2 to R.
    issue_receipt(&mut k, 4, 10_000);
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let (la, lr) = (lot(&k, 0), lot(&k, 1));
    expect_lands(give(&mut k, la, lr, 2), "GiveLot");
    // Day D: both claim 20 ore; once a day.
    let l = expect_lands(claim(&mut k, &a, la), "ClaimReceipt");
    expect_lands(claim(&mut k, &r, lr), "ClaimReceipt");
    assert_cq(claim(&mut k, &a, la), Cq::ReceiptState);
    assert_eq!((day_amount(&k, &la), day_amount(&k, &lr)), (20_000, 20_000));
    let v = k.c.data(&k.vault());
    assert_eq!(u64_at(&v, VA::claim(ORE)), 40_000);
    match event(&l, CqKind::RECEIPT_CLAIMED) {
        fclient::conquest::CqEvent::ReceiptClaimed { claim, claims, .. } => {
            assert_eq!((claim, claims), (20_000, 20_000))
        }
        e => panic!("{e:?}"),
    }
    // Nothing to withdraw on the claim's own day.
    assert_cq(withdraw(&mut k, &r, lr), Cq::ReceiptState);
    // Day D+1: 30 of 40 → 3/4 each, 15 ore.
    next_day(&mut k);
    let x = withdraw_args(&k, &r, lr);
    let l = expect_lands(withdraw(&mut k, &r, lr), "WithdrawReceipt");
    let v = k.c.data(&k.vault());
    assert_eq!(u32_at(&v, VA::ratio(ORE)), RATIO_ONE / 4 * 3);
    assert_eq!(u64_at(&v, VA::res(ORE)), 15_000);
    assert_eq!(k.store(ORE), 15_000);
    let cv = k.w.a.caravan(r.citizen_tag(), x.seq);
    assert_eq!(i64_at(&k.c.data(&cv), CV::cargo(ORE)), 15_000);
    assert_eq!(day_amount(&k, &lr), 0);
    match event(&l, CqKind::RECEIPT_WITHDRAWN) {
        fclient::conquest::CqEvent::ReceiptWithdrawn {
            ratio_ppm, grant, ..
        } => assert_eq!((ratio_ppm, grant), (750_000, 15_000)),
        e => panic!("{e:?}"),
    }
    assert_cq(withdraw(&mut k, &r, lr), Cq::ReceiptState);
    // The owner may not take A's reserved 15.
    assert_code(owner_send(&mut k, 1), E::Insufficient);
    expect_lands(withdraw(&mut k, &a, la), "WithdrawReceipt");
    assert_eq!(k.store(ORE), 0);
    // Day D+2: the reservation lapsed; a claim not withdrawn on D+3 lapses.
    k.set_store(ORE, 10);
    next_day(&mut k);
    expect_lands(owner_send(&mut k, 1), "SendCaravan");
    expect_lands(claim(&mut k, &a, la), "ClaimReceipt");
    next_day(&mut k);
    next_day(&mut k);
    expect_lands(claim(&mut k, &a, la), "ClaimReceipt (the old claim lapsed)");
}

#[test]
fn g13_s2_receipts_gifts_and_seizure() {
    let mut k = Cast::new();
    k.set_store(ORE, 100);
    issue_receipt(&mut k, 4, 10_000);
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let (la, lr, lr2) = (lot(&k, 0), lot(&k, 1), lot(&k, 2));
    expect_lands(give(&mut k, la, lr, 1), "GiveLot");
    // A claims; units it gives today land "claimed today".
    expect_lands(claim(&mut k, &a, la), "ClaimReceipt");
    assert_cq(give(&mut k, la, lr, 1), Cq::ReceiptState);
    expect_lands(give(&mut k, la, lr2, 1), "GiveLot");
    assert_cq(claim(&mut k, &r, lr2), Cq::ReceiptState);
    expect_lands(claim(&mut k, &r, lr), "ClaimReceipt");
    // A seizure voids the receipts and clears the vault's claims.
    let province = a.province;
    k.w.craft_host(&mut k.c, &r, &province, 0, 0, 0, 500, k.vt);
    let ix = fx::seize_vault(
        &k.w.a,
        &r.player(),
        (a.p, a.q, k.vt),
        r.href(),
        a.citizen,
        0,
    );
    expect_lands(
        s2_send(&mut k.c, I2::SeizeVault, ix, &[&r.wallet]),
        "SeizeVault",
    );
    let v = k.c.data(&k.vault());
    assert_eq!(
        (u32_at(&v, VA::CLAIM_DAY), u64_at(&v, VA::claim(ORE))),
        (0, 0)
    );
    next_day(&mut k);
    assert_cq(withdraw(&mut k, &r, lr), Cq::TicketVoid);
    assert_cq(claim(&mut k, &a, la), Cq::TicketVoid);
}

fn rent_of(c: &Chain, key: &Address, at: usize) -> Address {
    Address::new_from_array(c.data(key)[at..at + 32].try_into().unwrap())
}

/// A vault closed and built again on its tile is another source: the old
/// receipts stay void though the generation is the same (the stamp).
#[test]
fn g13_s2_receipts_die_with_a_closed_vault() {
    let mut k = Cast::new();
    issue_receipt(&mut k, 4, 10_000);
    let a = clone_estate(&k.a);
    let la = lot(&k, 0);
    let vr = rent_of(&k.c, &k.vault(), VA::RENT_TO);
    let ix = fx::close_vault(&k.w.a, &a.player(), (a.p, a.q, k.vt), vr);
    expect_lands(
        s2_send(&mut k.c, I2::CloseVault, ix, &[&a.wallet]),
        "CloseVault",
    );
    assert_cq(claim(&mut k, &a, la), Cq::TicketVoid);
    next_day(&mut k);
    let ix = fx::build_vault(&k.w.a, &a.player(), a.href(), (a.p, a.q), k.vt);
    expect_lands(
        s2_send(&mut k.c, I2::BuildVault, ix, &[&a.wallet]),
        "BuildVault again",
    );
    assert_eq!(k.c.data(&k.vault())[VA::GEN], 1);
    k.set_store(ORE, 100);
    assert_cq(claim(&mut k, &a, la), Cq::TicketVoid);
}

/// Receipts and shares never share a vault: no opening while a claim or a
/// grant is outstanding, and no claim once shared.
#[test]
fn g13_s2_receipts_and_shares_exclude() {
    let mut k = Cast::new();
    issue_receipt(&mut k, 4, 10_000);
    let a = clone_estate(&k.a);
    let la = lot(&k, 0);
    let open = |k: &mut Cast| {
        let seq = u32_at(&k.c.data(&a.citizen), C::ISSUES);
        let ix = fx::open_shares(
            &k.w.a,
            &a.player(),
            a.href(),
            (a.p, a.q, k.vt),
            a.citizen_tag(),
            seq,
        );
        s2_send(&mut k.c, I2::OpenShares, ix, &[&a.wallet])
    };
    expect_lands(claim(&mut k, &a, la), "ClaimReceipt");
    assert_cq(open(&mut k), Cq::ReceiptState);
    // The empty vault grants nothing at the boundary: nothing is pending.
    next_day(&mut k);
    expect_lands(open(&mut k), "OpenShares");
    assert_cq(claim(&mut k, &a, la), Cq::VaultShared);
}

/// A void issue closed by its issuer leaves its lots to close alone, units
/// and all.
#[test]
fn g13_s2_orphan_lots_close() {
    let mut k = Cast::new();
    k.set_store(ORE, 100);
    issue_receipt(&mut k, 4, 10_000);
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let (la, lr) = (lot(&k, 0), lot(&k, 1));
    expect_lands(give(&mut k, la, lr, 1), "GiveLot");
    let province = a.province;
    k.w.craft_host(&mut k.c, &r, &province, 0, 0, 0, 500, k.vt);
    let ix = fx::seize_vault(
        &k.w.a,
        &r.player(),
        (a.p, a.q, k.vt),
        r.href(),
        a.citizen,
        0,
    );
    expect_lands(
        s2_send(&mut k.c, I2::SeizeVault, ix, &[&r.wallet]),
        "SeizeVault",
    );
    let src = TicketSource::Vault {
        p: a.p,
        q: a.q,
        tile: k.vt,
    };
    let issue = k.w.a.issue(k.tag(), 0);
    let issue_rent = rent_of(&k.c, &issue, frontier_abi::v2::layout::s2::issue::RENT_TO);
    let ix = fx::close_lot(&k.w.a, &a.player(), (k.tag(), 0), src, issue_rent, None, true);
    expect_lands(
        s2_send(&mut k.c, I2::CloseLot, ix, &[&a.wallet]),
        "CloseLot (the void issue)",
    );
    assert!(k.c.account(&issue).is_none_or(|x| x.lamports == 0));
    for (e, l) in [(&r, lr), (&a, la)] {
        let ix = fx::close_lot(
            &k.w.a,
            &e.player(),
            (k.tag(), 0),
            src,
            issue_rent,
            Some((l, rent_of(&k.c, &l, LT::RENT_TO))),
            false,
        );
        let landed = expect_lands(
            s2_send(&mut k.c, I2::CloseLot, ix, &[&e.wallet]),
            "CloseLot (an orphan lot)",
        );
        match event(&landed, CqKind::LOT_CLOSED) {
            fclient::conquest::CqEvent::LotClosed {
                void,
                lot_closed,
                issue_closed,
                ..
            } => assert!(void && lot_closed && issue_closed),
            e => panic!("{e:?}"),
        }
    }
}

fn clone_estate(e: &Estate) -> Estate {
    Estate {
        wallet: e.wallet.insecure_clone(),
        ..*e
    }
}
