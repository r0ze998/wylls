//! `verify-core`: the Frontier verifier v2 (M1 contract §8.5, offchain
//! design §10, W4-D).
//!
//! Input: the program id, the season id, the pinned drand key, the ruleset
//! hash expected (and optionally the `.so` hash), the season's
//! transactions in feed order (failed ones included) and the **final
//! account states at a pinned slot** ([`input::Input`]). Every replayed
//! chain must reach the final on-chain head (K4); a transaction or record
//! that cannot be read is a FAIL (K2). Exit codes: 0 PASS, 1 FAIL, 2
//! cannot verify.
//!
//! | module | check |
//! |---|---|
//! | [`checks::v0_coverage`] | V0 the instructions and program versions this verifier can judge (an unknown or unmodelled one is never a PASS) |
//! | [`checks::v1_chains`] | V1 entity chains, final heads, duplicates, K4 state |
//! | [`checks::v2_program`] | V2 program id, `.so` hash, ruleset hash, announce → create |
//! | [`checks::v3_random`] | V3 anchors, caches, beacons, genesis and ring rounds (blstrs) |
//! | [`checks::v4_windows`] | V4 reveal window and latch |
//! | [`checks::v5_seals`] | V5 seals opened with the stock `tlock` crate; verdicts |
//! | [`checks::v6_quotas`] | V6 arrival quotas, departure masses |
//! | [`checks::v7_replay`] | V7 clashes, quiet skips (every bell, [`skip`]), transit outcomes, holdings (owner actions replayed, [`holding`]) |
//! | [`checks::v8_lag`] | V8 origin values (lag witness) |
//! | [`checks::v9_addresses`] | V9 canonical addresses, pre-funded inits |
//! | [`checks::v11_land`] | V11 tickets, cohorts, terrain, camps |
//! | [`checks::v12_explore`] | V12 explore rolls |
//! | [`checks::v13_payments`] | V13 payments and defence refunds |
//! | [`report`] | V10 `report.json` + `report.md` |
//!
//! Cargo features `mutate-v<n>` disable one check each (the checks of the
//! checks: the tamper of that check must then PASS; `mutate.sh`).
//! [`fixture`] builds the synthetic march season; [`tamper`] holds T1–T22,
//! the extra checks of the checks and the suite over any one run
//! ([`tamper::run_suite`], `frontier-verify tamper`, W5-D).

pub mod checks;
pub mod clash_input;
pub mod clash_v2;
pub mod codes;
pub mod conquest;
pub mod cqrec;
pub mod facts;
pub mod fixture;
/// An archive without post-states, re-executed from the Season's creation
/// by the pinned program (VG).
#[cfg(feature = "playable-lane")]
pub mod genesis;
pub mod history;
pub mod holding;
pub mod input;
pub mod lookup;
/// Re-execution of an archived transaction by the pinned program (VX).
#[cfg(feature = "playable-lane")]
pub mod reexec;
pub mod rent;
pub mod report;
pub mod resident_feed;
pub mod skip;
pub mod tamper;
pub mod vmsg;
/// Detached invocation-scoped conditional siege settlement proof only.
#[cfg(feature = "wide-economy-experimental")]
pub mod wide_conquest_settle;
/// Supplied-state WideClaimDefence consistency only; not authenticated replay.
#[cfg(feature = "wide-economy-experimental")]
pub mod wide_defence;
/// Experimental, opt-in (`wide-economy-experimental`): the independent
/// state-transition replay of one wide S1 economy receipt (event kinds 15
/// and 16) over caller-supplied snapshots. Not a check of [`verify`]; it
/// produces no season verdict.
#[cfg(feature = "wide-economy-experimental")]
pub mod wide_economy;
/// Detached original-origin resident transition replay; never a season verdict.
#[cfg(feature = "wide-economy-experimental")]
pub mod wide_expedition_resident;
/// One-transition kind-17 replay only; never a whole-season verdict.
#[cfg(feature = "wide-economy-experimental")]
pub mod wide_garrison;
pub mod witness;
pub mod world;

use serde_json::Value;

pub use input::{Config, Input};

/// The `mutate-*` feature this build was compiled with, if any (wave-5
/// review of W5-D): such a build has a check disabled and is **not a
/// verifier**. Its report says so, and `frontier-verify` refuses to run
/// (exit 2) unless [`ALLOW_MUTATED_ENV`] is `1` (the checks of the checks
/// set it).
pub fn mutated() -> Option<&'static str> {
    macro_rules! m {
        ($($f:literal),*) => {{ $( if cfg!(feature = $f) { return Some($f); } )* None }};
    }
    m!(
        "mutate-v1",
        "mutate-v2",
        "mutate-v3",
        "mutate-v4",
        "mutate-v5",
        "mutate-v6",
        "mutate-v7",
        "mutate-v8",
        "mutate-v9",
        "mutate-v11",
        "mutate-v12",
        "mutate-v13",
        "mutate-vx",
        "mutate-vg",
        "mutate-vs"
    )
}

/// Set to `1` to let a `mutate-*` build of `frontier-verify` run.
pub const ALLOW_MUTATED_ENV: &str = "FRONTIER_VERIFY_ALLOW_MUTATED";

/// Exit codes: 0 PASS, 1 FAIL, 2 cannot verify.
pub const EXIT_PASS: i32 = 0;
pub const EXIT_FAIL: i32 = 1;
pub const EXIT_UNVERIFIABLE: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Unverifiable,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::Unverifiable => "UNVERIFIABLE",
        }
    }
}

/// Severity of a finding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Holds, with a liveness or informational remark (PASS with warning).
    Warn,
    /// The data needed to check could not be read (UNVERIFIABLE unless a
    /// FAIL exists).
    Unverifiable,
    Fail,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    /// The check that raised it (`V1` … `V13`).
    pub check: &'static str,
    pub entity: String,
    pub bell: u32,
    pub signature: String,
    pub detail: String,
}

impl Finding {
    pub fn fail(&self) -> bool {
        self.severity == Severity::Fail
    }
}

/// Counters of `report.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub tx: u64,
    pub failed_tx: u64,
    pub seals: u64,
    pub reveals: u64,
    pub bad_seals: u64,
    pub clashes: u64,
    pub skips: u64,
    pub tickets: u64,
    pub explores: u64,
}

/// The liveness part of the report (warnings, never a FAIL).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Liveness {
    /// Valid seals never revealed: `(host_id, arrive_bell, signatures of
    /// the failed Reveal attempts)`.
    pub valid_unrevealed: Vec<(u64, u32, Vec<String>)>,
    /// Valid seals never revealed that the rules explain (W6-C, W6T-3):
    /// settled with an outcome other than `ROUTED` (reason `bounced`: no
    /// loss by rule, outranked, quota-refused, the citizen's second
    /// arrival), or settled `ROUTED` because §5.11 step 6 refuses their
    /// Reveal (`shielded-own`, `shielded-dest`, `path`, `arrival-bell`).
    pub unrevealed_by_rule: Vec<ByRule>,
    pub reveals_near_close: u64,
    pub max_anchor_delay_s: f64,
    /// Province-bells with more than one faction's arrivals or residents.
    pub contested_bells: Vec<(i32, i32, u32)>,
}

/// One valid seal never revealed that the rules explain (`liveness.
/// unrevealed_by_rule`, W6T-3): the march, its settlement outcome, the
/// reason (`checks::v5_seals::reason`) and its failed Reveal attempts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ByRule {
    pub host: u64,
    pub arrive: u32,
    pub outcome: u8,
    pub reason: &'static str,
    pub failed_attempts: usize,
}

/// The result of one verification.
#[derive(Clone, Debug)]
pub struct Report {
    pub verdict: Verdict,
    pub season: u64,
    pub program: String,
    pub slot_range: (u64, u64),
    pub entities: u64,
    pub bells: u64,
    pub counts: Counts,
    pub findings: Vec<Finding>,
    pub liveness: Liveness,
    /// The checks that ran (a `mutate-*` build lists fewer).
    pub checks_run: Vec<&'static str>,
    pub provenance: String,
    /// Where the transactions came from and whether that shows them to be
    /// the whole history ([`history::History::report`]); set by [`verify`].
    pub history: Option<Value>,
    /// The rent VX / VG re-executed under and its source (`chain`,
    /// `declared`, `assumed`), when the pinned binary was given; set by
    /// [`verify`] (rent-live-rest).
    pub rent: Option<Value>,
}

impl Report {
    pub fn codes(&self) -> Vec<&str> {
        self.findings.iter().map(|f| f.code.as_str()).collect()
    }
    /// Whether a FAIL finding carries `code`.
    pub fn fails_with(&self, code: &str) -> bool {
        self.findings.iter().any(|f| f.fail() && f.code == code)
    }
    pub fn json(&self) -> Value {
        report::json(self)
    }
    pub fn markdown(&self) -> String {
        report::markdown(self)
    }
}

pub fn exit_code(v: Verdict) -> i32 {
    match v {
        Verdict::Pass => EXIT_PASS,
        Verdict::Fail => EXIT_FAIL,
        Verdict::Unverifiable => EXIT_UNVERIFIABLE,
    }
}

/// Runs every check over `input` and builds the report.
/// A conquest-program season runs both suites (conquest contract R-22):
/// V2–V13 with the v2 rules where they differ, and the conquest audit
/// (CQ1 walks every chain in V1's place).
pub fn verify(input: &Input) -> Report {
    // ⑰ Q-P1 (a): VG re-executed the whole archive from the Season's
    // creation with no finding (every program-owned final state exact).
    #[allow(unused_mut)]
    let mut vg_exact = false;
    // ⑰ Q-P2: VG's FAIL findings (known-bad), counted only when VG ran.
    #[allow(unused_mut)]
    let mut vg_fails = 0usize;
    #[cfg(feature = "playable-lane")]
    let r = if !cfg!(feature = "mutate-vg") && genesis::applies(input) {
        let d = genesis::derive(input);
        // (a WARN is no finding against the season: genesis::ClockRule's
        // ClockFromEffects note)
        vg_exact = d.ran && d.findings.iter().all(|f| f.severity == Severity::Warn);
        if d.ran {
            vg_fails = d.findings.iter().filter(|f| f.fail()).count();
        }
        let mut r = verify_one(d.input.as_ref().unwrap_or(input));
        if d.ran {
            r.checks_run.insert(0, "VG:genesis-replay");
        }
        r.findings.extend(d.findings);
        settle(&mut r);
        r
    } else {
        verify_one(input)
    };
    #[cfg(not(feature = "playable-lane"))]
    let r = verify_one(input);
    let mut r = r;
    // verifier-v0v1: VT, every v0 transaction's looked-up addresses against
    // its lookup tables as read at the pinned slot (runs only when one has
    // lookups: a legacy / v1 archive's report is unchanged).
    let (vt, vt_ran) = lookup::judge(input);
    if vt_ran {
        r.checks_run.push("VT:lookup-tables");
        r.findings.extend(vt);
        settle(&mut r);
    }
    // ⑰ Q-P1 (b): the second source (VS).
    let (wf, outcome) = witness::judge(input);
    if outcome.is_some() {
        r.checks_run.push("VS:witness");
    }
    if outcome.is_some() {
        r.findings.extend(wf);
        settle(&mut r);
    }
    let mut r = history::apply_with(
        &input.history,
        r,
        &history::Lift {
            vg_exact,
            vg_fails,
            witness: outcome,
        },
    );
    rent_note(input, &mut r);
    r
}

/// rent-live-rest: the report states the rent VX / VG re-executed under,
/// and a re-execution mismatch at an ASSUMED rate carries a WARN saying so
/// (the verdict is unchanged: never a silent constant, never a lifted FAIL).
fn rent_note(input: &Input, r: &mut Report) {
    if input.program_so.is_none() {
        return;
    }
    let (rent, basis) = rent::rent_of(input);
    let read = input.chain.rent.as_ref();
    r.rent = Some(serde_json::json!({
        "source": basis.name(),
        "lamports_per_byte": rent::rent_per_byte(&rent),
        "lamports_per_byte_year": rent.lamports_per_byte_year,
        "exemption_threshold": rent.exemption_threshold,
        "burn_percent": rent.burn_percent,
        "slot": read.and_then(|x| x.slot),
    }));
    let reexec_mismatch = r
        .findings
        .iter()
        .any(|f| matches!(f.check, "VX" | "VG") && f.severity != Severity::Warn);
    if basis == rent::RentBasis::Assumed && reexec_mismatch {
        r.findings.push(Finding {
            code: codes::RENT_ASSUMED.into(),
            severity: Severity::Warn,
            check: "VX",
            entity: "rent".into(),
            bell: 0,
            signature: String::new(),
            detail: format!(
                "VX/VG re-executed at the ASSUMED {} lamports per byte: no Rent sysvar was read and none was declared, so a mismatch above may come from another rate (re-run with --rpc, a finals file carrying `rent`, or --lamports-per-byte)",
                rent::LAMPORTS_PER_BYTE
            ),
        });
        r.findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
    }
}

/// The verdict from the findings: FAIL on any FAIL, else never better
/// than UNVERIFIABLE when one is UNVERIFIABLE.
fn settle(r: &mut Report) {
    r.findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
    if r.findings.iter().any(|f| f.fail()) {
        r.verdict = Verdict::Fail;
    } else if r.verdict == Verdict::Pass
        && r.findings
            .iter()
            .any(|f| f.severity == Severity::Unverifiable)
    {
        r.verdict = Verdict::Unverifiable;
    }
}

fn verify_one(input: &Input) -> Report {
    let base = checks::run(input);
    let r = if conquest::applies(input) {
        merge(base, conquest::verify(input))
    } else {
        base
    };
    // An unproven history is never PASS; only self-contained failures remain
    // FAIL (`verify` applies it).
    r
}

/// One report of two suites over the same input: the worse verdict, every
/// finding (worst first), both check lists.
fn merge(mut a: Report, b: Report) -> Report {
    a.verdict = [a.verdict, b.verdict]
        .into_iter()
        .find(|v| *v == Verdict::Fail)
        .or_else(|| {
            [a.verdict, b.verdict]
                .into_iter()
                .find(|v| *v == Verdict::Unverifiable)
        })
        .unwrap_or(Verdict::Pass);
    a.findings.extend(b.findings);
    a.findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
    a.checks_run.extend(b.checks_run);
    a.entities = a.entities.max(b.entities);
    a.bells = a.bells.max(b.bells);
    a.provenance = format!(
        "{}; conquest season: V2–V13 with the v2 rules, chains, final state, identity and territory time by the conquest audit (CQ1–CQ3)",
        a.provenance
    );
    a
}
