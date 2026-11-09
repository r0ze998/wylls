//! VW1 — the wide world's event chains (workstream 04, 2026-11-08; the
//! owner's approved infinite-map work, technical rules only).
//!
//! Experimental and opt-in (`--features wide-world-experimental`): the wide
//! records (`PSW1`, `frontier_abi::world_index::event`) of the experimental
//! program build. No wide **rule** is judged here (the six undecided wide
//! rules stay undecided); only what the deployed design already fixes for
//! every chained account, applied to the wide accounts:
//!
//! - every `PSW1` body inside the game program's frame decodes (else FAIL
//!   [`WIDE_RECORD_UNDECODABLE`]: the program wrote it);
//! - for every province and holding a record concerns, each record's link
//!   is exactly `advance(previous link, body without tail)` (else FAIL
//!   [`WIDE_CHAIN_BROKEN`]); a chain whose first observed link is `seq 1`
//!   must start from `(0, 0³²)`; a jump in the sequence (records missing
//!   from the input) is FAIL only when the history is whole, else
//!   UNVERIFIABLE [`WIDE_CHAIN_UNPROVEN`] (⑯'s finding: a gap in an unproven
//!   history is not a contradiction);
//! - the last link equals the account's final header (`event_seq`,
//!   `event_head`): a difference is FAIL [`WIDE_CHAIN_FINAL_MISMATCH`] when
//!   the history is whole, else UNVERIFIABLE; an account the input does not
//!   carry is UNVERIFIABLE.
//!
//! And always, while any wide record exists: UNVERIFIABLE
//! [`WIDE_UNMODELLED`] — the wide instructions themselves are not replayed
//! yet, so a wide season is never PASS (V0 says the same per instruction).
//! Pure bytes; no key, no signature, no network.

use std::collections::BTreeMap;

use base64::Engine;
use frontier_abi::layout::header;
use frontier_abi::world_index::event::{
    advance, WideEntity, WideLink, WideRecord, WideTarget, WIDE_LOG_PREFIX,
};
use frontier_abi::world_index::holding::WideHolding;
use frontier_abi::world_index::key::{ProvinceKey, WideHostRef};
use frontier_abi::world_index::land::WideProvince;

use super::Ctx;

pub const V: &str = "VW1";

pub const WIDE_RECORD_UNDECODABLE: &str = "WideRecordUndecodable";
pub const WIDE_CHAIN_BROKEN: &str = "WideChainBroken";
pub const WIDE_CHAIN_FINAL_MISMATCH: &str = "WideChainFinalMismatch";
pub const WIDE_CHAIN_UNPROVEN: &str = "WideChainUnproven";
pub use crate::codes::WIDE_UNMODELLED;

/// What VW1 found, before it becomes findings (testable without a `Ctx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Judgement {
    Fail {
        code: &'static str,
        tx: Option<usize>,
        entity: String,
        detail: String,
    },
    Unverifiable {
        code: &'static str,
        tx: Option<usize>,
        entity: String,
        detail: String,
    },
}

/// The committed `PSW1` bodies of the game program's own frames. A failed
/// CPI discards its entire subtree, including successful grandchildren.
/// Decode only after rollback filtering: malformed rolled-back data is no
/// committed record. Foreign and unframed data remain outside this check.
/// Invocation depth, matching exits and complete logs are required when a
/// retained target-frame PSW1 tag identifies relevant wide data. Other
/// transactions cannot acquire a wide finding from their frame shape alone.
pub fn psw1_bodies(logs: &[String], program: &str) -> Result<Vec<Vec<u8>>, &'static str> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut stack: Vec<(&str, usize)> = vec![];
    let mut pending = vec![];
    let mut frame_error = None;
    for l in logs {
        if l.contains("Log truncated") {
            frame_error.get_or_insert("truncated logs");
        }
        if let Some(rest) = l.strip_prefix("Program data:") {
            if stack.last().is_some_and(|(who, _)| *who == program) {
                pending.push(rest);
            }
            continue;
        }
        let Some(rest) = l.strip_prefix("Program ") else {
            continue;
        };
        let Some((who, tail)) = rest.split_once(' ') else {
            continue;
        };
        if let Some(depth) = tail.strip_prefix("invoke [") {
            let depth = depth
                .strip_suffix(']')
                .and_then(|s| s.parse::<usize>().ok());
            if depth != Some(stack.len() + 1) {
                frame_error.get_or_insert("invocation depth");
            }
            // Retain claimed attribution only to decide whether a frame
            // error concerns wide data. It cannot pass validation below.
            stack.push((who, pending.len()));
        } else if tail == "success" || tail.starts_with("failed:") {
            let Some((active, start)) = stack.pop() else {
                frame_error.get_or_insert("unmatched exit");
                continue;
            };
            if active != who {
                frame_error.get_or_insert("mismatched exit");
                continue;
            }
            if tail.starts_with("failed:") {
                if stack.is_empty() {
                    // `judge` has already excluded failed transactions.
                    frame_error.get_or_insert("failed top-level frame in successful transaction");
                } else {
                    pending.truncate(start);
                }
            }
        } else if tail.starts_with("invoke")
            || tail.starts_with("success")
            || tail.starts_with("failed")
        {
            frame_error.get_or_insert("malformed frame");
            if tail.starts_with("invoke") {
                stack.push((who, pending.len()));
            }
        }
    }
    if !stack.is_empty() {
        frame_error.get_or_insert("unfinished frame");
    }
    // This check runs on every transaction, including legacy-only ones.
    // An unknown/malformed tag cannot by itself establish a wide record;
    // ordinary log/coverage checks own that input. Failed subtrees have
    // already been removed, so their PSW1 tags do not widen the scope.
    let has_wide = pending.iter().any(|raw| {
        raw.split_whitespace()
            .next()
            .and_then(|tag| b64.decode(tag).ok())
            .is_some_and(|tag| tag.as_slice() == &WIDE_LOG_PREFIX[..])
    });
    if !has_wide {
        return Ok(vec![]);
    }
    if let Some(why) = frame_error {
        return Err(why);
    }
    let mut out = vec![];
    for raw in pending {
        let mut parts = raw.split_whitespace();
        let tag = b64
            .decode(parts.next().ok_or("missing tag")?)
            .map_err(|_| "base64 tag")?;
        if tag.as_slice() != &WIDE_LOG_PREFIX[..] {
            continue;
        }
        let body = parts.next().ok_or("missing PSW1 body")?;
        if parts.next().is_some() {
            return Err("extra PSW1 data");
        }
        out.push(b64.decode(body).map_err(|_| "base64 body")?);
    }
    Ok(out)
}

/// Display labels are not keys: coordinates repeat in every world.
/// Include the entity tag and the complete canonical identity bytes.
fn target_key(t: &WideTarget) -> (u8, Vec<u8>) {
    let bytes = match t {
        WideTarget::Province(k) => k.to_bytes().to_vec(),
        WideTarget::Holding(h) => h.to_bytes().to_vec(),
    };
    (t.entity() as u8, bytes)
}

fn target_name(t: &WideTarget) -> String {
    match t {
        WideTarget::Province(k) => format!(
            "wide province {:?} world {}",
            k.coord(),
            hex::encode(k.world().as_bytes())
        ),
        WideTarget::Holding(h) => format!(
            "wide holding {:?} site {} gen {} world {}",
            h.key().coord(),
            h.site(),
            h.gen(),
            hex::encode(h.key().world().as_bytes())
        ),
    }
}

/// One step of a target's chain: the record's link and the body it
/// chains over, in feed order.
#[derive(Clone, Debug)]
pub struct Step<'a> {
    pub tx: usize,
    pub link: WideLink,
    pub body_without_tail: &'a [u8],
}

/// What one target's walk saw.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Walked {
    /// The last link observed.
    pub last: Option<WideLink>,
    /// Sequence jumps between observed records: `(tx, from seq, to seq)`.
    /// Records missing from the input (an honest gap unless the history is
    /// whole), re-anchored at the later link; not a contradiction by itself.
    pub gaps: Vec<(usize, u64, u64)>,
}

/// Walks one target's steps: every link at the next sequence number is
/// `advance` of the one before (else a contradiction, `Err`: no missing
/// record makes a wrong head at a consecutive number); a link further on is
/// a gap ([`Walked::gaps`]), re-anchored there; a first link at `seq 1` must
/// come from `(0, 0³²)`.
pub fn walk(entity: WideEntity, steps: &[Step<'_>]) -> Result<Walked, (usize, String)> {
    let mut w = Walked::default();
    for s in steps {
        let from = match w.last {
            Some(p) if s.link.seq > p.seq.saturating_add(1) => {
                w.gaps.push((s.tx, p.seq, s.link.seq));
                None
            }
            Some(p) => Some((p.seq, p.head)),
            None if s.link.seq == 1 => Some((0, [0u8; 32])),
            None => None,
        };
        if let Some((seq, head)) = from {
            let want = advance(entity, seq, &head, s.body_without_tail);
            if want != Some(s.link) {
                return Err((
                    s.tx,
                    format!(
                        "the link at seq {} is not the chain's next after seq {seq}",
                        s.link.seq
                    ),
                ));
            }
        }
        w.last = Some(s.link);
    }
    Ok(w)
}

/// The chain a wide account's bytes end at, with the target it is.
fn account_chain(d: &[u8]) -> Option<(WideTarget, (u64, [u8; 32]))> {
    let seq = u64::from_le_bytes(
        d.get(header::EVENT_SEQ..header::EVENT_SEQ + 8)?
            .try_into()
            .ok()?,
    );
    let head: [u8; 32] = d
        .get(header::EVENT_HEAD..header::EVENT_HEAD + 32)?
        .try_into()
        .ok()?;
    if let Ok(p) = WideProvince::read(d) {
        return Some((
            WideTarget::Province(ProvinceKey::new(p.world, p.coord)),
            (seq, head),
        ));
    }
    if let Ok(h) = WideHolding::read(d) {
        let r = WideHostRef::new(ProvinceKey::new(h.world, h.coord), h.site, h.gen, 0).ok()?;
        return Some((WideTarget::Holding(r), (seq, head)));
    }
    None
}

/// The whole judgement over `(tx index, ok, logs)` and the final accounts'
/// bytes; `whole` when the history is shown complete.
pub fn judge(
    program: &str,
    txs: &[(usize, bool, &[String])],
    finals: &[&[u8]],
    whole: bool,
) -> Vec<Judgement> {
    let mut out = vec![];
    let mut bodies: Vec<(usize, Vec<u8>)> = vec![];
    for (i, ok, logs) in txs {
        if !ok {
            continue;
        }
        match psw1_bodies(logs, program) {
            Ok(bs) => bodies.extend(bs.into_iter().map(|b| (*i, b))),
            Err(why) => out.push(Judgement::Fail {
                code: WIDE_RECORD_UNDECODABLE,
                tx: Some(*i),
                entity: "transaction".into(),
                detail: format!("a PSW1 line does not decode ({why})"),
            }),
        }
    }
    let mut records = vec![];
    for (i, b) in &bodies {
        match WideRecord::decode(b) {
            Ok(r) => records.push((*i, r)),
            Err(e) => out.push(Judgement::Fail {
                code: WIDE_RECORD_UNDECODABLE,
                tx: Some(*i),
                entity: "transaction".into(),
                detail: format!("a PSW1 body the program wrote does not decode ({e:?})"),
            }),
        }
    }
    if records.is_empty() && out.is_empty() {
        return out;
    }
    // Targets in first-seen order, each with its steps.
    let mut order: Vec<WideTarget> = vec![];
    let mut steps: BTreeMap<usize, Vec<Step<'_>>> = BTreeMap::new();
    for (i, r) in &records {
        let mut ts = vec![];
        if let Some(k) = r.province_of() {
            ts.push(WideTarget::Province(k));
        }
        if let Some(h) = r.holding_of() {
            ts.push(WideTarget::Holding(h));
        }
        for t in ts {
            if !r.concerns(t) || !r.kind.links().contains(&t.entity()) {
                continue;
            }
            let Some(link) = r.link(t.entity()) else {
                out.push(Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    tx: Some(*i),
                    entity: target_name(&t),
                    detail: "a record of this account carries no link for it".into(),
                });
                continue;
            };
            let at = order.iter().position(|o| *o == t).unwrap_or_else(|| {
                order.push(t);
                order.len() - 1
            });
            steps.entry(at).or_default().push(Step {
                tx: *i,
                link,
                body_without_tail: r.body_without_tail,
            });
        }
    }
    let ends: BTreeMap<_, (u64, [u8; 32])> = finals
        .iter()
        .filter_map(|d| account_chain(d))
        .map(|(t, c)| (target_key(&t), c))
        .collect();
    for (at, t) in order.iter().enumerate() {
        let name = target_name(t);
        let s = steps.get(&at).map(Vec::as_slice).unwrap_or(&[]);
        let walked = match walk(t.entity(), s) {
            Err((tx, why)) => {
                out.push(Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    tx: Some(tx),
                    entity: name,
                    detail: why,
                });
                continue;
            }
            Ok(w) => w,
        };
        for &(tx, from, to) in &walked.gaps {
            let detail =
                format!("the records between seq {from} and seq {to} are not in the input");
            if whole {
                out.push(Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    tx: Some(tx),
                    entity: name.clone(),
                    detail: format!("{detail}, though the history is shown whole"),
                });
            } else {
                out.push(Judgement::Unverifiable {
                    code: WIDE_CHAIN_UNPROVEN,
                    tx: Some(tx),
                    entity: name.clone(),
                    detail: format!("{detail}; the history is not shown whole"),
                });
            }
        }
        match walked.last {
            None => {}
            Some(last) => match ends.get(&target_key(t)) {
                None => out.push(Judgement::Unverifiable {
                    code: WIDE_CHAIN_UNPROVEN,
                    tx: None,
                    entity: name,
                    detail: "the account's final bytes are not in the input (closed, or not read)".into(),
                }),
                Some(&(seq, head)) if (seq, head) == (last.seq, last.head) => {}
                Some(&(seq, _)) if whole => out.push(Judgement::Fail {
                    code: WIDE_CHAIN_FINAL_MISMATCH,
                    tx: None,
                    entity: name,
                    detail: format!("the account ends at seq {seq}; its records end at seq {}", last.seq),
                }),
                Some(&(seq, _)) => out.push(Judgement::Unverifiable {
                    code: WIDE_CHAIN_UNPROVEN,
                    tx: None,
                    entity: name,
                    detail: format!(
                        "the account ends at seq {seq}, its observed records at seq {}; the history is not shown whole",
                        last.seq
                    ),
                }),
            },
        }
    }
    out.push(Judgement::Unverifiable {
        code: WIDE_UNMODELLED,
        tx: None,
        entity: "season".into(),
        detail: format!(
            "{} wide record(s): the wide instructions are not replayed yet (chains checked only); a wide season is never PASS",
            records.len()
        ),
    });
    out
}

pub fn run(cx: &mut Ctx) {
    let program = cx.cfg.program.to_string();
    let txs: Vec<(usize, bool, &[String])> = cx
        .input
        .txs
        .iter()
        .enumerate()
        .map(|(i, t)| (i, t.err.is_none(), t.logs.as_slice()))
        .collect();
    let finals: Vec<&[u8]> = cx
        .input
        .finals
        .values()
        .filter_map(|a| {
            a.as_ref()
                .filter(|a| a.owner == cx.cfg.program)
                .map(|a| a.data.as_slice())
        })
        .collect();
    let whole = !cx.input.history.unproven();
    for j in judge(&program, &txs, &finals, whole) {
        match j {
            Judgement::Fail {
                code,
                tx,
                entity,
                detail,
            } => cx.fail(V, code, entity, 0, tx, detail),
            Judgement::Unverifiable {
                code,
                tx,
                entity,
                detail,
            } => cx.unverifiable(V, code, entity, 0, tx, detail),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn psw1_line(body: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::STANDARD;
        format!(
            "Program data: {} {}",
            b64.encode(WIDE_LOG_PREFIX),
            b64.encode(body)
        )
    }

    fn steps_of(
        entity: WideEntity,
        bodies: &[&'static [u8]],
        from: (u64, [u8; 32]),
    ) -> Vec<Step<'static>> {
        let (mut seq, mut head) = from;
        bodies
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let l = advance(entity, seq, &head, b).unwrap();
                (seq, head) = (l.seq, l.head);
                Step {
                    tx: i,
                    link: l,
                    body_without_tail: b,
                }
            })
            .collect()
    }

    #[test]
    fn a_chain_from_genesis_walks_to_its_last_link() {
        let s = steps_of(WideEntity::Province, &[b"a", b"b", b"c"], (0, [0; 32]));
        assert_eq!(walk(WideEntity::Province, &s).unwrap().last.unwrap().seq, 3);
    }

    #[test]
    fn a_broken_or_reordered_link_fails_at_its_transaction() {
        let mut s = steps_of(WideEntity::Holding, &[b"a", b"b", b"c"], (0, [0; 32]));
        s[1].body_without_tail = b"B";
        assert_eq!(walk(WideEntity::Holding, &s).unwrap_err().0, 1);
        let mut s = steps_of(WideEntity::Holding, &[b"a", b"b", b"c"], (0, [0; 32]));
        s.swap(1, 2);
        assert!(walk(WideEntity::Holding, &s).is_err());
        // Another entity's chain over the same bodies is not this one's.
        let s = steps_of(WideEntity::Province, &[b"a"], (0, [0; 32]));
        assert!(walk(WideEntity::Holding, &s).is_err());
    }

    #[test]
    fn a_first_link_at_seq_one_must_start_from_genesis() {
        let s = steps_of(WideEntity::Province, &[b"a"], (0, [7; 32]));
        assert!(walk(WideEntity::Province, &s).is_err());
    }

    #[test]
    fn a_chain_observed_from_its_middle_is_taken_from_its_first_link() {
        let s = steps_of(WideEntity::Province, &[b"x", b"y"], (41, [9; 32]));
        assert_eq!(
            walk(WideEntity::Province, &s).unwrap().last.unwrap().seq,
            43
        );
    }

    #[test]
    fn psw1_lines_count_only_inside_the_program_frame() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let line = format!(
            "Program data: {} {}",
            b64.encode(WIDE_LOG_PREFIX),
            b64.encode(b"body")
        );
        let logs = vec![
            line.clone(),
            "Program P invoke [1]".into(),
            line.clone(),
            "Program Q invoke [2]".into(),
            line.clone(),
            "Program Q success".into(),
            "Program P success".into(),
        ];
        assert_eq!(psw1_bodies(&logs, "P").unwrap(), vec![b"body".to_vec()]);
    }

    #[test]
    fn failed_cpi_subtrees_are_discarded_before_decoding() {
        let logs = vec![
            "Program P invoke [1]".into(),
            psw1_line(b"before"),
            "Program Q invoke [2]".into(),
            "Program P invoke [3]".into(),
            // Even a successful grandchild rolls back when Q fails. Its
            // malformed bytes must not prevent the committed data decoding.
            "Program data: !!! !!!".into(),
            "Program P success".into(),
            "Program Q failed: custom program error: 0x1".into(),
            "Program P invoke [2]".into(),
            psw1_line(b"rolled back"),
            "Program P failed: custom program error: 0x2".into(),
            psw1_line(b"after"),
            "Program P success".into(),
        ];
        assert_eq!(
            psw1_bodies(&logs, "P").unwrap(),
            vec![b"before".to_vec(), b"after".to_vec()]
        );
    }

    #[test]
    fn rolled_back_wide_links_never_enter_the_chain_judgement() {
        let committed = resolve_logs_of(&[20], false, None);
        let line = committed[1].clone();
        let logs = vec![
            "Program P invoke [1]".into(),
            "Program Q invoke [2]".into(),
            "Program P invoke [3]".into(),
            line.clone(),
            "Program P success".into(),
            "Program Q failed: custom program error: 0x1".into(),
            line,
            "Program P success".into(),
        ];
        // Keeping the grandchild's rolled-back seq 1 would produce two
        // seq-1 links and a false WideChainBroken finding.
        assert_eq!(
            judge("P", &[(0, true, &logs)], &[], true),
            judge("P", &[(0, true, &committed)], &[], true)
        );
        let rolled_back_only = &logs[..logs.len() - 2];
        let mut logs = rolled_back_only.to_vec();
        logs.push("Program P success".into());
        assert!(judge("P", &[(0, true, &logs)], &[], true).is_empty());
    }

    #[test]
    fn committed_wide_data_requires_complete_matching_frames() {
        let line = psw1_line(b"body");
        let cases = [
            vec!["Program P invoke [1]".into(), line.clone()],
            vec![
                "Program P invoke [1]".into(),
                line.clone(),
                "Program Q success".into(),
            ],
            vec![
                "Program P invoke [2]".into(),
                line.clone(),
                "Program P success".into(),
            ],
            vec![
                "Program P invoke [1]".into(),
                line.clone(),
                "Program P success extra".into(),
            ],
            vec![
                "Program P invoke [1]".into(),
                line.clone(),
                "Program P failed: custom program error: 0x1".into(),
            ],
            vec![
                "Program P invoke [1]".into(),
                line,
                "Log truncated".into(),
                "Program P success".into(),
            ],
            vec![
                "Program P invoke [1]".into(),
                psw1_line(b"body"),
                "Program P success".into(),
                "Program P success".into(),
            ],
        ];
        for logs in cases {
            assert!(psw1_bodies(&logs, "P").is_err(), "{logs:?}");
            assert!(judge("P", &[(0, true, &logs)], &[], true)
                .iter()
                .any(|j| matches!(
                    j,
                    Judgement::Fail {
                        code: WIDE_RECORD_UNDECODABLE,
                        ..
                    }
                )));
            // A transaction known to have failed never contributes effects,
            // even when its retained logs are incomplete or malformed.
            assert!(judge("P", &[(0, false, &logs)], &[], true).is_empty());
        }
    }

    #[test]
    fn malformed_committed_psw1_data_is_not_silently_skipped() {
        for line in [
            "Program data: UFNXMQ==".to_string(),
            "Program data: UFNXMQ== !!!".to_string(),
            format!("{} extra", psw1_line(b"body")),
            "Program data: !!! !!!".to_string(),
        ] {
            let logs = vec![
                "Program P invoke [1]".into(),
                psw1_line(b"known wide scope"),
                line,
                "Program P success".into(),
            ];
            assert!(psw1_bodies(&logs, "P").is_err(), "{logs:?}");
        }
    }

    #[test]
    fn nonwide_or_rolled_back_data_cannot_create_wide_findings_from_frame_errors() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let ps2 = format!(
            "Program data: {} {}",
            b64.encode(b"PS2"),
            b64.encode(b"legacy")
        );
        let cases = [
            // Empty, foreign, unframed and legacy-only logs remain outside
            // VW1, even when other checks may find their framing invalid.
            vec!["Program P success".into()],
            vec!["Program Q invoke [1]".into(), psw1_line(b"foreign")],
            vec![psw1_line(b"unframed"), "Log truncated".into()],
            vec!["Program P invoke [1]".into(), ps2],
            vec![
                "Program P invoke [1]".into(),
                "Program data: !!! !!!".into(),
            ],
            // Only the failed subtree was wide. A truncated outer frame
            // cannot turn that rolled-back observation into a wide season.
            vec![
                "Program Q invoke [1]".into(),
                "Program P invoke [2]".into(),
                psw1_line(b"rolled back"),
                "Program P failed: custom program error: 0x1".into(),
                "Log truncated".into(),
            ],
        ];
        for logs in cases {
            assert_eq!(psw1_bodies(&logs, "P"), Ok(vec![]), "{logs:?}");
            assert!(
                judge("P", &[(0, true, &logs)], &[], true).is_empty(),
                "{logs:?}"
            );
        }
    }

    #[test]
    fn final_chains_are_matched_by_the_full_world_scoped_identity() {
        use frontier_abi::world_index::holding::wide_holding;
        use frontier_abi::world_index::land::province;

        // Existing immutable real host-dispatch outputs, not regenerated.
        // They carry simulated signer flags and establish no provenance.
        let record = include_bytes!("../../tests/fixtures/wide_economy/wall/record.bin");
        let holding = include_bytes!("../../tests/fixtures/wide_economy/wall/holding_post.bin");
        let province = include_bytes!("../../tests/fixtures/wide_economy/wall/province_post.bin");
        let logs = vec![
            "Program P invoke [1]".into(),
            psw1_line(record),
            "Program P success".into(),
        ];
        let mut other_holding = holding.to_vec();
        let mut other_province = province.to_vec();
        // Same coordinates/site/generation and even the same world prefix;
        // only its last byte differs. Preserve every chain byte initially.
        other_holding[wide_holding::WORLD + 31] ^= 1;
        other_province[province::WORLD + 31] ^= 1;
        assert!(WideHolding::read(&other_holding).is_ok());
        assert!(WideProvince::read(&other_province).is_ok());
        let canonical = [holding.as_slice(), province.as_slice()];
        let j = judge("P", &[(0, true, &logs)], &canonical, true);
        assert!(
            matches!(
                j.as_slice(),
                [Judgement::Unverifiable {
                    code: WIDE_UNMODELLED,
                    ..
                }]
            ),
            "{j:?}"
        );
        let foreign = [other_holding.as_slice(), other_province.as_slice()];
        let j = judge("P", &[(0, true, &logs)], &foreign, true);
        assert_eq!(
            j.iter()
                .filter(|j| matches!(
                    j,
                    Judgement::Unverifiable {
                        code: WIDE_CHAIN_UNPROVEN,
                        ..
                    }
                ))
                .count(),
            2,
            "a foreign final must not satisfy either chain: {j:?}"
        );
        assert!(!j.iter().any(|j| matches!(j, Judgement::Fail { .. })));

        // A foreign final must not shadow the real final, irrespective of
        // input order, even when its header contradicts this world's chain.
        other_holding[header::EVENT_HEAD] ^= 1;
        other_province[header::EVENT_HEAD] ^= 1;
        let mixed = [
            holding.as_slice(),
            province.as_slice(),
            other_holding.as_slice(),
            other_province.as_slice(),
        ];
        let reversed = mixed.iter().copied().rev().collect::<Vec<_>>();
        for finals in [mixed.as_slice(), reversed.as_slice()] {
            let j = judge("P", &[(0, true, &logs)], finals, true);
            assert!(
                matches!(
                    j.as_slice(),
                    [Judgement::Unverifiable {
                        code: WIDE_UNMODELLED,
                        ..
                    }]
                ),
                "{j:?}"
            );
        }
        let (own, _) = account_chain(holding).unwrap();
        let (foreign, _) = account_chain(&other_holding).unwrap();
        assert_ne!(target_key(&own), target_key(&foreign));
        assert_ne!(target_name(&own), target_name(&foreign));

        // A contradictory final of the same identity still fails for whole
        // history, and stays unproven for history that is not complete.
        let mut changed = holding.to_vec();
        changed[header::EVENT_HEAD] ^= 1;
        let finals = [changed.as_slice(), province.as_slice()];
        for (whole, fail) in [(true, true), (false, false)] {
            let j = judge("P", &[(0, true, &logs)], &finals, whole);
            assert_eq!(
                j.iter().any(|j| matches!(
                    j,
                    Judgement::Fail {
                        code: WIDE_CHAIN_FINAL_MISMATCH,
                        ..
                    }
                )),
                fail,
                "{j:?}"
            );
            assert!(matches!(
                j.last(),
                Some(Judgement::Unverifiable {
                    code: WIDE_UNMODELLED,
                    ..
                })
            ));
        }
    }

    #[test]
    fn an_undecodable_wide_body_fails_and_a_wide_season_is_never_pass() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let logs = vec![
            "Program P invoke [1]".into(),
            format!(
                "Program data: {} {}",
                b64.encode(WIDE_LOG_PREFIX),
                b64.encode(b"not a record")
            ),
            "Program P success".into(),
        ];
        let j = judge("P", &[(0, true, &logs)], &[], true);
        assert!(
            matches!(
                j[0],
                Judgement::Fail {
                    code: WIDE_RECORD_UNDECODABLE,
                    ..
                }
            ),
            "{j:?}"
        );
        assert!(
            matches!(
                j.last(),
                Some(Judgement::Unverifiable {
                    code: WIDE_UNMODELLED,
                    ..
                })
            ),
            "{j:?}"
        );
        // A failed transaction's lines are not records.
        assert!(judge("P", &[(0, false, &logs)], &[], true).is_empty());
        // No wide record: VW1 says nothing.
        assert!(judge("P", &[(0, true, &[])], &[], true).is_empty());
    }

    /// Real PSW1 bodies (two Resolve records of one wide province, built
    /// with the ABI's own encoder) in program frames.
    fn resolve_logs(tamper: bool) -> Vec<String> {
        resolve_logs_of(&[20, 21], tamper, None)
    }

    /// Resolve records at `bells`, the one at `skip` left out of the logs.
    fn resolve_logs_of(bells: &[u32], tamper: bool, skip: Option<u32>) -> Vec<String> {
        use frontier_abi::world_index::coord::WideCoord;
        use frontier_abi::world_index::event::{encode, write_body, WideKind, MAX_BODY};
        use frontier_abi::world_index::key::WorldId;
        let b64 = base64::engine::general_purpose::STANDARD;
        let key = ProvinceKey::new(
            WorldId::new([3; 32]).unwrap(),
            WideCoord::checked(130, 0).unwrap(),
        )
        .to_bytes();
        let (mut seq, mut head) = (0u64, [0u8; 32]);
        let mut logs = vec![];
        for &bell in bells {
            let payload = vec![bell as u8; WideKind::Resolve.payload_len()];
            let mut buf = vec![0u8; MAX_BODY];
            let n = write_body(WideKind::Resolve, bell, &key, &payload, &mut buf).unwrap();
            let mut l = advance(WideEntity::Province, seq, &head, &buf[..n]).unwrap();
            (seq, head) = (l.seq, l.head);
            if tamper && bell == 21 {
                l.head[0] ^= 1;
            }
            let rec = encode(WideKind::Resolve, bell, &key, &payload, &[l]).unwrap();
            if skip == Some(bell) {
                continue;
            }
            logs.push("Program P invoke [1]".to_string());
            logs.push(format!(
                "Program data: {} {}",
                b64.encode(WIDE_LOG_PREFIX),
                b64.encode(&rec)
            ));
            logs.push("Program P success".to_string());
        }
        logs
    }

    #[test]
    fn real_wide_records_chain_and_a_tampered_link_fails() {
        let logs = resolve_logs(false);
        let j = judge("P", &[(0, true, &logs)], &[], true);
        // The chain holds; the account is not in the input, so no claim on
        // its end; never PASS.
        assert!(
            j.iter().all(|x| !matches!(x, Judgement::Fail { .. })),
            "{j:?}"
        );
        assert!(
            j.iter().any(|x| matches!(
                x,
                Judgement::Unverifiable {
                    code: WIDE_CHAIN_UNPROVEN,
                    ..
                }
            )),
            "{j:?}"
        );
        assert!(matches!(
            j.last(),
            Some(Judgement::Unverifiable {
                code: WIDE_UNMODELLED,
                ..
            })
        ));
        let logs = resolve_logs(true);
        let j = judge("P", &[(4, true, &logs)], &[], true);
        assert!(
            j.iter().any(|x| matches!(
                x,
                Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    tx: Some(4),
                    ..
                }
            )),
            "{j:?}"
        );
    }

    /// ⑯'s case (v16_vw_unknown w3): a record missing from the middle of a
    /// chain is a gap in the input, not a contradiction, unless the history
    /// is shown whole.
    #[test]
    fn a_missing_middle_record_is_unverifiable_unless_the_history_is_whole() {
        let logs = resolve_logs_of(&[20, 21, 22], false, Some(21));
        let j = judge("P", &[(0, true, &logs)], &[], false);
        assert!(
            j.iter().all(|x| !matches!(x, Judgement::Fail { .. })),
            "{j:?}"
        );
        assert!(
            j.iter().any(|x| matches!(x, Judgement::Unverifiable { code: WIDE_CHAIN_UNPROVEN, detail, .. } if detail.contains("between seq 1 and seq 3"))),
            "{j:?}"
        );
        let j = judge("P", &[(0, true, &logs)], &[], true);
        assert!(
            j.iter().any(|x| matches!(
                x,
                Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    ..
                }
            )),
            "{j:?}"
        );
        // A wrong head at the next number stays a contradiction either way.
        let logs = resolve_logs(true);
        let j = judge("P", &[(0, true, &logs)], &[], false);
        assert!(
            j.iter().any(|x| matches!(
                x,
                Judgement::Fail {
                    code: WIDE_CHAIN_BROKEN,
                    ..
                }
            )),
            "{j:?}"
        );
    }
}
