//! S2 stage 2a: the ticket groundwork (`docs/frontier/stage2/S2-2A-CONTRACT.md`)
//! on the test-beacon build: IssueTickets, GiveLot and CloseLot — their
//! effects (`g13_s2_*` with the lands paths) and refusals (one per
//! (instruction, code)).
//!
//! Crafted state (`world::conquest`): the Season's conquest block,
//! Province / Citizen / Holding v2, a workshop's arms production and a
//! vault's seizure (its generation raised). Every S2 instruction itself goes
//! through the program, built by fclient's builders.

mod common;

use fclient::ix::v2::{self as fx, IssueArgs, TicketSource};
use fclient::ix::Player;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::s1::vault as VA;
use frontier_abi::v2::layout::s2::{issue as IS, lot as LT};
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{read_kholding, u32_at, u64_at, Estate};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair, Signer};
use permutation_rules::frontier::arms;
use permutation_rules::frontier::ticket::{
    self as kt, KIND_RECEIPT, KIND_USE, MAX_OPEN_ISSUES, NO_END, STATE_LIVE,
};

const B0: u32 = 20;
const GOLD: usize = 5;

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
        .find(|b| {
            frontier_abi::v2::log::decode(b)
                .is_ok_and(|r| r.kind == frontier_abi::v2::log::AnyKind::Cq(k))
        })
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

/// A (faction 0) and R (faction 1) hold sites 0 and 1 of a ring-4
/// Province with every tile opened; A has a vault there.
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
        // A's vault on the first tile that takes one.
        let vt = (0..61u8)
            .find(|&t| {
                let ix = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), t);
                s2_send(&mut k.c, I2::BuildVault, ix, &[&k.a.wallet]).is_ok()
            })
            .expect("a vault tile");
        k.vt = vt;
        k
    }

    fn vault(&self) -> Address {
        self.w.a.vault(self.a.p as i32, self.a.q as i32, self.vt)
    }

    fn vault_src(&self) -> TicketSource {
        TicketSource::Vault {
            p: self.a.p,
            q: self.a.q,
            tile: self.vt,
        }
    }

    fn counters(&self, e: &Estate) -> (u32, u32, u8) {
        let d = self.c.data(&e.citizen);
        (
            u32_at(&d, C::ISSUES),
            u32_at(&d, C::LOTS),
            d[C::OPEN_ISSUES],
        )
    }

    fn issue(
        &mut self,
        by: &Player,
        src: TicketSource,
        x: &IssueArgs,
        signer: &Keypair,
    ) -> SendResult {
        let (seq, lot_seq, _) = self.counters(&self.a);
        let ix = fx::issue_tickets(
            &self.w.a,
            by,
            self.a.href(),
            src,
            self.a.citizen_tag(),
            seq,
            lot_seq,
            x,
        );
        s2_send(&mut self.c, I2::IssueTickets, ix, &[signer])
    }

    fn issue_receipt(&mut self, amount: u64) -> SendResult {
        let (p, src, w) = (
            self.a.player(),
            self.vault_src(),
            self.a.wallet.insecure_clone(),
        );
        self.issue(&p, src, &receipt(amount), &w)
    }

    #[allow(clippy::too_many_arguments)]
    fn give(
        &mut self,
        by: &Player,
        signer: &Keypair,
        lot: Address,
        issue: (u64, u32),
        recipient: Address,
        to_lot: Address,
        amount: u64,
    ) -> SendResult {
        let ix = fx::give_lot(
            &self.w.a,
            by,
            lot,
            issue,
            self.vault_src(),
            recipient,
            to_lot,
            amount,
        );
        s2_send(&mut self.c, I2::GiveLot, ix, &[signer])
    }

    fn close(
        &mut self,
        by: &Player,
        signer: &Keypair,
        issue: (u64, u32),
        lot: Option<Address>,
        close_issue: bool,
    ) -> SendResult {
        let rent = |c: &Chain, k: &Address, at: usize| {
            Address::new_from_array(c.data(k)[at..at + 32].try_into().unwrap())
        };
        let ia = self.w.a.issue(issue.0, issue.1);
        let issue_rent_to = rent(&self.c, &ia, IS::RENT_TO);
        let lot = lot.map(|l| (l, rent(&self.c, &l, LT::RENT_TO)));
        let ix = fx::close_lot(
            &self.w.a,
            by,
            issue,
            self.vault_src(),
            issue_rent_to,
            lot,
            close_issue,
        );
        s2_send(&mut self.c, I2::CloseLot, ix, &[signer])
    }

    /// A session key for A.
    fn session(&mut self) -> (Keypair, Player) {
        let session = self.c.funded(b"session", 1);
        let exp = self.c.now + 3_600;
        let citizen = self.a.citizen;
        self.c.edit(&citizen, |d| {
            d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
            d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
        });
        let p = Player {
            actor: session.pubkey(),
            payer: session.pubkey(),
            wallet: self.a.wallet.pubkey(),
        };
        (session, p)
    }
}

fn receipt(amount: u64) -> IssueArgs {
    IssueArgs {
        kind: KIND_RECEIPT,
        resource: 3,
        amount,
        per_unit: 20_000,
        until_day: NO_END,
    }
}

fn gold(c: &Chain, e: &Estate) -> i64 {
    read_kholding(&c.data(&e.holding)).stores[GOLD].value
}

fn lot_amount(c: &Chain, l: &Address) -> u64 {
    u64_at(&c.data(l), LT::AMOUNT)
}

// ------------------------------------------------------------ IssueTickets

#[test]
fn g13_s2_issue_a_receipt_and_a_use_ticket() {
    let mut k = Cast::new();
    let g0 = gold(&k.c, &k.a);
    let l = expect_lands(k.issue_receipt(10), "IssueTickets");
    let tag = k.a.citizen_tag();
    let ia = k.w.a.issue(tag, 0);
    let d = k.c.data(&ia);
    assert_eq!(
        (d[IS::KIND], d[IS::STATE], d[IS::SRC_KIND], d[IS::SRC_GEN]),
        (KIND_RECEIPT, STATE_LIVE, kt::SRC_VAULT, 1)
    );
    assert_eq!(
        (
            u64_at(&d, IS::SUPPLY),
            u64_at(&d, IS::PER_UNIT),
            d[IS::RESOURCE]
        ),
        (10, 20_000, 3)
    );
    assert_eq!(u64_at(&d, IS::ISSUER_TAG), tag);
    let la = k.w.a.lot(tag, 0);
    let ld = k.c.data(&la);
    assert_eq!(
        (
            u64_at(&ld, LT::AMOUNT),
            u64_at(&ld, LT::HOLDER_TAG),
            u64_at(&ld, LT::SEED_TAG)
        ),
        (10, tag, tag)
    );
    assert_eq!(
        &ld[LT::HOLDER_CITIZEN..LT::HOLDER_CITIZEN + 32],
        k.a.citizen.as_ref()
    );
    assert_eq!(k.counters(&k.a), (1, 1, 1));
    // the fee is taken from the holding (and burned: nothing receives it)
    let fee = kt::issue_fee()[GOLD];
    let g1 = gold(&k.c, &k.a);
    assert!(
        g1 <= g0 - fee + 5_000 && g1 >= g0 - fee - 5_000,
        "{g0} → {g1}"
    );
    match event(&l, CqKind::TICKETS_ISSUED) {
        fclient::conquest::CqEvent::TicketsIssued {
            issuer_tag,
            seq,
            kind,
            amount,
            lot_seq,
            src,
            ..
        } => {
            assert_eq!(
                (issuer_tag, seq, kind, amount, lot_seq),
                (tag, 0, KIND_RECEIPT, 10, 0)
            );
            assert_eq!((src.kind, src.at), (2, k.vt));
        }
        e => panic!("{e:?}"),
    }
    // A use ticket of A's workshop (one copy's arms production).
    k.w.edit_kholding(&mut k.c, &k.a, |h| {
        h.production[arms::ARMS as usize] = arms::WORKSHOP_DELTA
    });
    let use_ = IssueArgs {
        kind: KIND_USE,
        resource: 0,
        amount: 3,
        per_unit: 2,
        until_day: NO_END,
    };
    let (p, w) = (k.a.player(), k.a.wallet.insecure_clone());
    expect_lands(
        k.issue(&p, TicketSource::Holding(k.a.href()), &use_, &w),
        "IssueTickets",
    );
    let d = k.c.data(&k.w.a.issue(tag, 1));
    assert_eq!(
        (d[IS::KIND], d[IS::SRC_KIND], d[IS::AT]),
        (KIND_USE, kt::SRC_HOLDING, k.a.site)
    );
    assert_eq!(k.counters(&k.a), (2, 2, 2));
    // the session key may issue (the citizen's own act)
    let (s, sp) = k.session();
    expect_lands(k.issue(&sp, k.vault_src(), &receipt(1), &s), "IssueTickets");
}

#[test]
fn g13_s2_issue_refusals() {
    let mut k = Cast::new();
    let (p, w) = (k.a.player(), k.a.wallet.insecure_clone());
    // Terms.
    assert_cq(k.issue_receipt(0), Cq::TicketTerms);
    let bad = IssueArgs {
        resource: 6,
        ..receipt(1)
    };
    assert_cq(k.issue(&p, k.vault_src(), &bad, &w), Cq::TicketTerms);
    // A use ticket of a holding with no workshop; a receipt of a holding.
    let use_ = IssueArgs {
        kind: KIND_USE,
        resource: 0,
        amount: 3,
        per_unit: 2,
        until_day: NO_END,
    };
    assert_cq(
        k.issue(&p, TicketSource::Holding(k.a.href()), &use_, &w),
        Cq::TicketTerms,
    );
    assert_cq(
        k.issue(&p, TicketSource::Holding(k.a.href()), &receipt(1), &w),
        Cq::TicketTerms,
    );
    // Another's source.
    let theirs = TicketSource::Holding(k.r.href());
    k.w.edit_kholding(&mut k.c, &k.r, |h| {
        h.production[arms::ARMS as usize] = arms::WORKSHOP_DELTA
    });
    assert_code(k.issue(&p, theirs, &use_, &w), E::NotOwner);
    // The limit.
    k.c.edit(&k.a.citizen, |d| d[C::OPEN_ISSUES] = MAX_OPEN_ISSUES);
    assert_cq(k.issue_receipt(1), Cq::TicketLimit);
    k.c.edit(&k.a.citizen, |d| d[C::OPEN_ISSUES] = 0);
    // The fee.
    k.w.edit_kholding(&mut k.c, &k.a, |h| {
        h.stores[GOLD].value = 0;
        h.stores[GOLD].frac = 0;
        h.production[GOLD] = 0;
    });
    assert_code(k.issue_receipt(1), E::Insufficient);
}

// ------------------------------------------------------------ GiveLot

#[test]
fn g13_s2_split_give_and_add() {
    let mut k = Cast::new();
    expect_lands(k.issue_receipt(10), "IssueTickets");
    let tag = k.a.citizen_tag();
    let issue = (tag, 0);
    let lot0 = k.w.a.lot(tag, 0);
    // A split by the session key: a new lot seeded by A's counter.
    let (s, sp) = k.session();
    let lot1 = k.w.a.lot(tag, 1);
    let l = expect_lands(
        k.give(&sp, &s, lot0, issue, k.a.citizen, lot1, 3),
        "GiveLot",
    );
    assert_eq!((lot_amount(&k.c, &lot0), lot_amount(&k.c, &lot1)), (7, 3));
    assert_eq!(k.counters(&k.a).1, 2);
    match event(&l, CqKind::LOT_MOVED) {
        fclient::conquest::CqEvent::LotMoved {
            from,
            to,
            amount,
            whole,
            new_lot,
            ..
        } => {
            assert_eq!(
                (from, to, amount, whole, new_lot),
                ((tag, 0), (tag, 1), 3, false, true)
            );
        }
        e => panic!("{e:?}"),
    }
    // A gift to R needs the wallet (L7).
    let lot2 = k.w.a.lot(tag, 2);
    assert_cq(
        k.give(&sp, &s, lot0, issue, k.r.citizen, lot2, 2),
        Cq::WalletRequired,
    );
    let (ap, aw) = (k.a.player(), k.a.wallet.insecure_clone());
    expect_lands(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, lot2, 2),
        "GiveLot",
    );
    let d = k.c.data(&lot2);
    assert_eq!(
        (
            u64_at(&d, LT::HOLDER_TAG),
            u64_at(&d, LT::SEED_TAG),
            u64_at(&d, LT::AMOUNT)
        ),
        (k.r.citizen_tag(), tag, 2)
    );
    // Added to R's lot of the issue.
    expect_lands(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, lot2, 1),
        "GiveLot",
    );
    assert_eq!((lot_amount(&k.c, &lot0), lot_amount(&k.c, &lot2)), (4, 3));
    // A whole-lot gift in place: the 3-unit lot becomes R's, same address.
    expect_lands(
        k.give(&ap, &aw, lot1, issue, k.r.citizen, lot1, 3),
        "GiveLot",
    );
    assert_eq!(u64_at(&k.c.data(&lot1), LT::HOLDER_TAG), k.r.citizen_tag());
    // Supply is unchanged by moves.
    assert_eq!(u64_at(&k.c.data(&k.w.a.issue(tag, 0)), IS::SUPPLY), 10);
    // Refusals: more than the lot, not the holder, a split in place.
    assert_code(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, lot2, 5),
        E::BadData,
    );
    let (rp, rw) = (k.r.player(), k.r.wallet.insecure_clone());
    assert_code(
        k.give(&rp, &rw, lot0, issue, k.r.citizen, lot2, 1),
        E::NotOwner,
    );
    assert_code(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, lot0, 1),
        E::BadData,
    );
}

// ------------------------------------------------------------ voiding, CloseLot

#[test]
fn g13_s2_a_seized_vaults_tickets_are_void_and_close() {
    let mut k = Cast::new();
    expect_lands(k.issue_receipt(10), "IssueTickets");
    let tag = k.a.citizen_tag();
    let issue = (tag, 0);
    let lot0 = k.w.a.lot(tag, 0);
    let (ap, aw) = (k.a.player(), k.a.wallet.insecure_clone());
    // A valid lot with units may not be closed; the issue neither.
    assert_code(k.close(&ap, &aw, issue, Some(lot0), false), E::BadData);
    assert_code(k.close(&ap, &aw, issue, None, true), E::BadData);
    // The vault is seized (its generation raised): every ticket is void.
    let v = k.vault();
    k.c.edit(&v, |d| d[VA::GEN] += 1);
    assert_cq(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, k.w.a.lot(tag, 1), 1),
        Cq::TicketVoid,
    );
    // The void lot closes, lowering the supply; then the issue.
    let l = expect_lands(k.close(&ap, &aw, issue, Some(lot0), false), "CloseLot");
    assert!(
        k.c.account(&lot0).is_none_or(|a| a.data.is_empty()),
        "the lot is closed"
    );
    assert_eq!(u64_at(&k.c.data(&k.w.a.issue(tag, 0)), IS::SUPPLY), 0);
    match event(&l, CqKind::LOT_CLOSED) {
        fclient::conquest::CqEvent::LotClosed {
            lot,
            amount,
            void,
            lot_closed,
            issue_closed,
            ..
        } => {
            assert_eq!(
                (lot, amount, void, lot_closed, issue_closed),
                ((tag, 0), 10, true, true, false)
            );
        }
        e => panic!("{e:?}"),
    }
    expect_lands(k.close(&ap, &aw, issue, None, true), "CloseLot");
    assert!(
        k.c.account(&k.w.a.issue(tag, 0))
            .is_none_or(|a| a.data.is_empty()),
        "the issue is closed"
    );
    assert_eq!(k.counters(&k.a).2, 0);
}

#[test]
fn g13_s2_an_empty_lot_and_its_issue_close() {
    let mut k = Cast::new();
    expect_lands(k.issue_receipt(2), "IssueTickets");
    let tag = k.a.citizen_tag();
    let issue = (tag, 0);
    let lot0 = k.w.a.lot(tag, 0);
    let (ap, aw) = (k.a.player(), k.a.wallet.insecure_clone());
    // Everything to R, then A's empty lot closes; R's lot keeps the issue open.
    let lot1 = k.w.a.lot(tag, 1);
    expect_lands(
        k.give(&ap, &aw, lot0, issue, k.r.citizen, lot1, 2),
        "GiveLot",
    );
    expect_lands(k.close(&ap, &aw, issue, Some(lot0), false), "CloseLot");
    assert_code(k.close(&ap, &aw, issue, None, true), E::BadData);
    // Not R's to close the issue; R may not close A's... R's lot is valid and full.
    let (rp, rw) = (k.r.player(), k.r.wallet.insecure_clone());
    assert_code(k.close(&rp, &rw, issue, Some(lot1), false), E::BadData);
    assert_code(k.close(&rp, &rw, issue, None, true), E::NotOwner);
}
