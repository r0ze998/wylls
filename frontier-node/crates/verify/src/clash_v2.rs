//! The ResolveFromInputs replay of V7 on a conquest Province (ABI v2, MC
//! contract §5.7; CQ3-A): the program's v2 calling order
//! (`permutation-frontier/src/proc/clash.rs` module note, "resolve"):
//! `input_digest_v2 → build_v2 → the kernel's resolve_clash →
//! report_from_outcome → apply_v2 → settle_bell → conquest_model::step →
//! finish_bell`, then the resolve's own writes (`last_digest`, the
//! summary, the ClashInputs fate table, `FLAG_RESOLVED`, the camp mask).
//!
//! **Not independent:** as [`crate::skip::replay_v2`], every step here is
//! the program's shared `frontier_abi::{clash_model, conquest_model}` (the
//! functions the program calls); what the replay adds is the calling
//! order, the digests and the comparison with what the chain wrote — the
//! Province and the ClashInputs, every byte but the event chain's header
//! fields and the fields that record who resolved ([`mask_province`],
//! [`mask_inputs`]: the summary's resolver, the ClashInputs' resolver,
//! evidence and resolve time are the keeper's, not the rules').

use frontier_abi::clash_model as m;
use frontier_abi::conquest_model as cq;
use frontier_abi::layout::clash::{arrival as AR, clash_inputs as CI};
use frontier_abi::layout::header as HD;
use frontier_abi::layout::province::{province as PV, summary as SU};
use frontier_abi::v2::layout::province::province as P2;
use permutation_rules::frontier::clash as kc;

/// What a replayed v2 resolve leaves.
#[derive(Clone, Debug)]
pub struct Replayed {
    /// CLASH's `input_digest` (`PSF-CLASH-INPUT-v2`).
    pub input: [u8; 32],
    /// CLASH's `outcome_digest`.
    pub outcome: [u8; 32],
    pub engagements: u32,
    /// CLASH's packed fates.
    pub fates: [u8; 9],
    /// The Province after the resolve (header chain fields and the
    /// summary's resolver as in `before`).
    pub province: Vec<u8>,
    /// The ClashInputs after the resolve (the keeper's fields as before).
    pub inputs: Vec<u8>,
    /// More than one faction among residents and arrivals, with arrivals
    /// (V10's contested province-bells).
    pub contested: bool,
    /// The bell's conquest step.
    pub step: cq::StepOut,
}

fn put(d: &mut [u8], o: usize, b: &[u8]) -> Result<(), String> {
    d.get_mut(o..o + b.len())
        .ok_or(format!("short at {o}"))?
        .copy_from_slice(b);
    Ok(())
}

/// Replays the resolve of bell `b` over the Province `before` (4,736 B)
/// and the gathered ClashInputs `inputs_before` with THE seed of the bell.
pub fn replay(
    before: &[u8],
    inputs_before: &[u8],
    b: u32,
    seed: &[u8; 32],
    prm: &cq::StepParams,
) -> Result<Replayed, String> {
    if before.len() != P2::SIZE {
        return Err(format!(
            "the Province before the clash is {} B, the v2 layout has {}",
            before.len(),
            P2::SIZE
        ));
    }
    let e = |x: m::ModelError| format!("{x:?}");
    let mut pd = before.to_vec();
    let mut ci = inputs_before.to_vec();
    let input = m::input_digest_v2(&pd, &ci, b, seed).map_err(e)?;
    let built = m::build_v2(&pd, Some(&ci), b)
        .map_err(|x| format!("the logged inputs do not build: {x:?}"))?;
    let out = kc::resolve_clash(&kc::frontier_ruleset(), &built.input(seed))
        .map_err(|x| format!("the kernel refuses the logged inputs: {x:?}"))?;
    let report = cq::report_from_outcome(&built, &out).map_err(e)?;
    let applied = m::apply_v2(&mut pd, &built, &out).map_err(e)?;
    let settled = m::settle_bell(&mut pd, b).map_err(e)?;
    let step = cq::step(&mut pd, b, &report, prm).map_err(e)?;
    m::finish_bell(&mut pd, b, applied.changed() || settled || step.roster_changed).map_err(e)?;
    let outcome = m::outcome_digest(&out).map_err(e)?;
    put(&mut pd, PV::LAST_DIGEST, &outcome)?;
    // The fate table of the present arrivals, the resolved flag and the
    // camp mask (the program's `resolve_core`).
    for k in 0..CI::POSITIONS {
        let o = CI::arrival(k);
        if ci.get(o + AR::PRESENT).copied() == Some(1) {
            put(&mut ci, o + AR::FATE, &[applied.base.fates[k]])?;
            put(
                &mut ci,
                o + AR::TROOPS_AFTER,
                &applied.base.troops_after[k].to_le_bytes(),
            )?;
        }
    }
    let flags = *ci.get(CI::FLAGS).ok_or("short inputs")?;
    put(&mut ci, CI::FLAGS, &[flags | CI::FLAG_RESOLVED])?;
    put(&mut ci, CI::CAMP_MASK, &applied.base.camp_mask.to_le_bytes())?;
    // The summary of the last resolve (§5.3; the resolver's 8 bytes are
    // the beneficiary's, left as before).
    let n_arr = *ci.get(CI::N_PRESENT).ok_or("short inputs")?;
    let o = PV::RESOLVE_SUMMARY;
    put(&mut pd, o + SU::BELL, &b.to_le_bytes())?;
    put(&mut pd, o + SU::ENGAGEMENTS, &out.engagements.to_le_bytes())?;
    put(&mut pd, o + SU::ARRIVALS, &[n_arr])?;
    put(&mut pd, o + SU::DESTROYED, &[applied.base.destroyed])?;
    put(&mut pd, o + SU::BOUNCED, &[applied.base.bounced])?;
    let factions: std::collections::BTreeSet<u8> = built
        .base
        .residents
        .iter()
        .map(|x| x.faction)
        .chain(built.base.arrivals.iter().map(|x| x.faction))
        .collect();
    let contested = factions.len() > 1 && !built.base.arrivals.is_empty();
    Ok(Replayed {
        input,
        outcome,
        engagements: out.engagements,
        fates: frontier_abi::log::pack_fates(&applied.base.fates),
        province: pd,
        inputs: ci,
        contested,
        step,
    })
}

fn mask_header(v: &mut [u8]) {
    if v.len() >= HD::H_SIZE {
        v[HD::EVENT_SEQ..HD::EVENT_HEAD + 32].fill(0);
    }
}

/// A Province with the bytes a resolve writes that are not the rules'
/// zeroed: the event chain's header fields and the summary's resolver.
pub fn mask_province(d: &[u8]) -> Vec<u8> {
    let mut v = d.to_vec();
    mask_header(&mut v);
    let o = PV::RESOLVE_SUMMARY + SU::RESOLVER;
    if let Some(x) = v.get_mut(o..o + 8) {
        x.fill(0);
    }
    v
}

/// ClashInputs with the keeper's fields zeroed: the event chain's header
/// fields, the resolver, the evidence and the resolve time.
pub fn mask_inputs(d: &[u8]) -> Vec<u8> {
    let mut v = d.to_vec();
    mask_header(&mut v);
    for (o, n) in [
        (CI::RESOLVER, 32),
        (CI::EV_SLOT, 8),
        (CI::EV_PRICE, 8),
        (CI::EV_LIMIT, 4),
        (CI::RESOLVED_TS, 4),
    ] {
        if let Some(x) = v.get_mut(o..o + n) {
            x.fill(0);
        }
    }
    v
}

/// First differing offset of two masked images.
pub fn first_diff(a: &[u8], b: &[u8]) -> usize {
    a.iter()
        .zip(b.iter())
        .position(|(x, y)| x != y)
        .unwrap_or(a.len().min(b.len()))
}
