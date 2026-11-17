//! Prize claim rights against the game's own season-end closes (workstream
//! 04, 2026-11-06). Legacy settlement path only: this changes no rule. It
//! shows, with both programs' own code, what a third party's cleanup can do
//! to an existing paid pool.
//!
//!   [game]     permutation-frontier's own `dispatch` (CloseCitizen 0x37,
//!              CloseProvince 0x24), run in this host (`Host::with_game`);
//!   [program]  permutation-prize's own process_instruction;
//!   [mock]     System / SPL Token / sysvars (src/lib.rs);
//!   [stand-in] the game's accounts at the end (Season Ended, Citizens,
//!              Provinces, ProvinceFunds), written with frontier-abi layouts
//!              at their real addresses — Join, play and EndSeason are not run.
//!
//! No keypair is generated, derived or used: every key is a fixed 32-byte
//! value or a program address; a "signer" is a key in the host's signer set.

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use permutation_prize::{entry, leaf, node, pool, share_amount, tag, PrizeError as E};
use wylls_e2e_native::solana_program::instruction::{AccountMeta, Instruction};
use wylls_e2e_native::solana_program::pubkey::Pubkey;
use wylls_e2e_native::{rent_exempt, token_balance, Acct, Host, SYSTEM, TOKEN};

const SEASON_ID: u64 = 7;
const END_BELL: u32 = 432;
const BELL_SECS: u32 = 600;
/// The host clock starts at 1,800,000,000: one bell after genesis.
const GENESIS_TS: i64 = 1_800_000_000 - 600;
const JOIN_CLOSE_BELL: u32 = 12;
/// `bell_start(genesis, end_bell)`: the season's scheduled end.
const END_TS: i64 = GENESIS_TS + END_BELL as i64 * BELL_SECS as i64;
/// The game's `END_GRACE_SECS` (permutation-frontier proc/map.rs): 72 h.
const GRACE: i64 = 72 * 3_600;
const FEE: u64 = 25_000_000;
const SOL: u64 = 1_000_000_000;
/// Game error numbers (frontier-abi `FrontierError`): TooEarly.
const GAME_TOO_EARLY: u32 = 13;

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

struct World {
    h: Host,
    game: Pubkey,
    season: Pubkey,
    bump: u8,
    ctx: AddrCtx,
    operator: Pubkey,
    mint: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
}

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}

fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}

fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

fn custom(r: &Result<(), String>) -> Option<u32> {
    let m = r.as_ref().err()?;
    let i = m.find("Custom(")? + 7;
    m[i..].split(')').next()?.parse().ok()
}

fn fails(r: Result<(), String>, e: E) {
    assert_eq!(custom(&r), Some(e as u32), "expected {e:?}: {r:?}");
}

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
    d[S::BUMP] = w.bump;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.as_ref());
    put(&mut d, S::RULESET_HASH, &permutation_frontier::RULESET_HASH);
    put(&mut d, S::END_BELL, &END_BELL.to_le_bytes());
    put(&mut d, S::BELL_SECS, &BELL_SECS.to_le_bytes());
    put(&mut d, S::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &JOIN_CLOSE_BELL.to_le_bytes());
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

fn opened_total(w: &World) -> u32 {
    funds(w)
        .iter()
        .map(|f| u32_at(&w.h.get(f).unwrap().data, PF::PROVINCES_OPENED))
        .sum()
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

/// A Citizen at its real address; `rent_payer` is who paid its rent (Join).
fn set_citizen(w: &mut World, wallet: &Pubkey, faction: u8) -> Pubkey {
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::WALLET, wallet.as_ref());
    put(&mut d, C::RENT_PAYER, wallet.as_ref());
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
    let mut h = Host::with_game(prize, game);
    h.fund(operator, 100 * SOL);
    let (season, bump) =
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
        bump,
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

fn pix(w: &World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: w.h.prize,
        accounts,
        data,
    }
}

fn init_pool(w: &mut World) {
    let mut d = vec![tag::INIT_POOL];
    d.extend_from_slice(&FEE.to_le_bytes());
    d.extend_from_slice(&2_000u16.to_le_bytes());
    d.extend_from_slice(&54u16.to_le_bytes());
    d.extend_from_slice(&[9u8; 32]);
    let i = pix(
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
    w.h.send(&[i], &[op]).unwrap();
}

fn entry_of(w: &World, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"entry", w.pool.as_ref(), wallet.as_ref()], &w.h.prize).0
}

fn pay(w: &mut World, wallet: &Pubkey, from: &Pubkey) -> Result<(), String> {
    let i = pix(
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
    let i = pix(w, a, vec![tag::TALLY]);
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
    let i = pix(w, a, vec![tag::FINALIZE]);
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn set_shares(w: &mut World, mode: u8, totals: [u64; 6], root: [u8; 32]) -> Result<(), String> {
    let mut d = vec![tag::SET_SHARES, mode];
    for t in totals {
        d.extend_from_slice(&t.to_le_bytes());
    }
    d.extend_from_slice(&root);
    d.extend_from_slice(&[0xAB; 32]);
    let op = w.operator;
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(op, true),
            AccountMeta::new(w.pool, false),
        ],
        d,
    );
    w.h.send(&[i], &[op])
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
    let i = pix(
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

/// [game] CloseCitizen 0x37 sent by `caller` (anyone; class N).
fn close_citizen(
    w: &mut World,
    caller: &Pubkey,
    citizen: &Pubkey,
    rent_payer: &Pubkey,
) -> Result<(), String> {
    let i = Instruction {
        program_id: w.game,
        accounts: vec![
            AccountMeta::new(*caller, true),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new(*citizen, false),
            AccountMeta::new(*rent_payer, false),
        ],
        data: vec![0x37],
    };
    w.h.send(&[i], &[*caller])
}

/// [game] CloseProvince 0x24 (P, Q) sent by `caller` (anyone; class N).
fn close_province(w: &mut World, caller: &Pubkey, p: i16, q: i16) -> Result<(), String> {
    let coord = permutation_frontier::proc::map::fund_wedge(
        permutation_rules::frontier::geometry::ProvinceCoord::new(p as i32, q as i32),
    );
    let mut d = vec![0x24];
    d.extend_from_slice(&p.to_le_bytes());
    d.extend_from_slice(&q.to_le_bytes());
    let i = Instruction {
        program_id: w.game,
        accounts: vec![
            AccountMeta::new(*caller, true),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new(
                Pubkey::new_from_array(w.ctx.province(p as i32, q as i32)),
                false,
            ),
            AccountMeta::new(Pubkey::new_from_array(w.ctx.province_fund(coord)), false),
        ],
        data: d,
    };
    w.h.send(&[i], &[*caller])
}

fn bal(w: &World, k: &Pubkey) -> u64 {
    token_balance(&w.h, k).expect("a token account")
}

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

/// Nation 1 holds 10 keeps, nations 0, 2–5 hold 9, 9, 9, 9, 8.
fn close_race() -> Vec<u8> {
    let mut h: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    h[53] = 1;
    h
}

fn third_party() -> Pubkey {
    key(77)
}

/// Settles a pool where a (10 pts) and b (6 pts) of nation 1 are owed shares.
fn settled_pool(
    w: &mut World,
) -> (
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    [u8; 32],
    [u8; 32],
) {
    init_pool(w);
    let (a, ta) = player(w, 1, FEE);
    let (b, tb) = player(w, 2, FEE);
    pay(w, &a, &ta).unwrap();
    pay(w, &b, &tb).unwrap();
    let ca = set_citizen(w, &a, 1);
    let cb = set_citizen(w, &b, 1);
    let provinces = set_provinces(w, &close_race());
    set_season(w, S::STATUS_ENDED);
    tally(w, &provinces).unwrap();
    finalize(w).unwrap();
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.to_bytes(), 1, 10);
    let lb = leaf(&pk, &b.to_bytes(), 1, 6);
    set_shares(w, pool::MODE_SHARES, [0, 16, 0, 0, 0, 0], node(&la, &lb)).unwrap();
    (a, ta, ca, b, tb, cb, la, lb)
}

/// A (the reported case, reproduced with both programs' code): after
/// `end + 72 h` anyone may run CloseCitizen on a winner who has not claimed
/// yet; the prize program then refuses that winner's shares claim for good
/// and the share stays in the vault with no way out. Before `end + 72 h` the
/// same close is TooEarly. Nothing in CloseCitizen looks at the prize.
#[test]
fn a_third_partys_close_citizen_after_the_grace_strands_an_unclaimed_share() {
    let mut w = world();
    let (a, ta, ca, b, tb, cb, la, lb) = settled_pool(&mut w);
    let x = third_party();
    w.h.fund(x, SOL);

    // a claims in time.
    claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).unwrap();

    // [game] TooEarly one second before end + 72 h, for anyone.
    w.h.clock.unix_timestamp = END_TS + GRACE - 1;
    let r = close_citizen(&mut w, &x, &cb, &b);
    assert_eq!(custom(&r), Some(GAME_TOO_EARLY), "{r:?}");
    assert!(w.h.get(&cb).is_some());

    // [game] At end + 72 h a third party closes b's Citizen (rent to b).
    w.h.clock.unix_timestamp = END_TS + GRACE;
    let lam_b = w.h.get(&b).unwrap().lamports;
    close_citizen(&mut w, &x, &cb, &b).unwrap();
    let gone = w.h.get(&cb).map(|a| (a.owner, a.data.len(), a.lamports));
    assert!(
        gone.is_none() || gone == Some((SYSTEM, 0, 0)),
        "the Citizen is closed: {gone:?}"
    );
    assert!(w.h.get(&b).unwrap().lamports > lam_b, "rent went to b");

    // [program] b's claim, with the correct proof, is refused for good.
    let prize = {
        let d = &w.h.get(&w.pool).unwrap().data;
        u64::from_le_bytes(d[pool::PRIZE..pool::PRIZE + 8].try_into().unwrap())
    };
    let owed_b = share_amount(prize, 1, 6, 16).unwrap();
    let (vb, b0) = (bal(&w, &w.vault), bal(&w, &tb));
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::BadAccount);
    // No other account stands in (a's live Citizen of the same nation).
    fails(claim(&mut w, &b, &tb, &ca, 1, 6, &[la]), E::BadAccount);
    assert_eq!((bal(&w, &w.vault), bal(&w, &tb)), (vb, b0));
    assert!(vb >= owed_b, "b's share is still in the vault, unreachable");
    // Join is closed after the end: the Citizen cannot come back.
}

/// D: Pay is accepted after the season has Ended, and even after the 72 h
/// grace (it checks only the pool's state and that Tally has not started).
#[test]
fn pay_is_accepted_after_the_end() {
    let mut w = world();
    init_pool(&mut w);
    set_season(&mut w, S::STATUS_ENDED);
    w.h.clock.unix_timestamp = END_TS + GRACE + 1;
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    assert_eq!(bal(&w, &w.vault), FEE);
    // Once Tally has counted anything, Pay is refused.
    let provinces = set_provinces(&mut w, &close_race());
    tally(&mut w, &provinces[..1]).unwrap();
    let (b, tb) = player(&mut w, 2, FEE);
    fails(pay(&mut w, &b, &tb), E::WrongState);
}

/// B: a Province closed (by anyone, after end + 72 h) before Tally reads it
/// leaves the count without an error: the game's own figure drops with it,
/// so Finalize agrees with a map that is missing that keep — and here the
/// winner changes (nation 1's 10 → 9 ties nation 0, 2, 3, 4).
#[test]
fn a_province_closed_before_tally_is_left_out_silently() {
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let holders = close_race();
    let provinces = set_provinces(&mut w, &holders);
    set_season(&mut w, S::STATUS_ENDED);
    w.h.clock.unix_timestamp = END_TS + GRACE;
    // The last keep is nation 1's.
    let (p, q) = keeps()[53];
    assert_eq!(holders[53], 1);
    let before = opened_total(&w);
    let x = third_party_funded(&mut w);
    close_province(&mut w, &x, p, q).unwrap();
    assert_eq!(opened_total(&w), before - 1);
    tally(&mut w, &provinces[..53]).unwrap();
    finalize(&mut w).unwrap();
    let d = &w.h.get(&w.pool).unwrap().data;
    let area: Vec<u16> = (0..6).map(|f| u16_at(d, pool::AREA + 2 * f)).collect();
    assert_eq!(area, [9, 9, 9, 9, 9, 8], "nation 1's tenth keep is gone");
    assert_ne!(d[pool::WINNERS], 0b10, "nation 1 no longer wins alone");
}

/// C: a Province closed after Tally counted it makes Finalize impossible for
/// good: the count stays 54, the game's figure is now 53.
#[test]
fn a_province_closed_after_tally_makes_finalize_impossible() {
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let provinces = set_provinces(&mut w, &close_race());
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    w.h.clock.unix_timestamp = END_TS + GRACE;
    let (p, q) = keeps()[0];
    let x = third_party_funded(&mut w);
    close_province(&mut w, &x, p, q).unwrap();
    fails(finalize(&mut w), E::WrongExpectedCount);
    // Nothing can undo it: the province cannot re-open after the end, and
    // re-tallying is a no-op (bitmap). The pool stays Open; nothing leaves.
    tally(&mut w, &provinces[1..]).unwrap();
    fails(finalize(&mut w), E::WrongExpectedCount);
    assert_eq!(
        w.h.get(&w.pool).unwrap().data[pool::STATE],
        pool::STATE_OPEN
    );
    assert_eq!(bal(&w, &w.vault), FEE);
}

/// C, in time: Tally and Finalize before end + 72 h are unaffected; a close
/// after Finalize changes nothing (the result is fixed).
#[test]
fn tally_and_finalize_within_the_grace_are_unaffected_by_later_closes() {
    let mut w = world();
    let (a, ta, ca, _b, _tb, _cb, _la, lb) = settled_pool(&mut w);
    w.h.clock.unix_timestamp = END_TS + GRACE;
    let (p, q) = keeps()[53];
    let x = third_party_funded(&mut w);
    close_province(&mut w, &x, p, q).unwrap();
    claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).unwrap();
}

/// E: an Aborted season never reaches Tally (SeasonNotEnded): the pool
/// cannot settle and nothing leaves the vault.
#[test]
fn an_aborted_season_leaves_the_pool_without_an_exit() {
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let provinces = set_provinces(&mut w, &close_race());
    set_season(&mut w, S::STATUS_ABORTED);
    fails(tally(&mut w, &provinces), E::SeasonNotEnded);
    fails(finalize(&mut w), E::SeasonNotEnded);
    assert_eq!(bal(&w, &w.vault), FEE);
}

fn third_party_funded(w: &mut World) -> Pubkey {
    let x = third_party();
    w.h.fund(x, SOL);
    x
}

#[test]
fn entry_spare_bytes_are_unused() {
    // The Entry's bytes 10–15 are not written by Pay (the fix candidate's room).
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let d = &w.h.get(&entry_of(&w, &a)).unwrap().data;
    assert_eq!(d.len(), entry::SIZE);
    assert!(d[10..16].iter().all(|b| *b == 0));
}

// ------------------------------------------------- the candidate fix
//
// permutation-prize RecordNation (tag 7, candidate): anyone copies the
// nation from the live Citizen into the wallet's Entry; Claim reads the live
// Citizen as before and, only when its address is empty, that record.

fn record_nation(
    w: &mut World,
    caller: &Pubkey,
    wallet: &Pubkey,
    citizen: &Pubkey,
) -> Result<(), String> {
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new(entry_of(w, wallet), false),
            AccountMeta::new_readonly(*citizen, false),
        ],
        vec![tag::RECORD_NATION],
    );
    w.h.send(&[i], &[*caller])
}

/// The fix: a nation recorded before the close keeps b's claim, for exactly
/// the amount owed; nothing else about the claim changes.
#[test]
fn a_recorded_nation_keeps_the_claim_after_the_citizen_is_closed() {
    let mut w = world();
    let (a, ta, ca, b, tb, cb, la, lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    // Anyone, no signature of b's: a third party records b's nation.
    record_nation(&mut w, &x, &b, &cb).unwrap();
    record_nation(&mut w, &x, &b, &cb).unwrap(); // a no-op the second time
    let e = w.h.get(&entry_of(&w, &b)).unwrap().data.clone();
    assert_eq!((e[entry::NATION_RECORDED], e[entry::NATION]), (1, 1));
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &x, &cb, &b).unwrap();
    assert!(w.h.get(&cb).is_none());

    let prize = u64::from_le_bytes(
        w.h.get(&w.pool).unwrap().data[pool::PRIZE..pool::PRIZE + 8]
            .try_into()
            .unwrap(),
    );
    let owed_b = share_amount(prize, 1, 6, 16).unwrap();
    // Unchanged checks still hold with the record: the proof, the nation.
    fails(claim(&mut w, &b, &tb, &cb, 1, 7, &[la]), E::BadProof);
    fails(claim(&mut w, &b, &tb, &cb, 2, 6, &[la]), E::NotWinner);
    // The canonical address only: another wallet's (live) Citizen is refused.
    fails(claim(&mut w, &b, &tb, &ca, 1, 6, &[la]), E::BadAccount);
    let b0 = bal(&w, &tb);
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).unwrap();
    assert_eq!(bal(&w, &tb) - b0, owed_b, "b is paid exactly its share");
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::AlreadyClaimed);
    // a (no record, live Citizen) claims as before.
    claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).unwrap();
}

/// Without a record the behaviour is exactly the old one (the claim is lost
/// once the Citizen is closed): the fix needs RecordNation before the close.
/// A record cannot be made after the close.
#[test]
fn without_a_record_the_old_behaviour_is_unchanged() {
    let mut w = world();
    let (_a, _ta, _ca, b, tb, cb, la, _lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &x, &cb, &b).unwrap();
    fails(record_nation(&mut w, &x, &b, &cb), E::BadAccount);
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::BadAccount);
}

/// RecordNation copies only the truth: the Entry's own wallet's Citizen at
/// its address, of this pool's game and season.
#[test]
fn record_nation_takes_only_the_entrys_own_citizen() {
    let mut w = world();
    let (a, _ta, ca, b, _tb, _cb, _la, _lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    // a's Citizen for b's Entry.
    fails(record_nation(&mut w, &x, &b, &ca), E::BadAccount);
    // A look-alike Citizen at the right address but not the game's.
    let (c, tc) = player(&mut w, 3, 0);
    let _ = tc;
    let cc = set_citizen(&mut w, &c, 1);
    w.h.get(&cc).unwrap();
    let mut fake = w.h.get(&cc).unwrap().clone();
    fake.owner = key(99);
    w.h.set(cc, fake);
    // c has no Entry: refused before the Citizen is even read.
    assert!(record_nation(&mut w, &x, &c, &cc).is_err());
    // a's own Citizen, made not the game's: refused.
    let mut fake = w.h.get(&ca).unwrap().clone();
    fake.owner = key(99);
    w.h.set(ca, fake);
    fails(record_nation(&mut w, &x, &a, &ca), E::BadAccount);
    let e = &w.h.get(&entry_of(&w, &a)).unwrap().data;
    assert_eq!(e[entry::NATION_RECORDED], 0, "nothing recorded");
}

/// A recorded nation never overrides a live Citizen, and a recorded nation
/// that did not win is refused like a live one.
#[test]
fn a_record_of_a_losing_nation_is_refused_like_the_citizen() {
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    let (c, tc) = player(&mut w, 3, FEE);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &c, &tc).unwrap();
    let ca = set_citizen(&mut w, &a, 1);
    let cc = set_citizen(&mut w, &c, 0);
    let x = third_party_funded(&mut w);
    // Recorded while the season still runs (the nation is fixed at Join).
    record_nation(&mut w, &x, &c, &cc).unwrap();
    let provinces = set_provinces(&mut w, &close_race());
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.to_bytes(), 1, 1);
    let lc = leaf(&pk, &c.to_bytes(), 0, 1);
    set_shares(
        &mut w,
        pool::MODE_SHARES,
        [0, 1, 0, 0, 0, 0],
        node(&la, &lc),
    )
    .unwrap();
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &x, &cc, &c).unwrap();
    fails(claim(&mut w, &c, &tc, &cc, 0, 1, &[la]), E::NotWinner);
    claim(&mut w, &a, &ta, &ca, 1, 1, &[lc]).unwrap();
}

/// Refund mode is untouched: it never needed the Citizen.
#[test]
fn refund_mode_needs_no_citizen_with_or_without_the_fix() {
    let mut w = world();
    init_pool(&mut w);
    let (a, ta) = player(&mut w, 1, FEE);
    pay(&mut w, &a, &ta).unwrap();
    let ca = set_citizen(&mut w, &a, 1);
    let provinces = set_provinces(&mut w, &close_race());
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces).unwrap();
    finalize(&mut w).unwrap();
    set_shares(&mut w, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    let x = third_party_funded(&mut w);
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &x, &ca, &a).unwrap();
    let a0 = bal(&w, &ta);
    claim(&mut w, &a, &ta, &ca, 0, 0, &[]).unwrap();
    assert!(bal(&w, &ta) > a0);
}
