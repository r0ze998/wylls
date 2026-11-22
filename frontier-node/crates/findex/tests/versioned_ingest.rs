//! herald-v0v1-decode: findex over a node that serves **v0** (lookup-table)
//! and **v1** transactions, as devnet does (B5, 2026-11-21). The devnet
//! ingest (`Enriched` over `RpcPoll`: no post-state from the node) fetches
//! the written accounts of both — for the v0 one the looked-up writable
//! address from `meta.loadedAddresses` — archives the looked-up addresses
//! with the record, and the archive and the index read them back. The
//! LocalnetFeed (the local node's own feed) carries them too.
//!
//! Port: 41653 (loopback; herald-v0v1-decode's range).

use std::path::PathBuf;

use solana_message::{v0, v1, AddressLookupTableAccount, VersionedMessage};

use fclient::ports::ChainPort;
use fclient::vtx::{self, Version, VersionedTransaction};
use fclient::{tx, Address, Keypair, Signer};
use findex::{Findex, LocalnetFeed, RpcPoll};
use localnet::chain::{lookup_table_create, lookup_table_extend};
use localnet::{server, Config, InProcess};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("findex-hv01-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

async fn land(ip: &InProcess, wire: &[u8]) -> fclient::ports::Signature {
    let sig = ip
        .send(wire)
        .await
        .unwrap_or_else(|e| panic!("send: {e:?}"));
    for _ in 0..4 {
        ip.step(1);
        if let Some(l) = ip.lock().transaction(&sig) {
            assert!(l.err.is_none(), "{:?} {:?}", l.err, l.logs);
            return sig;
        }
    }
    panic!("{sig} did not land");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enriched_rpc_poll_archives_v0_and_v1_post_state() {
    let ip = InProcess::new(Config::default(), None);
    let payer = Keypair::new_from_array([61; 32]);
    let to = Address::new_from_array([62; 32]);
    let extra = Address::new_from_array([63; 32]);
    ip.lock().airdrop(&payer.pubkey(), 50_000_000_000).unwrap();
    ip.step(1);
    // a lookup table holding the recipient (writable use) and one more (readonly use)
    let recent = ip.lock().slot() - 1;
    let (table, create) = lookup_table_create(&payer.pubkey(), &payer.pubkey(), recent);
    let extend = lookup_table_extend(&table, &payer.pubkey(), &payer.pubkey(), &[to, extra]);
    let (bh, _) = ip.blockhash().await.unwrap();
    let t = tx::sign(
        solana_message::Message::new_with_blockhash(&[create, extend], Some(&payer.pubkey()), &bh),
        &[&payer],
    )
    .unwrap();
    land(&ip, &tx::wire(&t)).await;
    ip.step(1);

    // v0: payer → `to`, both `to` and `extra` looked up
    let (bh, _) = ip.blockhash().await.unwrap();
    let mut ix = tx::transfer(payer.pubkey(), to, 2_000_000);
    ix.accounts
        .push(fclient::AccountMeta::new_readonly(extra, false));
    let m = v0::Message::try_compile(
        &payer.pubkey(),
        &[ix],
        &[AddressLookupTableAccount {
            key: table,
            addresses: vec![to, extra],
        }],
        bh,
    )
    .unwrap();
    let w0 = vtx::wire(&VersionedTransaction::try_new(VersionedMessage::V0(m), &[&payer]).unwrap())
        .unwrap();
    let s0 = land(&ip, &w0).await;
    // v1: payer → `to` (static keys; budget in the config mask)
    let (bh, _) = ip.blockhash().await.unwrap();
    let m = v1::Message::try_compile_with_config(
        &payer.pubkey(),
        &[tx::transfer(payer.pubkey(), to, 3_000_000)],
        bh,
        v1::TransactionConfig {
            compute_unit_limit: Some(10_000),
            loaded_accounts_data_size_limit: Some(1 << 20),
            ..v1::TransactionConfig::empty()
        },
    )
    .unwrap();
    let w1 = vtx::wire(&VersionedTransaction::try_new(VersionedMessage::V1(m), &[&payer]).unwrap())
        .unwrap();
    let s1 = land(&ip, &w1).await;
    let final_to = ip.lock().balance(&to);
    assert_eq!(final_to, 5_000_000);

    // the devnet ingest: RpcPoll (listed by `to`, a looked-up key in s0) + Enriched
    let node = server::start(ip.chain.clone(), 41653).await.unwrap();
    let d = tmp("enriched");
    let mut fx = Findex::open(&d, fclient::addr::system_program(), None, 1 << 20).unwrap();
    let mut src = findex::Enriched::new(
        RpcPoll::new(node.url(), to),
        node.url(),
        fclient::addr::system_program(),
    );
    let got = fx.ingest(&mut src).await.unwrap();
    assert_eq!(
        got.iter().map(|r| r.signature).collect::<Vec<_>>(),
        vec![s0, s1],
        "both, oldest first (the v0 one found by its looked-up key)"
    );
    let (r0, r1) = (&got[0], &got[1]);
    assert_eq!(vtx::decode(&r0.tx).unwrap().version, Version::V0);
    assert_eq!(vtx::decode(&r1.tx).unwrap().version, Version::V1);
    assert_eq!(r0.loaded.writable, vec![to]);
    assert_eq!(r0.loaded.readonly, vec![extra]);
    assert!(r1.loaded.writable.is_empty() && r1.loaded.readonly.is_empty());
    for r in [r0, r1] {
        assert_eq!(r.post.len(), 1, "the recipient only: {:?}", r.post);
        assert_eq!(r.post[0].0, to);
        assert!(r.post[0].1.as_ref().unwrap().lamports >= 2_000_000);
    }
    // the writable keys a reader names, per version
    assert_eq!(src.writable_keys(&r0.tx, &r0.loaded), vec![to]);
    assert!(
        src.writable_keys(&r0.tx, &Default::default()).is_empty(),
        "unresolved lookups name nothing (the herald alarms on them)"
    );
    assert_eq!(src.writable_keys(&r1.tx, &r1.loaded), vec![to]);
    fx.commit().unwrap();
    // the archive keeps the looked-up addresses (and only on the v0 record)
    let back = fx.archive.read_after(0).unwrap();
    assert_eq!(back[0].loaded, r0.loaded);
    assert_eq!(back[1].loaded, r1.loaded);
    let j0 = findex::archive::record_to_json(&back[0]);
    let j1 = findex::archive::record_to_json(&back[1]);
    assert!(j0.get("loaded").is_some() && j1.get("loaded").is_none());
    assert_eq!(findex::archive::record_from_json(&j0).unwrap(), back[0]);
    assert_eq!(fx.archive.verify(), Ok(2));
    node.stop();

    // the local node's own feed carries them as well
    let feed_port = InProcess::from_chain(ip.chain.clone(), Some(to));
    let mut feed = LocalnetFeed::new(feed_port);
    let d2 = tmp("feed");
    let mut f2 = Findex::open(&d2, fclient::addr::system_program(), None, 1 << 20).unwrap();
    let got2 = f2.ingest(&mut feed).await.unwrap();
    assert_eq!(got2.len(), 2);
    assert_eq!(got2[0].loaded, r0.loaded);
    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::remove_dir_all(&d2);
}
