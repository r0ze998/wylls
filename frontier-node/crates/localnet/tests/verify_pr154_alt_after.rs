//! verify-pr154: a landed v0 transaction keeps the addresses its lookups
//! resolved to WHEN IT RAN, even after its table is extended and then
//! deactivated: the chain's record, `getTransaction`'s `meta.loadedAddresses`
//! (and a restart from the ledger) still name the old addresses, and
//! `fclient::vtx` decodes it from the record's own loaded addresses. A record
//! whose loaded addresses do not match the wire's lookups is refused
//! (`check_loaded`), and a garbage / unknown-version wire is an error, never
//! a panic.
//!
//! Port: 41655 (loopback; verify-pr154's range 41650–41699).

use std::sync::{Arc, Mutex};

use serde_json::json;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

use fclient::vtx::{self, LoadedAddresses};
use fclient::{tx, Address, Keypair, Signer};
use localnet::chain::{lookup_table_create, lookup_table_extend, lookup_table_program};
use localnet::{server, Chain, Config};

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

fn legacy(c: &mut Chain, ixs: &[fclient::Instruction], k: &Keypair) -> fclient::ports::Signature {
    let (bh, _) = c.latest_blockhash();
    let msg = solana_message::Message::new_with_blockhash(ixs, Some(&k.pubkey()), &bh);
    let t = tx::sign(msg, &[k]).unwrap();
    let s = land(c, &tx::wire(&t));
    let l = c.transaction(&s).unwrap();
    assert!(l.err.is_none(), "{:?} {:?}", l.err, l.logs);
    s
}

/// `DeactivateLookupTable` (the program's instruction 3).
fn deactivate(table: &Address, authority: &Address) -> fclient::Instruction {
    fclient::Instruction {
        program_id: lookup_table_program(),
        accounts: vec![
            fclient::AccountMeta::new(*table, false),
            fclient::AccountMeta::new_readonly(*authority, true),
        ],
        data: 3u32.to_le_bytes().to_vec(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_v0_record_keeps_its_loaded_addresses_after_the_table_changes() {
    let dir = std::env::temp_dir().join(format!("vpr154-alt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cfg = Config {
        data_dir: Some(dir.clone()),
        ..Config::default()
    };
    let mut c = Chain::new(cfg.clone());
    let payer = Keypair::new_from_array([7; 32]);
    c.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let (w, r, x) = (
        Address::new_from_array([0x31; 32]),
        Address::new_from_array([0x32; 32]),
        Address::new_from_array([0x33; 32]),
    );
    c.produce_block();
    let (table, create) = lookup_table_create(&payer.pubkey(), &payer.pubkey(), c.slot() - 1);
    legacy(&mut c, &[create], &payer);
    legacy(
        &mut c,
        &[lookup_table_extend(
            &table,
            &payer.pubkey(),
            &payer.pubkey(),
            &[w, r],
        )],
        &payer,
    );
    c.produce_block();

    // the v0 transfer: w (writable) and r (readonly) come from the table
    let (bh, _) = c.latest_blockhash();
    let mut ix = tx::transfer(payer.pubkey(), w, 1_000_000);
    ix.accounts
        .push(fclient::AccountMeta::new_readonly(r, false));
    let m = v0::Message::try_compile(
        &payer.pubkey(),
        &[ix],
        &[AddressLookupTableAccount {
            key: table,
            addresses: vec![w, r],
        }],
        bh,
    )
    .unwrap();
    let t = VersionedTransaction::try_new(VersionedMessage::V0(m), &[&payer]).unwrap();
    let wire = vtx::wire(&t).unwrap();
    let s = land(&mut c, &wire);
    let before = c.transaction(&s).unwrap().clone();
    assert!(before.err.is_none(), "{:?} {:?}", before.err, before.logs);
    assert_eq!(before.loaded.writable, vec![w]);
    assert_eq!(before.loaded.readonly, vec![r]);

    // the table changes afterwards: extended, then deactivated
    legacy(
        &mut c,
        &[lookup_table_extend(
            &table,
            &payer.pubkey(),
            &payer.pubkey(),
            &[x],
        )],
        &payer,
    );
    let s_legacy = legacy(&mut c, &[deactivate(&table, &payer.pubkey())], &payer);
    for _ in 0..3 {
        c.produce_block();
    }
    assert_eq!(c.transaction(&s).unwrap().loaded, before.loaded);
    let state = c.state_hash();
    drop(c);
    let c = Chain::new(cfg);
    assert_eq!(
        c.state_hash(),
        state,
        "restart replays the table changes too"
    );
    assert_eq!(c.transaction(&s).unwrap().loaded, before.loaded);
    assert_eq!(c.transaction(&s).unwrap().keys, before.keys);

    // served: the record's own loaded addresses
    let shared = Arc::new(Mutex::new(c));
    let node = server::start(shared.clone(), 41655).await.unwrap();
    let rpc = fclient::rpc::RpcClient::new(node.url());
    let got = rpc
        .call(
            "getTransaction",
            json!([s.to_string(), {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 0}]),
        )
        .await
        .unwrap();
    assert_eq!(
        got["meta"]["loadedAddresses"],
        json!({"writable": [w.to_string()], "readonly": [r.to_string()]})
    );
    let rec = rpc.get_finalized_transaction(&s).await.unwrap().unwrap();
    assert_eq!(rec.loaded, before.loaded);
    let d = vtx::decode(&rec.tx).unwrap();
    d.check_loaded(&rec.loaded).unwrap();
    assert_eq!(d.keys(&rec.loaded).unwrap()[d.static_keys.len()..], [w, r]);
    // a legacy tx is still served to a client that names no version
    let lg = rpc
        .call(
            "getTransaction",
            json!([s_legacy.to_string(), {"encoding": "base64", "commitment": "finalized"}]),
        )
        .await
        .unwrap();
    assert_eq!(lg["version"], json!("legacy"));
    assert_eq!(
        lg["meta"]["loadedAddresses"],
        json!({"writable": [], "readonly": []})
    );
    node.stop();
    drop(shared);

    // a record whose loaded addresses do not match the wire's lookups
    for bad in [
        LoadedAddresses::default(),
        LoadedAddresses {
            writable: vec![w, x],
            readonly: vec![r],
        },
        LoadedAddresses {
            writable: vec![r],
            readonly: vec![w, x],
        },
        LoadedAddresses {
            writable: vec![],
            readonly: vec![w, r],
        },
    ] {
        assert!(d.check_loaded(&bad).is_err(), "{bad:?} accepted");
    }
    // garbage: truncations, unknown versions, trailing bytes — errors, never panics
    for n in 0..wire.len() {
        assert!(vtx::decode(&wire[..n]).is_err(), "truncated at {n} decoded");
    }
    for p in 0x82u8..=0xff {
        let mut v = wire.clone();
        // the message prefix sits after the 1-byte short-vec count + 64-byte signature
        v[65] = p;
        assert!(vtx::decode(&v).is_err(), "prefix {p:#x} decoded");
    }
    let mut long = wire.clone();
    long.push(0);
    assert!(vtx::decode(&long).is_err(), "trailing byte accepted");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A signed transaction whose program / account index is past its keys is
/// refused at admission (legacy and v0), never a panic under the chain lock.
#[test]
fn an_unsanitized_index_is_refused_not_a_panic() {
    let mut c = Chain::new(Config::default());
    let payer = Keypair::new_from_array([8; 32]);
    c.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    c.produce_block();
    let (bh, _) = c.latest_blockhash();
    let to = Address::new_from_array([0x41; 32]);
    for which in ["program", "account"] {
        let mut m = solana_message::Message::new_with_blockhash(
            &[tx::transfer(payer.pubkey(), to, 1_000_000)],
            Some(&payer.pubkey()),
            &bh,
        );
        match which {
            "program" => m.instructions[0].program_id_index = 200,
            _ => m.instructions[0].accounts[1] = 200,
        }
        let t = tx::sign(m.clone(), &[&payer]).unwrap();
        let e = c.submit(&tx::wire(&t)).unwrap_err().to_string();
        assert!(e.contains("sanitize"), "{which}: {e}");
        let e = c
            .simulate(&tx::wire(&t), true)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(e.contains("sanitize"), "{which} simulate: {e}");
        let v0m = v0::Message {
            header: m.header,
            account_keys: m.account_keys.clone(),
            recent_blockhash: bh,
            instructions: m.instructions.clone(),
            address_table_lookups: vec![],
        };
        let tv = VersionedTransaction::try_new(VersionedMessage::V0(v0m), &[&payer]).unwrap();
        let e = c.submit(&vtx::wire(&tv).unwrap()).unwrap_err().to_string();
        assert!(e.contains("sanitize"), "v0 {which}: {e}");
    }
    c.produce_block();
    assert_eq!(c.balance(&to), 0);
}
