//! Epoch pools (feature `epochs`): settlement windows of a continuous
//! world, end to end in LiteSVM against `scripts/build-prize.sh --features
//! epochs` (`PRIZE_EPOCH_SO`, default `target/deploy-epochs`). Test tokens
//! only. Without that build these tests are skipped with a message (the
//! default build has no epoch instructions; `pool.rs` covers it).

use frontier_abi::addr::{ring_of, AddrCtx};
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::v2::presets::{cq_layout, SEASON_CQ_OFFSET};
use litesvm::LiteSVM;
use permutation_prize::{leaf, node, pool, tag, PrizeError as E};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::new_from_array([0; 32]);
const SEASON_ID: u64 = 11;
const BELL_SECS: u32 = 600;
/// 25 units of a 6-decimal test token (the owner's fee), 20% operator.
const FEE: u64 = 25_000_000;
const OPS_BPS: u16 = 2_000;
const SOL: u64 = 1_000_000_000;
/// Epoch 0 ends at bell 10, epoch 1 at bell 20; claims for 5 bells.
const E0: u32 = 10;
const E1: u32 = 20;
const CLAIM_BELLS: u32 = 5;

struct World {
    svm: LiteSVM,
    prize: Address,
    game: Address,
    season: Address,
    ctx: AddrCtx,
    operator: Keypair,
    mint: Address,
    /// The season's join gate: the key that admits operator members by invite.
    gate: Keypair,
}

/// The epochs build. A path given in `PRIZE_EPOCH_SO` must exist; the
/// default path may be missing (the test then says SKIP and passes).
fn so() -> Option<Vec<u8>> {
    if let Ok(p) = std::env::var("PRIZE_EPOCH_SO") {
        return Some(std::fs::read(&p).unwrap_or_else(|e| panic!("PRIZE_EPOCH_SO={p}: {e}")));
    }
    let p = format!(
        "{}/../target/deploy-epochs/permutation_prize.so",
        env!("CARGO_MANIFEST_DIR")
    );
    match std::fs::read(&p) {
        Ok(b) => Some(b),
        Err(e) => {
            eprintln!("SKIP: {p}: {e} (run scripts/build-prize.sh --features epochs)");
            None
        }
    }
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

fn put(d: &mut [u8], off: usize, v: &[u8]) {
    d[off..off + v.len()].copy_from_slice(v);
}
fn u64_at(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}
fn u16_at(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().unwrap())
}

fn set_time(w: &mut World, ts: i64) {
    let mut c: Clock = w.svm.get_sysvar();
    c.unix_timestamp = ts;
    c.slot += 1;
    w.svm.set_sysvar(&c);
}
/// The time of `bell` (genesis 0).
fn at_bell(bell: u32) -> i64 {
    i64::from(bell) * i64::from(BELL_SECS)
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

fn token_account(w: &mut World, owner: &Address) -> Address {
    let k = Keypair::new();
    let rent = w.svm.minimum_balance_for_rent_exemption(165);
    let mut d = vec![18u8]; // InitializeAccount3
    d.extend_from_slice(owner.as_ref());
    let init = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(k.pubkey(), false),
            AccountMeta::new_readonly(w.mint, false),
        ],
        data: d,
    };
    let op = w.operator.insecure_clone();
    let create = system_create(&op.pubkey(), &k.pubkey(), rent, 165, &TOKEN);
    send(&mut w.svm, &[create, init], &[&op, &k]).unwrap();
    k.pubkey()
}

fn mint_to(w: &mut World, to: &Address, amount: u64) {
    let mut d = vec![7u8]; // MintTo
    d.extend_from_slice(&amount.to_le_bytes());
    let op = w.operator.insecure_clone();
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(w.mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(op.pubkey(), true),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[&op]).unwrap();
}

fn balance(w: &World, ta: &Address) -> u64 {
    u64_at(&w.svm.get_account(ta).expect("token account").data, 64)
}

fn game_account(w: &mut World, addr: [u8; 32], data: Vec<u8>) {
    let lamports = w.svm.minimum_balance_for_rent_exemption(data.len());
    let acc = Account {
        lamports,
        data,
        owner: w.game,
        executable: false,
        rent_epoch: 0,
    };
    w.svm
        .set_account(Address::new_from_array(addr), acc)
        .unwrap();
}

fn set_season(w: &mut World, status: u8, continuous: u8) {
    let mut d = vec![0u8; S::SIZE];
    put(&mut d, 0, &S::MAGIC);
    put(&mut d, S::SEASON_ID, &SEASON_ID.to_le_bytes());
    d[S::STATUS] = status;
    put(&mut d, S::R_MAX, &16u16.to_le_bytes());
    put(&mut d, S::AUTHORITY, w.operator.pubkey().as_ref());
    put(&mut d, S::BELL_SECS, &BELL_SECS.to_le_bytes());
    put(&mut d, S::GENESIS_TS, &0i64.to_le_bytes());
    // A continuous world has no end bell or join deadline of its own.
    put(&mut d, S::END_BELL, &u32::MAX.to_le_bytes());
    d[SEASON_CQ_OFFSET + cq_layout::CONTINUOUS] = continuous;
    put(&mut d, S::JOIN_GATE, w.gate.pubkey().as_ref());
    let k = w.season.to_bytes();
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

/// A keep Province: `holder` since `since`, every bell before
/// `resolved_next` resolved, opened at `opened`.
fn province_data(
    p: i16,
    q: i16,
    holder: u8,
    resolved_next: u32,
    since: u32,
    opened: u32,
) -> Vec<u8> {
    let mut d = vec![0u8; P::SIZE];
    put(&mut d, 0, &P::MAGIC);
    put(&mut d, P::SEASON_ID, &SEASON_ID.to_le_bytes());
    put(&mut d, P::P, &p.to_le_bytes());
    put(&mut d, P::Q, &q.to_le_bytes());
    put(&mut d, P::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    put(&mut d, P::OPENED_BELL, &opened.to_le_bytes());
    d[P::KEEP + K::TILE] = 30;
    d[P::KEEP + K::HOLDER] = holder;
    put(&mut d, P::KEEP + K::SINCE_BELL, &since.to_le_bytes());
    // Cumulative territory bells: epoch pools never read them.
    put(&mut d, P::TERRITORY_BELLS, &999u64.to_le_bytes());
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

fn set_province(w: &mut World, i: usize, holder: u8, resolved_next: u32, since: u32) -> Address {
    let (p, q) = keeps()[i];
    let a = w.ctx.province(p as i32, q as i32);
    game_account(w, a, province_data(p, q, holder, resolved_next, since, 0));
    Address::new_from_array(a)
}

/// Every keep, `holders[i]` holding `keeps()[i]` since bell 1, resolved to `resolved_next`.
fn set_provinces(w: &mut World, holders: &[u8], resolved_next: u32) -> Vec<Address> {
    (0..54)
        .map(|i| set_province(w, i, holders[i], resolved_next, 1))
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

fn world() -> Option<World> {
    let so = so()?;
    let mut svm = LiteSVM::new();
    let prize = Keypair::new().pubkey();
    svm.add_program(prize, &so).unwrap();
    let game = Keypair::new().pubkey();
    let operator = Keypair::new();
    svm.airdrop(&operator.pubkey(), 100 * SOL).unwrap();
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
    let create = system_create(&operator.pubkey(), &mint.pubkey(), rent, 82, &TOKEN);
    send(&mut svm, &[create, init], &[&operator, &mint]).unwrap();
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
        gate: Keypair::new(),
    };
    set_season(&mut w, S::STATUS_RUNNING, 1);
    set_funds(&mut w, 61);
    set_time(&mut w, 100);
    Some(w)
}

fn epool(w: &World, epoch: u32) -> Address {
    Address::find_program_address(
        &[
            b"epool",
            w.game.as_ref(),
            &SEASON_ID.to_le_bytes(),
            &epoch.to_le_bytes(),
        ],
        &w.prize,
    )
    .0
}
fn vault(w: &World, pool: &Address) -> Address {
    Address::find_program_address(&[b"vault", pool.as_ref()], &w.prize).0
}
fn entry(w: &World, pool: &Address, wallet: &Address) -> Address {
    Address::find_program_address(&[b"entry", pool.as_ref(), wallet.as_ref()], &w.prize).0
}

fn init_epoch_ix(w: &World, signer: &Address, epoch: u32, end_bell: u32, fee: u64) -> Instruction {
    let mut d = vec![tag::INIT_EPOCH_POOL];
    d.extend_from_slice(&epoch.to_le_bytes());
    d.extend_from_slice(&end_bell.to_le_bytes());
    d.extend_from_slice(&CLAIM_BELLS.to_le_bytes());
    d.extend_from_slice(&fee.to_le_bytes());
    d.extend_from_slice(&OPS_BPS.to_le_bytes());
    d.extend_from_slice(&[9u8; 32]);
    let pool = epool(w, epoch);
    Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new(*signer, true),
            AccountMeta::new(pool, false),
            AccountMeta::new(vault(w, &pool), false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(w.game, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: d,
    }
}

fn init_epoch(w: &mut World, epoch: u32, end_bell: u32) -> Result<(), String> {
    let op = w.operator.insecure_clone();
    let ix = init_epoch_ix(w, &op.pubkey(), epoch, end_bell, FEE);
    send(&mut w.svm, &[ix], &[&op])
}

fn player(w: &mut World, tokens: u64) -> (Keypair, Address) {
    let k = Keypair::new();
    w.svm.airdrop(&k.pubkey(), SOL).unwrap();
    let ta = token_account(w, &k.pubkey());
    if tokens > 0 {
        mint_to(w, &ta, tokens);
    }
    (k, ta)
}

fn pay(w: &mut World, epoch: u32, k: &Keypair, ta: &Address) -> Result<(), String> {
    let pool = epool(w, epoch);
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(k.pubkey(), true),
            AccountMeta::new(k.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(entry(w, &pool, &k.pubkey()), false),
            AccountMeta::new(*ta, false),
            AccountMeta::new(vault(w, &pool), false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(exclusion(w, &k.pubkey()), false),
        ],
        data: vec![tag::PAY],
    };
    send(&mut w.svm, &[ix], &[k])
}

/// The wallet's exclusion address in the season (`["noprize", game, season, wallet]`).
fn exclusion(w: &World, wallet: &Address) -> Address {
    Address::find_program_address(
        &[
            b"noprize",
            w.game.as_ref(),
            &SEASON_ID.to_le_bytes(),
            wallet.as_ref(),
        ],
        &w.prize,
    )
    .0
}

/// ExcludeWallet signed by `signer` (the season's gate, or someone else).
fn exclude(w: &mut World, signer: &Keypair, wallet: &Address) -> Result<(), String> {
    let payer = Keypair::new();
    w.svm.airdrop(&payer.pubkey(), SOL).unwrap();
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(w.season, false),
            AccountMeta::new_readonly(w.game, false),
            AccountMeta::new(exclusion(w, wallet), false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: vec![tag::EXCLUDE_WALLET],
    };
    send(&mut w.svm, &[ix], &[&payer, signer])
}

fn crank(w: &mut World, t: u8, pool: Address, rest: &[Address]) -> Result<(), String> {
    let mut accounts = vec![
        AccountMeta::new(pool, false),
        AccountMeta::new_readonly(w.season, false),
    ];
    accounts.extend(rest.iter().map(|a| AccountMeta::new_readonly(*a, false)));
    let ix = Instruction {
        program_id: w.prize,
        accounts,
        data: vec![t],
    };
    // Anyone may crank: a stranger pays the fee.
    let anyone = Keypair::new();
    w.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    send(&mut w.svm, &[ix], &[&anyone])
}

fn tally(w: &mut World, epoch: u32, provinces: &[Address]) -> Result<(), String> {
    let pool = epool(w, epoch);
    for chunk in provinces.chunks(18) {
        crank(w, tag::EPOCH_TALLY, pool, chunk)?;
    }
    Ok(())
}

fn finalize(w: &mut World, epoch: u32) -> Result<(), String> {
    let (pool, f) = (epool(w, epoch), funds(w));
    crank(w, tag::EPOCH_FINALIZE, pool, &f)
}

fn sweep(w: &mut World, from: u32, to: u32) -> Result<(), String> {
    let (a, b) = (epool(w, from), epool(w, to));
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new(a, false),
            AccountMeta::new(vault(w, &a), false),
            AccountMeta::new(b, false),
            AccountMeta::new(vault(w, &b), false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![tag::SWEEP],
    };
    let anyone = Keypair::new();
    w.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    send(&mut w.svm, &[ix], &[&anyone])
}

fn set_shares(
    w: &mut World,
    epoch: u32,
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
    let op = w.operator.insecure_clone();
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(op.pubkey(), true),
            AccountMeta::new(epool(w, epoch), false),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[&op])
}

#[allow(clippy::too_many_arguments)]
fn claim(
    w: &mut World,
    epoch: u32,
    k: &Keypair,
    ta: &Address,
    citizen: &Address,
    nation: u8,
    points: u64,
    proof: &[[u8; 32]],
) -> Result<(), String> {
    let pool = epool(w, epoch);
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
            AccountMeta::new(pool, false),
            AccountMeta::new(entry(w, &pool, &k.pubkey()), false),
            AccountMeta::new_readonly(*citizen, false),
            AccountMeta::new(vault(w, &pool), false),
            AccountMeta::new(*ta, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(exclusion(w, &k.pubkey()), false),
        ],
        data: d,
    };
    send(&mut w.svm, &[ix], &[k])
}

fn withdraw_ops(w: &mut World, epoch: u32, to: &Address) -> Result<(), String> {
    let pool = epool(w, epoch);
    let op = w.operator.insecure_clone();
    let ix = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(op.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(vault(w, &pool), false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![tag::WITHDRAW_OPS],
    };
    send(&mut w.svm, &[ix], &[&op])
}

fn pool_data(w: &World, epoch: u32) -> Vec<u8> {
    w.svm.get_account(&epool(w, epoch)).unwrap().data
}

/// Nation 1 holds 30 keeps, nation 2 holds 24.
fn holders_1_wins() -> Vec<u8> {
    (0..54).map(|i| if i < 30 { 1 } else { 2 }).collect()
}

/// The whole cycle in a world that never ends: fees in two windows, the
/// first window settled from the keeps at its end bell, shares claimed,
/// the unclaimed rest swept into the next window, the operator's 20% out.
/// Every token that came in has an exit.
#[test]
fn an_epoch_pays_out_and_rolls_the_rest_into_the_next() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    init_epoch(&mut w, 1, E1).unwrap();
    let d = pool_data(&w, 0);
    assert_eq!(d[pool::KIND], pool::KIND_EPOCH);
    assert_eq!(u64_at(&d, pool::FEE), FEE);
    assert_eq!(u16_at(&d, pool::OPS_BPS), OPS_BPS);
    assert_eq!(&d[..8], &pool::MAGIC, "the legacy decoders read it");

    let (a, ta) = player(&mut w, 2 * FEE);
    let (b, tb) = player(&mut w, FEE);
    let (c, tc) = player(&mut w, FEE);
    let (late, tlate) = player(&mut w, 2 * FEE);
    for (k, t) in [(&a, &ta), (&b, &tb), (&c, &tc)] {
        pay(&mut w, 0, k, t).unwrap();
    }
    pay(&mut w, 1, &a, &ta).unwrap();
    let d = pool_data(&w, 0);
    assert_eq!(u64_at(&d, pool::COLLECTED), 3 * FEE);
    assert_eq!(u64_at(&d, pool::PRIZE), 3 * FEE * 80 / 100);
    assert_eq!(u64_at(&d, pool::OPS), 3 * FEE * 20 / 100);

    let provinces = set_provinces(&mut w, &holders_1_wins(), E0);
    let ca = set_citizen(&mut w, &a.pubkey(), 1);
    let cb = set_citizen(&mut w, &b.pubkey(), 1);
    let cc = set_citizen(&mut w, &c.pubkey(), 2);

    // Still inside the window: nothing is counted, fees still taken.
    fails(tally(&mut w, 0, &provinces), E::WindowOpen);
    fails(finalize(&mut w, 0), E::WindowOpen);
    // The window's time is over: no more fees into epoch 0, epoch 1 open.
    set_time(&mut w, at_bell(E0));
    fails(pay(&mut w, 0, &late, &tlate), E::EpochClosed);
    pay(&mut w, 1, &late, &tlate).unwrap();
    tally(&mut w, 0, &provinces).unwrap();
    finalize(&mut w, 0).unwrap();
    let d = pool_data(&w, 0);
    assert_eq!(d[pool::STATE], pool::STATE_FINAL);
    assert_eq!(d[pool::WINNERS], 0b10);
    assert_eq!(u16_at(&d, pool::AREA + 2), 30);
    assert_eq!(u16_at(&d, pool::AREA + 4), 24);
    let deadline = at_bell(E0) + at_bell(CLAIM_BELLS);
    assert_eq!(u64_at(&d, pool::DEADLINE_TS) as i64, deadline);
    // Nothing more to count, and the legacy instructions keep out.
    fails(tally(&mut w, 0, &provinces[..1]), E::WrongState);
    let p0 = epool(&w, 0);
    fails(
        crank(&mut w, tag::TALLY, p0, &provinces[..1]),
        E::WrongState,
    );

    // Shares: a 3 points, b 1 point (nation 1).
    let pool0 = epool(&w, 0).to_bytes();
    let la = leaf(&pool0, &a.pubkey().to_bytes(), 1, 3);
    let lb = leaf(&pool0, &b.pubkey().to_bytes(), 1, 1);
    set_shares(
        &mut w,
        0,
        pool::MODE_SHARES,
        [0, 4, 0, 0, 0, 0],
        node(&la, &lb),
    )
    .unwrap();
    let before = balance(&w, &ta);
    claim(&mut w, 0, &a, &ta, &ca, 1, 3, &[lb]).unwrap();
    let prize = 3 * FEE * 80 / 100;
    assert_eq!(balance(&w, &ta) - before, prize * 3 / 4);
    // c's nation lost.
    fails(claim(&mut w, 0, &c, &tc, &cc, 2, 1, &[]), E::NotWinner);

    // b has not claimed: the rest waits for the claim window.
    fails(sweep(&mut w, 0, 1), E::ClaimWindowOpen);
    set_time(&mut w, deadline);
    // Only forward, and only into a window still taking fees.
    fails(sweep(&mut w, 1, 0), E::WrongState);
    sweep(&mut w, 0, 1).unwrap();
    let rest = prize - prize * 3 / 4;
    let d0 = pool_data(&w, 0);
    assert_eq!(d0[pool::STATE], pool::STATE_SWEPT);
    assert_eq!(u64_at(&d0, pool::ROLLED_OUT), rest);
    fails(claim(&mut w, 0, &b, &tb, &cb, 1, 1, &[la]), E::WrongState);
    fails(sweep(&mut w, 0, 1), E::WrongState);
    let d1 = pool_data(&w, 1);
    assert_eq!(u64_at(&d1, pool::COLLECTED), 2 * FEE + rest);
    assert_eq!(u64_at(&d1, pool::PRIZE), 2 * FEE * 80 / 100 + rest);
    assert_eq!(u64_at(&d1, pool::OPS), 2 * FEE * 20 / 100);
    let v1 = vault(&w, &epool(&w, 1));
    assert_eq!(balance(&w, &v1), 2 * FEE + rest);

    // The operator's 20% leaves epoch 0's vault; it is then empty.
    let opta = {
        let o = w.operator.pubkey();
        token_account(&mut w, &o)
    };
    withdraw_ops(&mut w, 0, &opta).unwrap();
    assert_eq!(balance(&w, &opta), 3 * FEE * 20 / 100);
    let v0 = vault(&w, &epool(&w, 0));
    assert_eq!(
        balance(&w, &v0),
        0,
        "every deposit of epoch 0 has left its vault"
    );
}

/// The snapshot rule at the window's end bell.
#[test]
fn keeps_count_as_they_stood_at_the_end_bell() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    // 27/27 between nations 3 and 4, then three special provinces.
    let holders: Vec<u8> = (0..54).map(|i| if i % 2 == 0 { 3 } else { 4 }).collect();
    let mut provinces = set_provinces(&mut w, &holders, E0);
    set_time(&mut w, at_bell(E0 + 3));
    // Not every bell before the end resolved: not final yet.
    provinces[0] = set_province(&mut w, 0, 3, E0 - 1, 1);
    fails(tally(&mut w, 0, &provinces[..1]), E::ProvinceNotFinal);
    // Taken in the last bell of the window (bell E0 − 1 → since E0): counts.
    provinces[0] = set_province(&mut w, 0, 4, E0 + 3, E0);
    // Taken after the close (since E0 + 1) before the tally: counts for nobody.
    provinces[2] = set_province(&mut w, 2, 4, E0 + 3, E0 + 1);
    // Opened at the end bell or later: on the map, but not at the end.
    let (p, q) = keeps()[4];
    let a = w.ctx.province(p as i32, q as i32);
    game_account(&mut w, a, province_data(p, q, 4, E0 + 3, E0 + 2, E0));
    tally(&mut w, 0, &provinces).unwrap();
    // Counting twice changes nothing.
    tally(&mut w, 0, &provinces).unwrap();
    finalize(&mut w, 0).unwrap();
    let d = pool_data(&w, 0);
    assert_eq!(u16_at(&d, pool::COUNTED), 54);
    // nation 3: 27 − province 0 − 2 − 4 = 24; nation 4: 27 + province 0 = 28.
    assert_eq!(u16_at(&d, pool::AREA + 6), 24);
    assert_eq!(u16_at(&d, pool::AREA + 8), 28);
    assert_eq!(d[pool::WINNERS], 1 << 4);
    // Territory bells are not read by an epoch pool.
    assert!((0..6).all(|f| u64_at(&d, pool::BELLS + 8 * f) == 0));
}

/// A tie for first place is shared (no territory-bell tie break), and a
/// grown map needs every new keep counted first.
#[test]
fn a_tie_is_shared_and_a_grown_map_is_counted_whole() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    let holders: Vec<u8> = (0..54).map(|i| if i < 27 { 0 } else { 5 }).collect();
    let provinces = set_provinces(&mut w, &holders, E0);
    set_time(&mut w, at_bell(E0));
    tally(&mut w, 0, &provinces).unwrap();
    // One more province opened (by the game's own count) and not counted.
    set_funds(&mut w, 62);
    fails(finalize(&mut w, 0), E::TallyIncomplete);
    set_funds(&mut w, 61);
    finalize(&mut w, 0).unwrap();
    assert_eq!(pool_data(&w, 0)[pool::WINNERS], 0b100001);
}

/// Refund mode on an epoch pool: claims sign with the epoch pool's seeds.
#[test]
fn refund_works_on_an_epoch_pool() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    let (a, ta) = player(&mut w, FEE);
    pay(&mut w, 0, &a, &ta).unwrap();
    let provinces = set_provinces(&mut w, &holders_1_wins(), E0);
    let ca = set_citizen(&mut w, &a.pubkey(), 1);
    set_time(&mut w, at_bell(E0));
    tally(&mut w, 0, &provinces).unwrap();
    finalize(&mut w, 0).unwrap();
    set_shares(&mut w, 0, pool::MODE_REFUND, [0; 6], [0; 32]).unwrap();
    claim(&mut w, 0, &a, &ta, &ca, 0, 0, &[]).unwrap();
    assert_eq!(balance(&w, &ta), FEE * 80 / 100);
}

#[test]
fn epoch_pools_open_only_in_a_running_continuous_world() {
    let Some(mut w) = world() else { return };
    // Not the season's authority.
    let other = Keypair::new();
    w.svm.airdrop(&other.pubkey(), SOL).unwrap();
    let ix = init_epoch_ix(&w, &other.pubkey(), 0, E0, FEE);
    fails(send(&mut w.svm, &[ix], &[&other]), E::NotOperator);
    // A zero fee.
    let op = w.operator.insecure_clone();
    let ix = init_epoch_ix(&w, &op.pubkey(), 0, E0, 0);
    fails(send(&mut w.svm, &[ix], &[&op]), E::BadParams);
    // A window whose end is already past.
    set_time(&mut w, at_bell(E0));
    fails(init_epoch(&mut w, 0, E0), E::EpochClosed);
    set_time(&mut w, 100);
    // A finite world: the legacy InitPool's.
    set_season(&mut w, S::STATUS_RUNNING, 0);
    fails(init_epoch(&mut w, 0, E0), E::FiniteSeason);
    // An ended world.
    set_season(&mut w, S::STATUS_ENDED, 1);
    fails(init_epoch(&mut w, 0, E0), E::WrongState);
    set_season(&mut w, S::STATUS_RUNNING, 1);
    init_epoch(&mut w, 0, E0).unwrap();
    assert!(init_epoch(&mut w, 0, E0).is_err(), "one pool per epoch");
}

#[test]
fn sweep_guards() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    init_epoch(&mut w, 1, E0).unwrap();
    init_epoch(&mut w, 2, E1).unwrap();
    let (a, ta) = player(&mut w, FEE);
    pay(&mut w, 0, &a, &ta).unwrap();
    // An open pool cannot be swept.
    fails(sweep(&mut w, 0, 2), E::WrongState);
    let provinces = set_provinces(&mut w, &holders_1_wins(), E0);
    set_time(&mut w, at_bell(E0));
    tally(&mut w, 0, &provinces).unwrap();
    finalize(&mut w, 0).unwrap();
    set_time(&mut w, at_bell(E0 + CLAIM_BELLS));
    // Not into itself; not into a window that is closed (epoch 1 ends at E0).
    fails(sweep(&mut w, 0, 0), E::BadAccount);
    fails(sweep(&mut w, 0, 1), E::WrongState);
    // The legacy Tally and Finalize refuse an (open) epoch pool.
    let p2 = epool(&w, 2);
    fails(
        crank(&mut w, tag::TALLY, p2, &provinces[..1]),
        E::WrongState,
    );
    let f = funds(&w);
    fails(crank(&mut w, tag::FINALIZE, p2, &f), E::WrongState);
    // Not into a window whose tally has begun.
    fails(tally(&mut w, 2, &provinces[..1]), E::WindowOpen);
    init_epoch(&mut w, 3, E1 + 10).unwrap();
    set_time(&mut w, at_bell(E1));
    let p0 = set_province(&mut w, 0, 1, E1, 1);
    tally(&mut w, 2, &[p0]).unwrap();
    fails(sweep(&mut w, 0, 2), E::WrongState);
    // A window still taking fees takes it.
    sweep(&mut w, 0, 3).unwrap();
    assert_eq!(u64_at(&pool_data(&w, 3), pool::PRIZE), FEE * 80 / 100);
}

/// The default build has no epoch instructions: InitEpochPool is unknown
/// data there (`PRIZE_SO`, default `target/deploy`; skipped when missing).
#[test]
fn the_default_build_has_no_epoch_instructions() {
    let p = std::env::var("PRIZE_SO").unwrap_or_else(|_| {
        format!(
            "{}/../target/deploy/permutation_prize.so",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let Ok(default_so) = std::fs::read(&p) else {
        eprintln!("SKIP: {p} (run scripts/build-prize.sh)");
        return;
    };
    assert!(
        !default_so
            .windows(permutation_prize_marker().len())
            .any(|w| w == permutation_prize_marker()),
        "{p} carries the epochs marker"
    );
    let Some(mut w) = world() else { return };
    w.svm.add_program(w.prize, &default_so).unwrap();
    fails(init_epoch(&mut w, 0, E0), E::BadData);
    // EpochTally, EpochFinalize and Sweep are unknown there too.
    for t in [tag::EPOCH_TALLY, tag::EPOCH_FINALIZE, tag::SWEEP] {
        let pool = epool(&w, 0);
        fails(crank(&mut w, t, pool, &[]), E::BadData);
    }
}

fn permutation_prize_marker() -> &'static [u8] {
    b"PRZ_EPOCHS_TEST_USDC_BUILD"
}

// ------------------------------------------------------------ owner decisions 2026-11-18 21:44 (t353u)

/// No AI residents in paid periods: a wallet the season's join gate marked
/// as an operator member (operator AI residents and script bots join by
/// invite with that key) can neither Pay into nor Claim from an epoch pool.
/// Only the gate can mark; a mark is idempotent and permanent.
#[test]
fn operator_members_cannot_pay_or_claim_in_a_paid_window() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    let (ai, tai) = player(&mut w, 2 * FEE);
    // Not the gate: refused. The operator (season authority) is not the gate either.
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    fails(exclude(&mut w, &stranger, &ai.pubkey()), E::NotOperator);
    let op = w.operator.insecure_clone();
    fails(exclude(&mut w, &op, &ai.pubkey()), E::NotOperator);
    let gate = w.gate.insecure_clone();
    exclude(&mut w, &gate, &ai.pubkey()).unwrap();
    exclude(&mut w, &gate, &ai.pubkey()).unwrap(); // repeat: no-op
    fails(pay(&mut w, 0, &ai, &tai), E::OperatorMember);
    assert_eq!(balance(&w, &tai), 2 * FEE, "nothing was taken");
    // Leaving the exclusion account out does not get around it.
    let pool = epool(&w, 0);
    let short = Instruction {
        program_id: w.prize,
        accounts: vec![
            AccountMeta::new_readonly(ai.pubkey(), true),
            AccountMeta::new(ai.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(entry(&w, &pool, &ai.pubkey()), false),
            AccountMeta::new(tai, false),
            AccountMeta::new(vault(&w, &pool), false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: vec![tag::PAY],
    };
    let r = send(&mut w.svm, std::slice::from_ref(&short), &[&ai]);
    assert!(
        r.as_ref()
            .is_err_and(|m| m.contains("NotEnoughAccountKeys")),
        "{r:?}"
    );
    // Naming another wallet's (empty) exclusion address is refused too.
    let mut other = short;
    other.accounts.push(AccountMeta::new_readonly(
        exclusion(&w, &stranger.pubkey()),
        false,
    ));
    fails(send(&mut w.svm, &[other], &[&ai]), E::BadAccount);

    // A wallet that paid first and is marked later cannot claim.
    let (late, tlate) = player(&mut w, FEE);
    let (human, thuman) = player(&mut w, FEE);
    pay(&mut w, 0, &late, &tlate).unwrap();
    pay(&mut w, 0, &human, &thuman).unwrap();
    exclude(&mut w, &gate, &late.pubkey()).unwrap();
    let provinces = set_provinces(&mut w, &holders_1_wins(), E0);
    let cl = set_citizen(&mut w, &late.pubkey(), 1);
    let ch = set_citizen(&mut w, &human.pubkey(), 1);
    set_time(&mut w, at_bell(E0));
    tally(&mut w, 0, &provinces).unwrap();
    finalize(&mut w, 0).unwrap();
    let p = pool.to_bytes();
    let ll = leaf(&p, &late.pubkey().to_bytes(), 1, 1);
    let lh = leaf(&p, &human.pubkey().to_bytes(), 1, 1);
    set_shares(
        &mut w,
        0,
        pool::MODE_SHARES,
        [0, 2, 0, 0, 0, 0],
        node(&ll, &lh),
    )
    .unwrap();
    fails(
        claim(&mut w, 0, &late, &tlate, &cl, 1, 1, &[lh]),
        E::OperatorMember,
    );
    claim(&mut w, 0, &human, &thuman, &ch, 1, 1, &[ll]).unwrap();
    // A season without a join gate has no operator-member key at all.
    let mut d = w.svm.get_account(&w.season).unwrap().data;
    d[S::JOIN_GATE..S::JOIN_GATE + 32].fill(0);
    let k = w.season.to_bytes();
    game_account(&mut w, k, d);
    fails(exclude(&mut w, &gate, &stranger.pubkey()), E::NotOperator);
}

/// Entry per period: a wallet that paid into window 0 only cannot claim
/// from window 1 (no Entry there), even in the winning nation.
#[test]
fn an_entry_counts_for_its_own_window_only() {
    let Some(mut w) = world() else { return };
    init_epoch(&mut w, 0, E0).unwrap();
    init_epoch(&mut w, 1, E1).unwrap();
    let (a, ta) = player(&mut w, 2 * FEE);
    let (b, tb) = player(&mut w, FEE);
    pay(&mut w, 0, &a, &ta).unwrap();
    pay(&mut w, 1, &b, &tb).unwrap();
    let ca = set_citizen(&mut w, &a.pubkey(), 1);
    let provinces = set_provinces(&mut w, &holders_1_wins(), E1);
    set_time(&mut w, at_bell(E1));
    tally(&mut w, 1, &provinces).unwrap();
    finalize(&mut w, 1).unwrap();
    let p1 = epool(&w, 1).to_bytes();
    let la = leaf(&p1, &a.pubkey().to_bytes(), 1, 1);
    let lb = leaf(&p1, &b.pubkey().to_bytes(), 1, 1);
    set_shares(
        &mut w,
        1,
        pool::MODE_SHARES,
        [0, 2, 0, 0, 0, 0],
        node(&la, &lb),
    )
    .unwrap();
    // a's Entry is window 0's: window 1 has none for a.
    let r = claim(&mut w, 1, &a, &ta, &ca, 1, 1, &[lb]);
    assert!(
        r.is_err(),
        "a wallet with no Entry in this window cannot claim from it"
    );
}

/// Prize scope is the ring-17 map: an epoch pool refuses a season whose map
/// may grow past ring 17 (`CeilingPastTally`) or starts past it.
#[test]
fn epoch_pools_refuse_maps_past_ring_17() {
    let Some(mut w) = world() else { return };
    let mut d = w.svm.get_account(&w.season).unwrap().data;
    let at = SEASON_CQ_OFFSET + cq_layout::R_MAX_CEILING;
    d[at..at + 2].copy_from_slice(&18u16.to_le_bytes());
    let k = w.season.to_bytes();
    game_account(&mut w, k, d.clone());
    fails(init_epoch(&mut w, 0, E0), E::CeilingPastTally);
    d[at..at + 2].copy_from_slice(&17u16.to_le_bytes());
    game_account(&mut w, k, d.clone());
    init_epoch(&mut w, 0, E0).unwrap();
    d[S::R_MAX..S::R_MAX + 2].copy_from_slice(&18u16.to_le_bytes());
    game_account(&mut w, k, d);
    fails(init_epoch(&mut w, 1, E1), E::BadParams);
}
