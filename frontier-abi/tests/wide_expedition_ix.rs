//! Closed experimental wire contracts; no signing, runtime or network.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::{
    error::FrontierError,
    prologue::{bounds_in, position_in},
    tags::Class,
    world_index::wide_ix::{self as w, WideCommand as C},
};

fn depart() -> w::ExpeditionDepart {
    w::ExpeditionDepart {
        host: [1; 56],
        transit_slot: 2,
        arrive_bell: 14,
        tip: 99,
        commit: [2; 32],
        seal: [3; 264],
    }
}

#[test]
fn expedition_commands_are_distinct_exact_closed_envelopes() {
    let d = depart();
    let db = d.to_bytes();
    let s = w::ExpeditionSettleOrigin { transit_slot: 3 };
    let sb = s.to_bytes();
    assert_eq!(db.len(), 369);
    assert_eq!(sb.len(), 5);
    assert_eq!(&db[..4], &[0xDA, 0xFF, 1, 6]);
    assert_eq!(sb, [0xDC, 0xFF, 1, 10, 3]);
    assert_eq!(C::decode(&db), Ok(C::ExpeditionDepart(d)));
    assert_eq!(C::decode(&sb), Ok(C::ExpeditionSettleOrigin(s)));
    assert_eq!(w::Depart::decode(&db), Err(FrontierError::BadData));
    assert_eq!(w::SettleDeparture::decode(&sb), Err(FrontierError::BadData));
    let old = w::Depart {
        host: d.host,
        transit_slot: d.transit_slot,
        arrive_bell: d.arrive_bell,
        tip: d.tip,
        commit: d.commit,
        seal: d.seal,
    }
    .to_bytes();
    assert!(matches!(C::decode(&old), Ok(C::Depart(_))));
    assert_eq!(
        w::ExpeditionDepart::decode(&old),
        Err(FrontierError::BadData)
    );
    for (bytes, class, count, name) in [
        (&db[..], Class::P, 9, "ExpeditionDepart"),
        (&sb[..], Class::D, 6, "ExpeditionSettleOrigin"),
    ] {
        let cmd = C::decode(bytes).unwrap();
        assert_eq!(cmd.class(), class);
        assert_eq!(cmd.name(), name);
        assert_eq!(bounds_in(cmd.accounts()), (count, count));
        assert!(!cmd.is_player(), "ResidentAct admission stays closed");
        assert!(!cmd.top_level_only());
        let mut act = vec![0; bytes.len() + w::ResidentAct::HEAD];
        w::ResidentAct {
            generation: 1,
            inner: bytes,
        }
        .encode_into(&mut act)
        .unwrap();
        assert_eq!(w::ResidentAct::decode(&act), Err(FrontierError::BadData));
        // Generic decoding preserves short legacy forms. The specific new
        // codec rejects every truncation, including those other command sizes.
        for n in 0..bytes.len() {
            if class == Class::P {
                assert!(w::ExpeditionDepart::decode(&bytes[..n]).is_err());
            } else {
                assert!(w::ExpeditionSettleOrigin::decode(&bytes[..n]).is_err());
            }
        }
        for off in 0..4 {
            let mut bad = bytes.to_vec();
            bad[off] = 0;
            assert!(C::decode(&bad).is_err());
        }
        let mut extra = bytes.to_vec();
        extra.push(0);
        assert!(C::decode(&extra).is_err());
    }
    for slot in [4, 255] {
        let mut bad = db;
        bad[60] = slot;
        assert!(C::decode(&bad).is_err());
        let mut bad = sb;
        bad[4] = slot;
        assert!(C::decode(&bad).is_err());
    }
    assert!(!C::decode(&db).unwrap().march_stage());
    assert!(C::decode(&sb).unwrap().march_stage());
}

#[test]
fn expedition_manifests_preserve_original_account_roles() {
    let d = w::EXPEDITION_DEPART;
    let s = w::EXPEDITION_SETTLE_ORIGIN;
    for (position, name) in [
        "actor",
        "payer",
        "season",
        "citizen",
        "holding",
        "province",
        "system",
        "holding_province",
        "transit",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(position_in(d, 9, name, 0), Some(position));
    }
    for (position, name) in [
        "payer",
        "season",
        "origin_province",
        "holding",
        "holding_province",
        "transit",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(position_in(s, 6, name, 0), Some(position));
    }
    assert_eq!(position_in(d, 9, "transit", 1), None);
    assert_eq!(position_in(s, 6, "citizen", 0), None);
    use frontier_abi::{
        layout::AccountKind as K,
        prologue::{Acc, Wr},
    };
    assert_eq!(d[0].specs[4].acc, Acc::Kind(K::Holding));
    assert_eq!(d[0].specs[5].acc, Acc::Kind(K::Province));
    assert_eq!(d[0].specs[8].acc, Acc::Any);
    assert_eq!(d[0].specs[8].wr, Wr::W);
    assert_eq!(s[0].specs[3].acc, Acc::Kind(K::Holding));
    assert_eq!(s[0].specs[4].acc, Acc::Kind(K::Province));
    assert_eq!(
        d[0].specs[7].wr,
        Wr::Either,
        "issuer may alias writable standing Province"
    );
    assert_eq!(
        s[0].specs[4].wr,
        Wr::Either,
        "issuer may alias writable origin Province"
    );
}
