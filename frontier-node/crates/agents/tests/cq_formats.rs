//! The bots' readers of the herald's MC files (MC contract v1.3 §8.4,
//! CF-1…CF-8) against the format vectors the herald's `cqfmt.rs` writes
//! (`frontier-node/fixtures/cq/formats/`): every valid file decodes to the
//! canonical form the vectors print, and the invalid files the bots'
//! readers check are refused.

use frontier_agents::cqobs::{ControlFile, Overview2, SiegesFile};
use serde_json::Value;

fn dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cq/formats")
}

fn vectors() -> Value {
    let t = std::fs::read_to_string(dir().join("vectors.json")).expect("vectors.json");
    serde_json::from_str(&t).expect("json")
}

fn file(name: &str) -> Vec<u8> {
    std::fs::read(dir().join(name)).expect(name)
}

fn n(v: &Value) -> i64 {
    v.as_i64().expect("int")
}

#[test]
fn cq_control_files_decode_to_the_canonical_form() {
    let v = vectors();
    let mut seen = 0;
    for x in v["valid"].as_array().unwrap() {
        if x["format"] != "control" {
            continue;
        }
        let c = ControlFile::decode(&file(x["file"].as_str().unwrap())).unwrap();
        let d = &x["decoded"];
        assert_eq!(c.bell as i64, n(&d["bell"]));
        assert_eq!(c.rings as i64, n(&d["rings"]));
        assert_eq!(c.season.to_string(), d["season"].as_str().unwrap());
        let ps = d["provinces"].as_array().unwrap();
        assert_eq!(c.provinces.len(), ps.len());
        for (p, w) in c.provinces.iter().zip(ps) {
            let w: Vec<i64> = w.as_array().unwrap().iter().map(n).collect();
            assert_eq!(
                vec![
                    p.index as i64,
                    p.coord.p as i64,
                    p.coord.q as i64,
                    p.control as i64,
                    p.contender as i64,
                    p.progress as i64,
                    p.required as i64,
                    p.flags as i64,
                    p.sieges as i64,
                    p.occupations as i64,
                    p.points_lead as i64,
                    p.points_share as i64,
                ],
                w
            );
        }
        let ms = d["marches"].as_array().unwrap();
        assert_eq!(c.marches.len(), ms.len());
        for (m, w) in c.marches.iter().zip(ms) {
            let w: Vec<i64> = w.as_array().unwrap().iter().map(n).collect();
            assert_eq!(
                vec![
                    m.march.m as i64,
                    m.march.n as i64,
                    m.banner as i64,
                    m.points_lead as i64,
                    m.keeps as i64,
                    m.flags as i64,
                ],
                w
            );
        }
        seen += 1;
    }
    assert!(seen >= 3);
}

#[test]
fn cq_overview2_files_decode_to_the_canonical_form() {
    let v = vectors();
    let mut seen = 0;
    for x in v["valid"].as_array().unwrap() {
        if x["format"] != "overview2" {
            continue;
        }
        let bytes = file(x["file"].as_str().unwrap());
        let o = Overview2::decode(&bytes).unwrap();
        let d = &x["decoded"];
        assert_eq!(o.bell as i64, n(&d["bell"]));
        let ps = d["provinces"].as_array().unwrap();
        assert_eq!(o.provinces.len(), ps.len());
        for (i, (r, w)) in o.provinces.iter().zip(ps).enumerate() {
            assert_eq!((r.v1.p as i64, r.v1.q as i64), (n(&w["p"]), n(&w["q"])));
            let arr = |k: &str| -> Vec<i64> { w[k].as_array().unwrap().iter().map(n).collect() };
            let bools = |k: &str| -> Vec<bool> {
                w[k].as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_bool().unwrap())
                    .collect()
            };
            assert_eq!(r.occupiers.map(|x| x as i64).to_vec(), arr("occupiers"));
            assert_eq!(r.sieges.map(|x| x as i64).to_vec(), arr("sieges"));
            assert_eq!(r.kinds.map(|x| x as i64).to_vec(), arr("kinds"));
            assert_eq!(r.immune.to_vec(), bools("immune"));
            assert_eq!(r.keep_tile.map(|t| t as i64), w["keepTile"].as_i64());
            assert_eq!(r.keep_troops as i64, n(&w["keepTroops"]));
            // Bytes 0–23 are exactly the v1 record.
            let o0 = 32 + 40 * i;
            assert_eq!(hex::encode(&bytes[o0..o0 + 24]), w["v1"].as_str().unwrap());
        }
        seen += 1;
    }
    assert!(seen >= 2);
}

#[test]
fn cq_sieges_files_parse() {
    for name in ["sieges-b400.json", "sieges-empty.json"] {
        let v: Value = serde_json::from_slice(&file(name)).unwrap();
        let s = SiegesFile::parse(&v).unwrap();
        let want = v["sieges"].as_array().map_or(0, |a| a.len());
        assert_eq!(s.sieges.len(), want, "{name}");
        assert_eq!(
            s.keeps.len(),
            v["keeps"].as_array().map_or(0, |a| a.len()),
            "{name}"
        );
        for (r, w) in s.sieges.iter().zip(v["sieges"].as_array().unwrap()) {
            assert_eq!(r.declared as i64, n(&w["declared"]));
            assert_eq!(r.paused, w["status"] == "paused");
        }
    }
}

/// The invalid files whose defect the bots' readers check (magic, length,
/// reserved bytes, the province and March counts, the occupier and keep
/// tile ranges) are refused.
#[test]
fn cq_invalid_files_the_readers_check_are_refused() {
    let v = vectors();
    let mut refused = 0;
    for x in v["invalid"].as_array().unwrap() {
        let f = x["file"].as_str().unwrap();
        let code = x["code"].as_str().unwrap();
        let checked = matches!(code, "BadMagic" | "BadLength" | "BadReserved" | "BadShape")
            || f == "bad-overview2-occupier.bin"
            || f == "bad-overview2-keeptile.bin";
        if !checked {
            continue;
        }
        let r = match x["format"].as_str().unwrap() {
            "control" => ControlFile::decode(&file(f)).err(),
            "overview2" => Overview2::decode(&file(f)).err(),
            _ => continue,
        };
        assert!(r.is_some(), "{f} ({code}) decoded");
        refused += 1;
    }
    assert!(refused >= 10, "{refused}");
}
