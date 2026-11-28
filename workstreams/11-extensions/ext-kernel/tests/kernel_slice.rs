//! ⑪(b) first local slice: the rules kernel's `frontier::effects` (feature
//! `declarative-effects`) must agree with this prototype's interpreter on
//! every op the slice shares (Require/Set/Add/Pay=Lock/Refund=Release), and
//! decode the WXM1 body byte for byte. Plan:
//! docs/design/extensions/item11b-plan.md.

use permutation_rules::frontier::effects as k;
use permutation_rules::frontier::holding::{Holding, Resource};
use permutation_rules::frontier::travel::BELL_SECS;
use wylls_ext_kernel::examples::{self, W};
use wylls_ext_kernel::exec::{run_entry, Instance};
use wylls_ext_kernel::manifest::{Manifest, Op, MAGIC};

const T0: i64 = 1_800_000_000;

/// watch-vow without its Emit ops (Emit is not in the slice).
fn slice_vow() -> Manifest {
    let mut m = examples::watch_vow([0xa1; 32]);
    for e in &mut m.entries {
        e.ops.retain(|op| !matches!(op, Op::Emit(_)));
    }
    m.validate().unwrap();
    m
}

fn body_bytes(m: &Manifest) -> Vec<u8> {
    let all = m.encode();
    assert_eq!(all[..4], MAGIC);
    let header = 4 + 1 + 1 + 2 + 32 + 32 + 1 + m.name.len();
    all[header..].to_vec()
}

#[test]
fn the_wxm1_body_decodes_byte_for_byte() {
    let m = slice_vow();
    let b = body_bytes(&m);
    let body = k::Body::decode(&b).unwrap();
    assert_eq!(body.encode(), b);
    // The full watch-vow (with Emit) is known to the format, not to the slice.
    let full = examples::watch_vow([0xa1; 32]);
    assert_eq!(
        k::Body::decode(&body_bytes(&full)),
        Err(k::EffectError::NotInSlice)
    );
}

#[test]
fn kernel_and_prototype_agree_on_every_short_history() {
    let m = slice_vow();
    let body = k::Body::decode(&body_bytes(&m)).unwrap();
    let mut h0 = Holding::found(T0, 0, 1);
    h0.credit(T0, Resource::Wood, 25_000).unwrap();
    // (entry, args) menu: pledge small, pledge big, fulfil, out-of-range.
    let menu: [(u8, &[i64]); 4] = [
        (0, &[5_000, 1]),
        (0, &[20_000, 3]),
        (1, &[]),
        (0, &[999, 1]),
    ];
    let (mut agree_ok, mut agree_err) = (0, 0);
    for n in 0..4u32.pow(5) {
        let (mut pi, mut ph) = (Instance::fresh(&m), h0.clone());
        let (mut ki, mut kh) = (k::Instance::fresh(&body), h0.clone());
        for step in 0..5 {
            let (entry, args) = menu[((n >> (2 * step)) & 3) as usize];
            let t = T0 + (step as i64 + 1) * 2 * BELL_SECS;
            let p = run_entry(&m, entry, args, t, &pi, &ph);
            let q = k::run(&body, entry, args, t, &ki, &kh);
            match (p, q) {
                (Ok(p), Ok(q)) => {
                    assert_eq!(p.holding, q.holding);
                    assert_eq!(p.holding_delta, q.holding_delta);
                    assert_eq!(p.escrow_delta, q.escrow_delta);
                    assert_eq!(p.instance.fields, q.instance.fields);
                    assert_eq!(p.instance.escrow, q.instance.escrow);
                    assert_eq!(p.instance.seq, q.instance.seq);
                    (pi, ph, ki, kh) = (p.instance, p.holding, q.instance, q.holding);
                    agree_ok += 1;
                }
                (Err(_), Err(_)) => agree_err += 1,
                (p, q) => panic!("history {n} step {step}: prototype {p:?} vs kernel {q:?}"),
            }
            assert_eq!(
                kh.stock_at(t)[W as usize] + ki.escrow[W as usize],
                h0.stock_at(T0)[W as usize]
            );
        }
    }
    assert!(
        agree_ok > 1_000 && agree_err > 1_000,
        "{agree_ok} {agree_err}"
    );
}
