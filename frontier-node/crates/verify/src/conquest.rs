//! Independent version-3 audit of record chains, pinned final state and
//! territory-time scoring. These checks deliberately have separate names from
//! the legacy V1–V13 combat/seal replay suite: coverage must stay visible.
use std::collections::{BTreeMap, BTreeSet};

use fclient::decode::{chained_header, Citizen, Holding, Province, Season};
use fclient::ports::Account;
use frontier_abi::bytes::rd_u32;
use frontier_abi::log::{CitizenRef, EntityRef, Kind};
use frontier_abi::v2::layout::{province::province as P, AccountKind};
use frontier_abi::v2::log::{self as log, AnyKind, CqKind, EntityKind, EntityRefV2};

use crate::world::Key;
use crate::{Counts, Finding, Input, Liveness, Report, Severity, Verdict};

type State = BTreeMap<Key, Account>;
type Heads = BTreeMap<Key, (u64, [u8; 32])>;

fn account_kind(d: &[u8]) -> Option<AccountKind> {
    AccountKind::from_magic(d.get(..8)?.try_into().ok()?)
}
fn entity_of(d: &[u8]) -> Option<EntityKind> {
    let k = account_kind(d)?;
    EntityKind::ALL.into_iter().find(|x| x.account_kind() == k)
}
fn by_tag(state: &State, tag: u64) -> Option<Key> {
    state
        .keys()
        .find(|k| {
            u64::from_le_bytes(k[..8].try_into().unwrap()) == tag
                && Citizen::decode(&state[*k].data).is_ok()
        })
        .copied()
}
fn citizen_key(ctx: &frontier_abi::addr::AddrCtx, state: &State, r: &CitizenRef) -> Option<Key> {
    match r {
        CitizenRef::Tag15(t) => Some(ctx.citizen_by_tag15(t)),
        CitizenRef::Tag8(t) => by_tag(state, *t),
        CitizenRef::OfHolding { p, q, site } => {
            let h = Holding::decode(&state.get(&ctx.holding(*p, *q, *site))?.data).ok()?;
            Some(h.owner_citizen.to_bytes())
        }
    }
}
fn resolve(ctx: &frontier_abi::addr::AddrCtx, state: &State, who: &EntityRefV2) -> Option<Key> {
    match who {
        EntityRefV2::Base(EntityRef::Citizen(c)) => citizen_key(ctx, state, c),
        EntityRefV2::Base(EntityRef::JoinShardOf(c)) => {
            let key = citizen_key(ctx, state, c)?;
            let c = Citizen::decode(&state.get(&key)?.data).ok()?;
            Some(ctx.join_shard(c.faction, c.join_shard))
        }
        _ => log::march_address(ctx, who),
    }
}
fn finding(
    out: &mut Vec<Finding>,
    check: &'static str,
    code: &str,
    entity: String,
    bell: u32,
    sig: &str,
    detail: impl Into<String>,
) {
    out.push(Finding {
        code: code.into(),
        severity: Severity::Fail,
        check,
        entity,
        bell,
        signature: sig.into(),
        detail: detail.into(),
    });
}
fn score(d: &[u8]) -> Option<([u64; 6], u32, u8)> {
    let p = Province::decode(d).ok()?;
    let c = p.cq?;
    Some((
        c.territory_bells,
        c.score_next_bell,
        c.keep.map_or(6, |k| k.holder),
    ))
}
/// Replay only ownership-time accounting. A capture at turn b changes the
/// earning faction from b+1, so late settlement can never move past points.
fn score_delta(
    before: ([u64; 6], u32, u8),
    next: u32,
    changes: &[(u32, u8)],
    end: u32,
) -> Option<[u64; 6]> {
    let (mut scores, first, mut holder) = before;
    if next < first || next > end {
        return None;
    }
    for b in first..next {
        if holder < 6 {
            scores[holder as usize] = scores[holder as usize].checked_add(1)?;
        }
        for &(at, to) in changes {
            if at == b {
                holder = to;
            }
        }
    }
    Some(scores)
}

pub fn applies(input: &Input) -> bool {
    input
        .finals
        .values()
        .flatten()
        .any(|a| Season::decode(&a.data).is_ok_and(|s| s.program_version >= 3))
        || input.cfg.ruleset_hash == frontier_abi::v2::presets::RULESET_HASH_V2
        || input.cfg.ruleset_hash == frontier_abi::v2::presets::RULESET_HASH_V3
}

/// An S1 season (redesign stage 1, program version 4): a Season with
/// `program_version >= 4`, or the configured ruleset is `RULESET_HASH_V3`.
/// S1 keeps every MC rule, so [`applies`] is true too.
pub fn s1_applies(input: &Input) -> bool {
    input.finals.values().flatten().any(|a| {
        Season::decode(&a.data)
            .is_ok_and(|s| s.program_version >= frontier_abi::v2::presets::PROGRAM_VERSION_S1)
    }) || input.cfg.ruleset_hash == frontier_abi::v2::presets::RULESET_HASH_V3
}

pub fn verify(input: &Input) -> Report {
    let ctx = findex::addr_ctx(&input.cfg.program, input.cfg.season_id);
    let mut states = State::new();
    let mut heads = Heads::new();
    let mut findings = vec![];
    let mut seen = BTreeSet::new();
    let mut bells = 0;
    let mut end = u32::MAX;
    let mut counts = Counts {
        tx: input.txs.len() as u64,
        ..Counts::default()
    };
    for tx in &input.txs {
        let sig = tx.signature.to_string();
        if !seen.insert(sig.clone()) {
            finding(
                &mut findings,
                "CQ1",
                "DuplicateTransaction",
                "archive".into(),
                0,
                &sig,
                "a transaction occurs twice",
            );
        }
        if tx.err.is_some() {
            counts.failed_tx += 1;
            continue;
        }
        let parsed = match fclient::tx::from_wire(&tx.tx) {
            Ok(p) => p,
            Err(e) => {
                finding(
                    &mut findings,
                    "CQ1",
                    "Undecodable",
                    "transaction".into(),
                    0,
                    &sig,
                    e,
                );
                continue;
            }
        };
        let mut writable = Vec::new();
        for ix in &parsed.message.instructions {
            if parsed
                .message
                .account_keys
                .get(ix.program_id_index as usize)
                != Some(&input.cfg.program)
            {
                continue;
            }
            for &i in &ix.accounts {
                if fclient::tx::is_writable_index(&parsed.message, i as usize) {
                    if let Some(k) = parsed.message.account_keys.get(i as usize) {
                        if !writable.contains(&k.to_bytes()) {
                            writable.push(k.to_bytes());
                        }
                    }
                }
            }
        }
        let mut context = states.clone();
        for (k, a) in &tx.post {
            if let Some(a) = a {
                context.insert(k.to_bytes(), a.clone());
            }
        }
        if let Some(s) = context
            .get(&ctx.season)
            .and_then(|a| Season::decode(&a.data).ok())
        {
            end = s.end_bell;
            if s.status >= 1
                && (s.program_version != 3
                    || s.ruleset_hash != input.cfg.ruleset_hash
                    || s.h.season_id != input.cfg.season_id)
            {
                finding(
                    &mut findings,
                    "CQ2",
                    "SeasonIdentity",
                    "Season".into(),
                    0,
                    &sig,
                    "version, ruleset or season differs from the expected v3 world",
                );
            }
        }
        let bodies = match fclient::log::bodies_from_logs(&tx.logs, &input.cfg.program) {
            Ok(x) => x,
            Err(e) => {
                finding(
                    &mut findings,
                    "CQ1",
                    "Undecodable",
                    "logs".into(),
                    0,
                    &sig,
                    format!("{e:?}"),
                );
                continue;
            }
        };
        let mut changes: BTreeMap<Key, Vec<(u32, u8)>> = BTreeMap::new();
        for b in &bodies {
            let r = match log::decode(b) {
                Ok(r) => r,
                Err(e) => {
                    finding(
                        &mut findings,
                        "CQ1",
                        "Undecodable",
                        "record".into(),
                        0,
                        &sig,
                        format!("{e:?}"),
                    );
                    continue;
                }
            };
            if r.bell != u32::MAX {
                bells = bells.max(r.bell as u64 + 1);
            }
            match r.kind {
                AnyKind::V1(Kind::CLASH) => counts.clashes += 1,
                AnyKind::V1(Kind::SKIP) => counts.skips += 1,
                AnyKind::V1(Kind::DEPART) => counts.seals += 1,
                AnyKind::V1(Kind::REVEAL) => counts.reveals += 1,
                _ => {}
            }
            if r.kind == AnyKind::Cq(CqKind::CONQUEST) {
                if let Some(pl) = log::ConquestPayload::from_bytes(r.payload) {
                    let p = i32::from_le_bytes(r.key[..4].try_into().unwrap());
                    let q = i32::from_le_bytes(r.key[4..8].try_into().unwrap());
                    let at = rd_u32(r.key, 8).unwrap_or(r.bell);
                    for e in pl.events.iter().take(pl.n as usize) {
                        if e.site == log::event::KEEP_SITE
                            && e.code & !log::event::DETAIL == log::event::KEEP_TAKEN
                        {
                            changes
                                .entry(ctx.province(p, q))
                                .or_default()
                                .push((at, e.faction));
                        }
                    }
                }
            }
            let Some(expected) = log::chains_of(r.kind, r.key, r.payload) else {
                finding(
                    &mut findings,
                    "CQ1",
                    "UnknownEntity",
                    r.kind.name().into(),
                    r.bell,
                    &sig,
                    "record has no entity table",
                );
                continue;
            };
            let links: Vec<_> = r.links.iter().take(r.n_links).flatten().copied().collect();
            let mut li = 0;
            let mut used = BTreeSet::new();
            for exp in expected.iter() {
                let Some(link) = links.get(li).filter(|l| l.entity == exp.entity) else {
                    if !exp.optional {
                        finding(
                            &mut findings,
                            "CQ1",
                            "MissingLink",
                            r.kind.name().into(),
                            r.bell,
                            &sig,
                            format!("missing {:?}", exp.entity),
                        );
                    }
                    continue;
                };
                let key = resolve(&ctx, &context, &exp.who).or_else(|| {
                    writable
                        .iter()
                        .copied()
                        .filter(|k| {
                            !used.contains(k)
                                && context.get(k).and_then(|a| entity_of(&a.data))
                                    == Some(exp.entity)
                        })
                        .find(|k| {
                            let (seq, head) = heads.get(k).copied().unwrap_or((0, [0; 32]));
                            link.seq == seq + 1
                                && log::next_head(&head, link.seq, r.body_without_tail) == link.head
                        })
                });
                let Some(key) = key else {
                    finding(
                        &mut findings,
                        "CQ1",
                        "UnknownEntity",
                        r.kind.name().into(),
                        r.bell,
                        &sig,
                        format!("cannot resolve {:?}", exp.who),
                    );
                    li += 1;
                    continue;
                };
                used.insert(key);
                let (seq, head) = heads.get(&key).copied().unwrap_or((0, [0; 32]));
                if link.seq != seq + 1
                    || log::next_head(&head, link.seq, r.body_without_tail) != link.head
                {
                    finding(
                        &mut findings,
                        "CQ1",
                        "ChainMismatch",
                        fclient::Address::new_from_array(key).to_string(),
                        r.bell,
                        &sig,
                        format!("expected seq {}, found {}", seq + 1, link.seq),
                    );
                }
                if !writable.contains(&key) {
                    finding(
                        &mut findings,
                        "CQ1",
                        "ReadonlyChain",
                        r.kind.name().into(),
                        r.bell,
                        &sig,
                        "a record chains an account the instruction cannot write",
                    );
                }
                heads.insert(key, (link.seq, link.head));
                if r.kind == AnyKind::V1(Kind::CLOSE) {
                    heads.remove(&key);
                }
                li += 1;
            }
            if li != links.len() {
                finding(
                    &mut findings,
                    "CQ1",
                    "ExtraLink",
                    r.kind.name().into(),
                    r.bell,
                    &sig,
                    "unexpected trailing links",
                );
            }
        }
        for (k, a) in &tx.post {
            let key = k.to_bytes();
            if let Some(a) = a {
                if let Some((after, next, holder)) = score(&a.data) {
                    if let Some(before) = states.get(&key).and_then(|x| score(&x.data)) {
                        let ownership_changes = changes.get(&key).map(Vec::as_slice).unwrap_or(&[]);
                        let expected_holder =
                            ownership_changes.last().map_or(before.2, |(_, to)| *to);
                        if holder != expected_holder
                            || ownership_changes
                                .iter()
                                .any(|(b, _)| *b < before.1 || *b >= next)
                        {
                            finding(&mut findings, "CQ3", "KeepHolderMismatch", k.to_string(), next, &sig,
                                "keep ownership changed without a matching capture in its resolved turn interval");
                        }
                        let expected = score_delta(before, next, ownership_changes, end);
                        if expected != Some(after) {
                            finding(
                                &mut findings,
                                "CQ3",
                                "TerritoryScoreMismatch",
                                k.to_string(),
                                next,
                                &sig,
                                format!("expected {expected:?}, found {after:?}"),
                            );
                        }
                    } else if after != [0; 6] {
                        finding(
                            &mut findings,
                            "CQ3",
                            "InitialTerritoryScore",
                            k.to_string(),
                            next,
                            &sig,
                            "new Province starts with nonzero score",
                        );
                    }
                    if next
                        != rd_u32(&a.data, P::RESOLVED_NEXT)
                            .unwrap_or(u32::MAX)
                            .min(end)
                    {
                        finding(
                            &mut findings,
                            "CQ3",
                            "ScoreCursorMismatch",
                            k.to_string(),
                            next,
                            &sig,
                            "score cursor does not match resolved turns",
                        );
                    }
                }
                states.insert(key, a.clone());
            } else {
                states.remove(&key);
            }
        }
    }
    for (key, (seq, head)) in &heads {
        let actual = input
            .finals
            .get(key)
            .and_then(Option::as_ref)
            .and_then(|a| chained_header(&a.data));
        if actual.is_none_or(|h| h.event_seq != *seq || h.event_head != *head) {
            finding(
                &mut findings,
                "CQ1",
                "FinalHeadMismatch",
                fclient::Address::new_from_array(*key).to_string(),
                0,
                "",
                "pinned final account does not end at its archived chain",
            );
        }
    }
    for (key, a) in &input.finals {
        if let Some(a) = a {
            if a.owner != input.cfg.program {
                continue;
            }
            if states
                .get(key)
                .is_none_or(|s| s.data != a.data || s.lamports != a.lamports || s.owner != a.owner)
            {
                finding(
                    &mut findings,
                    "CQ1",
                    "FinalStateMismatch",
                    fclient::Address::new_from_array(*key).to_string(),
                    0,
                    "",
                    "pinned final state differs from last archived write",
                );
            }
        }
    }
    if let Some(want) = input.cfg.program_hash {
        if input.program_hashes.is_empty()
            || input.program_hashes.iter().any(|(_, got)| *got != want)
        {
            finding(
                &mut findings,
                "CQ2",
                "ProgramHashMismatch",
                "Program".into(),
                0,
                "",
                "deployed program hash does not match expected binary",
            );
        }
    }
    let verdict = if findings.is_empty() {
        Verdict::Pass
    } else {
        Verdict::Fail
    };
    Report { verdict, season: input.cfg.season_id, program: input.cfg.program.to_string(), slot_range: (input.txs.iter().map(|t|t.slot).min().unwrap_or(0),input.final_slot), entities: heads.len() as u64, bells, counts, findings, liveness:Liveness::default(), checks_run:vec!["CQ1:event-chains-and-final-state", "CQ2:program-and-season-identity", "CQ3:territory-time-replay"], provenance:format!("{}; CQ audit coverage: event chains, final state, identity, territory time. Legacy combat/seal economic replay is not claimed.",input.provenance) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_turn_still_credits_previous_owner() {
        assert_eq!(
            score_delta(([10, 0, 0, 0, 0, 0], 10, 0), 14, &[(11, 1)], 20),
            Some([12, 2, 0, 0, 0, 0])
        );
        assert_eq!(
            score_delta(([12, 2, 0, 0, 0, 0], 14, 1), 14, &[], 20),
            Some([12, 2, 0, 0, 0, 0])
        );
    }
    #[test]
    fn neutral_and_season_boundary_never_mint_extra_time() {
        assert_eq!(
            score_delta(([0; 6], 3, 6), 6, &[(4, 2)], 6),
            Some([0, 0, 1, 0, 0, 0])
        );
        assert_eq!(score_delta(([0; 6], 3, 0), 7, &[], 6), None);
        assert_eq!(score_delta(([0; 6], 3, 0), 2, &[], 6), None);
    }
}
