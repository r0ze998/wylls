//! ⑯ independent verification of ④'s fix candidate RecordNation (prize tag 7,
//! f43eb4eb86f9aec6949ecf361ea13d35694ff639) against the game's real
//! CloseCitizen (permutation-frontier `dispatch`, run in ④'s e2e-native host
//! with `Host::with_game`). Place in workstreams/04-execution/e2e-native/tests/.
//!
//! No key is generated, derived or signed: fixed 32-byte keys; a "signer"
//! is a key in the host's signer set (no ed25519). The programs and the
//! helpers compute program-derived ADDRESSES (public, no secret key).
//!
//! The helper section (down to `settled_pool`, plus `third_party_funded`
//! and `record_nation`) is copied verbatim from ④'s `claims_vs_closes.rs`
//! at f43eb4eb; the scenarios after it are ⑯'s.

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

fn third_party_funded(w: &mut World) -> Pubkey {
    let x = third_party();
    w.h.fund(x, SOL);
    x
}

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

// ------------------------------------------------------------------ ⑯

fn owed(w: &World, points: u64) -> u64 {
    let d = &w.h.get(&w.pool).unwrap().data;
    let prize = u64::from_le_bytes(d[pool::PRIZE..pool::PRIZE + 8].try_into().unwrap());
    share_amount(prize, d[pool::SHARE_NATIONS], points, 16).unwrap()
}

fn closed_at_grace(w: &mut World, cb: &Pubkey, b: &Pubkey) {
    w.h.clock.unix_timestamp = END_TS + GRACE;
    let x = third_party_funded(w);
    close_citizen(w, &x, cb, b).expect("[game] a third party closes b's Citizen at end + 72 h");
}

/// F1: recorded by a third party (no signature of b's) before the close, b's
/// claim after the real close pays exactly what b is owed.
#[test]
fn v16_f1_recorded_before_the_close_the_claim_survives_it() {
    let mut w = world();
    let (_a, _ta, _ca, b, tb, cb, la, _lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    record_nation(&mut w, &x, &b, &cb).unwrap();
    closed_at_grace(&mut w, &cb, &b);
    let want = owed(&w, 6);
    let b0 = bal(&w, &tb);
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).unwrap();
    assert_eq!(bal(&w, &tb) - b0, want);
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::AlreadyClaimed);
}

/// F2 (residual): with no record, the close still strands b's share — the fix
/// helps only an Entry somebody recorded in time.
#[test]
fn v16_f2_without_a_record_the_close_still_strands_the_share() {
    let mut w = world();
    let (_a, _ta, _ca, b, tb, cb, la, _lb) = settled_pool(&mut w);
    closed_at_grace(&mut w, &cb, &b);
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::BadAccount);
}

/// F3 (residual): the window ends at the close — after it nothing can be
/// recorded (the Citizen is gone).
#[test]
fn v16_f3_nothing_can_be_recorded_after_the_close() {
    let mut w = world();
    let (_a, _ta, _ca, b, tb, cb, la, _lb) = settled_pool(&mut w);
    closed_at_grace(&mut w, &cb, &b);
    let x = third_party_funded(&mut w);
    assert!(record_nation(&mut w, &x, &b, &cb).is_err(), "recorded from a closed Citizen");
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::BadAccount);
}

/// F4: somebody sends lamports to the closed Citizen's address (a System
/// account with no data). The recorded claim still pays; an unrecorded one is
/// still refused, with the same error (no new path either way).
#[test]
fn v16_f4_lamports_sent_to_the_closed_address_change_nothing() {
    let mut w = world();
    let (a, ta, ca, b, tb, cb, la, lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    record_nation(&mut w, &x, &b, &cb).unwrap();
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &x, &cb, &b).unwrap();
    close_citizen(&mut w, &x, &ca, &a).unwrap();
    w.h.fund(cb, SOL);
    w.h.fund(ca, SOL);
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).unwrap();
    fails(claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]), E::BadAccount);
}

/// F5 (measured; depends on the game never changing a Citizen's nation, which
/// holds in the game code read: only Join writes C::FACTION): if the live
/// Citizen's nation differed from the record, a second record is refused, the
/// claim follows the live Citizen while it exists and the record once it is
/// closed. [stand-in] the faction byte is rewritten directly.
#[test]
fn v16_f5_record_and_live_citizen_disagree() {
    let mut w = world();
    let (_a, _ta, _ca, b, tb, cb, la, _lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    record_nation(&mut w, &x, &b, &cb).unwrap();
    let mut acct = w.h.get(&cb).unwrap().clone();
    acct.data[C::FACTION] = 2;
    w.h.set(cb, acct);
    fails(record_nation(&mut w, &x, &b, &cb), E::BadAccount);
    fails(claim(&mut w, &b, &tb, &cb, 1, 6, &[la]), E::NotWinner);
    closed_at_grace(&mut w, &cb, &b);
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).expect("after the close the record (nation 1) decides");
}

/// F6: RecordNation cannot be pointed at something that is not a paid
/// Entry of this pool, nor at another wallet's Citizen.
#[test]
fn v16_f6_record_needs_this_pools_entry_and_its_wallets_citizen() {
    let mut w = world();
    let (a, _ta, ca, b, _tb, cb, _la, _lb) = settled_pool(&mut w);
    let x = third_party_funded(&mut w);
    // b's Entry with a's Citizen.
    fails(record_nation(&mut w, &x, &b, &ca), E::BadAccount);
    // A wallet that never paid: its Entry address is empty.
    let nobody = key(88);
    let cn = set_citizen(&mut w, &nobody, 1);
    assert!(record_nation(&mut w, &x, &nobody, &cn).is_err());
    // A fake "Entry" owned by someone else at b's Entry address is impossible
    // to place on chain (a PDA of the prize program); a copy of b's Entry
    // owned by another program is refused.
    let e = entry_of(&w, &b);
    let mut fake = w.h.get(&e).unwrap().clone();
    fake.owner = x;
    w.h.set(e, fake);
    fails(record_nation(&mut w, &x, &b, &cb), E::BadAccount);
    let _ = (a,);
}
