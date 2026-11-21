//! B5 (read-only devnet run, 2026-11-21): `input::program_accounts` asks
//! the node to filter (`memcmp` on the season id at offset 8) and to slice
//! (8 bytes) instead of downloading every program account's whole data,
//! every season's, to filter them here. Checked against the local node
//! (which serves `memcmp`/`dataSlice`, as devnet does): the same set as
//! the old client-side filter. In-memory chain, port 0, no key.

use fclient::ports::Account;
use solana_address::Address;

fn acct(program: Address, data: Vec<u8>) -> Account {
    Account {
        lamports: 1_000_000,
        data,
        owner: program,
        executable: false,
    }
}

fn header(season: u64, len: usize) -> Vec<u8> {
    let mut d = vec![0xAB; len];
    if len >= 16 {
        d[8..16].copy_from_slice(&season.to_le_bytes());
    }
    d
}

#[tokio::test]
async fn program_accounts_are_filtered_by_the_node() {
    let program = Address::new_from_array([0x45; 32]);
    let other = Address::new_from_array([0x46; 32]);
    let mut c = localnet::Chain::new(localnet::Config {
        data_dir: None,
        ..localnet::Config::default()
    });
    let k = |i: u8| Address::new_from_array([i; 32]);
    // Season 7: two accounts (one long); season 8; one too short to hold
    // a header; one of season 7's layout owned by another program.
    c.set_account(k(1), acct(program, header(7, 64))).unwrap();
    c.set_account(k(2), acct(program, header(7, 4_000)))
        .unwrap();
    c.set_account(k(3), acct(program, header(8, 64))).unwrap();
    c.set_account(k(4), acct(program, vec![7; 12])).unwrap();
    c.set_account(k(5), acct(other, header(7, 64))).unwrap();
    let state = std::sync::Arc::new(std::sync::Mutex::new(c));
    let node = localnet::server::start(state, 0).await.unwrap();
    let mut got = verify_core::input::program_accounts(&node.url(), &program, 7)
        .await
        .unwrap();
    got.sort();
    assert_eq!(got, vec![k(1), k(2)]);
    let got8 = verify_core::input::program_accounts(&node.url(), &program, 8)
        .await
        .unwrap();
    assert_eq!(got8, vec![k(3)]);
    assert!(
        verify_core::input::program_accounts(&node.url(), &program, 9)
            .await
            .unwrap()
            .is_empty()
    );
}
