//! NFT pass prize rights (experimental, 2026-11-07, permutation-prize
//! `nft-experimental`): a pass's entry and its unclaimed share belong to the
//! pass and follow it to its CURRENT owner, judged by the prize program's own
//! code from the live asset and resident record — never from the caller.
//!
//!   [program]  permutation-prize's own process_instruction (host build,
//!              `nft-experimental`): PayResident 8, ClaimResident 9,
//!              RecordResidentNation 10, and the legacy Pay / Claim beside them;
//!   [game]     permutation-frontier's own `dispatch` for CloseCitizen (0x37)
//!              on an NFT Citizen (`Host::with_game`);
//!   [mock]     System / SPL Token / sysvars (src/lib.rs);
//!   [stand-in] the game's accounts, written with frontier-abi's layouts at
//!              their real addresses: the resident policy (`resident_policy`),
//!              the per-world link (`resident_binding`), the NFT Citizen
//!              (`resident_citizen::mark`), the Season, Provinces and
//!              ProvinceFunds at the end;
//!   [fixture]  the NFT Entry of a pass (`fixture_pass_entry`): PayResident is
//!              refused at dispatch (`ResidentDepositsDisabled`, deposits
//!              undecided), so no test obtains an Entry from the program; the
//!              claim tests write one as a deposit would have left it. The Core asset and the resident
//!              program's record are written as those programs leave them
//!              (the same bytes as permutation-frontier's
//!              resident_runtime_tests): a transfer rewrites the asset's owner
//!              and bumps the generation, as TransferResident does in one
//!              instruction. Neither Core, the resident program nor the
//!              game's JoinResident runs here.
//!
//! No keypair is generated, derived or used: every key is a fixed 32-byte
//! value or a program address; a "signer" is a key in the host's signer set
//! (no signature is verified, as in a LiteSVM run with sigverify off).
//!
//! **Execution class: address-deriving (NOT pure).** These tests derive
//! program addresses at run time (`Pubkey::find_program_address` for the
//! pool, vault, entries, policy, link, resident record and guard; the
//! Season PDA; `AddrCtx` with-seed addresses), and the programs under test
//! derive more. Under the rule that address derivation may not be executed
//! without approval, this file is **compile-only** (`cargo check --tests`,
//! `cargo test --no-run`) until a run is approved. The pure, executable
//! tests are permutation-prize's own unit tests (`cargo test --lib`).

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::resident_auth::Policy;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::{resident_binding, resident_citizen as rc, resident_policy};
use permutation_prize::{
    entry, entry_resident as N, leaf, leaf_resident, node, pool, share_amount, tag, PrizeError as E,
};
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

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

// The NFT side (the same literal keys as permutation-frontier's
// resident_runtime_tests).
const RESIDENT_PROGRAM: u8 = 0x33;
const CORE: u8 = 0x44;
const COLLECTION: u8 = 0x55;
const ASSET: u8 = 0x5a;
const ASSET2: u8 = 0x5b;
const A: u8 = 0xa1;
const B: u8 = 0xb2;
const SESSION: u8 = 0xc3;
const PAYER: u8 = 0xd4;
const STRANGER: u8 = 0x77;

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
    /// The game program's resident policy PDA.
    policy: Pubkey,
}

/// One pass: its Core asset, its resident record, the generation the
/// resident program's record carries now.
#[derive(Clone)]
struct Pass {
    asset: Pubkey,
    resident: Pubkey,
    generation: u32,
}

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}

fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
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

/// Nation 1 holds 10 keeps, nations 0, 2–5 hold 9, 9, 9, 9, 8.
fn close_race() -> Vec<u8> {
    let mut h: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    h[53] = 1;
    h
}

/// A wallet Citizen at its real address (as the legacy tests write it).
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

// ------------------------------------------------------------ the NFT side

fn guard() -> [u8; 32] {
    Pubkey::find_program_address(&[b"collection-authority"], &key(RESIDENT_PROGRAM))
        .0
        .to_bytes()
}

/// `PluginHeaderV1` + `PluginRegistryV1` for a frozen Permanent Freeze
/// Delegate and a Permanent Transfer Delegate of `guard` after an AssetV1
/// base ending at `base` (the layout `frontier_abi::resident_guard` reads).
fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(guard);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

/// A Core AssetV1 owned by `owner`, in the collection, with the guard
/// unless `unguarded`.
fn asset_bytes(owner: &Pubkey, unguarded: bool) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner.as_ref());
    a.push(2);
    a.extend_from_slice(key(COLLECTION).as_ref());
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0); // no sequence
    if !unguarded {
        let base = a.len();
        a.extend_from_slice(&guarded_tail(base, &guard()));
    }
    a
}

/// The resident program's record of `asset` (133 B): generation, session
/// `(key, generation it was set in, setter)`.
fn resident_bytes(
    asset: &Pubkey,
    generation: u32,
    session: Option<(Pubkey, u32, Pubkey)>,
) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(asset.as_ref());
    r[33..48].copy_from_slice(&rc::resident_tag15(asset.as_array()));
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    if let Some((k, g, setter)) = session {
        r[52..84].copy_from_slice(k.as_ref());
        r[84..92].copy_from_slice(&i64::MAX.to_le_bytes());
        r[92..96].copy_from_slice(&g.to_le_bytes());
        r[96..128].copy_from_slice(setter.as_ref());
    }
    r
}

fn policy_bytes() -> Vec<u8> {
    let policy = Policy {
        core_program: key(CORE).to_bytes(),
        resident_program: key(RESIDENT_PROGRAM).to_bytes(),
        collection: key(COLLECTION).to_bytes(),
        guard_authority: guard(),
    };
    let mut pd = vec![0u8; resident_policy::LEN];
    assert!(resident_policy::write_once(&mut pd, &policy));
    pd
}

/// [stand-in] The game program's policy at its PDA, owned by the game.
fn set_policy(w: &mut World) {
    let k = w.policy.to_bytes();
    game_account(w, k, policy_bytes());
}

fn set_acct(w: &mut World, k: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let lamports = rent_exempt(data.len());
    w.h.set(
        k,
        Acct {
            lamports,
            data,
            owner,
            executable: false,
        },
    );
}

/// [stand-in] A pass minted to `owner`: the Core asset (owned by Core, in
/// the collection, guarded) and the resident record at generation 0.
fn mint_pass(w: &mut World, asset: Pubkey, owner: &Pubkey) -> Pass {
    let resident =
        Pubkey::find_program_address(&[b"resident", asset.as_ref()], &key(RESIDENT_PROGRAM)).0;
    set_acct(w, asset, key(CORE), asset_bytes(owner, false));
    set_acct(
        w,
        resident,
        key(RESIDENT_PROGRAM),
        resident_bytes(&asset, 0, None),
    );
    Pass {
        asset,
        resident,
        generation: 0,
    }
}

/// [stand-in] TransferResident as the resident program leaves it: the
/// asset's owner is `to`, the generation goes up by one, the session is
/// cleared.
fn transfer(w: &mut World, pass: &mut Pass, to: &Pubkey) {
    pass.generation += 1;
    let mut a = w.h.get(&pass.asset).unwrap().clone();
    a.data[1..33].copy_from_slice(to.as_ref());
    w.h.set(pass.asset, a);
    set_resident(w, pass, None);
}

fn set_resident(w: &mut World, pass: &Pass, session: Option<(Pubkey, u32, Pubkey)>) {
    let mut r = w.h.get(&pass.resident).unwrap().clone();
    r.data = resident_bytes(&pass.asset, pass.generation, session);
    w.h.set(pass.resident, r);
}

fn resident_citizen(w: &World, asset: &Pubkey) -> Pubkey {
    Pubkey::new_from_array(
        w.ctx
            .citizen_by_tag15(&rc::resident_tag15(asset.as_array())),
    )
}

fn link_of(w: &World, asset: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"nft-citizen-link", w.season.as_ref(), asset.as_ref()],
        &w.game,
    )
    .0
}

/// [stand-in] What JoinResident leaves: the NFT Citizen of `faction` at
/// `citizen_by_tag15(resident id)` (zero wallet, marked with the asset,
/// rent paid by PAYER) and the per-world link. Returns `(citizen, link)`.
fn join_pass(w: &mut World, pass: &Pass, faction: u8) -> (Pubkey, Pubkey) {
    let citizen = resident_citizen(w, &pass.asset);
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::RENT_PAYER, key(PAYER).as_ref());
    d[C::FACTION] = faction;
    d[C::FLAGS] = C::FLAG_JOINED;
    assert!(rc::mark(&mut d, pass.asset.as_array()));
    game_account(w, citizen.to_bytes(), d);
    let link = link_of(w, &pass.asset);
    let mut ld = vec![0u8; resident_binding::LEN];
    assert!(resident_binding::write_once(
        &mut ld,
        &resident_binding::Record {
            asset: pass.asset.to_bytes(),
            resident: pass.resident.to_bytes(),
            citizen: citizen.to_bytes(),
        }
    ));
    game_account(w, link.to_bytes(), ld);
    (citizen, link)
}

// ------------------------------------------------------------ the host

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
    let payer = w.operator;
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
    w.h.send(&[system_create(&payer, &k, 165, &TOKEN), init], &[payer, k])
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
    h.fund(key(PAYER), 10 * SOL);
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
    let policy = Pubkey::find_program_address(&[b"nft-resident-policy"], &game).0;
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
        policy,
    };
    set_season(&mut w, S::STATUS_RUNNING);
    set_frontier_and_funds(&mut w, 61);
    set_policy(&mut w);
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

fn nft_entry_of(w: &World, asset: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"entry-nft", w.pool.as_ref(), asset.as_ref()], &w.h.prize).0
}

/// [program] Pay (legacy, tag 1) by a wallet.
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

/// [program] PayResident (tag 8): `owner` pays the pass's entry from `from`
/// at the signed `generation`; `signed` false leaves the owner unsigned.
fn pay_resident(
    w: &mut World,
    pass: &Pass,
    owner: &Pubkey,
    signed: bool,
    from: &Pubkey,
    generation: u32,
) -> Result<(), String> {
    let payer = key(PAYER);
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(*owner, signed),
            AccountMeta::new(payer, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(nft_entry_of(w, &pass.asset), false),
            AccountMeta::new(*from, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(w.policy, false),
            AccountMeta::new_readonly(pass.asset, false),
            AccountMeta::new_readonly(pass.resident, false),
        ],
        [vec![tag::PAY_RESIDENT], generation.to_le_bytes().to_vec()].concat(),
    );
    let mut signers = vec![payer];
    if signed {
        signers.push(*owner);
    }
    w.h.send(&[i], &signers)
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

/// [program] Claim (legacy, tag 5) by a wallet.
#[allow(clippy::too_many_arguments)]
fn claim(
    w: &mut World,
    wallet: &Pubkey,
    ta: &Pubkey,
    entry: &Pubkey,
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
            AccountMeta::new(*entry, false),
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

/// Every account and field of one ClaimResident, so a test can substitute
/// any one of them.
#[derive(Clone)]
struct ClaimR {
    owner: Pubkey,
    signed: bool,
    to: Pubkey,
    generation: u32,
    nation: u8,
    points: u64,
    proof: Vec<[u8; 32]>,
    entry: Pubkey,
    citizen: Pubkey,
    link: Pubkey,
    policy: Pubkey,
    asset: Pubkey,
    resident: Pubkey,
}

#[allow(clippy::too_many_arguments)]
fn claim_args(
    w: &World,
    pass: &Pass,
    owner: &Pubkey,
    to: &Pubkey,
    generation: u32,
    nation: u8,
    points: u64,
    proof: &[[u8; 32]],
) -> ClaimR {
    ClaimR {
        owner: *owner,
        signed: true,
        to: *to,
        generation,
        nation,
        points,
        proof: proof.to_vec(),
        entry: nft_entry_of(w, &pass.asset),
        citizen: resident_citizen(w, &pass.asset),
        link: link_of(w, &pass.asset),
        policy: w.policy,
        asset: pass.asset,
        resident: pass.resident,
    }
}

/// [program] ClaimResident (tag 9).
fn claim_resident(w: &mut World, c: &ClaimR) -> Result<(), String> {
    let mut d = vec![tag::CLAIM_RESIDENT];
    d.extend_from_slice(&c.generation.to_le_bytes());
    d.push(c.nation);
    d.extend_from_slice(&c.points.to_le_bytes());
    d.push(c.proof.len() as u8);
    for p in &c.proof {
        d.extend_from_slice(p);
    }
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(c.owner, c.signed),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(c.entry, false),
            AccountMeta::new_readonly(c.citizen, false),
            AccountMeta::new_readonly(c.link, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(c.to, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(c.policy, false),
            AccountMeta::new_readonly(c.asset, false),
            AccountMeta::new_readonly(c.resident, false),
        ],
        d,
    );
    let signers: Vec<Pubkey> = if c.signed { vec![c.owner] } else { vec![] };
    w.h.send(&[i], &signers)
}

/// [program] RecordResidentNation (tag 10): no signer.
fn record_resident_nation(w: &mut World, entry: &Pubkey, citizen: &Pubkey) -> Result<(), String> {
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new(*entry, false),
            AccountMeta::new_readonly(*citizen, false),
        ],
        vec![tag::RECORD_RESIDENT_NATION],
    );
    w.h.send(&[i], &[])
}

/// [program] RecordNation (legacy, tag 7): no signer.
fn record_nation(w: &mut World, entry: &Pubkey, citizen: &Pubkey) -> Result<(), String> {
    let i = pix(
        w,
        vec![
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new(*entry, false),
            AccountMeta::new_readonly(*citizen, false),
        ],
        vec![tag::RECORD_NATION],
    );
    w.h.send(&[i], &[])
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

fn bal(w: &World, k: &Pubkey) -> u64 {
    token_balance(&w.h, k).expect("a token account")
}

fn pool_u64(w: &World, off: usize) -> u64 {
    u64_at(&w.h.get(&w.pool).unwrap().data, off)
}

fn entry_bytes(w: &World, k: &Pubkey) -> Vec<u8> {
    w.h.get(k).map(|a| a.data.clone()).unwrap_or_default()
}

/// A wallet with `tokens` test USDC in a token account `key(n + 100)`.
fn player(w: &mut World, n: u8, tokens: u64) -> (Pubkey, Pubkey) {
    let wallet = key(n);
    w.h.fund(wallet, SOL);
    let ta = token_account(w, n + 100, &wallet);
    if tokens > 0 {
        faucet(w, &ta, tokens);
    }
    (wallet, ta)
}

fn end_and_finalize(w: &mut World) {
    let provinces = set_provinces(w, &close_race());
    set_season(w, S::STATUS_ENDED);
    tally(w, &provinces).unwrap();
    finalize(w).unwrap();
}

/// The settled pool of every scenario: pass P (minted to A, generation 0)
/// paid its entry and joined nation 1; wallet b paid and joined nation 1;
/// nation 1 won; shares P 10 points, b 6 points, root `node(lp, lb)`.
struct Settled {
    pass: Pass,
    citizen: Pubkey,
    link: Pubkey,
    /// A's and B's token accounts.
    ta: Pubkey,
    tb: Pubkey,
    b: Pubkey,
    tb_wallet: Pubkey,
    cb: Pubkey,
    lp: [u8; 32],
    lb: [u8; 32],
}

fn settled(w: &mut World) -> Settled {
    init_pool(w);
    w.h.fund(key(A), SOL);
    w.h.fund(key(B), SOL);
    let ta = token_account(w, 111, &key(A));
    let tb = token_account(w, 112, &key(B));
    let pass = mint_pass(w, key(ASSET), &key(A));
    // [fixture] the pass's Entry (deposits are refused at dispatch).
    fixture_pass_entry(w, &pass, &key(A));
    let (citizen, link) = join_pass(w, &pass, 1);
    let (b, tb_wallet) = player(w, 2, FEE);
    pay(w, &b, &tb_wallet).unwrap();
    let cb = set_citizen(w, &b, 1);
    end_and_finalize(w);
    let pk = w.pool.to_bytes();
    let lp = leaf_resident(&pk, pass.asset.as_array(), 1, 10);
    let lb = leaf(&pk, &b.to_bytes(), 1, 6);
    set_shares(w, pool::MODE_SHARES, [0, 16, 0, 0, 0, 0], node(&lp, &lb)).unwrap();
    Settled {
        pass,
        citizen,
        link,
        ta,
        tb,
        b,
        tb_wallet,
        cb,
        lp,
        lb,
    }
}

fn owed_pass(w: &World) -> u64 {
    share_amount(pool_u64(w, pool::PRIZE), 1, 10, 16).unwrap()
}

/// The settled pass's claim (10 points of nation 1, sibling `lb`) by `o`
/// (A or B, into its own token account) at the signed generation `g`.
fn claim_by(w: &World, p: &Pass, lb: [u8; 32], o: u8, g: u32) -> ClaimR {
    let to = key(if o == A { 111 } else { 112 });
    claim_args(w, p, &key(o), &to, g, 1, 10, &[lb])
}

/// [program] ClaimResident with the arguments `f` builds from the world
/// (the arguments are built before the world is borrowed for the run).
fn claim_with(w: &mut World, f: impl FnOnce(&World) -> ClaimR) -> Result<(), String> {
    let c = f(w);
    claim_resident(w, &c)
}

/// [program] The settled pass's claim by `o` at generation `g` (`claim_by`).
fn try_claim(w: &mut World, p: &Pass, lb: [u8; 32], o: u8, g: u32) -> Result<(), String> {
    claim_with(w, |w| claim_by(w, p, lb, o, g))
}

// ------------------------------------------------------------ tests

/// [fixture] An NFT Entry of `pass` paid by `paid_by`. NOT a PayResident:
/// the program refuses every pass deposit at dispatch
/// (`ResidentDepositsDisabled`, the test below). The Entry's bytes are
/// written as a deposit would have left them, the fee is minted into the
/// vault and the pool's counters are moved as `credit_fee` moves them, so
/// the Entry stands for one that exists on a chain from before deposits were
/// refused. Every claim test below rests on this fixture, not on a deposit
/// the program accepted.
fn fixture_pass_entry(w: &mut World, pass: &Pass, paid_by: &Pubkey) -> Pubkey {
    let (entry, bump) = Pubkey::find_program_address(
        &[b"entry-nft", w.pool.as_ref(), pass.asset.as_ref()],
        &w.h.prize,
    );
    let mut d = vec![0u8; N::SIZE];
    put(&mut d, N::HDR_MAGIC, &N::MAGIC);
    d[N::BUMP] = bump;
    put(&mut d, N::PAY_GENERATION, &pass.generation.to_le_bytes());
    put(&mut d, N::POOL, w.pool.as_ref());
    put(&mut d, N::ASSET, pass.asset.as_ref());
    put(&mut d, N::AMOUNT, &FEE.to_le_bytes());
    put(&mut d, N::PAID_BY, paid_by.as_ref());
    let prize = w.h.prize;
    set_acct(w, entry, prize, d);
    let vault = w.vault;
    faucet(w, &vault, FEE);
    // ops_bps 2,000: the operator's fifth, the prize the rest (lib.rs `credit_fee`).
    let ops = FEE / 5;
    let mut p = w.h.get(&w.pool).unwrap().clone();
    let entries = u32_at(&p.data, pool::ENTRIES) + 1;
    put(&mut p.data, pool::ENTRIES, &entries.to_le_bytes());
    let collected = u64_at(&p.data, pool::COLLECTED) + FEE;
    put(&mut p.data, pool::COLLECTED, &collected.to_le_bytes());
    let prize_total = u64_at(&p.data, pool::PRIZE) + FEE - ops;
    put(&mut p.data, pool::PRIZE, &prize_total.to_le_bytes());
    let ops_total = u64_at(&p.data, pool::OPS) + ops;
    put(&mut p.data, pool::OPS, &ops_total.to_le_bytes());
    w.h.set(w.pool, p);
    entry
}

/// PayResident is refused at dispatch (`ResidentDepositsDisabled`): a
/// pass's refund right is undecided, so no new pass deposit is taken — not
/// from the owner at its generation, not from anyone else, whatever the
/// data, before any account is read or any token moves. Nothing is created
/// and no counter moves. The wallet Pay beside it is as before.
#[test]
fn pass_deposits_are_refused_at_dispatch() {
    let mut w = world();
    init_pool(&mut w);
    w.h.fund(key(A), SOL);
    w.h.fund(key(B), SOL);
    let ta = token_account(&mut w, 111, &key(A));
    let tb = token_account(&mut w, 112, &key(B));
    faucet(&mut w, &ta, 2 * FEE);
    faucet(&mut w, &tb, FEE);
    let p = mint_pass(&mut w, key(ASSET), &key(A));
    let mut q = mint_pass(&mut w, key(ASSET2), &key(B));
    let pool_before = w.h.get(&w.pool).unwrap().data.clone();
    // The owner itself, at its generation, with everything in order: refused.
    fails(
        pay_resident(&mut w, &p, &key(A), true, &ta, 0),
        E::ResidentDepositsDisabled,
    );
    // Every other variant gets the same answer: nothing is read first.
    fails(
        pay_resident(&mut w, &q, &key(B), true, &tb, 1),
        E::ResidentDepositsDisabled,
    );
    fails(
        pay_resident(&mut w, &q, &key(A), true, &ta, 0),
        E::ResidentDepositsDisabled,
    );
    fails(
        pay_resident(&mut w, &q, &key(B), false, &tb, 0),
        E::ResidentDepositsDisabled,
    );
    set_acct(&mut w, q.asset, key(CORE), asset_bytes(&key(B), true));
    fails(
        pay_resident(&mut w, &q, &key(B), true, &tb, 0),
        E::ResidentDepositsDisabled,
    );
    set_acct(&mut w, q.asset, key(CORE), asset_bytes(&key(B), false));
    transfer(&mut w, &mut q, &key(A));
    transfer(&mut w, &mut q, &key(B));
    fails(
        pay_resident(&mut w, &q, &key(B), true, &tb, 2),
        E::ResidentDepositsDisabled,
    );
    // The tag alone, with no data and one account: answered before the data
    // or the accounts are looked at.
    let bare = pix(
        &w,
        vec![AccountMeta::new(w.pool, false)],
        vec![tag::PAY_RESIDENT],
    );
    fails(w.h.send(&[bare], &[]), E::ResidentDepositsDisabled);
    // Nothing happened: no Entry, no token moved, no counter moved.
    assert!(w.h.get(&nft_entry_of(&w, &p.asset)).is_none());
    assert!(w.h.get(&nft_entry_of(&w, &q.asset)).is_none());
    assert_eq!(bal(&w, &w.vault), 0);
    assert_eq!(bal(&w, &ta), 2 * FEE);
    assert_eq!(bal(&w, &tb), FEE);
    assert_eq!(w.h.get(&w.pool).unwrap().data, pool_before);
    // The wallet path beside it, unchanged.
    let (c, tc) = player(&mut w, 3, FEE);
    pay(&mut w, &c, &tc).unwrap();
    assert_eq!(u32_at(&w.h.get(&w.pool).unwrap().data, pool::ENTRIES), 1);
    assert_eq!(bal(&w, &w.vault), FEE);
    // After the tally starts the answer is the same (refused first, as always).
    let provinces = set_provinces(&mut w, &close_race());
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces[..1]).unwrap();
    fails(
        pay_resident(&mut w, &p, &key(A), true, &ta, 0),
        E::ResidentDepositsDisabled,
    );
}

/// The fixture Entry (§ above) is what the claim tests rest on: it reads as
/// a deposit would have left it, and the pool's figures agree with it.
#[test]
fn the_fixture_entry_reads_as_a_deposit_would_have_left_it() {
    let mut w = world();
    init_pool(&mut w);
    let p = mint_pass(&mut w, key(ASSET), &key(A));
    let entry = fixture_pass_entry(&mut w, &p, &key(A));
    assert_eq!(entry, nft_entry_of(&w, &p.asset));
    let e = entry_bytes(&w, &entry);
    assert_eq!(e.len(), N::SIZE);
    assert_eq!(&e[..8], &N::MAGIC);
    assert_eq!(&e[N::ASSET..N::ASSET + 32], p.asset.as_ref());
    assert_eq!(&e[N::POOL..N::POOL + 32], w.pool.as_ref());
    assert_eq!(u64_at(&e, N::AMOUNT), FEE);
    assert_eq!(&e[N::PAID_BY..N::PAID_BY + 32], key(A).as_ref());
    assert_eq!(e[N::CLAIMED], 0);
    assert_eq!(bal(&w, &w.vault), FEE);
    let pd = &w.h.get(&w.pool).unwrap().data;
    assert_eq!(u32_at(pd, pool::ENTRIES), 1);
    assert_eq!(u64_at(pd, pool::COLLECTED), FEE);
    assert_eq!(u64_at(pd, pool::PRIZE), FEE - FEE / 5);
    // The legacy RecordNation and Claim never read it (its size and magic are the pass's).
    assert!(w.h.get(&entry_of(&w, &key(A))).is_none());
}

/// The unclaimed share follows the pass: A paid at generation 0; after
/// A → B only B, at generation 1, is paid, into B's own account; A's
/// signatures from before and after the transfer are refused; a replay and a
/// claim after a buy-back (B → A) are AlreadyClaimed. The wallet member of
/// the same root claims as before, and the two never exceed the prize.
#[test]
fn the_unclaimed_share_follows_the_pass_to_its_current_owner() {
    let mut w = world();
    let s = settled(&mut w);
    let mut p = s.pass.clone();
    let owed = owed_pass(&w);
    assert!(owed > 0);
    let a0 = bal(&w, &s.ta);

    // A → B (generation 1): the right moved with the pass.
    transfer(&mut w, &mut p, &key(B));
    let lb = s.lb;
    fails(try_claim(&mut w, &p, lb, A, 0), E::ResidentStaleGeneration);
    fails(
        try_claim(&mut w, &p, lb, A, 1),
        E::ResidentNotCurrentAuthority,
    );
    fails(try_claim(&mut w, &p, lb, B, 0), E::ResidentStaleGeneration);
    assert_eq!(bal(&w, &s.tb), 0);
    try_claim(&mut w, &p, lb, B, 1).unwrap();
    assert_eq!(
        bal(&w, &s.tb),
        owed,
        "B, the current owner, is paid the share"
    );
    assert_eq!(
        bal(&w, &s.ta),
        a0,
        "A, who paid, gets nothing after selling"
    );
    let e = entry_bytes(&w, &nft_entry_of(&w, &p.asset));
    assert_eq!(e[N::CLAIMED], 1);
    assert_eq!(u64_at(&e, N::CLAIM_AMOUNT), owed);
    assert_eq!(&e[N::CLAIMED_BY..N::CLAIMED_BY + 32], key(B).as_ref());
    assert_eq!(u32_at(&e, N::CLAIM_GENERATION), 1);
    assert_eq!(&e[N::PAID_BY..N::PAID_BY + 32], key(A).as_ref());
    // A replay.
    fails(try_claim(&mut w, &p, lb, B, 1), E::AlreadyClaimed);
    // B → A (generation 2): the pass comes back claimed; A gets no second share.
    transfer(&mut w, &mut p, &key(A));
    fails(try_claim(&mut w, &p, lb, A, 2), E::AlreadyClaimed);
    fails(try_claim(&mut w, &p, lb, B, 2), E::AlreadyClaimed);
    assert_eq!(bal(&w, &s.tb), owed);
    assert_eq!(bal(&w, &s.ta), a0);
    // The wallet member's claim is as before; together they stay within the prize.
    let e_b = entry_of(&w, &s.b);
    claim(&mut w, &s.b, &s.tb_wallet, &e_b, &s.cb, 1, 6, &[s.lp]).unwrap();
    assert!(pool_u64(&w, pool::CLAIMED) <= pool_u64(&w, pool::PRIZE));
    assert_eq!(
        pool_u64(&w, pool::CLAIMED),
        owed + share_amount(pool_u64(&w, pool::PRIZE), 1, 6, 16).unwrap()
    );
    let _ = (s.citizen, s.link);
}

/// A transfer before the settlement moves the right too: A paid while the
/// season ran, sold to B before the end; after Finalize and SetShares only B
/// claims (the prize accrued before the transfer belongs to the pass).
#[test]
fn a_transfer_before_the_settlement_moves_the_right_too() {
    let mut w = world();
    init_pool(&mut w);
    w.h.fund(key(A), SOL);
    w.h.fund(key(B), SOL);
    let ta = token_account(&mut w, 111, &key(A));
    let tb = token_account(&mut w, 112, &key(B));
    let mut p = mint_pass(&mut w, key(ASSET), &key(A));
    // [fixture] the pass's Entry (deposits are refused at dispatch).
    fixture_pass_entry(&mut w, &p, &key(A));
    join_pass(&mut w, &p, 1);
    transfer(&mut w, &mut p, &key(B));
    end_and_finalize(&mut w);
    let pk = w.pool.to_bytes();
    let lp = leaf_resident(&pk, p.asset.as_array(), 1, 1);
    set_shares(&mut w, pool::MODE_SHARES, [0, 1, 0, 0, 0, 0], lp).unwrap();
    let prize = pool_u64(&w, pool::PRIZE);
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(A), &ta, 0, 1, 1, &[])),
        E::ResidentStaleGeneration,
    );
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(A), &ta, 1, 1, 1, &[])),
        E::ResidentNotCurrentAuthority,
    );
    claim_with(&mut w, |w| claim_args(w, &p, &key(B), &tb, 1, 1, 1, &[])).unwrap();
    assert_eq!(
        bal(&w, &tb),
        prize,
        "the whole prize, to the pass's owner now"
    );
    assert_eq!(bal(&w, &ta), 0);
}

/// A → B → A before any claim: the generation goes 0, 1, 2 and never back.
/// B's signatures (old and fresh), A's first-ownership signatures and A's
/// session key are refused; A claims once at generation 2.
#[test]
fn a_buy_back_before_the_claim_pays_the_returning_owner_once() {
    let mut w = world();
    let s = settled(&mut w);
    let mut p = s.pass.clone();
    let owed = owed_pass(&w);
    transfer(&mut w, &mut p, &key(B));
    transfer(&mut w, &mut p, &key(A));
    assert_eq!(p.generation, 2);
    let lb = s.lb;
    fails(try_claim(&mut w, &p, lb, B, 1), E::ResidentStaleGeneration);
    fails(
        try_claim(&mut w, &p, lb, B, 2),
        E::ResidentNotCurrentAuthority,
    );
    fails(try_claim(&mut w, &p, lb, A, 0), E::ResidentStaleGeneration);
    fails(try_claim(&mut w, &p, lb, A, 1), E::ResidentStaleGeneration);
    // A's session key, set by A in generation 2: a session never claims.
    set_resident(&mut w, &p, Some((key(SESSION), 2, key(A))));
    let mut via_session = claim_by(&w, &p, lb, A, 2);
    via_session.owner = key(SESSION);
    fails(
        claim_resident(&mut w, &via_session),
        E::ResidentNotCurrentAuthority,
    );
    // An unsigned owner.
    let mut unsigned = claim_by(&w, &p, lb, A, 2);
    unsigned.signed = false;
    fails(claim_resident(&mut w, &unsigned), E::BadAccount);
    assert_eq!(bal(&w, &s.tb), 0);
    try_claim(&mut w, &p, lb, A, 2).unwrap();
    assert_eq!(bal(&w, &s.ta), owed);
    fails(try_claim(&mut w, &p, lb, A, 2), E::AlreadyClaimed);
    assert_eq!(bal(&w, &s.ta), owed);
}

/// Every account a claim names is pinned: another pass, a policy elsewhere
/// or not the game's, another world's link or Citizen, a Citizen without
/// the pass's mark, an unguarded asset, another asset's resident record, a
/// wrong proof or nation. Nothing leaves the vault.
#[test]
fn the_wrong_pass_policy_link_world_or_citizen_is_refused() {
    let mut w = world();
    let s = settled(&mut w);
    let p = s.pass.clone();
    let good = claim_args(&w, &p, &key(A), &s.ta, 0, 1, 10, &[s.lb]);
    let v0 = bal(&w, &w.vault);
    let refused = |w: &mut World, c: ClaimR, e: E| {
        fails(claim_resident(w, &c), e);
        assert_eq!(bal(w, &w.vault), v0, "nothing left the vault");
    };

    // Another pass of A's (no entry of its own): the entry is not its.
    let q = mint_pass(&mut w, key(ASSET2), &key(A));
    refused(
        &mut w,
        ClaimR {
            asset: q.asset,
            resident: q.resident,
            ..good.clone()
        },
        E::BadAccount,
    );
    // Its entry address with the first pass's accounts: refused too.
    let q_entry = nft_entry_of(&w, &q.asset);
    refused(
        &mut w,
        ClaimR {
            entry: q_entry,
            ..good.clone()
        },
        E::BadAccount,
    );
    // The policy: a copy elsewhere (even owned by the game), or the right
    // address owned by another program.
    let game = w.game;
    set_acct(&mut w, key(STRANGER), game, policy_bytes());
    refused(
        &mut w,
        ClaimR {
            policy: key(STRANGER),
            ..good.clone()
        },
        E::ResidentPolicy,
    );
    let mut foreign = w.h.get(&w.policy).unwrap().clone();
    foreign.owner = key(99);
    w.h.set(w.policy, foreign);
    refused(&mut w, good.clone(), E::ResidentPolicy);
    set_policy(&mut w);
    // The link: another address (a game-owned record naming this very
    // Citizen), or the real one with one bit of its asset changed.
    let mut other_link = w.h.get(&s.link).unwrap().clone();
    w.h.set(key(0x62), other_link.clone());
    refused(
        &mut w,
        ClaimR {
            link: key(0x62),
            ..good.clone()
        },
        E::BadAccount,
    );
    other_link.data[8] ^= 1;
    let real = w.h.get(&s.link).unwrap().clone();
    w.h.set(s.link, other_link);
    refused(&mut w, good.clone(), E::BadAccount);
    w.h.set(s.link, real);
    // The Citizen: another world's (season 8 in its header) at the same
    // address, or a wallet-style Citizen (no mark) there.
    let live = w.h.get(&s.citizen).unwrap().clone();
    let mut other_world = live.clone();
    put(&mut other_world.data, C::SEASON_ID, &8u64.to_le_bytes());
    w.h.set(s.citizen, other_world);
    refused(&mut w, good.clone(), E::BadAccount);
    let mut unmarked = live.clone();
    unmarked.data[rc::RESIDENT_FLAGS] = 0;
    put(&mut unmarked.data, C::WALLET, key(A).as_ref());
    w.h.set(s.citizen, unmarked);
    refused(&mut w, good.clone(), E::BadAccount);
    // Marked with another asset.
    let mut other_asset = live.clone();
    assert!(rc::mark(&mut other_asset.data, q.asset.as_array()));
    w.h.set(s.citizen, other_asset);
    refused(&mut w, good.clone(), E::BadAccount);
    w.h.set(s.citizen, live);
    // The asset without its guard; the resident record of another asset.
    set_acct(&mut w, p.asset, key(CORE), asset_bytes(&key(A), true));
    refused(&mut w, good.clone(), E::ResidentUnguarded);
    set_acct(&mut w, p.asset, key(CORE), asset_bytes(&key(A), false));
    let mut rec = w.h.get(&p.resident).unwrap().clone();
    rec.data[1] ^= 1;
    let real_rec = w.h.get(&p.resident).unwrap().clone();
    w.h.set(p.resident, rec);
    refused(&mut w, good.clone(), E::ResidentAccount);
    w.h.set(p.resident, real_rec);
    // The resident record of the other pass, at its own address.
    refused(
        &mut w,
        ClaimR {
            resident: q.resident,
            ..good.clone()
        },
        E::ResidentAccount,
    );
    // The destination: another owner's token account of the mint (B's), or
    // an account that is no token account, is refused — the share goes to
    // the signer's own token account only.
    refused(
        &mut w,
        ClaimR {
            to: s.tb,
            ..good.clone()
        },
        E::BadAccount,
    );
    refused(
        &mut w,
        ClaimR {
            to: key(STRANGER),
            ..good.clone()
        },
        E::BadAccount,
    );
    // The proof, the points, the nation.
    refused(
        &mut w,
        ClaimR {
            proof: vec![s.lp],
            ..good.clone()
        },
        E::BadProof,
    );
    refused(
        &mut w,
        ClaimR {
            points: 11,
            ..good.clone()
        },
        E::BadProof,
    );
    refused(
        &mut w,
        ClaimR {
            nation: 2,
            ..good.clone()
        },
        E::NotWinner,
    );
    // After all of it, the real claim pays exactly once.
    claim_resident(&mut w, &good).unwrap();
    assert_eq!(bal(&w, &s.ta), owed_pass(&w));
}

/// The two entry kinds never stand for each other: a wallet Claim naming an
/// NFT Entry, a pass Claim naming a wallet Entry, RecordNation on an NFT
/// Entry and RecordResidentNation on a wallet Entry are all refused. A root
/// built from a wallet-domain leaf of the asset's bytes pays no pass.
#[test]
fn wallet_and_pass_entries_never_stand_for_each_other() {
    let mut w = world();
    let s = settled(&mut w);
    let p = s.pass.clone();
    let nft_entry = nft_entry_of(&w, &p.asset);
    let wallet_entry = entry_of(&w, &s.b);
    // Legacy Claim with the NFT Entry (the asset "signing" as a wallet, or b).
    fails(
        claim(
            &mut w,
            &p.asset,
            &s.ta,
            &nft_entry,
            &s.citizen,
            1,
            10,
            &[s.lb],
        ),
        E::BadAccount,
    );
    fails(
        claim(&mut w, &s.b, &s.tb_wallet, &nft_entry, &s.cb, 1, 6, &[s.lp]),
        E::BadAccount,
    );
    // ClaimResident with b's wallet Entry.
    let crossed = ClaimR {
        entry: wallet_entry,
        ..claim_args(&w, &p, &key(A), &s.ta, 0, 1, 10, &[s.lb])
    };
    fails(claim_resident(&mut w, &crossed), E::BadAccount);
    // The nation records, crossed.
    fails(record_nation(&mut w, &nft_entry, &s.citizen), E::BadAccount);
    fails(
        record_resident_nation(&mut w, &wallet_entry, &s.cb),
        E::BadAccount,
    );
    fails(
        record_resident_nation(&mut w, &nft_entry, &s.cb),
        E::BadAccount,
    );
    assert_eq!(entry_bytes(&w, &nft_entry)[N::NATION_RECORDED], 0);
    assert_eq!(entry_bytes(&w, &wallet_entry)[entry::NATION_RECORDED], 0);

    // A separate pool whose root holds the asset under the WALLET leaf domain
    // (an operator mistake): the pass's claim never verifies against it.
    let mut w2 = world();
    init_pool(&mut w2);
    w2.h.fund(key(A), SOL);
    let ta = token_account(&mut w2, 111, &key(A));
    let p2 = mint_pass(&mut w2, key(ASSET), &key(A));
    // [fixture] the pass's Entry (deposits are refused at dispatch).
    fixture_pass_entry(&mut w2, &p2, &key(A));
    join_pass(&mut w2, &p2, 1);
    end_and_finalize(&mut w2);
    let wrong = leaf(&w2.pool.to_bytes(), p2.asset.as_array(), 1, 1);
    set_shares(&mut w2, pool::MODE_SHARES, [0, 1, 0, 0, 0, 0], wrong).unwrap();
    fails(
        claim_with(&mut w2, |w| claim_args(w, &p2, &key(A), &ta, 0, 1, 1, &[])),
        E::BadProof,
    );
    assert_eq!(bal(&w2, &ta), 0);
}

/// RecordResidentNation (anyone, no signer) keeps the pass's claim after
/// the game's own CloseCitizen removed its NFT Citizen; the claim still goes
/// to the pass's current owner, for exactly the amount owed.
#[test]
fn a_recorded_nation_keeps_the_pass_claim_after_the_citizen_is_closed() {
    let mut w = world();
    let s = settled(&mut w);
    let mut p = s.pass.clone();
    let nft_entry = nft_entry_of(&w, &p.asset);
    let owed = owed_pass(&w);
    // Anyone: the record, and a no-op repeat.
    record_resident_nation(&mut w, &nft_entry, &s.citizen).unwrap();
    record_resident_nation(&mut w, &nft_entry, &s.citizen).unwrap();
    let e = entry_bytes(&w, &nft_entry);
    assert_eq!((e[N::NATION_RECORDED], e[N::NATION]), (1, 1));
    // Not from another Citizen (b's wallet Citizen, another pass's).
    fails(
        record_resident_nation(&mut w, &nft_entry, &s.cb),
        E::BadAccount,
    );
    let q = mint_pass(&mut w, key(ASSET2), &key(A));
    let (cq, _) = join_pass(&mut w, &q, 2);
    fails(
        record_resident_nation(&mut w, &nft_entry, &cq),
        E::BadAccount,
    );
    assert_eq!(
        entry_bytes(&w, &nft_entry)[N::NATION],
        1,
        "the record is unchanged"
    );

    // [game] At end + 72 h a third party closes the NFT Citizen (rent to
    // its payer); before that it is TooEarly (13).
    w.h.fund(key(STRANGER), SOL);
    w.h.clock.unix_timestamp = END_TS + GRACE - 1;
    let r = close_citizen(&mut w, &key(STRANGER), &s.citizen, &key(PAYER));
    assert_eq!(custom(&r), Some(13), "{r:?}");
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &key(STRANGER), &s.citizen, &key(PAYER)).unwrap();
    assert!(w.h.get(&s.citizen).is_none(), "the Citizen is closed");
    // The record cannot be made or changed now.
    fails(
        record_resident_nation(&mut w, &nft_entry, &s.citizen),
        E::BadAccount,
    );

    // The pass moved meanwhile: B, the owner now, is paid from the record.
    transfer(&mut w, &mut p, &key(B));
    let (lb, ta, tb) = (s.lb, s.ta, s.tb);
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(A), &ta, 1, 1, 10, &[lb])),
        E::ResidentNotCurrentAuthority,
    );
    // The proof and nation checks still hold with the record.
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(B), &tb, 1, 1, 7, &[lb])),
        E::BadProof,
    );
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(B), &tb, 1, 2, 10, &[lb])),
        E::NotWinner,
    );
    try_claim(&mut w, &p, lb, B, 1).unwrap();
    assert_eq!(bal(&w, &tb), owed);
    fails(try_claim(&mut w, &p, lb, B, 1), E::AlreadyClaimed);
}

/// Without a record the closed Citizen loses the pass's claim (the legacy
/// behaviour, unchanged): the record must be made before the close.
#[test]
fn without_a_record_a_closed_citizen_loses_the_pass_claim() {
    let mut w = world();
    let s = settled(&mut w);
    let p = s.pass.clone();
    w.h.fund(key(STRANGER), SOL);
    w.h.clock.unix_timestamp = END_TS + GRACE;
    close_citizen(&mut w, &key(STRANGER), &s.citizen, &key(PAYER)).unwrap();
    let v0 = bal(&w, &w.vault);
    fails(try_claim(&mut w, &p, s.lb, A, 0), E::BadAccount);
    assert_eq!(bal(&w, &w.vault), v0);
}

/// Refund mode is undecided for a pass (whom a refund follows): a pass claim
/// is refused, by the owner that paid and by a later owner, and its part
/// stays in the vault; the wallet refund beside it is exactly as before.
#[test]
fn refund_mode_refuses_a_pass_claim_and_keeps_wallet_refunds_unchanged() {
    let mut w = world();
    init_pool(&mut w);
    w.h.fund(key(A), SOL);
    w.h.fund(key(B), SOL);
    let ta = token_account(&mut w, 111, &key(A));
    let tb = token_account(&mut w, 112, &key(B));
    let mut p = mint_pass(&mut w, key(ASSET), &key(A));
    // [fixture] the pass's Entry (deposits are refused at dispatch).
    fixture_pass_entry(&mut w, &p, &key(A));
    let (citizen, _) = join_pass(&mut w, &p, 0);
    let (b, tbw) = player(&mut w, 2, FEE);
    pay(&mut w, &b, &tbw).unwrap();
    let cb = set_citizen(&mut w, &b, 0);
    end_and_finalize(&mut w);
    set_shares(&mut w, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    let prize = pool_u64(&w, pool::PRIZE);
    // The wallet refund: its part of the prize, as before.
    let e_b = entry_of(&w, &b);
    claim(&mut w, &b, &tbw, &e_b, &cb, 0, 0, &[]).unwrap();
    assert_eq!(bal(&w, &tbw), prize * FEE / (2 * FEE));
    // The pass: refused for the payer and for a later owner alike.
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(A), &ta, 0, 0, 0, &[])),
        E::ResidentRefundUndecided,
    );
    transfer(&mut w, &mut p, &key(B));
    fails(
        claim_with(&mut w, |w| claim_args(w, &p, &key(B), &tb, 1, 0, 0, &[])),
        E::ResidentRefundUndecided,
    );
    assert_eq!(bal(&w, &ta), 0);
    assert_eq!(bal(&w, &tb), 0);
    assert_eq!(bal(&w, &w.vault), 2 * FEE - prize * FEE / (2 * FEE));
    assert_eq!(entry_bytes(&w, &nft_entry_of(&w, &p.asset))[N::CLAIMED], 0);
    let _ = citizen;
}
