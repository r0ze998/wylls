//! V26's instruction replay (`V26:custody-replay`, custody seasons): a
//! landed OpenLot, SetLotQuota, SetLotOrder, RevokeLotOrder, ConsumeLot or
//! CloseLot is run through the kernel on the states recorded before it; a
//! result other than what the transaction left is a FAIL. The instructions
//! that move a caravan are not replayed (UNVERIFIABLE), and the season is
//! still never a PASS. No key is generated, derived or used to sign: the
//! states come from the kernel and the instruction is put into a recorded
//! transaction's message without signing it again.

mod common;

use std::collections::BTreeMap;

use common::*;
use frontier_abi::v2::ix as x;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::s1::vault as VA;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;
use verify_core::checks::v26_custody::{replay_ix, ReplayCase, Replayed};
use verify_core::codes::*;

type Key = [u8; 32];

const KEEPER_W: Key = [0x4A; 32]; // the vault owner's wallet
const KEEPER: Key = [0x4B; 32]; // its Citizen
const OWNER_W: Key = [0xB1; 32];
const OWNER: Key = [0xB2; 32];
const OWNER_S: Key = [0xB5; 32]; // the owner's Frontier session
const USER_W: Key = [0xC2; 32];
const USER: Key = [0xC3; 32];
const PAYER: Key = [0x9A; 32];
const SEASON: Key = [0x5E; 32];
const VAULT: Key = [0x7A; 32];
const LOT: Key = [0xD1; 32];
const SYSTEM: Key = [0; 32];
const ORE: u8 = Resource::Ore as u8;
const T: i64 = 50_000; // block time of every replayed instruction
const BELL: u32 = 30;
const PURPOSE: u16 = 0x0901;

fn citizen(wallet: Key, session: Key, tag: u64) -> Vec<u8> {
    let mut d = vec![0u8; C::SIZE];
    d[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet);
    d[C::SESSION..C::SESSION + 32].copy_from_slice(&session);
    d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&(T + 600).to_le_bytes());
    d[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&tag.to_le_bytes());
    d
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

fn view() -> K::VaultView {
    K::VaultView {
        p: 3,
        q: -2,
        tile: 7,
        gen: 1,
        live: true,
        owner: KEEPER,
        owner_tag: 0x4B,
        stores: [0; 8],
        cap: 100 * MILLI,
        quota: [0; 8],
        lots: 0,
    }
}

fn act(k: Key) -> K::Actor {
    K::Actor {
        citizen: k,
        tag: k[0] as u64,
        by_session: false,
    }
}

/// The accounts before and after one instruction.
#[derive(Clone, Default)]
struct World {
    before: BTreeMap<Key, Vec<u8>>,
    after: BTreeMap<Key, Option<Vec<u8>>>,
}

impl World {
    fn citizens() -> World {
        let mut w = World::default();
        w.before.insert(KEEPER, citizen(KEEPER_W, [0; 32], 0x4B));
        w.before.insert(OWNER, citizen(OWNER_W, OWNER_S, 0xB2));
        w.before.insert(USER, citizen(USER_W, [0; 32], 0xC3));
        w
    }
    fn replay(&self, data: &[u8], accounts: &[Key]) -> Replayed {
        let before = |k: &Key| self.before.get(k).cloned();
        let after = |k: &Key| self.after.get(k).cloned();
        replay_ix(&ReplayCase {
            data,
            accounts,
            time: T,
            bell: Some(BELL),
            before: &before,
            after: &after,
        })
    }
}

/// A lot holding 30 of ore (as a deposit and its settlement left it),
/// with the vault it is in.
fn filled() -> (K::VaultView, K::Lot) {
    let mut v = view();
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

fn use_order(qty: u32) -> x::SetLotOrder {
    x::SetLotOrder {
        slot: 0,
        nonce: 0,
        kind: K::ORDER_USE,
        qty,
        expires_bell: 500,
        dst_p: 0,
        dst_q: 0,
        dst_tile: 0,
        dst_gen: 0,
        purpose: PURPOSE,
    }
}

fn spec(o: &x::SetLotOrder, grantee: Key) -> K::OrderSpec {
    K::OrderSpec {
        kind: o.kind,
        grantee,
        qty: o.qty as i64 * MILLI,
        expires_bell: o.expires_bell,
        dst: K::PlaceRef::vault(o.dst_p, o.dst_q, o.dst_tile, o.dst_gen),
        purpose: o.purpose,
    }
}

/// One replayed instruction: its data, accounts and the world around it,
/// with what the kernel writes as the after-states.
struct Case {
    name: &'static str,
    data: Vec<u8>,
    accounts: Vec<Key>,
    w: World,
}

/// Every replayed instruction, each on the state the one before it left,
/// with the after-states the kernel writes.
fn cases() -> Vec<Case> {
    let mut out = vec![];
    // OpenLot.
    {
        let mut w = World::citizens();
        let mut v = view();
        w.before.insert(VAULT, vault_bytes(&v));
        let a = x::OpenLot {
            resource: ORE,
            quota: 40,
        };
        let l = K::open(
            &mut v,
            &act(KEEPER),
            (OWNER, 0xB2),
            ORE,
            40 * MILLI,
            BELL,
            PAYER,
        )
        .unwrap();
        w.after.insert(LOT, Some(lot_bytes(&l)));
        w.after.insert(VAULT, Some(vault_bytes(&v)));
        out.push(Case {
            name: "OpenLot",
            data: a.to_bytes().to_vec(),
            accounts: vec![KEEPER_W, PAYER, SEASON, KEEPER, VAULT, OWNER, LOT, SYSTEM],
            w,
        });
    }
    let (v0, l0) = filled();
    // SetLotQuota (raise to 50).
    {
        let mut w = World::citizens();
        let (mut v, mut l) = (v0, l0);
        w.before.insert(VAULT, vault_bytes(&v));
        w.before.insert(LOT, lot_bytes(&l));
        K::set_quota(&mut v, &mut l, &act(KEEPER), 50 * MILLI).unwrap();
        w.after.insert(LOT, Some(lot_bytes(&l)));
        w.after.insert(VAULT, Some(vault_bytes(&v)));
        out.push(Case {
            name: "SetLotQuota",
            data: x::SetLotQuota { quota: 50 }.to_bytes().to_vec(),
            accounts: vec![KEEPER_W, PAYER, SEASON, KEEPER, VAULT, LOT],
            w,
        });
    }
    // SetLotOrder (use, 20 for USER).
    let o = use_order(20);
    let mut l1 = l0;
    K::set_order(&v0, &mut l1, &act(OWNER), 0, 0, &spec(&o, USER), BELL).unwrap();
    {
        let mut w = World::citizens();
        w.before.insert(VAULT, vault_bytes(&v0));
        w.before.insert(LOT, lot_bytes(&l0));
        w.after.insert(LOT, Some(lot_bytes(&l1)));
        out.push(Case {
            name: "SetLotOrder",
            data: o.to_bytes().to_vec(),
            accounts: vec![OWNER_W, PAYER, SEASON, OWNER, VAULT, LOT, USER, VAULT],
            w,
        });
    }
    // ConsumeLot (USER uses 15).
    let mut l2 = l1;
    K::consume(&v0, &mut l2, &act(USER), 0, 0, 15 * MILLI, PURPOSE, BELL).unwrap();
    {
        let mut w = World::citizens();
        w.before.insert(VAULT, vault_bytes(&v0));
        w.before.insert(LOT, lot_bytes(&l1));
        w.after.insert(LOT, Some(lot_bytes(&l2)));
        out.push(Case {
            name: "ConsumeLot",
            data: x::ConsumeLot {
                slot: 0,
                id: 0,
                qty: 15,
                purpose: PURPOSE,
            }
            .to_bytes()
            .to_vec(),
            accounts: vec![USER_W, PAYER, SEASON, USER, VAULT, LOT],
            w,
        });
    }
    // RevokeLotOrder (by the owner's session: revoking only narrows).
    let mut l3 = l2;
    K::revoke_order(
        &mut l3,
        &K::Actor {
            by_session: true,
            ..act(OWNER)
        },
        0,
        0,
        BELL,
    )
    .unwrap();
    {
        let mut w = World::citizens();
        w.before.insert(LOT, lot_bytes(&l2));
        w.after.insert(LOT, Some(lot_bytes(&l3)));
        out.push(Case {
            name: "RevokeLotOrder",
            data: x::RevokeLotOrder { slot: 0, id: 0 }.to_bytes().to_vec(),
            accounts: vec![OWNER_S, PAYER, SEASON, OWNER, LOT],
            w,
        });
    }
    // CloseLot of an emptied lot (by the vault's owner).
    {
        let mut v = view();
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
        let mut w = World::citizens();
        w.before.insert(VAULT, vault_bytes(&v));
        w.before.insert(LOT, lot_bytes(&l));
        K::close(Some(&mut v), &mut l, Some(&act(KEEPER)), BELL).unwrap();
        w.after.insert(LOT, None);
        w.after.insert(VAULT, Some(vault_bytes(&v)));
        out.push(Case {
            name: "CloseLot",
            data: x::CloseLot {}.to_bytes().to_vec(),
            accounts: vec![KEEPER_W, PAYER, SEASON, KEEPER, VAULT, LOT, PAYER],
            w,
        });
    }
    out
}

fn mismatch(r: &Replayed) -> bool {
    matches!(r, Replayed::Mismatch(_))
}

#[test]
fn what_the_kernel_writes_replays_to_a_match() {
    let cs = cases();
    assert_eq!(cs.len(), 6);
    for c in &cs {
        assert_eq!(
            c.w.replay(&c.data, &c.accounts),
            Replayed::Matches,
            "{}",
            c.name
        );
    }
}

#[test]
fn a_different_result_is_a_mismatch() {
    for c in cases() {
        // Every byte of the lot's kernel fields the kernel would write, off
        // by one unit in HELD (or, for a close, the lot left in place).
        let mut w = c.w.clone();
        match w.after.get(&LOT).cloned().flatten() {
            Some(d) => {
                let mut l = K::Lot::decode(&d).unwrap();
                l.held += MILLI;
                w.after.insert(LOT, Some(lot_bytes(&l)));
            }
            None => {
                w.after.insert(LOT, w.before.get(&LOT).cloned());
            }
        }
        let r = w.replay(&c.data, &c.accounts);
        assert!(mismatch(&r), "{}: {r:?}", c.name);
    }
}

#[test]
fn the_vaults_counts_are_replayed_where_the_program_writes_them() {
    for c in cases() {
        let Some(Some(d)) = c.w.after.get(&VAULT).cloned() else {
            continue;
        };
        let mut v = verify_core::checks::v26_custody::vault_view_of(&d).unwrap();
        v.lots += 1;
        let mut w = c.w.clone();
        w.after.insert(VAULT, Some(vault_bytes(&v)));
        let r = w.replay(&c.data, &c.accounts);
        let Replayed::Mismatch(m) = &r else {
            panic!("{}: {r:?}", c.name)
        };
        assert!(m.contains("custody counts"), "{}: {m}", c.name);
    }
}

#[test]
fn a_signer_the_program_refuses_is_a_mismatch() {
    for c in cases() {
        // Someone else signs for the Citizen.
        let mut a = c.accounts.clone();
        a[0] = [0xEE; 32];
        let r = c.w.replay(&c.data, &a);
        let Replayed::Mismatch(m) = &r else {
            panic!("{}: {r:?}", c.name)
        };
        assert!(
            m.contains("neither the Citizen's wallet"),
            "{}: {m}",
            c.name
        );
    }
    // The owner's session may revoke (above) but not order: the kernel
    // wants the wallet.
    let c = cases()
        .into_iter()
        .find(|c| c.name == "SetLotOrder")
        .unwrap();
    let mut a = c.accounts.clone();
    a[0] = OWNER_S;
    assert_eq!(
        c.w.replay(&c.data, &a),
        Replayed::Mismatch(
            "SetLotOrder landed, but the kernel refuses it on the state before (WalletRequired)"
                .into()
        )
    );
    // An expired session is not the Citizen's.
    let c = cases()
        .into_iter()
        .find(|c| c.name == "RevokeLotOrder")
        .unwrap();
    let mut w = c.w.clone();
    let mut cz = w.before[&OWNER].clone();
    cz[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&T.to_le_bytes());
    w.before.insert(OWNER, cz);
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
}

#[test]
fn a_step_the_kernel_refuses_is_a_mismatch() {
    let cs = cases();
    let get = |n: &str| cs.iter().find(|c| c.name == n).unwrap();
    // Using more than the order left.
    let c = get("ConsumeLot");
    let more = x::ConsumeLot {
        slot: 0,
        id: 0,
        qty: 21,
        purpose: PURPOSE,
    }
    .to_bytes();
    assert!(mismatch(&c.w.replay(&more, &c.accounts)));
    // A stale nonce (a replay of the order built on the older lot).
    let c = get("SetLotOrder");
    let mut w = c.w.clone();
    // The lot the order already went into (NONCE 1) is the state before.
    let l = K::Lot::decode(&w.after[&LOT].clone().unwrap()).unwrap();
    w.before.insert(LOT, lot_bytes(&l));
    let r = w.replay(&c.data, &c.accounts);
    assert_eq!(
        r,
        Replayed::Mismatch(
            "SetLotOrder landed, but the kernel refuses it on the state before (Stale)".into()
        )
    );
    // Closing a lot that still holds goods.
    let (v, l) = filled();
    let c = get("CloseLot");
    let mut w = c.w.clone();
    w.before.insert(VAULT, vault_bytes(&v));
    w.before.insert(LOT, lot_bytes(&l));
    assert!(mismatch(&w.replay(&c.data, &c.accounts)));
    // Rent to an account that is not the lot's.
    let c = get("CloseLot");
    let mut a = c.accounts.clone();
    a[6] = [0x31; 32];
    assert!(mismatch(&c.w.replay(&c.data, &a)));
}

#[test]
fn missing_evidence_is_not_replayed_and_not_a_fail() {
    for c in cases() {
        for k in [LOT, VAULT, c.accounts[3]] {
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
                assert!(
                    matches!(r, Replayed::Unreplayed(_)),
                    "{} without {} of {:x}: {r:?}",
                    c.name,
                    ["before", "after"][side],
                    k[0]
                );
            }
        }
        // No bell.
        let before = |k: &Key| c.w.before.get(k).cloned();
        let after = |k: &Key| c.w.after.get(k).cloned();
        let r = replay_ix(&ReplayCase {
            data: &c.data,
            accounts: &c.accounts,
            time: T,
            bell: None,
            before: &before,
            after: &after,
        });
        assert!(matches!(r, Replayed::Unreplayed(_)), "{}", c.name);
    }
}

#[test]
fn caravan_instructions_are_not_replayed() {
    let w = World::citizens();
    let d = x::ReconcileLot {}.to_bytes();
    assert_eq!(
        w.replay(&d, &[]),
        Replayed::Unreplayed("ReconcileLot is not replayed yet (it moves a caravan)".into())
    );
}

/// The kernel's random runs: each step replays to a match, and a step's
/// result written one unit off never does.
#[test]
fn random_runs_replay_and_any_unit_off_is_caught() {
    let mut seed = 0x2611_0708u64;
    let mut rnd = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    let (mut matched, mut caught) = (0, 0);
    for _ in 0..300 {
        let (v, mut l) = filled();
        let mut nonce = 0u32;
        for _ in 0..6 {
            let mut w = World::citizens();
            w.before.insert(VAULT, vault_bytes(&v));
            w.before.insert(LOT, lot_bytes(&l));
            let before = l;
            let (data, accounts): (Vec<u8>, Vec<Key>) = match rnd(3) {
                0 => {
                    let o = x::SetLotOrder {
                        slot: rnd(2) as u8,
                        nonce,
                        qty: 1 + rnd(12) as u32,
                        ..use_order(0)
                    };
                    if K::set_order(
                        &v,
                        &mut l,
                        &act(OWNER),
                        o.slot,
                        nonce,
                        &spec(&o, USER),
                        BELL,
                    )
                    .is_err()
                    {
                        continue;
                    }
                    nonce += 1;
                    (
                        o.to_bytes().to_vec(),
                        vec![OWNER_W, PAYER, SEASON, OWNER, VAULT, LOT, USER, VAULT],
                    )
                }
                1 => {
                    let slot = rnd(2) as u8;
                    let id = l.orders[slot as usize].id;
                    let qty = 1 + rnd(6) as u32;
                    if K::consume(
                        &v,
                        &mut l,
                        &act(USER),
                        slot,
                        id,
                        qty as i64 * MILLI,
                        PURPOSE,
                        BELL,
                    )
                    .is_err()
                    {
                        continue;
                    }
                    (
                        x::ConsumeLot {
                            slot,
                            id,
                            qty,
                            purpose: PURPOSE,
                        }
                        .to_bytes()
                        .to_vec(),
                        vec![USER_W, PAYER, SEASON, USER, VAULT, LOT],
                    )
                }
                _ => {
                    let slot = rnd(2) as u8;
                    let id = l.orders[slot as usize].id;
                    if K::revoke_order(&mut l, &act(OWNER), slot, id, BELL).is_err() {
                        continue;
                    }
                    (
                        x::RevokeLotOrder { slot, id }.to_bytes().to_vec(),
                        vec![OWNER_W, PAYER, SEASON, OWNER, LOT],
                    )
                }
            };
            w.after.insert(LOT, Some(lot_bytes(&l)));
            assert_eq!(w.replay(&data, &accounts), Replayed::Matches, "{before:?}");
            matched += 1;
            let mut off = l;
            match rnd(3) {
                0 => off.held += MILLI,
                1 => off.consumed -= MILLI,
                _ => off.orders[rnd(2) as usize].qty_left += MILLI,
            }
            w.after.insert(LOT, Some(lot_bytes(&off)));
            if off != l {
                assert!(mismatch(&w.replay(&data, &accounts)));
                caught += 1;
            }
        }
    }
    assert!(matched > 300 && caught > 300, "{matched} {caught}");
}

// ------------------------------------------------------------ through verify

/// V26's replay findings (code, FAIL?, detail, signature).
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

/// The `march` fixture as a custody season, with transaction `a` writing
/// the before-states and transaction `b` carrying `case`'s instruction
/// (put into its message, not signed again) and its after-states. The
/// instruction's signer is `b`'s fee payer, made the Citizen's wallet.
fn recorded(case: &Case) -> (verify_core::Input, String) {
    let mut inp = march();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V4;
    let program = inp.cfg.program;
    let landed: Vec<usize> = inp
        .txs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.err.is_none())
        .map(|(i, _)| i)
        .collect();
    let (a, b) = (landed[landed.len() - 2], landed[landed.len() - 1]);
    let mut tx = fclient::tx::from_wire(&inp.txs[b].tx).unwrap();
    let payer = tx.message.account_keys[0].to_bytes();
    let signer = case.accounts[0];
    let citizen_key = case.accounts[3];
    let mut w = case.w.clone();
    let mut cz = w.before[&citizen_key].clone();
    cz[C::WALLET..C::WALLET + 32].copy_from_slice(&payer);
    w.before.insert(citizen_key, cz);
    // The message: the accounts after the signer appended, the instruction
    // a copy of the transaction's own program instruction with its data
    // and accounts replaced.
    let pid = tx
        .message
        .account_keys
        .iter()
        .position(|k| *k == program)
        .unwrap();
    let mut idx = vec![0u8];
    for k in &case.accounts[1..] {
        let k = if *k == signer { payer } else { *k };
        let addr = fclient::Address::new_from_array(k);
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
    for (k, d) in &w.before {
        inp.txs[a]
            .post
            .push((fclient::Address::new_from_array(*k), Some(acct(d.clone()))));
    }
    for (k, d) in &w.after {
        inp.txs[b]
            .post
            .push((fclient::Address::new_from_array(*k), d.clone().map(acct)));
    }
    let sig = inp.txs[b].signature.to_string();
    (inp, sig)
}

#[test]
fn verify_replays_a_landed_instruction_and_fails_a_tampered_one() {
    // SetLotQuota: its kernel step does not read the bell, so the
    // fixture's own bell at that transaction does not matter.
    let c = cases()
        .into_iter()
        .find(|c| c.name == "SetLotQuota")
        .unwrap();
    let (inp, sig) = recorded(&c);
    let r = verify_core::verify(&inp);
    assert!(r.checks_run.contains(&"V26:custody-replay"));
    assert_eq!(replay_findings(&r), vec![]);
    // The same transaction, its lot left one unit off.
    let mut bad = c;
    let mut l = K::Lot::decode(&bad.w.after[&LOT].clone().unwrap()).unwrap();
    l.held += MILLI;
    bad.w.after.insert(LOT, Some(lot_bytes(&l)));
    let (inp, sig2) = recorded(&bad);
    assert_eq!(sig, sig2);
    let r = verify_core::verify(&inp);
    let f = replay_findings(&r);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].0, CUSTODY_REPLAY_MISMATCH);
    assert!(f[0].1);
    assert!(
        f[0].2
            .starts_with("SetLotQuota landed, but it left the lot"),
        "{}",
        f[0].2
    );
    assert_eq!(f[0].3, sig);
}

#[test]
fn verify_leaves_a_caravan_instruction_unverifiable() {
    let c = Case {
        name: "DepositLot",
        data: x::DepositLot {
            seq: 0,
            qty: 5,
            steps: 0,
            path: [0; 12],
            fee: 0,
        }
        .to_bytes()
        .to_vec(),
        accounts: vec![OWNER_W, PAYER, SEASON, OWNER, VAULT, VAULT, LOT],
        w: World::citizens(),
    };
    let (inp, sig) = recorded(&c);
    let r = verify_core::verify(&inp);
    assert_eq!(
        replay_findings(&r),
        vec![(
            CUSTODY_REPLAY_INCOMPLETE.to_string(),
            false,
            "DepositLot is not replayed yet (it moves a caravan)".to_string(),
            sig
        )]
    );
    assert_ne!(
        r.findings.iter().filter(|f| f.check == "V26").count(),
        0,
        "the guard's traces stay"
    );
}
