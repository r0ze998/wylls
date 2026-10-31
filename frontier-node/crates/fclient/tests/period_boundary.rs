//! Sealed marches across a war-period boundary in a world that does not end
//! (direction of 2026-10-31: the world continues; war periods only
//! delimit competition). No period type exists in the code yet, and this
//! test does not define one: a boundary is just a bell `B`.
//!
//! The seal is bound to an absolute drand round `R = T(arrive)`, computed
//! from the bell clock (`genesis_ts`, 600-s bells) and the drand clock, and
//! its plaintext carries `host_id` and `arrive_bell`. So:
//!
//! - with one continuous bell clock, a march that departs before `B` and
//!   arrives after it opens with `R`'s signature and nothing else, exactly
//!   as one that stays inside a period;
//! - if a boundary re-based the bell clock (a new `genesis_ts`, bells
//!   counted from 0 again — what a new Season does today), the same march
//!   would be judged with another round and destroyed (FO failure), and its
//!   plaintext's `arrive_bell` would no longer be the transit's. That is a
//!   constraint on the migration (④/⑧), recorded here as a test;
//! - the clock arithmetic stays exact and monotone over the whole u32 bell
//!   range (≈ 81,700 years of 600-s bells), so continuing the world needs no
//!   re-basing for range reasons.

use fclient::beacon::TestKey;
use fclient::clock::Drand;
use fclient::seal::{self, Plain};

const G0: i64 = 1_788_998_400; // 2026-09-10T00:00:00Z, the archive season's G0

fn plain(host: u64, arrive: u32) -> Plain {
    Plain {
        version: 1,
        host_id: host,
        arrive_bell: arrive,
        dest_p: 2,
        dest_q: -1,
        dest_tile: 5,
        stance: 0,
        retreat_bps: 0,
        path_len: 1,
        path: seal::path_of(&[3]),
        reserved: [0; 3],
    }
}

#[test]
fn a_march_across_a_boundary_opens_only_with_its_round() {
    let k = TestKey::new();
    let d = Drand::QUICKNET;
    let boundary: u32 = 1_008; // e.g. the end of a 7-day war period
    for (host, depart, arrive) in [(1u64, 1_000u32, 1_007u32), (2, 1_005, 1_008), (3, 1_007, 1_020)] {
        let r = d.tlock_round(G0, arrive);
        let p = plain(host, arrive);
        let s = seal::seal(&seal::pack(&p), &k.pk96, r).unwrap();
        let crosses = depart < boundary && arrive >= boundary;
        let (code, got) = seal::judge(&s.seal, &s.commit, &k.sign(r), host, arrive);
        assert_eq!((code, got), (0, Some(p)), "host {host} (crosses: {crosses})");
        for other in [r - 1, r + 1, d.tlock_round(G0, arrive - 1), d.tlock_round(G0, arrive + 1)] {
            let (code, _) = seal::judge(&s.seal, &s.commit, &k.sign(other), host, arrive);
            assert_ne!(code, 0, "host {host}: round {other} ≠ R {r} must not open");
        }
    }
}

#[test]
fn re_basing_the_bell_clock_at_a_boundary_would_destroy_sealed_marches() {
    let k = TestKey::new();
    let d = Drand::QUICKNET;
    let boundary: u32 = 1_008;
    let (host, arrive) = (7u64, 1_010u32);
    let r = d.tlock_round(G0, arrive);
    let p = plain(host, arrive);
    let s = seal::seal(&seal::pack(&p), &k.pk96, r).unwrap();
    // A new period counted from its own genesis (today's new-Season shape).
    let g1 = G0 + 600 * boundary as i64;
    let arrive_rebased = arrive - boundary;
    let r_rebased = d.tlock_round(g1, arrive_rebased);
    assert_eq!(r_rebased, r, "same instant, same round: only the numbering moved");
    // …but the plaintext still says the old bell number, so the program's
    // Plain::validate (arrive_bell = the transit's) refuses it: code 5.
    let (code, _) = seal::judge(&s.seal, &s.commit, &k.sign(r_rebased), host, arrive_rebased);
    assert_eq!(code, 5, "ArriveMismatch after re-numbering bells");
    // And a re-based genesis that is not an exact bell multiple moves T.
    let g2 = g1 + 7;
    let r_shift = d.tlock_round(g2, arrive_rebased);
    assert_ne!(r_shift, r);
    let (code, _) = seal::judge(&s.seal, &s.commit, &k.sign(r_shift), host, arrive_rebased);
    assert_eq!(code, 1, "another round: FO failure, the march is destroyed");
}

#[test]
fn the_clock_has_no_range_reason_to_re_base() {
    let d = Drand::QUICKNET;
    let mut prev = 0u64;
    for b in (0..=u32::MAX - 1).step_by(9_999_991).chain([u32::MAX - 1]) {
        let r = d.tlock_round(G0, b);
        assert!(r > prev, "T is strictly increasing (bell {b})");
        // T(b) is the first round at or after the bell's end, exactly.
        let end = G0 + 600 * (b as i64 + 1);
        assert!(d.round_time(r) >= end && d.round_time(r) - end < 3, "bell {b}");
        prev = r;
    }
    assert!(prev < u64::MAX / 2);
}
