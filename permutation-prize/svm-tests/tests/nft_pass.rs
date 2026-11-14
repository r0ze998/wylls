//! TEST ONLY (⑰, 2026-11-15): the NFT pass prize path at runtime in LiteSVM.
//!
//! Real here: the prize program as an SBF build WITH `nft-experimental` (a TEST ONLY artefact, never the
//! production one: `PRIZE_NFT_SO`, no default; scripts/check-prize-nft-test-only.sh), the real Metaplex Core
//! binary (`PSF_CORE_SO`, mainnet ELF `CoREENxT…`) and ⑳'s real resident program (`WYLLS_RESIDENT_SO`):
//! a Core collection, InitConfig, SetMetadata, SetTerms, MintResident (a guarded Core asset and its resident
//! record), TransferResident (owner moves, generation + 1, session cleared) and SetSession. SPL Token is
//! LiteSVM's own.
//!
//! Stand-ins (the game program is not deployed here, as in pool.rs): the Season, Provinces, Funds and the
//! wallet Citizen; the game's resident policy, the NFT Citizen (marked with the asset) and the
//! nft-citizen-link, written as the game would leave them; CloseCitizen as removing the Citizen account.
//! The NFT Entry is the SYNTHETIC fixture of the host tests: the program refuses every pass deposit
//! (`ResidentDepositsDisabled`), so an Entry can only stand for one from before deposits were refused.
//!
//! Not a chain: one LiteSVM process, local test keys only (in memory; never written or printed), no
//! validator, no RPC, no relay, no page. Passing here is not proof of a real-chain transfer.
//!
//! Every test is `#[ignore]`: `cargo test --offline --locked --test nft_pass -- --ignored` with the three
//! binaries set. Helpers marked "pool.rs" are copied from tests/pool.rs (this branch, 0ebfe040 base).

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::resident_auth::Policy;
use frontier_abi::resident_binding;
use frontier_abi::resident_citizen as rc;
use frontier_abi::resident_policy;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use litesvm::LiteSVM;
use permutation_prize::{
    entry_resident as N, leaf, leaf_resident, node, pool, share_amount, tag, PrizeError as E,
};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::new_from_array([0; 32]);
const CORE: Address = Address::from_str_const("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const LOADER_V3: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
const SEASON_ID: u64 = 7;
const END_BELL: u32 = 432;
const FEE: u64 = 25_000_000;
const SOL: u64 = 1_000_000_000;
/// TEST VALUE: the resident sale price (⑳'s test sale uses 0.1 SOL).
const PRICE: u64 = 100_000_000;

// The resident program's instructions (⑳'s program/src/lib.rs header, built 947da0b9…).
const R_INIT_CONFIG: u8 = 0x01;
const R_SET_TERMS: u8 = 0x03;
const R_SET_METADATA: u8 = 0x05;
const R_MINT: u8 = 0x50;
const R_TRANSFER: u8 = 0x51;
const R_SET_SESSION: u8 = 0x52;
/// The resident record's generation (u32 at 48; frontier_abi resident_auth `resident_account`).
const R_GEN: usize = 48;

struct World {
    svm: LiteSVM,
    prize: Address,
    game: Address,
    season: Address,
    ctx: AddrCtx,
    operator: Keypair,
    mint: Address,
    pool: Address,
    vault: Address,
    resident_program: Address,
    coll_auth: Address,
    config: Address,
    collection: Address,
    treasury: Address,
    policy: Address,
}

/// A pass: the real Core asset, its real resident record, and who holds it now (as the tests track it).
#[derive(Clone)]
struct Pass {
    asset: Address,
    resident: Address,
}

/// A binary named by `env`. No default: a missing variable never falls back to a production artefact.
fn bin(env: &str) -> Vec<u8> {
    let p = std::env::var(env).unwrap_or_else(|_| panic!("TEST ONLY: set {env} (see the header)"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{env}={p}: {e}"))
}

// ------------------------------------------------------------ pool.rs helpers (copied)

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new(ixs, Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
}

fn fails(r: Result<(), String>, e: E) {
    let want = format!("Custom({})", e as u32);
    match r {
        Ok(()) => panic!("expected {e:?}, landed"),
        Err(m) => assert!(m.contains(&want), "expected {e:?} ({want}): {m}"),
    }
}

fn system_create(
    payer: &Address,
    new: &Address,
    lamports: u64,
    space: u64,
    owner: &Address,
) -> Instruction {
    let mut d = 0u32.to_le_bytes().to_vec();
    d.extend_from_slice(&lamports.to_le_bytes());
    d.extend_from_slice(&space.to_le_bytes());
    d.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*new, true)],
        data: d,
    }
}

fn token_account(svm: &mut LiteSVM, payer: &Keypair, mint: &Address, owner: &Address) -> Address {
    let k = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(165);
    let mut d = vec![18u8]; // InitializeAccount3
    d.extend_from_slice(owner.as_ref());
    let init = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(k.pubkey(), false),
            AccountMeta::new_readonly(*mint, false),
        ],
        data: d,
    };
    send(
        svm,
        &[
            system_create(&payer.pubkey(), &k.pubkey(), rent, 165, &TOKEN),
            init,
        ],
        &[payer, &k],
    )
    .unwrap();
    k.pubkey()
}

fn mint_to(svm: &mut LiteSVM, authority: &Keypair, mint: &Address, to: &Address, amount: u64) {
    let mut d = vec![7u8]; // MintTo
    d.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data: d,
    };
    send(svm, &[ix], &[authority]).unwrap();
}

fn balance(svm: &LiteSVM, token_account: &Address) -> u64 {
    let a = svm.get_account(token_account).expect("token account");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

fn set_raw(w: &mut World, addr: Address, owner: Address, data: Vec<u8>) {
    let lamports = w.svm.minimum_balance_for_rent_exemption(data.len());
    w.svm
        .set_account(
            addr,
            Account {
                lamports,
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

fn game_account(w: &mut World, addr: [u8; 32], data: Vec<u8>) {
    let game = w.game;
    set_raw(w, Address::new_from_array(addr), game, data);
}

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}

fn set_season(w: &mut World, status: u8) {
    let mut d = vec![0u8; S::SIZE];
    put(&mut d, 0, &S::MAGIC);
    put(&mut d, S::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[S::STATUS] = status;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.pubkey().as_ref());
    put(&mut d, S::BELL_SECS, &600u32.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &(END_BELL - 108).to_le_bytes());
    put(&mut d, S::END_BELL, &END_BELL.to_le_bytes());
    let k = w.season.to_bytes();
    game_account(w, k, d);
}

fn set_frontier(w: &mut World, opened: u32) {
    let mut d = vec![0u8; F::SIZE];
    put(&mut d, 0, &F::MAGIC);
    put(&mut d, F::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, F::PROVINCES_OPENED, &opened.to_le_bytes());
    let k = w.ctx.frontier();
    game_account(w, k, d);
}

fn set_funds(w: &mut World, opened: u32) {
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

fn funds(w: &World) -> Vec<Address> {
    (0..6u8)
        .map(|f| Address::new_from_array(w.ctx.province_fund(f)))
        .collect()
}

fn province_data(p: i16, q: i16, holder: u8, resolved_next: u32) -> Vec<u8> {
    let mut d = vec![0u8; P::SIZE];
    put(&mut d, 0, &P::MAGIC);
    put(&mut d, P::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, P::P, &p.to_le_bytes());
    put(&mut d, P::Q, &q.to_le_bytes());
    put(&mut d, P::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    d[P::KEEP + K::TILE] = 30;
    d[P::KEEP + K::HOLDER] = holder;
    d
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
    assert_eq!(v.len(), 54);
    v
}

fn set_provinces(w: &mut World, holders: &[u8]) -> Vec<Address> {
    keeps()
        .iter()
        .zip(holders)
        .map(|((p, q), h)| {
            let a = w.ctx.province(*p as i32, *q as i32);
            game_account(w, a, province_data(*p, *q, *h, END_BELL));
            Address::new_from_array(a)
        })
        .collect()
}

fn set_citizen(w: &mut World, wallet: &Address, faction: u8) -> Address {
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, C::WALLET, wallet.as_ref());
    d[C::FACTION] = faction;
    let a = w.ctx.citizen(&wallet.to_bytes());
    game_account(w, a, d);
    Address::new_from_array(a)
}

fn op(w: &World) -> Keypair {
    w.operator.insecure_clone()
}

fn prize_ix(w: &World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: w.prize,
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
    let ix = prize_ix(
        w,
        vec![
            AccountMeta::new(w.operator.pubkey(), true),
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
    let o = op(w);
    send(&mut w.svm, &[ix], &[&o]).unwrap();
}

fn entry_of(w: &World, wallet: &Address) -> Address {
    Address::find_program_address(&[b"entry", w.pool.as_ref(), wallet.as_ref()], &w.prize).0
}

fn nft_entry_of(w: &World, asset: &Address) -> Address {
    Address::find_program_address(&[b"entry-nft", w.pool.as_ref(), asset.as_ref()], &w.prize).0
}

/// A funded wallet with `tokens` of the test mint and its token account.
fn player(w: &mut World, tokens: u64) -> (Keypair, Address) {
    let k = Keypair::new();
    w.svm.airdrop(&k.pubkey(), SOL).unwrap();
    let o = op(w);
    let ta = token_account(&mut w.svm, &o, &w.mint, &k.pubkey());
    if tokens > 0 {
        mint_to(&mut w.svm, &o, &w.mint, &ta, tokens);
    }
    (k, ta)
}

fn pay(w: &mut World, k: &Keypair, ta: &Address) {
    let ix = prize_ix(
        w,
        vec![
            AccountMeta::new_readonly(k.pubkey(), true),
            AccountMeta::new(k.pubkey(), true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry_of(w, &k.pubkey()), false),
            AccountMeta::new(*ta, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        vec![tag::PAY],
    );
    send(&mut w.svm, &[ix], &[k]).unwrap();
}

fn tally(w: &mut World, provinces: &[Address]) {
    let mut accounts = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    accounts.extend(
        provinces
            .iter()
            .map(|a| AccountMeta::new_readonly(*a, false)),
    );
    let ix = prize_ix(w, accounts, vec![tag::TALLY]);
    let o = op(w);
    send(&mut w.svm, &[ix], &[&o]).unwrap();
}

fn finalize(w: &mut World) {
    let mut accounts = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    accounts.extend(
        funds(w)
            .iter()
            .map(|a| AccountMeta::new_readonly(*a, false)),
    );
    let ix = prize_ix(w, accounts, vec![tag::FINALIZE]);
    let o = op(w);
    send(&mut w.svm, &[ix], &[&o]).unwrap();
}

fn set_shares(w: &mut World, mode: u8, totals: [u64; 6], root: [u8; 32]) {
    let mut d = vec![tag::SET_SHARES, mode];
    for t in totals {
        d.extend_from_slice(&t.to_le_bytes());
    }
    d.extend_from_slice(&root);
    d.extend_from_slice(&[0xAB; 32]);
    let ix = prize_ix(
        w,
        vec![
            AccountMeta::new_readonly(w.operator.pubkey(), true),
            AccountMeta::new(w.pool, false),
        ],
        d,
    );
    let o = op(w);
    send(&mut w.svm, &[ix], &[&o]).unwrap();
}

fn pool_u64(w: &World, off: usize) -> u64 {
    let d = w.svm.get_account(&w.pool).unwrap().data;
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

// ------------------------------------------------------------ the real Core + resident program

/// Borsh string: u32 length, bytes.
fn borsh_str(d: &mut Vec<u8>, s: &str) {
    d.extend_from_slice(&(s.len() as u32).to_le_bytes());
    d.extend_from_slice(s.as_bytes());
}

/// Core CreateCollectionV1 (discriminator 1; mpl-core 0.12.1 generated/instructions/create_collection_v1.rs):
/// `[collection s,w] [update_authority] [payer s,w] [system]`, data `1 ‖ name ‖ uri ‖ plugins: None`.
fn create_collection_ix(
    collection: &Address,
    update_authority: &Address,
    payer: &Address,
) -> Instruction {
    let mut d = vec![1u8];
    borsh_str(&mut d, "Wylls Residents (TEST ONLY)");
    borsh_str(&mut d, "https://wylls.test/collection.json");
    d.push(0); // plugins: None
    Instruction {
        program_id: CORE,
        accounts: vec![
            AccountMeta::new(*collection, true),
            AccountMeta::new_readonly(*update_authority, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: d,
    }
}

fn resident_ix(w: &World, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: w.resident_program,
        accounts,
        data,
    }
}

fn world() -> World {
    let mut svm = LiteSVM::new();
    let prize = Keypair::new().pubkey();
    svm.add_program(prize, &bin("PRIZE_NFT_SO"))
        .expect("load the TEST ONLY nft-experimental prize build");
    svm.add_program(CORE, &bin("PSF_CORE_SO"))
        .expect("load Metaplex Core");
    let resident_program = Keypair::new().pubkey();
    svm.add_program(resident_program, &bin("WYLLS_RESIDENT_SO"))
        .expect("load the resident program");
    let game = Keypair::new().pubkey();
    let operator = Keypair::new();
    svm.airdrop(&operator.pubkey(), 100 * SOL).unwrap();
    // The resident program's InitConfig accepts only its upgrade authority (LoaderV3 ProgramData). LiteSVM
    // loads programs with none; write the local test operator into the ProgramData header
    // (bincode: u32 variant 3, u64 slot, Option<Pubkey> at 12). ProgramData is not executable, so the
    // loaded program is untouched.
    let programdata = Address::find_program_address(&[resident_program.as_ref()], &LOADER_V3).0;
    let mut pd = svm.get_account(&programdata).expect("programdata");
    assert_eq!(
        u32::from_le_bytes(pd.data[0..4].try_into().unwrap()),
        3,
        "ProgramData"
    );
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(operator.pubkey().as_ref());
    svm.set_account(programdata, pd).unwrap();

    let (season, _) =
        Address::find_program_address(&[S::PDA_PREFIX, &SEASON_ID.to_le_bytes()], &game);
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(82);
    let mut d = vec![20u8, 6]; // InitializeMint2
    d.extend_from_slice(operator.pubkey().as_ref());
    d.push(0);
    let init = Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(mint.pubkey(), false)],
        data: d,
    };
    send(
        &mut svm,
        &[
            system_create(&operator.pubkey(), &mint.pubkey(), rent, 82, &TOKEN),
            init,
        ],
        &[&operator, &mint],
    )
    .unwrap();
    let (pool, _) =
        Address::find_program_address(&[b"pool", game.as_ref(), &SEASON_ID.to_le_bytes()], &prize);
    let (vault, _) = Address::find_program_address(&[b"vault", pool.as_ref()], &prize);
    let coll_auth = Address::find_program_address(&[b"collection-authority"], &resident_program).0;
    let config = Address::find_program_address(&[b"config"], &resident_program).0;
    let policy = Address::find_program_address(&[b"nft-resident-policy"], &game).0;
    let mut w = World {
        svm,
        prize,
        game,
        season,
        ctx: AddrCtx {
            season: season.to_bytes(),
            program: game.to_bytes(),
        },
        operator,
        mint: mint.pubkey(),
        pool,
        vault,
        resident_program,
        coll_auth,
        config,
        collection: Address::default(),
        treasury: Keypair::new().pubkey(),
        policy,
    };
    set_season(&mut w, S::STATUS_RUNNING);
    set_frontier(&mut w, 61);
    set_funds(&mut w, 61);

    // [real] The collection: update authority = the resident program's collection-authority PDA.
    let coll = Keypair::new();
    let ix = create_collection_ix(&coll.pubkey(), &w.coll_auth, &w.operator.pubkey());
    let o = op(&w);
    send(&mut w.svm, &[ix], &[&o, &coll]).expect("Core CreateCollectionV1");
    w.collection = coll.pubkey();
    // [real] InitConfig (upgrade authority), SetMetadata, SetTerms (open, test supply, no per-wallet limit).
    let mut d = vec![R_INIT_CONFIG];
    d.extend_from_slice(&PRICE.to_le_bytes());
    d.extend_from_slice(w.treasury.as_ref());
    d.extend_from_slice(w.collection.as_ref());
    let ix = resident_ix(
        &w,
        vec![
            AccountMeta::new(w.operator.pubkey(), true),
            AccountMeta::new(w.config, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(w.resident_program, false),
            AccountMeta::new_readonly(programdata, false),
        ],
        d,
    );
    send(&mut w.svm, &[ix], &[&o]).expect("resident InitConfig");
    let mut d = vec![R_SET_METADATA];
    let (name, uri) = (
        "Wylls Resident (TEST ONLY)",
        "https://wylls.test/resident.json",
    );
    d.push(name.len() as u8);
    d.extend_from_slice(name.as_bytes());
    d.push(uri.len() as u8);
    d.extend_from_slice(uri.as_bytes());
    let cfg_accounts = vec![
        AccountMeta::new_readonly(w.operator.pubkey(), true),
        AccountMeta::new(w.config, false),
    ];
    let ix = resident_ix(&w, cfg_accounts.clone(), d);
    send(&mut w.svm, &[ix], &[&o]).expect("resident SetMetadata");
    let mut d = vec![R_SET_TERMS];
    d.extend_from_slice(&100u64.to_le_bytes()); // max_supply (test)
    d.extend_from_slice(&0i64.to_le_bytes()); // sale_start: 0 = no start limit
    d.extend_from_slice(&0i64.to_le_bytes()); // sale_end: 0 = no end (sale_check)
    d.extend_from_slice(&0u16.to_le_bytes()); // per_wallet: no limit
    d.push(1); // open
    let ix = resident_ix(&w, cfg_accounts, d);
    send(&mut w.svm, &[ix], &[&o]).expect("resident SetTerms");

    // [stand-in] The game's resident policy, naming the real Core, resident program, collection and guard.
    let mut pdat = vec![0u8; resident_policy::LEN];
    assert!(resident_policy::write_once(
        &mut pdat,
        &Policy {
            core_program: CORE.to_bytes(),
            resident_program: w.resident_program.to_bytes(),
            collection: w.collection.to_bytes(),
            guard_authority: w.coll_auth.to_bytes(),
        }
    ));
    let k = w.policy.to_bytes();
    game_account(&mut w, k, pdat);
    w
}

/// [real] MintResident: `owner` pays the test price and receives a guarded Core asset; the resident record
/// is created at generation 0.
fn mint_pass(w: &mut World, owner: &Keypair) -> Pass {
    let asset = Keypair::new();
    let resident =
        Address::find_program_address(&[b"resident", asset.pubkey().as_ref()], &w.resident_program)
            .0;
    let minter = Address::find_program_address(
        &[b"minted-by", owner.pubkey().as_ref()],
        &w.resident_program,
    )
    .0;
    let mut d = vec![R_MINT];
    d.extend_from_slice(&PRICE.to_le_bytes());
    let ix = resident_ix(
        w,
        vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(w.treasury, false),
            AccountMeta::new(asset.pubkey(), true),
            AccountMeta::new(w.collection, false),
            AccountMeta::new_readonly(w.coll_auth, false),
            AccountMeta::new(resident, false),
            // MintResident writes config.MINTED (resident lib.rs mint_resident): writable.
            AccountMeta::new(w.config, false),
            AccountMeta::new_readonly(CORE, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new(minter, false),
        ],
        d,
    );
    send(&mut w.svm, &[ix], &[owner, &asset]).expect("resident MintResident");
    let p = Pass {
        asset: asset.pubkey(),
        resident,
    };
    assert_eq!(
        asset_owner(w, &p),
        owner.pubkey(),
        "the real asset is the minter's"
    );
    assert_eq!(generation(w, &p), 0);
    p
}

/// [real] TransferResident: the current owner signs; the program moves the asset as permanent transfer
/// delegate, generation + 1, session cleared, in one instruction.
fn transfer(w: &mut World, p: &Pass, owner: &Keypair, to: &Address) {
    let g = generation(w, p);
    let ix = resident_ix(
        w,
        vec![
            AccountMeta::new_readonly(owner.pubkey(), true),
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(p.asset, false),
            AccountMeta::new(w.collection, false),
            AccountMeta::new_readonly(w.coll_auth, false),
            AccountMeta::new(p.resident, false),
            AccountMeta::new_readonly(*to, false),
            AccountMeta::new_readonly(CORE, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        vec![R_TRANSFER],
    );
    send(&mut w.svm, &[ix], &[owner]).expect("resident TransferResident");
    assert_eq!(asset_owner(w, p), *to, "the real asset moved");
    assert_eq!(generation(w, p), g + 1, "the generation went up by one");
}

/// [real] SetSession by the owner, recorded with the current generation and the setter.
fn set_session(w: &mut World, p: &Pass, owner: &Keypair, session: &Address) {
    let mut d = vec![R_SET_SESSION];
    d.extend_from_slice(session.as_ref());
    // The resident program refuses an expiry more than 30 days ahead (MAX_SESSION_SECS): one hour from now.
    d.extend_from_slice(&(now(w) + 3_600).to_le_bytes());
    let ix = resident_ix(
        w,
        vec![
            AccountMeta::new_readonly(owner.pubkey(), true),
            AccountMeta::new_readonly(p.asset, false),
            AccountMeta::new(p.resident, false),
        ],
        d,
    );
    send(&mut w.svm, &[ix], &[owner]).expect("resident SetSession");
}

/// The runtime clock's unix_timestamp (the Clock sysvar account: slot, epoch_start_timestamp, epoch,
/// leader_schedule_epoch, then unix_timestamp at byte 32).
fn now(w: &World) -> i64 {
    let clock = Address::from_str_const("SysvarC1ock11111111111111111111111111111111");
    let d = w.svm.get_account(&clock).expect("Clock sysvar").data;
    i64::from_le_bytes(d[32..40].try_into().unwrap())
}

fn asset_owner(w: &World, p: &Pass) -> Address {
    let d = w.svm.get_account(&p.asset).expect("asset").data;
    assert_eq!(d[0], 1, "Core AssetV1");
    Address::new_from_array(d[1..33].try_into().unwrap())
}

fn generation(w: &World, p: &Pass) -> u32 {
    let d = w
        .svm
        .get_account(&p.resident)
        .expect("resident record")
        .data;
    u32::from_le_bytes(d[R_GEN..R_GEN + 4].try_into().unwrap())
}

// ------------------------------------------------------------ the pass in the pool

fn nft_citizen(w: &World, p: &Pass) -> Address {
    Address::new_from_array(
        w.ctx
            .citizen_by_tag15(&rc::resident_tag15(&p.asset.to_bytes())),
    )
}

fn link_of(w: &World, p: &Pass) -> Address {
    Address::find_program_address(
        &[b"nft-citizen-link", w.season.as_ref(), p.asset.as_ref()],
        &w.game,
    )
    .0
}

/// [stand-in] What JoinResident leaves: the NFT Citizen of `faction` (marked with the asset) and the link.
fn join_pass(w: &mut World, p: &Pass, faction: u8) -> Address {
    let citizen = nft_citizen(w, p);
    let mut d = vec![0u8; C::SIZE];
    put(&mut d, 0, &C::MAGIC);
    put(&mut d, C::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[C::FACTION] = faction;
    d[C::FLAGS] = C::FLAG_JOINED;
    assert!(rc::mark(&mut d, &p.asset.to_bytes()));
    game_account(w, citizen.to_bytes(), d);
    let mut ld = vec![0u8; resident_binding::LEN];
    assert!(resident_binding::write_once(
        &mut ld,
        &resident_binding::Record {
            asset: p.asset.to_bytes(),
            resident: p.resident.to_bytes(),
            citizen: citizen.to_bytes(),
        }
    ));
    let link = link_of(w, p).to_bytes();
    game_account(w, link, ld);
    citizen
}

/// [fixture] The pass's NFT Entry as a deposit would have left it (NOT a PayResident: refused at dispatch),
/// the fee minted into the vault and the pool's counters moved as `credit_fee` moves them.
fn fixture_pass_entry(w: &mut World, p: &Pass, paid_by: &Address) -> Address {
    let (entry, bump) =
        Address::find_program_address(&[b"entry-nft", w.pool.as_ref(), p.asset.as_ref()], &w.prize);
    let mut d = vec![0u8; N::SIZE];
    put(&mut d, N::HDR_MAGIC, &N::MAGIC);
    d[N::BUMP] = bump;
    put(&mut d, N::PAY_GENERATION, &generation(w, p).to_le_bytes());
    put(&mut d, N::POOL, w.pool.as_ref());
    put(&mut d, N::ASSET, p.asset.as_ref());
    put(&mut d, N::AMOUNT, &FEE.to_le_bytes());
    put(&mut d, N::PAID_BY, paid_by.as_ref());
    let prize = w.prize;
    set_raw(w, entry, prize, d);
    let o = op(w);
    let vault = w.vault;
    mint_to(&mut w.svm, &o, &w.mint.clone(), &vault, FEE);
    let ops = FEE / 5;
    let mut a = w.svm.get_account(&w.pool).unwrap();
    let e = u32::from_le_bytes(a.data[pool::ENTRIES..pool::ENTRIES + 4].try_into().unwrap()) + 1;
    put(&mut a.data, pool::ENTRIES, &e.to_le_bytes());
    for (off, add) in [
        (pool::COLLECTED, FEE),
        (pool::PRIZE, FEE - ops),
        (pool::OPS, ops),
    ] {
        let v = u64::from_le_bytes(a.data[off..off + 8].try_into().unwrap()) + add;
        put(&mut a.data, off, &v.to_le_bytes());
    }
    w.svm.set_account(w.pool, a).unwrap();
    entry
}

/// A settled pool: pass P (minted for real to A) has its fixture Entry and joined nation 1; wallet b paid and
/// joined nation 1; nation 1 won; shares P 10 points, b 6 points (root `node(lp, lb)`), or refund mode.
struct Settled {
    a: Keypair,
    pass: Pass,
    citizen: Address,
    entry: Address,
    lb: [u8; 32],
}

fn settle(w: &mut World, mode: u8) -> Settled {
    init_pool(w);
    let a = Keypair::new();
    w.svm.airdrop(&a.pubkey(), 2 * SOL).unwrap();
    let pass = mint_pass(w, &a);
    let entry = fixture_pass_entry(w, &pass, &a.pubkey());
    let citizen = join_pass(w, &pass, 1);
    let (b, tbw) = player(w, FEE);
    pay(w, &b, &tbw);
    set_citizen(w, &b.pubkey(), 1);
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[0] = 1;
    let provinces = set_provinces(w, &holders);
    set_season(w, S::STATUS_ENDED);
    tally(w, &provinces[..18]);
    tally(w, &provinces[18..36]);
    tally(w, &provinces[36..]);
    finalize(w);
    let pk = w.pool.to_bytes();
    let lp = leaf_resident(&pk, &pass.asset.to_bytes(), 1, 10);
    let lb = leaf(&pk, &b.pubkey().to_bytes(), 1, 6);
    if mode == pool::MODE_REFUND {
        set_shares(w, pool::MODE_REFUND, [0; 6], [0; 32]);
    } else {
        set_shares(w, pool::MODE_SHARES, [0, 16, 0, 0, 0, 0], node(&lp, &lb));
    }
    Settled {
        a,
        pass,
        citizen,
        entry,
        lb,
    }
}

fn owed(w: &World) -> u64 {
    share_amount(pool_u64(w, pool::PRIZE), 1, 10, 16).unwrap()
}

/// ClaimResident (tag 9) of the settled pass, signed by `signer` (or unsigned), paid to `to`, at generation
/// `g`, with the pass's real asset and resident record.
#[allow(clippy::too_many_arguments)]
fn claim_ix(
    w: &World,
    s: &Settled,
    signer: &Address,
    signed: bool,
    to: &Address,
    g: u32,
) -> Instruction {
    let mut d = vec![tag::CLAIM_RESIDENT];
    d.extend_from_slice(&g.to_le_bytes());
    d.push(1);
    d.extend_from_slice(&10u64.to_le_bytes());
    d.push(1);
    d.extend_from_slice(&s.lb);
    prize_ix(
        w,
        vec![
            AccountMeta::new_readonly(*signer, signed),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(s.entry, false),
            AccountMeta::new_readonly(s.citizen, false),
            AccountMeta::new_readonly(link_of(w, &s.pass), false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(w.policy, false),
            AccountMeta::new_readonly(s.pass.asset, false),
            AccountMeta::new_readonly(s.pass.resident, false),
        ],
        d,
    )
}

/// Send a claim. The fee payer is the operator (as the relay sponsors it); `k` signs when given.
fn claim(w: &mut World, ix: Instruction, k: Option<&Keypair>) -> Result<(), String> {
    let o = op(w);
    match k {
        Some(k) => send(&mut w.svm, &[ix], &[&o, k]),
        None => send(&mut w.svm, &[ix], &[&o]),
    }
}

/// The state every refusal must leave as it was: the vault, the given token accounts, the whole Entry.
fn snapshot(w: &World, entry: &Address, accounts: &[Address]) -> (u64, Vec<u64>, Vec<u8>) {
    (
        balance(&w.svm, &w.vault),
        accounts.iter().map(|a| balance(&w.svm, a)).collect(),
        w.svm.get_account(entry).map(|a| a.data).unwrap_or_default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn refused(
    w: &mut World,
    ix: Instruction,
    k: Option<&Keypair>,
    e: E,
    snap: &(u64, Vec<u64>, Vec<u8>),
    accts: &[Address],
    entry: &Address,
    what: &str,
) {
    fails(claim(w, ix, k), e);
    assert_eq!(
        &snapshot(w, entry, accts),
        snap,
        "{what}: nothing moved and the Entry is unchanged"
    );
}

fn token_of(w: &mut World, owner: &Address) -> Address {
    let o = op(w);
    let mint = w.mint;
    token_account(&mut w.svm, &o, &mint, owner)
}

fn entry_claim(w: &World, entry: &Address) -> (u8, Address, u32) {
    let d = w.svm.get_account(entry).unwrap().data;
    (
        d[N::CLAIMED],
        Address::new_from_array(d[N::CLAIMED_BY..N::CLAIMED_BY + 32].try_into().unwrap()),
        u32::from_le_bytes(
            d[N::CLAIM_GENERATION..N::CLAIM_GENERATION + 4]
                .try_into()
                .unwrap(),
        ),
    )
}

// ------------------------------------------------------------ tests

/// The real mint, then the owner's claim at generation 0, once.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn real_mint_then_the_owner_claims_once() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_SHARES);
    let ta = token_of(&mut w, &s.a.pubkey());
    let v0 = balance(&w.svm, &w.vault);
    let a = s.a.insecure_clone();
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    claim(&mut w, ix, Some(&a)).unwrap();
    let paid = owed(&w);
    assert_eq!(balance(&w.svm, &ta), paid);
    assert_eq!(balance(&w.svm, &w.vault), v0 - paid);
    assert_eq!(entry_claim(&w, &s.entry), (1, a.pubkey(), 0));
    let snap = snapshot(&w, &s.entry, &[ta]);
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::AlreadyClaimed,
        &snap,
        &[ta],
        &s.entry,
        "a second claim",
    );
}

/// A real TransferResident A → B moves the unclaimed right: A is refused (stale, then not current), B is paid.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn a_real_transfer_moves_the_unclaimed_right() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_SHARES);
    let a = s.a.insecure_clone();
    let b = Keypair::new();
    w.svm.airdrop(&b.pubkey(), SOL).unwrap();
    transfer(&mut w, &s.pass, &a, &b.pubkey());
    let (ta, tb) = (token_of(&mut w, &a.pubkey()), token_of(&mut w, &b.pubkey()));
    let accts = [ta, tb];
    let snap = snapshot(&w, &s.entry, &accts);
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::ResidentStaleGeneration,
        &snap,
        &accts,
        &s.entry,
        "A at generation 0",
    );
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 1);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::ResidentNotCurrentAuthority,
        &snap,
        &accts,
        &s.entry,
        "A at generation 1",
    );
    let ix = claim_ix(&w, &s, &b.pubkey(), true, &tb, 1);
    claim(&mut w, ix, Some(&b)).unwrap();
    assert_eq!(
        balance(&w.svm, &tb),
        owed(&w),
        "the whole share, to the owner now"
    );
    assert_eq!(balance(&w.svm, &ta), 0);
    assert_eq!(entry_claim(&w, &s.entry), (1, b.pubkey(), 1));
}

/// A real A → B → A: generation 2. B and A's earlier generations are refused; A's real session is refused at
/// the destination binding (paid to A's account) and as a session (paid to its own); unsigned is refused;
/// A at 2 is paid once.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn a_real_buy_back_pays_the_returning_owner_once() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_SHARES);
    let a = s.a.insecure_clone();
    let b = Keypair::new();
    w.svm.airdrop(&b.pubkey(), SOL).unwrap();
    transfer(&mut w, &s.pass, &a, &b.pubkey());
    transfer(&mut w, &s.pass, &b, &a.pubkey());
    assert_eq!(generation(&w, &s.pass), 2);
    let session = Keypair::new();
    set_session(&mut w, &s.pass, &a, &session.pubkey());
    let (ta, tb, ts) = (
        token_of(&mut w, &a.pubkey()),
        token_of(&mut w, &b.pubkey()),
        token_of(&mut w, &session.pubkey()),
    );
    let accts = [ta, tb, ts];
    let snap = snapshot(&w, &s.entry, &accts);
    assert_eq!(snap.2[N::CLAIMED], 0);
    for (who, k, to, g, e) in [
        ("B at 1", &b, tb, 1, E::ResidentStaleGeneration),
        ("B at 2", &b, tb, 2, E::ResidentNotCurrentAuthority),
        ("A at 0", &a, ta, 0, E::ResidentStaleGeneration),
        ("A at 1", &a, ta, 1, E::ResidentStaleGeneration),
    ] {
        let ix = claim_ix(&w, &s, &k.pubkey(), true, &to, g);
        refused(&mut w, ix, Some(k), e, &snap, &accts, &s.entry, who);
    }
    let ix = claim_ix(&w, &s, &session.pubkey(), true, &ta, 2);
    refused(
        &mut w,
        ix,
        Some(&session),
        E::BadAccount,
        &snap,
        &accts,
        &s.entry,
        "session, paid to A's account",
    );
    let ix = claim_ix(&w, &s, &session.pubkey(), true, &ts, 2);
    refused(
        &mut w,
        ix,
        Some(&session),
        E::ResidentNotCurrentAuthority,
        &snap,
        &accts,
        &s.entry,
        "session, its own account",
    );
    let ix = claim_ix(&w, &s, &a.pubkey(), false, &ta, 2);
    refused(
        &mut w,
        ix,
        None,
        E::BadAccount,
        &snap,
        &accts,
        &s.entry,
        "unsigned owner",
    );
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 2);
    claim(&mut w, ix, Some(&a)).unwrap();
    assert_eq!(balance(&w.svm, &ta), owed(&w));
    assert_eq!(entry_claim(&w, &s.entry), (1, a.pubkey(), 2));
    let snap = snapshot(&w, &s.entry, &accts);
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 2);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::AlreadyClaimed,
        &snap,
        &accts,
        &s.entry,
        "A again",
    );
}

/// PayResident (tag 8) with a real asset is refused at dispatch; no Entry is created and nothing moves.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn pass_deposits_are_refused_at_dispatch_with_a_real_asset() {
    let mut w = world();
    init_pool(&mut w);
    let a = Keypair::new();
    w.svm.airdrop(&a.pubkey(), 2 * SOL).unwrap();
    let pass = mint_pass(&mut w, &a);
    let ta = token_of(&mut w, &a.pubkey());
    let o = op(&w);
    let mint = w.mint;
    mint_to(&mut w.svm, &o, &mint, &ta, FEE);
    let entry = nft_entry_of(&w, &pass.asset);
    let mut d = vec![tag::PAY_RESIDENT];
    d.extend_from_slice(&0u32.to_le_bytes());
    let ix = prize_ix(
        &w,
        vec![
            AccountMeta::new_readonly(a.pubkey(), true),
            AccountMeta::new(a.pubkey(), true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry, false),
            AccountMeta::new(ta, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(w.policy, false),
            AccountMeta::new_readonly(pass.asset, false),
            AccountMeta::new_readonly(pass.resident, false),
        ],
        d,
    );
    let before = (
        balance(&w.svm, &ta),
        balance(&w.svm, &w.vault),
        pool_u64(&w, pool::COLLECTED),
    );
    fails(send(&mut w.svm, &[ix], &[&a]), E::ResidentDepositsDisabled);
    assert!(
        w.svm.get_account(&entry).is_none_or(|x| x.data.is_empty()),
        "no Entry created"
    );
    assert_eq!(
        (
            balance(&w.svm, &ta),
            balance(&w.svm, &w.vault),
            pool_u64(&w, pool::COLLECTED)
        ),
        before
    );
}

/// RecordResidentNation (real) before the Citizen closes (stand-in: the account removed) keeps the claim.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn a_recorded_nation_survives_the_citizen_closing() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_SHARES);
    let ix = prize_ix(
        &w,
        vec![
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new(s.entry, false),
            AccountMeta::new_readonly(s.citizen, false),
        ],
        vec![tag::RECORD_RESIDENT_NATION],
    );
    let o = op(&w);
    send(&mut w.svm, &[ix], &[&o]).expect("RecordResidentNation");
    let d = w.svm.get_account(&s.entry).unwrap().data;
    assert_eq!((d[N::NATION_RECORDED], d[N::NATION]), (1, 1));
    w.svm.set_account(s.citizen, Account::default()).unwrap(); // [stand-in] CloseCitizen
    let a = s.a.insecure_clone();
    let ta = token_of(&mut w, &a.pubkey());
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    claim(&mut w, ix, Some(&a)).unwrap();
    assert_eq!(balance(&w.svm, &ta), owed(&w));
}

/// Without a record, a closed Citizen (stand-in) leaves the pass unable to claim; nothing moves.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn without_a_record_a_closed_citizen_cannot_claim() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_SHARES);
    w.svm.set_account(s.citizen, Account::default()).unwrap(); // [stand-in] CloseCitizen
    let a = s.a.insecure_clone();
    let ta = token_of(&mut w, &a.pubkey());
    let snap = snapshot(&w, &s.entry, &[ta]);
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::BadAccount,
        &snap,
        &[ta],
        &s.entry,
        "no record, Citizen closed",
    );
}

/// Refund mode: a pass claim is refused (whom a pass refund goes to is undecided); nothing moves.
#[test]
#[ignore = "TEST ONLY: needs PRIZE_NFT_SO, PSF_CORE_SO, WYLLS_RESIDENT_SO"]
fn refund_mode_refuses_the_pass_claim() {
    let mut w = world();
    let s = settle(&mut w, pool::MODE_REFUND);
    let a = s.a.insecure_clone();
    let ta = token_of(&mut w, &a.pubkey());
    let snap = snapshot(&w, &s.entry, &[ta]);
    let ix = claim_ix(&w, &s, &a.pubkey(), true, &ta, 0);
    refused(
        &mut w,
        ix,
        Some(&a),
        E::ResidentRefundUndecided,
        &snap,
        &[ta],
        &s.entry,
        "refund mode",
    );
}
