//! V0 — what this verifier can judge at all (⑱, 2026-10-31; an independent
//! patch, not ⑪'s prototype). Every other check reads the records and the
//! accounts that instructions leave; an instruction the program ran that no
//! check models changes state no check looks at, and the report used to say
//! PASS anyway. So, for every **successful** transaction:
//!
//! - an instruction of the program with no data, or a tag that is not in
//!   ABI v2 (`frontier_abi::v2::tags::Ix`), is a FAIL (`UnknownInstruction`):
//!   the pinned program refuses it (`BadData`), so its success means
//!   another program ran;
//! - data shorter or longer than the ABI's range for its tag is a FAIL
//!   (`Undecodable`: the arguments the checks would read are not there);
//! - a tag the ABI names but this verifier does not model for the season's
//!   program is `Unverifiable` (`UnverifiedInstruction`), never a PASS:
//!   see [`supported`];
//! - a season whose `program_version` (CreateSeason's) this verifier does not know is
//!   `Unverifiable` (`UnknownProgramVersion`): the checks choose their
//!   rules by version, and a later version must not borrow S1's.
//!
//! - ⑪ r9: workstream 20's `nft-experimental` program
//!   ([`PROGRAM_VERSION_NFT_S1`], S1's rules plus the resident tags
//!   0xE0–0xE7) is a known version. In its seasons JoinResident (0xE1) is
//!   judged (V27, with ⑳'s V9 and facts); CreateResidentPolicy and
//!   ResidentAct decode but are `UnverifiedInstruction`. Elsewhere, and for
//!   every tag workstream 4 allocated to a workstream (see
//!   [`allocated_band`]) that a known program version does not run, the
//!   FAIL names the band: a known program refuses it. Under a program
//!   version this verifier does not know, an allocated tag is
//!   `UnverifiedInstruction` instead (that program may run it, e.g. ②'s
//!   Grant), never a PASS and not a forgery claim; likewise when the
//!   archive does not show the program version at all.
//!
//! Failed transactions changed nothing and are not judged here.

use frontier_abi::v2::ix::data_len_range;
use frontier_abi::v2::presets::PROGRAM_VERSION_S1;
use frontier_abi::v2::tags::Ix;

use super::Ctx;
use crate::codes::*;

const V: &str = "V0";

/// Program versions whose rules this verifier implements (M1 1–2, the
/// conquest program 3, S1 4).
pub const KNOWN_PROGRAM_VERSIONS: std::ops::RangeInclusive<u16> = 1..=PROGRAM_VERSION_S1;

/// Workstream 20's `nft-experimental` build (`permutation-frontier`
/// `PROGRAM_VERSION`; provisional, workstream 4 fixes the integrated value).
pub const PROGRAM_VERSION_NFT_S1: u16 = 0x8000 | PROGRAM_VERSION_S1;

/// Whether this verifier implements `pv`'s rules.
pub fn known_version(pv: u16) -> bool {
    KNOWN_PROGRAM_VERSIONS.contains(&pv) || pv == PROGRAM_VERSION_NFT_S1
}

/// The workstream a tag outside ABI v2 is allocated to (workstream 4's
/// `ABI-ALLOCATION-20261106`, provisional).
pub fn allocated_band(tag: u8) -> Option<&'static str> {
    Some(match tag {
        0xC1 => "workstream 8 (ExtendFrontier)",
        0xC2..=0xCC => "workstream 10 (lots)",
        0xD0..=0xD5 => "workstream 2 (Grant)",
        0xE0..=0xE7 => "workstream 20 (NFT residents)",
        0xE8..=0xED => "workstream 11 (extensions)",
        0xF0..=0xFD => "workstream 9 (capacity pools)",
        _ => return None,
    })
}

/// V0's judgement of a tag outside ABI v2 under program version `pv`:
/// `None` when a check models it (JoinResident in an NFT season whose S1
/// checks run: V27 runs only with `s1`), else the severity, code and detail.
/// `s1` is `Ctx::s1` (`conquest::s1_applies`, read from the final Season
/// account or the configured ruleset): when it is false, V27 does not run,
/// so a JoinResident is `Unverifiable`, never left unjudged (⑱, 2026-11-06).
pub fn judge_outside_v2(
    tag: u8,
    data: &[u8],
    pv: Option<u16>,
    s1: bool,
) -> Option<(crate::Severity, &'static str, String)> {
    use crate::Severity::{Fail, Unverifiable};
    use frontier_abi::resident_wire::{self as rw, Command};
    let nft = pv == Some(PROGRAM_VERSION_NFT_S1);
    if nft && rw::is_resident_tag(tag) {
        return match rw::decode(data) {
            None => Some((
                Fail,
                UNDECODABLE,
                format!("resident tag 0x{tag:02x} with {} bytes does not decode", data.len()),
            )),
            Some(Command::Join { .. }) if s1 => None,
            Some(Command::Join { .. }) => Some((
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                "JoinResident in a season whose S1 checks did not run (V27 did not judge it)".into(),
            )),
            Some(_) => Some((
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                format!("resident instruction 0x{tag:02x} succeeded, and no check of this verifier models it"),
            )),
        };
    }
    let Some(band) = allocated_band(tag) else {
        return Some((
            Fail,
            UNKNOWN_INSTRUCTION,
            format!("tag 0x{tag:02x}, not in ABI v2, succeeded"),
        ));
    };
    // Only a program version this verifier knows is evidence that the tag
    // was refused. Without CreateSeason in the archive (`None`: a history
    // that starts later) nothing says which program ran, so an allocated
    // tag is not a forgery claim (⑪ r9, with ⑲'s history rule).
    match pv {
        Some(v) if known_version(v) => Some((
            Fail,
            UNKNOWN_INSTRUCTION,
            format!("tag 0x{tag:02x} is allocated to {band}, and program version {v} does not run it, yet it succeeded"),
        )),
        Some(v) => Some((
            Unverifiable,
            UNVERIFIED_INSTRUCTION,
            format!("tag 0x{tag:02x} is allocated to {band}; program version {v} may run it, and no check of this verifier models it"),
        )),
        None => Some((
            Unverifiable,
            UNVERIFIED_INSTRUCTION,
            format!("tag 0x{tag:02x} is allocated to {band}; the archive does not show the Season's program version, which may run it"),
        )),
    }
}

/// Whether the checks model `ix` for a season of this kind (`v3`: the
/// conquest rules apply; `s1`: S1's). M1's instructions are modelled by
/// V1–V13 in every season; the conquest ones by V14–V22 (DeclareSiege,
/// SettleSiege, SettleCapture, FileOutpost, FoldMarch, RetireHost through
/// their records); S1's vault, caravan, structure and nation ones by
/// V23–V25; map growth's **ExtendFrontier** (0xC1) by V26 (its
/// preconditions from the states before it, its Frontier post-state and
/// its FRONTIER_EXTENDED record). Not modelled anywhere: **CloseMarch**
/// (0xA7, MarchState rent after the Season ended) and **FastForward**
/// (0xC0, a resting Province advanced in closed form: its CAMP/REST
/// records are chained, the transition itself is not replayed).
pub fn supported(ix: Ix, v3: bool, s1: bool) -> bool {
    use Ix::*;
    if ix.to_v1().is_some() {
        return true;
    }
    match ix {
        DeclareSiege | SettleSiege | SettleCapture | FileOutpost | FoldMarch | RetireHost => v3,
        BuildVault | SendCaravan | SettleCaravan | RaidCaravan | SeizeVault | CloseVault
        | DefaultRaid | BuildStructure | SeizeStructure | CloseStructure | FortGarrison
        | Propose | Vote | SettleProposal | RaidDomestic | ExtendFrontier => s1,
        _ => false,
    }
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let (v3, s1) = (cx.v3, cx.s1);
    // The version CreateSeason named (the Season account may be a Closed
    // tombstone by the end; V2 ties the two together).
    if let Some(pv) = cx.f.params.as_ref().map(|p| p.program_version) {
        if !known_version(pv) {
            cx.unverifiable(
                V,
                UNKNOWN_PROGRAM_VERSION,
                "Season",
                0,
                None,
                format!(
                    "program_version {pv} is not one this verifier implements ({KNOWN_PROGRAM_VERSIONS:?}, {PROGRAM_VERSION_NFT_S1:#06x})"
                ),
            );
        }
    }
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        for ix in &t.ixs {
            let Some(tag) = ix.tag() else {
                cx.fail(
                    V,
                    UNKNOWN_INSTRUCTION,
                    format!("tx#{i}"),
                    0,
                    Some(i),
                    format!(
                        "instruction {} of the program has no data (no tag) and succeeded",
                        ix.index
                    ),
                );
                continue;
            };
            let Some(known) = Ix::from_tag(tag) else {
                let pv = cx.f.params.as_ref().map(|p| p.program_version);
                if let Some((sev, code, d)) = judge_outside_v2(tag, &ix.data, pv, cx.s1) {
                    let d = format!("instruction {}: {d}", ix.index);
                    match sev {
                        crate::Severity::Fail => cx.fail(V, code, format!("tx#{i}"), 0, Some(i), d),
                        _ => cx.unverifiable(V, code, format!("tx#{i}"), 0, Some(i), d),
                    }
                }
                continue;
            };
            // An M1 season's instructions are ABI v1's (CreateSeason is
            // shorter there); a conquest or S1 season's are v2's.
            let (lo, hi) = match known.to_v1() {
                Some(v1) if !v3 => frontier_abi::ix::data_len_range(v1),
                _ => data_len_range(known),
            };
            if ix.data.len() < lo || ix.data.len() > hi {
                cx.fail(
                    V,
                    UNDECODABLE,
                    format!("tx#{i}"),
                    0,
                    Some(i),
                    format!(
                        "{} data is {} bytes; the ABI allows {lo}..={hi}",
                        known.name(),
                        ix.data.len()
                    ),
                );
                continue;
            }
            if !supported(known, v3, s1) {
                cx.unverifiable(V, UNVERIFIED_INSTRUCTION, format!("tx#{i}"), 0, Some(i), format!(
                    "{} (0x{tag:02x}) succeeded, and no check of this verifier models it for this season (v3 {v3}, s1 {s1})",
                    known.name()
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_abi_tag_has_a_coverage_answer() {
        let unmodelled: Vec<&str> = Ix::ALL
            .iter()
            .filter(|ix| !supported(**ix, true, true))
            .map(|ix| ix.name())
            .collect();
        assert_eq!(unmodelled, ["CloseMarch", "FastForward"]);
        // M1 seasons: only M1's instructions are modelled.
        assert!(supported(Ix::Depart, false, false));
        assert!(!supported(Ix::DeclareSiege, false, false));
        assert!(!supported(Ix::SendCaravan, true, false));
        assert!(supported(Ix::SendCaravan, true, true));
        // Map growth: ExtendFrontier is V26's, in an S1 season only.
        assert!(supported(Ix::ExtendFrontier, true, true));
        assert!(!supported(Ix::ExtendFrontier, true, false));
        assert!(!supported(Ix::ExtendFrontier, false, false));
    }
}
