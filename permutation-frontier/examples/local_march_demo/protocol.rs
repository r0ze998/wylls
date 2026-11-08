//! Bounded stdio protocol `wylls-local-march-v3` (see
//! `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`).
//!
//! ONE session: the village economy (Harvest, Farm, Train), the march
//! lifecycle on the same holding bytes, and (v3) opening further ring-129
//! provinces with the real WideOpenProvince over the LOCAL land records,
//! under one revision and one simulated clock. Every mutation stages a
//! complete copy of the sandbox, runs real handlers on it, renders and bounds
//! the candidate response, and only then commits images, clock, counters and
//! revision together.
use crate::engine::{
    hex, Quote, Sandbox, ECONOMY_PER_INSTANT, FARM_ITEM, FINAL_BELL, GENESIS, MAX_ROUTE_DIRS,
    TRAIN_COUNT, TRAIN_UNIT,
};
use crate::land_bootstrap as land;
use frontier_abi::world_index::{WideHolding, WideProvince, WideRingSeed};
use permutation_frontier::layout::player::{accrual as AC, queue_item as QI};
use permutation_frontier::layout::{holding as H, province as PV, Ro};
use std::fmt::Write;

pub const PROTOCOL: &str = "wylls-local-march-v3";
/// Land-opening refusals decided before any dispatch: fixed tokens, nothing
/// staged or committed.
pub const LAND_REFUSALS: [&str; 7] = [
    "LAND_COORD_BOUNDS",
    "LAND_NOT_RING_129",
    "LAND_DUPLICATE_OPEN",
    "LAND_BUDGET",
    "LAND_IMAGE_BOUND",
    "LAND_RING_UNSEEDED",
    "LAND_TIME_BEFORE_GENESIS",
];
/// The token of a land evidence label (`EVIDENCE_LABELS`, text before `:`).
fn land_token(record: &str) -> &'static str {
    land::EVIDENCE_LABELS
        .iter()
        .find(|(k, _)| *k == record)
        .map(|(_, v)| v.split(':').next().unwrap_or("").trim())
        .unwrap_or("MISSING_LABEL")
}
/// A canonical revision (0..=9999999, no leading zero).
fn canonical_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= 7
        && !(rev.len() > 1 && rev.starts_with('0'))
        && rev.bytes().all(|b| b.is_ascii_digit())
}
/// A canonical signed decimal coordinate (`0` or `-?[1-9][0-9]*`, ≤ 19
/// digits) that parses as `i64`; the ±2^62 bound is `WideCoord::checked`'s.
fn canonical_coord(s: &str) -> Option<i64> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    if digits.is_empty()
        || digits.len() > 19
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.starts_with('0') && (digits.len() > 1 || s.starts_with('-')))
    {
        return None;
    }
    s.parse::<i64>().ok()
}
/// How a land-opening error is reported: status, fixed token, program code.
fn classify_land(e: &str) -> (&'static str, &'static str, Option<u32>) {
    if let Some(t) = LAND_REFUSALS.iter().find(|t| **t == e) {
        return ("refused", *t, None);
    }
    if let Some(rest) = e.strip_prefix("LAND_OPEN_REFUSED:") {
        if rest.starts_with("Refused_") {
            return classify(rest);
        }
    }
    ("fault", "EXECUTION_FAULT", None)
}
pub const SESSION: &str = "integrated-economy-march-same-holding";
pub const REVISION_LIMIT: u64 = 1_000_000;
/// Every mutating command token (each takes exactly one canonical REV).
pub const COMMANDS: [&str; 10] = [
    "reset",
    "depart",
    "settle_departure",
    "post_reveal",
    "resolve_arrival",
    "settle_transit",
    "dissolve_return",
    "harvest",
    "build_farm",
    "train",
];

pub struct Controller {
    pub sandbox: Sandbox,
    pub revision: u64,
}

/// How a sandbox error is reported: status, fixed token, program code.
fn classify(e: &str) -> (&'static str, &'static str, Option<u32>) {
    if e == "BAD_PHASE" {
        ("refused", "BAD_PHASE", None)
    } else if e == "INSTANT_BUDGET" {
        ("refused", "INSTANT_BUDGET", None)
    } else if let Some(rest) = e.strip_prefix("Refused_") {
        // runtime: `Refused_<custom code>` or `Refused_Runtime`, then `:<handler>`
        let code = rest.split(':').next().and_then(|d| {
            if !d.is_empty() && d.len() <= 10 && d.bytes().all(|b| b.is_ascii_digit()) {
                d.parse::<u32>().ok()
            } else {
                None
            }
        });
        ("refused", "HANDLER_REFUSED", code)
    } else {
        ("fault", "EXECUTION_FAULT", None)
    }
}

impl Controller {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            sandbox: Sandbox::new()?,
            revision: 0,
        })
    }
    pub fn reject(&self, error: &str) -> Result<String, String> {
        self.render("refused", Some(error), None, "invalid", false, None)
    }
    pub fn exchange(&mut self, line: &str) -> Result<String, String> {
        self.exchange_with_limit(line, 1_048_576)
    }
    fn exchange_with_limit(&mut self, line: &str, limit: usize) -> Result<String, String> {
        if line.len() > 128 || !line.bytes().all(|b| (32..=126).contains(&b)) {
            return self.reject("BAD_COMMAND");
        }
        if line == "get" {
            return self.render("ok", None, None, "get", false, None);
        }
        // A non-mutating route quote: `quote_route DIRS`, DIRS a 1..=32 string
        // of directions 0..5. It changes no account, clock, phase, revision or
        // record; it validates a chosen path over the real opened-province
        // bytes and never executes a march.
        if let Some(arg) = line.strip_prefix("quote_route ") {
            if arg.is_empty()
                || arg.len() > MAX_ROUTE_DIRS
                || !arg.bytes().all(|b| (b'0'..=b'5').contains(&b))
            {
                return self.reject("BAD_COMMAND");
            }
            let dirs: Vec<u8> = arg.bytes().map(|b| b - b'0').collect();
            return match self.sandbox.quote_route(&dirs) {
                Ok(q) => self.render("ok", None, None, "quote_route", false, Some(&q)),
                Err(e) => {
                    eprintln!("local_march_demo: quote_route: {e}");
                    self.render(
                        "fault",
                        Some("EXECUTION_FAULT"),
                        None,
                        "quote_route",
                        false,
                        None,
                    )
                }
            };
        }
        // Open a ring-129 province: `open_province REV P Q`, P and Q canonical
        // signed decimals. Revisioned and atomic like every mutation: staged
        // on a copy, the real handler judged by the land module, the reply
        // rendered and bounded, then committed with revision + 1.
        if let Some(rest) = line.strip_prefix("open_province ") {
            let parts: Vec<&str> = rest.split(' ').collect();
            let coords = match parts.as_slice() {
                [rev, p, q] if canonical_rev(rev) => canonical_coord(p)
                    .zip(canonical_coord(q))
                    .map(|c| (*rev, c)),
                _ => None,
            };
            let Some((rev, (p, q))) = coords else {
                return self.reject("BAD_COMMAND");
            };
            return self.open(rev, p, q, limit);
        }
        let (cmd, rev) = match line.split_once(' ') {
            Some(v) => v,
            None => return self.reject("BAD_COMMAND"),
        };
        if !COMMANDS.contains(&cmd) || !canonical_rev(rev) {
            return self.reject("BAD_COMMAND");
        }
        if rev.parse::<u64>().ok() != Some(self.revision) {
            return self.render("refused", Some("STALE_REVISION"), None, cmd, false, None);
        }
        if self.revision >= REVISION_LIMIT {
            return self.render("refused", Some("REVISION_LIMIT"), None, cmd, false, None);
        }
        let mut candidate = Self {
            sandbox: self.sandbox.clone(),
            revision: self.revision + 1,
        };
        let outcome = if cmd == "reset" {
            match Sandbox::new() {
                Ok(x) => {
                    candidate.sandbox = x;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        } else {
            candidate.sandbox.apply(cmd)
        };
        match outcome {
            Ok(()) => {
                let reply = candidate.render("ok", None, None, cmd, cmd != "reset", None)?;
                if reply.len() > limit {
                    return self.render("fault", Some("RESPONSE_LIMIT"), None, cmd, false, None);
                }
                *self = candidate;
                Ok(reply)
            }
            Err(e) => {
                eprintln!("local_march_demo: {cmd}: {e}");
                let (status, token, code) = classify(&e);
                self.render(status, Some(token), code, cmd, false, None)
            }
        }
    }
    /// `open_province REV P Q` (already syntax-checked): the revision gate,
    /// then the land module's staged real opening on a candidate copy, the
    /// reply rendered and bounded, and only then the commit. A refusal or a
    /// fault leaves images, clock, counters and revision as they were.
    fn open(&mut self, rev: &str, p: i64, q: i64, limit: usize) -> Result<String, String> {
        const CMD: &str = "open_province";
        if rev.parse::<u64>().ok() != Some(self.revision) {
            return self.render("refused", Some("STALE_REVISION"), None, CMD, false, None);
        }
        if self.revision >= REVISION_LIMIT {
            return self.render("refused", Some("REVISION_LIMIT"), None, CMD, false, None);
        }
        let mut candidate = Self {
            sandbox: self.sandbox.clone(),
            revision: self.revision + 1,
        };
        match candidate.sandbox.open_province(p, q) {
            Ok(_) => {
                let reply = candidate.render("ok", None, None, CMD, true, None)?;
                if reply.len() > limit {
                    return self.render("fault", Some("RESPONSE_LIMIT"), None, CMD, false, None);
                }
                *self = candidate;
                Ok(reply)
            }
            Err(e) => {
                eprintln!("local_march_demo: {CMD}: {e}");
                let (status, token, code) = classify_land(&e);
                self.render(status, Some(token), code, CMD, false, None)
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn render(
        &self,
        status: &str,
        error: Option<&str>,
        refusal: Option<u32>,
        command: &str,
        new_records: bool,
        quote: Option<&Quote>,
    ) -> Result<String, String> {
        let s = &self.sandbox;
        let hd = s.data("holding")?;
        let h = WideHolding::read(hd).map_err(|_| "HOLDING")?;
        let hr = Ro(hd);
        let host = s.host()?;
        let od = s.data("origin")?;
        let dd = s.data("destination")?;
        let origin = WideProvince::read(od).map_err(|_| "ORIGIN")?;
        let dest = WideProvince::read(dd).map_err(|_| "DESTINATION")?;
        let mut out = String::with_capacity(65536);
        write!(
            out,
            "{{\"protocol\":\"{PROTOCOL}\",\"mode\":\"local-only\",\"auth\":\"MOCK_AUTH_NO_SIGNATURE\",\"beacon\":\"PUBLIC_FIXTURES_REAL_VERIFICATION\",\"session\":\"{SESSION}\",\"status\":\"{status}\",\"error\":{},\"refusalCode\":{},\"command\":\"{command}\",\"revision\":{},\"phase\":\"{}\",\"allowed\":[",
            error.map_or("null".into(), |s| format!("\"{s}\"")),
            refusal.map_or("null".into(), |n| n.to_string()),
            self.revision,
            s.phase
        )
        .unwrap();
        for (i, a) in s.allowed().iter().enumerate() {
            if i > 0 {
                out.push(',')
            }
            write!(out, "\"{a}\"").unwrap()
        }
        let bell = (s.now - GENESIS) / 600;
        let prepared = s.num("arrive_bell")?.checked_sub(1).ok_or("ARRIVE_BELL")?;
        write!(
            out,
            "],\"clock\":{{\"unix\":\"{}\",\"bell\":{bell}}},\"horizon\":{{\"model\":\"PHASE_STEPS_ONLY\",\"finalBell\":{FINAL_BELL},\"destinationPreparedThroughBell\":{prepared},\"originResolvedNext\":{},\"destinationResolvedNext\":{}}}",
            s.now,
            Ro(od).u32(PV::RESOLVED_NEXT).map_err(|_| "ORIGIN")?,
            Ro(dd).u32(PV::RESOLVED_NEXT).map_err(|_| "DESTINATION")?
        )
        .unwrap();
        write!(
            out,
            ",\"economy\":{{\"perInstantBudget\":{ECONOMY_PER_INSTANT},\"usedThisInstant\":{},\"harvests\":{},\"farmBuilds\":{},\"trains\":{},\"farmItem\":{FARM_ITEM},\"trainUnit\":{TRAIN_UNIT},\"trainCount\":{TRAIN_COUNT}}}",
            s.instant_used, s.harvests, s.farm_builds, s.trains
        )
        .unwrap();
        village(&mut out, hd)?;
        land_json(&mut out, s)?;
        write!(
            out,
            ",\"map\":{{\"worldHex\":\"{}\",\"origin\":{{\"p\":\"{}\",\"q\":\"{}\"}},\"destination\":{{\"p\":\"{}\",\"q\":\"{}\"}},\"route\":[",
            hex(origin.world.as_bytes()),
            origin.coord.p(),
            origin.coord.q(),
            dest.coord.p(),
            dest.coord.q()
        )
        .unwrap();
        for (i, step) in s.meta.get("route").ok_or("ROUTE")?.split(';').enumerate() {
            let p: Vec<_> = step.split(',').collect();
            if p.len() != 3 {
                return Err("ROUTE".into());
            }
            let (a, b, t) = (
                p[0].parse::<i64>().map_err(|_| "ROUTE")?,
                p[1].parse::<i64>().map_err(|_| "ROUTE")?,
                p[2].parse::<u8>().map_err(|_| "ROUTE")?,
            );
            if i > 0 {
                out.push(',')
            }
            write!(out, "{{\"p\":\"{a}\",\"q\":\"{b}\",\"tile\":{t}}}").unwrap()
        }
        // Every province the host holds, each decoded from its own bytes:
        // the two exported fixtures first, then those opened this session.
        out.push_str("],\"provinces\":[");
        for (i, k) in s.provinces()?.iter().enumerate() {
            if i > 0 {
                out.push(',')
            }
            write!(
                out,
                "{{\"p\":\"{}\",\"q\":\"{}\",\"accountKeyHex\":\"{}\",\"passableMask\":\"{}\",\"source\":\"{}\",\"openedBell\":{},\"resolvedNext\":{},\"wedge\":{},\"region\":{}}}",
                k.province.coord.p(),
                k.province.coord.q(),
                hex(&s.images[&k.name].key),
                k.passable_mask,
                k.source,
                k.opened_bell,
                k.resolved_next,
                k.province.wedge,
                k.province.region
            )
            .unwrap()
        }
        let transit = match s.phase {
            "ready" => "absent",
            "departed" => "departed",
            "travelling" | "revealed" | "resolved" => "settled",
            _ => "closed",
        };
        // The ABI constant, never inferred by the UI.
        let fate = if s.arrival_survivors.is_some() {
            frontier_abi::world_index::arrival::wide_arrival::FATE_STAYS.to_string()
        } else {
            "null".into()
        };
        write!(
            out,
            "]}},\"host\":{{\"refHex\":\"{}\",\"originTile\":{},\"destinationTile\":{},\"initialMilli\":300000,\"currentMilli\":{},\"transitState\":\"{transit}\",\"fate\":{fate}}}",
            hex(&host.to_bytes()),
            s.num("origin_tile")?,
            s.num("destination_tile")?,
            s.current_milli()?
        )
        .unwrap();
        write!(
            out,
            ",\"holding\":{{\"accountKeyHex\":\"{}\",\"tile\":{},\"reserveUnits\":{},\"escrowLamports\":\"{}\",\"poolOwedLamports\":\"{}\",\"openTransits\":{}}}",
            hex(&s.images["holding"].key),
            hd[H::TILE],
            hr.u32(H::reserve(0)).map_err(|_| "HOLDING")?,
            hr.u64(H::ESCROW).map_err(|_| "HOLDING")?,
            hr.u64(H::POOL_OWED).map_err(|_| "HOLDING")?,
            h.open_transits
        )
        .unwrap();
        write!(
            out,
            ",\"combat\":{{\"engagements\":{},\"arrivalSurvivorMilli\":{},\"enemyFixture\":true}},\"returned\":{{\"creditedUnits\":{},\"creditedMilli\":{}}},\"evidence\":{{\"instructions\":[",
            s.engagements,
            s.arrival_survivors.map_or("null".into(), |x| x.to_string()),
            s.credited,
            s.credited * 1000
        )
        .unwrap();
        if new_records {
            for (i, n) in s.instructions.iter().enumerate() {
                if i > 0 {
                    out.push(',')
                }
                write!(out, "\"{n}\"").unwrap()
            }
        }
        out.push_str("],\"recordsHex\":[");
        if new_records {
            for (i, r) in s.records.iter().enumerate() {
                if i > 0 {
                    out.push(',')
                }
                write!(out, "\"{}\"", hex(r)).unwrap()
            }
        }
        out.push_str("],\"accounts\":[");
        for (i, a) in s.images.values().enumerate() {
            if i > 0 {
                out.push(',')
            }
            write!(
                out,
                "{{\"keyHex\":\"{}\",\"ownerHex\":\"{}\",\"lamports\":\"{}\",\"dataHex\":\"{}\"}}",
                hex(&a.key),
                hex(&a.owner),
                a.lamports,
                hex(&a.data)
            )
            .unwrap()
        }
        // close the accounts array and the evidence object
        out.push_str("]}");
        match quote {
            Some(q) => render_quote(&mut out, q),
            None => out.push_str(",\"routeQuote\":null"),
        }
        // close the root object
        out.push('}');
        Ok(out)
    }
}

/// The LOCAL land records and the opening budget. Keys name accounts that
/// are in `evidence.accounts`, so the browser re-reads every claimed number
/// (ring, seed, round, provinces created, rule bytes, fund wedges) from the
/// bytes. The provenance values are the land module's fixed evidence tokens.
fn land_json(out: &mut String, s: &Sandbox) -> Result<(), String> {
    let seed_im = s
        .images
        .get(land::RING_SEED_NAME)
        .ok_or("LAND_RING_SEED_RECORD")?;
    let seed = WideRingSeed::read(&seed_im.data).map_err(|_| "LAND_RING_SEED_RECORD")?;
    let rules = s
        .images
        .get(land::RULES_CONFIG_NAME)
        .ok_or("LAND_RULES_CONFIG")?;
    write!(
        out,
        ",\"land\":{{\"ring\":{},\"budget\":{},\"opened\":{},\"provincesCreated\":{},\"ringSeedKeyHex\":\"{}\",\"rulesConfigKeyHex\":\"{}\",\"fundKeysHex\":[",
        land::LAND_RING,
        land::MAX_EXTRA_PROVINCES,
        s.opened_count(),
        seed.provinces_created,
        hex(&seed_im.key),
        hex(&rules.key)
    )
    .unwrap();
    for w in 0..6u8 {
        let f = s
            .images
            .get(&land::fund_name(w))
            .ok_or("LAND_FUND_RECORD")?;
        if w > 0 {
            out.push(',')
        }
        write!(out, "\"{}\"", hex(&f.key)).unwrap();
    }
    write!(
        out,
        "],\"provenance\":{{\"ringSeed\":\"{}\",\"rules\":\"{}\",\"funds\":\"{}\",\"golden\":\"{}\",\"opened\":\"{}\",\"resolveHistory\":\"{}\",\"auth\":\"{}\",\"budget\":\"{}\"}}}}",
        land_token("land_ring_seed_129"),
        land_token("land_rules_config"),
        land_token("land_fund_*"),
        land_token("golden_gate"),
        land_token("land_province_*"),
        land_token("resolve_history"),
        land_token("auth"),
        land_token("budget")
    )
    .unwrap();
    Ok(())
}

/// Renders the read-only route quote (`Sandbox::quote_route`). Every number
/// is the host's own: start/end tiles, per-step province/tile/known/passable
/// (passability from the real mask), the refusal reason and the provinces the
/// route enters. The browser never computes these.
fn render_quote(out: &mut String, q: &Quote) {
    write!(
        out,
        ",\"routeQuote\":{{\"start\":{{\"p\":\"{}\",\"q\":\"{}\",\"tile\":{}}},\"reachable\":{},\"reason\":{},\"blockedStep\":{},\"steps\":[",
        q.start.0,
        q.start.1,
        q.start.2,
        q.reachable,
        q.reason.map_or("null".into(), |r| format!("\"{r}\"")),
        q.blocked_step.map_or("null".into(), |n| n.to_string())
    )
    .unwrap();
    for (i, s) in q.steps.iter().enumerate() {
        if i > 0 {
            out.push(',')
        }
        write!(
            out,
            "{{\"p\":\"{}\",\"q\":\"{}\",\"tile\":{},\"known\":{},\"passable\":{}}}",
            s.p,
            s.q,
            s.tile,
            s.known,
            s.passable.map_or("null".into(), |b| b.to_string())
        )
        .unwrap();
    }
    out.push_str("],\"end\":");
    match q.end {
        Some((p, qq, t)) => write!(out, "{{\"p\":\"{p}\",\"q\":\"{qq}\",\"tile\":{t}}}").unwrap(),
        None => out.push_str("null"),
    }
    out.push_str(",\"provincesEntered\":[");
    for (i, (p, qq)) in q.provinces.iter().enumerate() {
        if i > 0 {
            out.push(',')
        }
        write!(out, "{{\"p\":\"{p}\",\"q\":\"{qq}\"}}").unwrap();
    }
    out.push_str("]}");
}

/// The holding's village fields, read from its bytes as stored. Stores are
/// the values at their own `t0` (the last settle); nothing is projected to
/// the current clock here or anywhere else in this process.
fn village(out: &mut String, hd: &[u8]) -> Result<(), String> {
    let r = Ro(hd);
    let i64_at = |o: usize| r.i64(o).map_err(|_| "VILLAGE".to_string());
    let u32_at = |o: usize| r.u32(o).map_err(|_| "VILLAGE".to_string());
    let u8_at = |o: usize| r.u8(o).map_err(|_| "VILLAGE".to_string());
    write!(
        out,
        ",\"village\":{{\"tier\":{},\"flags\":{},\"lastOwnerAction\":\"{}\",\"stores\":[",
        u8_at(H::TIER)?,
        u8_at(H::FLAGS)?,
        i64_at(H::LAST_OWNER_ACTION)?
    )
    .unwrap();
    for i in 0..H::STORES_N {
        let o = H::store(i);
        if i > 0 {
            out.push(',')
        }
        write!(
            out,
            "{{\"value\":\"{}\",\"rate\":\"{}\",\"cap\":\"{}\",\"t0\":\"{}\"}}",
            i64_at(o + AC::VALUE)?,
            i64_at(o + AC::RATE)?,
            i64_at(o + AC::CAP)?,
            i64_at(o + AC::T0)?
        )
        .unwrap()
    }
    out.push_str("],\"production\":[");
    for i in 0..H::STORES_N {
        if i > 0 {
            out.push(',')
        }
        write!(out, "\"{}\"", i64_at(H::PRODUCTION + 8 * i)?).unwrap()
    }
    out.push_str("],\"queue\":[");
    for i in 0..H::QUEUE_N {
        let o = H::queue(i);
        if i > 0 {
            out.push(',')
        }
        write!(
            out,
            "{{\"doneAt\":\"{}\",\"kind\":{},\"arg\":{},\"delta\":\"{}\"}}",
            i64_at(o + QI::DONE_AT)?,
            u8_at(o + QI::KIND)?,
            u8_at(o + QI::ARG)?,
            i64_at(o + QI::DELTA)?
        )
        .unwrap()
    }
    out.push_str("],\"reserve\":[");
    for i in 0..H::RESERVE_N {
        if i > 0 {
            out.push(',')
        }
        write!(out, "{}", u32_at(H::reserve(i))?).unwrap()
    }
    out.push_str("]}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ok(c: &mut Controller, cmd: &str) -> String {
        let reply = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
        assert!(
            reply.contains("\"status\":\"ok\""),
            "{cmd} failed; see stderr"
        );
        reply
    }
    fn finish(economy: bool) -> Controller {
        let mut c = Controller::new().unwrap();
        for cmd in [
            "depart",
            "train",
            "settle_departure",
            "post_reveal",
            "resolve_arrival",
            "settle_transit",
            "dissolve_return",
        ] {
            if cmd == "train" && !economy {
                continue;
            }
            ok(&mut c, cmd);
        }
        c
    }
    #[test]
    fn real_full_sequence_with_train() {
        let c = finish(true);
        assert_eq!(c.sandbox.phase, "returned");
        assert!(c.sandbox.credited > 0 && c.sandbox.credited < 300);
        assert_eq!(c.sandbox.trains, 1);
        assert!(c.sandbox.engagements > 0);
    }
    #[test]
    fn real_full_sequence_without_train() {
        let c = finish(false);
        assert_eq!(c.sandbox.phase, "returned");
        assert_eq!(c.sandbox.trains, 0);
    }
    #[test]
    fn refuses_stale_invalid_phase_and_bad_command_without_mutation() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        for cmd in [
            "depart 1",
            "harvest 1",
            "settle_transit 0",
            "dissolve_return 0",
            "depart 00",
            "harvest 01",
            "run 0",
            "build 0",
            "build_farm 0 1",
            "depart 0 extra",
            "advance 0",
        ] {
            let r = c.exchange(cmd).unwrap();
            assert!(r.contains("\"status\":\"refused\""), "{cmd}");
            assert_eq!(c.sandbox.images, pre);
            assert_eq!(c.revision, 0);
            assert_eq!(c.sandbox.now, crate::engine::INITIAL);
        }
    }
    #[test]
    fn refuses_failed_depart_without_committing() {
        let mut c = Controller::new().unwrap();
        c.sandbox.images.get_mut("payer").unwrap().lamports = 0;
        let pre = c.sandbox.images.clone();
        let r = c.exchange("depart 0").unwrap();
        assert!(!r.contains("\"status\":\"ok\""));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.revision, 0);
    }
    #[test]
    fn settlement_binding_mismatch_rolls_back() {
        let mut c = Controller::new().unwrap();
        for cmd in [
            "depart",
            "settle_departure",
            "post_reveal",
            "resolve_arrival",
        ] {
            ok(&mut c, cmd);
        }
        c.sandbox.meta.insert("commit".into(), "00".repeat(32));
        let pre = c.sandbox.images.clone();
        let rev = c.revision;
        let r = c.exchange(&format!("settle_transit {rev}")).unwrap();
        assert!(!r.contains("\"status\":\"ok\""));
        assert_eq!(pre, c.sandbox.images);
        assert_eq!(rev, c.revision);
    }
}

#[cfg(test)]
mod atomic_tests {
    use super::*;
    #[test]
    fn oversized_render_does_not_commit_successful_depart() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        let old = c.sandbox.now;
        let r = c.exchange_with_limit("depart 0", 1).unwrap();
        assert!(r.contains("RESPONSE_LIMIT"));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.sandbox.now, old);
        assert_eq!(c.sandbox.phase, "ready");
        assert_eq!(c.revision, 0);
    }
    #[test]
    fn middle_phase_refusal_discards_seed_gather_clock_and_receipts() {
        let mut c = Controller::new().unwrap();
        for cmd in ["depart", "settle_departure", "post_reveal"] {
            let r = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
            assert!(r.contains("\"status\":\"ok\""));
        }
        let off = frontier_abi::v2::layout::province::province::SCORE_NEXT_BELL;
        c.sandbox.images.get_mut("destination").unwrap().data[off..off + 4]
            .copy_from_slice(&0u32.to_le_bytes());
        let pre = c.sandbox.images.clone();
        let old = c.sandbox.now;
        let rev = c.revision;
        let r = c.exchange(&format!("resolve_arrival {rev}")).unwrap();
        assert!(r.contains("HANDLER_REFUSED"));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.sandbox.now, old);
        assert_eq!(c.sandbox.phase, "revealed");
        assert_eq!(c.revision, rev);
        assert!(r.contains("\"recordsHex\":[]"));
    }
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    #[test]
    fn departed_projects_pending_origin_troops() {
        let mut c = Controller::new().unwrap();
        let r = c.exchange("depart 0").unwrap();
        assert!(r.contains("\"status\":\"ok\""));
        assert_eq!(c.sandbox.current_milli().unwrap(), 300000);
    }
}

/// v2: the economy and the march on the same holding, one clock, one
/// revision. Fixed public fixtures only; every outcome below is the real
/// handlers'. No value asserted here is a hardcoded snapshot of a store.
#[cfg(test)]
mod integrated_tests {
    use super::*;
    use crate::engine::{ECONOMY_COMMANDS, INITIAL};
    use permutation_frontier::layout::citizen as C;

    fn ok(c: &mut Controller, cmd: &str) -> String {
        let reply = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
        assert!(
            reply.contains("\"status\":\"ok\""),
            "{cmd} at {}: {reply:.300}",
            c.sandbox.phase
        );
        reply
    }
    fn holding(c: &Controller) -> Vec<u8> {
        c.sandbox.images["holding"].data.clone()
    }
    fn reserve0(c: &Controller) -> u32 {
        Ro(&holding(c)).u32(H::reserve(0)).unwrap()
    }
    fn food_production(c: &Controller) -> i64 {
        Ro(&holding(c)).i64(H::PRODUCTION).unwrap()
    }
    fn busy_slots(c: &Controller) -> Vec<usize> {
        let h = holding(c);
        (0..H::QUEUE_N)
            .filter(|i| h[H::queue(*i) + QI::KIND] != 0)
            .collect()
    }
    fn stores(c: &Controller) -> Vec<i64> {
        let h = holding(c);
        (0..H::STORES_N)
            .map(|i| Ro(&h).i64(H::store(i) + AC::VALUE).unwrap())
            .collect()
    }
    /// What must not move under an economy command: every image other than
    /// the citizen and the holding, and the march fields of the holding.
    fn march_view(c: &Controller) -> (Vec<(String, Vec<u8>, u64)>, Vec<u8>, i64, &'static str) {
        let others = c
            .sandbox
            .images
            .iter()
            .filter(|(n, _)| *n != "citizen" && *n != "holding")
            .map(|(n, im)| (n.clone(), im.data.clone(), im.lamports))
            .collect();
        let h = holding(c);
        let mut tail = h[H::TRANSIT..].to_vec();
        tail.extend_from_slice(&h[H::ESCROW..H::ESCROW + 8]);
        (others, tail, c.sandbox.now, c.sandbox.phase)
    }

    #[test]
    fn economy_and_march_interleave_on_one_holding_and_one_clock() {
        let mut c = Controller::new().unwrap();
        let r_initial = reserve0(&c);
        let prod0 = food_production(&c);
        // ready, bell 6: the village acts before the march leaves
        let before = march_view(&c);
        let reply = ok(&mut c, "harvest");
        assert!(reply.contains("\"instructions\":[\"Harvest\"]"));
        assert_eq!(march_view(&c), before, "harvest touched the march");
        let busy0 = busy_slots(&c);
        let s0 = stores(&c);
        ok(&mut c, "build_farm");
        let busy1 = busy_slots(&c);
        assert_eq!(busy1.len(), busy0.len() + 1, "the farm is queued");
        let farm_slot = *busy1.iter().find(|i| !busy0.contains(i)).unwrap();
        assert!(
            stores(&c).iter().zip(&s0).all(|(a, b)| a <= b)
                && stores(&c).iter().zip(&s0).any(|(a, b)| a < b),
            "the farm was paid from the same stores"
        );
        let before = march_view(&c);
        ok(&mut c, "train");
        assert_eq!(march_view(&c), before, "train touched the march");
        assert_eq!(reserve0(&c), r_initial + TRAIN_COUNT);
        assert_eq!(c.sandbox.now, INITIAL, "economy never moves the clock");
        // the same instant: depart, then train during the departure
        ok(&mut c, "depart");
        ok(&mut c, "train");
        assert_eq!(c.sandbox.instant_used, 4, "ready and departed share bell 6");
        ok(&mut c, "settle_departure");
        assert_eq!(c.sandbox.instant_used, 0, "a new instant");
        // travelling, bell 8: the farm is not finished yet
        ok(&mut c, "harvest");
        assert!(busy_slots(&c).contains(&farm_slot));
        ok(&mut c, "post_reveal");
        // revealed, bell 21: a touch completes the farm on the same holding
        ok(&mut c, "harvest");
        assert!(
            !busy_slots(&c).contains(&farm_slot),
            "the farm completed on the touch"
        );
        assert!(
            food_production(&c) > prod0,
            "the farm raised food production"
        );
        ok(&mut c, "resolve_arrival");
        ok(&mut c, "settle_transit");
        // settled: reserves change again before the survivors come home
        ok(&mut c, "train");
        let before_return = reserve0(&c);
        assert_eq!(before_return, r_initial + 3 * TRAIN_COUNT);
        let reply = ok(&mut c, "dissolve_return");
        assert!(reply.contains("\"Return\""));
        let credited = c.sandbox.credited;
        assert!(credited > 0 && credited < 300);
        assert_eq!(reserve0(&c), before_return + credited);
        // returned, bell 25: the village still acts at the final instant
        ok(&mut c, "harvest");
        assert_eq!(c.sandbox.phase, "returned");
        assert_eq!(
            (c.sandbox.harvests, c.sandbox.farm_builds, c.sandbox.trains),
            (4, 1, 3)
        );
        assert_eq!(c.sandbox.now, GENESIS + FINAL_BELL as i64 * 600 + 60);
        let hb = holding(&c);
        let h = WideHolding::read(&hb).unwrap();
        assert_eq!(h.open_transits, 0);
        assert_eq!(Ro(&hb).u64(H::ESCROW).unwrap(), 0);
        // 8 economy commands + 6 phase steps, one revision each
        assert_eq!(c.revision, 14);
    }

    #[test]
    fn handler_refusal_of_an_economy_command_is_atomic() {
        let mut c = Controller::new().unwrap();
        ok(&mut c, "harvest"); // production settled to this instant
        for i in 0..H::STORES_N {
            let at = H::store(i) + AC::VALUE;
            c.sandbox.images.get_mut("holding").unwrap().data[at..at + 8]
                .copy_from_slice(&0i64.to_le_bytes());
        }
        let pre = c.sandbox.images.clone();
        let (rev, used) = (c.revision, c.sandbox.instant_used);
        for cmd in ["build_farm", "train"] {
            let r = c.exchange(&format!("{cmd} {rev}")).unwrap();
            assert!(r.contains("\"status\":\"refused\""), "{cmd}");
            assert!(r.contains("\"error\":\"HANDLER_REFUSED\""));
            assert!(r.contains(&format!(
                "\"refusalCode\":{}",
                permutation_frontier::FrontierError::Insufficient.code()
            )));
            assert!(r.contains("\"recordsHex\":[]"));
            assert_eq!(c.sandbox.images, pre);
            assert_eq!(c.revision, rev);
            assert_eq!(c.sandbox.instant_used, used);
            assert_eq!((c.sandbox.farm_builds, c.sandbox.trains), (0, 0));
        }
        // the same revision is still current: the march can still leave
        ok(&mut c, "depart");
    }

    #[test]
    fn bucket_refusal_is_the_handlers_and_commits_nothing() {
        let mut c = Controller::new().unwrap();
        let t = (INITIAL - GENESIS) as u32;
        let cd = &mut c.sandbox.images.get_mut("citizen").unwrap().data;
        cd[C::BUCKET_MILLI..C::BUCKET_MILLI + 4].copy_from_slice(&0u32.to_le_bytes());
        cd[C::BUCKET_T..C::BUCKET_T + 4].copy_from_slice(&t.to_le_bytes());
        let pre = c.sandbox.images.clone();
        let r = c.exchange("train 0").unwrap();
        assert!(r.contains("\"error\":\"HANDLER_REFUSED\""));
        assert!(r.contains(&format!(
            "\"refusalCode\":{}",
            permutation_frontier::FrontierError::Bucket.code()
        )));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.revision, 0);
    }

    #[test]
    fn per_instant_budget_keeps_the_march_playable() {
        let mut c = Controller::new().unwrap();
        for _ in 0..ECONOMY_PER_INSTANT {
            ok(&mut c, "harvest");
        }
        let pre = c.sandbox.images.clone();
        let rev = c.revision;
        for cmd in ECONOMY_COMMANDS {
            let r = c.exchange(&format!("{cmd} {rev}")).unwrap();
            assert!(r.contains("\"error\":\"INSTANT_BUDGET\""), "{cmd}");
            assert!(!r.contains(&format!("\"allowed\":[\"depart\",\"{cmd}\"")));
            assert_eq!(c.sandbox.images, pre);
            assert_eq!(c.revision, rev);
        }
        // opening land is not an economy command: it is outside this budget
        assert_eq!(
            c.sandbox.allowed(),
            vec!["depart", "open_province", "reset"]
        );
        // the action bucket still has room for the player's own step
        ok(&mut c, "depart");
        assert_eq!(
            c.sandbox.allowed(),
            vec!["settle_departure", "open_province", "reset"]
        );
        ok(&mut c, "settle_departure");
        assert!(c.sandbox.allowed().contains(&"harvest"));
        ok(&mut c, "harvest");
    }

    #[test]
    fn duplicate_and_stale_economy_commands_never_replay() {
        let mut c = Controller::new().unwrap();
        ok(&mut c, "train");
        let after = c.sandbox.images.clone();
        let reserve = reserve0(&c);
        for line in ["train 0", "train 0", "harvest 0", "build_farm 0", "train 2"] {
            let r = c.exchange(line).unwrap();
            assert!(r.contains("\"error\":\"STALE_REVISION\""), "{line}");
            assert!(r.contains("\"recordsHex\":[]"));
            assert_eq!(c.sandbox.images, after);
        }
        assert_eq!(reserve0(&c), reserve);
        assert_eq!((c.revision, c.sandbox.trains), (1, 1));
    }

    #[test]
    fn oversized_economy_reply_commits_nothing() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        let r = c.exchange_with_limit("build_farm 0", 1).unwrap();
        assert!(r.contains("RESPONSE_LIMIT"));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(
            (c.revision, c.sandbox.farm_builds, c.sandbox.instant_used),
            (0, 0, 0)
        );
    }

    #[test]
    fn reset_after_economy_and_march_restores_the_fixture_but_not_the_revision() {
        let mut c = Controller::new().unwrap();
        let fresh = Controller::new().unwrap();
        let first = fresh.render("ok", None, None, "get", false, None).unwrap();
        for cmd in [
            "harvest",
            "build_farm",
            "depart",
            "train",
            "settle_departure",
            "harvest",
        ] {
            ok(&mut c, cmd);
        }
        assert_ne!(c.sandbox.images, fresh.sandbox.images);
        let rev = c.revision;
        ok(&mut c, "reset");
        assert_eq!(c.revision, rev + 1);
        assert_eq!(c.sandbox.images, fresh.sandbox.images);
        assert_eq!(c.sandbox.now, INITIAL);
        assert_eq!(c.sandbox.phase, "ready");
        assert_eq!(
            (
                c.sandbox.harvests,
                c.sandbox.farm_builds,
                c.sandbox.trains,
                c.sandbox.instant_used
            ),
            (0, 0, 0, 0)
        );
        // the reset state renders as the first state, revision aside
        let now = c.render("ok", None, None, "get", false, None).unwrap();
        let strip = |s: &str| {
            s.replacen(&format!("\"revision\":{},", c.revision), "", 1)
                .replacen("\"revision\":0,", "", 1)
        };
        assert_eq!(strip(&now), strip(&first));
        // an old revision stays dead
        let r = c.exchange(&format!("harvest {rev}")).unwrap();
        assert!(r.contains("STALE_REVISION"));
    }

    #[test]
    fn get_reports_village_bytes_and_the_honest_horizon() {
        let c = Controller::new().unwrap();
        let g = c.render("ok", None, None, "get", false, None).unwrap();
        assert!(g.starts_with("{\"protocol\":\"wylls-local-march-v3\""));
        assert!(g.contains("\"session\":\"integrated-economy-march-same-holding\""));
        assert!(g.contains("\"model\":\"PHASE_STEPS_ONLY\""));
        assert!(g.contains("\"destinationPreparedThroughBell\":19"));
        assert!(g.contains(&format!("\"finalBell\":{FINAL_BELL}")));
        assert!(g.contains("\"refusalCode\":null"));
        assert!(g.contains("\"perInstantBudget\":8,\"usedThisInstant\":0"));
        // the stores reported are the bytes' own, at their own t0
        let h = holding(&c);
        let v = Ro(&h).i64(H::store(0) + AC::VALUE).unwrap();
        let t0 = Ro(&h).i64(H::store(0) + AC::T0).unwrap();
        assert!(g.contains(&format!("\"stores\":[{{\"value\":\"{v}\",")));
        assert!(g.contains(&format!("\"t0\":\"{t0}\"")));
        // the destination is ahead of the origin: reported, not hidden
        let o = Ro(&c.sandbox.images["origin"].data)
            .u32(PV::RESOLVED_NEXT)
            .unwrap();
        let d = Ro(&c.sandbox.images["destination"].data)
            .u32(PV::RESOLVED_NEXT)
            .unwrap();
        assert!(d > o);
        assert!(g.contains(&format!(
            "\"originResolvedNext\":{o},\"destinationResolvedNext\":{d}"
        )));
        // a non-quote response carries a null routeQuote
        assert!(g.contains("\"routeQuote\":null}"));
        assert!(g.len() < 1_048_576);
    }

    #[test]
    fn classify_maps_only_fixed_tokens() {
        assert_eq!(classify("BAD_PHASE"), ("refused", "BAD_PHASE", None));
        assert_eq!(
            classify("INSTANT_BUDGET"),
            ("refused", "INSTANT_BUDGET", None)
        );
        assert_eq!(
            classify("Refused_21:Train"),
            ("refused", "HANDLER_REFUSED", Some(21))
        );
        assert_eq!(
            classify("Refused_Runtime:Depart"),
            ("refused", "HANDLER_REFUSED", None)
        );
        assert_eq!(
            classify("Refused_99999999999:Train"),
            ("refused", "HANDLER_REFUSED", None)
        );
        assert_eq!(
            classify("ECONOMY_RECEIPT"),
            ("fault", "EXECUTION_FAULT", None)
        );
        assert_eq!(
            classify("Fault_RuntimeBoundary:Harvest"),
            ("fault", "EXECUTION_FAULT", None)
        );
    }
}

#[cfg(test)]
mod route_quote_protocol_tests {
    use super::*;
    /// The recorded directions as a digit string (`020202` hex -> "222").
    fn recorded(c: &Controller) -> String {
        crate::engine::unhex(c.sandbox.meta.get("directions").unwrap())
            .unwrap()
            .iter()
            .map(|d| (b'0' + d) as char)
            .collect()
    }

    #[test]
    fn quote_route_validates_the_chosen_path_and_never_mutates() {
        let mut c = Controller::new().unwrap();
        let before = c.sandbox.images.clone();
        let dirs = recorded(&c);
        let r = c.exchange(&format!("quote_route {dirs}")).unwrap();
        assert!(r.contains("\"status\":\"ok\""));
        assert!(r.contains("\"command\":\"quote_route\""));
        assert!(r.contains("\"revision\":0,"));
        assert!(r.contains("\"routeQuote\":{"));
        assert!(r.contains("\"reachable\":true"));
        assert!(r.contains("\"reason\":null"));
        assert!(r.contains("\"end\":{\"p\":\"129\",\"q\":\"-1\",\"tile\":34}"));
        // verify_route lists every province a step enters in first-entered
        // order; the first steps stay in the start's province (129,0), which
        // therefore counts as entered, then (129,-1).
        assert!(r.contains(
            "\"provincesEntered\":[{\"p\":\"129\",\"q\":\"0\"},{\"p\":\"129\",\"q\":\"-1\"}]"
        ));
        // a query carries no new evidence and no record
        assert!(r.contains("\"instructions\":[]") && r.contains("\"recordsHex\":[]"));
        // nothing changed: images, revision, phase
        assert_eq!(c.sandbox.images, before);
        assert_eq!(c.revision, 0);
        assert_eq!(c.sandbox.phase, "ready");
        // the march still departs at the same revision afterwards
        assert!(c
            .exchange("depart 0")
            .unwrap()
            .contains("\"status\":\"ok\""));
    }

    #[test]
    fn a_path_past_the_known_provinces_is_unreachable_unknown_land() {
        let mut c = Controller::new().unwrap();
        let d = recorded(&c).as_bytes()[0];
        // exactly one step into the first province the host did not return,
        // located from the real fixture geometry
        let i = crate::engine::first_unknown_step(&c.sandbox, d - b'0').unwrap();
        let far = (d as char).to_string().repeat(i + 1);
        let r = c.exchange(&format!("quote_route {far}")).unwrap();
        assert!(r.contains("\"status\":\"ok\""));
        assert!(r.contains("\"revision\":0,"));
        assert!(r.contains("\"reachable\":false"));
        assert!(r.contains("\"end\":null"));
        assert!(r.contains("\"reason\":\"UNKNOWN_PROVINCE\""));
        assert!(r.contains(&format!("\"blockedStep\":{i},")));
        assert_eq!(c.revision, 0);
    }

    #[test]
    fn malformed_quote_commands_are_refused_without_a_quote() {
        let mut c = Controller::new().unwrap();
        let long = format!("quote_route {}", "2".repeat(MAX_ROUTE_DIRS + 1));
        for bad in [
            "quote_route ",
            "quote_route 6",
            "quote_route 2x",
            "quote_route 29",
            "quote_route -1",
            long.as_str(),
        ] {
            let r = c.exchange(bad).unwrap();
            assert!(r.contains("\"status\":\"refused\""), "{bad}");
            assert!(r.contains("\"error\":\"BAD_COMMAND\""), "{bad}");
            assert!(r.contains("\"routeQuote\":null"));
        }
        assert_eq!(c.revision, 0);
    }
}

/// v3: opening ring-129 provinces with the real WideOpenProvince over the
/// LOCAL land records, revisioned and atomic, at the controller's clock.
#[cfg(test)]
mod open_province_protocol_tests {
    use super::*;
    use crate::engine::{first_unknown, ECONOMY_COMMANDS, INITIAL};

    fn reply(c: &mut Controller, line: &str) -> String {
        c.exchange(line).unwrap()
    }
    fn recorded(c: &Controller) -> u8 {
        crate::engine::unhex(c.sandbox.meta.get("directions").unwrap()).unwrap()[0]
    }

    #[test]
    fn get_reports_the_installed_land_records_and_the_budget() {
        let c = Controller::new().unwrap();
        let g = c.render("ok", None, None, "get", false, None).unwrap();
        assert!(
            g.contains("\"land\":{\"ring\":129,\"budget\":4,\"opened\":0,\"provincesCreated\":3,")
        );
        for t in [
            "\"ringSeed\":\"LOCAL_SYNTHETIC_RING_SEED\"",
            "\"rules\":\"PROTOTYPE_CANDIDATE_RULES_V1\"",
            "\"funds\":\"LOCAL_FIXTURE_FUNDS\"",
            "\"golden\":\"GOLDEN_REOPEN_STATIC_FIELDS_MATCH\"",
            "\"opened\":\"REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME\"",
            "\"resolveHistory\":\"NO_RESOLVE_HISTORY\"",
            "\"auth\":\"MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE\"",
            "\"budget\":\"DEMO_BUDGET_4_EXTRA_PROVINCES\"",
        ] {
            assert!(g.contains(t), "{t}");
        }
        assert!(!g.contains("MISSING_LABEL"));
        // the two exported provinces, labelled as fixtures
        assert_eq!(g.matches("\"source\":\"fixture\"").count(), 2);
        assert_eq!(g.matches("\"source\":\"opened\"").count(), 0);
        assert!(
            g.contains("\"open_province\""),
            "allowed while the budget lasts"
        );
        // every land record named is in the returned account set
        for n in [land::RING_SEED_NAME, land::RULES_CONFIG_NAME] {
            let k = hex(&c.sandbox.images[n].key);
            assert_eq!(g.matches(&format!("\"keyHex\":\"{k}\"")).count(), 1, "{n}");
        }
    }

    #[test]
    fn open_province_runs_the_real_handler_and_increments_the_revision_once() {
        let mut c = Controller::new().unwrap();
        let before = c.sandbox.clone();
        let r = reply(&mut c, "open_province 0 129 -2");
        assert!(r.contains("\"status\":\"ok\""), "{r:.300}");
        assert!(r.contains("\"command\":\"open_province\""));
        assert!(r.contains("\"revision\":1,"));
        assert!(r.contains("\"instructions\":[\"WideOpenProvince\"]"));
        assert!(r.contains("\"recordsHex\":[]"));
        assert!(r.contains("\"opened\":1,\"provincesCreated\":4,"));
        assert!(r.contains("{\"p\":\"129\",\"q\":\"-2\",\"accountKeyHex\":"));
        assert_eq!(r.matches("\"source\":\"opened\"").count(), 1);
        assert!(r.contains("\"source\":\"opened\",\"openedBell\":6,\"resolvedNext\":6,"));
        // the clock, phase, economy and the march images did not move
        assert_eq!(c.sandbox.now, INITIAL);
        assert_eq!(c.sandbox.phase, "ready");
        for n in ["holding", "citizen", "origin", "destination"] {
            assert_eq!(c.sandbox.images[n], before.images[n], "{n}");
        }
        assert_eq!(c.sandbox.images.len(), before.images.len() + 1);
        // the economy and the fixed march still run afterwards
        assert!(reply(&mut c, "harvest 1").contains("\"status\":\"ok\""));
        assert!(reply(&mut c, "depart 2").contains("\"status\":\"ok\""));
    }

    #[test]
    fn stale_duplicate_and_malformed_openings_never_mutate() {
        let mut c = Controller::new().unwrap();
        assert!(reply(&mut c, "open_province 0 129 -2").contains("\"status\":\"ok\""));
        let after = c.sandbox.images.clone();
        // a replay of the same line is stale; the same coordinate again is a duplicate
        for (line, err) in [
            ("open_province 0 129 -2", "STALE_REVISION"),
            ("open_province 1 129 -2", "LAND_DUPLICATE_OPEN"),
            ("open_province 1 129 0", "LAND_DUPLICATE_OPEN"),
            ("open_province 1 129 -1", "LAND_DUPLICATE_OPEN"),
            ("open_province 1 128 0", "LAND_NOT_RING_129"),
            ("open_province 1 130 0", "LAND_NOT_RING_129"),
            ("open_province 1 4611686018427387905 0", "LAND_COORD_BOUNDS"),
        ] {
            let r = reply(&mut c, line);
            assert!(r.contains("\"status\":\"refused\""), "{line}");
            assert!(
                r.contains(&format!("\"error\":\"{err}\"")),
                "{line}: {r:.200}"
            );
            assert!(r.contains("\"recordsHex\":[]") && r.contains("\"instructions\":[]"));
            assert_eq!(c.sandbox.images, after, "{line}");
            assert_eq!(c.revision, 1, "{line}");
        }
        for bad in [
            "open_province 1 129",
            "open_province 1 129 -2 0",
            "open_province 1 0129 -2",
            "open_province 1 129 -02",
            "open_province 1 -0 0",
            "open_province 1 +129 0",
            "open_province 01 129 -2",
            "open_province 1 129  -2",
            "open_province 1 12x -2",
            "open_province 1 99999999999999999999 0",
        ] {
            let r = reply(&mut c, bad);
            assert!(r.contains("\"error\":\"BAD_COMMAND\""), "{bad}");
            assert_eq!(c.sandbox.images, after, "{bad}");
            assert_eq!(c.revision, 1);
        }
    }

    #[test]
    fn the_budget_of_four_is_enforced_and_open_leaves_the_allowed_list() {
        let mut c = Controller::new().unwrap();
        for (i, (p, q)) in [(129, -2), (129, -3), (128, 1), (127, 2)]
            .iter()
            .enumerate()
        {
            let r = reply(&mut c, &format!("open_province {i} {p} {q}"));
            assert!(r.contains("\"status\":\"ok\""), "{p},{q}");
        }
        assert_eq!(c.sandbox.opened_count(), 4);
        assert!(!c.sandbox.allowed().contains(&"open_province"));
        let after = c.sandbox.images.clone();
        let r = reply(&mut c, "open_province 4 126 3");
        assert!(r.contains("\"error\":\"LAND_BUDGET\""));
        assert!(r.contains("\"opened\":4,\"provincesCreated\":7,"));
        assert_eq!(c.sandbox.images, after);
        assert_eq!(c.revision, 4);
        // six provinces are reported, each once
        let g = c.render("ok", None, None, "get", false, None).unwrap();
        assert_eq!(g.matches("\"source\":\"opened\"").count(), 4);
        assert_eq!(g.matches("\"source\":\"fixture\"").count(), 2);
        assert!(g.len() < 1_048_576);
    }

    #[test]
    fn an_unseeded_ring_or_tampered_record_refuses_without_mutation() {
        let mut c = Controller::new().unwrap();
        {
            let ai = c.sandbox.images.get_mut(land::RING_SEED_NAME).unwrap();
            let mut rec = WideRingSeed::read(&ai.data).unwrap();
            rec.status = frontier_abi::world_index::SeedStatus::Requested;
            rec.seed = [0; 32];
            rec.write(&mut ai.data).unwrap();
        }
        let pre = c.sandbox.images.clone();
        let r = reply(&mut c, "open_province 0 129 -2");
        assert!(r.contains("\"error\":\"LAND_RING_UNSEEDED\""));
        assert_eq!((c.sandbox.images == pre, c.revision), (true, 0));
        // a changed rule byte in the config is a fault (the record is not
        // the installed one), never a successful opening
        let mut c = Controller::new().unwrap();
        c.sandbox
            .images
            .get_mut(land::RULES_CONFIG_NAME)
            .unwrap()
            .data[18] ^= 1;
        let pre = c.sandbox.images.clone();
        let r = reply(&mut c, "open_province 0 129 -2");
        assert!(r.contains("\"status\":\"fault\""), "{r:.200}");
        assert!(r.contains("\"error\":\"EXECUTION_FAULT\""));
        assert_eq!((c.sandbox.images == pre, c.revision), (true, 0));
    }

    #[test]
    fn a_handler_refusal_is_reported_with_its_program_code() {
        let mut c = Controller::new().unwrap();
        // one lamport short of its own rent plus one province rent (the land
        // module's boundary case): the handler itself refuses Insufficient
        let coord = frontier_abi::world_index::WideCoord::checked(129, -2).unwrap();
        let fund = land::fund_name(coord.wedge().unwrap());
        let prov_rent = solana_program::rent::Rent::default()
            .minimum_balance(frontier_abi::world_index::land::province::SIZE);
        c.sandbox.images.get_mut(&fund).unwrap().lamports =
            land::fund_lamports() - (land::MAX_EXTRA_PROVINCES as u64 - 1) * prov_rent - 1;
        let pre = c.sandbox.images.clone();
        let r = reply(&mut c, "open_province 0 129 -2");
        assert!(r.contains("\"error\":\"HANDLER_REFUSED\""), "{r:.200}");
        assert!(r.contains(&format!(
            "\"refusalCode\":{}",
            permutation_frontier::FrontierError::Insufficient.code()
        )));
        assert_eq!((c.sandbox.images == pre, c.revision), (true, 0));
    }

    #[test]
    fn an_oversized_open_reply_commits_nothing() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        let r = c.exchange_with_limit("open_province 0 129 -2", 1).unwrap();
        assert!(r.contains("RESPONSE_LIMIT"));
        assert_eq!((c.sandbox.images == pre, c.revision), (true, 0));
    }

    #[test]
    fn reset_after_openings_restores_the_installed_baseline() {
        let mut c = Controller::new().unwrap();
        let fresh = Controller::new().unwrap();
        assert!(reply(&mut c, "open_province 0 129 -2").contains("\"status\":\"ok\""));
        assert!(reply(&mut c, "harvest 1").contains("\"status\":\"ok\""));
        let r = reply(&mut c, "reset 2");
        assert!(r.contains("\"status\":\"ok\""));
        assert_eq!(c.revision, 3);
        assert_eq!(c.sandbox.images, fresh.sandbox.images);
        assert_eq!(c.sandbox.opened_count(), 0);
        assert!(r.contains("\"opened\":0,\"provincesCreated\":3,"));
        // the old revision stays dead and the province can be opened again
        assert!(reply(&mut c, "open_province 0 129 -2").contains("STALE_REVISION"));
        assert!(reply(&mut c, "open_province 3 129 -2").contains("\"status\":\"ok\""));
    }

    #[test]
    fn a_quote_into_the_newly_opened_province_uses_its_returned_bytes() {
        let mut c = Controller::new().unwrap();
        let d = recorded(&c);
        let (i, coord) = first_unknown(&c.sandbox, d).unwrap();
        assert_eq!(coord.ring(), 129);
        let path = ((b'0' + d) as char).to_string().repeat(i + 1);
        let before = reply(&mut c, &format!("quote_route {path}"));
        assert!(before.contains("\"reason\":\"UNKNOWN_PROVINCE\""));
        let open = format!("open_province 0 {} {}", coord.p(), coord.q());
        assert!(reply(&mut c, &open).contains("\"status\":\"ok\""));
        let after = reply(&mut c, &format!("quote_route {path}"));
        assert!(after.contains("\"status\":\"ok\""));
        assert!(after.contains("\"revision\":1,"));
        assert!(!after.contains("\"reason\":\"UNKNOWN_PROVINCE\""));
        let step = format!(
            "{{\"p\":\"{}\",\"q\":\"{}\",\"tile\":",
            coord.p(),
            coord.q()
        );
        assert!(
            after.contains(&step),
            "the step is now on the opened province"
        );
        // economy commands are unaffected by land opening
        for cmd in ECONOMY_COMMANDS {
            assert!(c.sandbox.allowed().contains(&cmd));
        }
    }
}
