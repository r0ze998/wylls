//! Literal existing train snapshots, modified only in memory. Self-consistency
//! cases are not program parity; the separate pinned host record establishes
//! parity only for its exact one-transition fixture.
#![cfg(feature = "wide-economy-experimental")]
use frontier_abi::bytes::*;
use frontier_abi::layout::{
    header as HDR,
    province::{province as P, site as SM},
    world::season as S,
};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::world_index::{
    economy::Snapshots,
    event::{self, GarrisonReceipt, WideEntity, WideKind, WideLink, WideRecord},
    holding::WideHolding,
    ProvinceKey, WideHostRef,
};
use verify_core::wide_garrison::{self as g, Refusal};

struct Images {
    s: Vec<u8>,
    c: Vec<u8>,
    h: Vec<u8>,
    p: Vec<u8>,
}
impl Images {
    fn pre() -> Self {
        let mut out = Self {
            s: include_bytes!("fixtures/wide_economy/train/season.bin").to_vec(),
            c: include_bytes!("fixtures/wide_economy/train/citizen_post.bin").to_vec(),
            h: include_bytes!("fixtures/wide_economy/train/holding_post.bin").to_vec(),
            p: include_bytes!("fixtures/wide_economy/train/province_post.bin").to_vec(),
        };
        wr_u32(&mut out.p, P::RESOLVED_NEXT, 723);
        out
    }
    fn snapshots(&self) -> Snapshots<'_> {
        Snapshots {
            citizen: &self.c,
            holding: &self.h,
            province: &self.p,
        }
    }
    fn now(&self) -> i64 {
        rd_i64(&self.s, S::GENESIS_TS).unwrap() + 723 * 600
    }
    fn href(&self) -> WideHostRef {
        let h = WideHolding::read(&self.h).unwrap();
        WideHostRef::new(ProvinceKey::new(h.world, h.coord), h.site, h.gen, 0).unwrap()
    }
}
fn record(pre: &Images, delta: i64, flip: bool, output: [u8; 32]) -> Vec<u8> {
    let receipt = GarrisonReceipt {
        delta,
        now_ts: pre.now(),
        became_final: flip,
        input_digest: event::garrison_input_digest(
            &pre.href(),
            delta,
            pre.now(),
            &pre.s,
            &pre.snapshots(),
        )
        .unwrap(),
        output_digest: output,
    };
    let payload = receipt.to_bytes().unwrap();
    let mut body = [0; event::MAX_BODY];
    let n = event::write_body(
        WideKind::Garrison,
        723,
        &pre.href().to_bytes(),
        &payload,
        &mut body,
    )
    .unwrap();
    let links: Vec<_> = WideKind::Garrison
        .links()
        .iter()
        .map(|entity| {
            let data = match entity {
                WideEntity::Holding => &pre.h,
                WideEntity::Province => &pre.p,
            };
            event::advance(
                *entity,
                rd_u64(data, HDR::EVENT_SEQ).unwrap(),
                &rd_arr(data, HDR::EVENT_HEAD).unwrap(),
                &body[..n],
            )
            .unwrap()
        })
        .collect();
    event::encode(
        WideKind::Garrison,
        723,
        &pre.href().to_bytes(),
        &payload,
        &links,
    )
    .unwrap()
}
fn post(pre: &Images, record: &[u8]) -> Images {
    let st = g::stage(record, &pre.s, &pre.snapshots()).unwrap();
    let mut after = Images {
        s: pre.s.clone(),
        c: st.citizen,
        h: st.holding,
        p: st.province,
    };
    let decoded = WideRecord::decode(record).unwrap();
    for entity in WideKind::Garrison.links() {
        let WideLink { seq, head, .. } = decoded.link(*entity).unwrap();
        let data = match entity {
            WideEntity::Holding => &mut after.h,
            WideEntity::Province => &mut after.p,
        };
        wr_u64(data, HDR::EVENT_SEQ, seq);
        wr_arr(data, HDR::EVENT_HEAD, &head);
    }
    after
}
fn build(pre: &Images, flip: bool) -> (Vec<u8>, Images) {
    let draft = record(pre, 5, flip, [0; 32]);
    let after = post(pre, &draft);
    let digest =
        event::garrison_output_digest(&pre.href(), 5, pre.now(), flip, &after.snapshots()).unwrap();
    let record = record(pre, 5, flip, digest);
    let after = post(pre, &record);
    (record, after)
}
#[test]
fn independent_transition_and_whole_season_limit() {
    let pre = Images::pre();
    let (record, after) = build(&pre, false);
    let v = g::verify_transition(&record, &pre.s, &pre.snapshots(), &after.snapshots()).unwrap();
    assert_eq!(v.delta, 5);
    assert!(!g::FULL_SEASON_REPLAY_SUPPORTED);
    assert!(!v.not_proven().is_empty());
    assert_eq!(
        rd_u32(&after.h, H::reserve(0)),
        Some(rd_u32(&pre.h, H::reserve(0)).unwrap() - 5)
    );
    let o = P::site(pre.href().site() as usize);
    assert_eq!(rd_u32(&after.p, o + SM::PEND0_BELL), Some(723));
    assert_eq!(rd_i64(&after.p, o + SM::PEND0_DELTA), Some(5000));
}
#[test]
fn every_output_byte_is_committed_and_compared() {
    let pre = Images::pre();
    let (record, mut after) = build(&pre, false);
    // Every byte, including both chain headers, trailer and unaffected fields.
    for which in 0..3 {
        let len = match which {
            0 => after.c.len(),
            1 => after.h.len(),
            _ => after.p.len(),
        };
        for i in 0..len {
            match which {
                0 => after.c[i] ^= 1,
                1 => after.h[i] ^= 1,
                _ => after.p[i] ^= 1,
            }
            assert!(
                g::verify_transition(&record, &pre.s, &pre.snapshots(), &after.snapshots())
                    .is_err(),
                "account {which} byte {i}"
            );
            match which {
                0 => after.c[i] ^= 1,
                1 => after.h[i] ^= 1,
                _ => after.p[i] ^= 1,
            }
        }
    }
}
#[test]
fn input_tamper_rejected_before_replay() {
    let mut pre = Images::pre();
    let (record, after) = build(&pre, false);
    pre.h[H::reserve(0)] ^= 1;
    assert!(matches!(
        g::verify_transition(&record, &pre.s, &pre.snapshots(), &after.snapshots()),
        Err(Refusal::Digest(_))
    ));
}
#[test]
fn output_digest_and_each_chain_are_required() {
    let pre = Images::pre();
    let (good, after) = build(&pre, false);
    let bad = record(&pre, 5, false, [0; 32]);
    let bad_after = post(&pre, &bad);
    assert!(matches!(
        g::verify_transition(&bad, &pre.s, &pre.snapshots(), &bad_after.snapshots()),
        Err(Refusal::Digest(_))
    ));
    for back in [1, 42] {
        let mut bad = good.clone();
        let i = bad.len() - back;
        bad[i] ^= 1;
        assert!(g::verify_transition(&bad, &pre.s, &pre.snapshots(), &after.snapshots()).is_err());
    }
    for bad in [
        &good[..good.len() - 1],
        &[good.as_slice(), &[0]].concat()[..],
    ] {
        assert!(g::verify_transition(bad, &pre.s, &pre.snapshots(), &after.snapshots()).is_err());
    }
}
#[test]
fn authenticated_bad_state_still_refused() {
    for mutation in 0..7 {
        let mut pre = Images::pre();
        match mutation {
            0 => {
                wr_u32(&mut pre.p, P::RESOLVED_NEXT, 721);
            }
            1 => {
                wr_u32(&mut pre.h, H::reserve(0), 4);
            }
            2 => {
                wr_u8(&mut pre.h, H::STATE, H::STATE_PROVISIONAL);
                wr_i64(&mut pre.h, H::FINAL_TS, i64::MAX);
            }
            3 => {
                pre.c[HDR::MAGIC] ^= 1;
            }
            4 => {
                wr_u8(&mut pre.h, H::ORDER, 0);
            }
            5 => {
                let o = P::site(pre.href().site() as usize);
                pre.p[o + SM::GEN] = pre.href().gen().wrapping_add(1);
            }
            _ => {
                wr_u64(&mut pre.c, HDR::SEASON_ID, 9999);
            }
        }
        let r = record(&pre, 5, false, [0; 32]);
        assert!(
            g::stage(&r, &pre.s, &pre.snapshots()).is_err(),
            "mutation {mutation}"
        );
    }
}
#[test]
fn lazy_finality_is_independently_required() {
    let mut pre = Images::pre();
    wr_u8(&mut pre.h, H::STATE, H::STATE_PROVISIONAL);
    wr_i64(&mut pre.h, H::FINAL_TS, 0);
    wr_u32(&mut pre.h, H::TICKET_BELL, 0);
    let bad = record(&pre, 5, false, [0; 32]);
    assert!(matches!(
        g::stage(&bad, &pre.s, &pre.snapshots()),
        Err(Refusal::Finality(_))
    ));
    let (r, after) = build(&pre, true);
    assert!(
        g::verify_transition(&r, &pre.s, &pre.snapshots(), &after.snapshots())
            .unwrap()
            .became_final
    );
    assert_eq!(rd_u8(&after.h, H::STATE), Some(H::STATE_FINAL));
}

mod host_anchors {
    include!("fixtures/wide_garrison_receipts.rs");
}
/// These literal receipts are independently pinned by real host dispatch.
/// The input commitment anchors our exact pre-state; the output commitment
/// anchors every independently staged post byte (chain fields normalized).
/// Both record chain links are separately checked against those full bytes.
#[test]
fn real_host_receipt_anchors_match_independent_replay() {
    for (case, hex) in &host_anchors::RECORDS {
        let mut pre = Images::pre();
        let so = P::site(pre.href().site() as usize);
        match *case {
            "base" => {}
            "merge" => {
                let base = host_anchors::RECORDS
                    .iter()
                    .find(|(n, _)| *n == "base")
                    .unwrap()
                    .1;
                pre = post(&pre, &hex::decode(base).unwrap());
            }
            "settle" => {
                wr_u32(&mut pre.p, so + SM::GARRISON, 1000);
                wr_u32(&mut pre.p, so + SM::PEND0_BELL, 722);
                wr_i64(&mut pre.p, so + SM::PEND0_DELTA, 2000);
                wr_u32(&mut pre.p, so + SM::PEND1_BELL, 721);
                wr_i64(&mut pre.p, so + SM::PEND1_DELTA, 3000);
            }
            "finality" => {
                let now = pre.now();
                wr_u8(&mut pre.h, H::STATE, H::STATE_PROVISIONAL);
                wr_i64(&mut pre.h, H::FINAL_TS, now);
            }
            "surviving_slot" | "due_clamp" => {
                wr_u32(&mut pre.p, so + SM::GARRISON, 1000);
                wr_u32(&mut pre.p, so + SM::PEND0_BELL, 722);
                wr_i64(
                    &mut pre.p,
                    so + SM::PEND0_DELTA,
                    if *case == "due_clamp" { i64::MIN } else { 2000 },
                );
                wr_u32(&mut pre.p, so + SM::PEND1_BELL, 723);
                wr_i64(&mut pre.p, so + SM::PEND1_DELTA, 3000);
            }
            _ => panic!("unknown pinned anchor"),
        }
        let record = hex::decode(hex).unwrap();
        let after = post(&pre, &record);
        let v = g::verify_transition(&record, &pre.s, &pre.snapshots(), &after.snapshots())
            .unwrap_or_else(|e| panic!("host parity {case}: {e}"));
        assert_eq!(v.delta, if *case == "merge" { 2 } else { 5 });
        assert_eq!(v.became_final, *case == "finality");
    }
}
