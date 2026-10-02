//! `cq_*`: `conquest_model` shares the kernels' vector files (MC contract
//! §7: "its unit tests share control-vectors-v1.json and
//! keep-vectors-v1.json with the kernels"; integ-W1, review CQ1-C).
//!
//! Every case of `permutation-rules/vectors/keep-vectors-v1.json` and the
//! model-facing cases of `control-vectors-v1.json` are replayed through the
//! model's **byte-level** path: the keep codec (`write_keep` / `read_keep`
//! at the pinned offsets), the conquest step over a Province v2 buffer with
//! the capturers as roster entries (`step` → `entry::candidates` →
//! `keep::advance` → the donor hand-off), the quiet run bell by bell, the
//! Province-byte `control_weights` (site mirror tier / garrison / 1-based
//! order, the occupier's side, Free Cities neutral) and `dominion_lead`,
//! and the kernel bridge's `keep_tile` / `free_city_site` over terrain
//! bytes. Each must equal the kernel's recorded output.

use frontier_abi::conquest_model::{self as qm, BellReport, SiteReport, StepParams};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::kernel::control::Controller;
use frontier_abi::v2::kernel::keep::{self as kkeep, Keep, KeepParams};
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P, site as SM};
use frontier_abi::v2::layout::{write_header, AccountKind};
use frontier_abi::v2::log::event;
use frontier_abi::v2::presets::MC_LOCAL_7D;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::terrain::ProvinceTerrain;
use permutation_rules::map::Terrain;

// ------------------------------------------------------------ a small JSON reader

#[derive(Clone, Debug)]
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn get(&self, k: &str) -> &J {
        match self {
            J::Obj(v) => v
                .iter()
                .find(|(x, _)| x == k)
                .map(|(_, j)| j)
                .unwrap_or_else(|| panic!("no key {k}")),
            _ => panic!("not an object: {k}"),
        }
    }
    fn arr(&self) -> &[J] {
        match self {
            J::Arr(v) => v,
            _ => panic!("not an array"),
        }
    }
    fn num(&self) -> f64 {
        match self {
            J::Num(x) => *x,
            _ => panic!("not a number: {self:?}"),
        }
    }
    fn u(&self) -> u64 {
        let x = self.num();
        assert!(x >= 0.0 && x.fract() == 0.0, "{x}");
        x as u64
    }
    fn i(&self) -> i64 {
        let x = self.num();
        assert!(x.fract() == 0.0);
        x as i64
    }
    fn b(&self) -> bool {
        match self {
            J::Bool(x) => *x,
            _ => panic!("not a bool"),
        }
    }
    fn s(&self) -> &str {
        match self {
            J::Str(x) => x,
            _ => panic!("not a string: {self:?}"),
        }
    }
}

fn parse(text: &str) -> J {
    let b = text.as_bytes();
    let mut i = 0;
    let j = value(b, &mut i);
    ws(b, &mut i);
    assert_eq!(i, b.len(), "trailing JSON");
    j
}

fn ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && b[*i].is_ascii_whitespace() {
        *i += 1;
    }
}

fn value(b: &[u8], i: &mut usize) -> J {
    ws(b, i);
    match b[*i] {
        b'{' => {
            *i += 1;
            let mut v = Vec::new();
            ws(b, i);
            if b[*i] == b'}' {
                *i += 1;
                return J::Obj(v);
            }
            loop {
                ws(b, i);
                let k = match value(b, i) {
                    J::Str(s) => s,
                    x => panic!("key {x:?}"),
                };
                ws(b, i);
                assert_eq!(b[*i], b':');
                *i += 1;
                v.push((k, value(b, i)));
                ws(b, i);
                match b[*i] {
                    b',' => *i += 1,
                    b'}' => {
                        *i += 1;
                        return J::Obj(v);
                    }
                    c => panic!("object: {}", c as char),
                }
            }
        }
        b'[' => {
            *i += 1;
            let mut v = Vec::new();
            ws(b, i);
            if b[*i] == b']' {
                *i += 1;
                return J::Arr(v);
            }
            loop {
                v.push(value(b, i));
                ws(b, i);
                match b[*i] {
                    b',' => *i += 1,
                    b']' => {
                        *i += 1;
                        return J::Arr(v);
                    }
                    c => panic!("array: {}", c as char),
                }
            }
        }
        b'"' => {
            *i += 1;
            let s = *i;
            while b[*i] != b'"' {
                assert_ne!(b[*i], b'\\', "escapes are not used by the vector files");
                *i += 1;
            }
            let out = std::str::from_utf8(&b[s..*i]).unwrap().to_string();
            *i += 1;
            J::Str(out)
        }
        b't' => {
            *i += 4;
            J::Bool(true)
        }
        b'f' => {
            *i += 5;
            J::Bool(false)
        }
        b'n' => {
            *i += 4;
            J::Null
        }
        _ => {
            let s = *i;
            while *i < b.len() && matches!(b[*i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                *i += 1;
            }
            J::Num(std::str::from_utf8(&b[s..*i]).unwrap().parse().unwrap())
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|k| u8::from_str_radix(&s[2 * k..2 * k + 2], 16).unwrap())
        .collect()
}

// ------------------------------------------------------------ helpers

const KEEP_FILE: &str = include_str!("../../permutation-rules/vectors/keep-vectors-v1.json");
const CONTROL_FILE: &str = include_str!("../../permutation-rules/vectors/control-vectors-v1.json");

fn keep_of(j: &J) -> Keep {
    Keep {
        tile: j.get("tile").u() as u8,
        holder: j.get("holder").u() as u8,
        contender: j.get("contender").u() as u8,
        progress: j.get("progress").u() as u8,
        required: j.get("required").u() as u8,
        heartland_safe: j.get("heartland_safe").b(),
        paused: j.get("paused").b(),
        changes: j.get("changes").u() as u16,
        troops: j.get("troops").u() as u32,
        since_bell: j.get("since_bell").u() as u32,
        consolidated_until_bell: j.get("consolidated_until_bell").u() as u32,
        contest_from_bell: j.get("contest_from_bell").u() as u32,
        gen: j.get("gen").u() as u32,
        last_taken_from: j.get("last_taken_from").u() as u8,
    }
}

fn params_of(j: &J) -> KeepParams {
    KeepParams {
        bells: j.get("bells").u() as u8,
        consolidate_bells: j.get("consolidate_bells").u() as u32,
        home_guard: j.get("home_guard").u() as u32,
        garrison_bps: j.get("garrison_bps").u() as u16,
    }
}

fn step_params(kp: &KeepParams) -> StepParams {
    let mut cq = MC_LOCAL_7D.cq;
    cq.keep_bells = kp.bells as u16;
    cq.keep_consolidate_bells = kp.consolidate_bells as u16;
    cq.keep_home_guard = kp.home_guard;
    cq.keep_garrison_bps = kp.garrison_bps;
    assert_eq!(
        cq.keep_params(),
        *kp,
        "the season bytes carry the vector's params"
    );
    StepParams {
        genesis_ts: 1_788_998_400,
        end_bell: 1_000_000,
        cq,
    }
}

/// An empty Province v2 (no sites, no entries) with the keep written by the
/// model's codec.
fn province(k: &Keep) -> Vec<u8> {
    let mut pd = vec![0u8; P::SIZE];
    assert!(write_header(&mut pd, AccountKind::Province, 1));
    pd[P::SITE_COUNT] = 0;
    qm::write_keep(&mut pd, k).unwrap();
    pd
}

/// The bell's capturers as roster entries on the keep tile (entry index,
/// host id, milli-troops), every other entry free.
fn put_capturers(pd: &mut [u8], tile: u8, faction: u8, caps: &[J]) {
    pd[P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE].fill(0);
    for c in caps {
        let c = c.arr();
        let e = Entry {
            id: c[1].u(),
            faction,
            unit: 0, // Spearman: non-civilian
            tile,
            state: E::STATE_ROSTER,
            troops: c[2].u() as u32,
            stamina_value: 120,
            dealt_bps: 10_000,
            stamina_bell: 0,
            ready_bell: 0,
            from_bell: 0,
            pend_bell: 0,
            op: EntryOp::None,
        };
        write_entry(pd, c[0].u() as usize, &e).unwrap();
    }
}

fn keep_report(holders: u8, defender_present: bool) -> BellReport {
    BellReport {
        sites: [SiteReport::default(); P::SITES_N],
        keep: SiteReport {
            holders,
            defender_present,
        },
    }
}

/// Checks one bell's step output against the vector's event.
fn check_event(out: &qm::StepOut, ev: &J, caps: &[J], caps_after: &[J], what: &str) {
    let keep_events: Vec<_> = out
        .events()
        .iter()
        .filter(|e| e.site == event::KEEP_SITE)
        .copied()
        .collect();
    match ev.get("kind").s() {
        "none" => {
            assert!(keep_events.is_empty(), "{what}: {keep_events:?}");
            assert!(out.keep_taken.is_none(), "{what}");
        }
        "contest" => {
            assert_eq!(keep_events.len(), 1, "{what}");
            assert_eq!(keep_events[0].code, event::KEEP_CONTEST, "{what}");
            assert_eq!(
                keep_events[0].faction as u64,
                ev.get("faction").u(),
                "{what}"
            );
        }
        "broken" => {
            assert_eq!(keep_events.len(), 1, "{what}");
            assert_eq!(keep_events[0].code, event::KEEP_BROKEN, "{what}");
        }
        "taken" => {
            let t = out.keep_taken.expect(what);
            assert_eq!(t.from as u64, ev.get("from").u(), "{what}");
            assert_eq!(t.garrison as u64, ev.get("garrison").u(), "{what}");
            assert_eq!(t.donor_removed, ev.get("donor_removed").b(), "{what}");
            let donor = ev.get("donor").u();
            let id = caps
                .iter()
                .find(|c| c.arr()[0].u() == donor)
                .map(|c| c.arr()[1].u())
                .expect("the donor is a capturer");
            assert_eq!(t.donor_host_id, id, "{what}: the donor's host id");
            if !t.donor_removed {
                let rest = caps_after
                    .iter()
                    .find(|c| c.arr()[0].u() == donor)
                    .map(|c| c.arr()[2].u())
                    .expect("the donor stays a capturer");
                assert_eq!(t.donor_rest as u64, rest, "{what}: the donor's rest");
            }
            assert_eq!(keep_events.len(), 1, "{what}");
            assert_eq!(keep_events[0].code, event::KEEP_TAKEN, "{what}");
        }
        k => panic!("event kind {k}"),
    }
}

// ------------------------------------------------------------ keep vectors

/// The keep codec writes every field at its pinned offset and reads back
/// the kernel's struct, for every state the keep vectors record.
#[test]
fn cq_keep_codec_round_trips_every_vector_state() {
    let v = parse(KEEP_FILE);
    let mut states: Vec<Keep> = Vec::new();
    for s in v.get("scenarios").arr() {
        states.push(keep_of(s.get("open")));
        for b in s.get("bells").arr() {
            states.push(keep_of(b.get("keep")));
        }
    }
    let q = v.get("quiet");
    states.push(keep_of(q.get("keep")));
    states.push(keep_of(q.get("keep_after")));
    assert!(states.len() > 100);
    for k in &states {
        let pd = province(k);
        assert_eq!(qm::read_keep(&pd).unwrap(), Some(*k));
        let d = &pd[P::KEEP..P::KEEP + KP::SIZE];
        assert_eq!(d[KP::TILE], k.tile);
        assert_eq!(d[KP::HOLDER], k.holder);
        assert_eq!(d[KP::CONTENDER], k.contender);
        assert_eq!(d[KP::PROGRESS], k.progress);
        assert_eq!(d[KP::REQUIRED], k.required);
        assert_eq!(
            d[KP::FLAGS] & KP::FLAG_HEARTLAND_SAFE != 0,
            k.heartland_safe
        );
        assert_eq!(&d[KP::TROOPS..KP::TROOPS + 4], &k.troops.to_le_bytes());
        assert_eq!(&d[KP::GEN..KP::GEN + 4], &k.gen.to_le_bytes());
        assert_eq!(d[KP::LAST_TAKEN_FROM], k.last_taken_from);
        assert_eq!(qm::map_faction(&pd).unwrap(), Some(k.holder));
    }
}

/// `keep::open` through the bridge, then every bell of every scenario
/// through `conquest_model::step` on Province bytes: the keep after the
/// bell, the event, the donor's host id and rest, and the per-faction
/// keeps-taken counter equal the kernel's recording.
#[test]
fn cq_keep_scenarios_replay_through_the_step() {
    let v = parse(KEEP_FILE);
    let mut taken_seen = 0;
    for s in v.get("scenarios").arr() {
        let name = s.get("name").s();
        let kp = params_of(s.get("params"));
        let c = ProvinceCoord::new(s.get("p").i() as i32, s.get("q").i() as i32);
        let opened = kkeep::open(
            c,
            s.get("wedge").u() as u8,
            s.get("heartland_max_ring").u() as u8,
            s.get("tile").u() as u8,
            &kp,
            s.get("open_bell").u() as u32,
        )
        .expect("the vector's keep opens");
        assert_eq!(opened, keep_of(s.get("open")), "{name}: open");
        let prm = step_params(&kp);
        let mut pd = province(&opened);
        let mut taken_by = [0u16; 6];
        for bj in s.get("bells").arr() {
            let b = bj.get("bell").u() as u32;
            let what = format!("{name} bell {b}");
            let holders = bj.get("holders").u() as u8;
            let caps = bj.get("capturers").arr();
            let faction = if holders.count_ones() == 1 {
                holders.trailing_zeros() as u8
            } else {
                assert!(caps.is_empty(), "{what}");
                0
            };
            let tile = qm::read_keep(&pd).unwrap().unwrap().tile;
            put_capturers(&mut pd, tile, faction, caps);
            let rep = keep_report(holders, bj.get("defender_present").b());
            let out = qm::step(&mut pd, b, &rep, &prm).unwrap();
            check_event(
                &out,
                bj.get("event"),
                caps,
                bj.get("capturers_after").arr(),
                &what,
            );
            if let Some(t) = out.keep_taken {
                taken_by[t.to as usize] += 1;
                taken_seen += 1;
            }
            assert_eq!(
                qm::read_keep(&pd).unwrap(),
                Some(keep_of(bj.get("keep"))),
                "{what}: keep after the bell"
            );
            for (f, n) in taken_by.iter().enumerate() {
                let o = P::keeps_taken_by(f);
                assert_eq!(u16::from_le_bytes([pd[o], pd[o + 1]]), *n, "{what}");
            }
        }
    }
    assert!(taken_seen >= 4, "the vectors take keeps");
}

/// The quiet run (`advance_quiet` in the kernel's recording) replayed bell
/// by bell through the step with the quiet model's keep report (the mask
/// of factions on the keep tile): the same events at the same bells and
/// the same keep and donor rest at its end.
#[test]
fn cq_keep_quiet_vector_replays_bell_by_bell() {
    let v = parse(KEEP_FILE);
    let q = v.get("quiet");
    let kp = params_of(q.get("params"));
    let prm = step_params(&kp);
    let k0 = keep_of(q.get("keep"));
    let mut pd = province(&k0);
    let mask = q.get("mask").u() as u8;
    let caps = q.get("capturers").arr();
    let (b0, through) = (q.get("b0").u() as u32, q.get("through").u() as u32);
    let evs: Vec<(u32, &J)> = q
        .get("events")
        .arr()
        .iter()
        .map(|e| (e.get("bell").u() as u32, e.get("event")))
        .collect();
    for b in b0..=through {
        let k = qm::read_keep(&pd).unwrap().unwrap();
        let hb = 1u8 << k.holder;
        let holders = mask & !hb;
        let faction = holders.trailing_zeros() as u8;
        put_capturers(&mut pd, k.tile, faction, caps);
        let out = qm::step(&mut pd, b, &keep_report(holders, mask & hb != 0), &prm).unwrap();
        let what = format!("quiet bell {b}");
        match evs.iter().find(|e| e.0 == b) {
            Some((_, ev)) => check_event(&out, ev, caps, q.get("capturers_after").arr(), &what),
            None => check_event(&out, &parse("{\"kind\": \"none\"}"), caps, caps, &what),
        }
    }
    assert_eq!(
        qm::read_keep(&pd).unwrap(),
        Some(keep_of(q.get("keep_after")))
    );
}

/// The bridge's `keep_tile` (the MC keep tile, `keep_tile_symmetric`,
/// v1.3 PO-5) and `free_city_site` over the vectors' terrain bytes
/// (`map::Terrain as u8`); the v1.2 column `keep_tile` is the kernel's
/// wedge-0 scan.
#[test]
fn cq_keep_tile_and_free_city_site_vectors_through_the_bridge() {
    let v = parse(KEEP_FILE);
    let all = [
        Terrain::Grassland,
        Terrain::Plains,
        Terrain::Forest,
        Terrain::Hills,
        Terrain::Mountain,
        Terrain::Water,
    ];
    for t in v.get("tiles").arr() {
        let bytes = hex(t.get("terrain").s());
        let sites_v = hex(t.get("sites").s());
        let mut terrain = [Terrain::Grassland; 61];
        for (i, &x) in bytes.iter().enumerate() {
            terrain[i] = *all.iter().find(|y| **y as u8 == x).expect("terrain byte");
        }
        let mut sites = [0u8; 12];
        sites.copy_from_slice(&sites_v);
        let pt = ProvinceTerrain {
            terrain,
            resource: [None; 61],
            sites,
            site_count: t.get("site_count").u() as u8,
        };
        let wedge = t.get("wedge").u() as u8;
        let want = t.get("keep_tile_symmetric");
        let got = kkeep::keep_tile(&pt, &pt.sites, pt.site_count, wedge);
        match want {
            J::Null => assert_eq!(got, None),
            w => assert_eq!(got, Some(w.u() as u8)),
        }
        // the v1.2 column: the kernel's scan of the province's own indices
        let bytes61: [u8; 61] = bytes.as_slice().try_into().unwrap();
        let scan = permutation_rules::frontier::keep::keep_tile(&bytes61, &pt.sites, pt.site_count);
        assert_eq!(scan.map(u64::from), Some(t.get("keep_tile").u()));
        if wedge == 0 {
            assert_eq!(got, scan);
        }
        let seed: [u8; 32] = hex(t.get("ring_seed").s()).try_into().unwrap();
        let c = ProvinceCoord::new(t.get("p").i() as i32, t.get("q").i() as i32);
        assert_eq!(
            permutation_rules::frontier::terrain::free_city_site(&seed, c, pt.site_count) as u64,
            t.get("free_city_site").u()
        );
    }
}

// ------------------------------------------------------------ control vectors

/// `control_weights` over Province bytes: one site per case with the
/// vector's tier, garrison and **1-based** order in the site mirror (the
/// model's order adaptation), on the owner's side; while occupied on the
/// occupier's; a Free City (order 1) on the neutral side.
#[test]
fn cq_control_weights_equal_site_weight_centi_vectors() {
    let v = parse(CONTROL_FILE);
    let cases = v.get("site_weight_centi").arr();
    assert!(cases.len() >= 48);
    for c in cases {
        let (tier, garrison, order) = (
            c.get("tier").u() as u8,
            c.get("garrison").u() as u32,
            c.get("order").u() as u8,
        );
        let want = c.get("centi").u() as u32;
        let mut pd = vec![0u8; P::SIZE];
        assert!(write_header(&mut pd, AccountKind::Province, 1));
        pd[P::SITE_COUNT] = 1;
        let o = P::site(0);
        pd[o + SM::STATE] = SM::STATE_HOLDING;
        pd[o + SM::FACTION] = 2;
        pd[o + SM::ORDER] = order;
        pd[o + SM::TIER] = tier;
        pd[o + SM::TIER_NEXT] = SM::NO_TIER_NEXT;
        pd[o + SM::GARRISON..o + SM::GARRISON + 4].copy_from_slice(&garrison.to_le_bytes());
        let w = qm::control_weights(&pd, 6).unwrap();
        let mut exp = [0u32; P::SIDES];
        exp[2] = want;
        assert_eq!(w, exp, "{c:?}");
        // occupied by faction 4: the weight moves to the occupier.
        let r = P::record(0);
        pd[r + CR::KIND] = CR::KIND_OCCUPATION;
        pd[r + CR::FACTION] = 4;
        let w = qm::control_weights(&pd, 6).unwrap();
        let mut exp = [0u32; P::SIDES];
        exp[4] = want;
        assert_eq!(w, exp, "occupied {c:?}");
        if order == 1 {
            // a Free City of that tier and garrison: neutral, order 1.
            pd[r..r + CR::SIZE].fill(0);
            pd[o + SM::STATE] = SM::STATE_FREE_CITY;
            let w = qm::control_weights(&pd, 6).unwrap();
            let mut exp = [0u32; P::SIDES];
            exp[6] = want;
            assert_eq!(w, exp, "Free City {c:?}");
        }
    }
}

/// `dominion_lead` (§3.10's strict rule) equals the kernel's recorded
/// controller for every weight vector.
#[test]
fn cq_dominion_lead_equals_controller_vectors() {
    let v = parse(CONTROL_FILE);
    for c in v.get("controller").arr() {
        let w: Vec<u32> = c
            .get("weights")
            .arr()
            .iter()
            .map(|x| x.u() as u32)
            .collect();
        let w: [u32; P::SIDES] = w.try_into().unwrap();
        let got = qm::dominion_lead(&w);
        let want = c.get("controller");
        match want {
            J::Str(s) if s == "unsettled" => assert_eq!(got, Controller::Unsettled, "{w:?}"),
            J::Str(s) if s == "contested" => assert_eq!(got, Controller::Contested, "{w:?}"),
            J::Num(_) => assert_eq!(got, Controller::Side(want.u() as u8), "{w:?}"),
            x => panic!("controller {x:?}"),
        }
    }
}
