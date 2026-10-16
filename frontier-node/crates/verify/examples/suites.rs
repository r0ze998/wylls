//! Runs the V1–V13 suite and the conquest audit separately over one saved
//! input and prints each suite's findings by code (a diagnostic, not the
//! verifier): `cargo run --release --example suites -- INPUT.json.gz`.
use std::collections::BTreeMap;
use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("usage: suites INPUT.json[.gz]");
    let input = verify_core::Input::load(Path::new(&path)).unwrap_or_else(|e| panic!("{e}"));
    for (name, r) in [
        ("V1-V13", verify_core::checks::run(&input)),
        ("conquest", verify_core::conquest::verify(&input)),
    ] {
        let mut by: BTreeMap<String, (usize, String)> = BTreeMap::new();
        for f in &r.findings {
            let e = by
                .entry(format!("{} {} {:?}", f.check, f.code, f.severity))
                .or_insert((0, f.detail.clone()));
            e.0 += 1;
        }
        println!("== {name}: {} ({} findings)", r.verdict.name(), r.findings.len());
        for (k, (n, d)) in by {
            println!("  {k} ×{n}: {}", d.chars().take(160).collect::<String>());
        }
    }
}
