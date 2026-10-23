//! Runs the V1–V13 suite and the conquest audit separately over one saved
//! input and prints each suite's findings by code (a diagnostic, not the
//! verifier): `cargo run --release --example suites -- INPUT.json.gz`;
//! with `--detail` every finding is printed (entity, bell, transaction).
use std::collections::BTreeMap;
use std::path::Path;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: suites INPUT.json[.gz] [--detail]");
    let detail = std::env::args().any(|a| a == "--detail");
    let input = verify_core::Input::load(Path::new(&path)).unwrap_or_else(|e| panic!("{e}"));
    if detail {
        let w = verify_core::world::World::parse(
            &input.cfg.program,
            &input.txs,
            input.finals.clone(),
            input.final_slot,
        );
        let mut by: BTreeMap<&str, usize> = BTreeMap::new();
        for r in &w.recs {
            *by.entry(r.kind.name()).or_default() += 1;
        }
        for r in &w.cq_recs {
            *by.entry(r.kind.name()).or_default() += 1;
        }
        let list: Vec<String> = by.iter().map(|(k, n)| format!("{k} {n}")).collect();
        println!("== records ({} txs): {}", w.txs.len(), list.join(", "));
    }
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
        println!(
            "== {name}: {} ({} findings)",
            r.verdict.name(),
            r.findings.len()
        );
        for (k, (n, d)) in by {
            println!("  {k} ×{n}: {}", d.chars().take(160).collect::<String>());
        }
        if detail {
            for f in &r.findings {
                println!(
                    "    {} {} {:?} {} bell {} sig {}: {}",
                    f.check,
                    f.code,
                    f.severity,
                    f.entity,
                    f.bell,
                    f.signature.chars().take(12).collect::<String>(),
                    f.detail
                );
            }
        }
    }
}
