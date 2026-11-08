//! V26's replay of the custody instructions that move a caravan
//! (DepositLot, ShipLot, WithdrawLot, SettleCustody, ReconcileLot), on the
//! lot's side: the custody kernel's step on the states recorded before,
//! with the caravan's identity and cargo as the transaction recorded them.
//! What is not replayed (a send's route and wear, a settlement's Province
//! conditions) keeps the instruction UNVERIFIABLE; a different lot is a
//! FAIL. No key is generated, derived or used to sign: the states are
//! fixed bytes or the kernel's, the addresses public derivations
//! (`create_with_seed`), and the instruction is put into a recorded
//! transaction's message without signing it again.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::*;
use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::addr;
use frontier_abi::v2::ix as x;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::s1::{caravan as CV, place as PL, vault as VA};
use frontier_abi::v2::log::{lot_loss, CqKind, LotKey};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;
use verify_core::checks::v26_custody::{replay_ix, ReplayCase, ReplayRecord, Replayed};
use verify_core::codes::*;

type Key = [u8; 32];

const PROGRAM: Key = [0x9F; 32];
const SEASON: Key = [0x5E; 32];
const KEEPER: Key = [0x4B; 32];
const OWNER_W: Key = [0xB1; 32];
const OWNER: Key = [0xB2; 32];
const OWNER_S: Key = [0xB5; 32];
const CAPTOR: Key = [0xCA; 32];
const PAYER: Key = [0x9A; 32];
const BENEF: Key = [0xBE; 32];
const SYSTEM: Key = [0; 32];
const PROV: Key = [0x70; 32];
const ORE: u8 = Resource::Ore as u8;
const T: i64 = 50_000;
const BELL: u32 = 30;
const SEQ: u32 = 3;

fn ctx(program: Key) -> AddrCtx {
    AddrCtx {
        season: SEASON,
        program,
    }
}

/// The lot's vault (tile 7), the destination vault of a shipment (tile 9),
/// the owner's own vault (tile 11), and their lots, at their addresses.
struct Keys {
    va: Key,
    vb: Key,
    src: Key,
    lot_a: Key,
    lot_b: Key,
    caravan: Key,
}

fn keys(program: Key) -> Keys {
    let c = ctx(program);
    Keys {
        va: addr::vault(&c, 3, -2, 7),
        vb: addr::vault(&c, 3, -2, 9),
        src: addr::vault(&c, 3, -2, 11),
        lot_a: addr::lot(&c, 3, -2, 7, 1, 0xB2, ORE),
        lot_b: addr::lot(&c, 3, -2, 9, 1, 0xB2, ORE),
        caravan: addr::caravan(&c, 0xB2, SEQ),
    }
}

fn citizen(wallet: Key, session: Key, tag: u64, caravans: u32) -> Vec<u8> {
    let mut d = vec![0u8; C::SIZE];
    d[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet);
    d[C::SESSION..C::SESSION + 32].copy_from_slice(&session);
    d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&(T + 600).to_le_bytes());
    d[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&tag.to_le_bytes());
    d[C::CARAVANS..C::CARAVANS + 4].copy_from_slice(&caravans.to_le_bytes());
    d
}

fn vault(tile: u8, gen: u8, owner: Key, owner_tag: u64) -> K::VaultView {
    K::VaultView {
        p: 3,
        q: -2,
        tile,
        gen,
        live: true,
        owner,
        owner_tag,
        stores: [0; 8],
        cap: 100 * MILLI,
        quota: [0; 8],
        lots: 0,
    }
}

fn vault_bytes(v: &K::VaultView) -> Vec<u8> {
    let mut d = vec![0u8; VA::SIZE];
    d[..8].copy_from_slice(&VA::MAGIC);
    d[VA::P..VA::P + 2].copy_from_slice(&v.p.to_le_bytes());
    d[VA::Q..VA::Q + 2].copy_from_slice(&v.q.to_le_bytes());
    d[VA::TILE] = v.tile;
    d[VA::GEN] = v.gen;
    d[VA::STATE] = if v.live {
        VA::STATE_LIVE
    } else {
        VA::STATE_NONE
    };
    d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&v.owner);
    d[VA::OWNER_TAG..VA::OWNER_TAG + 8].copy_from_slice(&v.owner_tag.to_le_bytes());
    for r in 0..8 {
        d[VA::store(r)..VA::store(r) + 8].copy_from_slice(&v.stores[r].to_le_bytes());
        d[VA::custody_quota(r)..VA::custody_quota(r) + 8]
            .copy_from_slice(&v.quota[r].to_le_bytes());
    }
    d[VA::CAP..VA::CAP + 8].copy_from_slice(&v.cap.to_le_bytes());
    d[VA::CUSTODY_LOTS..VA::CUSTODY_LOTS + 2].copy_from_slice(&v.lots.to_le_bytes());
    d
}

fn lot_bytes(l: &K::Lot) -> Vec<u8> {
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d
}

fn act(k: Key) -> K::Actor {
    K::Actor {
        citizen: k,
        tag: k[0] as u64,
        by_session: false,
    }
}

/// A caravan as the program leaves it: the owner's `SEQ`-th, to the lot's
/// vault (tile 7), carrying `cargo` of ore, marked `custody`.
fn caravan_bytes(custody: u8, cargo: i64, arrive: i64) -> Vec<u8> {
    let mut d = vec![0u8; CV::SIZE];
    d[..8].copy_from_slice(&CV::MAGIC);
    d[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32].copy_from_slice(&OWNER);
    d[CV::OWNER_TAG..CV::OWNER_TAG + 8].copy_from_slice(&0xB2u64.to_le_bytes());
    d[CV::SEQ..CV::SEQ + 4].copy_from_slice(&SEQ.to_le_bytes());
    d[CV::STATE] = CV::STATE_MOVING;
    let dst = CV::DST;
    d[dst + PL::KIND] = PL::KIND_VAULT;
    d[dst + PL::P..dst + PL::P + 2].copy_from_slice(&3i16.to_le_bytes());
    d[dst + PL::Q..dst + PL::Q + 2].copy_from_slice(&(-2i16).to_le_bytes());
    d[dst + PL::SITE_OR_TILE] = 7;
    d[dst + PL::GEN] = 1;
    d[dst + PL::TILE] = 7;
    d[CV::ARRIVE_TS..CV::ARRIVE_TS + 8].copy_from_slice(&arrive.to_le_bytes());
    d[CV::cargo(ORE as usize)..CV::cargo(ORE as usize) + 8].copy_from_slice(&cargo.to_le_bytes());
    d[CV::RENT_TO..CV::RENT_TO + 32].copy_from_slice(&PAYER);
    d[CV::CUSTODY] = custody;
    if custody != CV::CUSTODY_NONE {
        d[CV::CUSTODY_RESOURCE] = ORE;
        d[CV::CUSTODY_OWNER_TAG..CV::CUSTODY_OWNER_TAG + 8].copy_from_slice(&0xB2u64.to_le_bytes());
    }
    d
}

/// The accounts before and after one instruction, and those the input
/// shows closed before it.
#[derive(Clone, Default)]
struct World {
    before: BTreeMap<Key, Vec<u8>>,
    after: BTreeMap<Key, Option<Vec<u8>>>,
    closed: BTreeSet<Key>,
    records: Vec<ReplayRecord>,
}

impl World {
    fn replay(&self, data: &[u8], accounts: &[Key]) -> Replayed {
        let before = |k: &Key| self.before.get(k).cloned();
        let after = |k: &Key| self.after.get(k).cloned();
        let closed = |k: &Key| self.closed.contains(k);
        replay_ix(&ReplayCase {
            data,
            accounts,
            time: T,
            bell: Some(BELL),
            before: &before,
            after: &after,
            closed_before: &closed,
            program: PROGRAM,
            records: &self.records,
        })
    }
}

/// The lot (quota 40) holding 30 of ore, in its vault.
fn filled() -> (K::VaultView, K::Lot) {
    let mut v = vault(7, 1, KEEPER, 0x4B);
    let mut l = K::open(
        &mut v,
        &act(KEEPER),
        (OWNER, 0xB2),
        ORE,
        40 * MILLI,
        10,
        PAYER,
    )
    .unwrap();
    K::begin_inbound(&v, &mut l, (0x77, 1), 30 * MILLI).unwrap();
    K::finish_inbound(Some(&v), &mut l, (0x77, 1), 30 * MILLI).unwrap();
    (v, l)
}

struct Case {
    name: &'static str,
    data: Vec<u8>,
    accounts: Vec<Key>,
    w: World,
    want: Replayed,
}

// ------------------------------------------------------------ records (frontier_abi::v2::log)

fn raw(l: &K::Lot) -> Vec<u8> {
    LotKey {
        p: l.p,
        q: l.q,
        tile: l.tile,
        gen: l.vault_gen,
        owner_tag: l.owner_tag,
        resource: l.resource,
    }
    .raw()
    .to_vec()
}

fn ck() -> Vec<u8> {
    let mut k = 0xB2u64.to_le_bytes().to_vec();
    k.extend_from_slice(&SEQ.to_le_bytes());
    k
}

fn rec(kind: CqKind, key: Vec<u8>, parts: &[&[u8]]) -> ReplayRecord {
    ReplayRecord {
        kind,
        key,
        payload: parts.concat(),
    }
}

/// LOT_INBOUND: lot 15, sent 8, worn 8, from_lot 1.
fn inbound(l: &K::Lot, sent: i64, worn: i64, from_lot: u8) -> ReplayRecord {
    rec(
        CqKind::LOT_INBOUND,
        ck(),
        &[
            &raw(l),
            &sent.to_le_bytes(),
            &worn.to_le_bytes(),
            &[from_lot],
        ],
    )
}

/// LOT_SHIPPED: lot 15, sent 8, worn 8, to_lot 1, order_id 4, carrier_tag 8.
fn shipped(l: &K::Lot, sent: i64, worn: i64, to_lot: u8) -> ReplayRecord {
    rec(
        CqKind::LOT_SHIPPED,
        ck(),
        &[
            &raw(l),
            &sent.to_le_bytes(),
            &worn.to_le_bytes(),
            &[to_lot],
            &u32::MAX.to_le_bytes(),
            &0xB2u64.to_le_bytes(),
        ],
    )
}

/// LOT_SETTLED: lot 15, delivered 8, burned 8, dest_gone 8.
fn settled(l: &K::Lot, delivered: i64, burned: i64, gone: i64) -> ReplayRecord {
    rec(
        CqKind::LOT_SETTLED,
        ck(),
        &[
            &raw(l),
            &delivered.to_le_bytes(),
            &burned.to_le_bytes(),
            &gone.to_le_bytes(),
        ],
    )
}

/// LOT_LOSS (key: lot 15): cause 1, qty 8, to_tag 8, caravan_tag 8, caravan_seq 4.
fn lost(l: &K::Lot, cause: u8, qty: i64, to: u64, caravan: (u64, u32)) -> ReplayRecord {
    rec(
        CqKind::LOT_LOSS,
        raw(l),
        &[
            &[cause],
            &qty.to_le_bytes(),
            &to.to_le_bytes(),
            &caravan.0.to_le_bytes(),
            &caravan.1.to_le_bytes(),
        ],
    )
}

fn partial(kind: &str, what: &str) -> Replayed {
    Replayed::Partial(format!(
        "{kind}: the lot's side matches the kernel; not replayed: {what}"
    ))
}

const SEND: &str = "the route, its tower wear, the arrival and the path slots (the send rules V23 judges for SendCaravan)";

/// Each caravan instruction as the program would land it, with the states
/// the kernel writes.
fn cases() -> Vec<Case> {
    let k = keys(PROGRAM);
    let mut out = vec![];
    let base = || {
        let mut w = World::default();
        w.before.insert(OWNER, citizen(OWNER_W, OWNER_S, 0xB2, SEQ));
        w
    };
    // DepositLot: 10 from the owner's own vault, 9 left after the wear.
    {
        let (v, mut l) = filled();
        let mut src = vault(11, 1, OWNER, 0xB2);
        src.stores[ORE as usize] = 50 * MILLI;
        let mut w = base();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        w.before.insert(k.src, vault_bytes(&src));
        K::begin_inbound(&v, &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
        src.stores[ORE as usize] -= 10 * MILLI;
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.after.insert(k.src, Some(vault_bytes(&src)));
        w.records = vec![
            inbound(&l, 10 * MILLI, MILLI, 0),
            lost(&l, lot_loss::WORN, MILLI, 0, (0xB2, SEQ)),
        ];
        w.after.insert(
            k.caravan,
            Some(caravan_bytes(CV::CUSTODY_LOT, 9 * MILLI, T + 900)),
        );
        out.push(Case {
            name: "DepositLot",
            data: x::DepositLot {
                seq: SEQ,
                qty: 10,
                steps: 2,
                path: [0; 12],
                fee: 5_000,
            }
            .to_bytes()
            .to_vec(),
            accounts: vec![
                OWNER_W, PAYER, SEASON, OWNER, k.src, k.va, k.lot_a, k.caravan, SYSTEM, PROV,
            ],
            w,
            want: partial(
                "DepositLot",
                &format!("{SEND} and a holding source's debit"),
            ),
        });
    }
    // ShipLot by the owner: 5 to its lot in vault B, 4 left after the wear.
    {
        let (v, mut l) = filled();
        let mut vb = vault(9, 1, KEEPER, 0x4B);
        let mut tl = K::open(
            &mut vb,
            &act(KEEPER),
            (OWNER, 0xB2),
            ORE,
            20 * MILLI,
            10,
            PAYER,
        )
        .unwrap();
        let mut w = base();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        w.before.insert(k.vb, vault_bytes(&vb));
        w.before.insert(k.lot_b, lot_bytes(&tl));
        K::spend_ship(
            &v,
            &mut l,
            &act(OWNER),
            K::By::Owner,
            5 * MILLI,
            K::ShipTo::Lot(tl.place()),
            BELL,
        )
        .unwrap();
        K::begin_inbound(&vb, &mut tl, (0xB2, SEQ), 4 * MILLI).unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.after.insert(k.lot_b, Some(lot_bytes(&tl)));
        w.records = vec![
            shipped(&l, 5 * MILLI, MILLI, 1),
            inbound(&tl, 5 * MILLI, MILLI, 1),
            lost(&l, lot_loss::WORN, MILLI, 0, (0xB2, SEQ)),
        ];
        w.after.insert(
            k.caravan,
            Some(caravan_bytes(CV::CUSTODY_LOT, 4 * MILLI, T + 900)),
        );
        out.push(Case {
            name: "ShipLot",
            data: x::ShipLot {
                seq: SEQ,
                slot: x::SHIP_BY_OWNER,
                id: 0,
                qty: 5,
                steps: 1,
                path: [0; 12],
                fee: 5_000,
            }
            .to_bytes()
            .to_vec(),
            accounts: vec![
                OWNER_W, PAYER, SEASON, OWNER, k.va, k.lot_a, k.vb, k.lot_b, k.caravan, SYSTEM,
                PROV,
            ],
            w,
            want: partial("ShipLot", SEND),
        });
    }
    // WithdrawLot by the owner's session: 5 to its own vault.
    {
        let (v, mut l) = filled();
        let src = vault(11, 1, OWNER, 0xB2);
        let mut w = base();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        w.before.insert(k.src, vault_bytes(&src));
        let to = K::PlaceRef {
            kind: PL::KIND_VAULT,
            p: 3,
            q: -2,
            at: 11,
            gen: 1,
            tile: 11,
        };
        K::spend_ship(
            &v,
            &mut l,
            &K::Actor {
                by_session: true,
                ..act(OWNER)
            },
            K::By::Owner,
            5 * MILLI,
            K::ShipTo::OwnPlace(to),
            BELL,
        )
        .unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.after.insert(
            k.caravan,
            Some(caravan_bytes(CV::CUSTODY_NONE, 5 * MILLI, T + 900)),
        );
        w.records = vec![shipped(&l, 5 * MILLI, 0, 0)];
        out.push(Case {
            name: "WithdrawLot",
            data: x::WithdrawLot {
                seq: SEQ,
                qty: 5,
                dst_kind: PL::KIND_VAULT,
                dst_p: 3,
                dst_q: -2,
                dst_at: 11,
                dst_gen: 1,
                steps: 1,
                path: [0; 12],
                fee: 5_000,
            }
            .to_bytes()
            .to_vec(),
            accounts: vec![
                OWNER_S, PAYER, SEASON, OWNER, k.va, k.lot_a, k.src, k.caravan, SYSTEM, PROV,
            ],
            w,
            want: partial("WithdrawLot", SEND),
        });
    }
    // SettleCustody: the deposit's caravan arrives with 9.
    {
        let (v, mut l) = filled();
        K::begin_inbound(&v, &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
        let mut w = World::default();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        w.before
            .insert(k.caravan, caravan_bytes(CV::CUSTODY_LOT, 9 * MILLI, T - 10));
        K::finish_inbound(Some(&v), &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.after.insert(k.caravan, None);
        w.records = vec![settled(&l, 9 * MILLI, 0, 0)];
        out.push(Case {
            name: "SettleCustody",
            data: x::SettleCustody { beneficiary: BENEF }.to_bytes().to_vec(),
            accounts: vec![PAYER, SEASON, k.caravan, k.va, k.lot_a, BENEF, PAYER, PROV],
            w,
            want: partial(
                "SettleCustody",
                "the path Provinces' resolution and raid state, the fee and the rent",
            ),
        });
    }
    // ReconcileLot: the vault was seized (generation 2): the lot is forfeited.
    {
        let (v, l) = filled();
        let mut seized = vault(7, 2, CAPTOR, 0xCA);
        seized.quota = v.quota;
        seized.lots = v.lots;
        let mut w = World::default();
        w.before.insert(k.va, vault_bytes(&seized));
        w.before.insert(k.lot_a, lot_bytes(&l));
        let (mut sv, mut sl) = (seized, l);
        let f = K::forfeit(&mut sv, &mut sl).unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&sl)));
        w.after.insert(k.va, Some(vault_bytes(&sv)));
        w.records = vec![lost(&sl, lot_loss::SEIZED, f.qty, 0xCA, (0, 0))];
        out.push(Case {
            name: "ReconcileLot (seized)",
            data: x::ReconcileLot {}.to_bytes().to_vec(),
            accounts: vec![PAYER, SEASON, k.va, k.lot_a],
            w,
            want: Replayed::Matches,
        });
    }
    // ReconcileLot: the expected caravan was taken by a raider.
    {
        let (v, mut l) = filled();
        K::begin_inbound(&v, &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
        let mut w = World::default();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        // Taken by the raider of tag 0xCA.
        let mut taken = caravan_bytes(CV::CUSTODY_TAKEN, 9 * MILLI, T + 900);
        taken[CV::TAKEN_BY_TAG..CV::TAKEN_BY_TAG + 8].copy_from_slice(&0xCAu64.to_le_bytes());
        w.before.insert(k.caravan, taken);
        K::drop_inbound(&mut l, (0xB2, SEQ), K::CaravanSeen::Taken).unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.records = vec![lost(&l, lot_loss::RAIDED, 9 * MILLI, 0xCA, (0xB2, SEQ))];
        out.push(Case {
            name: "ReconcileLot (taken)",
            data: x::ReconcileLot {}.to_bytes().to_vec(),
            accounts: vec![PAYER, SEASON, k.va, k.lot_a, k.caravan],
            w,
            want: Replayed::Matches,
        });
    }
    // ReconcileLot: the expected caravan is closed (only a taken one closes
    // without its settlement).
    {
        let (v, mut l) = filled();
        K::begin_inbound(&v, &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
        let mut w = World::default();
        w.before.insert(k.va, vault_bytes(&v));
        w.before.insert(k.lot_a, lot_bytes(&l));
        w.closed.insert(k.caravan);
        K::drop_inbound(&mut l, (0xB2, SEQ), K::CaravanSeen::Absent).unwrap();
        w.after.insert(k.lot_a, Some(lot_bytes(&l)));
        w.records = vec![lost(&l, lot_loss::RAIDED, 9 * MILLI, 0, (0xB2, SEQ))];
        out.push(Case {
            name: "ReconcileLot (closed)",
            data: x::ReconcileLot {}.to_bytes().to_vec(),
            accounts: vec![PAYER, SEASON, k.va, k.lot_a, k.caravan],
            w,
            want: Replayed::Matches,
        });
    }
    out
}

fn get(name: &str) -> Case {
    cases().into_iter().find(|c| c.name == name).unwrap()
}

fn mismatch(r: &Replayed) -> bool {
    matches!(r, Replayed::Mismatch(_))
}

fn lot_a() -> Key {
    keys(PROGRAM).lot_a
}

#[test]
fn what_the_kernel_writes_replays_to_the_lots_side() {
    let cs = cases();
    assert_eq!(cs.len(), 7);
    for c in &cs {
        assert_eq!(c.w.replay(&c.data, &c.accounts), c.want, "{}", c.name);
    }
}

#[test]
fn a_lot_one_unit_off_is_a_mismatch() {
    for c in cases() {
        let mut w = c.w.clone();
        let mut l = K::Lot::decode(&w.after[&lot_a()].clone().unwrap()).unwrap();
        l.held += MILLI;
        w.after.insert(lot_a(), Some(lot_bytes(&l)));
        let r = w.replay(&c.data, &c.accounts);
        let Replayed::Mismatch(m) = &r else {
            panic!("{}: {r:?}", c.name)
        };
        assert!(m.contains("it left the lot"), "{}: {m}", c.name);
    }
    // The shipment's destination lot too.
    let c = get("ShipLot");
    let k = keys(PROGRAM);
    let mut w = c.w.clone();
    let mut l = K::Lot::decode(&w.after[&k.lot_b].clone().unwrap()).unwrap();
    l.inbound[0].qty += MILLI;
    w.after.insert(k.lot_b, Some(lot_bytes(&l)));
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
}

#[test]
fn the_caravan_a_send_left_is_checked() {
    let k = keys(PROGRAM);
    for name in ["DepositLot", "ShipLot", "WithdrawLot"] {
        let c = get(name);
        let custody = if name == "WithdrawLot" {
            CV::CUSTODY_NONE
        } else {
            CV::CUSTODY_LOT
        };
        // More cargo than was sent.
        let mut w = c.w.clone();
        w.after
            .insert(k.caravan, Some(caravan_bytes(custody, 11 * MILLI, T + 900)));
        assert!(mismatch(&w.replay(&c.data, &c.accounts)), "{name}: cargo");
        // The other custody mark.
        let other = if custody == CV::CUSTODY_NONE {
            CV::CUSTODY_LOT
        } else {
            CV::CUSTODY_NONE
        };
        let mut w = c.w.clone();
        w.after
            .insert(k.caravan, Some(caravan_bytes(other, 4 * MILLI, T + 900)));
        assert!(mismatch(&w.replay(&c.data, &c.accounts)), "{name}: mark");
        // A caravan number that is not the Citizen's next.
        let mut w = c.w.clone();
        w.before
            .insert(OWNER, citizen(OWNER_W, OWNER_S, 0xB2, SEQ + 1));
        let r = w.replay(&c.data, &c.accounts);
        let Replayed::Mismatch(m) = &r else {
            panic!("{name}: {r:?}")
        };
        assert!(m.contains("is not the Citizen's next"), "{name}: {m}");
        // A caravan account that is not the signer's caravan of that number.
        let mut a = c.accounts.clone();
        let i = a.iter().position(|x| *x == k.caravan).unwrap();
        a[i] = [0x33; 32];
        let r = c.w.replay(&c.data, &a);
        let Replayed::Mismatch(m) = &r else {
            panic!("{name}: {r:?}")
        };
        assert!(m.contains("not the signer's caravan"), "{name}: {m}");
        // A caravan the input does not show after: not a FAIL.
        let mut w = c.w.clone();
        w.after.remove(&k.caravan);
        assert!(
            matches!(w.replay(&c.data, &c.accounts), Replayed::Unreplayed(_)),
            "{name}"
        );
    }
}

#[test]
fn a_send_the_program_refuses_is_a_mismatch() {
    let k = keys(PROGRAM);
    // A deposit signed by the session.
    let c = get("DepositLot");
    let mut a = c.accounts.clone();
    a[0] = OWNER_S;
    let r = c.w.replay(&c.data, &a);
    assert_eq!(
        r,
        Replayed::Mismatch(
            "DepositLot landed, but a deposit is signed by the session, not the wallet".into()
        )
    );
    // The source vault not debited.
    let mut w = c.w.clone();
    w.after.insert(k.src, w.before.get(&k.src).cloned());
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
    // A shipment by the owner's session (the wallet is needed to another
    // lot), and to a lot of another owner.
    let c = get("ShipLot");
    let mut a = c.accounts.clone();
    a[0] = OWNER_S;
    let r = c.w.replay(&c.data, &a);
    assert_eq!(
        r,
        Replayed::Mismatch(
            "ShipLot landed, but the kernel refuses it on the state before (WalletRequired)".into()
        )
    );
    let mut w = c.w.clone();
    let mut tl = K::Lot::decode(&w.before[&k.lot_b]).unwrap();
    tl.owner_tag = 0x99;
    w.before.insert(k.lot_b, lot_bytes(&tl));
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
    // Shipping more than the lot holds.
    let more = x::ShipLot {
        seq: SEQ,
        slot: x::SHIP_BY_OWNER,
        id: 0,
        qty: 31,
        steps: 1,
        path: [0; 12],
        fee: 5_000,
    }
    .to_bytes();
    assert_eq!(
        c.w.replay(&more, &c.accounts),
        Replayed::Mismatch(
            "ShipLot landed, but the kernel refuses it on the state before (Insufficient)".into()
        )
    );
    // A withdrawal to a place that is not the owner's.
    let c = get("WithdrawLot");
    let mut w = c.w.clone();
    w.before
        .insert(k.src, vault_bytes(&vault(11, 1, KEEPER, 0x4B)));
    let r = w.replay(&c.data, &c.accounts);
    let Replayed::Mismatch(m) = &r else {
        panic!("{r:?}")
    };
    assert!(m.contains("not the signer's own live place"), "{m}");
}

#[test]
fn a_settlement_the_program_refuses_is_a_mismatch() {
    let k = keys(PROGRAM);
    let c = get("SettleCustody");
    // Before the arrival.
    let mut w = c.w.clone();
    w.before
        .insert(k.caravan, caravan_bytes(CV::CUSTODY_LOT, 9 * MILLI, T + 1));
    assert_eq!(
        w.replay(&c.data, &c.accounts),
        Replayed::Mismatch("SettleCustody landed, but the caravan had not arrived".into())
    );
    // Not a custody caravan.
    let mut w = c.w.clone();
    w.before.insert(
        k.caravan,
        caravan_bytes(CV::CUSTODY_NONE, 9 * MILLI, T - 10),
    );
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
    // Rent to another account; a lot that is not the caravan's destination.
    let mut a = c.accounts.clone();
    a[6] = [0x31; 32];
    assert!(mismatch(&c.w.replay(&c.data, &a)));
    let mut a = c.accounts.clone();
    a[4] = k.lot_b;
    assert!(mismatch(&c.w.replay(&c.data, &a)));
    // The caravan left open.
    let mut w = c.w.clone();
    w.after.insert(
        k.caravan,
        Some(caravan_bytes(CV::CUSTODY_LOT, 9 * MILLI, T - 10)),
    );
    assert_eq!(
        w.replay(&c.data, &c.accounts),
        Replayed::Mismatch("SettleCustody landed, but the caravan is not closed".into())
    );
}

#[test]
fn a_settlement_to_a_closed_vault_delivers_nothing_and_an_unknown_one_is_not_judged() {
    let k = keys(PROGRAM);
    let c = get("SettleCustody");
    // The vault closed before: the cargo is a DestinationGone loss, the lot
    // only forgets the caravan.
    let mut w = c.w.clone();
    let mut l = K::Lot::decode(&w.before[&k.lot_a]).unwrap();
    w.before.remove(&k.va);
    w.closed.insert(k.va);
    let s = K::finish_inbound(None, &mut l, (0xB2, SEQ), 9 * MILLI).unwrap();
    assert_eq!(s.dest_gone, 9 * MILLI);
    w.after.insert(k.lot_a, Some(lot_bytes(&l)));
    w.records = vec![
        settled(&l, 0, 0, 9 * MILLI),
        lost(&l, lot_loss::DESTINATION_GONE, 9 * MILLI, 0, (0xB2, SEQ)),
    ];
    assert_eq!(w.replay(&c.data, &c.accounts), c.want);
    // Booked as delivered while the vault is gone: a mismatch.
    let mut d = c.w.clone();
    d.before.remove(&k.va);
    d.closed.insert(k.va);
    assert!(mismatch(&d.replay(&c.data, &c.accounts)));
    // The vault neither in the input nor shown closed: not judged.
    let mut u = c.w.clone();
    u.before.remove(&k.va);
    assert_eq!(
        u.replay(&c.data, &c.accounts),
        Replayed::Unreplayed("the vault's state before the transaction is not in the input".into())
    );
}

#[test]
fn a_reconciliation_the_program_refuses_is_a_mismatch() {
    let k = keys(PROGRAM);
    // A caravan still on its way (custody): the kernel refuses to drop it.
    let c = get("ReconcileLot (taken)");
    let mut w = c.w.clone();
    w.before.insert(
        k.caravan,
        caravan_bytes(CV::CUSTODY_LOT, 9 * MILLI, T + 900),
    );
    assert_eq!(
        w.replay(&c.data, &c.accounts),
        Replayed::Mismatch(
            "ReconcileLot landed, but the kernel refuses it on the state before (InTransit)".into()
        )
    );
    // A caravan the lot does not expect.
    let mut a = c.accounts.clone();
    a[4] = [0x33; 32];
    assert!(mismatch(&c.w.replay(&c.data, &a)));
    // Nothing to reconcile (the vault not seized, no caravan listed).
    let mut a = c.accounts.clone();
    a.pop();
    assert_eq!(
        c.w.replay(&c.data, &a),
        Replayed::Mismatch(
            "ReconcileLot landed, but it changes nothing (the program refuses that)".into()
        )
    );
    // A seizure that leaves the vault's counts unchanged.
    let c = get("ReconcileLot (seized)");
    let mut w = c.w.clone();
    w.after.insert(k.va, w.before.get(&k.va).cloned());
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
    // A listed caravan the input does not show: not judged.
    let c = get("ReconcileLot (closed)");
    let mut w = c.w.clone();
    w.closed.clear();
    assert_eq!(
        w.replay(&c.data, &c.accounts),
        Replayed::Unreplayed(
            "a listed caravan's state before the transaction is not in the input".into()
        )
    );
}

#[test]
fn missing_evidence_is_never_a_fail() {
    for c in cases() {
        let keys: Vec<Key> = c.w.before.keys().chain(c.w.after.keys()).copied().collect();
        for k in keys {
            for side in 0..2 {
                let mut w = c.w.clone();
                let had = if side == 0 {
                    w.before.remove(&k).is_some()
                } else {
                    w.after.remove(&k).is_some()
                };
                if !had {
                    continue;
                }
                let r = w.replay(&c.data, &c.accounts);
                // A missing source vault (DepositLot) is a holding source's
                // case: still the lot's side, still not a PASS.
                assert!(
                    matches!(r, Replayed::Unreplayed(_) | Replayed::Partial(_)),
                    "{} without {} of {:x?}: {r:?}",
                    c.name,
                    ["before", "after"][side],
                    &k[..2]
                );
            }
        }
    }
}

// ------------------------------------------------------------ through verify

fn replay_findings(r: &verify_core::Report) -> Vec<(String, bool, String, String)> {
    let mut v: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.check == "V26" && f.code.starts_with("CustodyReplay"))
        .map(|f| {
            (
                f.code.clone(),
                f.fail(),
                f.detail.clone(),
                f.signature.clone(),
            )
        })
        .collect();
    v.sort();
    v
}

/// The `march` fixture as a custody season: transaction `a` writes the
/// before-states, `b` carries the instruction (put into its message, not
/// signed again) and the after-states. The addresses are derived from the
/// fixture's program and this test's season key.
fn recorded(build: impl Fn(Key) -> Case) -> (verify_core::Input, String, Case) {
    let mut inp = march();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V4;
    let program = inp.cfg.program;
    let case = build(program.to_bytes());
    let landed: Vec<usize> = inp
        .txs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.err.is_none())
        .map(|(i, _)| i)
        .collect();
    let (a, b) = (landed[landed.len() - 2], landed[landed.len() - 1]);
    let mut tx = fclient::tx::from_wire(&inp.txs[b].tx).unwrap();
    let pid = tx
        .message
        .account_keys
        .iter()
        .position(|k| *k == program)
        .unwrap();
    let mut idx = vec![];
    for k in &case.accounts {
        let addr = fclient::Address::new_from_array(*k);
        let i = match tx.message.account_keys.iter().position(|x| *x == addr) {
            Some(i) => i,
            None => {
                tx.message.account_keys.push(addr);
                tx.message.account_keys.len() - 1
            }
        };
        idx.push(i as u8);
    }
    let mut ci = tx
        .message
        .instructions
        .iter()
        .find(|c| c.program_id_index as usize == pid)
        .unwrap()
        .clone();
    ci.data = case.data.clone();
    ci.accounts = idx;
    tx.message.instructions.push(ci);
    inp.txs[b].tx = fclient::tx::wire(&tx);
    let acct = |d: Vec<u8>| fclient::ports::Account {
        lamports: 1,
        data: d,
        owner: program,
        executable: false,
    };
    for (k, d) in &case.w.before {
        inp.txs[a]
            .post
            .push((fclient::Address::new_from_array(*k), Some(acct(d.clone()))));
    }
    for k in &case.w.closed {
        inp.txs[a]
            .post
            .push((fclient::Address::new_from_array(*k), None));
    }
    for (k, d) in &case.w.after {
        inp.txs[b]
            .post
            .push((fclient::Address::new_from_array(*k), d.clone().map(acct)));
    }
    // The records, as the program logs them in a frame of its own.
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let pid = program.to_string();
    inp.txs[b].logs.push(format!("Program {pid} invoke [1]"));
    for r in &case.w.records {
        let mut body = vec![0u8; 512];
        let n = frontier_abi::v2::log::write_body(
            frontier_abi::v2::log::AnyKind::Cq(r.kind),
            BELL,
            &r.key,
            &r.payload,
            &mut body,
        )
        .unwrap();
        let n = frontier_abi::v2::log::write_tail(&[], &mut body, n).unwrap();
        inp.txs[b].logs.push(format!(
            "Program data: {} {}",
            b64.encode(fclient::log::PS2),
            b64.encode(&body[..n])
        ));
    }
    inp.txs[b].logs.push(format!("Program {pid} success"));
    let sig = inp.txs[b].signature.to_string();
    (inp, sig, case)
}

/// The taken-caravan reconciliation with the fixture's program: its states
/// are the same bytes, its addresses the fixture's.
fn reconcile_taken(program: Key) -> Case {
    let k = keys(program);
    let mut c = get("ReconcileLot (taken)");
    let old = keys(PROGRAM);
    let swap = |x: &Key| {
        if *x == old.va {
            k.va
        } else if *x == old.lot_a {
            k.lot_a
        } else if *x == old.caravan {
            k.caravan
        } else {
            *x
        }
    };
    c.accounts = c.accounts.iter().map(swap).collect();
    c.w.before =
        c.w.before
            .iter()
            .map(|(a, d)| (swap(a), d.clone()))
            .collect();
    c.w.after =
        c.w.after
            .iter()
            .map(|(a, d)| (swap(a), d.clone()))
            .collect();
    c
}

#[test]
fn verify_replays_a_landed_reconciliation_and_fails_a_tampered_one() {
    let (inp, _, _) = recorded(reconcile_taken);
    let r = verify_core::verify(&inp);
    assert!(r.checks_run.contains(&"V26:custody-replay"));
    assert_eq!(replay_findings(&r), vec![]);
    // The inbound slot left in place.
    let (inp, sig, _) = recorded(|p| {
        let mut c = reconcile_taken(p);
        let k = keys(p);
        let before = c.w.before[&k.lot_a].clone();
        c.w.after.insert(k.lot_a, Some(before));
        c
    });
    let r = verify_core::verify(&inp);
    let f = replay_findings(&r);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].0, CUSTODY_REPLAY_MISMATCH);
    assert!(f[0].1);
    assert!(
        f[0].2
            .starts_with("ReconcileLot landed, but it left the lot"),
        "{}",
        f[0].2
    );
    assert_eq!(f[0].3, sig);
}

#[test]
fn verify_keeps_a_settlement_unverifiable_when_its_lot_side_matches() {
    let (inp, sig, _) = recorded(|p| {
        let k = keys(p);
        let old = keys(PROGRAM);
        let mut c = get("SettleCustody");
        let swap = |x: &Key| {
            if *x == old.va {
                k.va
            } else if *x == old.lot_a {
                k.lot_a
            } else if *x == old.caravan {
                k.caravan
            } else {
                *x
            }
        };
        c.accounts = c.accounts.iter().map(swap).collect();
        c.w.before =
            c.w.before
                .iter()
                .map(|(a, d)| (swap(a), d.clone()))
                .collect();
        c.w.after =
            c.w.after
                .iter()
                .map(|(a, d)| (swap(a), d.clone()))
                .collect();
        c
    });
    let r = verify_core::verify(&inp);
    assert_eq!(
        replay_findings(&r),
        vec![(
            CUSTODY_REPLAY_INCOMPLETE.to_string(),
            false,
            "SettleCustody: the lot's side matches the kernel; not replayed: the path Provinces' resolution and raid state, the fee and the rent".to_string(),
            sig
        )]
    );
}

#[test]
fn the_records_are_the_kernels() {
    for c in cases() {
        // Each record dropped: not judged; each record's amount changed
        // by one unit: a mismatch.
        for i in 0..c.w.records.len() {
            let mut w = c.w.clone();
            let r = w.records.remove(i);
            let got = w.replay(&c.data, &c.accounts);
            assert!(
                matches!(got, Replayed::Unreplayed(_)),
                "{} without its {}: {got:?}",
                c.name,
                r.kind.name()
            );
            let mut w = c.w.clone();
            let p = &mut w.records[i].payload;
            let at = if r.kind == CqKind::LOT_LOSS { 1 } else { 15 };
            p[at] ^= 0x01;
            let got = w.replay(&c.data, &c.accounts);
            let Replayed::Mismatch(m) = &got else {
                panic!("{} with its {} changed: {got:?}", c.name, r.kind.name())
            };
            assert!(m.contains("record"), "{}: {m}", c.name);
        }
        // A loss the kernel does not give.
        let l = K::Lot::decode(&c.w.after[&lot_a()].clone().unwrap()).unwrap();
        let mut w = c.w.clone();
        w.records
            .push(lost(&l, lot_loss::BURNED, MILLI, 0, (0xB2, SEQ)));
        let got = w.replay(&c.data, &c.accounts);
        let Replayed::Mismatch(m) = &got else {
            panic!("{} with an extra loss: {got:?}", c.name)
        };
        assert!(m.contains("LOT_LOSS"), "{}: {m}", c.name);
    }
}
