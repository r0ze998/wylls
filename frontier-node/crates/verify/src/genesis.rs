//! VG — an archive **without post-states**, re-executed from the Season's
//! creation by the pinned program (Q16-1 = A, prize gate, 2026-11-19;
//! `playable-lane` build only).
//!
//! A public RPC's `getTransaction` gives each transaction's bytes, logs,
//! error, fee and `meta.preBalances` / `meta.postBalances`, but not the
//! account states it wrote (D-verify-pr81-3: `fclient` `rpc.rs` keeps
//! `post: vec![]`), and every check that replays from the states before a
//! transaction was UNVERIFIABLE on such an archive. VG closes that the way
//! a full node does when it replays its ledger from genesis (agave
//! `ledger-tool verify`): no post-state is needed, because every account the
//! program owns is created by an archived transaction of the program.
//!
//! Starting from no program account at all, every archived transaction is
//! executed again **in order** by the pinned `.so` in LiteSVM
//! ([`crate::reexec`]), each account it names starting from the state the
//! earlier re-executions left (data and owner) with exactly the lamports the
//! chain shows before it (`preBalances`). The derived post-states (the
//! re-run's data and owner, the chain's `postBalances` lamports) become the
//! archive's post-states, and every other check (V0–V28, VL, VWL, VX, CQ1)
//! then judges the season as it judges a local node's archive. VG's own
//! findings:
//!
//! * FAIL `ReExecRefused`: the archive says a transaction succeeded and the
//!   program refuses it (a program error code), or its signatures do not
//!   verify; or the archive says it failed with a program error code and
//!   the program does not fail with that code;
//! * FAIL `ReExecMismatch`: a successful transaction's program log lines
//!   (the runtime's compute accounting excepted) differ from the archive's;
//!   a program-owned account's lamports after it are not the chain's
//!   `postBalances`; a program-owned account holds fewer lamports before a
//!   transaction than the re-execution left it (only the program debits its
//!   accounts, and every transaction that invokes it names it); the final
//!   state of a program account (data, owner, existence; lamports below the
//!   re-run's) is not what the re-executions leave.
//!
//! UNVERIFIABLE (`MissingData`), never a PASS: no pinned binary or not the
//! pinned one; a program upgrade inside the archive (two `.so` hashes); a
//! transaction without archived balances, or with balances that do not name
//! its message's accounts; a re-run the runtime stops (not a program
//! error), and every later transaction that names an account it wrote (its
//! state is then unknown); a wallet whose movement differs from the chain's
//! (fees and other programs' accounts are not this program's to prove); a
//! runtime account (the System program, a sysvar) whose chain balance is
//! not LiteSVM's (D-verify-pr89-2: the receipts digest it); a transaction
//! that names the ProgramData when the upgrade authority was not read;
//! balances no chain can show (its accounts do not lose exactly its fee, a
//! read-only account's lamports move, a failed transaction moves more than
//! the fee payer's fee); an archive whose slots go back (not the chain's order) (verify-pr91).
//!
//! What VG assumes: the archive is the program's **whole** history from the
//! Season's creation, in the chain's order. A missing transaction that
//! changes a program account shows as a FAIL of a later one, or of the
//! final states; one that changes none does not (a failed transaction, a
//! success that leaves every account it writes as it was, a pair that
//! cancels out), nor does a swap of two transactions of one slot (or with
//! their slots swapped too) whose effects commute (verify-pr91 mutations).
//! ⑲'s history rule keeps an unproven history from a PASS (lifted only
//! when VG has no finding AND every witness RPC agrees: VS, `witness.rs`,
//! ⑰ Q-P1 = (a)+(b); when every witness agrees and VG FAILs, the verdict is
//! FAIL, never PASS: ⑰ Q-P2, `history.rs`); LiteSVM's runtime behaves as the cluster's for this
//! program (rent 5,080 lamports per byte; fees re-based on the fee payer
//! only); the program reads no account of another program (none in the
//! playable lane; such a state is not in this archive). A program-owned
//! account that holds MORE lamports than the re-run left is a credit (a
//! System transfer anyone can make), taken from the chain's balances.

use std::collections::{BTreeMap, BTreeSet};

use fclient::ports::Account;
use solana_address::Address;

use crate::codes::*;
use crate::input::{Balances, Input};
use crate::reexec::{judged_logs, replay_known, Pre, Program, Svm};
use crate::world::{b58, Key};
use crate::{Finding, Severity};

const V: &str = "VG";

/// The derivation's outcome.
pub struct Derived {
    /// The archive with each successful transaction's post-states as the
    /// pinned program leaves them (`None`: VG does not apply, or could not
    /// start).
    pub input: Option<Input>,
    /// VG's findings (always reported, also when `input` is `None`).
    pub findings: Vec<Finding>,
    /// Whether VG ran over the whole archive (for `checks_run`).
    pub ran: bool,
}

/// Whether VG applies: an archive without any post-state, with the
/// chain's balances.
pub fn applies(input: &Input) -> bool {
    !input.txs.is_empty()
        && input.txs.iter().all(|t| t.post.is_empty())
        && !input.chain.balances.is_empty()
}

fn finding(sev: Severity, code: &str, tx: Option<usize>, input: &Input, d: String) -> Finding {
    Finding {
        code: code.into(),
        severity: sev,
        check: V,
        entity: tx.map_or("archive".into(), |i| format!("tx#{i}")),
        bell: 0,
        signature: tx
            .and_then(|i| input.txs.get(i))
            .map(|t| t.signature.to_string())
            .unwrap_or_default(),
        detail: d,
    }
}

fn owned(a: &Option<Account>, program: &Key) -> bool {
    a.as_ref().is_some_and(|a| a.owner.to_bytes() == *program)
}

fn is_wallet(a: &Option<Account>, program: &Key) -> bool {
    a.as_ref()
        .is_none_or(|a| a.owner.to_bytes() != *program && a.data.is_empty())
}

/// With lamports `l` (an account of no data and no lamports is absent).
fn with_lamports(a: Option<Account>, l: u64) -> Option<Account> {
    match a {
        Some(mut a) => {
            a.lamports = l;
            (a.lamports > 0 || !a.data.is_empty()).then_some(a)
        }
        None if l > 0 => Some(Account {
            lamports: l,
            data: vec![],
            owner: Address::default(),
            executable: false,
        }),
        None => None,
    }
}

/// Why a transaction's archived balances are not ones a chain can show:
/// its accounts lose exactly its fee (`meta.fee`); a read-only account's
/// lamports do not move; a failed transaction moves only the fee payer's
/// (its fee). `None`: they can be.
fn balances_doubt(b: &Balances, writable: &[bool], ok: bool, fee: u64) -> Option<String> {
    let pre: u128 = b.pre.iter().map(|&x| x as u128).sum();
    let post: u128 = b.post.iter().map(|&x| x as u128).sum();
    if pre != post + fee as u128 {
        return Some(format!(
            "its accounts hold {pre} lamports before it and {post} after, and its fee is {fee}"
        ));
    }
    for (j, (x, y)) in b.pre.iter().zip(b.post.iter()).enumerate() {
        if x == y {
            continue;
        }
        if !writable.get(j).copied().unwrap_or(false) {
            return Some(format!(
                "the read-only account #{j} goes from {x} to {y} lamports"
            ));
        }
        if !ok && j > 0 {
            return Some(format!(
                "it failed, and account #{j} goes from {x} to {y} lamports"
            ));
        }
    }
    None
}

enum Judged {
    Ok,
    Fail(&'static str, String),
    Missing(String),
}

/// How VG takes each transaction's Clock (verifier-clock-fix, Q-W3VWS-1 =
/// a; fix-verify-clock, Q-WF2-1). The RPC gives a transaction's
/// `blockTime`, not the bank's `Clock.unix_timestamp` the program read, and
/// on devnet the two differ in some slots: blockTime one second above
/// (world 3 tx#21 and ~340 more), once two seconds above (world 3
/// tx#13720, slot 527244500: blockTime 1795872970, the program stamped
/// 1795872968 into its logs and 7 anchors). Never below. The Clock is
/// therefore read from the transaction's own recorded effects: the pinned
/// program is run at `blockTime − k` for every k in `0..=`[`CLOCK_LAG_MAX`],
/// and the Clock is the one under which its log lines (the program's records
/// carry the times it stamps), its program accounts' balances and its error
/// are exactly the chain's.
///
/// * One Clock per slot (one bank): once a transaction of a slot decides
///   it, every later transaction of the slot is run at that Clock only, and
///   every transaction of the slot is dated with it for the other checks
///   (V3, V7, VX, … read the derived archive's `block_time`).
/// * Only those candidates (a window as wide as devnet was seen to lag, no
///   wider), and only exact agreement: no tolerance is applied to any
///   comparison. A transaction no candidate reproduces is judged at the
///   slot's Clock, else at `blockTime`, as before.
/// * When several reproduce it and their runs leave different states (the
///   Clock went into account data the archive does not show: PostBeacon's
///   anchor time), the account write decides where the chain recorded it:
///   the chain's final state of an account this transaction is the last
///   writer of shows the Clock it stamped (a candidate whose run it does not
///   show is out). Otherwise it is taken at the first one left (nearest
///   `blockTime`) until a later transaction of the same slot decides the
///   slot's Clock; then its states are re-taken from that Clock's run
///   (UNVERIFIABLE [`OPEN_CLOCK`] when a later write already replaced them;
///   FAIL when the slot's Clock is not one that reproduces it). Never
///   decided: a later write replaced the stamp and every later transaction
///   reproduced from the state taken, so the archive is the program's under
///   that Clock (counted in the `ClockFromEffects` WARN).
///
/// What this proves: the archive is what the pinned program produces under
/// SOME Clock per slot, each `blockTime − k`, 0 ≤ k ≤ [`CLOCK_LAG_MAX`] (the
/// RPC's `blockTime` is no more authenticated than that). The search is
/// greedy (no back-tracking): a transaction whose state rests on a Clock
/// taken nearer `blockTime` that only a much later transaction contradicts
/// FAILs there.
///
/// An archive with post-states (a local node's, whose recorder stores the
/// bank's Clock as `block_time`) is not VG's: VX runs it at `block_time`.
pub struct ClockRule;

/// The most seconds the bank's Clock was seen below the RPC's `blockTime`
/// ([`ClockRule`]): 2 (world 3 tx#13720, slot 527244500; every other moved
/// slot of world 3's 13,785 transactions was 1, none was 3 or above, none
/// was above `blockTime`). Q-WF2-1 (r0ze): widen only on chain evidence; a
/// larger lag stays a FAIL that stops the watch.
pub const CLOCK_LAG_MAX: i64 = 2;

/// The detail prefix of an undecided Clock (UNVERIFIABLE).
pub const OPEN_CLOCK: &str = "the Clock this transaction read is not decided";

/// A transaction several candidate Clocks reproduce, whose runs leave
/// different states ([`ClockRule`]): taken at `used` until its slot's Clock
/// is decided.
struct Open {
    tx: usize,
    slot: u64,
    used: i64,
    /// The other candidate Clocks that reproduce it.
    others: Vec<i64>,
    /// Each account the runs leave differently: the state taken (at
    /// `used`) and, one per `others`, the other runs' (chain lamports in
    /// all).
    accounts: Vec<(Key, Option<Account>, Vec<Option<Account>>)>,
    /// Re-taken at the slot's decided Clock.
    fixed: bool,
    /// A later transaction named one of `accounts` (read or wrote it)
    /// while the slot's Clock was undecided: it ran on the state taken at
    /// `used`, so re-taking the other run's state would leave its judgement
    /// resting on a state that is no longer the derived one (verify-pr266).
    touched: bool,
}

/// Q-VCF-2 (owner question, recommended "no" = WARN): when `true`, every
/// transaction whose stamped Clock nothing the chain recorded decides is
/// UNVERIFIABLE ([`OPEN_CLOCK`]) instead of being counted in the
/// `ClockFromEffects` WARN. Flip this one line if r0ze answers Q-VCF-2
/// with "stricter".
pub const UNDECIDED_CLOCK_UNVERIFIABLE: bool = false;

/// The Clock of `slot` is `c` ([`ClockRule`]): every open transaction of the
/// slot taken at another Clock gets `c`'s run's states, as long as no later
/// transaction read or wrote them since (else it stays unfixed, reported
/// UNVERIFIABLE) and `c` reproduces it (else it stays unfixed, reported
/// FAIL).
fn decide(
    clocks: &mut BTreeMap<u64, i64>,
    open: &mut [Open],
    state: &mut BTreeMap<Key, Option<Account>>,
    derived: &mut [fclient::ports::TxRecord],
    slot: u64,
    c: i64,
) {
    clocks.insert(slot, c);
    for o in open
        .iter_mut()
        .filter(|o| o.slot == slot && o.used != c && !o.fixed)
    {
        if o.touched {
            continue;
        }
        let Some(n) = o.others.iter().position(|x| *x == c) else {
            continue;
        };
        if o.accounts
            .iter()
            .any(|(k, used, _)| state.get(k) != Some(used))
        {
            continue;
        }
        for (k, _, others) in &o.accounts {
            let other = &others[n];
            state.insert(*k, other.clone());
            for (a, p) in derived[o.tx].post.iter_mut() {
                if a.to_bytes() == *k {
                    *p = other.clone();
                }
            }
        }
        o.used = c;
        o.fixed = true;
    }
}

/// Whether the bytes in which the run taken (`used`) and the other run
/// (`other`) leave an account differently are, at the end, still the taken
/// run's in the derived state (`now`) and the other run's in the chain's
/// final state.
fn survives(
    now: Option<Account>,
    used: &Option<Account>,
    other: &Option<Account>,
    fin: Option<&Option<Account>>,
) -> bool {
    let (Some(now), Some(used), Some(other), Some(Some(fin))) =
        (now, used.as_ref(), other.as_ref(), fin)
    else {
        return false;
    };
    let n = used.data.len();
    if other.data.len() != n || now.data.len() != n || fin.data.len() != n {
        return false;
    }
    let at: Vec<usize> = (0..n).filter(|&o| used.data[o] != other.data[o]).collect();
    !at.is_empty()
        && at
            .iter()
            .all(|&o| now.data[o] == used.data[o] && fin.data[o] == other.data[o])
}

/// A re-run judged against what the chain recorded of the transaction
/// (its error and program error code; for a success its log lines and the
/// lamports it leaves). A debit before it is judged by the caller.
fn judge_run(
    r: &crate::reexec::Replayed,
    rec: &fclient::ports::TxRecord,
    bal: &Balances,
    writable: &[bool],
    program: &Key,
) -> Judged {
    if rec.err.is_some() {
        // A failed transaction changes nothing but balances. When the
        // chain names a program error, the program must fail with it.
        return match (rec.code, &r.err) {
            (Some(c), None) => Judged::Fail(REEXEC_REFUSED, format!("the archive says it failed with program error {c}, and the pinned program runs it to success from the states before it")),
            (Some(c), Some(e)) => match fclient::ports::custom_code(e) {
                Some(g) if g == c => Judged::Ok,
                Some(g) => Judged::Fail(REEXEC_REFUSED, format!("the archive says it failed with program error {c}, the pinned program fails it with {g}")),
                None => Judged::Missing(format!("the archive says it failed with program error {c}; the re-run stopped in the runtime ({e})")),
            },
            // A runtime failure (compute budget, funds): not the
            // program's to prove; the state stays as before.
            (None, _) => Judged::Ok,
        };
    }
    if let Some(err) = &r.err {
        return if err.contains("SignatureFailure") {
            Judged::Fail(REEXEC_REFUSED, format!("the archived transaction's signatures do not verify ({err}), yet the archive says it succeeded"))
        } else {
            match fclient::ports::custom_code(err) {
                Some(code) => Judged::Fail(REEXEC_REFUSED, format!("the pinned program refuses this transaction from the states its history leaves (code {code}: {err}), yet the archive says it succeeded")),
                None => Judged::Missing(format!("the re-run stopped in the runtime, not in the program ({err})")),
            }
        };
    }
    if rec.logs.iter().any(|l| l.contains("Log truncated")) {
        return Judged::Missing("the archived logs are cut by the runtime".into());
    }
    let got = judged_logs(&r.logs);
    let want = judged_logs(&rec.logs);
    if got != want {
        let at = got
            .iter()
            .zip(want.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        return Judged::Fail(REEXEC_MISMATCH, format!("the program's log lines differ from the archive's at line {at}: re-run {:?}, archive {:?}", got.get(at), want.get(at)));
    }
    for (j, (k, how, before, after)) in r.accounts.iter().enumerate() {
        if *how == Pre::Runtime || !writable[j] {
            continue;
        }
        let l = after.as_ref().map_or(0, |a| a.lamports);
        if l == bal.post[j] {
            continue;
        }
        if owned(before, program) || owned(after, program) {
            return Judged::Fail(REEXEC_MISMATCH, format!("account {}: the chain shows {} lamports after it, the pinned program leaves {l}", b58(k), bal.post[j]));
        }
        if is_wallet(before, program) && is_wallet(after, program) {
            return Judged::Missing(format!("wallet {}: the chain shows {} lamports after it, the re-run leaves {l} (a movement this program's archive cannot explain)", b58(k), bal.post[j]));
        }
        return Judged::Missing(format!(
            "account {} (another program's): the chain shows {} lamports after it, the re-run {l}",
            b58(k),
            bal.post[j]
        ));
    }
    Judged::Ok
}

/// Most re-derivations [`ClockRule`] makes when final states decide the
/// Clock of slots a pass left undecided.
const CLOCK_PASSES: usize = 4;

/// Re-executes the archive from the Season's creation (see the module doc).
pub fn derive(input: &Input) -> Derived {
    let mut hints: BTreeMap<u64, i64> = BTreeMap::new();
    let mut pass = 0;
    loop {
        pass += 1;
        let (d, more) = derive_pass(input, &hints);
        let more: BTreeMap<u64, i64> = more
            .into_iter()
            .filter(|(s, _)| !hints.contains_key(s))
            .collect();
        if more.is_empty() || pass >= CLOCK_PASSES {
            return d;
        }
        hints.extend(more);
    }
}

/// One pass of [`derive`], each slot of `hints` run at that Clock only.
/// Also returns the slots whose Clock the final states decide although
/// this pass left them undecided (a stamp the two candidate runs leave
/// differently survives, unwritten since, into the chain's final state).
fn derive_pass(input: &Input, hints: &BTreeMap<u64, i64>) -> (Derived, BTreeMap<u64, i64>) {
    let mut out = Derived {
        input: None,
        findings: vec![],
        ran: false,
    };
    if !applies(input) {
        return (out, BTreeMap::new());
    }
    let program = input.cfg.program.to_bytes();
    let missing = |out: &mut Derived, d: String| {
        out.findings.push(finding(
            Severity::Unverifiable,
            MISSING_DATA,
            None,
            input,
            d,
        ));
    };
    let Some(so) = input.program_so.as_ref() else {
        missing(&mut out, "the archive has no post-states; without the pinned program binary (`--program-so`) it is not re-executed from the Season's creation".into());
        return (out, BTreeMap::new());
    };
    // (the season's rent: chain / declared / assumed, reexec::rent_of — rent-live-rest)
    let so = Program::with_rent(so.as_ref().clone(), crate::reexec::rent_of(input).0);
    if input.cfg.program_hash != Some(so.sha256()) {
        missing(
            &mut out,
            format!(
                "the archive has no post-states, and the program binary given (sha256 {}) is not the pinned one: not re-executed",
                hex::encode(so.sha256())
            ),
        );
        return (out, BTreeMap::new());
    }
    let hashes: BTreeSet<[u8; 32]> = input.program_hashes.iter().map(|(_, h)| *h).collect();
    if hashes.len() > 1 {
        missing(&mut out, format!("the program was upgraded inside the archive ({} binaries): one pinned binary cannot re-execute it", hashes.len()));
        return (out, BTreeMap::new());
    }
    let mut svm = match Svm::with_authority(&so, &input.cfg.program, input.chain.upgrade_authority)
    {
        Ok(s) => s,
        Err(e) => {
            missing(&mut out, format!("the program binary does not load: {e}"));
            return (out, BTreeMap::new());
        }
    };
    out.ran = true;
    // The re-executions' states (data, owner; lamports as the chain's
    // postBalances left them), and the accounts whose state is unknown.
    let mut state: BTreeMap<Key, Option<Account>> = BTreeMap::new();
    let mut declared_at: BTreeSet<Key> = BTreeSet::new();
    let mut unknown: BTreeSet<Key> = BTreeSet::new();
    let mut derived = input.clone();
    // [`ClockRule`]: the Clock each slot's transactions decided, and the
    // transactions whose state rests on an undecided one (tx, slot, Clock used).
    let mut clocks: BTreeMap<u64, i64> = hints.clone();
    let mut open: Vec<Open> = vec![];
    // The last successful transaction that writes each account (its final
    // state, read from the chain, shows that write).
    let mut last_writer: BTreeMap<Key, usize> = BTreeMap::new();
    for (i, rec) in input.txs.iter().enumerate() {
        if rec.err.is_some() {
            continue;
        }
        if let Ok(m) = crate::vmsg::Msg::of(rec) {
            for (j, k) in m.keys.iter().enumerate() {
                if m.is_writable_index(j) {
                    last_writer.insert(k.to_bytes(), i);
                }
            }
        }
    }
    let mut runtime_noted: BTreeSet<Key> = BTreeSet::new();
    let mut last_slot = 0u64;
    for (i, rec) in input.txs.iter().enumerate() {
        // The archive's order must be the chain's: slots never go back
        // (verify-pr91; transactions of one slot cannot be ordered here).
        if rec.slot < last_slot {
            out.findings.push(finding(
                Severity::Unverifiable,
                MISSING_DATA,
                Some(i),
                input,
                format!(
                    "the archive puts it (slot {}) after a transaction of slot {last_slot}: not the chain's order, so the re-executions are not the chain's",
                    rec.slot
                ),
            ));
        }
        last_slot = last_slot.max(rec.slot);
        // A recorder's declared patch, in force from before `txs[at]`.
        for d in input.declared.iter().filter(|d| d.at == i) {
            state.insert(d.key, d.account.clone());
            declared_at.insert(d.key);
            unknown.remove(&d.key);
        }
        let ok = rec.err.is_none();
        let push = |out: &mut Derived, j: Judged| match j {
            Judged::Ok => {}
            Judged::Fail(code, d) => {
                out.findings
                    .push(finding(Severity::Fail, code, Some(i), input, d))
            }
            Judged::Missing(d) => out.findings.push(finding(
                Severity::Unverifiable,
                MISSING_DATA,
                Some(i),
                input,
                d,
            )),
        };
        let parsed = match crate::vmsg::Msg::of(rec) {
            Ok(t) => t,
            Err(e) => {
                // V0 judges an undecodable transaction; its effects are unknown.
                push(
                    &mut out,
                    Judged::Missing(format!("the transaction does not decode ({e})")),
                );
                continue;
            }
        };
        let keys: Vec<Key> = parsed.keys.iter().map(|k| k.to_bytes()).collect();
        // [`ClockRule`] (verify-pr266): a transaction that names an account
        // an open transaction of an undecided slot left runs on the state
        // taken at that Clock, which can then no longer be re-taken.
        for o in open
            .iter_mut()
            .filter(|o| !o.fixed && !clocks.contains_key(&o.slot))
        {
            if o.accounts.iter().any(|(k, _, _)| keys.contains(k)) {
                o.touched = true;
            }
        }
        let writable: Vec<bool> = (0..keys.len())
            .map(|j| parsed.is_writable_index(j))
            .collect();
        let runtime: Vec<bool> = parsed.keys.iter().map(|k| svm.runtime(k)).collect();
        let mark_unknown = |unknown: &mut BTreeSet<Key>| {
            for (j, k) in keys.iter().enumerate() {
                if writable[j] && !runtime[j] {
                    unknown.insert(*k);
                }
            }
        };
        let Some(bal) = input.chain.of(rec) else {
            push(
                &mut out,
                Judged::Missing("the archive has no balances (`meta.preBalances` / `postBalances`) of this transaction: it is not re-executed".into()),
            );
            if ok {
                mark_unknown(&mut unknown);
            }
            continue;
        };
        if bal.pre.len() != keys.len() || bal.post.len() != keys.len() {
            push(
                &mut out,
                Judged::Missing(format!(
                    "the archived balances name {} / {} accounts, the message {}",
                    bal.pre.len(),
                    bal.post.len(),
                    keys.len()
                )),
            );
            if ok {
                mark_unknown(&mut unknown);
            }
            continue;
        }
        // The balances must be ones a chain can show (verify-pr91): never a
        // PASS otherwise. It is still re-executed, so that a FAIL the
        // re-run shows (an archive no chain produced) stays a FAIL.
        if let Some(d) = balances_doubt(bal, &writable, ok, rec.fee) {
            push(
                &mut out,
                Judged::Missing(format!("the archived balances are not a chain's: {d}")),
            );
        }
        if let Some(k) = keys.iter().find(|k| unknown.contains(*k)) {
            if ok {
                push(&mut out, Judged::Missing(format!("it names {}, whose state an earlier transaction left unknown (not re-executed)", b58(k))));
                mark_unknown(&mut unknown);
            }
            continue;
        }
        // Before it: the program's accounts hold at least what the
        // re-executions left them (only the program debits them).
        let mut doubt: Vec<String> = vec![];
        let mut early: Option<Judged> = None;
        for (j, k) in keys.iter().enumerate() {
            let a = Address::new_from_array(*k);
            if a == svm.programdata() && input.chain.upgrade_authority.is_some() {
                // (ours to set: the chain's ProgramData is padded to max_len)
                if let Err(e) = svm.set_programdata_lamports(bal.pre[j]) {
                    doubt.push(e);
                }
                continue;
            }
            if let Some(l) = svm.runtime_lamports(&a) {
                // D-verify-pr89-2: the receipts digest the runtime accounts'
                // lamports too; LiteSVM's must be the chain's.
                if l != bal.pre[j] {
                    doubt.push(format!(
                        "the runtime account {} holds {} lamports on the chain, {l} in LiteSVM",
                        b58(k),
                        bal.pre[j]
                    ));
                    if runtime_noted.insert(*k) {
                        missing(&mut out, format!("D-verify-pr89-2: the runtime account {} holds {} lamports on the chain (tx#{i}), {l} in the re-execution; a receipt that digests it cannot be judged", b58(k), bal.pre[j]));
                    }
                }
                continue;
            }
            if let Some(s) = state.get(k) {
                if owned(s, &program) {
                    let have = s.as_ref().map_or(0, |a| a.lamports);
                    if bal.pre[j] < have && early.is_none() {
                        early = Some(Judged::Fail(REEXEC_MISMATCH, format!("account {}: the chain shows {} lamports before it, {} fewer than the program's earlier transactions left (only the program debits its account, and every transaction that invokes it is in its history)", b58(k), bal.pre[j], have - bal.pre[j])));
                    }
                }
            }
        }
        // A program account this transaction does not write (read-only, or
        // the transaction failed) keeps the lamports the chain shows before
        // it (a credit, if more: checked above): a later transaction must
        // not show it with fewer (verify-pr91).
        for (j, k) in keys.iter().enumerate() {
            if ok && writable[j] {
                continue;
            }
            if let Some(Some(a)) = state.get_mut(k) {
                if a.owner.to_bytes() == program && bal.pre[j] > a.lamports {
                    a.lamports = bal.pre[j];
                }
            }
        }
        if input.chain.upgrade_authority.is_none() {
            let (pd, _) = Address::find_program_address(
                &[input.cfg.program.as_ref()],
                &"BPFLoaderUpgradeab1e11111111111111111111111"
                    .parse()
                    .expect("the LoaderV3 id"),
            );
            if keys.contains(&pd.to_bytes()) {
                doubt.push("the program's ProgramData (its upgrade authority was not read)".into());
            }
        }
        let pre = |k: &Key| -> Option<(Pre, Option<Account>)> {
            state.get(k).map(|s| {
                (
                    if declared_at.contains(k) {
                        Pre::Declared
                    } else {
                        Pre::Archive
                    },
                    s.clone(),
                )
            })
        };
        // verifier-clock-fix (Q-W3VWS-1 = a): the Clock the program read is
        // not in the RPC's answer. `blockTime` is the slot's time as the RPC
        // node stores it, and on devnet it is sometimes one second above the
        // bank's `Clock.unix_timestamp` (world 3 tx#21: blockTime
        // 1795663037, the program logged 1795663036). The Clock is taken
        // from the transaction's own effects instead ([`ClockRule`]).
        let base = rec.block_time;
        // (fix-verify-clock: once 2 s, tx#13720; [`CLOCK_LAG_MAX`])
        let feasible: Vec<i64> = clocks
            .get(&rec.slot)
            .map(|c| vec![*c])
            .unwrap_or_else(|| (0..=CLOCK_LAG_MAX).map(|k| base - k).collect());
        let mut runs: Vec<(i64, crate::reexec::Replayed, Judged)> = vec![];
        let mut refused: Option<String> = None;
        for &t in &feasible {
            match replay_known(
                &mut svm,
                &parsed,
                rec.slot,
                t,
                pre,
                |_| None,
                &program,
                Some((&bal.pre, &bal.post, rec.fee)),
            ) {
                Ok(r) => {
                    let j = judge_run(&r, rec, bal, &writable, &program);
                    runs.push((t, r, j));
                }
                Err(e) => {
                    refused.get_or_insert(e);
                }
            }
        }
        if runs.is_empty() {
            push(
                &mut out,
                Judged::Missing(format!(
                    "the transaction does not re-execute: {}",
                    refused.unwrap_or_default()
                )),
            );
            if ok {
                mark_unknown(&mut unknown);
            }
            continue;
        }
        let fits: Vec<usize> = (0..runs.len())
            .filter(|&k| matches!(runs[k].2, Judged::Ok))
            .collect();
        let pick = match fits.as_slice() {
            // Neither reproduces it: judged at the first candidate (the
            // slot's decided Clock, else blockTime), as before.
            [] => 0,
            // Exactly one Clock reproduces what the chain recorded: that is
            // the slot's Clock (one Clock per slot), for every transaction
            // of the slot.
            [k] => {
                decide(
                    &mut clocks,
                    &mut open,
                    &mut state,
                    &mut derived.txs,
                    rec.slot,
                    runs[*k].0,
                );
                *k
            }
            // Several reproduce its logs, balances and error. The states
            // their runs leave may still differ (the Clock stamped into
            // account data: PostBeacon's anchor time); then the chain's
            // final state of an account it is the last writer of decides
            // (it shows the Clock that last write stamped: a candidate
            // whose run it does not show is out), else it stays open until
            // a later transaction of its slot decides the slot.
            many => {
                let a = many[0];
                // the accounts some two of the runs leave differently
                let differ = |j: usize, ks: &[usize]| {
                    let x = &runs[ks[0]].1.accounts[j];
                    x.1 != Pre::Runtime
                        && writable[j]
                        && ks[1..].iter().any(|&k| runs[k].1.accounts[j].3 != x.3)
                };
                let n = runs[a].1.accounts.len();
                let last: Vec<(Key, usize)> = (0..n)
                    .filter(|&j| differ(j, many))
                    .map(|j| (runs[a].1.accounts[j].0, j))
                    .filter(|(k, _)| last_writer.get(k) == Some(&i) && input.finals.contains_key(k))
                    .collect();
                let shows = |k: usize| {
                    last.iter().all(|(key, j)| {
                        let f = input.finals.get(key).cloned().flatten();
                        let s = runs[k].1.accounts[*j].3.as_ref();
                        match (s, f.as_ref()) {
                            (None, None) => true,
                            (Some(s), Some(f)) => s.owner == f.owner && s.data == f.data,
                            _ => false,
                        }
                    })
                };
                let showing: Vec<usize> = many.iter().copied().filter(|&k| shows(k)).collect();
                // (none shows it: every candidate stays; the final states FAIL)
                let cands: Vec<usize> = if last.is_empty() || showing.is_empty() {
                    many.to_vec()
                } else {
                    showing
                };
                let alt: Vec<(Key, Option<Account>, Vec<Option<Account>>)> = (0..n)
                    .filter(|&j| cands.len() > 1 && differ(j, &cands))
                    .map(|j| {
                        let at =
                            |k: usize| with_lamports(runs[k].1.accounts[j].3.clone(), bal.post[j]);
                        (
                            runs[a].1.accounts[j].0,
                            at(cands[0]),
                            cands[1..].iter().map(|&k| at(k)).collect(),
                        )
                    })
                    .collect();
                let same_err = cands.iter().all(|&k| runs[k].1.err == runs[cands[0]].1.err);
                // (a failed transaction leaves no state: nothing to decide)
                if !ok {
                    a
                } else if cands.len() == 1 {
                    let k = cands[0];
                    decide(
                        &mut clocks,
                        &mut open,
                        &mut state,
                        &mut derived.txs,
                        rec.slot,
                        runs[k].0,
                    );
                    k
                } else if alt.is_empty() && same_err {
                    cands[0]
                } else {
                    open.push(Open {
                        tx: i,
                        slot: rec.slot,
                        used: runs[cands[0]].0,
                        others: cands[1..].iter().map(|&k| runs[k].0).collect(),
                        accounts: alt,
                        fixed: false,
                        touched: false,
                    });
                    cands[0]
                }
            }
        };
        let (_, r, judged0) = runs.swap_remove(pick);
        let soften = |j: Judged| -> Judged {
            match j {
                Judged::Fail(_, d) if !doubt.is_empty() => Judged::Missing(format!(
                    "{d}; but {}, so the re-run cannot be shown to start from the chain's states",
                    doubt.join("; ")
                )),
                j => j,
            }
        };
        // (a debit outside the program comes first, before a failure too)
        let judged = match early.take() {
            Some(e @ Judged::Fail(..)) => e,
            _ => judged0,
        };
        if !ok {
            push(&mut out, soften(judged));
            continue;
        }
        let judged = soften(judged);
        let stop = matches!(judged, Judged::Missing(_)) && r.err.is_some();
        push(&mut out, judged);
        if stop {
            mark_unknown(&mut unknown);
            continue;
        }
        // The derived post-states: every writable account it names, as the
        // re-run leaves it, with the chain's lamports.
        let mut post = vec![];
        for (j, (k, how, _, after)) in r.accounts.iter().enumerate() {
            if *how == Pre::Runtime || !writable[j] {
                continue;
            }
            let a = with_lamports(after.clone(), bal.post[j]);
            state.insert(*k, a.clone());
            declared_at.remove(k);
            post.push((Address::new_from_array(*k), a));
        }
        derived.txs[i].post = post;
    }
    // [`ClockRule`]: every transaction of a decided slot is dated with the
    // slot's Clock in the derived archive (the other checks read it).
    let mut moved: BTreeMap<u64, (i64, i64, usize)> = BTreeMap::new();
    for (i, rec) in input.txs.iter().enumerate() {
        if let Some(&c) = clocks.get(&rec.slot) {
            if c != rec.block_time {
                derived.txs[i].block_time = c;
                let e = moved.entry(rec.slot).or_insert((rec.block_time, c, 0));
                e.2 += 1;
            }
        }
    }
    let mut undecided = 0usize;
    let mut below = 0usize;
    let mut more: BTreeMap<u64, i64> = BTreeMap::new();
    for o in &open {
        // Never decided in this pass: the chain's final state of an account
        // it stamped, unwritten since at the stamped bytes, shows another
        // run's bytes: the next pass runs the slot at that Clock.
        let shown = || {
            (0..o.others.len()).find(|&n| {
                o.accounts.iter().any(|(k, used, others)| {
                    survives(
                        state.get(k).cloned().flatten(),
                        used,
                        &others[n],
                        input.finals.get(k),
                    )
                })
            })
        };
        match clocks.get(&o.slot) {
            None if shown().is_some() => {
                let n = shown().expect("checked");
                more.insert(o.slot, o.others[n]);
            }
            // Never decided: nothing the chain recorded shows the Clock it
            // stamped (a later write replaced it, and every later
            // transaction reproduced from the state taken at `used`).
            None => {
                undecided += 1;
                if o.used != input.txs[o.tx].block_time {
                    below += 1;
                }
                if UNDECIDED_CLOCK_UNVERIFIABLE {
                    out.findings.push(finding(
                        Severity::Unverifiable,
                        MISSING_DATA,
                        Some(o.tx),
                        input,
                        format!(
                            "{OPEN_CLOCK}: each of {} reproduces it and nothing the chain recorded shows which one it stamped (Q-VCF-2)",
                            std::iter::once(o.used)
                                .chain(o.others.iter().copied())
                                .map(|c| c.to_string())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    ));
                }
            }
            Some(c) if *c == o.used => {}
            // (fix-verify-clock) the slot's Clock is not one that reproduces
            // it: no one Clock of the slot reproduces the slot.
            Some(c) if !o.others.contains(c) => out.findings.push(finding(
                Severity::Fail,
                REEXEC_MISMATCH,
                Some(o.tx),
                input,
                format!(
                    "another transaction of slot {} decides the slot's Clock to be {c}, but it reproduces the chain's record only at {} (one Clock per slot)",
                    o.slot,
                    std::iter::once(o.used)
                        .chain(o.others.iter().copied())
                        .map(|c| c.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )),
            Some(c) => out.findings.push(finding(
                Severity::Unverifiable,
                MISSING_DATA,
                Some(o.tx),
                input,
                format!(
                    "{OPEN_CLOCK}: another transaction of slot {} decides its Clock to be {c}, but the state it left (taken at {}) was read or written again before that, so it cannot be re-taken",
                    o.slot, o.used
                ),
            )),
        }
    }
    // (verify-pr266: also when no slot moved: an undecided stamp taken at
    // blockTime is not proven by blockTime either, so it is always counted)
    if !moved.is_empty() || undecided > 0 {
        let txs: usize = moved.values().map(|m| m.2).sum();
        let first = moved
            .iter()
            .next()
            .map(|(s, m)| format!("; first: slot {s} blockTime {} → Clock {}", m.0, m.1))
            .unwrap_or_default();
        // (fix-verify-clock: the text is the earlier one when every moved
        // slot moved by 1 and every undecided stamp was taken at blockTime)
        let mut by_lag: BTreeMap<i64, (usize, usize)> = BTreeMap::new();
        for m in moved.values() {
            let e = by_lag.entry(m.0 - m.1).or_default();
            e.0 += 1;
            e.1 += m.2;
        }
        let at = if by_lag.keys().all(|&k| k == 1) {
            "blockTime − 1".to_string()
        } else {
            by_lag
                .iter()
                .map(|(k, (sl, t))| format!("blockTime − {k} ({t} in {sl} slot(s))"))
                .collect::<Vec<_>>()
                .join(" or ")
        };
        let taken = if below == 0 {
            "taken at blockTime".to_string()
        } else {
            format!(
                "taken at the Clock nearest blockTime that reproduces it ({below} of them below blockTime)"
            )
        };
        out.findings.push(finding(
            Severity::Warn,
            CLOCK_FROM_EFFECTS,
            None,
            input,
            format!(
                "Clock from the transactions' effects, not the RPC's blockTime: {txs} transaction(s) in {} slot(s) re-executed at {at}, the only Clock of their slot that reproduces the program's recorded logs, balances, errors and final states (one Clock per slot){first}; {undecided} transaction(s) stamped a Clock nothing the chain recorded decides (a later write replaced it and every later transaction reproduced): {taken}",
                moved.len(),
            ),
        ));
    }
    // The end: the final states read from the chain are what the
    // re-executions leave.
    let mut keys: BTreeSet<Key> = input.finals.keys().copied().collect();
    keys.extend(
        state
            .iter()
            .filter(|(_, a)| owned(a, &program))
            .map(|(k, _)| *k),
    );
    for k in keys {
        if unknown.contains(&k) {
            continue;
        }
        let s = state.get(&k).cloned().flatten();
        let Some(f) = input.finals.get(&k) else {
            missing(
                &mut out,
                format!(
                    "the program account {} has no final state in the input",
                    b58(&k)
                ),
            );
            continue;
        };
        if !owned(&s, &program) && !owned(f, &program) {
            continue;
        }
        let bad = match (&s, f) {
            (None, Some(_)) => {
                Some("the final state shows it, no archived transaction created it".to_string())
            }
            (Some(_), None) => {
                Some("the archived transactions leave it, the final state shows it absent".into())
            }
            (Some(x), Some(y)) if x.owner != y.owner => Some(format!(
                "owner {} after the re-executions, {} finally",
                x.owner, y.owner
            )),
            (Some(x), Some(y)) if x.data != y.data => Some(format!(
                "its final data differs from what the re-executions leave (first at byte {})",
                x.data
                    .iter()
                    .zip(y.data.iter())
                    .position(|(a, b)| a != b)
                    .unwrap_or(x.data.len().min(y.data.len()))
            )),
            (Some(x), Some(y)) if y.lamports < x.lamports => Some(format!(
                "{} lamports fewer finally than the re-executions leave",
                x.lamports - y.lamports
            )),
            _ => None,
        };
        if let Some(d) = bad {
            out.findings.push(finding(
                Severity::Fail,
                REEXEC_MISMATCH,
                None,
                input,
                format!("account {}: {d}", b58(&k)),
            ));
        }
    }
    derived.provenance = format!(
        "{} [VG: post-states derived by re-executing the archive from the Season's creation with the pinned program]",
        input.provenance
    );
    out.input = Some(derived);
    (out, more)
}

#[cfg(test)]
mod clock_rule {
    use super::*;

    fn acc(stamp: u8) -> Option<Account> {
        Some(Account {
            lamports: 10,
            data: vec![1, 2, stamp, 4],
            owner: Address::new_from_array([9; 32]),
            executable: false,
        })
    }

    fn one_tx() -> Vec<fclient::ports::TxRecord> {
        vec![Default::default()]
    }

    #[test]
    fn a_slots_decided_clock_re_takes_its_open_transactions() {
        let k = [7u8; 32];
        let mut inp = one_tx();
        inp[0].post = vec![(Address::new_from_array(k), acc(0x10))];
        let mut state = BTreeMap::from([(k, acc(0x10))]);
        let mut open = vec![Open {
            tx: 0,
            slot: 5,
            used: 100,
            others: vec![99],
            accounts: vec![(k, acc(0x10), vec![acc(0x0f)])],
            fixed: false,
            touched: false,
        }];
        let mut clocks = BTreeMap::new();
        decide(&mut clocks, &mut open, &mut state, &mut inp, 5, 99);
        assert_eq!(clocks.get(&5), Some(&99));
        assert!(open[0].fixed && open[0].used == 99);
        assert_eq!(state.get(&k), Some(&acc(0x0f)));
        assert_eq!(inp[0].post[0].1, acc(0x0f));
    }

    #[test]
    fn a_state_written_again_since_is_not_re_taken() {
        let k = [7u8; 32];
        let mut inp = one_tx();
        let mut state = BTreeMap::from([(k, acc(0x33))]);
        let mut open = vec![Open {
            tx: 0,
            slot: 5,
            used: 100,
            others: vec![99],
            accounts: vec![(k, acc(0x10), vec![acc(0x0f)])],
            fixed: false,
            touched: false,
        }];
        let mut clocks = BTreeMap::new();
        decide(&mut clocks, &mut open, &mut state, &mut inp, 5, 99);
        assert!(!open[0].fixed);
        assert_eq!(state.get(&k), Some(&acc(0x33)));
        // another slot's decision never touches it
        decide(&mut clocks, &mut open, &mut state, &mut inp, 6, 99);
        assert!(!open[0].fixed);
    }

    #[test]
    fn a_state_read_since_is_not_re_taken() {
        // verify-pr266: a later transaction of the slot named the account
        // (read it, state unchanged) while the Clock was open: it ran on
        // the state taken at `used`, so the other run's state is not
        // re-taken (the open transaction is reported UNVERIFIABLE).
        let k = [7u8; 32];
        let mut inp = one_tx();
        inp[0].post = vec![(Address::new_from_array(k), acc(0x10))];
        let mut state = BTreeMap::from([(k, acc(0x10))]);
        let mut open = vec![Open {
            tx: 0,
            slot: 5,
            used: 100,
            others: vec![99],
            accounts: vec![(k, acc(0x10), vec![acc(0x0f)])],
            fixed: false,
            touched: true,
        }];
        let mut clocks = BTreeMap::new();
        decide(&mut clocks, &mut open, &mut state, &mut inp, 5, 99);
        assert_eq!(clocks.get(&5), Some(&99));
        assert!(!open[0].fixed && open[0].used == 100);
        assert_eq!(state.get(&k), Some(&acc(0x10)));
        assert_eq!(inp[0].post[0].1, acc(0x10));
    }

    #[test]
    fn a_decided_clock_re_takes_the_matching_one_of_several_runs() {
        // fix-verify-clock: three candidates; the slot's Clock picks its own
        // run's state, not another's.
        let k = [7u8; 32];
        let mut inp = one_tx();
        inp[0].post = vec![(Address::new_from_array(k), acc(0x10))];
        let mut state = BTreeMap::from([(k, acc(0x10))]);
        let mut open = vec![Open {
            tx: 0,
            slot: 5,
            used: 100,
            others: vec![99, 98],
            accounts: vec![(k, acc(0x10), vec![acc(0x0f), acc(0x0e)])],
            fixed: false,
            touched: false,
        }];
        let mut clocks = BTreeMap::new();
        decide(&mut clocks, &mut open, &mut state, &mut inp, 5, 98);
        assert!(open[0].fixed && open[0].used == 98);
        assert_eq!(state.get(&k), Some(&acc(0x0e)));
        assert_eq!(inp[0].post[0].1, acc(0x0e));
    }

    #[test]
    fn a_decided_clock_that_does_not_reproduce_it_re_takes_nothing() {
        // The slot's Clock is none of the runs that reproduce it: its state
        // stays (reported FAIL at the end of the pass).
        let k = [7u8; 32];
        let mut inp = one_tx();
        let mut state = BTreeMap::from([(k, acc(0x10))]);
        let mut open = vec![Open {
            tx: 0,
            slot: 5,
            used: 100,
            others: vec![99],
            accounts: vec![(k, acc(0x10), vec![acc(0x0f)])],
            fixed: false,
            touched: false,
        }];
        let mut clocks = BTreeMap::new();
        decide(&mut clocks, &mut open, &mut state, &mut inp, 5, 98);
        assert_eq!(clocks.get(&5), Some(&98));
        assert!(!open[0].fixed && open[0].used == 100);
        assert_eq!(state.get(&k), Some(&acc(0x10)));
    }

    #[test]
    fn a_stamp_survives_only_unwritten_and_exactly_in_the_final_state() {
        let (used, other) = (acc(0x10), acc(0x0f));
        assert!(survives(acc(0x10), &used, &other, Some(&acc(0x0f))));
        // the final state shows the taken run's bytes: nothing to decide
        assert!(!survives(acc(0x10), &used, &other, Some(&acc(0x10))));
        // written again since
        assert!(!survives(acc(0x22), &used, &other, Some(&acc(0x0f))));
        // a final state neither run leaves
        assert!(!survives(acc(0x10), &used, &other, Some(&acc(0x0e))));
        // no final state, or absent
        assert!(!survives(acc(0x10), &used, &other, None));
        assert!(!survives(acc(0x10), &used, &other, Some(&None)));
    }
}
