//! Private, read-only proof bridge for resolved original-to-wide members.
//! This is a child of `expedition_return`, not an instruction or effect API.
//! It uses the production anchor/archive selection, clock grace and wide
//! opener, then the original-owner return staging. Bad seals and nonmembers
//! remain refused: this does not implement forfeiture or routed settlement.
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
pub(super) fn stage(
    p: &Pubkey,
    a: &[AccountInfo],
    anchor: &AccountInfo,
    slot_index: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<PendingVerifiedResolvedReturn> {
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

#[cfg(all(test, feature = "public-proof-tests", not(target_os = "solana")))]
#[path = "wide_expedition_return_proof_tests.rs"]
mod tests;
