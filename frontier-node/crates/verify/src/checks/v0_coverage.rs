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

/// Whether the checks model `ix` for a season of this kind (`v3`: the
/// conquest rules apply; `s1`: S1's). M1's instructions are modelled by
/// V1–V13 in every season; the conquest ones by V14–V22 (DeclareSiege,
/// SettleSiege, SettleCapture, FileOutpost, FoldMarch, RetireHost through
/// their records); S1's vault, caravan, structure and nation ones by
/// V23–V25. Not modelled anywhere: **CloseMarch** (0xA7, MarchState rent
/// after the Season ended) and **FastForward** (0xC0, a resting Province
/// advanced in closed form: its CAMP/REST records are chained, the
/// transition itself is not replayed).
pub fn supported(ix: Ix, v3: bool, s1: bool) -> bool {
    use Ix::*;
    if ix.to_v1().is_some() {
        return true;
    }
    match ix {
        DeclareSiege | SettleSiege | SettleCapture | FileOutpost | FoldMarch | RetireHost => v3,
        BuildVault | SendCaravan | SettleCaravan | RaidCaravan | SeizeVault | CloseVault
        | DefaultRaid | BuildStructure | SeizeStructure | CloseStructure | FortGarrison
        | Propose | Vote | SettleProposal | RaidDomestic => s1,
        _ => false,
    }
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let (v3, s1) = (cx.v3, cx.s1);
    // The version CreateSeason named (the Season account may be a Closed
    // tombstone by the end; V2 ties the two together).
    if let Some(pv) = cx.f.params.as_ref().map(|p| p.program_version) {
        if !KNOWN_PROGRAM_VERSIONS.contains(&pv) {
            cx.unverifiable(
                V,
                UNKNOWN_PROGRAM_VERSION,
                "Season",
                0,
                None,
                format!(
                    "program_version {pv} is not one this verifier implements ({KNOWN_PROGRAM_VERSIONS:?})"
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
                cx.fail(
                    V,
                    UNKNOWN_INSTRUCTION,
                    format!("tx#{i}"),
                    0,
                    Some(i),
                    format!(
                        "instruction {} has tag 0x{tag:02x}, not in ABI v2, and succeeded",
                        ix.index
                    ),
                );
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
    }
}
