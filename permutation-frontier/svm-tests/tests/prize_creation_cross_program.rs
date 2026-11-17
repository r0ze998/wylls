//! Frontier and the legacy prize binary in one LiteSVM. The Season account
//! is written by Frontier's real Announce/Create/Genesis instructions; the
//! mint is initialized by the real SPL Token program. No test account stands
//! in for the Season whose status controls InitPool.

use frontier_abi::layout::world::season as S;
use frontier_abi::presets::NO_END_BELL;
use frontier_abi::v2::presets::S1_LOCAL_7D;
use permutation_frontier_svm_tests::chain::{expect_lands, max_len_for, Chain};
use permutation_frontier_svm_tests::world::{params_v2_for, World};
use permutation_frontier_svm_tests::{keypair, AccountMeta, Address, Instruction, Keypair, Signer};

const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::new_from_array([0; 32]);
const PRIZE_WRONG_STATE: u32 = 0x104;
const PRIZE_CONTINUOUS_SEASON: u32 = 0x112;

fn deploy_prize(c: &mut Chain) -> Address {
    let path = std::env::var("PRIZE_SO").expect("set PRIZE_SO to the isolated prize .so");
    let so = std::fs::read(path).expect("read prize .so");
    let prize = keypair(b"cross-program-prize").pubkey();
    c.deploy(prize, &so, max_len_for(so.len()), None);
    prize
}

fn mint(c: &mut Chain, authority: &Keypair) -> Address {
    let mint = keypair(b"cross-program-mint");
    let mut create = 0u32.to_le_bytes().to_vec(); // System CreateAccount
    create.extend_from_slice(&c.rent(82).to_le_bytes());
    create.extend_from_slice(&82u64.to_le_bytes());
    create.extend_from_slice(TOKEN.as_ref());
    let mut initialize = vec![20u8, 6]; // SPL Token InitializeMint2, six decimals
    initialize.extend_from_slice(authority.pubkey().as_ref());
    initialize.push(0); // no freeze authority
    expect_lands(
        c.send(
            &[
                Instruction {
                    program_id: SYSTEM,
                    accounts: vec![
                        AccountMeta::new(authority.pubkey(), true),
                        AccountMeta::new(mint.pubkey(), true),
                    ],
                    data: create,
                },
                Instruction {
                    program_id: TOKEN,
                    accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                    data: initialize,
                },
            ],
            &[authority, &mint],
        ),
        "create and initialize test mint",
    );
    mint.pubkey()
}

fn pool_addresses(prize: Address, w: &World) -> (Address, Address) {
    let (pool, _) = Address::find_program_address(
        &[b"pool", w.a.program.as_ref(), &w.id.to_le_bytes()],
        &prize,
    );
    let (vault, _) = Address::find_program_address(&[b"vault", pool.as_ref()], &prize);
    (pool, vault)
}

fn init_pool(prize: Address, mint: Address, w: &World) -> Instruction {
    let (pool, vault) = pool_addresses(prize, w);
    let mut data = vec![0u8]; // Prize InitPool
    data.extend_from_slice(&25_000_000u64.to_le_bytes()); // test-token fee
    data.extend_from_slice(&2_000u16.to_le_bytes()); // operator share
    data.extend_from_slice(&0u16.to_le_bytes()); // expected keeps: display only
    data.extend_from_slice(&[9u8; 32]); // provisional contribution params hash
    Instruction {
        program_id: prize,
        accounts: vec![
            AccountMeta::new(w.authority.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(w.a.season, false),
            AccountMeta::new_readonly(w.a.program, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    }
}

fn prize_refuses(c: &mut Chain, prize: Address, mint: Address, w: &World, code: u32) {
    let (pool, vault) = pool_addresses(prize, w);
    let failed = c
        .send(&[init_pool(prize, mint, w)], &[&w.authority])
        .expect_err("Prize InitPool must refuse");
    assert_eq!(failed.code, Some(code), "{}", failed.logs.join("\n"));
    assert!(failed.failed_in(&prize), "{}", failed.logs.join("\n"));
    assert!(c.is_absent(&pool), "refusal must not create a pool");
    assert!(c.is_absent(&vault), "refusal must not create a vault");
}

#[test]
fn finite_frontier_season_opens_prize_only_after_running() {
    let mut c = Chain::release();
    let prize = deploy_prize(&mut c);
    let params = params_v2_for(&c, S1_LOCAL_7D);
    let w = World::with_v2(&mut c, 38, params);
    let mint = mint(&mut c, &w.authority);

    expect_lands(w.announce(&mut c), "Announce finite world");
    assert_eq!(c.data(&w.a.season)[S::STATUS], S::STATUS_ANNOUNCED);
    prize_refuses(&mut c, prize, mint, &w, PRIZE_WRONG_STATE);

    expect_lands(w.create(&mut c), "Create finite world");
    assert_eq!(c.data(&w.a.season)[S::STATUS], S::STATUS_CREATED);
    prize_refuses(&mut c, prize, mint, &w, PRIZE_WRONG_STATE);

    expect_lands(w.init_logs(&mut c), "InitBeaconLogs");
    for faction in 0..6 {
        expect_lands(w.init_shards(&mut c, faction), "InitShards");
    }
    expect_lands(w.consume_genesis(&mut c), "ConsumeGenesisSeed");
    assert_eq!(c.data(&w.a.season)[S::STATUS], S::STATUS_SEEDED);
    // The fixture publishes the genesis seed at genesis itself. Rewind the
    // test Clock only to exercise the Seeded-but-not-yet-Running guard; a
    // live chain does not run time backwards.
    c.set_time(w.genesis_ts() - 1);
    prize_refuses(&mut c, prize, mint, &w, PRIZE_WRONG_STATE);
    c.set_time(w.genesis_ts());

    let (pool, vault) = pool_addresses(prize, &w);
    expect_lands(
        c.send(&[init_pool(prize, mint, &w)], &[&w.authority]),
        "finite InitPool after effective Running",
    );
    let account = c.account(&pool).expect("new prize pool");
    assert_eq!(account.owner, prize);
    assert_eq!(&account.data[..8], b"WYPRPOOL");
    assert_eq!(c.owner(&vault), Some(TOKEN));
}

#[test]
fn continuous_frontier_season_refuses_legacy_prize_pool() {
    let mut c = Chain::release();
    let prize = deploy_prize(&mut c);
    let mut params = S1_LOCAL_7D;
    params.cq.continuous = 1;
    params.base.end_bell = NO_END_BELL;
    params.base.join_close_bell = NO_END_BELL;
    let params = params_v2_for(&c, params);
    let w = World::with_v2(&mut c, 39, params);
    let mint = mint(&mut c, &w.authority);
    expect_lands(w.announce(&mut c), "Announce continuous world");
    expect_lands(w.create(&mut c), "Create continuous world");
    expect_lands(w.init_logs(&mut c), "InitBeaconLogs");
    for faction in 0..6 {
        expect_lands(w.init_shards(&mut c, faction), "InitShards");
    }
    expect_lands(w.consume_genesis(&mut c), "ConsumeGenesisSeed");
    c.set_time(w.genesis_ts());
    prize_refuses(&mut c, prize, mint, &w, PRIZE_CONTINUOUS_SEASON);
}
