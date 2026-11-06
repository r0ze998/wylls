//! ⑯ independent verification: prize claim rights against the game's
//! post-season closes, and the order of Pay / Tally / CloseProvince /
//! Finalize, on the permutation-prize program's own process_instruction
//! (host build). Place in workstreams/04-execution/e2e-native/tests/.
//!
//! No key is generated, derived or signed: accounts are fixed addresses
//! (`key(n)`), and "signed" is the host's list of keys said to have signed
//! (④'s e2e-native host, no ed25519). The program and the harness compute
//! program-derived ADDRESSES (find_program_address: public, no secret key).
//!
//! The game program is NOT run. Its CloseCitizen / CloseProvince are
//! stand-ins that do what the game code does (permutation-frontier
//! `proc/citizen.rs close_citizen`: the Citizen account is gone;
//! `proc/map.rs close_province`: the Province account is gone and its
//! wedge's ProvinceFund `provinces_opened -= 1`). Whether and when the game
//! lets a third party do this (Ended and `now ≥ bell_start(end_bell) + 72 h`,
//! or Aborted at once; any signer; no prize check) is from reading only.
//!
//! The helper section below (down to `player`) is copied verbatim from ④'s
//! `legacy_season_claims.rs` at b858e40d954cdc2ebbcac5a7edb8a251fb701730;
//! the scenarios after it are ⑯'s.


use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use permutation_prize::{leaf, node, pool, share_amount, tag, PrizeError as E};
use wylls_e2e_native::solana_program::instruction::{AccountMeta, Instruction};
use wylls_e2e_native::solana_program::pubkey::Pubkey;
use wylls_e2e_native::{rent_exempt, spl, token_balance, Acct, Host, SYSTEM, TOKEN};

const SEASON_ID: u64 = 7;
const END_BELL: u32 = 432;
/// The finite world's clock (the host's `unix_timestamp` is 1,800,000,000):
/// begun one bell ago, ten-minute bells, joins closed at bell 12. InitPool
/// opens an end-dependent pool only while a finite world is running
/// (permutation-prize `season_ends`, integration 2c29496f / c5750a20).
const BELL_SECS: u32 = 600;
const GENESIS_TS: i64 = 1_800_000_000 - 600;
const JOIN_CLOSE_BELL: u32 = 12;
/// 25 test USDC (6 decimals): the fixed test fee.
const FEE: u64 = 25_000_000;
const SOL: u64 = 1_000_000_000;

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

struct World {
    h: Host,
    game: Pubkey,
    season: Pubkey,
    ctx: AddrCtx,
    operator: Pubkey,
    mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
}

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}

fn fails(r: Result<(), String>, e: E) {
    let want = format!("Custom({})", e as u32);
    match r {
        Ok(()) => panic!("expected {e:?}, it landed"),
        Err(m) => assert!(m.contains(&want), "expected {e:?} ({want}): {m}"),
    }
}

/// [stand-in] A game account at `addr`, owned by the game program.
fn game_account(w: &mut World, addr: [u8; 32], data: Vec<u8>) {
    let lamports = rent_exempt(data.len());
    w.h.set(
        Pubkey::new_from_array(addr),
        Acct {
            lamports,
            data,
            owner: w.game,
            executable: false,
        },
    );
}

fn set_season(w: &mut World, status: u8) {
    let mut d = vec![0u8; S::SIZE];
    put(&mut d, 0, &S::MAGIC);
    put(&mut d, S::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[S::STATUS] = status;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.as_ref());
    put(&mut d, S::END_BELL, &END_BELL.to_le_bytes());
    put(&mut d, S::BELL_SECS, &BELL_SECS.to_le_bytes());
    put(&mut d, S::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &JOIN_CLOSE_BELL.to_le_bytes());
    // The continuous-world flag (SEASON_CQ_OFFSET + CONTINUOUS) stays 0: finite.
    let k = w.season.to_bytes();
    game_account(w, k, d);
}

fn set_frontier_and_funds(w: &mut World, opened: u32) {
    let mut d = vec![0u8; F::SIZE];
    put(&mut d, 0, &F::MAGIC);
    put(&mut d, F::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, F::PROVINCES_OPENED, &opened.to_le_bytes());
    let k = w.ctx.frontier();
    game_account(w, k, d);
    for wedge in 0..6u8 {
        let n = opened / 6 + if wedge == 0 { opened % 6 } else { 0 };
        let mut d = vec![0u8; PF::SIZE];
        put(&mut d, 0, &PF::MAGIC);
        put(&mut d, PF::SEASON_ID, &SEASON_ID.to_le_bytes());
        d[PF::WEDGE] = wedge;
        put(&mut d, PF::PROVINCES_OPENED, &n.to_le_bytes());
        let k = w.ctx.province_fund(wedge);
        game_account(w, k, d);
    }
}

fn funds(w: &World) -> Vec<Pubkey> {
    (0..6u8)
        .map(|f| Pubkey::new_from_array(w.ctx.province_fund(f)))
        .collect()
}

fn keeps() -> Vec<(i16, i16)> {
    let mut v = vec![];
    for p in -4i16..=4 {
        for q in -4i16..=4 {
            if (2..=4).contains(&ring_of(p as i32, q as i32)) {
                v.push((p, q));
            }
        }
    }
    v
}

fn set_provinces(w: &mut World, holders: &[u8]) -> Vec<Pubkey> {
    keeps()
        .iter()
        .zip(holders)
        .map(|((p, q), h)| {
            let mut d = vec![0u8; P::SIZE];
            put(&mut d, 0, &P::MAGIC);
            put(&mut d, P::SEASON_ID, &SEASON_ID.to_le_bytes());
            put(&mut d, P::P, &p.to_le_bytes());
            put(&mut d, P::Q, &q.to_le_bytes());
            put(&mut d, P::RESOLVED_NEXT, &END_BELL.to_le_bytes());
            d[P::KEEP + K::TILE] = 30;
            d[P::KEEP + K::HOLDER] = *h;
            let a = w.ctx.province(*p as i32, *q as i32);
            game_account(w, a, d);
            Pubkey::new_from_array(a)
        })
        .collect()
}

fn set_citizen(w: &mut World, wallet: &Pubkey, faction: u8) -> Pubkey {
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::WALLET, wallet.as_ref());
    d[C::FACTION] = faction;
    let a = w.ctx.citizen(&wallet.to_bytes());
    game_account(w, a, d);
    Pubkey::new_from_array(a)
}

fn system_create(payer: &Pubkey, new: &Pubkey, space: u64, owner: &Pubkey) -> Instruction {
    let mut d = 0u32.to_le_bytes().to_vec();
    d.extend_from_slice(&rent_exempt(space as usize).to_le_bytes());
    d.extend_from_slice(&space.to_le_bytes());
    d.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*new, true)],
        data: d,
    }
}

/// [mock] A token account of the test mint for `owner` (created by `payer`).
fn token_account(w: &mut World, payer: &Pubkey, n: u8, owner: &Pubkey) -> Pubkey {
    let k = key(n);
    let mut d = vec![18u8];
    d.extend_from_slice(owner.as_ref());
    let init = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(k, false),
            AccountMeta::new_readonly(w.mint, false),
        ],
        data: d,
    };
    w.h.send(&[system_create(payer, &k, 165, &TOKEN), init], &[*payer, k])
        .unwrap();
    k
}

/// [mock] The faucet: test USDC minted by the operator (POST /f/faucet's role).
fn faucet(w: &mut World, to: &Pubkey, amount: u64) {
    let mut d = vec![7u8];
    d.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(w.mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(w.operator, true),
        ],
        data: d,
    };
    let op = w.operator;
    w.h.send(&[ix], &[op]).unwrap();
}

fn world() -> World {
    let prize = key(201);
    let game = key(202);
    let operator = key(203);
    let mut h = Host::new(prize);
    h.fund(operator, 100 * SOL);
    let (season, _) =
        Pubkey::find_program_address(&[S::PDA_PREFIX, &SEASON_ID.to_le_bytes()], &game);
    let mint = key(204);
    let mut init = vec![20u8, 6];
    init.extend_from_slice(operator.as_ref());
    init.push(0);
    h.send(
        &[
            system_create(&operator, &mint, 82, &TOKEN),
            Instruction {
                program_id: TOKEN,
                accounts: vec![AccountMeta::new(mint, false)],
                data: init,
            },
        ],
        &[operator, mint],
    )
    .unwrap();
    let (pool, _) =
        Pubkey::find_program_address(&[b"pool", game.as_ref(), &SEASON_ID.to_le_bytes()], &prize);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &prize);
    let mut w = World {
        h,
        game,
        season,
        ctx: AddrCtx {
            season: season.to_bytes(),
            program: game.to_bytes(),
        },
        operator,
        mint,
        pool,
        vault,
    };
    set_season(&mut w, S::STATUS_RUNNING);
    set_frontier_and_funds(&mut w, 61);
    w
}

fn ix(w: &World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: w.h.prize,
        accounts,
        data,
    }
}

fn init_pool(w: &mut World) -> Result<(), String> {
    let mut d = vec![tag::INIT_POOL];
    d.extend_from_slice(&FEE.to_le_bytes());
    d.extend_from_slice(&2_000u16.to_le_bytes());
    d.extend_from_slice(&54u16.to_le_bytes());
    d.extend_from_slice(&[9u8; 32]);
    let i = ix(
        w,
        vec![
            AccountMeta::new(w.operator, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(w.game, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        d,
    );
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn entry_of(w: &World, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"entry", w.pool.as_ref(), wallet.as_ref()], &w.h.prize).0
}

/// [program] Pay: the wallet's entry fee into the vault (the x402 join's
/// payment part; the Join itself is the game program's and is not run).
fn pay(w: &mut World, wallet: &Pubkey, from: &Pubkey) -> Result<(), String> {
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(*wallet, true),
            AccountMeta::new(*wallet, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry_of(w, wallet), false),
            AccountMeta::new(*from, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        vec![tag::PAY],
    );
    w.h.send(&[i], &[*wallet])
}

fn tally(w: &mut World, provinces: &[Pubkey]) -> Result<(), String> {
    let mut a = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    a.extend(
        provinces
            .iter()
            .map(|p| AccountMeta::new_readonly(*p, false)),
    );
    let i = ix(w, a, vec![tag::TALLY]);
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn finalize(w: &mut World) -> Result<(), String> {
    let mut a = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    a.extend(
        funds(w)
            .iter()
            .map(|f| AccountMeta::new_readonly(*f, false)),
    );
    let i = ix(w, a, vec![tag::FINALIZE]);
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn set_shares(
    w: &mut World,
    signer: Pubkey,
    totals: [u64; 6],
    root: [u8; 32],
) -> Result<(), String> {
    set_mode(w, signer, pool::MODE_SHARES, totals, root)
}

fn set_mode(
    w: &mut World,
    signer: Pubkey,
    mode: u8,
    totals: [u64; 6],
    root: [u8; 32],
) -> Result<(), String> {
    let mut d = vec![tag::SET_SHARES, mode];
    for t in totals {
        d.extend_from_slice(&t.to_le_bytes());
    }
    d.extend_from_slice(&root);
    d.extend_from_slice(&[0xAB; 32]);
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(w.pool, false),
        ],
        d,
    );
    w.h.send(&[i], &[signer])
}

#[allow(clippy::too_many_arguments)]
fn claim(
    w: &mut World,
    wallet: &Pubkey,
    ta: &Pubkey,
    citizen: &Pubkey,
    nation: u8,
    points: u64,
    proof: &[[u8; 32]],
) -> Result<(), String> {
    let mut d = vec![tag::CLAIM, nation];
    d.extend_from_slice(&points.to_le_bytes());
    d.push(proof.len() as u8);
    for p in proof {
        d.extend_from_slice(p);
    }
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(*wallet, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry_of(w, wallet), false),
            AccountMeta::new_readonly(*citizen, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(*ta, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        d,
    );
    w.h.send(&[i], &[*wallet])
}

fn withdraw_ops(w: &mut World, to: &Pubkey) -> Result<(), String> {
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(w.operator, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        vec![tag::WITHDRAW_OPS],
    );
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn pool_data(w: &World) -> Vec<u8> {
    w.h.get(&w.pool).unwrap().data.clone()
}

fn bal(w: &World, k: &Pubkey) -> u64 {
    token_balance(&w.h, k).expect("a token account")
}

/// A player: a funded wallet and a token account holding `tokens`.
fn player(w: &mut World, n: u8, tokens: u64) -> (Pubkey, Pubkey) {
    let wallet = key(n);
    w.h.fund(wallet, SOL);
    let op = w.operator;
    let ta = token_account(w, &op, n + 100, &wallet);
    if tokens > 0 {
        faucet(w, &ta, tokens);
    }
    (wallet, ta)
}

// ------------------------------------------------------------------ ⑯

/// [stand-in] The game's CloseProvince on `prov`: the account is gone and a
/// ProvinceFund's `provinces_opened` drops by one (wedge 0 here; Finalize
/// sums all six funds, so which wedge does not change the total).
fn close_province_standin(w: &mut World, prov: &Pubkey) {
    w.h.accounts.remove(prov);
    let f = funds(w)[0];
    let mut a = w.h.get(&f).unwrap().clone();
    let n = u32::from_le_bytes(a.data[PF::PROVINCES_OPENED..PF::PROVINCES_OPENED + 4].try_into().unwrap());
    put(&mut a.data, PF::PROVINCES_OPENED, &(n - 1).to_le_bytes());
    w.h.set(f, a);
}

fn vault_bal(w: &World) -> u64 {
    bal(w, &w.vault)
}

/// D3 seen from the vault: after the stranded wallet's Citizen is closed,
/// nobody can take its share — not the wallet, not the operator
/// (WithdrawOps takes only the 20%), not a refund (the mode is fixed).
#[test]
fn v16_p1_a_closed_winner_citizen_strands_its_share_for_good() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    let (b, tb) = player(&mut w, 2, FEE);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &b, &tb).unwrap();
    let ca = set_citizen(&mut w, &a, 1);
    let cb = set_citizen(&mut w, &b, 1);
    let holders: Vec<u8> = (0..54).map(|i| if i < 20 { 1 } else { (i % 5 + 2) as u8 }).collect();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let pk = w.pool.to_bytes();
    let (la, lb) = (leaf(&pk, &a.to_bytes(), 1, 1), leaf(&pk, &b.to_bytes(), 1, 1));
    let op = w.operator;
    set_shares(&mut w, op, [0, 2, 0, 0, 0, 0], node(&la, &lb)).unwrap();
    w.h.accounts.remove(&cb); // [stand-in] CloseCitizen on b
    claim(&mut w, &a, &ta, &ca, 1, 1, &[lb]).unwrap();
    fails(claim(&mut w, &b, &tb, &cb, 1, 1, &[la]), E::BadAccount);
    let (o, to) = player(&mut w, 9, 0);
    let _ = o;
    withdraw_ops(&mut w, &to).unwrap();
    let prize = 2 * (FEE - FEE * 2_000 / 10_000);
    let stranded = prize / 2;
    assert_eq!(vault_bal(&w), stranded, "b's half of the prize stays in the vault with no instruction to move it");
    // Re-setting the mode is refused (SetShares only from FINAL).
    let op = w.operator;
    fails(set_mode(&mut w, op, pool::MODE_REFUND, [0; 6], [0; 32]), E::WrongState);
}

/// A Province closed after it was tallied and before Finalize: the game's
/// count drops below the pool's, Finalize is refused for good, and nothing
/// can leave the vault (no instruction leaves OPEN otherwise).
#[test]
fn v16_p2_a_tallied_province_closed_before_finalize_locks_every_fee() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let holders: Vec<u8> = (0..54).map(|i| (i % 6) as u8).collect();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    close_province_standin(&mut w, &provinces[0]);
    fails(finalize(&mut w), E::WrongExpectedCount);
    let op = w.operator;
    fails(set_shares(&mut w, op, [0; 6], [0; 32]), E::WrongState);
    let (_, to) = player(&mut w, 9, 0);
    fails(withdraw_ops(&mut w, &to), E::WrongState);
    assert_eq!(vault_bal(&w), FEE, "the whole fee is locked");
}

/// Provinces closed before they were tallied: the game's count drops with
/// them, so Finalize accepts a tally that never saw them. Closing the
/// leader's untallied keeps changes the winner.
#[test]
fn v16_p3_closing_untallied_keeps_before_finalize_changes_the_winner() {
    // Nation 1 holds 12 keeps, nation 2 holds 11, the others at most 8.
    let holders: Vec<u8> = (0..54)
        .map(|i| match i {
            0..=11 => 1,
            12..=22 => 2,
            _ => [3u8, 4, 5, 0][i % 4],
        })
        .collect();
    // Control: everything tallied, nation 1 wins.
    let mut w = world();
    init_pool(&mut w).unwrap();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    assert_eq!(pool_data(&w)[pool::WINNERS], 1 << 1, "control: nation 1 wins");
    // Two of nation 1's keeps closed before anyone tallied them.
    let mut w = world();
    init_pool(&mut w).unwrap();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    close_province_standin(&mut w, &provinces[0]);
    close_province_standin(&mut w, &provinces[1]);
    tally(&mut w, &provinces[2..]).unwrap();
    finalize(&mut w).unwrap();
    let won = pool_data(&w)[pool::WINNERS];
    assert_eq!(won, 1 << 2, "measured: the winner after the closes is mask {won:#04x}");
}

/// Pay after the Season is Ended: accepted until the first Tally, refused
/// after it. The pool reads no Season state in Pay.
#[test]
fn v16_p4_pay_after_the_end_lands_until_the_first_tally() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let provinces = set_provinces(&mut w, &(0..54).map(|i| (i % 6) as u8).collect::<Vec<_>>());
    set_season(&mut w, S::STATUS_ENDED);
    let (late, tl) = player(&mut w, 5, 2 * FEE);
    pay(&mut w, &late, &tl).expect("a Pay after Ended, before any Tally, lands");
    tally(&mut w, &provinces[..1]).unwrap();
    let (later, tl2) = player(&mut w, 6, FEE);
    fails(pay(&mut w, &later, &tl2), E::WrongState);
    let _ = late;
}

/// An Aborted Season: Tally and Finalize need Ended, so the pool never
/// leaves OPEN and every fee stays in the vault (the game's closes are open
/// at once on an Aborted season).
#[test]
fn v16_p5_an_aborted_season_locks_every_fee() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let provinces = set_provinces(&mut w, &(0..54).map(|i| (i % 6) as u8).collect::<Vec<_>>());
    set_season(&mut w, S::STATUS_ABORTED);
    fails(tally(&mut w, &provinces), E::SeasonNotEnded);
    fails(finalize(&mut w), E::SeasonNotEnded);
    let (_, to) = player(&mut w, 9, 0);
    fails(withdraw_ops(&mut w, &to), E::WrongState);
    assert_eq!(vault_bal(&w), FEE);
}

/// Refund mode: the Entry alone gives the claim, with or without a Citizen
/// (control for P1; ④'s D3 covers the same).
#[test]
fn v16_p6_refund_mode_needs_no_citizen() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (c, tc) = player(&mut w, 3, FEE);
    pay(&mut w, &c, &tc).unwrap();
    let cc = set_citizen(&mut w, &c, 0);
    let provinces = set_provinces(&mut w, &(0..54).map(|i| (i / 9) as u8).collect::<Vec<_>>());
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let op = w.operator;
    set_mode(&mut w, op, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    w.h.accounts.remove(&cc); // [stand-in] CloseCitizen
    let c0 = bal(&w, &tc);
    claim(&mut w, &c, &tc, &cc, 0, 0, &[]).unwrap();
    assert_eq!(bal(&w, &tc) - c0, FEE - FEE * 2_000 / 10_000, "80% of the fee back");
}
