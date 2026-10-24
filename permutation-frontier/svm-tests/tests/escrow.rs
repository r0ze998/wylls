//! S2 stage 2e: escrowed exchange (`docs/frontier/stage2/S2-2E-CONTRACT.md`)
//! on the test-beacon build: OpenEscrow, AcceptEscrow, CancelEscrow and
//! WithdrawEscrow — goods held in place, the swap at acceptance, the
//! collection by caravan, cancels and a seizure — their effects (`g13_s2_*`
//! with the lands paths) and refusals.
//!
//! Crafted state (`world::conquest`): the Season's conquest block,
//! Province / Citizen / Holding v2, a vault's stores and the clock. Every
//! instruction itself goes through the program, built by fclient's builders.

mod common;

use fclient::ix::v2::{
    self as fx, EscrowItem, IssueArgs, PlaceRef, SendCaravanArgs, TicketSource, WithdrawEscrowArgs,
};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::layout::s2::{escrow as ES, lot as LT};
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
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair, Signer};
use permutation_rules::frontier::caravan::{self as kc, CARAVAN_FEE};
use permutation_rules::frontier::ticket::{KIND_RECEIPT, NO_END};
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
}


/// R's vault, on the first free tile after A's.
fn r_vault(k: &mut Cast) -> u8 {
    let pd = k.c.data(&k.a.province);
    let sites = pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize].to_vec();
    let r = clone_estate(&k.r);
    (0..61u8)
        .filter(|t| !sites.contains(t) && *t != k.vt)
        .find(|&t| {
            let ix = fx::build_vault(&k.w.a, &r.player(), r.href(), (r.p, r.q), t);
            s2_send(&mut k.c, I2::BuildVault, ix, &[&r.wallet]).is_ok()
        })
        .expect("a vault tile")
}

/// `e` issues a receipt of 1 ore a day on its vault at `tile` (its first
/// lot, `(tag, lots)`).
fn issue_receipt(k: &mut Cast, e: &Estate, tile: u8) -> (u64, u32) {
    let seq = u32_at(&k.c.data(&e.citizen), C::ISSUES);
    let lots = u32_at(&k.c.data(&e.citizen), C::LOTS);
    let ix = fx::issue_tickets(
        &k.w.a,
        &e.player(),
        e.href(),
        TicketSource::Vault {
            p: e.p,
            q: e.q,
            tile,
        },
        e.citizen_tag(),
        seq,
        lots,
        &IssueArgs {
            kind: KIND_RECEIPT,
            resource: ORE as u8,
            amount: 5,
            per_unit: 1_000,
            until_day: NO_END,
        },
    );
    expect_lands(s2_send(&mut k.c, I2::IssueTickets, ix, &[&e.wallet]), "IssueTickets");
    (e.citizen_tag(), lots)
}

fn ore(units: u64, vault: (i16, i16, u8)) -> EscrowItem {
    EscrowItem::Goods {
        resource: ORE as u8,
        amount: units * MILLI as u64,
        vault,
    }
}

fn open(k: &mut Cast, e: &Estate, to: &Estate, deadline: u32, give: EscrowItem, want: EscrowItem) -> (SendResult, (u64, u32)) {
    let seq = u32_at(&k.c.data(&e.citizen), C::LOTS);
    let ix = fx::open_escrow(&k.w.a, &e.player(), e.citizen_tag(), seq, &to.wallet.pubkey(), deadline, give, want);
    (s2_send(&mut k.c, I2::OpenEscrow, ix, &[&e.wallet]), (e.citizen_tag(), seq))
}

fn accept(k: &mut Cast, e: &Estate, id: (u64, u32), maker_item: EscrowItem, taker_item: EscrowItem) -> SendResult {
    let ix = fx::accept_escrow(&k.w.a, &e.player(), id, maker_item, taker_item);
    s2_send(&mut k.c, I2::AcceptEscrow, ix, &[&e.wallet])
}

fn rent_of(c: &Chain, key: &Address) -> Address {
    Address::new_from_array(c.data(key)[ES::RENT_TO..ES::RENT_TO + 32].try_into().unwrap())
}

fn cancel(k: &mut Cast, e: &Estate, id: (u64, u32), srcs: &[Address]) -> SendResult {
    let esc = k.w.a.escrow(id.0, id.1);
    let rent = rent_of(&k.c, &esc);
    let ix = fx::cancel_escrow(&k.w.a, &e.player(), id, rent, srcs);
    s2_send(&mut k.c, I2::CancelEscrow, ix, &[&e.wallet])
}

/// `e` collects goods side `side` of `id` from the vault at `tile` home.
fn withdraw(k: &mut Cast, e: &Estate, id: (u64, u32), side: u8, tile: u8) -> (SendResult, u32) {
    let (steps, path) = local_path(&k.c, e, tile, e.tile);
    let esc = k.w.a.escrow(id.0, id.1);
    let seq = u32_at(&k.c.data(&e.citizen), C::CARAVANS);
    let x = WithdrawEscrowArgs {
        escrow: id,
        side,
        vault: (k.a.p, k.a.q, tile),
        seq,
        dst: PlaceRef::Holding { h: e.href(), gen: e.gen },
        steps,
        path,
        fee: CARAVAN_FEE,
        rent_to: rent_of(&k.c, &esc),
        provinces: vec![(e.p, e.q)],
    };
    let ix = fx::withdraw_escrow(&k.w.a, &e.player(), &x);
    (s2_send(&mut k.c, I2::WithdrawEscrow, ix, &[&e.wallet]), seq)
}

fn held(k: &Cast, tile: u8, r: usize) -> u64 {
    u64_at(&k.c.data(&k.w.a.vault(k.a.p as i32, k.a.q as i32, tile)), VA::held(r))
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
        dst: PlaceRef::Holding { h: a.href(), gen: a.gen },
        steps,
        path,
        cargo,
        fee: CARAVAN_FEE,
        provinces: vec![(a.p, a.q)],
    };
    let ix = fx::send_caravan(&k.w.a, &a.player(), &x);
    s2_send(&mut k.c, I2::SendCaravan, ix, &[&a.wallet])
}

/// A gives 50 ore (held in its vault) for R's receipt lot: the hold binds
/// the owner's sends, the swap moves the lot at acceptance, and R collects
/// the ore by caravan, which closes the escrow.
#[test]
fn g13_s2_escrow_goods_for_a_lot() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    k.set_store(ORE, 100);
    let rt = r_vault(&mut k);
    let rl = issue_receipt(&mut k, &r, rt);
    let lot = EscrowItem::Lot { lot: rl, units: 5 };
    let give = ore(50, (a.p, a.q, k.vt));
    let deadline = k.w.bell(&k.c) + 10;
    let (l, id) = open(&mut k, &a, &r, deadline, give, lot);
    let l = expect_lands(l, "OpenEscrow");
    let _ = event(&l, CqKind::ESCROW_OPENED);
    assert_eq!(held(&k, k.vt, ORE), 50_000);
    // The owner may send the free 50, not one more.
    assert_code(owner_send(&mut k, 51), E::Insufficient);
    // Only the taker accepts.
    assert_cq(accept(&mut k, &a, id, give, lot), Cq::EscrowState);
    let l = expect_lands(accept(&mut k, &r, id, give, lot), "AcceptEscrow");
    match event(&l, CqKind::ESCROW_SETTLED) {
        fclient::conquest::CqEvent::EscrowSettled { closed, .. } => assert!(!closed),
        e => panic!("{e:?}"),
    }
    let ld = k.c.data(&k.w.a.lot(rl.0, rl.1));
    assert_eq!(&ld[LT::HOLDER_CITIZEN..LT::HOLDER_CITIZEN + 32], a.citizen.as_ref());
    assert_eq!(u64_at(&ld, LT::ESCROW), 0);
    // A cannot collect its own goods; R does.
    let vt = k.vt;
    assert_cq(withdraw(&mut k, &a, id, 0, vt).0, Cq::EscrowState);
    let (l, seq) = withdraw(&mut k, &r, id, 0, vt);
    let l = expect_lands(l, "WithdrawEscrow");
    match event(&l, CqKind::ESCROW_WITHDRAWN) {
        fclient::conquest::CqEvent::EscrowWithdrawn { amount, closed, .. } => {
            assert_eq!((amount, closed), (50_000, true))
        }
        e => panic!("{e:?}"),
    }
    let cv = k.w.a.caravan(r.citizen_tag(), seq);
    assert_eq!(i64_at(&k.c.data(&cv), CV::cargo(ORE)), 50_000);
    assert_eq!((held(&k, k.vt, ORE), k.store(ORE)), (0, 50_000));
    assert!(k.c.account(&k.w.a.escrow(id.0, id.1)).is_none_or(|x| x.lamports == 0));
}

/// A lot offered and cancelled by its maker, one cancelled by anyone after
/// its deadline, a lot in escrow frozen, and the refusals of the terms.
#[test]
fn g13_s2_escrow_cancels_and_refusals() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    k.set_store(ORE, 100);
    let vt = k.vt;
    let al = issue_receipt(&mut k, &a, vt);
    let lot = EscrowItem::Lot { lot: al, units: 5 };
    let rt = r_vault(&mut k);
    let want = ore(10, (r.p, r.q, rt));
    let now = k.w.bell(&k.c);
    // Terms: a deadline past the limit, goods not in whole units, oneself.
    assert_code(open(&mut k, &a, &r, now + 7 * BELLS_PER_DAY + 1, lot, want).0, E::BadData);
    let frac = EscrowItem::Goods { resource: ORE as u8, amount: 1_500, vault: (a.p, a.q, k.vt) };
    assert_code(open(&mut k, &a, &r, now + 10, frac, lot).0, E::BadData);
    // (oneself as the taker repeats the Citizen: refused by the accounts)
    assert_code(open(&mut k, &a, &a, now + 10, lot, want).0, E::BadAccount);
    // Open; the lot is frozen; the maker cancels.
    let (l, id) = open(&mut k, &a, &r, now + 10, lot, want);
    expect_lands(l, "OpenEscrow");
    let lk = k.w.a.lot(al.0, al.1);
    assert_ne!(u64_at(&k.c.data(&lk), LT::ESCROW), 0);
    assert_cq(open(&mut k, &a, &r, now + 10, lot, want).0, Cq::TicketTerms);
    assert_cq(cancel(&mut k, &r, id, &[lk]), Cq::EscrowState);
    let l = expect_lands(cancel(&mut k, &a, id, &[lk]), "CancelEscrow");
    match event(&l, CqKind::ESCROW_CANCELLED) {
        fclient::conquest::CqEvent::EscrowCancelled { released, .. } => assert_eq!(released, 2),
        e => panic!("{e:?}"),
    }
    assert_eq!(u64_at(&k.c.data(&lk), LT::ESCROW), 0);
    // Past its deadline: no acceptance; anyone may cancel.
    let soon = k.w.bell(&k.c) + 1;
    let (l, id) = open(&mut k, &a, &r, soon, lot, want);
    expect_lands(l, "OpenEscrow");
    let b = k.w.bell(&k.c);
    k.w.to_bell(&mut k.c, b + 3, 5);
    k.set_store(ORE, 100);
    let rv = k.w.a.vault(r.p as i32, r.q as i32, rt);
    k.c.edit(&rv, |d| d[VA::store(ORE)..VA::store(ORE) + 8].copy_from_slice(&(50 * MILLI).to_le_bytes()));
    assert_cq(accept(&mut k, &r, id, lot, want), Cq::EscrowState);
    expect_lands(cancel(&mut k, &r, id, &[lk]), "CancelEscrow (after the deadline)");
    assert_eq!(u64_at(&k.c.data(&lk), LT::ESCROW), 0);
}

/// A lot for R's ore: settled, the ore owed from R's vault; A seizes it
/// back? No: R's vault is seized by A, which voids the owed ore; a party
/// then closes the escrow.
#[test]
fn g13_s2_escrow_owed_goods_die_with_their_vault() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    let vt = k.vt;
    let al = issue_receipt(&mut k, &a, vt);
    let lot = EscrowItem::Lot { lot: al, units: 5 };
    let rt = r_vault(&mut k);
    let rv = k.w.a.vault(r.p as i32, r.q as i32, rt);
    k.c.edit(&rv, |d| d[VA::store(ORE)..VA::store(ORE) + 8].copy_from_slice(&(40 * MILLI).to_le_bytes()));
    let want = ore(20, (r.p, r.q, rt));
    let later = k.w.bell(&k.c) + 10;
    let (l, id) = open(&mut k, &a, &r, later, lot, want);
    expect_lands(l, "OpenEscrow");
    expect_lands(accept(&mut k, &r, id, lot, want), "AcceptEscrow");
    assert_eq!(u64_at(&k.c.data(&rv), VA::held(ORE)), 20_000);
    // A's lot is R's now.
    let ld = k.c.data(&k.w.a.lot(al.0, al.1));
    assert_eq!(&ld[LT::HOLDER_CITIZEN..LT::HOLDER_CITIZEN + 32], r.citizen.as_ref());
    // Nothing closes while the ore is live.
    assert_cq(cancel(&mut k, &a, id, &[rv]), Cq::EscrowState);
    // A seizes R's vault: the hold is gone, the ore is void.
    let province = r.province;
    k.w.craft_host(&mut k.c, &a, &province, 0, 0, 0, 500, rt);
    let ix = fx::seize_vault(&k.w.a, &a.player(), (r.p, r.q, rt), a.href(), r.citizen, 0);
    expect_lands(s2_send(&mut k.c, I2::SeizeVault, ix, &[&a.wallet]), "SeizeVault");
    assert_eq!(u64_at(&k.c.data(&rv), VA::held(ORE)), 0);
    // (A collects nothing: the vault's generation moved.)
    let _ = trace;
    // Review fix: A empties and closes the seized vault, R builds it again
    // (generation 1 again): the old owed ore stays void (the stamp).
    k.c.edit(&rv, |d| d[VA::store(ORE)..VA::store(ORE) + 8].copy_from_slice(&0i64.to_le_bytes()));
    let vr = Address::new_from_array(k.c.data(&rv)[VA::RENT_TO..VA::RENT_TO + 32].try_into().unwrap());
    let ix = fx::close_vault(&k.w.a, &a.player(), (r.p, r.q, rt), vr);
    expect_lands(s2_send(&mut k.c, I2::CloseVault, ix, &[&a.wallet]), "CloseVault");
    let b = k.w.bell(&k.c);
    k.w.to_bell(&mut k.c, b + 2, 5);
    let ix = fx::build_vault(&k.w.a, &r.player(), r.href(), (r.p, r.q), rt);
    expect_lands(s2_send(&mut k.c, I2::BuildVault, ix, &[&r.wallet]), "BuildVault again");
    assert_eq!(k.c.data(&rv)[VA::GEN], 1);
    k.c.edit(&rv, |d| d[VA::store(ORE)..VA::store(ORE) + 8].copy_from_slice(&(40 * MILLI).to_le_bytes()));
    let (l, _) = withdraw(&mut k, &a, id, 1, rt);
    assert_cq(l, Cq::TicketVoid);
    expect_lands(cancel(&mut k, &a, id, &[rv]), "CancelEscrow (void goods)");
}

/// Review fixes: goods beyond the cap, a wanted lot short of its units, and
/// goods voided by a seizure before the acceptance are all refused.
#[test]
fn g13_s2_escrow_refuses_huge_short_or_void_items() {
    let mut k = Cast::new();
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    k.set_store(ORE, 100);
    let rt = r_vault(&mut k);
    let rl = issue_receipt(&mut k, &r, rt);
    let now = k.w.bell(&k.c);
    // A wrapping amount (2^64 − 1000) is refused.
    let huge = EscrowItem::Goods { resource: ORE as u8, amount: u64::MAX - 615, vault: (a.p, a.q, k.vt) };
    let want = EscrowItem::Lot { lot: rl, units: 5 };
    assert_code(open(&mut k, &a, &r, now + 10, huge, want).0, E::BadData);
    // R's lot holds 5: an escrow wanting 6 cannot be accepted with it.
    let give = ore(10, (a.p, a.q, k.vt));
    let six = EscrowItem::Lot { lot: rl, units: 6 };
    let (l, id) = open(&mut k, &a, &r, now + 10, give, six);
    expect_lands(l, "OpenEscrow");
    assert_cq(accept(&mut k, &r, id, give, six), Cq::EscrowState);
    // Goods voided by a seizure of A's vault cannot be accepted.
    let (l, id) = open(&mut k, &a, &r, now + 10, give, want);
    expect_lands(l, "OpenEscrow");
    let province = a.province;
    let vt = k.vt;
    k.w.craft_host(&mut k.c, &r, &province, 0, 0, 0, 500, vt);
    let ix = fx::seize_vault(&k.w.a, &r.player(), (a.p, a.q, vt), r.href(), a.citizen, 0);
    expect_lands(s2_send(&mut k.c, I2::SeizeVault, ix, &[&r.wallet]), "SeizeVault");
    let seized = EscrowItem::Goods { resource: ORE as u8, amount: 10_000, vault: (a.p, a.q, vt) };
    assert_cq(accept(&mut k, &r, id, seized, want), Cq::TicketVoid);
}

fn clone_estate(e: &Estate) -> Estate {
    Estate {
        wallet: e.wallet.insecure_clone(),
        ..*e
    }
}
