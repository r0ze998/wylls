//! The checks (contract §8.5). Each module is one check; [`run`] runs them
//! in order over one parsed [`World`] and its [`Facts`], and a `mutate-v<n>`
//! build leaves check `n` out (the checks of the checks).

pub mod v0_coverage;
pub mod v0_evidence;
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
pub mod v25_nations;
pub mod v26_custody;
pub mod v26_growth;
pub mod v27_residents;
pub mod v28_resident_acts;
pub mod v2_program;
pub mod v3_random;
pub mod v4_windows;
pub mod v5_seals;
pub mod v6_quotas;
pub mod v7_replay;
pub mod v8_lag;
pub mod v9_addresses;
#[cfg(feature = "playable-lane")]
pub mod vl_land;
pub mod vr_rights;
#[cfg(feature = "wide-world-experimental")]
pub mod vw_chains;
#[cfg(feature = "playable-lane")]
pub mod vwl_wide_land;
#[cfg(feature = "playable-lane")]
pub mod vx_reexec;

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
    /// `(transaction, instruction index)` of the player instructions an NFT
    /// resident's Citizen ran through ResidentAct that the program allows only
    /// to the pass's owner, not its session (⑳: V23 marks a SendCaravan to
    /// another player; V28 judges the holder).
    pub owner_required: std::collections::BTreeSet<(usize, usize)>,
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
    /// The check cannot judge this with what it implements (UNVERIFIABLE
    /// unless a FAIL exists), under its own code (V0).
    pub fn unverifiable(
        &mut self,
        check: &'static str,
        code: &str,
        entity: impl Into<String>,
        bell: u32,
        tx: Option<usize>,
        detail: impl Into<String>,
    ) {
        self.push(
            Severity::Unverifiable,
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

/// The detail of a judgement that passed on a state the archive only
/// declares ([`Before`]): `MissingData`, never a PASS.
pub const FROM_DECLARED: &str = "judged exactly, but from a state the archive only declares (a recorder's patch, not an archived transaction's write)";

/// The checks' reader of the states before a transaction: the last
/// archived post-state or the recorder's declared patch in force
/// (`Input::declared`, "in force from before `txs[at]`"), whichever is
/// later — the rule of `vx_reexec::before` and VWL's `acct_before`.
///
/// verifier-v11-patches moved V11 onto it (D-verify-pr166-5);
/// verifier-v7-patches moved V7 (and the other replays that compare a
/// state the transaction wrote with one derived from the state before it)
/// onto it: they read only archived post-states, so an honest season whose
/// recorder patched an account after its last archived write (the dress
/// rehearsal's 400 declared Spearmen, D-dress-7) FAILed at the next owner
/// action.
///
/// A judgement that read a declared state is never a PASS
/// ([`Ctx::declared_pass`]): `MissingData`, as VWL rules. A FAIL stays a
/// FAIL: the program ran on the declared state, so an honest archive's
/// declared state can never contradict a success — and a forged
/// declaration cannot turn a FAIL into a PASS (the season is UNVERIFIABLE
/// at best once anything is declared, V0E).
///
/// [`World::state_before`] follows the same rule for every other check and
/// logs its declared reads per transaction ([`run`] softens them after each
/// check); `Before` tracks them per judgement instead, for the checks that
/// judge several things in one transaction (V7, V11).
pub struct Before<'a> {
    w: &'a World,
    read_declared: std::cell::Cell<bool>,
}

impl<'a> Before<'a> {
    pub fn new(w: &'a World) -> Self {
        Before {
            w,
            read_declared: std::cell::Cell::new(false),
        }
    }

    /// The data of `k` before transaction `tx` (`None`: absent or unknown).
    pub fn data(&self, k: &crate::world::Key, tx: usize) -> Option<&'a [u8]> {
        if let Some(d) = self.w.declared_before(k, tx) {
            self.read_declared.set(true);
            return d.map(|a| a.data.as_slice());
        }
        self.w.archived_before(k, tx).map(|a| a.data.as_slice())
    }

    /// Whether any read since [`Before::new`] / [`Before::reset`] took a
    /// declared state.
    pub fn read_declared(&self) -> bool {
        self.read_declared.get()
    }

    /// Starts a new judgement (forgets the declared reads so far).
    pub fn reset(&self) {
        self.read_declared.set(false);
    }
}

impl<'a> Ctx<'a> {
    /// A [`Before`] reader over this season's archive and declared patches.
    pub fn before(&self) -> Before<'a> {
        Before::new(self.w)
    }

    /// The end of one judgement of `check` that started with
    /// `self.findings.len() == mark`: when it read a declared state
    /// ([`Before`]) and found no FAIL of `check`, its PASS is `MissingData`.
    pub fn declared_pass(
        &mut self,
        check: &'static str,
        pre: &Before,
        mark: usize,
        entity: impl Into<String>,
        bell: u32,
        tx: Option<usize>,
    ) {
        if pre.read_declared()
            && !self.findings[mark..]
                .iter()
                .any(|f| f.check == check && f.severity == Severity::Fail)
        {
            self.missing(check, entity, bell, tx, FROM_DECLARED);
        }
    }
}

/// After check `name` (its findings from `mark` on): every transaction at
/// which it read a declared state through [`World::state_before`] /
/// [`World::lamports_before`] and found no FAIL is `MissingData`
/// ([`FROM_DECLARED`]): the judgement agreed, but from a state no archived
/// transaction wrote (verifier-v7-patches; VX, VWL, V7 and V11 say so per
/// judgement themselves).
fn soften_declared(cx: &mut Ctx, name: &'static str, mark: usize) {
    let reads = std::mem::take(&mut *cx.w.declared_reads.borrow_mut());
    if reads.is_empty() {
        return;
    }
    let check = name.split(':').next().unwrap_or(name);
    let mut by_tx: std::collections::BTreeMap<usize, Vec<crate::world::Key>> = Default::default();
    for (t, k) in reads {
        by_tx.entry(t).or_default().push(k);
    }
    for (t, keys) in by_tx {
        let Some(tx) = cx.w.txs.get(t) else { continue };
        let failed = cx.findings[mark..]
            .iter()
            .any(|f| f.severity == Severity::Fail && f.signature == tx.sig);
        if failed {
            continue;
        }
        let bell = frontier_abi::prologue::bell_at(cx.f.genesis_ts, tx.time).unwrap_or(0);
        let named: Vec<String> = keys.iter().map(b58).collect();
        cx.missing(
            check,
            format!("tx#{t}"),
            bell,
            Some(t),
            format!("{FROM_DECLARED}: {}", named.join(", ")),
        );
    }
}

/// Entity name for a report line.
pub fn ent(kind: &str, k: &[u8; 32]) -> String {
    format!("{kind}:{}", b58(k))
}

/// Runs every check that this build has.
pub fn run(input: &Input) -> Report {
    let mut w = World::parse(
        &input.cfg.program,
        &input.txs,
        input.finals.clone(),
        input.final_slot,
    );
    // verifier-v7-patches: every state before a transaction is the later of
    // the archived post-state and the recorder's declared patch.
    w.declare(&input.declared);
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
        owner_required: Default::default(),
    };
    let mut ran: Vec<&'static str> = vec![];
    // The findings of the check that runs next start here ([`soften_declared`]).
    let mut mark = cx.findings.len();
    // Each check, once run: its name in the report, and its judgements that
    // read a declared state through `World::state_before` and found no FAIL
    // become `MissingData`.
    macro_rules! ran {
        ($name:expr) => {{
            let name: &'static str = $name;
            ran.push(name);
            soften_declared(&mut cx, name, mark);
            mark = cx.findings.len();
        }};
    }
    // What this verifier can judge at all: unknown or unmodelled
    // instructions and program versions are never a PASS (V0).
    v0_coverage::run(&mut cx);
    ran!("V0");
    // The evidence those judgements need: logs present and whole, no
    // program call the archive does not show, post-states of what was
    // written (V0E, ⑪).
    v0_evidence::run(&mut cx);
    ran!("V0E");
    // States the archive DECLARES (a recorder's patches): no archived
    // transaction wrote them, so the season is never a PASS.
    if !input.declared.is_empty() {
        cx.unverifiable(
            "V0E",
            crate::codes::MISSING_DATA,
            "archive",
            0,
            None,
            format!(
                "the archive declares {} account state(s) no archived transaction wrote (a recorder's patches): {}",
                input.declared.len(),
                input
                    .declared
                    .iter()
                    .map(|d| d.what.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
                    .chars()
                    .take(600)
                    .collect::<String>()
            ),
        );
    }
    macro_rules! check {
        ($feat:literal, $name:literal, $m:ident) => {
            if !cfg!(feature = $feat) {
                $m::run(&mut cx);
                ran!($name);
            }
        };
    }
    // A conquest season's chains, conquest records included, are walked by
    // the conquest audit's CQ1 (`crate::verify` merges it); V1's walk sees
    // only M1's kinds. In an M1 season a conquest record is undecodable.
    if cx.v3 {
        ran!("V1:CQ1");
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
        ran!("V14:siege-declaration");
        v15_records::run(&mut cx);
        ran!("V15:conquest-records");
        v16_owner::run(&mut cx);
        ran!("V16:first-holding-owner");
        v17_captures::run(&mut cx);
        ran!("V17:capture-settlement");
        v19_folds::run(&mut cx);
        ran!("V19:march-folds");
        v20_end::run(&mut cx);
        ran!("V20:season-end");
        v22_outposts::run(&mut cx);
        ran!("V22:outpost-filing");
        // Map growth (a local candidate): every ExtendFrontier that stands
        // alone in its transaction re-judged from the states before it, its
        // Frontier post-state and its FRONTIER_EXTENDED record; a bundle
        // with another Frontier writer is MissingData (`v26_growth::guard`).
        v26_growth::run(&mut cx);
        ran!("V26:map-growth");
    }
    // S1 stages 1b, 1d and 1e: vaults, caravans, structures and nations, on
    // an S1 season only.
    if cx.s1 {
        v23_caravans::run(&mut cx);
        ran!("V23:caravans");
        v24_structures::run(&mut cx);
        ran!("V24:structures");
        v25_nations::run(&mut cx);
        ran!("V25:nations");
        v27_residents::run(&mut cx);
        ran!("V27:residents");
        v28_resident_acts::run(&mut cx);
        ran!("V28:resident-acts");
    }
    // Workstream 10: custody is checked in part (V26); any trace of it is
    // never a PASS (a season without custody FAILs on it).
    v26_custody::run(&mut cx);
    ran!("V26:custody-guard");
    // The wide world's event chains (VW1; experimental build only).
    #[cfg(feature = "wide-world-experimental")]
    {
        vw_chains::run(&mut cx);
        ran!("VW1:wide-chains");
        v28_resident_acts::run_wide(&mut cx);
        ran!("V28:wide-resident-acts");
    }
    if v26_custody::custody_season(&cx) {
        ran!("V26:custody-state");
        ran!("V26:custody-history");
        ran!("V26:custody-replay");
    }
    // Q16-1: the land preview's FoldLand / ClaimLandYield in a playable-lane
    // season (0x4804), re-run from the states before them.
    #[cfg(feature = "playable-lane")]
    if !cfg!(feature = "mutate-vl") {
        vl_land::run(&mut cx);
        ran!("VL:land");
    }
    // Q16-1 continued: the wide land opening, the wide claims, the
    // season-end closes and the wide economy / garrison of a playable-lane
    // season, re-run from the states before them.
    #[cfg(feature = "playable-lane")]
    if !cfg!(feature = "mutate-vwl") {
        vwl_wide_land::run(&mut cx);
        ran!("VWL:wide-land");
    }
    // Q16-1 = A (prize gate): the expedition wrapper and Free City conquest
    // of a playable-lane season, re-executed by the pinned program from the
    // archive's states.
    #[cfg(feature = "playable-lane")]
    if !cfg!(feature = "mutate-vx") {
        vx_reexec::run(&mut cx);
        ran!("VX:re-execution");
    }
    // 02-rights (candidate): the Grant's instructions, records and
    // accounts; on every season (outside S1 the program refuses them, so
    // any is a FAIL of its own).
    check!("mutate-vr", "VR:rights", vr_rights);
    let _ = mark;
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
        history: None,
        rent: None,
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
