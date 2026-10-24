//! S2 stage 2b: share tickets (`docs/frontier/stage2/S2-2B-CONTRACT.md`) on
//! the test-beacon build: OpenShares, deposits by SettleDeposit and
//! WithdrawShares — their effects (`g13_s2_*` with the lands paths) and
//! refusals, and the guards 2b adds to SendCaravan, SettleCaravan,
//! CloseVault, IssueTickets, SeizeVault, GiveLot and CloseLot.
//!
//! Crafted state (`world::conquest`): the Season's conquest block,
//! Province / Citizen / Holding v2, a vault's stores, the resolves and a
//! captor's host on the vault's tile. Every instruction itself goes through
//! the program, built by fclient's builders.

mod common;

use fclient::ix::v2::{self as fx, PlaceRef, SendCaravanArgs, TicketSource, WithdrawSharesArgs};
use fclient::ix::Player;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::layout::s2::{issue as IS, lot as LT};
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
use permutation_rules::frontier::ticket::{KIND_RECEIPT, KIND_SHARE, NO_END, STATE_LIVE};

const B0: u32 = 20;
const MILLI: i64 = 1_000;
const WOOD: usize = 1;
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
    keeper: Keypair,
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
        let keeper = c.funded(b"s2-keeper", 1);
        let mut k = Cast {
            c,
            w,
            a,
            r,
            vt: 0,
            keeper,
        };
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

    fn issue(&self) -> Address {
        self.w.a.issue(self.tag(), 0)
    }

    fn lot_of(&self, e: &Estate) -> Address {
        self.w.a.deposit_lot(e.citizen_tag(), self.tag(), 0)
    }

    fn open(&mut self, e: &Estate) -> SendResult {
        let seq = u32_at(&self.c.data(&e.citizen), C::ISSUES);
        let ix = fx::open_shares(
            &self.w.a,
            &e.player(),
            e.href(),
            (self.a.p, self.a.q, self.vt),
            e.citizen_tag(),
            seq,
        );
        s2_send(&mut self.c, I2::OpenShares, ix, &[&e.wallet])
    }

    /// `e` sends `cargo` from its holding into the vault (its `seq`-th
    /// caravan).
    fn send_in(&mut self, e: &Estate, cargo: [u32; 8]) -> (SendResult, Address) {
        let seq = u32_at(&self.c.data(&e.citizen), C::CARAVANS);
        let (steps, path) = local_path(&self.c, e, e.tile, self.vt);
        let x = SendCaravanArgs {
            seq,
            src: PlaceRef::Holding {
                h: e.href(),
                gen: e.gen,
            },
            dst: self.vault_place(1),
            steps,
            path,
            cargo,
            fee: CARAVAN_FEE,
            provinces: vec![(e.p, e.q)],
        };
        let ix = fx::send_caravan(&self.w.a, &e.player(), &x);
        let r = s2_send(&mut self.c, I2::SendCaravan, ix, &[&e.wallet]);
        (r, self.w.a.caravan(e.citizen_tag(), seq))
    }

    /// Past the caravan's arrival and the resolve of its bells.
    fn arrive(&mut self, caravan: &Address) {
        let d = self.c.data(caravan);
        let arrive = i64_at(&d, CV::ARRIVE_TS);
        let last = u32_at(&d, CV::LAST_BELL);
        if self.c.now <= arrive {
            self.c.set_time(arrive + 1);
        }
        let b = self.w.bell(&self.c).max(last + 1);
        self.w.set_resolved_next(&mut self.c, &self.a.province, b);
    }

    fn rent_to(&self, caravan: &Address) -> Address {
        Address::new_from_array(
            self.c.data(caravan)[CV::RENT_TO..CV::RENT_TO + 32]
                .try_into()
                .unwrap(),
        )
    }

    fn settle(&mut self, caravan: Address) -> SendResult {
        let ix = fx::settle_caravan(
            &self.w.a,
            self.keeper.pubkey(),
            caravan,
            self.vault(),
            self.keeper.pubkey(),
            self.rent_to(&caravan),
            &[(self.a.p, self.a.q)],
        );
        let kp = self.keeper.insecure_clone();
        s2_send(&mut self.c, I2::SettleCaravan, ix, &[&kp])
    }

    fn settle_deposit(&mut self, caravan: Address, holder: &Estate) -> SendResult {
        let ix = fx::settle_deposit(
            &self.w.a,
            self.keeper.pubkey(),
            caravan,
            self.vault(),
            self.keeper.pubkey(),
            self.rent_to(&caravan),
            (self.tag(), 0),
            holder.citizen_tag(),
            &[(self.a.p, self.a.q)],
        );
        let kp = self.keeper.insecure_clone();
        s2_send(&mut self.c, I2::SettleDeposit, ix, &[&kp])
    }

    /// `e` sends a deposit and it settles.
    fn deposit(&mut self, e: &Estate, cargo: [u32; 8]) -> Landed {
        let (r, cv) = self.send_in(e, cargo);
        expect_lands(r, "SendCaravan into the shared vault");
        self.arrive(&cv);
        expect_lands(self.settle_deposit(cv, e), "SettleDeposit")
    }

    fn withdraw_args(&self, e: &Estate, amount: u64) -> WithdrawSharesArgs {
        let (steps, path) = local_path(&self.c, e, self.vt, e.tile);
        WithdrawSharesArgs {
            lot: self.lot_of(e),
            issue: (self.tag(), 0),
            vault: (self.a.p, self.a.q, self.vt),
            amount,
            seq: u32_at(&self.c.data(&e.citizen), C::CARAVANS),
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

    fn withdraw(&mut self, by: &Player, signer: &Keypair, x: &WithdrawSharesArgs) -> SendResult {
        let ix = fx::withdraw_shares(&self.w.a, by, x);
        s2_send(&mut self.c, I2::WithdrawShares, ix, &[signer])
    }

    fn supply(&self) -> u64 {
        u64_at(&self.c.data(&self.issue()), IS::SUPPLY)
    }

    fn units(&self, e: &Estate) -> u64 {
        u64_at(&self.c.data(&self.lot_of(e)), LT::AMOUNT)
    }

    fn session(&mut self, e: &Estate) -> (Keypair, Player) {
        let session = self.c.funded(b"session", 1);
        let exp = self.c.now + 3_600;
        self.c.edit(&e.citizen, |d| {
            d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
            d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
        });
        let p = Player {
            actor: session.pubkey(),
            payer: session.pubkey(),
            wallet: e.wallet.pubkey(),
        };
        (session, p)
    }
}

fn wood(n: u32) -> [u32; 8] {
    let mut c = [0; 8];
    c[WOOD] = n;
    c
}

fn ore(n: u32) -> [u32; 8] {
    let mut c = [0; 8];
    c[ORE] = n;
    c
}

// ------------------------------------------------------------ open, deposit, withdraw

#[test]
fn g13_s2_open_deposit_and_withdraw_shares() {
    let mut k = Cast::new();
    k.set_store(WOOD, 100);
    let a = clone_estate(&k.a);
    let l = expect_lands(k.open(&a), "OpenShares");
    let d = k.c.data(&k.issue());
    assert_eq!(
        (d[IS::KIND], d[IS::STATE], d[IS::SRC_KIND], d[IS::SRC_GEN]),
        (KIND_SHARE, STATE_LIVE, 2, 1)
    );
    assert_eq!((k.supply(), k.units(&a)), (100, 100));
    let v = k.c.data(&k.vault());
    assert_eq!(
        (
            v[VA::SHARES_ON],
            u32_at(&v, VA::SHARES_SEQ),
            u64_at(&v, VA::SHARES_ISSUER_TAG)
        ),
        (1, 0, k.tag())
    );
    let cd = k.c.data(&a.citizen);
    assert_eq!(
        (u32_at(&cd, C::ISSUES), u32_at(&cd, C::LOTS), cd[C::OPEN_ISSUES]),
        (1, 0, 1)
    );
    match event(&l, CqKind::SHARES_OPENED) {
        fclient::conquest::CqEvent::SharesOpened {
            issuer_tag,
            supply,
            lot_seq,
            src,
            ..
        } => {
            assert_eq!((issuer_tag, supply), (k.tag(), 100));
            assert_eq!(lot_seq, frontier_abi::v2::addr::deposit_seq(k.tag(), 0));
            assert_eq!((src.kind, src.at), (2, k.vt));
        }
        e => panic!("{e:?}"),
    }
    // R deposits 50 ore (value 100) at the vault's price: 100 units.
    let r = clone_estate(&k.r);
    let (sent, cv) = k.send_in(&r, ore(50));
    expect_lands(sent, "SendCaravan into the shared vault");
    k.arrive(&cv);
    assert_cq(k.settle(cv), Cq::VaultShared);
    let l = expect_lands(k.settle_deposit(cv, &r), "SettleDeposit");
    assert!(k.c.is_absent(&cv), "the caravan closed");
    assert_eq!(k.store(ORE), 50 * MILLI);
    assert_eq!((k.supply(), k.units(&r)), (200, 100));
    let ld = k.c.data(&k.lot_of(&r));
    assert_eq!(
        (u64_at(&ld, LT::HOLDER_TAG), u64_at(&ld, LT::SEED_TAG)),
        (r.citizen_tag(), r.citizen_tag())
    );
    assert_eq!(&ld[LT::HOLDER_CITIZEN..LT::HOLDER_CITIZEN + 32], r.citizen.as_ref());
    match event(&l, CqKind::SHARES_DEPOSITED) {
        fclient::conquest::CqEvent::SharesDeposited {
            holder_tag,
            value,
            minted,
            supply,
            new_lot,
            ..
        } => assert_eq!(
            (holder_tag, value, minted, supply, new_lot),
            (r.citizen_tag(), 100, 100, 200, true)
        ),
        e => panic!("{e:?}"),
    }
    // A deposits 50 wood into its own shared vault: 50 more units, the lot
    // it already has.
    let l = k.deposit(&a, wood(50));
    assert_eq!((k.supply(), k.units(&a)), (250, 150));
    match event(&l, CqKind::SHARES_DEPOSITED) {
        fclient::conquest::CqEvent::SharesDeposited { minted, new_lot, .. } => {
            assert_eq!((minted, new_lot), (50, false))
        }
        e => panic!("{e:?}"),
    }
    // R withdraws its 100 units of 250 by the session key: 2/5 of each
    // store, home.
    let (s, sp) = k.session(&r);
    let x = k.withdraw_args(&r, 100);
    let l = expect_lands(k.withdraw(&sp, &s, &x), "WithdrawShares");
    assert_eq!((k.store(WOOD), k.store(ORE)), (90 * MILLI, 30 * MILLI));
    assert_eq!((k.supply(), k.units(&r)), (150, 0));
    let cv = k.w.a.caravan(r.citizen_tag(), x.seq);
    let cd = k.c.data(&cv);
    assert_eq!(
        (i64_at(&cd, CV::cargo(WOOD)), i64_at(&cd, CV::cargo(ORE))),
        (60 * MILLI, 20 * MILLI)
    );
    assert_eq!(&cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32], r.citizen.as_ref());
    match event(&l, CqKind::SHARES_WITHDRAWN) {
        fclient::conquest::CqEvent::SharesWithdrawn {
            holder_tag,
            amount,
            supply,
            caravan_seq,
            ..
        } => assert_eq!(
            (holder_tag, amount, supply, caravan_seq),
            (r.citizen_tag(), 100, 150, x.seq)
        ),
        e => panic!("{e:?}"),
    }
    let _ = event(&l, CqKind::CARAVAN_SENT);
}

#[test]
fn g13_s2_a_shared_vault_is_the_holders() {
    let mut k = Cast::new();
    k.set_store(WOOD, 100);
    let a = clone_estate(&k.a);
    expect_lands(k.open(&a), "OpenShares");
    // Opened once.
    assert_cq(k.open(&a), Cq::VaultShared);
    // The owner's plain send out of it.
    let (steps, path) = local_path(&k.c, &a, k.vt, a.tile);
    let x = SendCaravanArgs {
        seq: 0,
        src: k.vault_place(1),
        dst: PlaceRef::Holding { h: a.href(), gen: a.gen },
        steps,
        path,
        cargo: wood(10),
        fee: CARAVAN_FEE,
        provinces: vec![(a.p, a.q)],
    };
    let ix = fx::send_caravan(&k.w.a, &a.player(), &x);
    assert_cq(s2_send(&mut k.c, I2::SendCaravan, ix, &[&a.wallet]), Cq::VaultShared);
    // Its close.
    let ix = fx::close_vault(&k.w.a, &a.player(), (a.p, a.q, k.vt), a.wallet.pubkey());
    assert_cq(s2_send(&mut k.c, I2::CloseVault, ix, &[&a.wallet]), Cq::VaultShared);
    // A receipt on it.
    let ix = fx::issue_tickets(
        &k.w.a,
        &a.player(),
        a.href(),
        TicketSource::Vault { p: a.p, q: a.q, tile: k.vt },
        a.citizen_tag(),
        1,
        0,
        &fx::IssueArgs {
            kind: KIND_RECEIPT,
            resource: 1,
            amount: 1,
            per_unit: 1_000,
            until_day: NO_END,
        },
    );
    assert_cq(s2_send(&mut k.c, I2::IssueTickets, ix, &[&a.wallet]), Cq::VaultShared);
    // The deposit lot is not given whole in place.
    let lot = k.lot_of(&a);
    let ix = fx::give_lot(
        &k.w.a,
        &a.player(),
        lot,
        (k.tag(), 0),
        TicketSource::Vault { p: a.p, q: a.q, tile: k.vt },
        k.r.citizen,
        lot,
        100,
    );
    assert_code(s2_send(&mut k.c, I2::GiveLot, ix, &[&a.wallet]), E::BadData);
    // Withdrawals: more than the lot, by another, an empty basket; R's
    // lot is absent.
    let r = clone_estate(&k.r);
    let mut x = k.withdraw_args(&a, 101);
    assert_code(k.withdraw(&a.player(), &a.wallet, &x), E::BadData);
    x.amount = 0;
    assert_code(k.withdraw(&a.player(), &a.wallet, &x), E::BadData);
    let mut xr = k.withdraw_args(&r, 1);
    xr.lot = k.lot_of(&a);
    assert_code(k.withdraw(&r.player(), &r.wallet, &xr), E::NotOwner);
    k.set_store(WOOD, 0);
    k.c.edit(&k.vault(), |d| {
        d[VA::store(WOOD)..VA::store(WOOD) + 8].copy_from_slice(&999i64.to_le_bytes())
    });
    let x = k.withdraw_args(&a, 1);
    assert_code(k.withdraw(&a.player(), &a.wallet, &x), E::BadData);
    // A plain settle into an unshared vault by SettleDeposit is refused.
    k.set_store(WOOD, 100);
    let mut k2 = Cast::new();
    let a2 = clone_estate(&k2.a);
    let (sent, cv) = k2.send_in(&a2, wood(5));
    expect_lands(sent, "SendCaravan");
    k2.arrive(&cv);
    assert_code(k2.settle_deposit(cv, &a2), E::BadAccount);
}

// ------------------------------------------------------------ seizure, close

#[test]
fn g13_s2_a_seizure_voids_the_shares() {
    let mut k = Cast::new();
    k.set_store(WOOD, 100);
    let (a, r) = (clone_estate(&k.a), clone_estate(&k.r));
    expect_lands(k.open(&a), "OpenShares");
    // R stands on the vault and seizes it.
    let province = a.province;
    k.w.craft_host(&mut k.c, &r, &province, 0, 0, 0, 500, k.vt);
    let ix = fx::seize_vault(&k.w.a, &r.player(), (a.p, a.q, k.vt), r.href(), a.citizen, 0);
    expect_lands(s2_send(&mut k.c, I2::SeizeVault, ix, &[&r.wallet]), "SeizeVault");
    let v = k.c.data(&k.vault());
    assert_eq!((v[VA::SHARES_ON], v[VA::GEN]), (0, 2));
    // A's units are void: no withdrawal.
    let x = k.withdraw_args(&a, 10);
    assert_cq(k.withdraw(&a.player(), &a.wallet, &x), Cq::TicketVoid);
    // A closes its void lot and the issue; the vault is not cleared again.
    let rent = |c: &Chain, key: &Address, at: usize| {
        Address::new_from_array(c.data(key)[at..at + 32].try_into().unwrap())
    };
    let lot = k.lot_of(&a);
    let src = TicketSource::Vault { p: a.p, q: a.q, tile: k.vt };
    let issue_rent = rent(&k.c, &k.issue(), IS::RENT_TO);
    let ix = fx::close_lot(
        &k.w.a,
        &a.player(),
        (k.tag(), 0),
        src,
        issue_rent,
        Some((lot, rent(&k.c, &lot, LT::RENT_TO))),
        true,
    );
    let l = expect_lands(s2_send(&mut k.c, I2::CloseLot, ix, &[&a.wallet]), "CloseLot");
    match event(&l, CqKind::LOT_CLOSED) {
        fclient::conquest::CqEvent::LotClosed {
            void,
            issue_closed,
            shares_cleared,
            ..
        } => assert_eq!((void, issue_closed, shares_cleared), (true, true, false)),
        e => panic!("{e:?}"),
    }
    assert_eq!(k.c.data(&a.citizen)[C::OPEN_ISSUES], 0);
}

#[test]
fn g13_s2_closing_the_shares_frees_the_vault() {
    let mut k = Cast::new();
    let a = clone_estate(&k.a);
    // An empty vault opens with no units.
    expect_lands(k.open(&a), "OpenShares");
    assert_eq!((k.supply(), k.units(&a)), (0, 0));
    // The first deposit takes the whole vault.
    k.deposit(&a, wood(20));
    assert_eq!((k.supply(), k.units(&a)), (20, 20));
    // Withdraw everything (home), then close the empty lot and the issue.
    let x = k.withdraw_args(&a, 20);
    expect_lands(k.withdraw(&a.player(), &a.wallet, &x), "WithdrawShares");
    assert_eq!(k.store(WOOD), 0);
    let rent = |c: &Chain, key: &Address, at: usize| {
        Address::new_from_array(c.data(key)[at..at + 32].try_into().unwrap())
    };
    let lot = k.lot_of(&a);
    let src = TicketSource::Vault { p: a.p, q: a.q, tile: k.vt };
    let issue_rent = rent(&k.c, &k.issue(), IS::RENT_TO);
    let ix = fx::close_lot(
        &k.w.a,
        &a.player(),
        (k.tag(), 0),
        src,
        issue_rent,
        Some((lot, rent(&k.c, &lot, LT::RENT_TO))),
        true,
    );
    let l = expect_lands(s2_send(&mut k.c, I2::CloseLot, ix, &[&a.wallet]), "CloseLot");
    match event(&l, CqKind::LOT_CLOSED) {
        fclient::conquest::CqEvent::LotClosed { shares_cleared, .. } => assert!(shares_cleared),
        e => panic!("{e:?}"),
    }
    assert_eq!(k.c.data(&k.vault())[VA::SHARES_ON], 0);
    // The vault is A's own again: it closes.
    let vr = Address::new_from_array(
        k.c.data(&k.vault())[VA::RENT_TO..VA::RENT_TO + 32]
            .try_into()
            .unwrap(),
    );
    let ix = fx::close_vault(&k.w.a, &a.player(), (a.p, a.q, k.vt), vr);
    expect_lands(s2_send(&mut k.c, I2::CloseVault, ix, &[&a.wallet]), "CloseVault");
}

fn clone_estate(e: &Estate) -> Estate {
    Estate {
        wallet: e.wallet.insecure_clone(),
        ..*e
    }
}
