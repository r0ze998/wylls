//! The checks (contract §8.5). Each module is one check; [`run`] runs them
//! in order over one parsed [`World`] and its [`Facts`], and a `mutate-v<n>`
//! build leaves check `n` out (the checks of the checks).

pub mod v11_land;
pub mod v12_explore;
pub mod v13_payments;
pub mod v14_sieges;
pub mod v15_records;
pub mod v16_owner;
pub mod v17_captures;
pub mod v19_folds;
pub mod v1_chains;
pub mod v20_end;
pub mod v22_outposts;
pub mod v23_caravans;
pub mod v24_structures;
pub mod v2_program;
pub mod v3_random;
pub mod v4_windows;
pub mod v5_seals;
pub mod v6_quotas;
pub mod v7_replay;
pub mod v8_lag;
pub mod v9_addresses;

use crate::facts::{Facts, SigCache};
use crate::input::{Config, Input};
use crate::world::{b58, World};
use crate::{Counts, Finding, Liveness, Report, Severity, Verdict};

/// What every check reads and writes.
pub struct Ctx<'a> {
    pub w: &'a World,
    pub f: &'a Facts,
    pub cfg: &'a Config,
    pub input: &'a Input,
    pub findings: Vec<Finding>,
    pub counts: Counts,
    pub liveness: Liveness,
    pub sigs: SigCache,
    /// A conquest-program season (program version 3, ABI v2; conquest
    /// contract R-22): the checks read the v2 rules where they differ.
    pub v3: bool,
    /// An S1-program season (program version 4; `conquest::s1_applies`):
    /// the arms economy's rules where they differ (`holding::Rules::S1`).
    pub s1: bool,
    /// The conquest records V7's v2 replays leave, per transaction in
    /// order (`crate::cqrec`), for V15's record check.
    pub cq_expected: std::collections::BTreeMap<usize, Vec<crate::cqrec::Expected>>,
    /// The transactions whose skip or clash V7 replayed on the v2 path.
    pub cq_replayed: std::collections::BTreeSet<usize>,
}

impl Ctx<'_> {
    /// The rules the season runs under, where the replays differ.
    pub fn rules(&self) -> crate::holding::Rules {
        crate::holding::Rules::of(self.v3, self.s1)
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        sev: Severity,
        check: &'static str,
        code: &str,
        entity: String,
        bell: u32,
        tx: Option<usize>,
        detail: String,
    ) {
        let signature = tx
            .and_then(|t| self.w.txs.get(t))
            .map(|t| t.sig.clone())
            .unwrap_or_default();
        self.findings.push(Finding {
            code: code.into(),
            severity: sev,
            check,
            entity,
            bell,
            signature,
            detail,
        });
    }
    pub fn fail(
        &mut self,
        check: &'static str,
        code: &str,
        entity: impl Into<String>,
        bell: u32,
        tx: Option<usize>,
        detail: impl Into<String>,
    ) {
        self.push(
            Severity::Fail,
            check,
            code,
            entity.into(),
            bell,
            tx,
            detail.into(),
        );
    }
    pub fn warn(
        &mut self,
        check: &'static str,
        code: &str,
        entity: impl Into<String>,
        bell: u32,
        tx: Option<usize>,
        detail: impl Into<String>,
    ) {
        self.push(
            Severity::Warn,
            check,
            code,
            entity.into(),
            bell,
            tx,
            detail.into(),
        );
    }
    /// Data the check needs is absent (UNVERIFIABLE unless a FAIL exists).
    pub fn missing(
        &mut self,
        check: &'static str,
        entity: impl Into<String>,
        bell: u32,
        tx: Option<usize>,
        detail: impl Into<String>,
    ) {
        self.push(
            Severity::Unverifiable,
            check,
            crate::codes::MISSING_DATA,
            entity.into(),
            bell,
            tx,
            detail.into(),
        );
    }
}

/// Entity name for a report line.
pub fn ent(kind: &str, k: &[u8; 32]) -> String {
    format!("{kind}:{}", b58(k))
}

/// Runs every check that this build has.
pub fn run(input: &Input) -> Report {
    let w = World::parse(
        &input.cfg.program,
        &input.txs,
        input.finals.clone(),
        input.final_slot,
    );
    let f = Facts::build(&w, &input.cfg);
    let mut cx = Ctx {
        w: &w,
        f: &f,
        cfg: &input.cfg,
        input,
        findings: vec![],
        counts: Counts::default(),
        liveness: Liveness::default(),
        sigs: SigCache::default(),
        v3: crate::conquest::applies(input),
        s1: crate::conquest::s1_applies(input),
        cq_expected: Default::default(),
        cq_replayed: Default::default(),
    };
    let mut ran: Vec<&'static str> = vec![];
    macro_rules! check {
        ($feat:literal, $name:literal, $m:ident) => {
            if !cfg!(feature = $feat) {
                $m::run(&mut cx);
                ran.push($name);
            }
        };
    }
    // A conquest season's chains, conquest records included, are walked by
    // the conquest audit's CQ1 (`crate::verify` merges it); V1's walk sees
    // only M1's kinds. In an M1 season a conquest record is undecodable.
    if cx.v3 {
        ran.push("V1:CQ1");
    } else {
        for r in &w.cq_recs {
            cx.fail(
                "V1",
                crate::codes::UNDECODABLE,
                "transaction",
                r.bell,
                Some(r.tx),
                format!(
                    "record {} is a conquest record ({}) in an M1 season",
                    r.pos,
                    r.kind.name()
                ),
            );
        }
        check!("mutate-v1", "V1", v1_chains);
    }
    check!("mutate-v2", "V2", v2_program);
    check!("mutate-v3", "V3", v3_random);
    check!("mutate-v4", "V4", v4_windows);
    check!("mutate-v5", "V5", v5_seals);
    check!("mutate-v6", "V6", v6_quotas);
    check!("mutate-v7", "V7", v7_replay);
    check!("mutate-v8", "V8", v8_lag);
    check!("mutate-v9", "V9", v9_addresses);
    check!("mutate-v11", "V11", v11_land);
    check!("mutate-v12", "V12", v12_explore);
    check!("mutate-v13", "V13", v13_payments);
    // Conquest contract §8.5 V14–V22: the parts implemented so far (each
    // module's note says which), on a conquest season only.
    if cx.v3 {
        v14_sieges::run(&mut cx);
        ran.push("V14:siege-declaration");
        v15_records::run(&mut cx);
        ran.push("V15:conquest-records");
        v16_owner::run(&mut cx);
        ran.push("V16:first-holding-owner");
        v17_captures::run(&mut cx);
        ran.push("V17:capture-settlement");
        v19_folds::run(&mut cx);
        ran.push("V19:march-folds");
        v20_end::run(&mut cx);
        ran.push("V20:season-end");
        v22_outposts::run(&mut cx);
        ran.push("V22:outpost-filing");
    }
    // S1 stages 1b and 1d: vaults, caravans and towers, on an S1 season only.
    if cx.s1 {
        v23_caravans::run(&mut cx);
        ran.push("V23:caravans");
        v24_structures::run(&mut cx);
        ran.push("V24:structures");
    }
    ran.push("V10");
    counts(&mut cx);
    let verdict = if cx.findings.iter().any(|x| x.severity == Severity::Fail) {
        Verdict::Fail
    } else if cx
        .findings
        .iter()
        .any(|x| x.severity == Severity::Unverifiable)
    {
        Verdict::Unverifiable
    } else {
        Verdict::Pass
    };
    let mut findings = cx.findings;
    findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
    let slots = (
        w.txs.iter().map(|t| t.slot).min().unwrap_or(0),
        w.final_slot
            .max(w.txs.iter().map(|t| t.slot).max().unwrap_or(0)),
    );
    // Program accounts at the pinned slot.
    let entities = w
        .finals
        .values()
        .flatten()
        .filter(|a| a.owner.to_bytes() == w.program)
        .count() as u64;
    let bells = w
        .recs
        .iter()
        .filter(|r| r.bell != frontier_abi::log::NO_BELL)
        .map(|r| r.bell)
        .max()
        .map(|b| b as u64 + 1)
        .unwrap_or(0);
    Report {
        verdict,
        season: input.cfg.season_id,
        program: input.cfg.program.to_string(),
        slot_range: slots,
        entities,
        bells,
        counts: cx.counts,
        findings,
        liveness: cx.liveness,
        checks_run: ran,
        provenance: input.provenance.clone(),
    }
}

fn counts(cx: &mut Ctx) {
    use frontier_abi::log::{transit_outcome, Kind};
    let w = cx.w;
    let c = &mut cx.counts;
    c.tx = w.txs.len() as u64;
    c.failed_tx = w.txs.iter().filter(|t| !t.ok).count() as u64;
    for r in &w.recs {
        match r.kind {
            Kind::DEPART => c.seals += 1,
            Kind::REVEAL => c.reveals += 1,
            Kind::CLASH => c.clashes += 1,
            Kind::SKIP => c.skips += 1,
            Kind::TICKET => c.tickets += 1,
            Kind::EXPLORE => c.explores += 1,
            Kind::TRANSIT_SETTLED if r.pu8("outcome") == transit_outcome::BAD_SEAL => {
                c.bad_seals += 1
            }
            _ => {}
        }
    }
}
