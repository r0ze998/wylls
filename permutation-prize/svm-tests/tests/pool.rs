//! The prize pool end to end in LiteSVM: the SBPF build of
//! permutation-prize, LiteSVM's own SPL Token program, and game accounts
//! (Season, Province, Citizen) laid out with the game's ABI under a
//! stand-in game program id.

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use litesvm::LiteSVM;
use permutation_prize::{entry, leaf, node, pool, tag, PrizeError as E};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::new_from_array([0; 32]);
const SEASON_ID: u64 = 7;
const END_BELL: u32 = 432;
/// 25 units of a 6-decimal test token (the owner's fee; a pool parameter).
const FEE: u64 = 25_000_000;
const SOL: u64 = 1_000_000_000;

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
}

fn so() -> Vec<u8> {
    let p = std::env::var("PRIZE_SO").unwrap_or_else(|_| {
        format!(
            "{}/../target/deploy/permutation_prize.so",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e} (run scripts/build-prize.sh)"))
}

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

fn game_account(w: &mut World, addr: [u8; 32], data: Vec<u8>) {
    let lamports = w.svm.minimum_balance_for_rent_exemption(data.len());
    w.svm
        .set_account(
            Address::new_from_array(addr),
            Account {
                lamports,
                data,
                owner: w.game,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}

fn set_season(w: &mut World, status: u8) {
    let mut d = vec![0u8; S::SIZE];
    put(&mut d, 0, &S::MAGIC);
    put(&mut d, S::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[S::STATUS] = status;
    put(&mut d, S::AUTHORITY, w.operator.pubkey().as_ref());
    put(&mut d, S::END_BELL, &END_BELL.to_le_bytes());
    let k = w.season.to_bytes();
    game_account(w, k, d);
}

/// The game's Frontier account: `opened` provinces (61 = rings 0..4).
fn set_frontier(w: &mut World, opened: u32) {
    let mut d = vec![0u8; F::SIZE];
    put(&mut d, 0, &F::MAGIC);
    put(&mut d, F::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, F::PROVINCES_OPENED, &opened.to_le_bytes());
    let k = w.ctx.frontier();
    game_account(w, k, d);
}

fn province_data(p: i16, q: i16, holder: u8, resolved_next: u32, bells: [u64; 6]) -> Vec<u8> {
    let mut d = vec![0u8; P::SIZE];
    put(&mut d, 0, &P::MAGIC);
    put(&mut d, P::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, P::P, &p.to_le_bytes());
    put(&mut d, P::Q, &q.to_le_bytes());
    put(&mut d, P::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    d[P::KEEP + K::TILE] = 30;
    d[P::KEEP + K::HOLDER] = holder;
    for (f, b) in bells.iter().enumerate() {
        put(&mut d, P::TERRITORY_BELLS + 8 * f, &b.to_le_bytes());
    }
    d
}

/// The 54 keep provinces (rings 2..4).
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

/// Writes every keep province: `holders[i]` holds `keeps()[i]`.
fn set_provinces(w: &mut World, holders: &[u8], bells: [u64; 6]) -> Vec<Address> {
    keeps()
        .iter()
        .zip(holders)
        .enumerate()
        .map(|(i, ((p, q), h))| {
            let a = w.ctx.province(*p as i32, *q as i32);
            let b = if i == 0 { bells } else { [0; 6] };
            game_account(w, a, province_data(*p, *q, *h, END_BELL, b));
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

fn world() -> World {
    let mut svm = LiteSVM::new();
    let prize = Keypair::new().pubkey();
    svm.add_program(prize, &so()).unwrap();
    let game = Keypair::new().pubkey();
    let operator = Keypair::new();
    svm.airdrop(&operator.pubkey(), 100 * SOL).unwrap();
    let (season, _) =
        Address::find_program_address(&[S::PDA_PREFIX, &SEASON_ID.to_le_bytes()], &game);
    // The test mint (6 decimals), authority the operator.
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
    };
    set_season(&mut w, S::STATUS_RUNNING);
    set_frontier(&mut w, 61);
    w
}

fn init_ix(w: &World, operator: &Address, fee: u64, ops_bps: u16, keeps: u16) -> Instruction {
    let mut d = vec![tag::INIT_POOL];
    d.extend_from_slice(&fee.to_le_bytes());
    d.extend_from_slice(&ops_bps.to_le_bytes());
    d.extend_from_slice(&keeps.to_le_bytes());
    d.extend_from_slice(&[9u8; 32]);
    Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new(*operator, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(w.game, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: d,
    }
}

fn init(w: &mut World) {
    init_with(w, 54)
}

fn init_with(w: &mut World, keeps: u16) {
    let ix = init_ix(w, &w.operator.pubkey(), FEE, 2_000, keeps);
    let op = w.operator.insecure_clone();
    send(&mut w.svm, &[ix], &[&op]).unwrap();
}

fn entry_of(w: &World, wallet: &Address) -> Address {
    Address::find_program_address(&[b"entry", w.pool.as_ref(), wallet.as_ref()], &w.prize).0
}

fn pay_ix(w: &World, wallet: &Address, payer: &Address, from: &Address) -> Instruction {
    Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(*wallet, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry_of(w, wallet), false),
            AccountMeta::new(*from, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: vec![tag::PAY],
    }
}

/// A funded wallet with `tokens` of the test mint; `(wallet, token account)`.
fn player(w: &mut World, tokens: u64) -> (Keypair, Address) {
    let k = Keypair::new();
    w.svm.airdrop(&k.pubkey(), SOL).unwrap();
    let op = w.operator.insecure_clone();
    let ta = token_account(&mut w.svm, &op, &w.mint, &k.pubkey());
    if tokens > 0 {
        mint_to(&mut w.svm, &op, &w.mint, &ta, tokens);
    }
    (k, ta)
}

fn pay(w: &mut World, k: &Keypair, ta: &Address) -> Result<(), String> {
    let ix = pay_ix(w, &k.pubkey(), &k.pubkey(), ta);
    send(&mut w.svm, &[ix], &[k])
}

fn tally(w: &mut World, provinces: &[Address]) -> Result<(), String> {
    let mut accounts = vec![
        AccountMeta::new(w.pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    accounts.extend(
        provinces
            .iter()
            .map(|a| AccountMeta::new_readonly(*a, false)),
    );
    let ix = Instruction {
        program_id: w.prize,
        accounts,
        data: vec![tag::TALLY],
    };
    let op = w.operator.insecure_clone();
    send(&mut w.svm, &[ix], &[&op])
}

fn finalize(w: &mut World) -> Result<(), String> {
    let frontier = Address::new_from_array(w.ctx.frontier());
    finalize_with(w, frontier)
}

fn finalize_with(w: &mut World, frontier: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new(w.pool, false),
            AccountMeta::new_readonly(frontier, false),
        ],
        data: vec![tag::FINALIZE],
    };
    let op = w.operator.insecure_clone();
    send(&mut w.svm, &[ix], &[&op])
}

fn set_shares(
    w: &mut World,
    signer: &Keypair,
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
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(w.pool, false),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[signer])
}

#[allow(clippy::too_many_arguments)]
fn claim(
    w: &mut World,
    k: &Keypair,
    ta: &Address,
    citizen: &Address,
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
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(k.pubkey(), true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(entry_of(w, &k.pubkey()), false),
            AccountMeta::new_readonly(*citizen, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(*ta, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[k])
}

fn pool_data(w: &World) -> Vec<u8> {
    w.svm.get_account(&w.pool).unwrap().data
}
fn u64_at(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}
fn u16_at(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().unwrap())
}

/// LiteSVM 0.16's default programs include SPL Token: a mint, two token
/// accounts and a transfer work with no extra program loaded.
#[test]
fn spl_token_is_available_in_litesvm() {
    let mut w = world();
    assert!(w.svm.get_account(&TOKEN).is_some_and(|a| a.executable));
    let (a, ta) = player(&mut w, 25_000_000);
    let (b, tb) = player(&mut w, 0);
    let mut d = vec![12u8]; // TransferChecked
    d.extend_from_slice(&5_000_000u64.to_le_bytes());
    d.push(6);
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(ta, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new(tb, false),
            AccountMeta::new_readonly(a.pubkey(), true),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[&a]).unwrap();
    assert_eq!(
        (balance(&w.svm, &ta), balance(&w.svm, &tb)),
        (20_000_000, 5_000_000)
    );
    let _ = b;
}

#[test]
fn only_the_season_authority_opens_the_pool() {
    let mut w = world();
    let other = Keypair::new();
    w.svm.airdrop(&other.pubkey(), SOL).unwrap();
    let ix = init_ix(&w, &other.pubkey(), FEE, 2_000, 54);
    fails(send(&mut w.svm, &[ix], &[&other]), E::NotOperator);
    let ix = init_ix(&w, &w.operator.pubkey(), 0, 2_000, 54);
    let op = w.operator.insecure_clone();
    fails(send(&mut w.svm, &[ix], &[&op]), E::BadParams);
    init(&mut w);
    let d = pool_data(&w);
    assert_eq!(u64_at(&d, pool::FEE), FEE);
    assert_eq!(u16_at(&d, pool::OPS_BPS), 2_000);
    assert_eq!(d[pool::DECIMALS], 6);
    // the vault is a token account of the mint owned by the pool PDA
    let v = w.svm.get_account(&w.vault).unwrap();
    assert_eq!(v.owner, TOKEN);
    assert_eq!(&v.data[..32], w.mint.as_ref());
    assert_eq!(&v.data[32..64], w.pool.as_ref());
    // a second InitPool is refused
    let ix = init_ix(&w, &w.operator.pubkey(), FEE, 2_000, 54);
    fails(send(&mut w.svm, &[ix], &[&op]), E::BadAccount);
}

/// The whole season: three payers, the tally in chunks from Province
/// accounts, the winner by area, shares by points, claims, the operator's
/// 20%.
#[test]
fn pay_tally_finalize_shares_claim() {
    let mut w = world();
    init(&mut w);
    let (a, ta) = player(&mut w, 3 * FEE);
    let (b, tb) = player(&mut w, FEE);
    let (c, tc) = player(&mut w, FEE);
    let (poor, tpoor) = player(&mut w, FEE - 1);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &b, &tb).unwrap();
    pay(&mut w, &c, &tc).unwrap();
    fails(pay(&mut w, &a, &ta), E::AlreadyPaid);
    assert!(
        pay(&mut w, &poor, &tpoor).is_err(),
        "a wallet without the fee does not enter"
    );
    assert!(w
        .svm
        .get_account(&entry_of(&w, &poor.pubkey()))
        .is_none_or(|x| x.data.is_empty()));
    let d = pool_data(&w);
    assert_eq!(u64_at(&d, pool::COLLECTED), 3 * FEE);
    assert_eq!(u64_at(&d, pool::PRIZE), 3 * FEE * 80 / 100);
    assert_eq!(u64_at(&d, pool::OPS), 3 * FEE * 20 / 100);
    assert_eq!(balance(&w.svm, &w.vault), 3 * FEE);
    assert_eq!(balance(&w.svm, &ta), 2 * FEE);
    let e = w.svm.get_account(&entry_of(&w, &a.pubkey())).unwrap();
    assert_eq!(
        &e.data[entry::WALLET..entry::WALLET + 32],
        a.pubkey().as_ref()
    );
    assert_eq!(u64_at(&e.data, entry::AMOUNT), FEE);

    // Nation 1 took one keep from nation 0: 9/9/… becomes 8/10/9/9/9/9.
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[0] = 1;
    let provinces = set_provinces(&mut w, &holders, [5, 6, 0, 0, 0, 0]);
    let ca = set_citizen(&mut w, &a.pubkey(), 1);
    let cb = set_citizen(&mut w, &b.pubkey(), 1);
    let cc = set_citizen(&mut w, &c.pubkey(), 0);

    // Not before the game says Ended.
    fails(tally(&mut w, &provinces[..10]), E::SeasonNotEnded);
    set_season(&mut w, S::STATUS_ENDED);
    // A province with an unresolved bell is not final.
    let (p0, q0) = keeps()[20];
    let a20 = w.ctx.province(p0 as i32, q0 as i32);
    game_account(
        &mut w,
        a20,
        province_data(p0, q0, holders[20], END_BELL - 1, [0; 6]),
    );
    fails(tally(&mut w, &provinces[18..36]), E::ProvinceNotFinal);
    game_account(
        &mut w,
        a20,
        province_data(p0, q0, holders[20], END_BELL, [0; 6]),
    );
    // An account that is not the game's Province at its address is refused.
    let fake = Keypair::new().pubkey();
    let lamports = w.svm.minimum_balance_for_rent_exemption(P::SIZE);
    w.svm
        .set_account(
            fake,
            Account {
                lamports,
                data: province_data(p0, q0, 3, END_BELL, [0; 6]),
                owner: w.game,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    fails(tally(&mut w, &[fake]), E::BadAccount);
    let (p1, q1) = keeps()[21];
    let squat = Address::new_from_array(w.ctx.province(p1 as i32, q1 as i32));
    let real = w.svm.get_account(&squat).unwrap();
    w.svm
        .set_account(
            squat,
            Account {
                owner: w.prize,
                ..real.clone()
            },
        )
        .unwrap();
    fails(tally(&mut w, &[squat]), E::BadAccount);
    w.svm.set_account(squat, real).unwrap();

    tally(&mut w, &provinces[..18]).unwrap();
    fails(finalize(&mut w), E::TallyIncomplete);
    // Fees stop at the first tally.
    let (late, tlate) = player(&mut w, FEE);
    fails(pay(&mut w, &late, &tlate), E::WrongState);
    // Passing a province twice counts it once.
    tally(&mut w, &provinces[10..36]).unwrap();
    assert_eq!(u16_at(&pool_data(&w), pool::COUNTED), 36);
    tally(&mut w, &provinces[36..]).unwrap();
    tally(&mut w, &provinces[..5]).unwrap();
    let d = pool_data(&w);
    assert_eq!(u16_at(&d, pool::COUNTED), 54);
    let area: Vec<u16> = (0..6).map(|f| u16_at(&d, pool::AREA + 2 * f)).collect();
    assert_eq!(area, [8, 10, 9, 9, 9, 9]);
    assert_eq!(
        (u64_at(&d, pool::BELLS), u64_at(&d, pool::BELLS + 8)),
        (5, 6)
    );

    // Shares and claims wait for Finalize.
    let op = w.operator.insecure_clone();
    fails(
        set_shares(&mut w, &op, pool::MODE_SHARES, [0, 1, 0, 0, 0, 0], [0; 32]),
        E::WrongState,
    );
    finalize(&mut w).unwrap();
    fails(finalize(&mut w), E::WrongState);
    fails(tally(&mut w, &provinces[..5]), E::WrongState);
    let d = pool_data(&w);
    assert_eq!(
        (d[pool::STATE], d[pool::WINNERS]),
        (pool::STATE_FINAL, 0b10)
    );

    // a: 10 points, b: 6 points (nation 1).
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.pubkey().to_bytes(), 1, 10);
    let lb = leaf(&pk, &b.pubkey().to_bytes(), 1, 6);
    let root = node(&la, &lb);
    fails(claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]), E::WrongState);
    fails(
        set_shares(&mut w, &a, pool::MODE_SHARES, [0, 16, 0, 0, 0, 0], root),
        E::NotOperator,
    );
    // Points for a nation that did not win, or a refund while there are points: refused.
    fails(
        set_shares(&mut w, &op, pool::MODE_SHARES, [4, 16, 0, 0, 0, 0], root),
        E::BadShares,
    );
    fails(
        set_shares(&mut w, &op, pool::MODE_REFUND, [0, 16, 0, 0, 0, 0], root),
        E::BadShares,
    );
    fails(
        set_shares(&mut w, &op, pool::MODE_SHARES, [0; 6], root),
        E::BadShares,
    );
    set_shares(&mut w, &op, pool::MODE_SHARES, [0, 16, 0, 0, 0, 0], root).unwrap();
    fails(
        set_shares(&mut w, &op, pool::MODE_SHARES, [0, 1, 0, 0, 0, 0], root),
        E::WrongState,
    );

    let prize = 3 * FEE * 80 / 100;
    fails(claim(&mut w, &a, &ta, &ca, 1, 11, &[lb]), E::BadProof);
    fails(claim(&mut w, &a, &ta, &ca, 1, 10, &[la]), E::BadProof);
    // c paid but is nation 0: not a winner, whatever it claims.
    fails(claim(&mut w, &c, &tc, &cc, 0, 10, &[lb]), E::NotWinner);
    fails(claim(&mut w, &c, &tc, &cc, 1, 10, &[lb]), E::NotWinner);
    // c with a's citizen: the citizen is not c's.
    fails(claim(&mut w, &c, &tc, &ca, 1, 10, &[lb]), E::BadAccount);
    // late never paid: no Entry.
    let cl = set_citizen(&mut w, &late.pubkey(), 1);
    assert!(claim(&mut w, &late, &tlate, &cl, 1, 10, &[lb]).is_err());

    let before = (balance(&w.svm, &ta), balance(&w.svm, &tb));
    claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]).unwrap();
    claim(&mut w, &b, &tb, &cb, 1, 6, &[la]).unwrap();
    fails(claim(&mut w, &a, &ta, &ca, 1, 10, &[lb]), E::AlreadyClaimed);
    assert_eq!(balance(&w.svm, &ta) - before.0, prize * 10 / 16);
    assert_eq!(balance(&w.svm, &tb) - before.1, prize * 6 / 16);

    // The operator's 20%, once.
    let top = token_account(&mut w.svm, &op, &w.mint, &op.pubkey());
    let ops_ix = |w: &World, who: &Address| Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(*who, true),
            AccountMeta::new(w.pool, false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new(top, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![tag::WITHDRAW_OPS],
    };
    let ix = ops_ix(&w, &a.pubkey());
    fails(send(&mut w.svm, &[ix], &[&a]), E::NotOperator);
    let ix = ops_ix(&w, &op.pubkey());
    send(&mut w.svm, std::slice::from_ref(&ix), &[&op]).unwrap();
    assert_eq!(balance(&w.svm, &top), 3 * FEE * 20 / 100);
    fails(send(&mut w.svm, &[ix], &[&op]), E::NothingToPay);
    assert_eq!(balance(&w.svm, &w.vault), 0);
    let d = pool_data(&w);
    assert_eq!(u64_at(&d, pool::CLAIMED), prize);
}

/// Two nations tied on area and on territory bells both win; the prize is
/// halved between them, then split by points.
#[test]
fn a_full_tie_splits_between_the_tied_nations() {
    let mut w = world();
    init(&mut w);
    let (a, ta) = player(&mut w, FEE);
    let (b, tb) = player(&mut w, FEE);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &b, &tb).unwrap();
    // 10/10/8/8/9/9, equal bells.
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[18] = 0;
    holders[27] = 1;
    let provinces = set_provinces(&mut w, &holders, [4, 4, 9, 9, 9, 9]);
    let ca = set_citizen(&mut w, &a.pubkey(), 0);
    let cb = set_citizen(&mut w, &b.pubkey(), 1);
    set_season(&mut w, S::STATUS_ENDED);
    for c in provinces.chunks(18) {
        tally(&mut w, c).unwrap();
    }
    finalize(&mut w).unwrap();
    assert_eq!(pool_data(&w)[pool::WINNERS], 0b11);
    let pk = w.pool.to_bytes();
    let la = leaf(&pk, &a.pubkey().to_bytes(), 0, 3);
    let lb = leaf(&pk, &b.pubkey().to_bytes(), 1, 50);
    let op = w.operator.insecure_clone();
    set_shares(
        &mut w,
        &op,
        pool::MODE_SHARES,
        [3, 50, 0, 0, 0, 0],
        node(&la, &lb),
    )
    .unwrap();
    claim(&mut w, &a, &ta, &ca, 0, 3, &[lb]).unwrap();
    claim(&mut w, &b, &tb, &cb, 1, 50, &[la]).unwrap();
    let prize = 2 * FEE * 80 / 100;
    assert_eq!(balance(&w.svm, &ta), prize / 2);
    assert_eq!(balance(&w.svm, &tb), prize / 2);
}

/// More territory bells break an area tie.
#[test]
fn territory_bells_break_an_area_tie() {
    let mut w = world();
    init(&mut w);
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[18] = 0;
    holders[27] = 1;
    let provinces = set_provinces(&mut w, &holders, [4, 5, 9, 9, 9, 9]);
    set_season(&mut w, S::STATUS_ENDED);
    for c in provinces.chunks(27) {
        tally(&mut w, c).unwrap();
    }
    finalize(&mut w).unwrap();
    assert_eq!(pool_data(&w)[pool::WINNERS], 0b10);
}

/// No eligible member in the winning nation: every payer takes its part of
/// the prize back (80% of its fee); the operator keeps its 20%.
#[test]
fn refund_when_the_winner_has_no_eligible_member() {
    let mut w = world();
    init(&mut w);
    let (a, ta) = player(&mut w, FEE);
    let (b, tb) = player(&mut w, FEE);
    pay(&mut w, &a, &ta).unwrap();
    pay(&mut w, &b, &tb).unwrap();
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[0] = 5;
    let provinces = set_provinces(&mut w, &holders, [0; 6]);
    let ca = set_citizen(&mut w, &a.pubkey(), 0);
    let cb = set_citizen(&mut w, &b.pubkey(), 1);
    set_season(&mut w, S::STATUS_ENDED);
    for c in provinces.chunks(18) {
        tally(&mut w, c).unwrap();
    }
    finalize(&mut w).unwrap();
    assert_eq!(pool_data(&w)[pool::WINNERS], 1 << 5);
    let op = w.operator.insecure_clone();
    set_shares(&mut w, &op, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    claim(&mut w, &a, &ta, &ca, 0, 0, &[]).unwrap();
    claim(&mut w, &b, &tb, &cb, 1, 0, &[]).unwrap();
    fails(claim(&mut w, &b, &tb, &cb, 1, 0, &[]), E::AlreadyClaimed);
    assert_eq!(balance(&w.svm, &ta), FEE * 80 / 100);
    assert_eq!(balance(&w.svm, &tb), FEE * 80 / 100);
    assert_eq!(balance(&w.svm, &w.vault), 2 * FEE * 20 / 100);
}

fn area(w: &World) -> Vec<u16> {
    let d = pool_data(w);
    (0..6).map(|f| u16_at(&d, pool::AREA + 2 * f)).collect()
}

/// (a) The end state is frozen: a Province is counted only when the Season
/// is Ended and every bell before `end_bell` is resolved; once counted it
/// is never read again, so a later change of its keep cannot move the
/// result; after Finalize nothing is counted at all.
#[test]
fn an_ownership_change_after_the_end_cannot_change_the_result() {
    let mut w = world();
    init(&mut w);
    let mut holders: Vec<u8> = (0..54).map(|i| (i / 9) as u8).collect();
    holders[0] = 3; // nation 3 holds 10
    let provinces = set_provinces(&mut w, &holders, [0; 6]);
    // Running: nothing is counted, whatever the provinces say.
    fails(tally(&mut w, &provinces[..18]), E::SeasonNotEnded);
    set_season(&mut w, S::STATUS_ENDED);
    // A keep that still has a bell to resolve, or a holder dated at or
    // after the end bell, is not final.
    let (p, q) = keeps()[1];
    let a1 = w.ctx.province(p as i32, q as i32);
    game_account(&mut w, a1, province_data(p, q, 0, END_BELL - 1, [0; 6]));
    fails(tally(&mut w, &provinces[1..2]), E::ProvinceNotFinal);
    let mut late = province_data(p, q, 5, END_BELL, [0; 6]);
    put(&mut late, P::KEEP + K::SINCE_BELL, &END_BELL.to_le_bytes());
    game_account(&mut w, a1, late);
    fails(tally(&mut w, &provinces[1..2]), E::ProvinceNotFinal);
    game_account(&mut w, a1, province_data(p, q, 0, END_BELL, [0; 6]));
    for c in provinces.chunks(18) {
        tally(&mut w, c).unwrap();
    }
    assert_eq!(area(&w), [8, 9, 9, 10, 9, 9]);
    // After the count, every keep "changes hands" to nation 5: the tally
    // does not move (each province was counted once, at its end state).
    for (i, (p, q)) in keeps().iter().enumerate() {
        let a = w.ctx.province(*p as i32, *q as i32);
        game_account(&mut w, a, province_data(*p, *q, 5, END_BELL + 9, [7; 6]));
        let _ = i;
    }
    for c in provinces.chunks(18) {
        tally(&mut w, c).unwrap();
    }
    assert_eq!(area(&w), [8, 9, 9, 10, 9, 9]);
    assert_eq!(u16_at(&pool_data(&w), pool::COUNTED), 54);
    finalize(&mut w).unwrap();
    assert_eq!(pool_data(&w)[pool::WINNERS], 1 << 3);
    // Final: no tally, no second Finalize.
    fails(tally(&mut w, &provinces[..18]), E::WrongState);
    fails(finalize(&mut w), E::WrongState);
    assert_eq!(pool_data(&w)[pool::WINNERS], 1 << 3);
    assert_eq!(area(&w), [8, 9, 9, 10, 9, 9]);
}

/// (b) a missing province: no Finalize; (c) a duplicate is counted once;
/// (d) another season's, another program's or a keepless Province is
/// refused; (e) a wrong expected count is refused.
#[test]
fn tally_and_finalize_guards() {
    let mut w = world();
    init(&mut w);
    let holders: Vec<u8> = (0..54)
        .map(|i| if i == 0 { 2 } else { (i / 9) as u8 })
        .collect();
    let provinces = set_provinces(&mut w, &holders, [0; 6]);
    set_season(&mut w, S::STATUS_ENDED);

    // (d) another season's Province (right address, the game's, season 8).
    let (p, q) = keeps()[5];
    let a5 = w.ctx.province(p as i32, q as i32);
    let mut other_season = province_data(p, q, 4, END_BELL, [0; 6]);
    put(&mut other_season, P::SEASON_ID, &8u64.to_le_bytes());
    game_account(&mut w, a5, other_season);
    fails(tally(&mut w, &provinces[5..6]), E::BadAccount);
    // (d) another program's account with a Province's bytes at that address.
    let lamports = w.svm.minimum_balance_for_rent_exemption(P::SIZE);
    let other_program = Keypair::new().pubkey();
    w.svm
        .set_account(
            provinces[5],
            Account {
                lamports,
                data: province_data(p, q, 4, END_BELL, [0; 6]),
                owner: other_program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    fails(tally(&mut w, &provinces[5..6]), E::BadAccount);
    // (d) the game's Province of the same coordinates under another address.
    let stray = Keypair::new().pubkey();
    w.svm
        .set_account(
            stray,
            Account {
                lamports,
                data: province_data(p, q, 4, END_BELL, [0; 6]),
                owner: w.game,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    fails(tally(&mut w, &[stray]), E::BadAccount);
    game_account(
        &mut w,
        a5,
        province_data(p, q, holders[5], END_BELL, [0; 6]),
    );
    // (d) a keepless Province (ring 1).
    let a_core = w.ctx.province(1, 0);
    let mut core = province_data(1, 0, 0, END_BELL, [0; 6]);
    core[P::KEEP + K::TILE] = K::NO_TILE;
    game_account(&mut w, a_core, core);
    fails(tally(&mut w, &[Address::new_from_array(a_core)]), E::NoKeep);
    // The Season itself must be the pool's.
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new(w.pool, false),
            AccountMeta::new_readonly(provinces[0], false),
            AccountMeta::new_readonly(provinces[1], false),
        ],
        data: vec![tag::TALLY],
    };
    let op = w.operator.insecure_clone();
    fails(send(&mut w.svm, &[ix], &[&op]), E::BadAccount);

    // (c) the same province three times in one transaction and again later: once.
    tally(&mut w, &[provinces[0], provinces[0], provinces[0]]).unwrap();
    tally(&mut w, &provinces[..1]).unwrap();
    assert_eq!(u16_at(&pool_data(&w), pool::COUNTED), 1);
    assert_eq!(area(&w), [0, 0, 1, 0, 0, 0]);

    // (b) 53 of 54: Finalize refuses, with every chunk order.
    tally(&mut w, &provinces[..30]).unwrap();
    tally(&mut w, &provinces[31..]).unwrap();
    assert_eq!(u16_at(&pool_data(&w), pool::COUNTED), 53);
    fails(finalize(&mut w), E::TallyIncomplete);
    // A Frontier account that is not the game's at its address is refused.
    let fake = Keypair::new().pubkey();
    let real = w
        .svm
        .get_account(&Address::new_from_array(w.ctx.frontier()))
        .unwrap();
    let mut short = real.clone();
    put(&mut short.data, F::PROVINCES_OPENED, &60u32.to_le_bytes());
    w.svm.set_account(fake, short).unwrap();
    fails(finalize_with(&mut w, fake), E::BadAccount);
    tally(&mut w, &provinces[30..31]).unwrap();
    finalize(&mut w).unwrap();
    assert_eq!(area(&w), [8, 9, 10, 9, 9, 9]);
    assert_eq!(pool_data(&w)[pool::WINNERS], 1 << 2);

    // (e) a pool opened with the wrong count can never be finalised: 53
    // counted of an expected 53 is not the game's 54, and 54 is not 53.
    let mut w = world();
    init_with(&mut w, 53);
    let provinces = set_provinces(&mut w, &holders, [0; 6]);
    set_season(&mut w, S::STATUS_ENDED);
    tally(&mut w, &provinces[..30]).unwrap();
    tally(&mut w, &provinces[31..]).unwrap();
    fails(finalize(&mut w), E::WrongExpectedCount);
    tally(&mut w, &provinces[30..31]).unwrap();
    fails(finalize(&mut w), E::WrongExpectedCount);
    assert_eq!(pool_data(&w)[pool::STATE], pool::STATE_OPEN);
}
