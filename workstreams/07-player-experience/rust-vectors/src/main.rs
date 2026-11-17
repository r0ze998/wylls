//! Workstream 07: the vectors of the S1 walk rules, from the shared rules
//! crate (the program, verifier and keeper call the same functions).
//! `cargo run --release > ../vectors/s1-walk-v1.json`
use permutation_rules::frontier::caravan::{fastest_path, pack, schedule, walk, Land};
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::structure::{
    caravan_watch, coverage, march_watch, stops, watch, wear, wear_bps, Stances, Walked, WatchedLand,
    KIND_FORT, KIND_PALISADE, KIND_TOWER, NATIONS, STANCE_WAR,
};
use permutation_rules::frontier::travel::is_cavalry;
use permutation_rules::units::UnitType;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

fn walked(w: Option<Walked>) -> String {
    match w {
        None => "null".into(),
        Some(Walked::Blocked) => "\"blocked\"".into(),
        Some(Walked::Secs(s)) => format!("{s}"),
    }
}

fn main() {
    let mut out = String::from("{\"v\":1,\"source\":\"permutation-rules structure.rs, caravan.rs (workstream 07 rust-vectors)\",");
    // the coverage table and the wear curve
    let cov: Vec<String> = (0u8..61).map(|t| format!("\"{}\"", coverage(t))).collect();
    out += &format!("\"coverage\":[{}],", cov.join(","));
    let wears: Vec<String> = [0u32, 1, 59, 60, 61, 119, 120, 600, 1079, 1080, 1081, 1799, 1800, 1801, 5000]
        .iter().map(|&s| format!("[{s},{}]", wear_bps(s))).collect();
    out += &format!("\"wearBps\":[{}],", wears.join(","));
    let worn: Vec<String> = [(1000u64, 0u16), (1000, 3000), (999, 1), (100_000, 2999), (7, 3000), (12345, 10_001)]
        .iter().map(|&(v, b)| format!("[{v},{b},{}]", wear(v, b))).collect();
    out += &format!("\"wear\":[{}],", worn.join(","));
    let units = [UnitType::Spearman, UnitType::Archer, UnitType::Horseman, UnitType::Pikeman, UnitType::Crossbowman, UnitType::Knight, UnitType::Scout, UnitType::Settler];
    out += &format!("\"cavalry\":[{}],", units.iter().map(|u| is_cavalry(*u).to_string()).collect::<Vec<_>>().join(","));

    // the stop rule over every pair, with a mixed stance table
    let mut r = Rng(7007);
    let mut st: Stances = [STANCE_WAR; NATIONS * NATIONS];
    for x in st.iter_mut() { *x = (r.below(3)) as u8; }
    let mut stops_rows = Vec::new();
    for n in 0u8..7 { for f in 0u8..7 { for e in [false, true] {
        stops_rows.push(format!("[{n},{f},{},{}]", e as u8, stops(&st, n, f, e) as u8));
    } } }
    out += &format!("\"stances\":[{}],\"stops\":[{}],", st.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","), stops_rows.join(","));

    // random walks: four Provinces around the origin's, structures, paths
    let mut cases = Vec::new();
    let around = [(0i32, 0i32), (1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];
    for case in 0..240 {
        let base = ProvinceCoord::new(r.below(5) as i32 - 2, r.below(5) as i32 - 2);
        let mut provs = Vec::new();
        for (dp, dq) in around { provs.push(ProvinceCoord::new(base.p + dp, base.q + dq)); }
        let mut lands_json = Vec::new();
        let mut lands = Vec::new();
        let mut wl = Vec::new();
        let faction = r.below(6) as u8;
        let expelled = r.below(5) == 0;
        for pc in &provs {
            // mostly passable, some rough and road
            let passable = !(r.next() & r.next() & r.next()) & ((1u64 << 61) - 1);
            let rough = r.next() & r.next();
            let road = r.next() & r.next() & r.next();
            let mut list = Vec::new();
            let n = r.below(9);
            for _ in 0..n {
                let kind = [KIND_TOWER, KIND_PALISADE, KIND_FORT][r.below(3) as usize];
                let tile = r.below(61) as u8;
                let nation = r.below(7) as u8; // 6 = outside the table
                list.extend_from_slice(&[kind, tile, nation, 0]);
            }
            let w = watch(&list, &st, faction, expelled);
            lands_json.push(format!(
                "{{\"p\":{},\"q\":{},\"passable\":\"{passable}\",\"rough\":\"{rough}\",\"road\":\"{road}\",\"structures\":[{}],\"wear\":\"{}\",\"block\":\"{}\"}}",
                pc.p, pc.q,
                list.chunks(4).map(|e| format!("{{\"kind\":{},\"tile\":{},\"faction\":{}}}", e[0], e[1], e[2])).collect::<Vec<_>>().join(","),
                w.wear, w.block
            ));
            lands.push((*pc, passable, rough, road, w));
            wl.push(WatchedLand { at: *pc, rough, road, watch: w });
        }
        let otile = r.below(61) as u8;
        let dst = provs[r.below(7) as usize];
        let dtile = r.below(61) as u8;
        // the fastest road with every land as it is, and with the stopped palisades removed
        let plain: Vec<Land> = lands.iter().map(|l| Land { at: l.0, passable: l.1, rough: l.2, road: l.3 }).collect();
        let masked: Vec<Land> = lands.iter().map(|l| Land { at: l.0, passable: l.1 & !l.4.block, rough: l.2, road: l.3 }).collect();
        let fp = |ls: &[Land]| -> String {
            match fastest_path((base, otile), (dst, dtile), ls) {
                None => "null".into(),
                Some((d, _)) => format!("[{}]", d.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")),
            }
        };
        let raw = fastest_path((base, otile), (dst, dtile), &plain);
        let cavalry = r.below(3) == 0;
        let (mw, cw) = match &raw {
            Some((dirs, ps)) if !dirs.is_empty() => {
                let on_path: Vec<Land> = ps.iter().filter_map(|pc| plain.iter().find(|l| l.at == *pc).copied()).collect();
                let path = pack(dirs).unwrap();
                let m = march_watch((base, otile), &path, dirs.len() as u8, &wl, cavalry);
                let bps = if r.below(2) == 0 { 10_000 } else { 8_000 };
                let ws = walk((base, otile), &path, dirs.len() as u8, &on_path[..], bps).ok();
                let c = ws.as_ref().map(|steps| {
                    caravan_watch(steps, |pc| lands.iter().find(|l| l.0 == pc).map_or(Default::default(), |l| l.4))
                });
                let genesis = 1_700_000_000i64 + r.below(600) as i64;
                let depart = genesis + r.below(144 * 600 * 3) as i64;
                let sch = match &ws {
                    None => "null".to_string(),
                    Some(steps) => match schedule(genesis, depart, (base, otile), steps) {
                        Err(_) => "\"tooSlow\"".to_string(),
                        Ok(runs) => format!("[{}]", runs.iter().map(|x| format!("{{\"p\":{},\"q\":{},\"firstBell\":{},\"tiles\":[{}]}}", x.province.p, x.province.q, x.first_bell, x.tiles.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(","))).collect::<Vec<_>>().join(",")),
                    },
                };
                let at: String = ws.as_ref().map_or("null".into(), |st| format!("[{}]", st.iter().map(|x| x.at_secs.to_string()).collect::<Vec<_>>().join(",")));
                (walked(m), format!("{{\"bps\":{bps},\"walked\":{},\"atSecs\":{at},\"genesis\":{genesis},\"depart\":{depart},\"schedule\":{sch}}}", walked(c)))
            }
            _ => ("null".into(), "null".into()),
        };
        cases.push(format!(
            "{{\"case\":{case},\"faction\":{faction},\"expelled\":{expelled},\"origin\":{{\"p\":{},\"q\":{},\"tile\":{otile}}},\"dst\":{{\"p\":{},\"q\":{},\"tile\":{dtile}}},\"lands\":[{}],\"fastest\":{},\"fastestAvoiding\":{},\"cavalry\":{cavalry},\"march\":{mw},\"caravan\":{cw}}}",
            base.p, base.q, dst.p, dst.q, lands_json.join(","), fp(&plain), fp(&masked)
        ));
    }
    out += &format!("\"walks\":[{}]}}", cases.join(","));
    println!("{out}");
}
