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

/// Re-executes the archive from the Season's creation (see the module doc).
pub fn derive(input: &Input) -> Derived {
    let mut out = Derived {
        input: None,
        findings: vec![],
        ran: false,
    };
    if !applies(input) {
        return out;
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
        return out;
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
        return out;
    }
    let hashes: BTreeSet<[u8; 32]> = input.program_hashes.iter().map(|(_, h)| *h).collect();
    if hashes.len() > 1 {
        missing(&mut out, format!("the program was upgraded inside the archive ({} binaries): one pinned binary cannot re-execute it", hashes.len()));
        return out;
    }
    let mut svm = match Svm::with_authority(&so, &input.cfg.program, input.chain.upgrade_authority)
    {
        Ok(s) => s,
        Err(e) => {
            missing(&mut out, format!("the program binary does not load: {e}"));
            return out;
        }
    };
    out.ran = true;
    // The re-executions' states (data, owner; lamports as the chain's
    // postBalances left them), and the accounts whose state is unknown.
    let mut state: BTreeMap<Key, Option<Account>> = BTreeMap::new();
    let mut declared_at: BTreeSet<Key> = BTreeSet::new();
    let mut unknown: BTreeSet<Key> = BTreeSet::new();
    let mut derived = input.clone();
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
        let r = match replay_known(
            &mut svm,
            &parsed,
            rec.slot,
            rec.block_time,
            pre,
            |_| None,
            &program,
            Some((&bal.pre, &bal.post, rec.fee)),
        ) {
            Ok(r) => r,
            Err(e) => {
                push(
                    &mut out,
                    Judged::Missing(format!("the transaction does not re-execute: {e}")),
                );
                if ok {
                    mark_unknown(&mut unknown);
                }
                continue;
            }
        };
        let soften = |j: Judged| -> Judged {
            match j {
                Judged::Fail(_, d) if !doubt.is_empty() => Judged::Missing(format!(
                    "{d}; but {}, so the re-run cannot be shown to start from the chain's states",
                    doubt.join("; ")
                )),
                j => j,
            }
        };
        if !ok {
            // A failed transaction changes nothing but balances. When the
            // chain names a program error, the program must fail with it.
            let judged = match (rec.code, &r.err) {
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
            // (a debit outside the program is one before a failure too)
            let judged = match (early.take(), judged) {
                (Some(e @ Judged::Fail(..)), _) => e,
                (_, j) => j,
            };
            push(&mut out, soften(judged));
            continue;
        }
        let mut judged = early.take().unwrap_or(Judged::Ok);
        if matches!(judged, Judged::Ok) {
            if let Some(err) = &r.err {
                judged = if err.contains("SignatureFailure") {
                    Judged::Fail(REEXEC_REFUSED, format!("the archived transaction's signatures do not verify ({err}), yet the archive says it succeeded"))
                } else {
                    match fclient::ports::custom_code(err) {
                        Some(code) => Judged::Fail(REEXEC_REFUSED, format!("the pinned program refuses this transaction from the states its history leaves (code {code}: {err}), yet the archive says it succeeded")),
                        None => Judged::Missing(format!("the re-run stopped in the runtime, not in the program ({err})")),
                    }
                };
            }
        }
        if matches!(judged, Judged::Ok) {
            if rec.logs.iter().any(|l| l.contains("Log truncated")) {
                judged = Judged::Missing("the archived logs are cut by the runtime".into());
            } else {
                let got = judged_logs(&r.logs);
                let want = judged_logs(&rec.logs);
                if got != want {
                    let at = got
                        .iter()
                        .zip(want.iter())
                        .position(|(a, b)| a != b)
                        .unwrap_or(got.len().min(want.len()));
                    judged = Judged::Fail(REEXEC_MISMATCH, format!("the program's log lines differ from the archive's at line {at}: re-run {:?}, archive {:?}", got.get(at), want.get(at)));
                }
            }
        }
        if matches!(judged, Judged::Ok) {
            for (j, (k, how, before, after)) in r.accounts.iter().enumerate() {
                if *how == Pre::Runtime || !writable[j] {
                    continue;
                }
                let l = after.as_ref().map_or(0, |a| a.lamports);
                if l == bal.post[j] {
                    continue;
                }
                if owned(before, &program) || owned(after, &program) {
                    judged = Judged::Fail(REEXEC_MISMATCH, format!("account {}: the chain shows {} lamports after it, the pinned program leaves {l}", b58(k), bal.post[j]));
                    break;
                }
                if is_wallet(before, &program) && is_wallet(after, &program) {
                    judged = Judged::Missing(format!("wallet {}: the chain shows {} lamports after it, the re-run leaves {l} (a movement this program's archive cannot explain)", b58(k), bal.post[j]));
                    break;
                }
                judged = Judged::Missing(format!(
                    "account {} (another program's): the chain shows {} lamports after it, the re-run {l}",
                    b58(k),
                    bal.post[j]
                ));
                break;
            }
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
    out
}
