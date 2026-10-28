//! Map growth stage 4: a resting S1 Province the keeper leaves behind
//! (`resolved_next` not written each bell) still gets its per-bell files
//! (overview, control, standings) as soon as the chain proves the bell
//! quiet — its anchor's reveal window closed by the latest block time and
//! no arrival bit — with the territory of R1 (stored counter + proven
//! tail). An arrival stops the projection at its bell; the FastForward
//! that later writes the same bells raises no alarm and leaves nothing
//! waiting.

mod common;

use std::sync::Arc;

use common::tmp;
use fclient::log::log_line;
use fclient::ports::{Account, Signature, TxRecord};
use frontier_abi::conquest_model::{self as qm, StepParams};
use frontier_abi::rest_model;
use frontier_abi::v2::layout::province::{keep as KP, province as P};
use frontier_abi::v2::layout::world::season as SE;
use frontier_abi::v2::log::{self as v2log, AnyKind, CqKind, EntityKind, Link};
use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, S1_TEST};
use herald_fold::clash::Provisional;
use herald_fold::cqfmt::StandingsLatest;
use herald_fold::files::Out;
use herald_fold::fold::{Fold, FoldCfg};
use permutation_rules::frontier::geometry::{provinces_within, region_of, ProvinceCoord};
use solana_address::Address;

const SEASON_ID: u64 = 11;
const GENESIS_TS: i64 = 1_800_000_000;
const END_BELL: u32 = 288;
const HOLDER: u8 = 2;

fn program() -> Address {
    Address::new_from_array([0x6E; 32])
}

fn put(d: &mut [u8], o: usize, b: &[u8]) {
    d[o..o + b.len()].copy_from_slice(b);
}

fn prm() -> StepParams {
    StepParams {
        genesis_ts: GENESIS_TS,
        end_bell: END_BELL,
        cq: S1_TEST.cq,
    }
}

fn season() -> Vec<u8> {
    use frontier_abi::v2::layout::{write_header, AccountKind};
    let mut s = vec![0u8; SE::SIZE];
    write_header(&mut s, AccountKind::Season, SEASON_ID);
    s[SE::STATUS] = SE::STATUS_RUNNING;
    s[SE::REGIONS] = 16;
    s[SE::GENESIS_RING] = 2;
    put(&mut s, SE::R_MAX, &16u16.to_le_bytes());
    put(
        &mut s,
        SE::PROGRAM_VERSION,
        &PROGRAM_VERSION_S1.to_le_bytes(),
    );
    put(&mut s, SE::BELL_SECS, &600u32.to_le_bytes());
    put(&mut s, SE::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut s, SE::END_BELL, &END_BELL.to_le_bytes());
    put(&mut s, SE::CONQUEST_PARAMS, &S1_TEST.cq.to_bytes());
    s
}

/// A ring-2 Province opened at bell 0, its keep held by [`HOLDER`], no
/// camp check before day 1,000: it rests from bell 0.
fn province(c: ProvinceCoord) -> Vec<u8> {
    use frontier_abi::v2::kernel::keep::Keep;
    use frontier_abi::v2::layout::{write_header, AccountKind};
    let mut d = vec![0u8; P::SIZE];
    write_header(&mut d, AccountKind::Province, SEASON_ID);
    put(&mut d, P::P, &(c.p as i16).to_le_bytes());
    put(&mut d, P::Q, &(c.q as i16).to_le_bytes());
    put(&mut d, P::RING, &(c.ring() as u16).to_le_bytes());
    d[P::WEDGE] = c.wedge().unwrap_or(0);
    d[P::REGION] = region_of(c);
    frontier_abi::clash_model::Camp {
        tile: 0,
        state: 0,
        troops: 0,
        next_check_day: 1_000,
        gen: 0,
    }
    .write(&mut d)
    .expect("camp");
    let k = Keep {
        tile: 30,
        holder: HOLDER,
        contender: KP::NONE,
        progress: 0,
        required: 24,
        heartland_safe: false,
        paused: false,
        changes: 0,
        troops: 0,
        since_bell: 0,
        consolidated_until_bell: 0,
        contest_from_bell: 0,
        gen: 0,
        last_taken_from: KP::NONE,
    };
    qm::write_keep(&mut d, &k).expect("keep");
    d
}

/// Bell `b`'s anchor in region `r`: `A` = the bell's end.
fn anchor(b: u32, r: u8) -> Vec<u8> {
    use frontier_abi::layout::beacon::bell_anchor as A;
    use frontier_abi::layout::{write_header, AccountKind};
    let mut d = vec![0u8; AccountKind::BellAnchor.size()];
    write_header(&mut d, AccountKind::BellAnchor, SEASON_ID);
    put(&mut d, A::BELL, &b.to_le_bytes());
    d[A::REGION] = r;
    d[A::NET] = 2;
    put(&mut d, A::A, &bell_end(b).to_le_bytes());
    d
}

fn arrival_day(c: ProvinceCoord, b: u32) -> Vec<u8> {
    use frontier_abi::layout::clash::arrival_day as AD;
    use frontier_abi::layout::{write_header, AccountKind};
    let mut d = vec![0u8; AccountKind::ArrivalDay.size()];
    write_header(&mut d, AccountKind::ArrivalDay, SEASON_ID);
    put(&mut d, AD::P, &(c.p as i16).to_le_bytes());
    put(&mut d, AD::Q, &(c.q as i16).to_le_bytes());
    put(&mut d, AD::DAY, &(b / 144).to_le_bytes());
    let (at, m) = AD::bit(b);
    d[at] |= m;
    d
}

fn bell_end(b: u32) -> i64 {
    GENESIS_TS + (b as i64 + 1) * 600
}

/// The REST record of a rest `from..to` that left `pd`, chained to it.
fn rest_record(c: ProvinceCoord, from: u32, r: &rest_model::Rest, pd: &mut [u8]) -> Vec<u8> {
    let k = AnyKind::Cq(CqKind::REST);
    let mut key = vec![];
    key.extend((c.p).to_le_bytes());
    key.extend((c.q).to_le_bytes());
    key.extend(from.to_le_bytes());
    let digest = rest_model::rest_digest(pd, r.from, r.to).unwrap();
    let mut pay = vec![0u8; k.payload_len()];
    for (n, b) in [
        ("to", r.to.to_le_bytes().to_vec()),
        ("holder", vec![r.holder.unwrap_or(0xFF)]),
        ("territory", (r.territory as u32).to_le_bytes().to_vec()),
        ("spawns", vec![r.spawns.len() as u8]),
        ("digest", digest.to_vec()),
    ] {
        let (o, w) = v2log::field(k, n, true).unwrap();
        pay[o..o + w].copy_from_slice(&b[..w]);
    }
    let mut out = vec![0u8; 512];
    let n = v2log::write_body(k, r.to, &key, &pay, &mut out).unwrap();
    let bwt = out[..n].to_vec();
    let seq = u64::from_le_bytes(pd[24..32].try_into().unwrap());
    let head: [u8; 32] = pd[32..64].try_into().unwrap();
    let l: Link = v2log::advance(EntityKind::Province, seq, &head, &bwt).unwrap();
    put(pd, 24, &l.seq.to_le_bytes());
    put(pd, 32, &l.head);
    let m = v2log::write_tail(&[l], &mut out, n).unwrap();
    out.truncate(m);
    out
}

struct Chain {
    f: Fold,
    seq: u64,
}

impl Chain {
    fn tx(&mut self, time: i64, bodies: Vec<Vec<u8>>, post: Vec<([u8; 32], Vec<u8>)>) {
        self.seq += 1;
        let mut sig = [0u8; 64];
        sig[..8].copy_from_slice(&self.seq.to_le_bytes());
        self.f.apply(&TxRecord {
            seq: self.seq,
            slot: self.seq,
            signature: Signature::from(sig),
            block_time: time,
            tx: vec![],
            logs: fclient::log::in_frame(&program(), bodies.iter().map(|b| log_line(b))),
            err: None,
            code: None,
            units: 0,
            fee: 5_000,
            post: post
                .into_iter()
                .map(|(k, data)| {
                    (
                        Address::new_from_array(k),
                        Some(Account {
                            lamports: 1_000_000,
                            data,
                            owner: program(),
                            executable: false,
                        }),
                    )
                })
                .collect(),
        });
    }
}

fn territory(root: &std::path::Path) -> (u32, u64) {
    let b = std::fs::read(root.join("h/standings/latest.json")).unwrap();
    let l = StandingsLatest::parse(&b).unwrap();
    (l.bell, l.factions[HOLDER as usize].dominion)
}

#[test]
fn a_resting_province_is_projected_over_the_bells_the_chain_proves() {
    let dir = tmp("rest");
    let mut ch = Chain {
        f: Fold::new(
            FoldCfg {
                program: program(),
                season_id: SEASON_ID,
                builder: Arc::new(Provisional),
                exact_post: true,
            },
            Out::new(&dir),
        ),
        seq: 0,
    };
    let c = ProvinceCoord::from_index(provinces_within(1));
    assert_eq!(c.ring(), 2);
    let pq = (c.p as i16, c.q as i16);
    let r = region_of(c);
    let ctx = ch.f.ctx;
    let pd0 = province(c);
    ch.tx(
        GENESIS_TS,
        vec![],
        vec![
            (ctx.season, season()),
            (ctx.province(c.p, c.q), pd0.clone()),
        ],
    );
    // 12 bells close, the Province is never written
    for b in 0..12u32 {
        ch.tx(
            bell_end(b),
            vec![],
            vec![(ctx.bell_anchor(b, r), anchor(b, r))],
        );
    }
    assert_eq!(ch.f.rest.next(pq, 0), 12, "every closed bell is proven");
    for b in 0..12u32 {
        assert!(
            dir.join(format!("h/control/{b}.bin")).exists(),
            "control {b}"
        );
        assert!(
            dir.join(format!("h/overview/2/{b}.bin")).exists(),
            "overview {b}"
        );
    }
    assert_eq!(territory(&dir), (11, 12), "stored 0 + the proven 12 bells");
    // a bell whose window has not closed is not proven
    ch.tx(
        bell_end(12) - 1,
        vec![],
        vec![(ctx.bell_anchor(12, r), anchor(12, r))],
    );
    assert_eq!(ch.f.rest.next(pq, 0), 12);
    // an arrival at bell 14 stops it there
    ch.tx(
        bell_end(12),
        vec![],
        vec![(ctx.arrival_day(c.p, c.q, 0), arrival_day(c, 14))],
    );
    for b in 13..18u32 {
        ch.tx(
            bell_end(b),
            vec![],
            vec![(ctx.bell_anchor(b, r), anchor(b, r))],
        );
    }
    assert_eq!(ch.f.rest.next(pq, 0), 14);
    assert_eq!(territory(&dir), (13, 14));
    // the FastForward to 14 lands: same bytes, a REST record, no alarm
    let mut pd = pd0.clone();
    let rest = rest_model::project(&mut pd, 14, &prm()).unwrap();
    assert_eq!((rest.holder, rest.territory), (Some(HOLDER), 14));
    let body = rest_record(c, 0, &rest, &mut pd);
    ch.tx(bell_end(18), vec![body], vec![(ctx.province(c.p, c.q), pd)]);
    let a = &ch.f.cq.alarms;
    assert_eq!(
        (a.conquest_mismatch, a.replay_errors, a.conquest_missing),
        (0, 0, 0),
        "{a:?}"
    );
    assert_eq!(ch.f.st.alarms.rewrites, 0, "no immutable file rewritten");
    assert!(
        ch.f.st.pending.keys().all(|k| k.2 >= 14),
        "nothing waits for a bell already in the overview"
    );
    assert_eq!(
        ch.f.rest.next(pq, 14),
        14,
        "the arrival's bell is the clash's"
    );
    assert_eq!(territory(&dir), (13, 14));
    // a REST record whose digest is not the Province's is an alarm
    let mut pd2 = pd0.clone();
    put(&mut pd2, P::RESOLVED_NEXT, &14u32.to_le_bytes());
    let bad = rest_record(c, 0, &rest, &mut pd2.clone());
    ch.tx(bell_end(19), vec![bad], vec![]);
    assert_eq!(ch.f.cq.alarms.conquest_mismatch, 1);
}
