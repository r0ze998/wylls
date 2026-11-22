//! herald-v0v1-decode: the local chain takes, executes, keeps and serves
//! **v0** transactions (with an address lookup table created and extended
//! through the real lookup-table program) and **v1** transactions (SIMD-0385),
//! as a cluster does: `getTransaction` answers their `version` and
//! `meta.loadedAddresses` (and -32015 to a client that did not say it reads
//! that version), the feed carries the looked-up addresses, and a restart
//! from the ledger replays them to the same state.
//!
//! Port: 41651/41652 (loopback; herald-v0v1-decode's range).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use solana_message::{v0, v1, AddressLookupTableAccount, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

use fclient::vtx::{self, Version};
use fclient::{tx, Address, Keypair, Signer};
use localnet::chain::lookup_table_addresses;
use localnet::{server, Chain, Config};

fn funded(c: &mut Chain, n: u8) -> Keypair {
    let k = Keypair::new_from_array([n; 32]);
    c.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

fn alt_create(
    authority: &Address,
    payer: &Address,
    recent_slot: u64,
) -> (Address, fclient::Instruction) {
    localnet::chain::lookup_table_create(authority, payer, recent_slot)
}

fn alt_extend(
    table: &Address,
    authority: &Address,
    payer: &Address,
    new: &[Address],
) -> fclient::Instruction {
    localnet::chain::lookup_table_extend(table, authority, payer, new)
}

/// A System transfer naming one more, readonly, account (the System
/// program ignores accounts past its two).
fn transfer_plus(
    from: &Address,
    to: &Address,
    extra: &Address,
    lamports: u64,
) -> fclient::Instruction {
    let mut ix = tx::transfer(*from, *to, lamports);
    ix.accounts
        .push(fclient::AccountMeta::new_readonly(*extra, false));
    ix
}

fn land(c: &mut Chain, wire: &[u8]) -> fclient::ports::Signature {
    let sig = c.submit(wire).unwrap_or_else(|e| panic!("submit: {e}"));
    for _ in 0..4 {
        c.produce_block();
        if c.transaction(&sig).is_some() {
            return sig;
        }
    }
    panic!("{sig} did not land");
}

fn legacy(
    c: &mut Chain,
    ixs: &[fclient::Instruction],
    signers: &[&Keypair],
) -> fclient::ports::Signature {
    let (bh, _) = c.latest_blockhash();
    let msg = solana_message::Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &bh);
    let t = tx::sign(msg, signers).unwrap();
    land(c, &tx::wire(&t))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v0_with_a_lookup_table_and_v1_land_and_are_served() {
    let dir = std::env::temp_dir().join(format!("hv01-localnet-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cfg = Config {
        data_dir: Some(dir.clone()),
        ..Config::default()
    };
    let mut c = Chain::new(cfg.clone());
    let payer = funded(&mut c, 1);
    let (to_w, to_r, unused) = (
        Address::new_from_array([0x21; 32]),
        Address::new_from_array([0x22; 32]),
        Address::new_from_array([0x23; 32]),
    );
    c.produce_block();
    // 1. a lookup table through the real program: create, extend
    let recent = c.slot() - 1;
    let (table, create) = alt_create(&payer.pubkey(), &payer.pubkey(), recent);
    let s = legacy(&mut c, &[create], &[&payer]);
    assert!(
        c.transaction(&s).unwrap().err.is_none(),
        "{:?}",
        c.transaction(&s).unwrap().logs
    );
    let s = legacy(
        &mut c,
        &[alt_extend(
            &table,
            &payer.pubkey(),
            &payer.pubkey(),
            &[unused, to_w, to_r],
        )],
        &[&payer],
    );
    assert!(
        c.transaction(&s).unwrap().err.is_none(),
        "{:?}",
        c.transaction(&s).unwrap().logs
    );
    c.produce_block();
    let ta = c.svm.get_account(&table).unwrap();
    assert_eq!(
        lookup_table_addresses(&ta, &[1, 2]).unwrap(),
        vec![to_w, to_r]
    );

    // 2. a v0 transfer whose recipient and extra account come from the table
    let (bh, _) = c.latest_blockhash();
    let m = v0::Message::try_compile(
        &payer.pubkey(),
        &[transfer_plus(&payer.pubkey(), &to_w, &to_r, 777_000)],
        &[AddressLookupTableAccount {
            key: table,
            addresses: vec![unused, to_w, to_r],
        }],
        bh,
    )
    .unwrap();
    assert_eq!(
        m.address_table_lookups.len(),
        1,
        "the recipient is looked up"
    );
    let t0 = VersionedTransaction::try_new(VersionedMessage::V0(m), &[&payer]).unwrap();
    let w0 = vtx::wire(&t0).unwrap();
    assert!(tx::from_wire(&w0).is_err());
    let s0 = land(&mut c, &w0);
    let l0 = c.transaction(&s0).unwrap().clone();
    assert!(l0.err.is_none(), "{:?} {:?}", l0.err, l0.logs);
    assert_eq!(c.balance(&to_w), 777_000);
    assert_eq!(l0.loaded.writable, vec![to_w]);
    assert_eq!(l0.loaded.readonly, vec![to_r]);
    assert_eq!(l0.keys[l0.keys.len() - 2..], [to_w, to_r]);
    assert_eq!(l0.pre_balances.len(), l0.keys.len());
    assert!(l0
        .post
        .iter()
        .any(|(k, a)| *k == to_w && a.as_ref().is_some_and(|a| a.lamports == 777_000)));
    assert_eq!(l0.record().loaded, l0.loaded);

    // 3. a v1 transfer (no lookups; compute budget in the config mask)
    let (bh, _) = c.latest_blockhash();
    // (SIMD-0385: an absent CU or loaded-data limit is 0, so a v1 sender states both)
    let m1 = v1::Message::try_compile_with_config(
        &payer.pubkey(),
        &[tx::transfer(payer.pubkey(), to_r, 1_000_000)],
        bh,
        v1::TransactionConfig {
            compute_unit_limit: Some(10_000),
            loaded_accounts_data_size_limit: Some(65_536),
            ..v1::TransactionConfig::empty()
        },
    )
    .unwrap();
    let t1 = VersionedTransaction::try_new(VersionedMessage::V1(m1), &[&payer]).unwrap();
    let w1 = vtx::wire(&t1).unwrap();
    assert_eq!(w1[0], 0x81);
    let s1 = land(&mut c, &w1);
    let l1 = c.transaction(&s1).unwrap().clone();
    assert!(l1.err.is_none(), "{:?} {:?}", l1.err, l1.logs);
    assert_eq!(c.balance(&to_r), 1_000_000);
    assert!(l1.loaded.writable.is_empty() && l1.loaded.readonly.is_empty());

    // 4. a v0 transaction naming a lookup index past the table is refused
    let (bh, _) = c.latest_blockhash();
    let mut bad = v0::Message::try_compile(
        &payer.pubkey(),
        &[tx::transfer(payer.pubkey(), to_w, 1)],
        &[AddressLookupTableAccount {
            key: table,
            addresses: vec![unused, to_w, to_r],
        }],
        bh,
    )
    .unwrap();
    bad.address_table_lookups[0].writable_indexes = vec![9];
    let tb = VersionedTransaction::try_new(VersionedMessage::V0(bad), &[&payer]).unwrap();
    let e = c.submit(&vtx::wire(&tb).unwrap()).unwrap_err().to_string();
    assert!(e.contains("lookup index 9"), "{e}");

    // 5. a restart from the ledger replays both to the same state
    let balances_before = (c.balance(&to_w), c.balance(&to_r));
    let state = c.state_hash();
    drop(c);
    let c = Chain::new(cfg);
    assert_eq!((c.balance(&to_w), c.balance(&to_r)), balances_before);
    assert_eq!(
        c.state_hash(),
        state,
        "the replayed state (SlotHashes included)"
    );
    let r0 = c
        .transaction(&s0)
        .expect("the v0 transaction after a restart");
    assert_eq!(r0.loaded, l0.loaded);
    assert_eq!(r0.keys, l0.keys);
    assert!(c.transaction(&s1).is_some());

    // 6. the RPC (of the restarted node): versions, loadedAddresses, -32015, the feed
    let shared = Arc::new(Mutex::new(c));
    let node = server::start(shared.clone(), 41651).await.unwrap();
    let rpc = fclient::rpc::RpcClient::new(node.url());
    let get = |sig: String, max: Option<u64>| {
        let rpc = &rpc;
        async move {
            let mut cfg = json!({"encoding": "base64", "commitment": "finalized"});
            if let Some(m) = max {
                cfg["maxSupportedTransactionVersion"] = json!(m);
            }
            rpc.call("getTransaction", json!([sig, cfg])).await
        }
    };
    let r = get(s0.to_string(), Some(0)).await.unwrap();
    assert_eq!(r["version"], json!(0));
    assert_eq!(
        r["meta"]["loadedAddresses"],
        json!({"writable": [to_w.to_string()], "readonly": [to_r.to_string()]})
    );
    assert_eq!(
        r["meta"]["preBalances"].as_array().unwrap().len(),
        l0.keys.len()
    );
    let e = get(s0.to_string(), None).await.unwrap_err();
    assert!(
        matches!(e, fclient::ports::PortError::Rpc { code: -32015, .. }),
        "{e:?}"
    );
    let e = get(s1.to_string(), Some(0)).await.unwrap_err();
    assert!(
        matches!(e, fclient::ports::PortError::Rpc { code: -32015, .. }),
        "{e:?}"
    );
    assert_eq!(
        get(s1.to_string(), Some(1)).await.unwrap()["version"],
        json!(1)
    );
    let json_enc = rpc
        .call(
            "getTransaction",
            json!([s0.to_string(), {"encoding": "json", "maxSupportedTransactionVersion": 0}]),
        )
        .await
        .unwrap();
    assert_eq!(
        json_enc["transaction"]["message"]["addressTableLookups"][0]["accountKey"],
        json!(table.to_string())
    );
    // the readers' client: getTransaction → TxRecord with its loaded addresses
    let rec = rpc.get_finalized_transaction(&s0).await.unwrap().unwrap();
    assert_eq!(rec.loaded, l0.loaded);
    assert_eq!(vtx::decode(&rec.tx).unwrap().version, Version::V0);
    let rec1 = rpc.get_finalized_transaction(&s1).await.unwrap().unwrap();
    assert_eq!(vtx::decode(&rec1.tx).unwrap().version, Version::V1);
    // the feed (frontier_feed) carries `loaded` for the v0 record only
    let feed: Value = rpc.call("frontier_feed", json!([0, 100])).await.unwrap();
    let f0 = feed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["signature"] == json!(s0.to_string()))
        .unwrap();
    assert_eq!(f0["loaded"]["writable"], json!([to_w.to_string()]));
    let f1 = feed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["signature"] == json!(s1.to_string()))
        .unwrap();
    assert!(f1.get("loaded").is_none());
    let parsed = fclient::rpc::parse_feed_record(f0).unwrap();
    assert_eq!(parsed.loaded, l0.loaded);
    // getSignaturesForAddress finds the v0 transaction by a looked-up key
    let sigs = rpc
        .call("getSignaturesForAddress", json!([to_r.to_string()]))
        .await
        .unwrap();
    assert!(sigs
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["signature"] == json!(s0.to_string())));
    node.stop();
    drop(shared);
    let _ = std::fs::remove_dir_all(&dir);
}
