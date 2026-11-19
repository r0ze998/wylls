//! VX — the playable lane's **expedition wrapper** and **Free City
//! conquest**, re-executed by the pinned program (Q16-1 = A, prize gate,
//! 2026-11-19; `playable-lane` build only).
//!
//! Every successful transaction of a playable-lane season (program version
//! 0x4804) with an instruction in the expedition dispatch envelope
//! `[tag, 0xff, 2, kind]` (`frontier_abi::world_index::expedition_dispatch_ix`,
//! kinds 0–18: ExpeditionDepart, SettleOrigin, ExpeditionReveal, Gather,
//! Dissolve, Return, SettleMember, SettleCamp, SettleFailure,
//! SettleForfeit, CloseTerminal, SettleRetainedFailure, and the conquest
//! kinds DeclareSiege, ResolveWithConquest, SettleCapture, SettleSiege,
//! CloseConquest, CloseCaptureEscrow, SettleReservation) is executed again
//! by the pinned `.so` ([`crate::reexec`]) from the states the archive
//! shows before it, and judged:
//!
//! * **the program refuses it** from those states (a program error code)
//!   while the archive says it succeeded: FAIL `ReExecRefused`;
//! * the program's **log lines** (records included; the runtime's compute
//!   accounting excepted) differ from the archived ones: FAIL
//!   `ReExecMismatch`;
//! * a **program-owned post-state** differs (existence, owner, data;
//!   lamports below the re-run's: only the program can debit its accounts):
//!   FAIL `ReExecMismatch`. Lamports above the re-run's are `MissingData`
//!   (a System transfer can credit any account outside the archive, as VWL
//!   and V13 rule).
//!
//! UNVERIFIABLE (`MissingData`), never a PASS: no program binary given, or
//! not the pinned one (`program_hash`); no post-states in the archive (a
//! public RPC's: D-verify-pr81-3); an account the transaction writes with no
//! post-state in the archive; logs cut by the runtime; a re-run the runtime
//! itself stops (not a program error: compute budget, rent, fees); lamports
//! above the re-run's (a credit outside the archive, e.g. a pre-funded PDA,
//! which also explains a log difference: the allocator then skips its
//! transfer); a re-run that starts from a state the archive only DECLARES
//! (`Input::declared`, a recorder's patch); and a FAIL is softened to
//! `MissingData` when the transaction reads another program's account or
//! the program's ProgramData (their states are not in this program's
//! archive). An account no archived transaction wrote is taken as absent:
//! in a history from the Season's creation every program account is
//! created by an archived transaction of the program. A successful
//! transaction whose signatures do not verify is a FAIL.
//!
//! Wallet balances: the program's receipts digest every named account's
//! lamports, and an archive shows a wallet's balance only after a
//! transaction, so each written wallet starts from its archived post-state
//! minus the program's movement (`reexec::replay_exact`): taken from the
//! archive's own claim, never proven, and no game state rests on it.
//!
//! What VX does **not** prove: the program's own rules (the pinned program
//! IS the rule here; contrast VWL's independent ports), the provenance of
//! the states it starts from (earlier transactions, judged by their own
//! checks; declared patches stay UNVERIFIABLE), and beacon data (THE
//! anchors and SeedCaches the wrapper reads are PostAnchor's and PostSeed's,
//! V3's to judge).

use fclient::ports::Account;
use solana_address::Address;

use super::Ctx;
use crate::codes::*;
use crate::input::Input;
use crate::reexec::{judged_logs, Pre, Program, Replayed, Svm};
use crate::world::{b58, Key, Tx, World};

const V: &str = "VX";

enum Wrong {
    Fail(&'static str, String),
    Missing(String),
}
use Wrong::*;

/// The dispatch kind `data` names, if it is the expedition dispatch
/// envelope (what VX re-executes).
pub fn kind_of(data: &[u8]) -> Option<String> {
    use frontier_abi::world_index::expedition_dispatch_ix as dx;
    dx::Command::decode(data)
        .ok()
        .map(|c| format!("{:?}", c.kind()))
}

/// Whether VX re-executes the transaction of this instruction.
pub fn judged(data: &[u8]) -> bool {
    kind_of(data).is_some()
}

/// The transactions VX judges: successful, with a dispatch-envelope
/// instruction of the program.
fn selected(t: &Tx) -> Option<String> {
    if !t.ok {
        return None;
    }
    let kinds: Vec<String> = t.ixs.iter().filter_map(|ix| kind_of(&ix.data)).collect();
    (!kinds.is_empty()).then(|| kinds.join("+"))
}

/// The state of `k` before transaction `tx`: the last earlier archived
/// post-state or declared state, whichever is later.
fn before(
    w: &World,
    declared: &[crate::input::Declared],
    k: &Key,
    tx: usize,
) -> Option<(Pre, Option<Account>)> {
    let posted = w.posts.get(k).and_then(|v| {
        let i = v.partition_point(|&t| t < tx);
        i.checked_sub(1).and_then(|i| v.get(i)).copied()
    });
    let decl = declared.iter().rfind(|d| d.key == *k && d.at <= tx);
    match (posted, decl) {
        // (a patch made after the last write, before this transaction)
        (Some(t), Some(d)) if d.at > t => Some((Pre::Declared, d.account.clone())),
        (Some(t), _) => Some((Pre::Archive, w.txs[t].post.get(k).cloned().flatten())),
        (None, Some(d)) => Some((Pre::Declared, d.account.clone())),
        (None, None) => None,
    }
}

fn owned(a: &Option<Account>, program: &Key) -> bool {
    a.as_ref().is_some_and(|a| a.owner.to_bytes() == *program)
}

/// Judges one re-executed transaction against the archive.
///
/// An account the archive does not show is taken as
/// absent: in a history from the Season's creation every program account
/// is created by an archived transaction of the program. Anyone can still
/// credit any address outside the archive (a System transfer, e.g. a
/// pre-funded PDA, which the program's allocator accepts), so lamports
/// above the re-run's are `MissingData`, and so is a log difference that
/// such a credit explains (the allocator then skips its transfer).
fn compare(
    w: &World,
    rec: &fclient::ports::TxRecord,
    tx: usize,
    r: &Replayed,
) -> Result<(), Wrong> {
    let t = &w.txs[tx];
    let program = w.program;
    let writable = |k: &Key| t.keys.iter().any(|(x, wr)| x == k && *wr);
    // Another program's account read from the archive: its writes are not
    // in this program's archive, so the state may be stale.
    let mut doubt: Vec<String> = vec![];
    let mut declared: Vec<String> = vec![];
    if r.names_programdata {
        doubt
            .push("the program's ProgramData (its upgrade authority is not in the archive)".into());
    }
    for (k, how, pre, _) in r.accounts.iter() {
        match how {
            Pre::Archive | Pre::Declared => {
                if let Some(a) = pre {
                    if a.owner.to_bytes() != program
                        && !a.data.is_empty()
                        && a.owner != Address::default()
                    {
                        doubt.push(format!("{} (another program's account)", b58(k)));
                    }
                }
                if *how == Pre::Declared {
                    declared.push(b58(k));
                }
            }
            _ => {}
        }
    }
    let soften = |e: Wrong| -> Wrong {
        match e {
            Fail(_, d) if !doubt.is_empty() => Missing(format!(
                "{d}; but the transaction reads {}, so the archive cannot show the re-run started from the chain's states",
                doubt.join(", ")
            )),
            e => e,
        }
    };
    if rec.logs.iter().any(|l| l.contains("Log truncated")) {
        return Err(Missing("the archived logs are cut by the runtime".into()));
    }
    if let Some(err) = &r.err {
        // The chain verifies every signature before it runs anything: an
        // archived success whose signatures do not verify is forged.
        if err.contains("SignatureFailure") {
            return Err(Fail(
                REEXEC_REFUSED,
                format!("the archived transaction's signatures do not verify ({err}), yet the archive says it succeeded"),
            ));
        }
        return Err(match fclient::ports::custom_code(err) {
            Some(code) => soften(Fail(
                REEXEC_REFUSED,
                format!(
                    "the pinned program refuses this transaction from the archive's states (code {code}: {err}), yet the archive says it succeeded"
                ),
            )),
            None => Missing(format!(
                "the re-run stopped in the runtime, not in the program ({err})"
            )),
        });
    }
    let mut credited: Vec<String> = vec![];
    let mut heads: Vec<String> = vec![];
    for (k, how, pre, after) in &r.accounts {
        if *how == Pre::Runtime || !writable(k) {
            continue;
        }
        let recorded = t.post.get(k);
        let relevant = owned(pre, &program)
            || owned(after, &program)
            || recorded.is_some_and(|a| owned(a, &program));
        if !relevant {
            continue;
        }
        let Some(recorded) = recorded else {
            if pre != after {
                return Err(Missing(format!(
                    "the program writes {}, and the archive has no post-state of it",
                    b58(k)
                )));
            }
            continue;
        };
        let what = |d: String| soften(Fail(REEXEC_MISMATCH, format!("account {}: {d}", b58(k))));
        match (after, recorded) {
            (None, None) => {}
            (Some(_), None) => {
                return Err(what(
                    "the re-run leaves it, the archive says it is closed".into(),
                ))
            }
            (None, Some(_)) => {
                return Err(what(
                    "the re-run closes it, the archive says it remains".into(),
                ))
            }
            (Some(x), Some(y)) => {
                if x.owner != y.owner {
                    return Err(what(format!(
                        "owner {} in the re-run, {} in the archive",
                        x.owner, y.owner
                    )));
                }
                if x.data != y.data {
                    // Only the chain header (`EVENT_SEQ`, `EVENT_HEAD`): the
                    // records differ, judged with the logs below.
                    use frontier_abi::layout::header as HDR;
                    let header = HDR::EVENT_SEQ..HDR::EVENT_HEAD + 32;
                    if x.data.len() == y.data.len()
                        && x.data
                            .iter()
                            .zip(y.data.iter())
                            .enumerate()
                            .all(|(i, (a, b))| a == b || header.contains(&i))
                    {
                        heads.push(b58(k));
                        continue;
                    }
                    let at = x
                        .data
                        .iter()
                        .zip(y.data.iter())
                        .position(|(a, b)| a != b)
                        .unwrap_or(x.data.len().min(y.data.len()));
                    return Err(what(format!(
                        "data differs (lengths {} / {}, first at byte {at})",
                        x.data.len(),
                        y.data.len()
                    )));
                }
                if y.lamports < x.lamports {
                    return Err(what(format!(
                        "{} lamports fewer than the re-run leaves (only the program can debit its account)",
                        x.lamports - y.lamports
                    )));
                }
                if y.lamports > x.lamports {
                    credited.push(format!("{} (+{})", b58(k), y.lamports - x.lamports));
                }
            }
        }
    }
    let got = judged_logs(&r.logs);
    let want = judged_logs(&rec.logs);
    if got != want || !heads.is_empty() {
        let at = got
            .iter()
            .zip(want.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        let d = if got != want {
            format!(
                "the program's log lines differ from the archive's at line {at}: re-run {:?}, archive {:?}",
                got.get(at),
                want.get(at)
            )
        } else {
            format!(
                "the event chain heads of {} differ from the re-run's",
                heads.join(", ")
            )
        };
        // The program's receipts digest the lamports of every account the
        // transaction names (`expedition_event::digest`), read-only ones
        // included, and a System transfer can credit any of them outside
        // this program's archive. With game state equal, a difference only
        // in the records (and the chain heads over them) may be that: not
        // a FAIL a third party could cause (D-verifier-wide-freecity-4:
        // the archive needs each transaction's pre-balances to decide).
        // Records that differ while every chain head over them is the
        // re-run's are not that: the archive's records are not the ones
        // its own post-states chain (FAIL).
        let unseen: Vec<String> = r
            .accounts
            .iter()
            .enumerate()
            .filter(|(i, (_, how, _, _))| {
                *how != Pre::Runtime
                    && !fclient::tx::from_wire(&rec.tx)
                        .is_ok_and(|m| fclient::tx::is_writable_index(&m.message, *i))
            })
            .map(|(_, (k, _, _, _))| b58(k))
            .collect();
        return Err(if !credited.is_empty() {
            Missing(format!(
                "{d}; the archive's accounts {} hold more lamports than the re-run leaves: a credit outside the archive (e.g. a pre-funded address) explains a different allocation path",
                credited.join(", ")
            ))
        } else if !unseen.is_empty() && !heads.is_empty() {
            Missing(format!(
                "{d}, with every program-owned post-state's game bytes equal: the receipts digest the balances of the read-only accounts it names ({}), which this archive does not show before it",
                unseen.join(", ")
            ))
        } else {
            soften(Fail(REEXEC_MISMATCH, d))
        });
    }
    if !credited.is_empty() {
        return Err(Missing(format!(
            "accounts {} hold more lamports than the re-run leaves: a System transfer may have reached them outside the archive",
            credited.join(", ")
        )));
    }
    if !declared.is_empty() {
        return Err(Missing(format!(
            "re-executed exactly, but from states the archive only declares (a recorder's patch, not an archived transaction's write): {}",
            declared.join(", ")
        )));
    }
    Ok(())
}

/// Every transaction `pick` selects, re-executed and judged (findings in
/// order).
#[allow(clippy::too_many_arguments)]
fn judge_all(
    w: &World,
    recs: &[fclient::ports::TxRecord],
    declared: &[crate::input::Declared],
    program: &Address,
    program_hash: Option<[u8; 32]>,
    so: Option<&Program>,
    pick: impl Fn(&Tx) -> Option<String>,
) -> Vec<(usize, String, Wrong)> {
    let picked: Vec<(usize, String)> = w
        .txs
        .iter()
        .enumerate()
        .filter_map(|(i, t)| pick(t).map(|n| (i, n)))
        .collect();
    if picked.is_empty() {
        return vec![];
    }
    let all = |why: String| -> Vec<(usize, String, Wrong)> {
        picked
            .iter()
            .map(|(i, n)| (*i, n.clone(), Missing(why.clone())))
            .collect()
    };
    let Some(so) = so else {
        return all(
            "no program binary was given (`--program-so`): the transaction is not re-executed"
                .into(),
        );
    };
    if program_hash != Some(so.sha256()) {
        return all(format!(
            "the program binary given (sha256 {}) is not the pinned one ({})",
            hex::encode(so.sha256()),
            program_hash
                .map(hex::encode)
                .unwrap_or_else(|| "none pinned".into())
        ));
    }
    if !w.has_post {
        return all(
            "the archive has no post-states (a public RPC's): nothing to re-execute from".into(),
        );
    }
    let mut svm = match Svm::new(so, program) {
        Ok(s) => s,
        Err(e) => return all(format!("the program binary does not load: {e}")),
    };
    let mut out = vec![];
    for (i, name) in picked {
        let t = &w.txs[i];
        let Some(rec) = recs.get(i) else {
            out.push((
                i,
                name,
                Missing("the transaction's record is not in the archive".into()),
            ));
            continue;
        };
        let r = crate::reexec::replay_exact(
            &mut svm,
            &rec.tx,
            t.slot,
            t.time,
            |k| before(w, declared, k, i),
            |k| t.post.get(k).cloned(),
            &w.program,
        );
        match r {
            Err(e) => out.push((
                i,
                name,
                Missing(format!("the transaction does not re-execute: {e}")),
            )),
            Ok(r) => {
                if let Err(e) = compare(w, rec, i, &r) {
                    out.push((i, name, e));
                }
            }
        }
    }
    out
}

fn program_of(input: &Input) -> Option<Program> {
    input
        .program_so
        .as_ref()
        .map(|so| Program::new(so.as_ref().clone()))
}

pub fn run(cx: &mut Ctx) {
    let pv = cx.f.params.as_ref().map(|p| p.program_version);
    if !super::v0_coverage::playable(pv) {
        return;
    }
    let so = program_of(cx.input);
    let found = judge_all(
        cx.w,
        &cx.input.txs,
        &cx.input.declared,
        &cx.cfg.program,
        cx.cfg.program_hash,
        so.as_ref(),
        selected,
    );
    for (i, name, er) in found {
        match er {
            Fail(code, d) => cx.fail(
                V,
                code,
                format!("tx#{i}"),
                0,
                Some(i),
                format!("{name}: {d}"),
            ),
            Missing(d) => cx.missing(V, format!("tx#{i}"), 0, Some(i), format!("{name}: {d}")),
        }
    }
}

/// Diagnostics (tests, evidence): transaction `i` re-executed as VX would,
/// without a judgement.
pub fn replay_one(input: &Input, i: usize) -> Result<Replayed, String> {
    let w = World::parse(
        &input.cfg.program,
        &input.txs,
        input.finals.clone(),
        input.final_slot,
    );
    let so = program_of(input).ok_or("no program binary")?;
    let mut svm = Svm::new(&so, &input.cfg.program)?;
    let t = w.txs.get(i).ok_or("no such transaction")?;
    crate::reexec::replay_exact(
        &mut svm,
        &input.txs[i].tx,
        t.slot,
        t.time,
        |k| before(&w, &input.declared, k, i),
        |k| t.post.get(k).cloned(),
        &w.program,
    )
}
