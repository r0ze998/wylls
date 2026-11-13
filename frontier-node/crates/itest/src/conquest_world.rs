//! **`local-conquest-test-v1` preset, pure parts** (feature
//! `localnet-conquest-play`): the timing check of a preset Season against the
//! program's own bounds, the earliest time a bell can be resolved, the Free
//! City read-back from a Province the program opened, and the runner's
//! capability statement (`CLAUDE-LOCAL-CONQUEST-PRESET-PLAN-20261112.md`).
//!
//! **Design result (recorded, not worked around), on a NATURAL clock:**
//! DeclareSiege requires the standing province resolved through the current
//! bell (`wide_conquest_exec.rs`: `RESOLVED_NEXT < bell` → `NotResident`). On a
//! natural clock (chain time ≈ real time) a bell's tlock round does not exist
//! before the bell ends, so its anchor lands after the bell ends. (The program
//! checks `round_is_due` only in `test-beacon` builds; production relies on
//! future drand signatures not existing. A chain clock held BEHIND real time,
//! where later rounds are already public, is an artificial condition this
//! result does not cover and the keeper does not use: it anchors ended bells
//! only.) The reveal window closes `W` after that anchor; the seed is a round
//! at least `Δ` after the close; Resolve needs the seed. With the program's own
//! bounds (`WINDOW_MIN` = 600 ≤ W, `SEED_MARGIN_MIN` = 60 ≤ Δ) and the rules'
//! fixed `BELL_SECS` = 600, the previous bell resolves at the earliest
//! `W + Δ ≥ 660 s` after it ended, after the current bell ended too. So in this
//! LOCAL RESIDENT PROGRESSION (the province opened earlier and resolved bell by
//! bell) the immediate-declaration window does not open ([`declaration_window`]
//! ≤ 0 over the whole valid range: tests), and with the approved reservation
//! rule (B) such a declaration becomes a reservation for its bell. Not every
//! state: `OpenProvince` sets the cursor to the opening bell, so a province
//! opened in the current bell can take the immediate path (exercised only as a
//! synthetic branch). A preset may not use a window below
//! `WINDOW_MIN` (the program's SetWindowSchedule / Season bound): that would be
//! a silent loosening of a safety condition, refused by [`timing_valid`].
//! Opening declarations needs a decision on the program's rule, not a preset.
use frontier_abi::v2::layout::province::{province as PV, site as SM};
use permutation_rules::frontier::beacon::{self, first_round_from, reveal_close, round_time, SEED_MARGIN_MIN, WINDOW_MAX, WINDOW_MIN};
use permutation_rules::frontier::travel::BELL_SECS;
use serde_json::{json, Value};

pub const PRESET: &str = "local-conquest-test-v1";
pub const CAPABILITY_SCHEMA: &str = "frontier-local-play-conquest-capability-v1";
pub const MARKERS: [&str; 2] = ["PSF_LOCALNET_EXPEDITION_SBF_BUILD", "PSF_LOCALNET_CONQUEST_SBF_BUILD"];
/// The runner flag that asks for this preset (launcher: `--world-preset`).
pub const FLAG: &str = "--world-preset";

/// The preset's rule bytes: the expedition world's [`crate::wide_destination::RULES`]
/// with only the Free City rule changed to the ABI's existing
/// `CanonicalHashV1` (the program's own OpenProvince then places it). No other
/// rule, Season field or gate differs.
pub const RULES: frontier_abi::world_index::rules::RuleBytes = frontier_abi::world_index::rules::RuleBytes {
    free_city: frontier_abi::world_index::rules::FreeCityRule::CanonicalHashV1 as u8,
    ..crate::wide_destination::RULES
};

/// Removes `--world-preset <value>` from the runner's arguments (at most once)
/// and returns it; the rest goes to the unchanged parser. An unknown preset,
/// a repeated flag or a missing value is refused.
pub fn split_world_preset(args: Vec<String>) -> Result<(Option<String>, Vec<String>), String> {
    let mut preset = None;
    let mut rest = Vec::with_capacity(args.len());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == FLAG {
            let v = it.next().ok_or(format!("{FLAG} takes exactly `{PRESET}`"))?;
            if v != PRESET {
                return Err(format!("{FLAG} takes exactly `{PRESET}`"));
            }
            if preset.replace(v).is_some() {
                return Err(format!("{FLAG} given twice"));
            }
        } else {
            rest.push(a);
        }
    }
    Ok((preset, rest))
}

/// The artefact this start verified (its sha256), re-read and re-hashed here:
/// the same bytes must carry each of the two lane markers exactly once.
pub fn markers_ok(bytes: &[u8], verified_sha256: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if hex::encode(Sha256::digest(bytes)) != verified_sha256 {
        return Err("the artefact read again is not the one this start verified".into());
    }
    for m in MARKERS {
        let n = bytes.windows(m.len()).filter(|w| *w == m.as_bytes()).count();
        if n != 1 {
            return Err(format!("the artefact carries {m} {n} times, not exactly once"));
        }
    }
    Ok(())
}

/// The preset's opening and its read-back: the real ConsumeRingSeed /
/// SetRules([`RULES`]) / WideOpenProvince (`wide_destination::run_with_rules`,
/// whose progress lines `report` prints, the `opened` line included), then the
/// destination Province read from this chain, its Free City found, and this
/// start's capability statement built from this start's own facts (artefact
/// sha, program, Season, RPC of its first line). No Free City: an error, no
/// statement.
#[allow(clippy::too_many_arguments)]
pub async fn open(state: localnet::server::Shared, plan: crate::wide_destination::Plan, artifact_sha256: &str, program: &str, season: &str, rpc: &str,
    stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Value)) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    let season_key = plan.season;
    let opened = crate::wide_destination::run_with_rules(state.clone(), plan, RULES, stop, report).await?;
    let (province, _) = crate::wide_destination::dest_accounts(&season_key)?;
    let (pd, slot) = {
        let c = localnet::server::lock(&state);
        let acc = c.account(&province).ok_or("the destination Province is absent after its opening")?;
        if acc.owner.to_bytes() != crate::expedition_play::PROGRAM {
            return Err("the destination Province is not the program's".into());
        }
        (acc.data, c.slot())
    };
    let city = free_city_of(&pd)?;
    let (p, q) = crate::wide_destination::DEST;
    let evidence = json!({
        "consume_ring_seed": opened["signatures"]["consume_ring_seed"], "set_rules": opened["signatures"]["set_rules"],
        "open_province": opened["signatures"]["open_province"],
        "province_sha256_at_open": opened["accounts"]["province"]["sha256"], "rules_config_sha256": opened["accounts"]["rules_config"]["sha256"],
        "province_sha256_read": hex::encode(Sha256::digest(&pd)), "read_slot": slot,
    });
    capability(artifact_sha256, &MARKERS, program, season, rpc, p, q, &city, evidence)
}

/// A Season's bell clock (its own fields).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub bell_secs: u32,
    pub reveal_window: u32,
    pub seed_margin: u32,
    pub drand_genesis: i64,
    pub drand_period: u32,
    pub genesis_ts: i64,
}

impl Timing {
    /// The S1_LOCAL_7D clock the runner's Season uses, genesis aligned as the
    /// fixture aligns it (a round time + 600).
    pub fn s1_local_7d(genesis_round: u64) -> Timing {
        let p = frontier_abi::v2::presets::S1_LOCAL_7D.base;
        Timing { bell_secs: p.bell_secs, reveal_window: p.reveal_window, seed_margin: p.seed_margin, drand_genesis: p.drand_genesis,
            drand_period: p.drand_period, genesis_ts: round_time(p.drand_genesis, p.drand_period, genesis_round) + 600 }
    }
}

/// The program's own bounds; anything else is refused, never used.
pub fn timing_valid(t: &Timing) -> Result<(), String> {
    if t.bell_secs as i64 != BELL_SECS {
        return Err(format!("bell_secs {} is not the rules' fixed {BELL_SECS}", t.bell_secs));
    }
    if !beacon::window_valid(t.reveal_window) {
        return Err(format!("reveal_window {} is outside the program's {WINDOW_MIN}..={WINDOW_MAX}", t.reveal_window));
    }
    if t.seed_margin < SEED_MARGIN_MIN {
        return Err(format!("seed_margin {} is below the program's {SEED_MARGIN_MIN}", t.seed_margin));
    }
    Ok(())
}

fn bell_start(t: &Timing, b: u32) -> i64 {
    t.genesis_ts + b as i64 * t.bell_secs as i64
}

/// The earliest chain time bell `b` can be resolved: its anchor lands when
/// its tlock round (the first round at or after the bell's end) is due, plus
/// `delay` (the keeper's tick and transport); the window closes `W` later; the
/// seed round is the first round at or after `close + Δ` and must be due;
/// Resolve then needs `delay` again.
pub fn earliest_resolution(t: &Timing, b: u32, delay: i64) -> i64 {
    let end = bell_start(t, b + 1);
    let anchor = round_time(t.drand_genesis, t.drand_period, first_round_from(t.drand_genesis, t.drand_period, end)) + delay;
    let close = reveal_close(anchor, t.reveal_window);
    let seed = round_time(t.drand_genesis, t.drand_period, first_round_from(t.drand_genesis, t.drand_period, close + t.seed_margin as i64));
    seed + delay + delay
}

/// Seconds during bell `b + 1` in which every bell before it is resolved
/// (DeclareSiege's precondition), at the earliest; `≤ 0`: never.
pub fn declaration_window(t: &Timing, b: u32, delay: i64) -> i64 {
    bell_start(t, b + 2) - earliest_resolution(t, b, delay)
}

/// The Free City of a Province the program opened (`STATE_FREE_CITY` in its
/// site mirror): the lowest such site, its tile, and how many there are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FreeCity {
    pub site: u8,
    pub tile: u8,
    pub count: u8,
}

pub fn free_city_of(pd: &[u8]) -> Result<FreeCity, String> {
    let n = *pd.get(PV::SITE_COUNT).ok_or("province bytes")? as usize;
    if n > PV::SITES_N {
        return Err(format!("site count {n} is past the table"));
    }
    let cities: Vec<u8> = (0..n).filter(|&i| pd.get(PV::site(i) + SM::STATE) == Some(&SM::STATE_FREE_CITY)).map(|i| i as u8).collect();
    let site = *cities.first().ok_or("NoFreeCityAtDestination: the opened Province has no Free City site")?;
    let tile = *pd.get(PV::SITES + site as usize).ok_or("province bytes")?;
    Ok(FreeCity { site, tile, count: cities.len() as u8 })
}

/// The runner's capability statement: public facts only, every value read
/// from this start (the artefact's recomputed SHA and markers, the chain's
/// own records). `markers` must be exactly both, in order.
#[allow(clippy::too_many_arguments)]
pub fn capability(artifact_sha256: &str, markers: &[&str], program: &str, season: &str, rpc: &str, p: i64, q: i64, city: &FreeCity, evidence: Value)
    -> Result<Value, String> {
    if markers != MARKERS {
        return Err("the artefact does not carry exactly both lane markers".into());
    }
    if artifact_sha256.len() != 64 || !artifact_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("artefact sha256".into());
    }
    Ok(json!({"schema": CAPABILITY_SCHEMA, "artifact_sha256": artifact_sha256, "markers": MARKERS, "program": program, "season": season,
        "rpc": rpc, "world_preset": PRESET, "free_city": {"p": p.to_string(), "q": q.to_string(), "site": city.site, "tile": city.tile},
        "free_city_count": city.count, "evidence": evidence,
        "not_claimed": "an isolated local test arrangement; no Free City rule of the real game is decided; in this local resident progression the immediate-declaration path is not reached (a declaration becomes a reservation for its bell); not a claim about every state or Season timing"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In the local resident progression (anchors only after their bell ends,
    /// the province opened earlier), no valid timing opens an immediate-
    /// declaration window, at any bell, with any keeper delay (the whole valid range of W in 60 s steps, margins up to
    /// 600 s). The S1_LOCAL_7D clock is one point of it (the keeper's time
    /// model measured 0/720 ticks).
    #[test]
    fn no_valid_season_timing_opens_a_declaration_window() {
        let base = Timing::s1_local_7d(30_913_000);
        assert!(timing_valid(&base).is_ok());
        let mut checked = 0;
        for w in (WINDOW_MIN..=WINDOW_MAX).step_by(60) {
            for m in [SEED_MARGIN_MIN, 61, 90, 120, 300, 600] {
                let t = Timing { reveal_window: w, seed_margin: m, ..base };
                assert!(timing_valid(&t).is_ok());
                for b in [10u32, 11, 37, 500] {
                    for delay in [0i64, 1, 10, 30] {
                        let win = declaration_window(&t, b, delay);
                        assert!(win <= 0, "W {w} Δ {m} bell {b} delay {delay}: window {win}");
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 1000);
        // the S1_LOCAL_7D point: the previous bell resolves at least 60 s after the current one ended
        assert!(declaration_window(&base, 20, 0) <= -60);
    }

    /// The formula is not trivially non-positive: a window below the
    /// program's bound WOULD open declarations, and exactly such a timing is
    /// refused (a preset cannot use it without loosening a safety bound).
    #[test]
    fn only_an_invalid_window_would_open_declarations_and_it_is_refused() {
        let base = Timing::s1_local_7d(30_913_000);
        let short = Timing { reveal_window: 300, ..base };
        assert!(declaration_window(&short, 20, 10) > 200, "{}", declaration_window(&short, 20, 10));
        assert!(timing_valid(&short).unwrap_err().contains("outside the program's"));
        assert!(timing_valid(&Timing { seed_margin: 30, ..base }).is_err());
        assert!(timing_valid(&Timing { bell_secs: 900, ..base }).is_err(), "the rules' bell is fixed");
        assert!(timing_valid(&Timing { reveal_window: WINDOW_MAX + 1, ..base }).is_err());
        // boundary: the window never grows with W, Δ or the delay, and a 1 s
        // longer window costs at most one drand period (seed rounds are 3 s apart)
        let w = |t: &Timing, d| declaration_window(t, 20, d);
        let (a, b) = (w(&short, 10), w(&Timing { reveal_window: 301, ..base }, 10));
        assert!(b <= a && a - b <= base.drand_period as i64, "{a} → {b}");
        assert!(w(&Timing { seed_margin: 120, ..short }, 10) < a);
        assert!(w(&short, 40) < a);
        // and the existing preset is unchanged
        let p = frontier_abi::v2::presets::S1_LOCAL_7D.base;
        assert_eq!((p.bell_secs, p.reveal_window, p.seed_margin), (600, 600, 60));
    }

    fn province(sites: &[(u8, u8)]) -> Vec<u8> {
        let mut pd = vec![0u8; frontier_abi::v2::layout::AccountKind::Province.size()];
        pd[PV::SITE_COUNT] = sites.len() as u8;
        for (i, (state, tile)) in sites.iter().enumerate() {
            pd[PV::site(i) + SM::STATE] = *state;
            pd[PV::SITES + i] = *tile;
        }
        pd
    }

    #[test]
    fn the_free_city_is_read_back_from_the_opened_province_only() {
        assert_eq!(free_city_of(&province(&[(SM::STATE_FREE, 3), (SM::STATE_FREE_CITY, 43)])), Ok(FreeCity { site: 1, tile: 43, count: 1 }));
        assert_eq!(free_city_of(&province(&[(SM::STATE_FREE_CITY, 7), (SM::STATE_HOLDING, 9), (SM::STATE_FREE_CITY, 43)])),
            Ok(FreeCity { site: 0, tile: 7, count: 2 }), "the lowest, with the count");
        assert!(free_city_of(&province(&[(SM::STATE_FREE, 3), (SM::STATE_HOLDING, 9)])).unwrap_err().starts_with("NoFreeCityAtDestination"));
        // a city past the site count is not a site
        let mut pd = province(&[(SM::STATE_FREE, 3)]);
        pd[PV::site(1) + SM::STATE] = SM::STATE_FREE_CITY;
        assert!(free_city_of(&pd).is_err());
        let mut bad = province(&[]);
        bad[PV::SITE_COUNT] = PV::SITES_N as u8 + 1;
        assert!(free_city_of(&bad).is_err());
        // the expedition world's rule is unchanged: no Free City there
        assert_eq!(crate::wide_destination::RULES.free_city, frontier_abi::world_index::rules::FreeCityRule::NoFreeCity as u8);
    }

    #[test]
    fn the_preset_flag_is_split_off_exactly_and_the_rules_differ_only_in_the_free_city() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (p, rest) = split_world_preset(a(&["--rpc-port", "41931", FLAG, PRESET, "--keeper", "public-quicknet"])).unwrap();
        assert_eq!(p.as_deref(), Some(PRESET));
        assert_eq!(rest, a(&["--rpc-port", "41931", "--keeper", "public-quicknet"]));
        assert_eq!(split_world_preset(a(&["--rpc-port", "41931"])).unwrap(), (None, a(&["--rpc-port", "41931"])), "absent: unchanged");
        assert!(split_world_preset(a(&[FLAG, "other"])).is_err());
        assert!(split_world_preset(a(&[FLAG])).is_err());
        assert!(split_world_preset(a(&[FLAG, PRESET, FLAG, PRESET])).is_err());
        let w = crate::wide_destination::RULES;
        assert_eq!((RULES.keep_holder, RULES.camp, RULES.region), (w.keep_holder, w.camp, w.region));
        assert_eq!(RULES.free_city, frontier_abi::world_index::rules::FreeCityRule::CanonicalHashV1 as u8);
        assert_ne!(RULES.free_city, w.free_city);
        // the SetRules of each carries its own bytes; the expedition one is unchanged
        let s = fclient::Address::new_from_array([3; 32]);
        let d = |ix: fclient::Instruction| frontier_abi::world_index::wide_ix::WideCommand::decode(&ix.data).map(|c| match c {
            frontier_abi::world_index::wide_ix::WideCommand::SetRules(x) => x.free_city,
            _ => 255,
        });
        assert_eq!(d(crate::wide_destination::set_rules_ix(&s, &s)), Ok(w.free_city));
        assert_eq!(d(crate::wide_destination::set_rules_ix_with(&s, &s, &RULES)), Ok(RULES.free_city));
    }

    #[test]
    fn the_artefact_must_carry_each_marker_exactly_once() {
        use sha2::{Digest, Sha256};
        let sha = |b: &[u8]| hex::encode(Sha256::digest(b));
        let both = [b"xx".as_slice(), MARKERS[0].as_bytes(), b"yy", MARKERS[1].as_bytes()].concat();
        assert_eq!(markers_ok(&both, &sha(&both)), Ok(()));
        assert!(markers_ok(&both, &"00".repeat(32)).unwrap_err().contains("not the one"));
        let one = [b"xx".as_slice(), MARKERS[0].as_bytes()].concat();
        assert!(markers_ok(&one, &sha(&one)).is_err(), "an expedition-only artefact");
        let twice = [both.as_slice(), MARKERS[1].as_bytes()].concat();
        assert!(markers_ok(&twice, &sha(&twice)).is_err(), "a marker twice");
    }

    #[test]
    fn the_capability_is_exactly_the_published_shape() {
        let city = FreeCity { site: 3, tile: 43, count: 1 };
        let sha = "ab".repeat(32);
        let v = capability(&sha, &MARKERS, "P", "S", "http://127.0.0.1:41931", 129, 0, &city, json!({"open_province": "sig"})).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["schema", "artifact_sha256", "markers", "program", "season", "rpc", "world_preset", "free_city", "evidence"] {
            assert!(keys.contains(&k), "{k}");
        }
        assert_eq!(v["schema"], CAPABILITY_SCHEMA);
        assert_eq!(v["world_preset"], PRESET);
        assert_eq!(v["markers"], json!(MARKERS));
        assert_eq!(v["free_city"], json!({"p": "129", "q": "0", "site": 3, "tile": 43}));
        // one marker, swapped markers, a bad SHA: no capability
        assert!(capability(&sha, &MARKERS[..1], "P", "S", "r", 129, 0, &city, json!({})).is_err());
        assert!(capability(&sha, &[MARKERS[1], MARKERS[0]], "P", "S", "r", 129, 0, &city, json!({})).is_err());
        assert!(capability("xyz", &MARKERS, "P", "S", "r", 129, 0, &city, json!({})).is_err());
    }
}
