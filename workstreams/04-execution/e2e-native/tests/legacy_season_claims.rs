//! **Legacy compatibility only** (2026-10-31 direction: the world no longer
//! ends; a season end is not the target design and is never a reason to end a
//! new world). What this keeps checking: the deployed prize program's existing
//! path — paid entries and the claim rights they give — still pays out exactly,
//! in one world: test USDC → entry fee (Pay) → [game: stand-in] → the old
//! season end → Tally → Finalize → SetShares → Claim → the payout read back
//! from the winner's token account → WithdrawOps → every token accounted for.
//!
//! Each step is labelled with what ran it:
//!   [program] permutation-prize's own process_instruction (host build);
//!   [mock]    this harness's System / SPL Token / sysvars (src/lib.rs);
//!   [stand-in] game accounts written with frontier-abi layouts — the game
//!             program (Join, play, EndSeason) is NOT run here.
//!
//! Fixed test conditions (not new rules): the owner's decided fee split 80/20,
//! the winner by area (permutation-prize), shares by points in the winning
//! nation; fee 25 test USDC (6 decimals). Nothing has value; no network.

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

/// The through path: three paid players, nation 1 wins by area, a and b
/// (nation 1) claim by points, c (nation 0) cannot, the operator takes the
/// 20%; every test USDC that came in is accounted for.
#[test]
fn legacy_paid_entry_claim_pays_out_exactly() {
    let mut w = world();
    // 1. [program] InitPool: only the season's authority; vault owned by the pool PDA.
    init_pool(&mut w).unwrap();
    let v = w.h.get(&w.vault).unwrap();
    assert_eq!((v.owner, v.data.len()), (TOKEN, spl::ACCOUNT_LEN));
    assert_eq!(&v.data[32..64], w.pool.as_ref());

    // 2. [mock] Test USDC from the faucet; [program] Pay (entry fee).
    let (a, ta) = player(&mut w, 1, FEE);
    let (b, tb) = player(&mut w, 2, FEE);
    let (c, tc) = player(&mut w, 3, FEE);
    let (poor, tpoor) = player(&mut w, 4, FEE - 1);
    for (k, t) in [(a, ta), (b, tb), (c, tc)] {
        pay(&mut w, &k, &t).unwrap();
    }
    fails(pay(&mut w, &a, &ta), E::AlreadyPaid);
    assert!(pay(&mut w, &poor, &tpoor).is_err(), "no fee, no entry");
    assert!(
        w.h.get(&entry_of(&w, &poor)).is_none(),
        "nothing of the refused payment stays"
    );
    assert_eq!(bal(&w, &w.vault), 3 * FEE);
    let d = pool_data(&w);
    assert_eq!(u64_at(&d, pool::COLLECTED), 3 * FEE);
    let prize = u64_at(&d, pool::PRIZE);
    let ops = u64_at(&d, pool::OPS);
    assert_eq!((prize, ops), (3 * FEE * 80 / 100, 3 * FEE * 20 / 100));

    // 3. [stand-in] The game: Citizens (Join), the provinces at the end, Ended.
    let ca = set_citizen(&mut w, &a, 1);
    let cb = set_citizen(&mut w, &b, 1);
    let cc = set_citizen(&mut w, &c, 0);
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[0] = 1; // nation 1 took one keep from nation 0: 8/10/9/9/9/9
    let provinces = set_provinces(&mut w, &holders);
    fails(tally(&mut w, &provinces[..10]), E::SeasonNotEnded);
    set_season(&mut w, S::STATUS_ENDED);

    // 4. [program] The result: Tally (in chunks), Finalize from the game's funds.
    tally(&mut w, &provinces[..30]).unwrap();
    fails(finalize(&mut w), E::TallyIncomplete);
    tally(&mut w, &provinces[30..]).unwrap();
    finalize(&mut w).unwrap();
    let d = pool_data(&w);
    let area: Vec<u16> = (0..6).map(|f| u16_at(&d, pool::AREA + 2 * f)).collect();
    assert_eq!(area, [8, 10, 9, 9, 9, 9]);
    assert_eq!(
        (d[pool::STATE], d[pool::WINNERS]),
        (pool::STATE_FINAL, 0b10),
        "nation 1 won"
    );

    // 5. [program] SetShares: a 10 points, b 6 points (nation 1).
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.to_bytes(), 1, 10);
    let lb = leaf(&pk, &b.to_bytes(), 1, 6);
    let root = node(&la, &lb);
    fails(
        set_shares(&mut w, a, [0, 16, 0, 0, 0, 0], root),
        E::NotOperator,
    );
    let op = w.operator;
    set_shares(&mut w, op, [0, 16, 0, 0, 0, 0], root).unwrap();

    // 6. [program] Claim, and the payout read back from the token accounts.
    let share_nations = pool_data(&w)[pool::SHARE_NATIONS];
    let want_a = share_amount(prize, share_nations, 10, 16).unwrap();
    let want_b = share_amount(prize, share_nations, 6, 16).unwrap();
    let (a0, b0, v0) = (bal(&w, &ta), bal(&w, &tb), bal(&w, &w.vault));
    assert!(
        claim(&mut w, &a, &ta, &ca, 1, 11, &[lb]).is_err(),
        "points not in the root"
    );
    claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).unwrap();
    assert!(claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).is_err(), "once");
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).unwrap();
    assert!(
        claim(&mut w, &c, &tc, &cc, 0, 1, &[]).is_err(),
        "nation 0 did not win"
    );
    assert_eq!(bal(&w, &ta) - a0, want_a, "a's payout arrived");
    assert_eq!(bal(&w, &tb) - b0, want_b, "b's payout arrived");
    assert_eq!(v0 - bal(&w, &w.vault), want_a + want_b);
    assert_eq!(bal(&w, &tc), 0, "c paid and won nothing");

    // 7. [program] The operator's 20%.
    let to = token_account(&mut w, &op, 205, &op);
    withdraw_ops(&mut w, &to).unwrap();
    assert_eq!(bal(&w, &to), ops);
    assert!(
        withdraw_ops(&mut w, &to).is_err() || bal(&w, &to) == ops,
        "not twice"
    );

    // 8. Every test USDC accounted for: paid in = payouts + ops + left in the vault.
    let d = pool_data(&w);
    let left = bal(&w, &w.vault);
    assert_eq!(3 * FEE, want_a + want_b + ops + left);
    assert_eq!(u64_at(&d, pool::CLAIMED), want_a + want_b);
    assert!(left < 2, "only rounding stays: {left}");
}

/// The payout is refused, and nothing moves, for a wallet that did not pay
/// (no Entry) even when its Citizen is of the winning nation.
#[test]
fn unpaid_winner_cannot_claim() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    let (b, tb) = player(&mut w, 2, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let _ca = set_citizen(&mut w, &a, 1);
    let cb = set_citizen(&mut w, &b, 1);
    let holders: Vec<u8> = (0..54)
        .map(|i| if i < 20 { 1 } else { (i % 5 + 2) as u8 })
        .collect();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.to_bytes(), 1, 1);
    let lb = leaf(&pk, &b.to_bytes(), 1, 1);
    let op = w.operator;
    set_shares(&mut w, op, [0, 2, 0, 0, 0, 0], node(&la, &lb)).unwrap();
    let before = (bal(&w, &tb), bal(&w, &w.vault));
    assert!(claim(&mut w, &b, &tb, &cb, 1, 1, &[la]).is_err());
    assert_eq!((bal(&w, &tb), bal(&w, &w.vault)), before, "nothing moved");
}

/// Workstream 17's D2, on the program's own code: while the season runs
/// (the world goes on), entry fees keep coming in and nothing can leave
/// the vault — Tally and Finalize need the Season Ended, SetShares, Claim
/// and WithdrawOps need Finalize. A continuing world never reaches either.
#[test]
fn while_the_world_runs_deposits_have_no_exit() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    let (b, tb) = player(&mut w, 2, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let ca = set_citizen(&mut w, &a, 1);
    let holders: Vec<u8> = (0..54).map(|i| (i % 6) as u8).collect();
    let provinces = set_provinces(&mut w, &holders);
    fails(tally(&mut w, &provinces), E::SeasonNotEnded);
    fails(finalize(&mut w), E::SeasonNotEnded);
    let op = w.operator;
    fails(
        set_shares(&mut w, op, [0, 1, 0, 0, 0, 0], [0; 32]),
        E::WrongState,
    );
    assert!(claim(&mut w, &a, &ta, &ca, 1, 1, &[]).is_err());
    let to = token_account(&mut w, &op, 205, &op);
    fails(withdraw_ops(&mut w, &to), E::WrongState);
    pay(&mut w, &b, &tb).unwrap();
    assert_eq!(
        bal(&w, &w.vault),
        2 * FEE,
        "everything paid in stays, with no way out"
    );
}

/// Workstream 17's D3: a shares-mode claim needs the winner's Citizen
/// account (the game's, at its address). Once the game's cleanup has
/// closed it (CloseCitizen is open to anyone 72 h after the end; here the
/// account is simply gone), that wallet's claim is refused and its share
/// stays in the vault for good. A refund-mode claim needs only the Entry.
#[test]
fn a_closed_citizen_loses_its_shares_claim_but_not_a_refund() {
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (a, ta) = player(&mut w, 1, FEE);
    let (b, tb) = player(&mut w, 2, FEE);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &b, &tb).unwrap();
    let ca = set_citizen(&mut w, &a, 1);
    let cb = set_citizen(&mut w, &b, 1);
    let holders: Vec<u8> = (0..54)
        .map(|i| if i < 20 { 1 } else { (i % 5 + 2) as u8 })
        .collect();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.to_bytes(), 1, 1);
    let lb = leaf(&pk, &b.to_bytes(), 1, 1);
    let op = w.operator;
    set_shares(&mut w, op, [0, 2, 0, 0, 0, 0], node(&la, &lb)).unwrap();
    // [stand-in] the game's cleanup closed b's Citizen.
    w.h.accounts.remove(&cb);
    let before = (bal(&w, &tb), bal(&w, &w.vault));
    assert!(claim(&mut w, &b, &tb, &cb, 1, 1, &[la]).is_err());
    assert_eq!(
        (bal(&w, &tb), bal(&w, &w.vault)),
        before,
        "b's share is stranded"
    );
    claim(&mut w, &a, &ta, &ca, 1, 1, &[lb]).unwrap();

    // Refund mode: no points; the Entry alone gives the claim.
    let mut w = world();
    init_pool(&mut w).unwrap();
    let (c, tc) = player(&mut w, 3, FEE);
    pay(&mut w, &c, &tc).unwrap();
    let cc = Pubkey::new_from_array(w.ctx.citizen(&c.to_bytes())); // never written
    let holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let op = w.operator;
    set_mode(&mut w, op, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    let c0 = bal(&w, &tc);
    claim(&mut w, &c, &tc, &cc, 0, 0, &[]).unwrap();
    assert!(bal(&w, &tc) > c0, "refunded without a Citizen");
}
