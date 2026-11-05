//! Prints the example manifests' sizes and ids, and the per-user state size
//! a program account would hold (the numbers 02-comparison quotes).
use wylls_ext_kernel::describe::describe;
use wylls_ext_kernel::examples::{watch_vow, watch_vow_v2, wood_offering};
use wylls_ext_kernel::manifest::MAX_FIELDS;

fn main() {
    for m in [
        watch_vow([0xA1; 32]),
        watch_vow_v2([0xA1; 32]),
        wood_offering([0xA1; 32]),
    ] {
        let b = m.encode();
        println!(
            "{:<14} {:>4} B  id {}",
            m.name,
            b.len(),
            describe(&m).id_hex
        );
    }
    // magic 8, manifest id 32, citizen 32, seq 8, fields 8×8, escrow 8×8,
    // last receipt 32.
    let inst = 8 + 32 + 32 + 8 + 8 * MAX_FIELDS + 8 * 8 + 32;
    println!(
        "instance account {inst} B, rent-exempt {} lamports",
        (128 + inst) * 6_960
    );
    println!(
        "1,024 B manifest account (+64 B header) rent-exempt {} lamports",
        (128 + 1_024 + 64) * 6_960
    );
}
