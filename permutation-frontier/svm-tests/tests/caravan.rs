//! S1 stage 1b: vaults and caravans (`docs/frontier/stage1b/S1-1B-CONTRACT.md`)
//! on the test-beacon build: BuildVault, SendCaravan, SettleCaravan,
//! RaidCaravan, SeizeVault, CloseVault and DefaultRaid — their effects
//! (`g13_s1_*` with the lands paths) and refusals (one per (instruction,
//! code)).
//!
//! Crafted state (`world::conquest`, module note): the Season's conquest
//! block, Province / Citizen / Holding v2, hosts on a tile, the resolves
//! (`set_resolved_next`), and an **open raid** in a caravan slot: until
//! stage 1c the clash does not raid caravans, so these tests write the slot
//! as the clash will (`RAID_OFF`, `RAIDER`, `CARRY`). Every S1 instruction
//! itself goes through the program, built by fclient's builders.

mod common;

use fclient::ix::v2::{self as fx, DefaultRaidArgs, PlaceRef, RaidCaravanArgs, SendCaravanArgs};
use fclient::ix::Player;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{caravan_slot as CS, province as P};
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::log::{caravan_outcome, raid_choice, AnyKind, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{
    i64_at, read_kholding, trace, u32_at, u64_at, Estate,
};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair, Signer};
use permutation_rules::frontier::caravan::{
    self as kc, caravan_id, CaravanSlot, CARAVAN_FEE, MAX_CARAVAN_SLOTS, MAX_VAULTS,
    RAID_DECIDE_BELLS,
};

/// The bell the tests start in.
const B0: u32 = 20;
const MILLI: i64 = 1_000;

// ------------------------------------------------------------ worlds

fn s1_world() -> (Chain, World) {
    let mut c = Chain::new(Build::TestBeacon);
    let w = World::running(&mut c, 1);
    w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
    w.to_bell(&mut c, B0, 5);
    (c, w)
}

/// A ring-4 Province of wedge `w` (outside every heartland).
fn ring4(w: u8, i: usize) -> (i16, i16) {
    provinces_of(4, Some(w))[i]
}

fn s1_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    let loaded = permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

/// The cast: A (faction 0) owns a first holding in Province T with every
/// tile opened (plains), and the vault tile `vt` four steps from A's
/// holding; R (faction 1) owns site 1 of T (a raider next door).
struct Cast {
    c: Chain,
    w: World,
    a: Estate,
    r: Estate,
    /// The vault tile (not a site).
    vt: u8,
}

impl Cast {
    fn new() -> Cast {
        let (mut c, w) = s1_world();
        let t = ring4(0, 0);
        let a = w.cq_estate(&mut c, "a", 0, t, 0);
        let r = w.cq_estate(&mut c, "r", 1, t, 1);
        w.open_tiles(&mut c, t.0, t.1, &(0..61).collect::<Vec<u8>>());
        w.enrich(&mut c, &a, 5_000);
        w.enrich(&mut c, &r, 5_000);
        let vt = far_tile(&c, &w, &a, 4);
        Cast { c, w, a, r, vt }
    }

    fn player(&self) -> Player {
        self.a.player()
    }

    /// A builds a vault on `vt`.
    fn build_vault(&mut self) -> SendResult {
        let ix = fx::build_vault(
            &self.w.a,
            &self.player(),
            self.a.href(),
            (self.a.p, self.a.q),
            self.vt,
        );
        s1_send(&mut self.c, I2::BuildVault, ix, &[&self.a.wallet])
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

    /// A sends `cargo` from its holding to its vault.
    fn send_args(&self, seq: u32, cargo: [u32; 8]) -> SendCaravanArgs {
        let (steps, path) = local_path(&self.c, &self.w, &self.a, self.a.tile, self.vt);
        SendCaravanArgs {
            seq,
            src: PlaceRef::Holding {
                h: self.a.href(),
                gen: self.a.gen,
            },
            dst: self.vault_place(1),
            steps,
            path,
            cargo,
            fee: CARAVAN_FEE,
            provinces: vec![(self.a.p, self.a.q)],
        }
    }

    fn send(&mut self, x: &SendCaravanArgs) -> SendResult {
        let ix = fx::send_caravan(&self.w.a, &self.player(), x);
        s1_send(&mut self.c, I2::SendCaravan, ix, &[&self.a.wallet])
    }

    fn caravan(&self, seq: u32) -> Address {
        self.w.a.caravan(self.a.citizen_tag(), seq)
    }

    /// Moves past the caravan's arrival and resolves its Province past its
    /// last slot bell (crafted resolves).
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

    fn settle(&mut self, caravan: Address, dst: Address, by: &Keypair) -> SendResult {
        let rent_to = Address::new_from_array(
            self.c.data(&caravan)[CV::RENT_TO..CV::RENT_TO + 32]
                .try_into()
                .unwrap(),
        );
        let ix = fx::settle_caravan(
            &self.w.a,
            by.pubkey(),
            caravan,
            dst,
            by.pubkey(),
            rent_to,
            &[(self.a.p, self.a.q)],
        );
        s1_send(&mut self.c, I2::SettleCaravan, ix, &[by])
    }
}

/// A non-site tile of the estate's Province exactly `n` steps (inside the
/// Province) from the holding's tile.
fn far_tile(c: &Chain, w: &World, e: &Estate, n: usize) -> u8 {
    let pd = c.data(&e.province);
    let sites = &pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize];
    (0..61u8)
        .find(|&t| {
            !sites.contains(&t) && local_dirs(c, w, e, e.tile, t).is_some_and(|d| d.len() == n)
        })
        .expect("a tile n steps away")
}

/// A shortest path from `from` to `to` over the passable tiles of the
/// estate's Province, never leaving it.
fn local_dirs(c: &Chain, _w: &World, e: &Estate, from: u8, to: u8) -> Option<Vec<u8>> {
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
            return Some(dirs);
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
    None
}

fn local_path(c: &Chain, w: &World, e: &Estate, from: u8, to: u8) -> (u8, [u8; 12]) {
    let dirs = local_dirs(c, w, e, from, to).expect("a path");
    (dirs.len() as u8, kc::pack(&dirs).expect("packs"))
}

/// Every caravan slot of a Province.
fn slots(c: &Chain, province: &Address) -> Vec<CaravanSlot> {
    let d = c.data(province);
    (0..MAX_CARAVAN_SLOTS)
        .map(|i| CaravanSlot::decode(&d[CS::at(i)..CS::at(i) + CS::SIZE]).unwrap())
        .collect()
}

/// The slot of caravan `id` (index and record).
fn slot_of(c: &Chain, province: &Address, id: u64) -> Option<(usize, CaravanSlot)> {
    slots(c, province)
        .into_iter()
        .enumerate()
        .find(|(_, s)| s.id == id)
}

fn put_slot(c: &mut Chain, province: &Address, i: usize, s: &CaravanSlot) {
    c.edit(province, |d| {
        assert!(s.encode(&mut d[CS::at(i)..CS::at(i) + CS::SIZE]).is_some());
    });
}

fn store(c: &Chain, holding: &Address, r: usize) -> i64 {
    read_kholding(&c.data(holding)).stores[r].value
}

fn vault_store(c: &Chain, vault: &Address, r: usize) -> i64 {
    i64_at(&c.data(vault), VA::store(r))
}

/// Parses the one S1 record of `k` with fclient's decoder.
#[track_caller]
fn event(l: &Landed, k: CqKind) -> fclient::conquest::CqEvent {
    // one record of the kind, its tail within chains_of
    let _ = records::one_cq(&l.logs, k);
    let body = records::bodies(&l.logs)
        .into_iter()
        .find(|b| frontier_abi::v2::log::decode(b).is_ok_and(|r| r.kind == AnyKind::Cq(k)))
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

fn session_of(c: &mut Chain, e: &Estate, label: &[u8]) -> Keypair {
    let session = c.funded(label, 1);
    let exp = c.now + 3_600;
    c.edit(&e.citizen, |d| {
        d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
        d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
    });
    session
}

fn by_session(e: &Estate, session: &Keypair) -> Player {
    Player {
        actor: session.pubkey(),
        payer: session.pubkey(),
        wallet: e.wallet.pubkey(),
    }
}

// ------------------------------------------------------------ BuildVault

#[test]
fn g13_s1_build_vault_lands_pays_and_counts() {
    let mut k = Cast::new();
    let before: Vec<i64> = (0..8).map(|r| store(&k.c, &k.a.holding, r)).collect();
    let l = expect_lands(k.build_vault(), "BuildVault");
    let d = k.c.data(&k.vault());
    assert_eq!(d[VA::STATE], VA::STATE_LIVE);
    assert_eq!(d[VA::GEN], 1);
    assert_eq!(d[VA::FACTION], 0);
    assert_eq!(
        &d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32],
        k.a.citizen.as_ref()
    );
    assert_eq!(u64_at(&d, VA::OWNER_TAG), k.a.citizen_tag());
    assert_eq!(i64_at(&d, VA::CAP), kc::VAULT_CAP);
    assert_eq!(
        &d[VA::RENT_TO..VA::RENT_TO + 32],
        k.a.wallet.pubkey().as_ref()
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::VAULTS], 1);
    let cost = kc::vault_cost();
    for (r, b) in before.iter().enumerate() {
        let now = store(&k.c, &k.a.holding, r);
        // production since the enrich only adds; the cost is taken
        assert!(
            now <= b - cost[r] + 10 * MILLI && now >= b - cost[r] - 10 * MILLI,
            "store {r}"
        );
    }
    match event(&l, CqKind::VAULT_BUILT) {
        fclient::conquest::CqEvent::VaultBuilt {
            tile,
            owner_tag,
            gen,
            ..
        } => {
            assert_eq!((tile, owner_tag, gen), (k.vt, k.a.citizen_tag(), 1));
        }
        e => panic!("{e:?}"),
    }
}

#[test]
fn g13_s1_build_vault_refusals() {
    let mut k = Cast::new();
    // A site tile.
    let ix = fx::build_vault(&k.w.a, &k.player(), k.a.href(), (k.a.p, k.a.q), k.r.tile);
    assert_cq(
        s1_send(&mut k.c, I2::BuildVault, ix, &[&k.a.wallet]),
        Cq::VaultSite,
    );
    // An impassable tile.
    let t = k.vt;
    k.c.edit(&k.a.province, |d| {
        let m = u64_at(d, P::PASSABLE_MASK) & !(1u64 << t);
        d[P::PASSABLE_MASK..P::PASSABLE_MASK + 8].copy_from_slice(&m.to_le_bytes());
    });
    assert_cq(k.build_vault(), Cq::VaultSite);
    k.w.open_tiles(&mut k.c, k.a.p, k.a.q, &[t]);
    // The limit.
    k.c.edit(&k.a.citizen, |d| d[C::VAULTS] = MAX_VAULTS);
    assert_cq(k.build_vault(), Cq::VaultLimit);
    k.c.edit(&k.a.citizen, |d| d[C::VAULTS] = 0);
    // The cost.
    let now = k.c.now;
    k.w.edit_kholding(&mut k.c, &k.a, |h| {
        for s in h.stores.iter_mut() {
            s.value = 0;
            s.frac = 0;
        }
        h.production = [0; 8];
        let _ = now;
    });
    assert_code(k.build_vault(), E::Insufficient);
    k.w.enrich(&mut k.c, &k.a, 5_000);
    // A vault already there.
    expect_lands(k.build_vault(), "BuildVault");
    assert_cq(k.build_vault(), Cq::VaultSite);
}

// ------------------------------------------------------------ SendCaravan, SettleCaravan

#[test]
fn g13_s1_send_and_settle_to_own_vault() {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    let cargo = [0, 100, 0, 0, 0, 30, 0, 0];
    let x = k.send_args(0, cargo);
    let before: Vec<i64> = (0..8).map(|r| store(&k.c, &k.a.holding, r)).collect();
    let l = expect_lands(k.send(&x), "SendCaravan");
    let cv = k.caravan(0);
    let d = k.c.data(&cv);
    assert_eq!(d[CV::STATE], CV::STATE_MOVING);
    assert_eq!(u64_at(&d, CV::FEE), CARAVAN_FEE);
    assert_eq!(i64_at(&d, CV::cargo(1)), 100 * MILLI);
    assert_eq!(i64_at(&d, CV::cargo(5)), 30 * MILLI);
    assert_eq!(u32_at(&k.c.data(&k.a.citizen), C::CARAVANS), 1);
    for r in [1usize, 5] {
        let taken = before[r] - store(&k.c, &k.a.holding, r);
        assert!(
            (cargo[r] as i64 * MILLI - 10 * MILLI..=cargo[r] as i64 * MILLI).contains(&taken),
            "debit {r}"
        );
    }
    // Four steps of 180 s cross at least one bell start: a slot.
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (_, s) = slot_of(&k.c, &k.a.province, id).expect("a slot");
    assert!(s.n >= 1 && !s.raid_open());
    match event(&l, CqKind::CARAVAN_SENT) {
        fclient::conquest::CqEvent::CaravanSent {
            seq,
            cargo: c8,
            runs,
            steps,
            ..
        } => {
            assert_eq!((seq, c8, steps), (0, cargo, x.steps));
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].first_bell, s.first_bell);
        }
        e => panic!("{e:?}"),
    }
    // Early: before the arrival, then before the resolve of its bells.
    let keeper = k.c.funded(b"s1-keeper", 1);
    assert_cq(k.settle(cv, k.vault(), &keeper), Cq::CaravanEarly);
    let arrive = i64_at(&k.c.data(&cv), CV::ARRIVE_TS);
    k.c.set_time(arrive + 1);
    assert_cq(k.settle(cv, k.vault(), &keeper), Cq::CaravanEarly);
    k.arrive(&cv);
    let rent = k.c.lamports(&cv) - CARAVAN_FEE;
    let (kb, ab) = (
        k.c.lamports(&keeper.pubkey()),
        k.c.lamports(&k.a.wallet.pubkey()),
    );
    let l = expect_lands(k.settle(cv, k.vault(), &keeper), "SettleCaravan");
    assert!(k.c.is_absent(&cv), "closed");
    assert_eq!(vault_store(&k.c, &k.vault(), 1), 100 * MILLI);
    assert_eq!(vault_store(&k.c, &k.vault(), 5), 30 * MILLI);
    assert_eq!(k.c.lamports(&keeper.pubkey()) + l.fee, kb + CARAVAN_FEE);
    assert_eq!(k.c.lamports(&k.a.wallet.pubkey()), ab + rent);
    match event(&l, CqKind::CARAVAN_SETTLED) {
        fclient::conquest::CqEvent::CaravanSettled { outcome, fee, .. } => {
            assert_eq!((outcome, fee), (caravan_outcome::DELIVERED, CARAVAN_FEE));
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(
        records::cq_records(&l.logs, CqKind::CARAVAN_SETTLED).len(),
        1
    );
    // Settled once: the Caravan is gone.
    let ix = fx::settle_caravan(
        &k.w.a,
        keeper.pubkey(),
        cv,
        k.vault(),
        keeper.pubkey(),
        k.a.wallet.pubkey(),
        &[(k.a.p, k.a.q)],
    );
    assert_code(
        s1_send(&mut k.c, I2::SettleCaravan, ix, &[&keeper]),
        E::BadAccount,
    );
}

#[test]
fn g13_s1_send_from_vault_to_holding_and_a_lost_destination() {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    k.c.edit(&k.vault(), |d| {
        d[VA::store(2)..VA::store(2) + 8].copy_from_slice(&(500 * MILLI).to_le_bytes())
    });
    let (steps, path) = local_path(&k.c, &k.w, &k.a, k.vt, k.a.tile);
    let x = SendCaravanArgs {
        seq: 0,
        src: k.vault_place(1),
        dst: PlaceRef::Holding {
            h: k.a.href(),
            gen: k.a.gen,
        },
        steps,
        path,
        cargo: [0, 0, 200, 0, 0, 0, 0, 0],
        fee: CARAVAN_FEE,
        provinces: vec![(k.a.p, k.a.q)],
    };
    expect_lands(k.send(&x), "SendCaravan from a vault");
    assert_eq!(vault_store(&k.c, &k.vault(), 2), 300 * MILLI);
    assert_eq!(u32_at(&k.c.data(&k.vault()), VA::SENT), 1);
    let before = store(&k.c, &k.a.holding, 2);
    let cv = k.caravan(0);
    k.arrive(&cv);
    let keeper = k.c.funded(b"s1-keeper", 1);
    expect_lands(
        k.settle(cv, k.a.holding, &keeper),
        "SettleCaravan to a holding",
    );
    assert!(store(&k.c, &k.a.holding, 2) >= before + 200 * MILLI);

    // A second send to the vault, whose generation then changes: lost.
    let x = k.send_args(1, [0, 10, 0, 0, 0, 0, 0, 0]);
    expect_lands(k.send(&x), "SendCaravan");
    k.c.edit(&k.vault(), |d| d[VA::GEN] = 2);
    let cv = k.caravan(1);
    k.arrive(&cv);
    let v1 = vault_store(&k.c, &k.vault(), 1);
    let l = expect_lands(k.settle(cv, k.vault(), &keeper), "SettleCaravan, lost");
    assert_eq!(vault_store(&k.c, &k.vault(), 1), v1);
    match event(&l, CqKind::CARAVAN_SETTLED) {
        fclient::conquest::CqEvent::CaravanSettled { outcome, .. } => {
            assert_eq!(outcome, caravan_outcome::LOST)
        }
        e => panic!("{e:?}"),
    }
}

#[test]
fn g13_s1_send_caravan_refusals() {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    // A wrong sequence, a low fee, no cargo.
    let mut x = k.send_args(1, [0, 10, 0, 0, 0, 0, 0, 0]);
    assert_code(k.send(&x), E::BadData);
    x.seq = 0;
    x.fee = CARAVAN_FEE - 1;
    assert_code(k.send(&x), E::BadData);
    x.fee = CARAVAN_FEE;
    x.cargo = [0; 8];
    assert_code(k.send(&x), E::BadData);
    x.cargo = [0, 10, 0, 0, 0, 0, 0, 0];
    // A path that does not end on the destination.
    let mut bad = x.clone();
    bad.steps -= 1;
    assert_code(k.send(&bad), E::Path);
    // More than the holding has.
    let mut much = x.clone();
    much.cargo = [0, 1_000_000, 0, 0, 0, 0, 0, 0];
    assert_code(k.send(&much), E::Insufficient);
    // A send to another player by the session key.
    let session = session_of(&mut k.c, &k.a, b"s1-session");
    let mut to_r = x.clone();
    let (steps, path) = local_path(&k.c, &k.w, &k.a, k.a.tile, k.r.tile);
    to_r.dst = PlaceRef::Holding {
        h: k.r.href(),
        gen: k.r.gen,
    };
    to_r.steps = steps;
    to_r.path = path;
    let ix = fx::send_caravan(&k.w.a, &by_session(&k.a, &session), &to_r);
    assert_cq(
        s1_send(&mut k.c, I2::SendCaravan, ix, &[&session]),
        Cq::WalletRequired,
    );
    // The session key may send between the actor's own places.
    let ix = fx::send_caravan(&k.w.a, &by_session(&k.a, &session), &x);
    expect_lands(
        s1_send(&mut k.c, I2::SendCaravan, ix, &[&session]),
        "own send by session",
    );
    // The wallet may send to another player.
    to_r.seq = 1;
    expect_lands(k.send(&to_r), "send to R by the wallet");
    // A full Province: every slot taken by caravans still on the road.
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (_, s) = slot_of(&k.c, &k.a.province, id).expect("slot");
    for i in 0..MAX_CARAVAN_SLOTS {
        let mut f = s;
        f.id = caravan_id(0x77, i as u32);
        f.first_bell = s.first_bell + 50;
        put_slot(&mut k.c, &k.a.province, i, &f);
    }
    let mut y = k.send_args(2, [0, 10, 0, 0, 0, 0, 0, 0]);
    y.seq = 2;
    assert_cq(k.send(&y), Cq::ProvinceBusy);
}

// ------------------------------------------------------------ the raid (crafted, until 1c)
//
// Decision J2: a take makes the raided caravan the raider's, with its whole
// cargo, on a new route from the raid tile; a burn empties it and it goes
// on.

/// A's caravan 0 to its vault, its slot raided by R's host (seq 0) at the
/// slot's first bell on A's own site tile (a walk away from R's site).
fn raided() -> (Cast, u32) {
    raided_on(None)
}

/// [`raided`] with the raid tile given (`None`: A's site tile).
fn raided_on(tile: Option<u8>) -> (Cast, u32) {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, [0, 100, 0, 0, 0, 50, 0, 0]);
    expect_lands(k.send(&x), "SendCaravan");
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (i, mut s) = slot_of(&k.c, &k.a.province, id).expect("slot");
    s.raid_off = 0;
    s.raid_pos = 0;
    s.tiles[0] = tile.unwrap_or(k.a.tile);
    s.raider = k.r.host_id(0);
    put_slot(&mut k.c, &k.a.province, i, &s);
    let raid_bell = s.first_bell;
    // The clash of the raid bell has resolved.
    k.w.to_bell(&mut k.c, raid_bell + 1, 5);
    k.w.set_resolved_next(&mut k.c, &k.a.province, raid_bell + 1);
    (k, raid_bell)
}

/// The raided slot's tile.
fn raid_tile(k: &Cast) -> u8 {
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (_, s) = slot_of(&k.c, &k.a.province, id).expect("slot");
    s.tiles[s.raid_off as usize]
}

fn raid_args(k: &Cast, choice: u8) -> RaidCaravanArgs {
    let (steps, path) = local_path(&k.c, &k.w, &k.a, raid_tile(k), k.r.tile);
    RaidCaravanArgs {
        caravan: k.caravan(0),
        raid: (k.a.p, k.a.q),
        raider_holding: k.r.href(),
        choice,
        dst: (choice == raid_choice::TAKE).then_some(PlaceRef::Holding {
            h: k.r.href(),
            gen: k.r.gen,
        }),
        steps,
        path,
        path_provinces: vec![],
        old_route: vec![(k.a.p, k.a.q)],
    }
}

fn raid(k: &mut Cast, x: &RaidCaravanArgs) -> SendResult {
    let ix = fx::raid_caravan(&k.w.a, &k.r.player(), x);
    s1_send(&mut k.c, I2::RaidCaravan, ix, &[&k.r.wallet])
}

/// Settles caravan 0 (its `RENT_TO` A's wallet) at `dst` by `keeper`.
fn settle_at(k: &mut Cast, dst: Address, keeper: &Keypair) -> SendResult {
    let cv = k.caravan(0);
    k.arrive(&cv);
    let ix = fx::settle_caravan(
        &k.w.a,
        keeper.pubkey(),
        cv,
        dst,
        keeper.pubkey(),
        k.a.wallet.pubkey(),
        &[(k.a.p, k.a.q)],
    );
    s1_send(&mut k.c, I2::SettleCaravan, ix, &[keeper])
}

#[test]
fn g13_s1_raid_take_makes_the_caravan_the_raiders() {
    let (mut k, _) = raided();
    let keeper = k.c.funded(b"s1-keeper", 1);
    let cv = k.caravan(0);
    // The open raid holds the caravan.
    let arrive = i64_at(&k.c.data(&cv), CV::ARRIVE_TS);
    if k.c.now <= arrive {
        k.c.set_time(arrive + 1);
    }
    let last = u32_at(&k.c.data(&cv), CV::LAST_BELL);
    let rn = k.w.bell(&k.c).max(last + 1);
    k.w.set_resolved_next(&mut k.c, &k.a.province, rn);
    let ix = fx::settle_caravan(
        &k.w.a,
        keeper.pubkey(),
        cv,
        k.vault(),
        keeper.pubkey(),
        k.a.wallet.pubkey(),
        &[(k.a.p, k.a.q)],
    );
    assert_cq(
        s1_send(&mut k.c, I2::SettleCaravan, ix, &[&keeper]),
        Cq::RaidState,
    );
    // Back inside the raider's window (the clash resolved at +1).
    let (mut k, raid_bell) = raided();
    // Only the raider decides.
    let x = raid_args(&k, raid_choice::TAKE);
    assert!(x.steps > 0, "the caravan walks to R's holding");
    let ix = fx::raid_caravan(&k.w.a, &k.a.player(), &x);
    assert_code(
        s1_send(&mut k.c, I2::RaidCaravan, ix, &[&k.a.wallet]),
        E::NotOwner,
    );
    let lamports = k.c.lamports(&k.r.wallet.pubkey());
    let l = expect_lands(raid(&mut k, &x), "RaidCaravan take");
    // No new account and nothing paid but the transaction fee.
    assert_eq!(k.c.lamports(&k.r.wallet.pubkey()) + l.fee, lamports);
    let cd = k.c.data(&cv);
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    assert_eq!(cd[CV::FACTION], k.r.faction);
    assert_eq!(
        u64_at(&cd, CV::OWNER_TAG),
        k.a.citizen_tag(),
        "the address seed stays"
    );
    assert_eq!(i64_at(&cd, CV::cargo(1)), 100 * MILLI, "the whole cargo");
    assert_eq!(i64_at(&cd, CV::cargo(5)), 50 * MILLI);
    assert_eq!(cd[CV::SRC], frontier_abi::v2::log::log_place::KIND_FIELD);
    assert_eq!(i64_at(&cd, CV::DEPART_TS), k.c.now);
    // The old slot is gone; the new route's slots carry the same id.
    let id = caravan_id(k.a.citizen_tag(), 0);
    for s in slots(&k.c, &k.a.province) {
        if s.id == id {
            assert!(
                s.first_bell > raid_bell && !s.raid_open(),
                "only the new route's slots"
            );
        }
    }
    match event(&l, CqKind::CARAVAN_RAIDED) {
        fclient::conquest::CqEvent::CaravanRaided {
            choice,
            by,
            taken,
            raider_tag,
            dst,
            cleared,
            ..
        } => {
            assert_eq!((choice, by), (raid_choice::TAKE, raid_choice::BY_RAIDER));
            assert_eq!(raider_tag, k.r.citizen_tag());
            assert_eq!((taken[1], taken[5]), (100, 50));
            assert_eq!(dst.kind, frontier_abi::v2::layout::s1::place::KIND_HOLDING);
            assert!(cleared.is_empty(), "one-province route");
        }
        e => panic!("{e:?}"),
    }
    match event(&l, CqKind::CARAVAN_SENT) {
        fclient::conquest::CqEvent::CaravanSent {
            src,
            owner_tag,
            faction,
            ..
        } => {
            assert_eq!(src.kind, frontier_abi::v2::log::log_place::KIND_FIELD);
            assert_eq!(owner_tag, k.a.citizen_tag());
            assert_eq!(faction, k.r.faction);
        }
        e => panic!("{e:?}"),
    }
    // Decided once.
    let again = RaidCaravanArgs {
        choice: raid_choice::BURN,
        dst: None,
        ..x.clone()
    };
    assert_cq(raid(&mut k, &again), Cq::RaidState);
    // The caravan arrives at R's holding with the whole cargo; A's vault
    // gets nothing; A (RENT_TO) gets the rent back.
    let rb = store(&k.c, &k.r.holding, 1);
    let keeper = k.c.funded(b"s1-keeper", 1);
    expect_lands(
        {
            let d = k.r.holding;
            settle_at(&mut k, d, &keeper)
        },
        "settle the taken caravan",
    );
    assert!(store(&k.c, &k.r.holding, 1) >= rb + 100 * MILLI);
    assert_eq!(vault_store(&k.c, &k.vault(), 1), 0);
}

/// A raid on the raider's own site tile: the taken caravan has no step to
/// walk, arrives at once with no slot, and settles home.
#[test]
fn g13_s1_raid_take_on_the_raiders_own_tile() {
    let (mut k, _) = raided();
    let r_tile = k.r.tile;
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (i, mut s) = slot_of(&k.c, &k.a.province, id).unwrap();
    s.tiles[0] = r_tile;
    put_slot(&mut k.c, &k.a.province, i, &s);
    let x = raid_args(&k, raid_choice::TAKE);
    assert_eq!(x.steps, 0);
    expect_lands(raid(&mut k, &x), "RaidCaravan take on the raider's tile");
    let cd = k.c.data(&k.caravan(0));
    assert_eq!(i64_at(&cd, CV::ARRIVE_TS), k.c.now);
    assert!(slot_of(&k.c, &k.a.province, id).is_none(), "no slot");
    let keeper = k.c.funded(b"s1-keeper", 1);
    let rb = store(&k.c, &k.r.holding, 1);
    expect_lands(
        {
            let d = k.r.holding;
            settle_at(&mut k, d, &keeper)
        },
        "settle at once",
    );
    assert!(store(&k.c, &k.r.holding, 1) >= rb + 100 * MILLI);
}

#[test]
fn g13_s1_raid_burn_and_the_window() {
    let (mut k, _) = raided();
    let x = raid_args(&k, raid_choice::BURN);
    let l = expect_lands(raid(&mut k, &x), "burn");
    let cd = k.c.data(&k.caravan(0));
    assert!((0..8).all(|r| i64_at(&cd, CV::cargo(r)) == 0), "all burned");
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.a.citizen.as_ref(),
        "still A's"
    );
    match event(&l, CqKind::CARAVAN_RAIDED) {
        fclient::conquest::CqEvent::CaravanRaided { choice, taken, .. } => {
            assert_eq!(choice, raid_choice::BURN);
            assert_eq!((taken[1], taken[5]), (100, 50), "what burned");
        }
        e => panic!("{e:?}"),
    }
    // The empty caravan goes on and settles at A's vault: nothing arrives.
    let keeper = k.c.funded(b"s1-keeper", 1);
    expect_lands(
        {
            let d = k.vault();
            settle_at(&mut k, d, &keeper)
        },
        "settle the burned caravan",
    );
    assert_eq!(vault_store(&k.c, &k.vault(), 1), 0);
    // A raid the raider let lapse.
    let (mut k, raid_bell) = raided();
    k.w.to_bell(&mut k.c, raid_bell + RAID_DECIDE_BELLS + 1, 5);
    let x = raid_args(&k, raid_choice::BURN);
    assert_cq(raid(&mut k, &x), Cq::RaidWindow);
}

fn default_args(k: &Cast, beneficiary: Address) -> DefaultRaidArgs {
    let x = raid_args(k, raid_choice::TAKE);
    DefaultRaidArgs {
        caravan: k.caravan(0),
        raid: (k.a.p, k.a.q),
        raider_holding: k.r.href(),
        raider_citizen: k.r.citizen,
        steps: x.steps,
        path: x.path,
        beneficiary,
        path_provinces: vec![],
        old_route: vec![(k.a.p, k.a.q)],
    }
}

#[test]
fn g13_s1_default_raid_takes_home_after_the_window() {
    let (mut k, raid_bell) = raided();
    let keeper = k.c.funded(b"s1-keeper", 1);
    let x = default_args(&k, keeper.pubkey());
    let ix = fx::default_raid(&k.w.a, keeper.pubkey(), &x);
    assert_cq(
        s1_send(&mut k.c, I2::DefaultRaid, ix, &[&keeper]),
        Cq::RaidWindow,
    );
    k.w.to_bell(&mut k.c, raid_bell + RAID_DECIDE_BELLS + 1, 5);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.a.province, b);
    let kb = k.c.lamports(&keeper.pubkey());
    let ix = fx::default_raid(&k.w.a, keeper.pubkey(), &x);
    let l = expect_lands(
        s1_send(&mut k.c, I2::DefaultRaid, ix, &[&keeper]),
        "DefaultRaid",
    );
    let cd = k.c.data(&k.caravan(0));
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    assert_eq!(i64_at(&cd, CV::cargo(1)), 100 * MILLI);
    // The keeper is paid the caravan's fee; the caravan settles with none.
    assert_eq!(k.c.lamports(&keeper.pubkey()) + l.fee, kb + CARAVAN_FEE);
    assert_eq!(u64_at(&cd, CV::FEE), 0);
    match event(&l, CqKind::CARAVAN_RAIDED) {
        fclient::conquest::CqEvent::CaravanRaided { by, choice, .. } => {
            assert_eq!((by, choice), (raid_choice::BY_DEFAULT, raid_choice::TAKE))
        }
        e => panic!("{e:?}"),
    }
}

/// No walk home given (`steps` 0): refused until `RAID_BURN_AFTER_BELLS`
/// after the window, then a burn (a raid never stays open for good).
#[test]
fn g13_s1_default_raid_burns_late_without_a_walk_home() {
    let (mut k, raid_bell) = raided();
    let keeper = k.c.funded(b"s1-keeper", 1);
    let mut x = default_args(&k, keeper.pubkey());
    x.steps = 0;
    x.path = [0; 12];
    k.w.to_bell(&mut k.c, raid_bell + RAID_DECIDE_BELLS + 1, 5);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.a.province, b);
    let ix = fx::default_raid(&k.w.a, keeper.pubkey(), &x);
    assert_cq(
        s1_send(&mut k.c, I2::DefaultRaid, ix, &[&keeper]),
        Cq::RaidWindow,
    );
    k.w.to_bell(
        &mut k.c,
        raid_bell + RAID_DECIDE_BELLS + kc::RAID_BURN_AFTER_BELLS + 1,
        5,
    );
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.a.province, b);
    let ix = fx::default_raid(&k.w.a, keeper.pubkey(), &x);
    let l = expect_lands(
        s1_send(&mut k.c, I2::DefaultRaid, ix, &[&keeper]),
        "DefaultRaid late burn",
    );
    let cd = k.c.data(&k.caravan(0));
    assert!((0..8).all(|r| i64_at(&cd, CV::cargo(r)) == 0));
    match event(&l, CqKind::CARAVAN_RAIDED) {
        fclient::conquest::CqEvent::CaravanRaided { by, choice, .. } => {
            assert_eq!((by, choice), (raid_choice::BY_DEFAULT, raid_choice::BURN))
        }
        e => panic!("{e:?}"),
    }
}

#[test]
fn g13_s1_default_raid_burns_when_the_raiders_holding_is_gone() {
    let (mut k, raid_bell) = raided();
    let keeper = k.c.funded(b"s1-keeper", 1);
    k.w.to_bell(&mut k.c, raid_bell + RAID_DECIDE_BELLS + 1, 5);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.a.province, b);
    // R's holding changed hands (a new generation).
    k.c.edit(&k.r.holding, |d| {
        d[frontier_abi::v2::layout::player::holding::GEN] = 2
    });
    let x = default_args(&k, keeper.pubkey());
    let ix = fx::default_raid(&k.w.a, keeper.pubkey(), &x);
    let l = expect_lands(
        s1_send(&mut k.c, I2::DefaultRaid, ix, &[&keeper]),
        "DefaultRaid burn",
    );
    let cd = k.c.data(&k.caravan(0));
    assert!((0..8).all(|r| i64_at(&cd, CV::cargo(r)) == 0));
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.a.citizen.as_ref()
    );
    match event(&l, CqKind::CARAVAN_RAIDED) {
        fclient::conquest::CqEvent::CaravanRaided {
            by,
            choice,
            raider_tag,
            ..
        } => {
            assert_eq!(
                (by, choice, raider_tag),
                (raid_choice::BY_DEFAULT, raid_choice::BURN, 0)
            )
        }
        e => panic!("{e:?}"),
    }
}

// ------------------------------------------------------------ SeizeVault, CloseVault

#[test]
fn g13_s1_seize_vault_by_standing_on_it() {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    k.c.edit(&k.vault(), |d| {
        d[VA::store(1)..VA::store(1) + 8].copy_from_slice(&(70 * MILLI).to_le_bytes())
    });
    let seize = |k: &mut Cast, entry: u8| {
        let ix = fx::seize_vault(
            &k.w.a,
            &k.r.player(),
            (k.a.p, k.a.q, k.vt),
            k.r.href(),
            k.a.citizen,
            entry,
        );
        s1_send(&mut k.c, I2::SeizeVault, ix, &[&k.r.wallet])
    };
    // No host of R on the tile.
    assert_cq(seize(&mut k, 0), Cq::NotOnTile);
    let province = k.a.province;
    k.w.craft_host(&mut k.c, &k.r, &province, 0, 0, 0, 500, k.vt);
    // An owner's host on the tile too.
    k.w.craft_host(&mut k.c, &k.a, &province, 1, 0, 0, 500, k.vt);
    assert_cq(seize(&mut k, 0), Cq::NotOnTile);
    k.c.edit(&province, |d| {
        let o = P::entry(1);
        d[o..o + frontier_abi::layout::province::entry::SIZE].fill(0);
        d[P::N_ENTRIES] -= 1;
    });
    // The captor's limit.
    k.c.edit(&k.r.citizen, |d| d[C::VAULTS] = MAX_VAULTS);
    assert_cq(seize(&mut k, 0), Cq::VaultLimit);
    k.c.edit(&k.r.citizen, |d| d[C::VAULTS] = 0);
    let l = expect_lands(seize(&mut k, 0), "SeizeVault");
    let d = k.c.data(&k.vault());
    assert_eq!(
        &d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    assert_eq!((d[VA::GEN], d[VA::FACTION]), (2, 1));
    assert_eq!(
        vault_store(&k.c, &k.vault(), 1),
        70 * MILLI,
        "the goods stay"
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::VAULTS], 0);
    assert_eq!(k.c.data(&k.r.citizen)[C::VAULTS], 1);
    match event(&l, CqKind::VAULT_SEIZED) {
        fclient::conquest::CqEvent::VaultSeized {
            captor_tag,
            prev_tag,
            new_gen,
            domestic,
            ..
        } => {
            assert_eq!(
                (captor_tag, prev_tag, new_gen, domestic),
                (k.r.citizen_tag(), k.a.citizen_tag(), 2, false)
            );
        }
        e => panic!("{e:?}"),
    }
}

#[test]
fn g13_s1_close_vault() {
    let mut k = Cast::new();
    expect_lands(k.build_vault(), "BuildVault");
    let rent_to = k.a.wallet.pubkey();
    let close = |k: &mut Cast, p: Player, s: &Keypair| {
        let ix = fx::close_vault(&k.w.a, &p, (k.a.p, k.a.q, k.vt), rent_to);
        s1_send(&mut k.c, I2::CloseVault, ix, &[s])
    };
    // Not by the session key.
    let session = session_of(&mut k.c, &k.a, b"s1-close-session");
    let p = by_session(&k.a, &session);
    assert_cq(close(&mut k, p, &session), Cq::WalletRequired);
    // Not while it holds goods.
    k.c.edit(&k.vault(), |d| {
        d[VA::store(0)..VA::store(0) + 8].copy_from_slice(&MILLI.to_le_bytes())
    });
    let w = k.a.wallet.insecure_clone();
    let owner = k.a.player();
    assert_code(close(&mut k, owner, &w), E::BadData);
    k.c.edit(&k.vault(), |d| d[VA::store(0)..VA::store(0) + 8].fill(0));
    // Not by another player.
    let ix = fx::close_vault(&k.w.a, &k.r.player(), (k.a.p, k.a.q, k.vt), rent_to);
    assert_code(
        s1_send(&mut k.c, I2::CloseVault, ix, &[&k.r.wallet]),
        E::NotOwner,
    );
    let before = k.c.lamports(&rent_to);
    let rent = k.c.lamports(&k.vault());
    let owner = k.a.player();
    let l = expect_lands(close(&mut k, owner, &w), "CloseVault");
    assert!(k.c.is_absent(&k.vault()));
    assert_eq!(k.c.lamports(&rent_to) + l.fee, before + rent);
    assert_eq!(k.c.data(&k.a.citizen)[C::VAULTS], 0);
}
