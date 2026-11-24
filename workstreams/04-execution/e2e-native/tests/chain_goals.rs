//! World goals' prize pool (permutation-prize feature `goals`, design record
//! `docs/design/win-conditions/01-proposal.ja.md` §7, §10.1), end to end in
//! one continuous world: test USDC → 30-day passes → a hegemony goal posted →
//! [stand-in] flag keeps held → Achieve (judged on chain) → the ledger's
//! merkle root → claims, with every refusal of §7.4 → sweep → the operator's
//! part; then the attested kinds (dispute window, void, return), retiring
//! an unachieved goal, and the legal gate.
//!
//!   [program]  permutation-prize's own process_instruction (host build)
//!   [mock]     System / SPL Token / sysvars (src/lib.rs)
//!   [stand-in] the game's Season (continuous, running), Provinces and
//!              Citizens written with frontier-abi layouts — the game program
//!              is not run
//!
//! Keys are fixed 32-byte values; nothing is signed; no network. Test USDC.

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use permutation_prize::goals::{self, goal, gpool, Params};
use permutation_prize::{leaf, node, share_amount, tag, PrizeError as E};
use wylls_e2e_native::solana_program::instruction::{AccountMeta, Instruction};
use wylls_e2e_native::solana_program::pubkey::Pubkey;
use wylls_e2e_native::{rent_exempt, token_balance, Acct, Host, SYSTEM, TOKEN};

const SEASON_ID: u64 = 9;
const BELL_SECS: u32 = 600;
const NOW: i64 = 1_800_000_000;
/// The world began 400 bells ago (posting happens at bell 400).
const GENESIS_TS: i64 = NOW - 400 * BELL_SECS as i64;
const SOL: u64 = 1_000_000_000;
const DAY: i64 = 86_400;
/// The test mint (6 decimals, the operator's).
const MINT: Pubkey = Pubkey::new_from_array([204; 32]);

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}
fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn fails(r: Result<(), String>, e: E) {
    let want = format!("Custom({})", e as u32);
    match r {
        Ok(()) => panic!("expected {e:?}, it landed"),
        Err(m) => assert!(m.contains(&want), "expected {e:?} ({want}): {m}"),
    }
}

struct World {
    h: Host,
    game: Pubkey,
    season: Pubkey,
    ctx: AddrCtx,
    operator: Pubkey,
    gate: Pubkey,
    mint: Pubkey,
    gpool: Pubkey,
    vault: Pubkey,
}

fn game_account(w: &mut World, addr: [u8; 32], data: Vec<u8>) {
    w.h.set(
        Pubkey::new_from_array(addr),
        Acct {
            lamports: rent_exempt(data.len()),
            data,
            owner: w.game,
            executable: false,
        },
    );
}

/// [stand-in] The Season: continuous (`continuous = 1`), running, no end.
fn set_season(w: &mut World, continuous: u8) {
    let mut d = vec![0u8; S::SIZE];
    put(&mut d, 0, &S::MAGIC);
    put(&mut d, S::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[S::STATUS] = S::STATUS_RUNNING;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.as_ref());
    put(&mut d, S::JOIN_GATE, w.gate.as_ref());
    put(&mut d, S::BELL_SECS, &BELL_SECS.to_le_bytes());
    put(&mut d, S::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    let cq = frontier_abi::v2::presets::SEASON_CQ_OFFSET;
    d[cq + frontier_abi::v2::presets::cq_layout::CONTINUOUS] = continuous;
    // A map that grows to ring 128 (devnet's playable world): no limit here.
    put(
        &mut d,
        cq + frontier_abi::v2::presets::cq_layout::R_MAX_CEILING,
        &128u16.to_le_bytes(),
    );
    let k = w.season.to_bytes();
    game_account(w, k, d);
}

/// [stand-in] A province with a keep held by `holder` since `since`,
/// resolved up to (not including) `resolved_next`.
fn set_keep(w: &mut World, (p, q): (i16, i16), holder: u8, since: u32, resolved_next: u32) {
    let mut d = vec![0u8; P::SIZE];
    put(&mut d, 0, &P::MAGIC);
    put(&mut d, P::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, P::P, &p.to_le_bytes());
    put(&mut d, P::Q, &q.to_le_bytes());
    put(&mut d, P::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    d[P::KEEP + K::TILE] = 30;
    d[P::KEEP + K::HOLDER] = holder;
    put(&mut d, P::KEEP + K::SINCE_BELL, &since.to_le_bytes());
    let a = w.ctx.province(p as i32, q as i32);
    game_account(w, a, d);
}

fn province(w: &World, (p, q): (i16, i16)) -> Pubkey {
    Pubkey::new_from_array(w.ctx.province(p as i32, q as i32))
}

/// [stand-in] A Citizen of `faction`, joined at `join_bell`.
fn set_citizen(w: &mut World, wallet: &Pubkey, faction: u8, join_bell: u32) -> Pubkey {
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::WALLET, wallet.as_ref());
    d[C::FACTION] = faction;
    put(&mut d, C::JOIN_BELL, &join_bell.to_le_bytes());
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

fn token_account(w: &mut World, n: u8, owner: &Pubkey) -> Pubkey {
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
    let op = w.operator;
    w.h.send(&[system_create(&op, &k, 165, &TOKEN), init], &[op, k])
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

fn make_mint(h: &mut Host, operator: &Pubkey, mint: &Pubkey) {
    let mut init = vec![20u8, 6];
    init.extend_from_slice(operator.as_ref());
    init.push(0);
    h.send(
        &[
            system_create(operator, mint, 82, &TOKEN),
            Instruction {
                program_id: TOKEN,
                accounts: vec![AccountMeta::new(*mint, false)],
                data: init,
            },
        ],
        &[*operator, *mint],
    )
    .unwrap();
}

fn world() -> World {
    let prize = key(201);
    let game = key(202);
    let operator = key(203);
    let mut h = Host::new(prize);
    h.clock.unix_timestamp = NOW;
    h.fund(operator, 100 * SOL);
    let (season, _) =
        Pubkey::find_program_address(&[S::PDA_PREFIX, &SEASON_ID.to_le_bytes()], &game);
    let mint = key(204);
    make_mint(&mut h, &operator, &mint);
    let (gp, _) = goals::goal_pool_address(&prize, &game, SEASON_ID);
    let (vault, _) = permutation_prize::vault_address(&prize, &gp);
    let mut w = World {
        h,
        game,
        season,
        ctx: AddrCtx {
            season: season.to_bytes(),
            program: game.to_bytes(),
        },
        operator,
        gate: key(205),
        mint,
        gpool: gp,
        vault,
    };
    w.h.fund(w.gate, SOL);
    set_season(&mut w, 1);
    w
}

fn ix(w: &World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: w.h.prize,
        accounts,
        data,
    }
}

fn params() -> Params {
    Params::recommended([9u8; 32])
}

fn init(w: &mut World, mint: Pubkey, p: &Params) -> Result<(), String> {
    let mut d = vec![tag::INIT_GOAL_POOL];
    d.extend_from_slice(&goals::init_data(p));
    let i = ix(
        w,
        vec![
            AccountMeta::new(w.operator, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(mint, false),
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

fn exclusion(w: &World, wallet: &Pubkey) -> Pubkey {
    permutation_prize::member::exclusion_address(&w.h.prize, &w.game, SEASON_ID, wallet).0
}

fn pass_of(w: &World, wallet: &Pubkey) -> Pubkey {
    goals::pass_address(&w.h.prize, &w.gpool, wallet).0
}

fn buy_pass(w: &mut World, wallet: &Pubkey, from: &Pubkey) -> Result<(), String> {
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(*wallet, true),
            AccountMeta::new(*wallet, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(pass_of(w, wallet), false),
            AccountMeta::new(*from, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(exclusion(w, wallet), false),
        ],
        vec![tag::BUY_PASS],
    );
    w.h.send(&[i], &[*wallet])
}

fn exclude(w: &mut World, wallet: &Pubkey) -> Result<(), String> {
    let i = ix(
        w,
        vec![
            AccountMeta::new_readonly(w.gate, true),
            AccountMeta::new(w.gate, true),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(w.game, false),
            AccountMeta::new(exclusion(w, wallet), false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        vec![tag::EXCLUDE_WALLET],
    );
    let g = w.gate;
    w.h.send(&[i], &[g])
}

fn goal_of(w: &World, kind: u8, round: u32) -> Pubkey {
    goals::goal_address(&w.h.prize, &w.gpool, kind, round).0
}

#[allow(clippy::too_many_arguments)]
fn post(
    w: &mut World,
    kind: u8,
    round: u32,
    need: u8,
    hold: u32,
    payout_bps: u16,
    flags: &[(i16, i16)],
) -> Result<(), String> {
    let mut d = vec![tag::POST_GOAL];
    d.extend_from_slice(&goals::post_data(
        kind,
        round,
        need,
        hold,
        payout_bps,
        &[0x5a; 32],
        flags,
    ));
    let i = ix(
        w,
        vec![
            AccountMeta::new(w.operator, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(goal_of(w, kind, round), false),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        d,
    );
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn achieve(w: &mut World, round: u32, flags: &[(i16, i16)]) -> Result<(), String> {
    let mut accounts = vec![
        AccountMeta::new(goal_of(w, 0, round), false),
        AccountMeta::new(w.gpool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    accounts.extend(
        flags
            .iter()
            .map(|f| AccountMeta::new_readonly(province(w, *f), false)),
    );
    let i = ix(w, accounts, vec![tag::ACHIEVE]);
    // Anyone may send it: a stranger with no role.
    w.h.send(&[i], &[])
}

fn op_ix(w: &mut World, t: u8, goal: Pubkey, data: &[u8]) -> Result<(), String> {
    let mut d = vec![t];
    d.extend_from_slice(data);
    let mut accounts = vec![
        AccountMeta::new_readonly(w.operator, true),
        AccountMeta::new(goal, false),
        AccountMeta::new(w.gpool, false),
    ];
    if t == tag::ATTEST_ACHIEVE {
        accounts.push(AccountMeta::new_readonly(w.season, false));
    }
    let i = ix(w, accounts, d);
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn shares_data(mode: u8, totals: [u64; 6], root: [u8; 32]) -> Vec<u8> {
    let mut d = vec![mode];
    for t in totals {
        d.extend_from_slice(&t.to_le_bytes());
    }
    d.extend_from_slice(&root);
    d.extend_from_slice(&[0x1e; 32]); // the published ledger's sha256
    d
}

fn sweep(w: &mut World, goal: Pubkey) -> Result<(), String> {
    let i = ix(
        w,
        vec![
            AccountMeta::new(goal, false),
            AccountMeta::new(w.gpool, false),
        ],
        vec![tag::GOAL_SWEEP],
    );
    w.h.send(&[i], &[])
}

struct Who {
    wallet: Pubkey,
    token: Pubkey,
    citizen: Pubkey,
}

fn member(w: &mut World, n: u8, faction: u8, join_bell: u32) -> Who {
    let wallet = key(n);
    w.h.fund(wallet, SOL);
    let token = token_account(w, n + 100, &wallet);
    faucet(w, &token, 100_000_000);
    let citizen = set_citizen(w, &wallet, faction, join_bell);
    Who {
        wallet,
        token,
        citizen,
    }
}

fn claim(
    w: &mut World,
    goal: Pubkey,
    who: &Who,
    nation: u8,
    points: u64,
    proof: &[[u8; 32]],
) -> Result<(), String> {
    let mut d = vec![tag::GOAL_CLAIM];
    d.extend_from_slice(&goals::claim_data(nation, points, proof));
    let receipt = goals::receipt_address(&w.h.prize, &goal, &who.wallet).0;
    let i = ix(
        w,
        vec![
            AccountMeta::new(who.wallet, true),
            AccountMeta::new(goal, false),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new_readonly(pass_of(w, &who.wallet), false),
            AccountMeta::new(receipt, false),
            AccountMeta::new_readonly(who.citizen, false),
            AccountMeta::new_readonly(exclusion(w, &who.wallet), false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(who.token, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        d,
    );
    w.h.send(&[i], &[who.wallet])
}

/// A merkle tree over leaves (sorted pairs, the odd one carried up), as
/// permutation-gateway's `merkleTree`: root and every leaf's proof.
fn tree(leaves: &[[u8; 32]]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let mut proofs: Vec<Vec<[u8; 32]>> = vec![vec![]; leaves.len()];
    let mut level: Vec<([u8; 32], Vec<usize>)> = leaves
        .iter()
        .enumerate()
        .map(|(i, l)| (*l, vec![i]))
        .collect();
    while level.len() > 1 {
        let mut next = vec![];
        for pair in level.chunks(2) {
            if let [a, b] = pair {
                for i in &a.1 {
                    proofs[*i].push(b.0);
                }
                for i in &b.1 {
                    proofs[*i].push(a.0);
                }
                let mut ids = a.1.clone();
                ids.extend(&b.1);
                next.push((node(&a.0, &b.0), ids));
            } else {
                next.push(pair[0].clone());
            }
        }
        level = next;
    }
    (level[0].0, proofs)
}

fn data(w: &World, k: &Pubkey) -> Vec<u8> {
    w.h.get(k).unwrap().data.clone()
}
fn treasury(w: &World, kind: usize) -> u64 {
    u64_at(&data(w, &w.gpool), gpool::TREASURY + 8 * kind)
}
fn bal(w: &World, k: &Pubkey) -> u64 {
    token_balance(&w.h, k).expect("a token account")
}
fn advance(w: &mut World, secs: i64) {
    w.h.clock.unix_timestamp += secs;
}
fn bell_now(w: &World) -> u32 {
    ((w.h.clock.unix_timestamp - GENESIS_TS) / BELL_SECS as i64) as u32
}

/// Flag keeps: 6 provinces, one on ring 40 (Q18: no ring limit).
const FLAGS: [(i16, i16); 6] = [(2, 0), (0, 2), (-2, 0), (3, -1), (-1, 3), (40, -10)];

/// The through path: passes, a hegemony goal, the on-chain judge, the
/// ledger root, claims and every refusal, the sweep, the operator's part —
/// every test USDC accounted for.
#[test]
fn goal_pool_pays_contributors_once_and_refuses_the_rest() {
    let mut w = world();
    assert_eq!(ring_of(40, -10), 40);
    let p = params();
    init(&mut w, MINT, &p).unwrap();
    // A second InitGoalPool for the same season: the PDA exists.
    assert!(init(&mut w, MINT, &p).is_err());

    // Nation 2: a (30 points), b (10), g (0 points), d (joined too late),
    // f (no pass), h (pass bought after the achievement), e (operator AI).
    // Nation 1: c.
    let a = member(&mut w, 11, 2, 0);
    let b = member(&mut w, 12, 2, 0);
    let c = member(&mut w, 13, 1, 0);
    let d = member(&mut w, 14, 2, 450);
    let e = member(&mut w, 15, 2, 0);
    let f = member(&mut w, 16, 2, 0);
    let g = member(&mut w, 17, 2, 0);
    let h = member(&mut w, 18, 2, 0);
    for who in [&a, &b, &c, &d, &g] {
        buy_pass(&mut w, &who.wallet, &who.token).unwrap();
    }
    // Q17 (b): the operator's AI resident, marked by the join gate, cannot buy.
    exclude(&mut w, &e.wallet).unwrap();
    fails(buy_pass(&mut w, &e.wallet, &e.token), E::OperatorMember);

    // 5 passes × 25: 125 in, 25 the operator's, 100 prize — all hegemony
    // while no other kind has been posted (§7.2).
    let gd = data(&w, &w.gpool);
    assert_eq!(u64_at(&gd, gpool::COLLECTED), 125_000_000);
    assert_eq!(u64_at(&gd, gpool::OPS), 25_000_000);
    assert_eq!(treasury(&w, 0), 100_000_000);
    assert_eq!((1..4).map(|k| treasury(&w, k)).sum::<u64>(), 0);
    assert_eq!(bal(&w, &w.vault), 125_000_000);

    // Round 1 of hegemony: 6 flags, need 3, held 144 bells, pays 30 %.
    fails(post(&mut w, 0, 2, 3, 144, 3_000, &FLAGS), E::WrongState); // not the next round
    fails(post(&mut w, 0, 1, 7, 144, 3_000, &FLAGS), E::BadParams); // need > flags
    fails(
        post(&mut w, 0, 1, 3, 144, 3_000, &[(2, 0), (2, 0)]),
        E::BadParams,
    ); // duplicate
    post(&mut w, 0, 1, 3, 144, 3_000, &FLAGS).unwrap();
    let g1 = goal_of(&w, 0, 1);
    assert_eq!(u32_at(&data(&w, &g1), goal::POSTED_BELL), 400);
    fails(post(&mut w, 0, 2, 3, 144, 3_000, &FLAGS), E::WrongState); // one live goal per kind

    // Nation 2 takes three flags (bells 380, 410, 420); nation 3 holds one.
    for (i, (holder, since)) in [(2u8, 380u32), (2, 410), (2, 420), (3, 0), (255, 0), (5, 0)]
        .iter()
        .enumerate()
    {
        set_keep(&mut w, FLAGS[i], *holder, *since, 401);
    }
    fails(achieve(&mut w, 1, &FLAGS), E::NotAchieved);
    // Wrong province list: refused.
    assert!(achieve(&mut w, 1, &FLAGS[..5])
        .unwrap_err()
        .contains("NotEnoughAccountKeys"));
    // Hold times: max(since, 400) + 144 → 544, 554, 564: reached at 564.
    advance(&mut w, 170 * BELL_SECS as i64);
    assert_eq!(bell_now(&w), 570);
    // Resolution lags: one flag province resolved only to 560 (a tie could hide).
    for (i, (holder, since)) in [(2u8, 380u32), (2, 410), (2, 420), (3, 0), (255, 0), (5, 0)]
        .iter()
        .enumerate()
    {
        set_keep(
            &mut w,
            FLAGS[i],
            *holder,
            *since,
            if i == 5 { 560 } else { 570 },
        );
    }
    fails(achieve(&mut w, 1, &FLAGS), E::ProvinceNotFinal);
    set_keep(&mut w, FLAGS[5], 5, 0, 570);
    achieve(&mut w, 1, &FLAGS).unwrap();
    let gd = data(&w, &g1);
    assert_eq!(gd[goal::STATE], goal::STATE_ACHIEVED);
    assert_eq!(gd[goal::WINNERS], 1 << 2);
    assert_eq!(u32_at(&gd, goal::ACHIEVED_BELL), 564);
    let payout = 30_000_000; // 30 % of 100
    assert_eq!(u64_at(&gd, goal::PAYOUT), payout);
    assert_eq!(treasury(&w, 0), 70_000_000);
    fails(achieve(&mut w, 1, &FLAGS), E::WrongState);

    // h buys a pass only now: not valid at the achievement bell's time.
    buy_pass(&mut w, &h.wallet, &h.token).unwrap();

    // The ledger (the operator's, publicly recomputable): Q17 (b) leaves e's
    // points out; this tree also carries members the chain must refuse
    // (d too recent, f no pass, h late pass, g zero points).
    let rows: Vec<(&Who, u64)> = vec![(&a, 30), (&b, 10), (&g, 0), (&d, 5), (&f, 5), (&h, 5)];
    let total: u64 = rows.iter().map(|r| r.1).sum();
    let leaves: Vec<[u8; 32]> = rows
        .iter()
        .map(|(who, pts)| leaf(&g1.to_bytes(), &who.wallet.to_bytes(), 2, *pts))
        .collect();
    let (root, proofs) = tree(&leaves);
    let mut totals = [0u64; 6];
    totals[2] = total;
    let mut wrong = totals;
    wrong[1] = 5;
    fails(
        op_ix(
            &mut w,
            tag::SET_GOAL_SHARES,
            g1,
            &shares_data(goal::MODE_SHARES, wrong, root),
        ),
        E::BadShares,
    );
    fails(
        op_ix(
            &mut w,
            tag::SET_GOAL_SHARES,
            g1,
            &shares_data(goal::MODE_RETURN, totals, root),
        ),
        E::BadShares,
    );
    op_ix(
        &mut w,
        tag::SET_GOAL_SHARES,
        g1,
        &shares_data(goal::MODE_SHARES, totals, root),
    )
    .unwrap();
    fails(
        op_ix(
            &mut w,
            tag::SET_GOAL_SHARES,
            g1,
            &shares_data(goal::MODE_SHARES, totals, root),
        ),
        E::WrongState,
    );

    // b with forged points: refused by the proof.
    fails(claim(&mut w, g1, &b, 2, 11, &proofs[1]), E::BadProof);
    // a claims 30/55 of 30.
    let before = bal(&w, &a.token);
    claim(&mut w, g1, &a, 2, 30, &proofs[0]).unwrap();
    let pay_a = share_amount(payout, 1, 30, total).unwrap();
    assert_eq!(bal(&w, &a.token) - before, pay_a);
    // Double claim: refused.
    fails(claim(&mut w, g1, &a, 2, 30, &proofs[0]), E::AlreadyClaimed);
    claim(&mut w, g1, &b, 2, 10, &proofs[1]).unwrap();
    let pay_b = share_amount(payout, 1, 10, total).unwrap();
    // Wrong members: c of nation 1 (with a's leaf, with its own nation),
    // d too recent, f no pass, h's pass bought after, g under the minimum,
    // e the operator's AI resident.
    fails(claim(&mut w, g1, &c, 2, 30, &proofs[0]), E::NotWinner);
    fails(claim(&mut w, g1, &c, 1, 30, &proofs[0]), E::NotWinner);
    fails(claim(&mut w, g1, &d, 2, 5, &proofs[3]), E::MemberTooRecent);
    fails(claim(&mut w, g1, &f, 2, 5, &proofs[4]), E::PassNotValid);
    fails(claim(&mut w, g1, &h, 2, 5, &proofs[5]), E::PassNotValid);
    fails(claim(&mut w, g1, &g, 2, 0, &proofs[2]), E::BelowMinimum);
    fails(claim(&mut w, g1, &e, 2, 5, &proofs[4]), E::OperatorMember);
    // Someone else's wallet signing for a: the receipt and pass are a's, the
    // Citizen check refuses c's Citizen under a's name.
    let mut fake = Who {
        wallet: c.wallet,
        token: c.token,
        citizen: a.citizen,
    };
    fails(claim(&mut w, g1, &fake, 2, 30, &proofs[0]), E::BadAccount);
    fake.citizen = c.citizen;
    let _ = fake;

    // The claim window (14 days) ends: no more claims; the rest returns.
    fails(sweep(&mut w, g1), E::ClaimWindowOpen);
    advance(&mut w, 14 * DAY);
    fails(claim(&mut w, g1, &b, 2, 10, &proofs[1]), E::AlreadyClaimed);
    fails(claim(&mut w, g1, &g, 2, 0, &proofs[2]), E::ClaimClosed);
    sweep(&mut w, g1).unwrap();
    let rest = payout - pay_a - pay_b;
    // (h's late pass added 20 to hegemony after the achievement)
    assert_eq!(treasury(&w, 0), 90_000_000 + rest);
    assert_eq!(data(&w, &g1)[goal::STATE], goal::STATE_CLOSED);
    fails(sweep(&mut w, g1), E::WrongState);

    // The operator's part (6 passes × 5).
    let op_key = w.operator;
    let ops_to = token_account(&mut w, 230, &op_key);
    let i = ix(
        &w,
        vec![
            AccountMeta::new_readonly(w.operator, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(ops_to, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        vec![tag::GOAL_WITHDRAW_OPS],
    );
    let op = w.operator;
    w.h.send(std::slice::from_ref(&i), &[op]).unwrap();
    assert_eq!(bal(&w, &ops_to), 30_000_000);
    fails(w.h.send(&[i], &[op]), E::NothingToPay);

    // Every token: the vault holds the treasuries exactly.
    let gd = data(&w, &w.gpool);
    let treasuries: u64 = (0..4).map(|k| treasury(&w, k)).sum();
    assert_eq!(bal(&w, &w.vault), treasuries);
    assert_eq!(u64_at(&gd, gpool::PAID), pay_a + pay_b);
    assert_eq!(u64_at(&gd, gpool::RETURNED), rest);
    assert_eq!(
        u64_at(&gd, gpool::COLLECTED),
        treasuries + u64_at(&gd, gpool::PAID) + u64_at(&gd, gpool::OPS)
    );

    // Round 2 is postable right after; round 1 cannot be posted again.
    fails(post(&mut w, 0, 1, 3, 144, 3_000, &FLAGS), E::WrongState);
    post(&mut w, 0, 2, 3, 144, 3_000, &FLAGS).unwrap();
}

/// Science, wonder, exploration (P8): attested by the operator with a dispute
/// window; voiding and RETURN put the payout back; fees then split by kind.
#[test]
fn attested_goals_wait_out_the_dispute_window() {
    let mut w = world();
    init(&mut w, MINT, &params()).unwrap();
    let a = member(&mut w, 11, 4, 0);
    // Attested kinds carry no flags.
    fails(post(&mut w, 1, 1, 0, 0, 500, &FLAGS), E::BadParams);
    post(&mut w, 1, 1, 0, 0, 500, &[]).unwrap();
    // Science is posted: its 20 % is its own from now on.
    buy_pass(&mut w, &a.wallet, &a.token).unwrap();
    assert_eq!(treasury(&w, 0), 16_000_000);
    assert_eq!(treasury(&w, 1), 4_000_000);
    let s1 = goal_of(&w, 1, 1);
    // Achieve is for hegemony only.
    let i = ix(
        &w,
        vec![
            AccountMeta::new(s1, false),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new_readonly(w.season, false),
        ],
        vec![tag::ACHIEVE],
    );
    fails(w.h.send(&[i], &[]), E::WrongState);
    let attest = |winners: u8, bell: u32| {
        let mut d = vec![winners];
        d.extend_from_slice(&bell.to_le_bytes());
        d.extend_from_slice(&[0xee; 32]);
        d
    };
    // Not in the future, not before the posting, a real nation.
    fails(
        op_ix(&mut w, tag::ATTEST_ACHIEVE, s1, &attest(1 << 4, 401)),
        E::BadParams,
    );
    fails(
        op_ix(&mut w, tag::ATTEST_ACHIEVE, s1, &attest(1 << 4, 399)),
        E::BadParams,
    );
    fails(
        op_ix(&mut w, tag::ATTEST_ACHIEVE, s1, &attest(1 << 6, 400)),
        E::BadParams,
    );
    op_ix(&mut w, tag::ATTEST_ACHIEVE, s1, &attest(1 << 4, 400)).unwrap();
    assert_eq!(treasury(&w, 1), 4_000_000 - 200_000); // 5 % of science
    let mut totals = [0u64; 6];
    totals[4] = 1;
    let root = leaf(&s1.to_bytes(), &a.wallet.to_bytes(), 4, 1);
    fails(
        op_ix(
            &mut w,
            tag::SET_GOAL_SHARES,
            s1,
            &shares_data(goal::MODE_SHARES, totals, root),
        ),
        E::DisputeOpen,
    );
    // Withdrawn during the window: the payout returns.
    op_ix(&mut w, tag::VOID_GOAL, s1, &[]).unwrap();
    assert_eq!(treasury(&w, 1), 4_000_000);
    fails(op_ix(&mut w, tag::VOID_GOAL, s1, &[]), E::WrongState);
    // Round 2: attested, window over, no eligible member → RETURN.
    post(&mut w, 1, 2, 0, 0, 500, &[]).unwrap();
    let s2 = goal_of(&w, 1, 2);
    op_ix(&mut w, tag::ATTEST_ACHIEVE, s2, &attest(1 << 4, 400)).unwrap();
    advance(&mut w, 3 * DAY);
    fails(op_ix(&mut w, tag::VOID_GOAL, s2, &[]), E::WrongState);
    op_ix(
        &mut w,
        tag::SET_GOAL_SHARES,
        s2,
        &shares_data(goal::MODE_RETURN, [0; 6], [0; 32]),
    )
    .unwrap();
    assert_eq!(treasury(&w, 1), 4_000_000);
    assert_eq!(data(&w, &s2)[goal::STATE], goal::STATE_CLOSED);
    // Round 3: a tie between nations 4 and 1; nation 1 has no eligible
    // member. §7.3: split by the number of winning nations first — a takes
    // half, the other half returns with the sweep.
    post(&mut w, 1, 3, 0, 0, 500, &[]).unwrap();
    let s3 = goal_of(&w, 1, 3);
    let now_bell = bell_now(&w);
    op_ix(
        &mut w,
        tag::ATTEST_ACHIEVE,
        s3,
        &attest((1 << 4) | (1 << 1), now_bell),
    )
    .unwrap();
    let payout3 = u64_at(&data(&w, &s3), goal::PAYOUT);
    assert_eq!(payout3, 200_000);
    advance(&mut w, 3 * DAY);
    let root3 = leaf(&s3.to_bytes(), &a.wallet.to_bytes(), 4, 1);
    op_ix(
        &mut w,
        tag::SET_GOAL_SHARES,
        s3,
        &shares_data(goal::MODE_SHARES, totals, root3),
    )
    .unwrap();
    assert_eq!(data(&w, &s3)[goal::SHARE_NATIONS], 2);
    let before = bal(&w, &a.token);
    claim(&mut w, s3, &a, 4, 1, &[]).unwrap();
    assert_eq!(bal(&w, &a.token) - before, payout3 / 2);
    advance(&mut w, 14 * DAY);
    sweep(&mut w, s3).unwrap();
    assert_eq!(treasury(&w, 1), 4_000_000 - payout3 / 2);
    // Only the operator posts, attests and sets shares.
    let mut d = vec![tag::POST_GOAL];
    d.extend_from_slice(&goals::post_data(2, 1, 0, 0, 5_000, &[1; 32], &[]));
    let stranger = key(99);
    w.h.fund(stranger, SOL);
    let i = ix(
        &w,
        vec![
            AccountMeta::new(stranger, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(goal_of(&w, 2, 1), false),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        d,
    );
    fails(w.h.send(&[i], &[stranger]), E::NotOperator);
}

/// Q5: an unachieved goal can be retired only after 30 days; then an easier
/// next round is posted. A lapsed pass renews from the purchase.
#[test]
fn retire_after_thirty_days_and_pass_lapses() {
    let mut w = world();
    init(&mut w, MINT, &params()).unwrap();
    post(&mut w, 0, 1, 3, 144, 3_000, &FLAGS).unwrap();
    let g1 = goal_of(&w, 0, 1);
    fails(op_ix(&mut w, tag::RETIRE_GOAL, g1, &[]), E::WrongState);
    advance(&mut w, 30 * DAY);
    op_ix(&mut w, tag::RETIRE_GOAL, g1, &[]).unwrap();
    fails(achieve(&mut w, 1, &FLAGS), E::WrongState);
    post(&mut w, 0, 2, 2, 144, 3_000, &FLAGS).unwrap();

    let a = member(&mut w, 11, 0, 0);
    buy_pass(&mut w, &a.wallet, &a.token).unwrap();
    let pa = pass_of(&w, &a.wallet);
    let t0 = w.h.clock.unix_timestamp;
    let pd = data(&w, &pa);
    let span = |d: &[u8], o: usize| i64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    assert_eq!(
        (
            span(&pd, goals::pass::VALID_FROM),
            span(&pd, goals::pass::VALID_UNTIL)
        ),
        (t0, t0 + 30 * DAY)
    );
    // Renewed while valid: longer.
    buy_pass(&mut w, &a.wallet, &a.token).unwrap();
    assert_eq!(
        span(&data(&w, &pa), goals::pass::VALID_UNTIL),
        t0 + 60 * DAY
    );
    // Lapsed, then bought: a new span; the old one kept.
    advance(&mut w, 61 * DAY);
    buy_pass(&mut w, &a.wallet, &a.token).unwrap();
    let pd = data(&w, &pa);
    assert_eq!(span(&pd, goals::pass::VALID_FROM), t0 + 61 * DAY);
    assert_eq!(span(&pd, goals::pass::PREV_UNTIL), t0 + 60 * DAY);
    assert_eq!(u32_at(&pd, goals::pass::COUNT), 3);
}

/// The legal gate and the world it needs: a finite world is refused
/// (`FiniteSeason`), and so is Circle's mainnet USDC mint (`RealMoneyMint`).
#[test]
fn only_test_assets_in_a_continuous_world() {
    let mut w = world();
    set_season(&mut w, 0);
    fails(init(&mut w, MINT, &params()), E::FiniteSeason);
    set_season(&mut w, 1);
    let real = goals::MAINNET_USDC;
    let mut m = vec![0u8; 82];
    m[44] = 6;
    m[45] = 1;
    w.h.set(
        real,
        Acct {
            lamports: rent_exempt(82),
            data: m,
            owner: TOKEN,
            executable: false,
        },
    );
    fails(init(&mut w, real, &params()), E::RealMoneyMint);
    let mut bad = params();
    bad.kind_bps = [5_000, 2_000, 2_000, 2_000];
    fails(init(&mut w, MINT, &bad), E::BadParams);
    init(&mut w, MINT, &params()).unwrap();
}

/// A claim with every account given by hand (the adversarial cases below
/// swap one at a time).
#[allow(clippy::too_many_arguments)]
fn claim_raw(
    w: &mut World,
    goal: Pubkey,
    wallet: Pubkey,
    pass: Pubkey,
    excl: Pubkey,
    citizen: Pubkey,
    to: Pubkey,
    mint: Pubkey,
    nation: u8,
    points: u64,
    proof: &[[u8; 32]],
) -> Result<(), String> {
    let mut d = vec![tag::GOAL_CLAIM];
    d.extend_from_slice(&goals::claim_data(nation, points, proof));
    let receipt = goals::receipt_address(&w.h.prize, &goal, &wallet).0;
    let i = ix(
        w,
        vec![
            AccountMeta::new(wallet, true),
            AccountMeta::new(goal, false),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new_readonly(pass, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new_readonly(citizen, false),
            AccountMeta::new_readonly(excl, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        d,
    );
    w.h.send(&[i], &[wallet])
}

/// verify-pr202 (independent verification): adversarial cases the author's
/// suite does not cover — account type confusion (the goal pool and a goal
/// are both 448 B), substituted flag provinces, a stranger in the operator's
/// seat, griefers pre-funding the receipt and pass PDAs, swapped pass and
/// exclusion accounts, a fake mint, and a dishonest ledger whose totals are
/// smaller than its leaves (the program must still never pay more than the
/// goal's payout, so no other goal's or kind's money can leave the vault).
#[test]
fn adversarial_accounts_and_ledgers_are_refused() {
    let mut w = world();
    init(&mut w, MINT, &params()).unwrap();
    let a = member(&mut w, 11, 2, 0);
    let b = member(&mut w, 12, 2, 0);
    let z = member(&mut w, 19, 2, 0);
    let e = member(&mut w, 15, 2, 0);
    // A griefer pre-funds a's pass PDA: BuyPass still creates it.
    let pa = pass_of(&w, &a.wallet);
    w.h.fund(pa, 5_000);
    for who in [&a, &b, &z] {
        buy_pass(&mut w, &who.wallet, &who.token).unwrap();
    }
    assert_eq!(&data(&w, &pa)[..8], &goals::pass::MAGIC);
    // The operator AI resident with a swapped (empty) exclusion account.
    exclude(&mut w, &e.wallet).unwrap();
    let i = ix(
        &w,
        vec![
            AccountMeta::new_readonly(e.wallet, true),
            AccountMeta::new(e.wallet, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(pass_of(&w, &e.wallet), false),
            AccountMeta::new(e.token, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(exclusion(&w, &a.wallet), false),
        ],
        vec![tag::BUY_PASS],
    );
    fails(w.h.send(&[i], &[e.wallet]), E::BadAccount);

    post(&mut w, 0, 1, 3, 144, 3_000, &FLAGS).unwrap();
    let g1 = goal_of(&w, 0, 1);
    for (i, (holder, since)) in [(2u8, 380u32), (2, 410), (2, 420), (3, 0), (255, 0), (5, 0)]
        .iter()
        .enumerate()
    {
        set_keep(&mut w, FLAGS[i], *holder, *since, 570);
    }
    advance(&mut w, 170 * BELL_SECS as i64);

    // Type confusion: the goal pool in the goal's seat (both 448 B).
    let mut acc = vec![
        AccountMeta::new(w.gpool, false),
        AccountMeta::new(w.gpool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    acc.extend(
        FLAGS
            .iter()
            .map(|f| AccountMeta::new_readonly(province(&w, *f), false)),
    );
    let i = ix(&w, acc, vec![tag::ACHIEVE]);
    fails(w.h.send(&[i], &[]), E::BadAccount);
    // Flags out of their posted order.
    let mut swapped = FLAGS;
    swapped.swap(0, 1);
    fails(achieve(&mut w, 1, &swapped), E::BadAccount);
    // A province at the right address but owned by another program, then of
    // another season: refused.
    let p0 = province(&w, FLAGS[0]);
    let real = w.h.get(&p0).unwrap().clone();
    let mut forged = real.clone();
    forged.owner = key(99);
    w.h.set(p0, forged);
    fails(achieve(&mut w, 1, &FLAGS), E::BadAccount);
    let mut other = real.clone();
    other.data[P::SEASON_ID..P::SEASON_ID + 8].copy_from_slice(&(SEASON_ID + 1).to_le_bytes());
    w.h.set(p0, other);
    fails(achieve(&mut w, 1, &FLAGS), E::BadAccount);
    w.h.set(p0, real);
    achieve(&mut w, 1, &FLAGS).unwrap();
    let payout = u64_at(&data(&w, &g1), goal::PAYOUT);
    assert_eq!(payout, 18_000_000); // 30 % of 3 × 20

    // A stranger in the operator's seat.
    let stranger = key(98);
    w.h.fund(stranger, SOL);
    let i = ix(
        &w,
        vec![
            AccountMeta::new_readonly(stranger, true),
            AccountMeta::new(g1, false),
            AccountMeta::new(w.gpool, false),
        ],
        {
            let mut d = vec![tag::SET_GOAL_SHARES];
            d.extend_from_slice(&shares_data(goal::MODE_RETURN, [0; 6], [0; 32]));
            d
        },
    );
    fails(w.h.send(&[i], &[stranger]), E::NotOperator);
    let st = token_account(&mut w, 240, &stranger);
    let i = ix(
        &w,
        vec![
            AccountMeta::new_readonly(stranger, true),
            AccountMeta::new(w.gpool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(st, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        vec![tag::GOAL_WITHDRAW_OPS],
    );
    fails(w.h.send(&[i], &[stranger]), E::NotOperator);

    // A dishonest (or buggy) ledger: nation 2's total says 10, yet a and b
    // each hold a 10-point leaf and z an 11-point one.
    let rows = [(&a, 10u64), (&b, 10), (&z, 11)];
    let leaves: Vec<[u8; 32]> = rows
        .iter()
        .map(|(who, pts)| leaf(&g1.to_bytes(), &who.wallet.to_bytes(), 2, *pts))
        .collect();
    let (root, proofs) = tree(&leaves);
    let mut totals = [0u64; 6];
    totals[2] = 10;
    op_ix(
        &mut w,
        tag::SET_GOAL_SHARES,
        g1,
        &shares_data(goal::MODE_SHARES, totals, root),
    )
    .unwrap();
    // Swapped pass (b's valid pass under a's claim) and swapped exclusion.
    let pb = pass_of(&w, &b.wallet);
    let mint = w.mint;
    let ex_a = exclusion(&w, &a.wallet);
    let ex_b = exclusion(&w, &b.wallet);
    fails(
        claim_raw(
            &mut w, g1, a.wallet, pb, ex_a, a.citizen, a.token, mint, 2, 10, &proofs[0],
        ),
        E::BadAccount,
    );
    fails(
        claim_raw(
            &mut w, g1, a.wallet, pa, ex_b, a.citizen, a.token, mint, 2, 10, &proofs[0],
        ),
        E::BadAccount,
    );
    // A fake mint.
    let fake_mint = key(97);
    make_mint(&mut w.h, &w.operator.clone(), &fake_mint);
    fails(
        claim_raw(
            &mut w, g1, a.wallet, pa, ex_a, a.citizen, a.token, fake_mint, 2, 10, &proofs[0],
        ),
        E::BadAccount,
    );
    // z's leaf claims more points than the nation's total.
    fails(claim(&mut w, g1, &z, 2, 11, &proofs[2]), E::BadShares);
    // A griefer pre-funds a's receipt PDA: a's claim still lands, once.
    let ra = goals::receipt_address(&w.h.prize, &g1, &a.wallet).0;
    w.h.fund(ra, 1);
    let vault_before = bal(&w, &w.vault);
    let before = bal(&w, &a.token);
    claim(&mut w, g1, &a, 2, 10, &proofs[0]).unwrap();
    assert_eq!(bal(&w, &a.token) - before, payout); // 10/10 of the only nation
    fails(claim(&mut w, g1, &a, 2, 10, &proofs[0]), E::AlreadyClaimed);
    // b's equally valid-looking leaf: the goal's payout is spent; the cap
    // refuses it, so nothing beyond the payout leaves the vault.
    fails(claim(&mut w, g1, &b, 2, 10, &proofs[1]), E::Overflow);
    assert_eq!(vault_before - bal(&w, &w.vault), payout);
    let treasuries: u64 = (0..4).map(|k| treasury(&w, k)).sum();
    let gd = data(&w, &w.gpool);
    assert_eq!(
        bal(&w, &w.vault),
        treasuries + u64_at(&gd, gpool::OPS) - u64_at(&gd, gpool::OPS_WITHDRAWN)
    );
}
