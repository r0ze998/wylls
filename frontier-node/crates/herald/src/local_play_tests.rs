//! Synthetic public bytes of the runner's first world (the same layout as
//! `itest::expedition_play::Fixture`), checked, seeded and read back through
//! the herald's own views. No RPC, key or chain.
use super::*;
use crate::fold::FoldCfg;
use frontier_abi::addr::host_id;
use frontier_abi::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::world::frontier as FR;
use frontier_abi::layout::{
    header,
    player::{citizen as C1, holding_ref as HR},
    province::entry as E,
};
use frontier_abi::v2::layout::{
    player::{citizen as C, holding as H},
    province::province as P,
    world::season as S,
};
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord};

const SID: u64 = 11;
const RPC: &str = "http://127.0.0.1:41901";
/// A stand-in ELF for the ProgramData digest check (no execution here).
const ELF: &[u8] = b"\x7fELF stand-in bytes of the artifact";

fn program() -> Address {
    Address::new_from_array(PROGRAM)
}
fn wallet() -> Address {
    Address::new_from_array([7; 32])
}
fn hdr(size: usize, magic: [u8; 8]) -> Vec<u8> {
    let mut d = vec![0; size];
    assert!(wr_arr(&mut d, header::MAGIC, &magic));
    assert!(wr_u64(&mut d, header::SEASON_ID, SID));
    assert!(wr_u16(&mut d, header::LAYOUT_VERSION, 2));
    d
}

struct World {
    e: Expected,
    snap: Snapshot,
}
fn world() -> World {
    let ctx = findex::addr_ctx(&program(), SID);
    let (season, bump) = fclient::addr::season_pda(&program(), SID);
    let citizen = Address::new_from_array(ctx.citizen(&wallet().to_bytes()));
    let holding = Address::new_from_array(ctx.holding(128, 0, 1));
    let home = Address::new_from_array(ctx.province(128, 0));
    let frontier = Address::new_from_array(ctx.frontier());
    let ring_seed = Address::new_from_array(ctx.ring_seed(128));
    let qn = fclient::beacon::quicknet_info();
    let mut s = hdr(S::SIZE, S::MAGIC);
    s[S::STATUS] = S::STATUS_RUNNING;
    s[S::BUMP] = bump;
    assert!(wr_u16(&mut s, S::PROGRAM_VERSION, PROGRAM_VERSION));
    assert!(wr_arr(&mut s, S::RULESET_HASH, &LANE_RULESET_HASH));
    s[S::NETWORK] = S::NETWORK_QUICKNET;
    assert!(wr_arr(
        &mut s,
        S::QUICKNET_PK_HASH,
        &<[u8; 32]>::from(sha2::Sha256::digest(qn.public_key))
    ));
    assert!(wr_arr(
        &mut s,
        S::DRAND_GENESIS,
        &qn.genesis_time.to_le_bytes()
    ));
    assert!(wr_u32(&mut s, S::DRAND_PERIOD, qn.period));
    assert!(wr_u32(&mut s, S::REVEAL_WINDOW, 600));
    assert!(wr_u32(&mut s, S::SEED_MARGIN, 60));
    assert!(wr_u16(&mut s, S::R_MAX, 128));
    assert!(wr_arr(
        &mut s,
        S::GENESIS_TS,
        &1_785_542_400i64.to_le_bytes()
    ));
    assert!(wr_u32(&mut s, S::BELL_SECS, 600));
    assert!(wr_u32(&mut s, S::END_BELL, 1008));
    let mut h = hdr(H::SIZE, H::MAGIC);
    assert!(wr_i16(&mut h, H::P, 128));
    h[H::SITE] = 1;
    h[H::GEN] = 2;
    h[H::STATE] = H::STATE_FINAL;
    h[H::ORDER] = 1;
    assert!(wr_arr(&mut h, H::OWNER_CITIZEN, &citizen.to_bytes()));
    assert!(wr_u32(&mut h, H::HOST_SEQ, 1));
    let coord = ProvinceCoord::new(128, 0);
    let mut pv = hdr(P::SIZE, P::MAGIC);
    assert!(wr_i16(&mut pv, P::P, 128));
    assert!(wr_u16(&mut pv, P::RING, 128));
    pv[P::WEDGE] = coord.wedge().unwrap();
    pv[P::REGION] = region_of(coord);
    assert!(wr_u32(&mut pv, P::RESOLVED_NEXT, 10));
    let entry = Entry {
        id: host_id(128, 0, 1, 2, 0).unwrap(),
        unit: 2,
        state: E::STATE_ROSTER,
        troops: 12_000,
        stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
        op: EntryOp::None,
        ..Entry::FREE
    };
    write_entry(&mut pv, 0, &entry).unwrap();
    pv[P::N_ENTRIES] = 1;
    let mut c = hdr(C::SIZE, C::MAGIC);
    assert!(wr_arr(&mut c, C::WALLET, &wallet().to_bytes()));
    assert!(wr_u32(&mut c, C1::BUCKET_MILLI, 5_000));
    let slot = C::holding_of_slot(1);
    assert!(wr_i16(&mut c, slot + HR::P, 128));
    c[slot + HR::SITE] = 1;
    c[slot + HR::GEN] = 2;
    let mut fr = vec![0u8; K2::Frontier.size()];
    assert!(write_header(&mut fr, K2::Frontier, SID));
    assert!(wr_u16(&mut fr, FR::RINGS_OPENED, 129));
    assert!(wr_u32(&mut fr, FR::PROVINCES_OPENED, 1));
    let mut rs = vec![0u8; K2::RingSeed.size()];
    assert!(write_header(&mut rs, K2::RingSeed, SID));
    assert!(wr_u16(&mut rs, RS::D, 128));
    rs[RS::STATUS] = RS::STATUS_SEEDED;
    let read = |data: Vec<u8>| {
        Some(Read {
            owner: program(),
            executable: false,
            data,
        })
    };
    let loader: Address = fclient::abi::LOADER_V3.parse().unwrap();
    let pd_key = fclient::addr::programdata(&program());
    let mut prog = 2u32.to_le_bytes().to_vec();
    prog.extend_from_slice(&pd_key.to_bytes());
    let mut pd = vec![0u8; 45 + ELF.len() + 100];
    pd[..4].copy_from_slice(&3u32.to_le_bytes());
    pd[45..45 + ELF.len()].copy_from_slice(ELF);
    World {
        e: Expected {
            program: program(),
            season_id: SID,
            season,
            wallet: wallet(),
            citizen,
            holding,
            home,
            frontier,
            ring_seed,
            artifact_sha256: hex::encode(sha2::Sha256::digest(ELF)),
            artifact_len: ELF.len(),
        },
        snap: Snapshot {
            context_slot: 42,
            program: Some(Read {
                owner: loader,
                executable: true,
                data: prog,
            }),
            programdata: Some(Read {
                owner: loader,
                executable: false,
                data: pd,
            }),
            accounts: [
                (season, read(s)),
                (citizen, read(c)),
                (holding, read(h)),
                (home, read(pv)),
                (frontier, read(fr)),
                (ring_seed, read(rs)),
            ],
        },
    }
}
fn metadata(w: &World) -> Value {
    json!({"schema": METADATA_SCHEMA, "rpc_url": RPC, "program": w.e.program.to_string(), "program_version": format!("0x{PROGRAM_VERSION:04x}"),
        "season": w.e.season.to_string(), "season_id": SID, "player_wallet": w.e.wallet.to_string(),
        "artifact": {"sha256": w.e.artifact_sha256, "bytes": w.e.artifact_len},
        "accounts": {"citizen": w.e.citizen.to_string(), "holding": w.e.holding.to_string(), "home_province": w.e.home.to_string(),
            "frontier": w.e.frontier.to_string(), "ring_seed": w.e.ring_seed.to_string()}})
}

/// A new directory this test owns (never an existing path).
fn scratch() -> std::path::PathBuf {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    for i in 0..1000 {
        let d =
            std::env::temp_dir().join(format!("herald-local-play-{}-{n}-{i}", std::process::id()));
        if std::fs::create_dir(&d).is_ok() {
            return d;
        }
    }
    panic!("no fresh directory")
}
fn fold(dir: &std::path::Path, program: Address) -> Fold {
    let cfg = FoldCfg {
        program,
        season_id: SID,
        builder: std::sync::Arc::new(crate::clash::Provisional),
        exact_post: true,
    };
    Fold::new(cfg, crate::files::Out::new(dir.join("files")))
}

#[test]
fn metadata_must_name_this_herald_s_program_season_and_rpc() {
    let w = world();
    let m = metadata(&w);
    assert_eq!(expected(&m.to_string(), &program(), SID, RPC).unwrap(), w.e);
    assert!(expected(&m.to_string(), &program(), 12, RPC).is_err());
    assert!(expected(&m.to_string(), &program(), SID, "http://127.0.0.1:41902").is_err());
    assert!(expected(
        &m.to_string(),
        &Address::new_from_array([0x44; 32]),
        SID,
        RPC
    )
    .is_err());
    for (k, v) in [
        ("schema", json!("x")),
        ("program_version", json!("0x4004")),
        (
            "program",
            json!(Address::new_from_array([0x44; 32]).to_string()),
        ),
    ] {
        let mut bad = m.clone();
        bad[k] = v;
        assert!(
            expected(&bad.to_string(), &program(), SID, RPC).is_err(),
            "{k}"
        );
    }
}

#[test]
fn every_identity_and_binding_is_checked() {
    let w = world();
    check(&w.e, &w.snap).unwrap();
    type Tamper = fn(&mut World);
    let cases: [(&str, Tamper); 25] = [
        // the RingSeed provenance is exactly the synthetic zero seed, round 0
        ("ring seed nonzero seed", |w| {
            w.snap.accounts[5].1.as_mut().unwrap().data[RS::SEED + 7] = 1
        }),
        ("ring seed nonzero round", |w| {
            w.snap.accounts[5].1.as_mut().unwrap().data[RS::ROUND] = 1
        }),
        // the beacon and the map
        ("not quicknet", |w| {
            w.snap.accounts[0].1.as_mut().unwrap().data[S::NETWORK] = 0
        }),
        ("pk hash", |w| {
            w.snap.accounts[0].1.as_mut().unwrap().data[S::QUICKNET_PK_HASH] ^= 1
        }),
        ("drand period", |w| {
            let d = &mut w.snap.accounts[0].1.as_mut().unwrap().data;
            assert!(wr_u32(d, S::DRAND_PERIOD, 30));
        }),
        ("home ring not opened", |w| {
            let d = &mut w.snap.accounts[4].1.as_mut().unwrap().data;
            assert!(wr_u16(d, FR::RINGS_OPENED, 128));
        }),
        ("ring seed requested only", |w| {
            w.snap.accounts[5].1.as_mut().unwrap().data[RS::STATUS] = RS::STATUS_REQUESTED
        }),
        ("province region", |w| {
            w.snap.accounts[3].1.as_mut().unwrap().data[P::REGION] ^= 1
        }),
        ("frontier and ring seed swapped", |w| {
            w.snap.accounts.swap(4, 5)
        }),
        // keys: replaced, reordered, repeated
        ("key replaced", |w| {
            w.snap.accounts[2].0 = Address::new_from_array([9; 32])
        }),
        ("keys reordered", |w| w.snap.accounts.swap(1, 2)),
        ("key repeated", |w| {
            w.snap.accounts[3] = w.snap.accounts[2].clone();
        }),
        // the artifact
        ("another ELF", |w| {
            w.snap.programdata.as_mut().unwrap().data[46] ^= 1
        }),
        ("bytes after the ELF", |w| {
            let d = &mut w.snap.programdata.as_mut().unwrap().data;
            let n = d.len();
            d[n - 1] = 1;
        }),
        ("no ProgramData", |w| w.snap.programdata = None),
        ("ruleset", |w| {
            w.snap.accounts[0].1.as_mut().unwrap().data[S::RULESET_HASH] ^= 1
        }),
        ("program not deployed", |w| w.snap.program = None),
        ("foreign owner", |w| {
            w.snap.accounts[1].1.as_mut().unwrap().owner = Address::new_from_array([3; 32])
        }),
        ("executable data", |w| {
            w.snap.accounts[2].1.as_mut().unwrap().executable = true
        }),
        ("absent holding", |w| w.snap.accounts[2].1 = None),
        ("program version", |w| {
            let d = &mut w.snap.accounts[0].1.as_mut().unwrap().data;
            assert!(wr_u16(d, S::PROGRAM_VERSION, 0x4004));
        }),
        ("another wallet", |w| {
            w.snap.accounts[1].1.as_mut().unwrap().data[C::WALLET] ^= 1
        }),
        ("holding owner", |w| {
            w.snap.accounts[2].1.as_mut().unwrap().data[H::OWNER_CITIZEN] ^= 1
        }),
        ("unbound slot", |w| {
            let s = C::holding_of_slot(1);
            w.snap.accounts[1].1.as_mut().unwrap().data[s + HR::GEN] = 3;
        }),
        ("layout", |w| {
            w.snap.accounts[3].1.as_mut().unwrap().data[16] = 1
        }),
    ];
    for (name, t) in cases {
        let mut w = world();
        t(&mut w);
        assert!(check(&w.e, &w.snap).is_err(), "{name}");
        // and nothing is seeded from it
        let dir = scratch();
        let mut f = fold(&dir, program());
        assert!(seed(&mut f, &w.e, &w.snap).is_err(), "{name}");
        assert!(f.st.accounts.is_empty(), "{name}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn rpc_and_listen_must_be_plain_loopback_on_an_allowed_port() {
    assert_eq!(loopback_rpc("http://127.0.0.1:41901"), Ok(41901));
    for bad in [
        "http://127.0.0.1:41970",
        "http://127.0.0.1:8899",
        "http://127.0.0.1:0",
        "https://127.0.0.1:41901",
        "http://user@127.0.0.1:41901",
        "http://127.0.0.1:41901/",
        "http://127.0.0.1:41901?x=1",
        "http://127.0.0.1:41901#f",
        "http://127.0.0.1:041901",
        "http://localhost:41901",
        "http://127.0.0.2:41901",
        "http://127.0.0.1:41901@evil:1",
    ] {
        assert!(loopback_rpc(bad).is_err(), "{bad}");
    }
    assert_eq!(loopback_listen("127.0.0.1:41902"), Ok(41902));
    for bad in [
        "127.0.0.1:41970",
        "0.0.0.0:41902",
        "[::1]:41902",
        "127.0.0.1:0",
        "127.0.0.1:80",
        "localhost:41902",
        "127.0.0.1:041902",
    ] {
        assert!(loopback_listen(bad).is_err(), "{bad}");
    }
}

#[test]
fn seeded_accounts_reach_season_me_hosts_and_world_views() {
    let w = world();
    let dir = scratch();
    let mut f = fold(&dir, program());
    let provenance = seed(&mut f, &w.e, &w.snap).unwrap();
    assert!(provenance["source"]
        .as_str()
        .unwrap()
        .contains("synthetic account snapshot"));
    assert_eq!(f.st.events, 0, "no event is fabricated");
    assert_eq!(f.st.folded_through, 0, "no transaction is fabricated");
    // the fold's slot watermark is the snapshot's context slot: no capture it serves is ahead of it
    assert_eq!(
        f.st.last_slot, w.snap.context_slot,
        "the state is as of the context slot"
    );
    assert!(
        f.st.accounts
            .values()
            .all(|c| c.slot <= f.st.last_slot && c.tx <= f.st.folded_through),
        "every capture is within the snapshot's bounds"
    );
    let st = crate::views::SeasonStatic {
        cluster: "localnet".into(),
        drand: fclient::beacon::quicknet_info(),
        quotas: json!({}),
    };
    let season = crate::views::season_json(&f, &st).expect("/h/season answers");
    assert!(
        season.to_string().contains(&w.e.season.to_string()),
        "{season}"
    );
    let me = crate::views::me_json(&f, &wallet(), Value::Null);
    let text = me.to_string();
    assert!(text.contains(&w.e.holding.to_string()), "{me}");
    assert!(
        !me["hosts"].as_array().map(|h| h.is_empty()).unwrap_or(true),
        "the roster host appears: {me}"
    );
    assert!(f.provinces.contains_key(&(128, 0)));
    // the map: /h/world and the ring's live roster/overview answer from it
    let wj = crate::world::world_json(&f).expect("/h/world answers");
    assert_eq!(
        (
            wj["season"].as_str(),
            wj["provinces"].as_u64(),
            wj["ringsOpened"].as_u64(),
            wj["rMax"].as_u64()
        ),
        (Some("11"), Some(1), Some(129), Some(128)),
        "{wj}"
    );
    // rings below the home ring are opened by the Frontier but have no
    // RingSeed or Province: shown as such, nothing invented
    let rings = wj["rings"].as_array().unwrap();
    assert_eq!(rings[127]["seed"], "absent");
    assert_eq!(rings[127]["provinces"], 0);
    assert_eq!(rings[128]["seed"], "seeded");
    assert_eq!(rings[128]["provinces"], 1);
    let r128 = crate::world::ring_json(&f, 128).expect("/h/world/ring/128 answers");
    assert_eq!(r128["provinces"][0]["p"], 128, "{r128}");
    assert!(
        crate::world::ring_json(&f, 129).is_none(),
        "beyond ringsOpened"
    );
    let ring = f.provinces[&(128, 0)].ring;
    assert_eq!(ring, 128);
    assert!(
        f.roster_latest(ring).is_some(),
        "/h/roster/{ring}/latest.bin answers"
    );
    assert!(
        f.overview_latest(ring).is_some(),
        "/h/overview/{ring}/latest.bin answers"
    );
    // a second seed, or a seed into a fold of another program, is refused
    assert!(seed(&mut f, &w.e, &w.snap).is_err());
    let mut other = fold(&dir, Address::new_from_array([0x44; 32]));
    assert!(seed(&mut other, &w.e, &w.snap).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_a_new_or_empty_data_directory_is_accepted() {
    let dir = scratch();
    assert!(fresh_data_dir(&dir).is_ok());
    assert!(fresh_data_dir(&dir.join("absent")).is_ok());
    std::fs::write(dir.join("herald.ckpt"), b"x").unwrap();
    assert!(fresh_data_dir(&dir).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A later live transaction's post-state replaces the seeded capture (this
/// record is a test input only; production folds only real feed records).
#[test]
fn a_live_post_state_replaces_the_seeded_capture() {
    let w = world();
    let dir = scratch();
    let mut f = fold(&dir, program());
    seed(&mut f, &w.e, &w.snap).unwrap();
    let mut data = w.snap.accounts[2].1.as_ref().unwrap().data.clone();
    data[H::STATE] = H::STATE_PROVISIONAL;
    let tx = fclient::ports::TxRecord {
        seq: 1,
        slot: 50,
        signature: Default::default(),
        block_time: 1_785_548_400,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![(
            w.e.holding,
            Some(fclient::ports::Account {
                lamports: 1,
                data: data.clone(),
                owner: program(),
                executable: false,
            }),
        )],
        loaded: Default::default(),
    };
    f.apply(&tx);
    let c = f.account(&w.e.holding.to_bytes()).unwrap();
    assert_eq!((c.slot, c.tx), (50, 1));
    assert_eq!(c.data, data);
    assert_eq!(f.st.folded_through, 1);
    // untouched seeded captures stay at the bootstrap slot
    assert_eq!(f.account(&w.e.citizen.to_bytes()).unwrap().slot, 42);
    let _ = std::fs::remove_dir_all(&dir);
}

/// History replayed after the bootstrap: an older transaction (the real
/// OpenProvince, slot ≤ the snapshot's context slot) is folded (its sequence
/// counts) but does not overwrite the newer verified snapshot of the home; a
/// later one does.
#[test]
fn replayed_older_history_never_overwrites_the_newer_snapshot() {
    let w = world();
    let dir = scratch();
    let mut f = fold(&dir, program());
    seed(&mut f, &w.e, &w.snap).unwrap();
    let snapshot = w.snap.accounts[3].1.as_ref().unwrap().data.clone();
    let mut older = snapshot.clone();
    older[P::N_ENTRIES] = 0; // the program's freshly opened home: no roster yet
    let tx = |seq, slot, data: Vec<u8>| fclient::ports::TxRecord {
        seq,
        slot,
        signature: Default::default(),
        block_time: 1_785_540_000,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![(
            w.e.home,
            Some(fclient::ports::Account {
                lamports: 1,
                data,
                owner: program(),
                executable: false,
            }),
        )],
        loaded: Default::default(),
    };
    for slot in [30, 42] {
        f.apply(&tx(if slot == 30 { 1 } else { 2 }, slot, older.clone()));
        let c = f.account(&w.e.home.to_bytes()).unwrap();
        assert_eq!((c.slot, c.tx), (42, 0), "slot {slot}: the snapshot stays");
        assert_eq!(c.data, snapshot);
    }
    assert_eq!(
        f.st.folded_through, 2,
        "the older transactions are folded, not skipped"
    );
    // (the watermark did not fall back to the replayed transactions' slots: the seeded captures stay within bounds)
    assert_eq!(f.st.last_slot, 42);
    assert!(f
        .st
        .accounts
        .values()
        .all(|c| c.slot <= f.st.last_slot && c.tx <= f.st.folded_through));
    let me = crate::views::me_json(&f, &wallet(), Value::Null);
    assert!(
        !me["hosts"].as_array().unwrap().is_empty(),
        "the player's host is still there"
    );
    // a later transaction replaces it as usual
    f.apply(&tx(3, 43, older.clone()));
    let c = f.account(&w.e.home.to_bytes()).unwrap();
    assert_eq!((c.slot, c.tx, c.data == older), (43, 3, true));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The route read's bounds (web fexpedition-route-read.mjs: `capture.slot <= snapshot.lastSlot` and
/// `capture.archiveSequence <= snapshot.foldedThrough`, else RouteCaptureAhead). The local test world's history is
/// OLDER than the bootstrap snapshot: its transactions are at slots below the context slot. Folding them must leave
/// every seeded capture inside the bounds the herald reports; the watermark was 0 after the seed and became the
/// replayed transaction's slot (5), under captures of slot 7.
#[test]
fn replayed_history_below_the_context_slot_leaves_every_capture_within_the_reported_bounds() {
    let w = world();
    let dir = scratch();
    let mut f = fold(&dir, program());
    seed(&mut f, &w.e, &w.snap).unwrap();
    let context = w.snap.context_slot;
    let within = |f: &Fold| {
        f.st.accounts
            .values()
            .all(|c| c.slot <= f.st.last_slot && c.tx <= f.st.folded_through)
    };
    assert!(within(&f), "after the seed");
    // three older transactions, none of the seeded accounts in their post-states (as the real history's events)
    for (seq, slot) in [(1u64, context - 30), (2, context - 20), (3, context - 2)] {
        f.apply(&fclient::ports::TxRecord {
            seq,
            slot,
            signature: Default::default(),
            block_time: 1_785_540_000,
            tx: vec![],
            logs: vec![],
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
            loaded: Default::default(),
        });
        assert_eq!(f.st.folded_through, seq, "folded, not skipped");
        assert_eq!(
            f.st.last_slot, context,
            "sequence {seq} at slot {slot}: the watermark stays at the snapshot's slot"
        );
        assert!(
            within(&f),
            "sequence {seq}: every capture within the bounds"
        );
    }
    for k in [w.e.citizen, w.e.holding, w.e.home] {
        let c = f.account(&k.to_bytes()).unwrap();
        assert_eq!(
            (c.slot, c.tx),
            (context, 0),
            "the seeded capture is as it was"
        );
    }
    // a transaction after the snapshot moves the watermark on, as ever
    f.apply(&fclient::ports::TxRecord {
        seq: 4,
        slot: context + 9,
        signature: Default::default(),
        block_time: 1_785_548_400,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
        loaded: Default::default(),
    });
    assert_eq!((f.st.last_slot, f.st.folded_through), (context + 9, 4));
    assert!(within(&f));
    let _ = std::fs::remove_dir_all(&dir);
}
