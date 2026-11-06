//! Chain flow, stage E (workstream 04): the prize, with the **prize program's
//! own code** and the **game program's own JoinResident** in one Season.
//! It records what the current prize program does for an NFT pass's Citizen;
//! it implements no NFT prize (the owner's CC builds it) and changes no rule.
//!
//!   [game]     permutation-frontier `dispatch` (`nft-experimental`): JoinResident 0xE1
//!   [program]  permutation-prize `process_instruction`: InitPool, Pay, Tally,
//!              Finalize, SetShares, Claim, RecordNation
//!   [mock]     System / SPL Token / sysvars (src/lib.rs); Metaplex Core and
//!              the resident program as bytes (⑳'s layout); a transfer as the
//!              resident program leaves it (owner changes, generation + 1)
//!   [stand-in] the season's end (Season Ended, Provinces, ProvinceFunds
//!              written with frontier-abi layouts at their real addresses)
//!
//! Keys: every key is a fixed 32-byte value, or a public address a program
//! computes (PDA, with_seed — allowed by the owner, 2026-11-06). No keypair is
//! generated or derived and nothing is signed: a "signer" is a key in the
//! host's signer set.
#![cfg(feature = "nft")]

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::resident_auth::Policy;
use frontier_abi::resident_citizen as rc;
use frontier_abi::resident_wire as wire;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use permutation_frontier::layout::frontier as FR;
use permutation_prize::{entry, leaf, pool, tag, PrizeError as E};
use wylls_e2e_native::solana_program::instruction::{AccountMeta, Instruction};
use wylls_e2e_native::solana_program::pubkey::Pubkey;
use wylls_e2e_native::{rent_exempt, token_balance, Acct, Host, SYSTEM, TOKEN};

const SEASON_ID: u64 = 7;
const END_BELL: u32 = 432;
const BELL_SECS: u32 = 600;
const GENESIS_TS: i64 = 1_800_000_000 - 600;
const JOIN_CLOSE_BELL: u32 = 12;
const FEE: u64 = 25_000_000;
const SOL: u64 = 1_000_000_000;

const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const CORE: [u8; 32] = [0x44; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const ASSET: [u8; 32] = [0x5a; 32];
/// The pass's first owner (its wallet pays the entry fee) and the buyer.
const A: [u8; 32] = [0xa1; 32];
const B: [u8; 32] = [0xb2; 32];
/// The nation the pass joins (JoinResident's faction byte).
const NATION: u8 = 2;

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}
fn pk(b: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(b)
}
fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}
fn custom(r: &Result<(), String>) -> Option<u32> {
    let m = r.as_ref().err()?;
    let i = m.find("Custom(")? + 7;
    m[i..].split(')').next()?.parse().ok()
}
fn fails(r: Result<(), String>, e: E) {
    assert_eq!(custom(&r), Some(e as u32), "expected {e:?}: {r:?}");
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
    config: Pubkey,
    link: Pubkey,
    resident: Pubkey,
    /// The pass's Citizen: `citizen_by_tag15(resident id)`.
    nft_citizen: Pubkey,
    generation: u32,
}

fn game_account(w: &mut World, addr: Pubkey, data: Vec<u8>) {
    w.h.set(
        addr,
        Acct {
            lamports: rent_exempt(data.len()),
            data,
            owner: w.game,
            executable: false,
        },
    );
}

fn guard() -> [u8; 32] {
    Pubkey::find_program_address(&[b"collection-authority"], &pk(RESIDENT_PROGRAM))
        .0
        .to_bytes()
}

fn asset_bytes(owner: &[u8; 32]) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    let base = a.len();
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    a.push(3);
    a.extend_from_slice(&(registry_at as u64).to_le_bytes());
    a.extend_from_slice(&[5, 1, 7]);
    a.push(4);
    a.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        a.extend_from_slice(&[kind, 3]);
        a.extend_from_slice(&guard());
        a.extend_from_slice(&(at as u64).to_le_bytes());
    }
    a.extend_from_slice(&0u32.to_le_bytes());
    a
}

fn resident_bytes(generation: u32) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    r
}

fn set_season(w: &mut World, status: u8) {
    let bump = Pubkey::find_program_address(
        &[
            permutation_frontier::addr::SEASON_PREFIX,
            &permutation_frontier::addr::season_seed_id(SEASON_ID),
        ],
        &w.game,
    )
    .1;
    let mut d = vec![0u8; K2::Season.size()];
    assert!(write_header(&mut d, K2::Season, SEASON_ID));
    d[S::STATUS] = status;
    d[S::BUMP] = bump;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.as_ref());
    put(&mut d, S::RULESET_HASH, &permutation_frontier::RULESET_HASH);
    put(&mut d, S::END_BELL, &END_BELL.to_le_bytes());
    put(&mut d, S::BELL_SECS, &BELL_SECS.to_le_bytes());
    put(&mut d, S::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &JOIN_CLOSE_BELL.to_le_bytes());
    put(&mut d, S::BUCKET_RATE_PER_H, &60u16.to_le_bytes());
    put(&mut d, S::BUCKET_BURST, &20u16.to_le_bytes());
    let k = w.season;
    game_account(w, k, d);
}

/// The Frontier (sites open for JoinResident, provinces opened for Finalize)
/// and the six ProvinceFunds.
fn set_frontier_and_funds(w: &mut World, opened: u32) {
    let mut d = vec![0u8; K2::Frontier.size()];
    assert!(write_header(&mut d, K2::Frontier, SEASON_ID));
    put(&mut d, FR::OPEN_SITES, &100u32.to_le_bytes());
    put(&mut d, FR::PROVINCES_OPENED, &opened.to_le_bytes());
    let k = pk(w.ctx.frontier());
    game_account(w, k, d);
    for wedge in 0..6u8 {
        let n = opened / 6 + if wedge == 0 { opened % 6 } else { 0 };
        let mut d = vec![0u8; PF::SIZE];
        put(&mut d, 0, &PF::MAGIC);
        put(&mut d, PF::SEASON_ID, &SEASON_ID.to_le_bytes());
        d[PF::WEDGE] = wedge;
        put(&mut d, PF::PROVINCES_OPENED, &n.to_le_bytes());
        let k = pk(w.ctx.province_fund(wedge));
        game_account(w, k, d);
    }
}

fn funds(w: &World) -> Vec<Pubkey> {
    (0..6u8).map(|f| pk(w.ctx.province_fund(f))).collect()
}

/// Nation `NATION` holds 10 keeps, the others 9, 9, 9, 9, 8.
fn set_provinces(w: &mut World) -> Vec<Pubkey> {
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[53] = NATION;
    let mut keeps = vec![];
    for p in -4i16..=4 {
        for q in -4i16..=4 {
            if (2..=4).contains(&ring_of(p as i32, q as i32)) {
                keeps.push((p, q));
            }
        }
    }
    keeps
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
            d[P::KEEP + K::HOLDER] = h;
            let a = pk(w.ctx.province(*p as i32, *q as i32));
            game_account(w, a, d);
            a
        })
        .collect()
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

/// A token account (fixed address `key(n)`) of `owner`, with `tokens` minted.
fn token_account(w: &mut World, n: u8, owner: &Pubkey, tokens: u64) -> Pubkey {
    let k = key(n);
    let op = w.operator;
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
    w.h.send(&[system_create(&op, &k, 165, &TOKEN), init], &[op, k])
        .unwrap();
    if tokens > 0 {
        let mut d = vec![7u8];
        d.extend_from_slice(&tokens.to_le_bytes());
        let ix = Instruction {
            program_id: TOKEN,
            accounts: vec![
                AccountMeta::new(w.mint, false),
                AccountMeta::new(k, false),
                AccountMeta::new_readonly(op, true),
            ],
            data: d,
        };
        w.h.send(&[ix], &[op]).unwrap();
    }
    k
}

fn world() -> World {
    let prize = key(201);
    // The same game program id as stage A (tests/chain_nft.rs), so the Season
    // and the pass's Citizen are the same addresses in every stage.
    let game = pk([0x11; 32]);
    let operator = key(203);
    let mut h = Host::with_game(prize, game);
    h.fund(operator, 100 * SOL);
    h.fund(pk(A), SOL);
    h.fund(pk(B), SOL);
    let season = pk(permutation_frontier::addr::season_pda(
        SEASON_ID,
        Pubkey::find_program_address(
            &[
                permutation_frontier::addr::SEASON_PREFIX,
                &permutation_frontier::addr::season_seed_id(SEASON_ID),
            ],
            &game,
        )
        .1,
        &game.to_bytes(),
    ));
    let ctx = AddrCtx {
        season: season.to_bytes(),
        program: game.to_bytes(),
    };
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
    let gb = game.to_bytes();
    let pda = |s: &[&[u8]], p: &Pubkey| Pubkey::find_program_address(s, p).0;
    let config = pda(&[b"nft-resident-policy"], &game);
    let link = pda(&[b"nft-citizen-link", season.as_ref(), &ASSET], &game);
    let resident = pda(&[b"resident", &ASSET], &pk(RESIDENT_PROGRAM));
    let nft_citizen = pk(ctx.citizen_by_tag15(&rc::resident_tag15(&ASSET)));
    let mut w = World {
        h,
        game,
        season,
        ctx,
        operator,
        mint,
        pool,
        vault,
        config,
        link,
        resident,
        nft_citizen,
        generation: 0,
    };
    set_season(&mut w, S::STATUS_RUNNING);
    set_frontier_and_funds(&mut w, 61);
    let policy = Policy {
        core_program: CORE,
        resident_program: RESIDENT_PROGRAM,
        collection: COLLECTION,
        guard_authority: guard(),
    };
    let mut pd = vec![0u8; frontier_abi::resident_policy::LEN];
    assert!(frontier_abi::resident_policy::write_once(&mut pd, &policy));
    game_account(&mut w, config, pd);
    let _ = gb;
    let own = |owner: [u8; 32], data: Vec<u8>| Acct {
        lamports: rent_exempt(data.len()),
        data,
        owner: pk(owner),
        executable: false,
    };
    w.h.set(pk(ASSET), own(CORE, asset_bytes(&A)));
    w.h.set(resident, own(RESIDENT_PROGRAM, resident_bytes(0)));
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

/// The game's JoinResident by the pass's current owner.
fn join_resident(w: &mut World, owner: [u8; 32]) -> Result<(), String> {
    let mut d = vec![wire::JOIN_RESIDENT];
    d.extend_from_slice(&w.generation.to_le_bytes());
    d.push(NATION);
    let payer = w.operator;
    let i = Instruction {
        program_id: w.game,
        accounts: vec![
            AccountMeta::new_readonly(pk(owner), true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(pk(w.ctx.frontier()), false),
            AccountMeta::new(w.nft_citizen, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new(w.link, false),
            AccountMeta::new_readonly(pk(ASSET), false),
            AccountMeta::new_readonly(w.resident, false),
        ],
        data: d,
    };
    w.h.send(&[i], &[pk(owner), payer])
}

/// TransferResident as the resident program leaves it.
fn transfer(w: &mut World, to: &[u8; 32]) {
    w.generation += 1;
    w.h.accounts.get_mut(&pk(ASSET)).unwrap().data[1..33].copy_from_slice(to);
    let g = w.generation;
    let r = w.resident;
    w.h.accounts.get_mut(&r).unwrap().data = resident_bytes(g);
}

fn operator_ix(w: &mut World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Result<(), String> {
    let i = pix(w, accounts, data);
    let op = w.operator;
    w.h.send(&[i], &[op])
}

/// The season ends with `NATION` the winner; shares: the paying wallet A,
/// 10 points in `NATION` (one leaf, so the root is the leaf).
fn settle(w: &mut World) -> [u8; 32] {
    let provinces = set_provinces(w);
    set_season(w, S::STATUS_ENDED);
    let mut a = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    a.extend(
        provinces
            .iter()
            .map(|p| AccountMeta::new_readonly(*p, false)),
    );
    operator_ix(w, a, vec![tag::TALLY]).unwrap();
    let mut a = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    a.extend(
        funds(w)
            .iter()
            .map(|f| AccountMeta::new_readonly(*f, false)),
    );
    operator_ix(w, a, vec![tag::FINALIZE]).unwrap();
    let la = leaf(&w.pool.to_bytes(), &A, NATION, 10);
    let mut d = vec![tag::SET_SHARES, pool::MODE_SHARES];
    let mut totals = [0u64; 6];
    totals[NATION as usize] = 10;
    for t in totals {
        d.extend_from_slice(&t.to_le_bytes());
    }
    d.extend_from_slice(&la);
    d.extend_from_slice(&[0xAB; 32]);
    let op = w.operator;
    operator_ix(
        w,
        vec![
            AccountMeta::new_readonly(op, true),
            AccountMeta::new(w.pool, false),
        ],
        d,
    )
    .unwrap();
    la
}

fn claim(w: &mut World, wallet: &Pubkey, ta: &Pubkey, citizen: &Pubkey) -> Result<(), String> {
    let mut d = vec![tag::CLAIM, NATION];
    d.extend_from_slice(&10u64.to_le_bytes());
    d.push(0);
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

fn record_nation(w: &mut World, wallet: &Pubkey, citizen: &Pubkey) -> Result<(), String> {
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new(entry_of(w, wallet), false),
            AccountMeta::new_readonly(*citizen, false),
        ],
        vec![tag::RECORD_NATION],
    );
    let op = w.operator;
    w.h.send(&[i], &[op])
}

fn bal(w: &World, k: &Pubkey) -> u64 {
    token_balance(&w.h, k).expect("a token account")
}

fn hand_off(lines: &[(&str, String)]) {
    let Ok(dir) = std::env::var("CHAIN_OUT") else {
        return;
    };
    let body: Vec<String> = lines
        .iter()
        .map(|(k, v)| format!("  \"{k}\": {v}"))
        .collect();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        std::path::Path::new(&dir).join("e-prize-run.json"),
        format!("{{\n{}\n}}\n", body.join(",\n")),
    )
    .unwrap();
}

/// The pass's owner paid the entry and joined with the pass; its nation won.
/// With the current prize program (wallet-keyed, Claim reads the Citizen at
/// `citizen(wallet)`), the share cannot be claimed through the pass's Citizen
/// before or after a transfer, and the buyer has no entry at all: the share
/// stays in the vault. This is the gap the NFT prize (the owner's CC) closes;
/// no rule is changed here.
#[test]
fn the_current_prize_program_cannot_pay_an_nft_pass_citizen() {
    let mut w = world();
    init_pool(&mut w);
    let ta = token_account(&mut w, 150, &pk(A), FEE);
    pay(&mut w, &pk(A), &ta).expect("A pays the entry fee from its wallet");
    join_resident(&mut w, A).expect("A joins with the pass (real JoinResident)");
    let c = w.h.get(&w.nft_citizen).expect("the pass's Citizen").clone();
    assert_eq!(rc::resident_asset(&c.data), Some(ASSET));
    assert_eq!(
        c.data[frontier_abi::v2::layout::player::citizen::FACTION],
        NATION
    );
    let wallet_citizen = pk(w.ctx.citizen(&A));
    assert_ne!(
        wallet_citizen, w.nft_citizen,
        "the pass's Citizen is not citizen(wallet)"
    );
    assert!(
        w.h.get(&wallet_citizen).is_none(),
        "no wallet Citizen exists"
    );

    settle(&mut w);
    let nc = w.nft_citizen;
    let in_vault = bal(&w, &w.vault.clone());
    assert!(in_vault > 0);
    let before = bal(&w, &ta);
    // 1. A claims through the pass's Citizen: refused (not citizen(wallet)).
    let r1 = claim(&mut w, &pk(A), &ta, &nc);
    fails(r1.clone(), E::BadAccount);
    // 2. A claims through citizen(wallet): it is empty and no nation was
    //    recorded, so refused too; RecordNation from the pass's Citizen is
    //    refused for the same address check.
    let r2 = claim(&mut w, &pk(A), &ta, &wallet_citizen);
    fails(r2.clone(), E::BadAccount);
    let r3 = record_nation(&mut w, &pk(A), &nc);
    fails(r3.clone(), E::BadAccount);
    // 3. After a transfer to B (the owner's policy: the unclaimed prize moves
    //    with the pass), B has no entry: refused; A's entry is still A's.
    transfer(&mut w, &B);
    let tb = token_account(&mut w, 151, &pk(B), 0);
    let r4 = claim(&mut w, &pk(B), &tb, &nc);
    fails(r4.clone(), E::BadAccount);
    let entry_a = w.h.get(&entry_of(&w, &pk(A))).unwrap().data.clone();
    assert_eq!(entry_a[entry::CLAIMED], 0);
    assert!(w.h.get(&entry_of(&w, &pk(B))).is_none());
    // Nothing moved.
    assert_eq!(bal(&w, &ta), before);
    assert_eq!(bal(&w, &tb), 0);
    assert_eq!(bal(&w, &w.vault.clone()), in_vault);
    let code =
        |r: &Result<(), String>| format!("\"{}\"", r.as_ref().err().cloned().unwrap_or_default());
    hand_off(&[
        ("stage", "\"E\"".into()),
        (
            "source",
            "\"workstreams/04-execution/e2e-native/tests/chain_prize.rs\"".into(),
        ),
        ("nft_citizen", format!("\"{}\"", w.nft_citizen)),
        ("wallet_citizen_of_A", format!("\"{wallet_citizen}\"")),
        ("vault_after", in_vault.to_string()),
        ("claim_A_with_pass_citizen", code(&r1)),
        ("claim_A_with_wallet_citizen", code(&r2)),
        ("record_nation_with_pass_citizen", code(&r3)),
        ("claim_B_after_transfer", code(&r4)),
        (
            "prize_error_bad_account",
            (E::BadAccount as u32).to_string(),
        ),
    ]);
}

/// For comparison, the same season with an ordinary wallet player (the
/// path the prize program has today): the claim pays. It shows the pool,
/// the tally and the shares above are set up correctly, so the refusals in
/// the test above come from the pass's Citizen, not from the setup.
#[test]
fn the_same_pool_pays_a_wallet_citizen() {
    let mut w = world();
    init_pool(&mut w);
    let ta = token_account(&mut w, 150, &pk(A), FEE);
    pay(&mut w, &pk(A), &ta).unwrap();
    // A wallet Citizen of A in NATION, at citizen(wallet) (stand-in for Join).
    use frontier_abi::v2::layout::player::citizen as C;
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::WALLET, &A);
    put(&mut d, C::RENT_PAYER, &A);
    d[C::FACTION] = NATION;
    let wc = pk(w.ctx.citizen(&A));
    game_account(&mut w, wc, d);
    settle(&mut w);
    let before = bal(&w, &ta);
    claim(&mut w, &pk(A), &ta, &wc).expect("the wallet path pays");
    assert!(bal(&w, &ta) > before);
}
