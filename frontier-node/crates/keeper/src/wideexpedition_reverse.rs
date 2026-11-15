//! Reverse observations inside the existing keeper review, never a send plan.
//! Uses the shared strict occupancy and transport codecs. No seal opening,
//! instruction admission, Engine enqueue, signer or historical execution proof.
use super::*;
use fclient::decode::Season;
use frontier_abi::layout::clash::{arrival as AR, arrival_day as AD, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::world_index::expedition_reverse_transport::{self as transport, ReverseMarker, ReverseTransit};

pub const SCHEMA: &str = "frontier-reverse-expedition-review-v1";
pub const MAX_READS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    ResolveWideOrigin,
    SettleWideOrigin,
    RevealEvidenceRequired,
    AnchorEvidenceRequired,
    WaitRevealClose,
    GatherOriginalArrival,
    GatherRemainingOriginalArrivals,
    MissingArrivalAfterClose,
    ResolveOriginalDestination,
    SettleOriginalDestination,
    CapturedSourceSettlementEvidence,
    ReleasedSourceCleanupEvidence,
    OriginDestroyedCleanupEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub slot: u8,
    pub state: MarchState,
    pub origin: ProvinceKey,
    pub destination: ProvinceKey,
    pub original_owner: Address,
    pub previous_generation: bool,
    pub previous_home: Option<Address>,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub arrival_index: Option<u8>,
    pub inputs_present: bool,
    pub next: Next,
    pub required_reads: Vec<Address>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn plan(
    scope: &Scope, selected: Selection, reads: &Reads, keys: &ReadPlan,
    season: &Season, holding: &Holding, hd: &[u8], slot: u8, marker: &ReverseMarker,
) -> Result<Facts, Refusal> {
    let ctx = wideduty::ctx_of(scope);
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| Block::World)?;
    let a = account(reads, scope, keys.bridges[slot as usize], "reverse transit")?;
    let reverse = ReverseTransit::from_bytes(&ctx, &a.data).map_err(|_| Refusal::OwnedBridgeRequired)?;
    transport::authenticate_pair(&ctx, &keys.holding.to_bytes(), slot,
        &keys.bridges[slot as usize].to_bytes(), marker, &reverse).map_err(|_| Refusal::BridgePair)?;
    let t = reverse.transit();
    if t.host != selected.host { return Err(Refusal::BridgePair); }
    if reverse.original_owner() != selected.original_owner.to_bytes() { return Err(Refusal::BridgeOwner); }
    if t.origin.key() != selected.standing { return Err(Refusal::BridgeDestination); }
    if t.arrive_bell >= season.end_bell { return Err(Refusal::BridgePair); }
    let previous = holding.gen != t.host.gen();
    let previous_home = if previous {
        let cq = holding.cq.ok_or(Refusal::SourceGeneration)?;
        if !cq.captured() || cq.prev_gen != t.host.gen()
            || cq.prev_owner_tag != frontier_abi::addr::citizen_tag(&reverse.original_owner()) {
            return Err(Refusal::SourceGeneration);
        }
        let ph = frontier_abi::addr::split_host_id(cq.prev_home).ok_or(Refusal::SourceGeneration)?;
        let key = wideduty::addr(ctx.holding(ph.province.p, ph.province.q, ph.site));
        if key == keys.holding { return Err(Refusal::SourceGeneration); }
        Some(key)
    } else {
        if holding.owner_citizen != selected.original_owner { return Err(Refusal::OwnerChanged); }
        if t.host.seq() >= holding.host_seq { return Err(Refusal::HostNotIssued); }
        None
    };
    let coord = resolver.adapter().coord_of(&reverse.destination()).map_err(|_| Refusal::BridgeDestination)?;
    let destination = wideduty::addr(ctx.province(coord.p, coord.q));
    let day = wideduty::addr(ctx.arrival_day(coord.p, coord.q, t.arrive_bell / 144));
    let inputs = wideduty::addr(ctx.clash_inputs(coord.p, coord.q, t.arrive_bell));
    let slots: [Address; 4] = std::array::from_fn(|i| wideduty::addr(ctx.arrival_slot(coord.p, coord.q, t.arrive_bell, t.faction, i as u8)));
    let region = permutation_rules::frontier::geometry::region_of(coord);
    let mut required = vec![destination, day, inputs,
        wideduty::addr(ctx.bell_anchor(t.arrive_bell, region)),
        wideduty::addr(ctx.anchor_archive(region, frontier_abi::addr::archive_part_of(t.arrive_bell)))];
    required.extend(slots);
    required.extend(previous_home);
    let missing = wideduty::missing(reads, &required);
    if !missing.is_empty() { return Err(Refusal::MissingReads(missing)); }
    for key in &required {
        if reads.accounts.get(key).and_then(Option::as_ref).is_some_and(|a| a.executable) {
            return Err(Refusal::ExecutableAccount(*key));
        }
    }
    if let Some(key) = previous_home {
        if wideduty::presence(reads, &key, &scope.program, "previous home")?.is_some() {
            let d = original(reads, scope, key, AccountKind::Holding, season.h.season_id, "previous home")?;
            let h = Holding::decode(d).map_err(|_| Refusal::OriginalAccount("previous home"))?;
            if ctx.holding(h.p as i32, h.q as i32, h.site) != key.to_bytes() {
                return Err(Refusal::OriginalAccount("previous home identity"));
            }
        }
    }
    let pd = original(reads, scope, destination, AccountKind::Province, season.h.season_id, "reverse destination")?;
    if rd_u16(pd, P::P).map(|n| n as i16 as i32) != Some(coord.p)
        || rd_u16(pd, P::Q).map(|n| n as i16 as i32) != Some(coord.q) {
        return Err(Refusal::OriginalAccount("reverse destination identity"));
    }
    let rn = rd_u32(pd, P::RESOLVED_NEXT).ok_or(Refusal::OriginalAccount("reverse destination"))?;
    let mut facts = Facts { slot, state: t.state, origin: t.origin.key(), destination: reverse.destination(),
        original_owner: selected.original_owner, previous_generation: previous, previous_home,
        depart_bell: t.depart_bell, arrive_bell: t.arrive_bell, arrival_index: None,
        inputs_present: false, next: Next::RevealEvidenceRequired, required_reads: required };
    // Historical capture metadata is consistency evidence only. Never reinterpret
    // it as current ownership or authorize a return to the captor's reserve.
    if previous { facts.next = Next::CapturedSourceSettlementEvidence; return Ok(facts); }
    if !matches!(holding.state, H::STATE_FINAL | H::STATE_PROVISIONAL) {
        facts.next = Next::ReleasedSourceCleanupEvidence; return Ok(facts);
    }
    if t.state == MarchState::DestroyedAtOrigin {
        facts.next = Next::OriginDestroyedCleanupEvidence;
        return Ok(facts);
    }
    if t.state == MarchState::Departed {
        let (_, wd) = wideduty::province_at(reads, scope, &ctx, &keys.standing, season.h.season_id,
            selected.standing.world(), "wide origin")?.ok_or(Block::Absent("wide origin"))?;
        let (roster, rd) = wideduty::roster_at(reads, scope, &keys.roster, season.h.season_id, selected.standing)?
            .ok_or(Refusal::ResidentMissingHistoryRequired)?;
        roster.validate_paired(rd, &resolve::live_ids(wd).map_err(|_| Block::BadEntry)?).map_err(|_| Block::RosterUnpaired)?;
        let index = find_entry(wd, wide_host_alias(&t.host)).ok_or(Refusal::BridgePair)?;
        let e = read_entry(wd, index).map_err(|_| Block::BadEntry)?;
        if !roster.entry_matches(rd, index, e.id, &t.host) || e.state != E::STATE_DEPARTED
            || e.unit != t.unit || e.faction != t.faction || e.tile != t.origin.local() {
            return Err(Refusal::BridgePair);
        }
        facts.next = if rd_u32(wd, P::RESOLVED_NEXT).ok_or(Block::BadEntry)? > t.depart_bell {
            Next::SettleWideOrigin
        } else { Next::ResolveWideOrigin };
        wideduty::chain_headroom(hd, 1, "original holding")?;
        wideduty::chain_headroom(wd, 1, "wide origin")?;
        return Ok(facts);
    }
    let id = resolver.legacy_host_id(&t.host).map_err(|_| Refusal::BridgePair)?;
    for (i, key) in slots.iter().enumerate() {
        if wideduty::presence(reads, key, &scope.program, "original arrival slot")?.is_none() { continue; }
        let d = original(reads, scope, *key, AccountKind::ArrivalSlot, season.h.season_id, "original arrival slot")?;
        if rd_u16(d, AS::P).map(|n| n as i16 as i32) != Some(coord.p)
            || rd_u16(d, AS::Q).map(|n| n as i16 as i32) != Some(coord.q)
            || rd_u32(d, AS::BELL) != Some(t.arrive_bell) || rd_u8(d, AS::FACTION) != Some(t.faction)
            || rd_u8(d, AS::I) != Some(i as u8) { return Err(Refusal::BridgePair); }
        if rd_u64(d, AS::HOST_ID) != Some(id) { continue; }
        if facts.arrival_index.is_some() || rd_u64(d, AS::CITIZEN_TAG) != Some(frontier_abi::addr::citizen_tag(&reverse.original_owner()))
            || rd_u32(d, AS::DEP_MASS) != Some(t.dep_mass) || rd_u8(d, AS::UNIT) != Some(t.unit)
            || rd_u8(d, AS::FLAGS).is_none_or(|v| v & !AS::FLAG_CREATED_DAY != 0) {
            return Err(Refusal::BridgePair);
        }
        facts.arrival_index = Some(i as u8);
    }
    if facts.arrival_index.is_some() {
        let d = original(reads, scope, day, AccountKind::ArrivalDay, season.h.season_id, "original arrival day")?;
        let (at, bit) = AD::bit(t.arrive_bell);
        if rd_u16(d, AD::P).map(|n| n as i16 as i32) != Some(coord.p)
            || rd_u16(d, AD::Q).map(|n| n as i16 as i32) != Some(coord.q)
            || rd_u32(d, AD::DAY) != Some(t.arrive_bell / 144) || rd_u8(d, at).is_none_or(|v| v & bit == 0) {
            return Err(Refusal::BridgePair);
        }
    }
    if wideduty::presence(reads, &inputs, &scope.program, "original inputs")?.is_some() {
        let cd = original(reads, scope, inputs, AccountKind::ClashInputs, season.h.season_id, "original inputs")?;
        facts.inputs_present = true;
        if rd_u16(cd, CI::P).map(|n| n as i16 as i32) != Some(coord.p)
            || rd_u16(cd, CI::Q).map(|n| n as i16 as i32) != Some(coord.q)
            || rd_u32(cd, CI::BELL) != Some(t.arrive_bell) { return Err(Refusal::BridgePair); }
        let mut member = None;
        for i in 0..4 {
            let k = CI::position(t.faction, i);
            let at = CI::arrival(k);
            if rd_u64(cd, at + AR::HOST_ID) != Some(id) { continue; }
            if member.is_some() || rd_u64(cd, at + AR::CITIZEN_TAG) != Some(frontier_abi::addr::citizen_tag(&reverse.original_owner()))
                || rd_u32(cd, at + AR::DEP_MASS) != Some(t.dep_mass) || rd_u8(cd, at + AR::UNIT) != Some(t.unit)
                || rd_u8(cd, at + AR::FACTION) != Some(t.faction)
                || rd_u32(cd, CI::ARRIVALS_MASK).is_none_or(|m| m & (1 << k) == 0)
                || rd_u32(cd, CI::SETTLED_MASK).is_none_or(|m| m & (1 << k) != 0) { return Err(Refusal::BridgePair); }
            member = Some(i);
        }
        if t.state == MarchState::Gathered {
            if member.is_none() || facts.arrival_index.is_some_and(|i| member != Some(i)) { return Err(Refusal::BridgePair); }
            let resolved = rd_u8(cd, CI::FLAGS).is_some_and(|f| f & CI::FLAG_RESOLVED != 0);
            if resolved && (rd_u32(cd, CI::ARRIVALS_MASK) != Some(CI::ALL_GATHERED) || rn <= t.arrive_bell) {
                return Err(Refusal::BridgePair);
            }
            facts.next = if resolved { Next::SettleOriginalDestination }
                else if rd_u32(cd, CI::ARRIVALS_MASK) != Some(CI::ALL_GATHERED) { Next::GatherRemainingOriginalArrivals }
                else { Next::ResolveOriginalDestination };
            return Ok(facts);
        }
        if member.is_some() { return Err(Refusal::BridgePair); }
    } else if t.state == MarchState::Gathered { return Err(Refusal::BridgePair); }
    // Original Reveal refuses once inputs exist. A missing arrival cannot be
    // repaired by suggesting another Reveal against that already latched bell.
    if facts.inputs_present && facts.arrival_index.is_none() {
        facts.next = Next::MissingArrivalAfterClose;
        return Ok(facts);
    }
    if rn > t.arrive_bell { facts.next = Next::MissingArrivalAfterClose; return Ok(facts); }
    let anchor = match wideduty::anchor_read(reads, scope, &ctx, season.h.season_id, season.genesis_ts, t.arrive_bell, region) {
        Ok(a) => a,
        Err(Block::NoAnchor(_)) => { facts.next = Next::AnchorEvidenceRequired; return Ok(facts); }
        Err(e) => return Err(e.into()),
    };
    let now = reads.clock.ok_or(Refusal::ClockMissing)?;
    let closed = now.unix_timestamp >= SeasonClock::from_season(season).reveal_close(t.arrive_bell, anchor.a_ts);
    facts.next = match (facts.arrival_index.is_some(), closed) {
        (true, true) => Next::GatherOriginalArrival,
        (true, false) => Next::WaitRevealClose,
        (false, true) => Next::MissingArrivalAfterClose,
        (false, false) => Next::RevealEvidenceRequired,
    };
    Ok(facts)
}

pub(super) fn describe(report: &Report, f: &Facts) -> Value {
    json!({"schema":SCHEMA, "key":report.key(), "kind":KIND, "direction":"wide-to-original",
        "host":hex::encode(report.selected.host.to_bytes()), "original_owner":f.original_owner.to_string(),
        "origin":hex::encode(f.origin.to_bytes()), "destination":hex::encode(f.destination.to_bytes()),
        "slot":f.slot, "state":format!("{:?}",f.state), "previous_generation":f.previous_generation,
        "previous_home":f.previous_home.map(|a|a.to_string()), "depart_bell":f.depart_bell.to_string(),
        "arrive_bell":f.arrive_bell.to_string(), "arrival_index":f.arrival_index, "inputs_present":f.inputs_present,
        "next_prerequisite":format!("{:?}",f.next), "required_reads":report.accounts.keys().iter().map(ToString::to_string).collect::<Vec<_>>(),
        "min_slot":report.min_slot.to_string(), "context_slot":report.context_slot.map(|s|s.to_string()),
        "coherent":report.context_slot.is_some(), "provenance_verified":false, "history_verified":false,
        "dispatch_available":false, "instruction":null, "admitted":false, "signed":false,
        "enqueued":false, "automatic_send":false, "completion_proven":false,
        "engine":report.engine.as_ref().map(|e|json!({"feed_writes_allowed":e.feed_writes_allowed,
            "kind_allowed":e.kind_allowed,"already_pending":e.already_pending,"care_unresolved":e.care_unresolved})),
        "denials":["ReverseDispatchUnavailable","HistoryUnverified","SourceProvenanceUnverified","SignerAbsent","SliceDoesNotEnqueue","SnapshotCurrencyUnknown"]})
}
