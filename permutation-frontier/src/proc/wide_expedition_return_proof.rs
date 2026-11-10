//! Private proof bridge for resolved original-to-wide members. Its stage is
//! read-only; its isolated draft consumer invokes same-call settlement.
//! This is a child of `expedition_return`, never a public instruction API.
//! It uses the production anchor/archive selection, clock grace and wide
//! opener, then the original-owner return staging. Bad seals and nonmembers
//! remain refused by member/camp consumers. A separate failure draft supports
//! only already-destroyed members, without forfeiture or routed settlement.
use super::*;

/// An opaque observation, NOT a reusable settlement capability. No fields,
/// getters, serializer, payment or commit interface are exposed to the parent.
/// Any future effects must re-read and authenticate all runtime accounts and
/// repeat this proof/staging in the SAME call, then atomically commit payments,
/// claims, cleanup and paired receipts. Merely retaining this value authorizes
/// none of those effects, even if its account snapshots were once current.
pub(super) struct PendingVerifiedResolvedReturn {
    pending: PendingResolvedReturn,
    plain: wseal::WidePlain,
    anchor: AnchorSource,
    settle_at: i64,
}

/// `a` is exactly the parent candidate's private eight/nine-account table:
/// season, original holding, owned bridge, original home, wide destination,
/// resolved inputs, retained/absent slot, external rent recipient, optional
/// PREV_HOME. `anchor` is THE canonical destination-region anchor or archive.
/// Neither a plaintext, signature, outcome nor a validity verdict is accepted
/// from the caller. The only proof input is the actual committed wide seal.
/// No account data, lamports, events or external state is changed on any path.
struct OpenedMemberSeal {
    code: u8,
    plain: Option<wseal::WidePlain>,
    anchor: AnchorSource,
    settle_at: i64,
    destination: ProvinceKey,
}

fn open_member_seal(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot_index: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<OpenedMemberSeal> {
    let [season, holding, external, _home, dest, _inputs, _slot, _rent_to, tail @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if tail.len() > 1 || slot_index as usize >= H::TRANSIT_N {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        hdr.id,
    )?;
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    {
        let hd = holding.try_borrow_data()?;
        let off = H::transit(slot_index as usize);
        let marker =
            BridgeMarker::from_bytes(&ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
                .map_err(|_| BAD_ACCOUNT)?;
        authenticate_pair(
            &ctx,
            &key(holding),
            slot_index,
            &key(external),
            &marker,
            bridge.common(),
        )
        .map_err(|_| BAD_ACCOUNT)?;
    }
    let t = bridge.transit();
    if t.state != MarchState::Gathered {
        return Err(FrontierError::TransitState.into());
    }
    let dp = canonical_province(dest, p, &ctx, hdr.id, world_of(&ctx)?)?;
    let dkey = ProvinceKey::new(dp.world, dp.coord);
    if t.dest != Some(dkey) {
        return Err(FrontierError::BadAddress.into());
    }
    let clock = SeasonClock::read(&season.try_borrow_data()?)?;
    let src = the_anchor_or_archive(p, &ctx, hdr.id, anchor, t.arrive_bell, dp.region, &clock)?;
    let settle_at = clock
        .reveal_close(t.arrive_bell, src.a)
        .checked_add(crate::proc::transit::SETTLE_AFTER_CLOSE_SECS)
        .ok_or(OVERFLOW)?;
    if now.ts < settle_at || Ro(&dest.try_borrow_data()?).u32(PV::RESOLVED_NEXT)? <= t.arrive_bell {
        return Err(FrontierError::TooEarly.into());
    }
    if cseal::wide_seal_root_of(commit, seal) != t.seal_root {
        return Err(FrontierError::CommitMismatch.into());
    }
    // Program-owned canonical anchors are already verified by PostAnchor.
    // Exactly as wide::settle_transit, malformed anchor decompression is an
    // instruction error; seal failures are opener verdicts, never a bypass.
    let s_aff = sys::bls_g1_decompress(&src.sig48)
        .map_err(|_| crypto(crate::error::crypto_sub::BAD_POINT))?;
    let (code, plain) = cseal::judge_wide(&s_aff, seal, commit, &t.host, t.arrive_bell);
    Ok(OpenedMemberSeal {
        code,
        plain,
        anchor: src,
        settle_at,
        destination: dkey,
    })
}

pub(super) fn stage(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot_index: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<PendingVerifiedResolvedReturn> {
    let OpenedMemberSeal {
        code,
        plain,
        anchor: src,
        settle_at,
        destination: dkey,
    } = open_member_seal(p, a, anchor, slot_index, commit, seal)?;
    if code != seal_code::VALID {
        // No invented forfeiture or fee treatment for unsupported bad seals.
        return Err(FrontierError::NotImplemented.into());
    }
    let plain = plain.ok_or(BAD_ACCOUNT)?;
    if plain.dest != dkey {
        return Err(FrontierError::BadAddress.into());
    }
    // Re-reads the strict owned-v2 bridge and original marker; authenticates
    // current/previous generation, full original Citizen, unique unresolved
    // final-set membership and retained slot; derives the actual recorded fate
    // and survivor amount. No caller can choose a final-set outcome here.
    let pending = stage_resolved_return(p, a, slot_index)?;
    Ok(PendingVerifiedResolvedReturn {
        pending,
        plain,
        anchor: src,
        settle_at,
    })
}

/// Narrow failure contract: the same authenticated final-set member is already
/// destroyed. No caller verdict, no survivor return, no destination forfeiture.
/// All other fates and nonmembers remain unsupported by this consumer.
fn stage_bad_destroyed(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<(PendingResolvedReturn, u8)> {
    stage_bad_member(p, a, anchor, slot, commit, seal, false)
}

fn stage_bad_forfeit(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<(PendingResolvedReturn, u8)> {
    stage_bad_member(p, a, anchor, slot, commit, seal, true)
}

fn stage_bad_member(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
    forfeit: bool,
) -> R<(PendingResolvedReturn, u8)> {
    let opened = open_member_seal(p, a, anchor, slot, commit, seal)?;
    if !matches!(
        opened.code,
        seal_code::FO_FAILED
            | seal_code::BAD_POINT
            | seal_code::COMMIT_MISMATCH
            | seal_code::BAD_PLAINTEXT
    ) {
        return Err(FrontierError::NotImplemented.into());
    }
    let pending = stage_resolved_return(p, a, slot)?;
    let supported = match pending.payments_if_valid.outcome {
        WideOutcome::Fate(wa::wide_arrival::FATE_DESTROYED) => !forfeit,
        WideOutcome::Fate(wa::wide_arrival::FATE_STAYS | wa::wide_arrival::FATE_WITHDREW) => {
            forfeit
        }
        _ => false,
    };
    if !supported
        || pending.retained_slot.is_some()
        || pending.home.is_some()
        || pending.previous_home.is_some()
        || pending.credited_milli != 0
    {
        return Err(FrontierError::NotImplemented.into());
    }
    Ok((pending, opened.code))
}

/// Separate present-slot contract; v1/v2 keep rejecting retained evidence.
fn stage_bad_retained(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<(PendingResolvedReturn, u8, AnchorSource)> {
    let opened = open_member_seal(p, a, anchor, slot, commit, seal)?;
    if !matches!(
        opened.code,
        seal_code::FO_FAILED
            | seal_code::BAD_POINT
            | seal_code::COMMIT_MISMATCH
            | seal_code::BAD_PLAINTEXT
    ) {
        return Err(FrontierError::NotImplemented.into());
    }
    let pending = stage_resolved_return(p, a, slot)?;
    if !matches!(
        pending.payments_if_valid.outcome,
        WideOutcome::Fate(
            wa::wide_arrival::FATE_DESTROYED
                | wa::wide_arrival::FATE_STAYS
                | wa::wide_arrival::FATE_WITHDREW
        )
    ) || !matches!(pending.retained_slot, Some(ArrivalSlot::Expedition(_)))
        || pending.home.is_some()
        || pending.previous_home.is_some()
        || pending.credited_milli != 0
    {
        return Err(FrontierError::NotImplemented.into());
    }
    Ok((pending, opened.code, opened.anchor))
}

pub(super) fn settle_retained_failure_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    settlement::retained_failure::execute_draft(p, a, d)
}

pub(super) fn settle_failure_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    settlement::failure::execute_draft(p, a, d)
}

pub(super) fn settle_forfeit_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    settlement::forfeit::execute_draft(p, a, d)
}

#[path = "wide_expedition_settlement.rs"]
mod settlement;

/// Consume the isolated draft, not a decoded outcome or retained proof plan.
/// Account count determines the only possible split. The existing consumer
/// performs real seal/anchor proof, history authentication and staging again
/// in this call; its receipt command remains slot + commitment + seal.
pub(super) fn settle_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::world_index::expedition_settlement_ix::{AccountLayout, DraftCommand};
    let command = DraftCommand::decode(d)?;
    let layout = AccountLayout::from_count(a.len())?;
    for (i, account) in a.iter().enumerate() {
        let spec = layout.spec(i).ok_or(BAD_ACCOUNT)?;
        if (spec.signer && !account.is_signer)
            || (spec.wr == frontier_abi::prologue::Wr::W && !account.is_writable)
        {
            return Err(BAD_ACCOUNT);
        }
    }
    settlement::settle(
        p,
        a,
        layout.base(),
        command.slot(),
        command.commit(),
        command.seal(),
    )
}

/// Separate closed camp schema: exact version and roles before any proof or
/// write. No account-count fallback from v1, caller split, outcome or loot.
pub(super) fn settle_camp_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::world_index::expedition_settlement_ix::camp_v2::{
        AccountLayout, DraftCommand,
    };
    let command = DraftCommand::decode(d)?;
    let layout = AccountLayout::from_count(a.len())?;
    for (i, account) in a.iter().enumerate() {
        let spec = layout.spec(i).ok_or(BAD_ACCOUNT)?;
        if (spec.signer && !account.is_signer)
            || (spec.wr == frontier_abi::prologue::Wr::W && !account.is_writable)
        {
            return Err(BAD_ACCOUNT);
        }
        for (j, previous) in a[..i].iter().enumerate() {
            if previous.key == account.key && !layout.roles_may_alias(i, j) {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    settlement::settle_camp_v2(
        p,
        a,
        layout.base(),
        command.slot(),
        command.commit(),
        command.seal(),
    )
}

#[cfg(all(test, feature = "public-proof-tests", not(target_os = "solana")))]
#[path = "wide_expedition_return_proof_tests.rs"]
mod tests;

// Isolated unsigned test adapter only. No production API, dispatch or proof bypass.
#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "public-proof-tests",
    feature = "system-cpi-tests",
    not(target_os = "solana")
))]
pub(super) fn runtime_settle(
    p: &Pubkey,
    a: &[AccountInfo],
    base: usize,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<()> {
    settlement::settle(p, a, base, slot, commit, seal)
}
