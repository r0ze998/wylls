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
//! - ⑳'s resident instructions (0xE0–0xE7, `frontier_abi::resident_wire`)
//!   exist only in the `nft-experimental` build, whose Seasons carry
//!   [`PROGRAM_VERSION_RESIDENT_S1`]: there, JoinResident (0xE1) is modelled
//!   (V9 `resident_joined_findings` and `joins_without_their_record`, the
//!   facts' NFT Citizen, V0E's conditional kind 130), CreateResidentPolicy and
//!   ResidentAct are `Unverifiable`, and data that does not decode exactly is
//!   `Undecodable`. In any other Season a success with such a tag is a FAIL
//!   (`UnknownInstruction`), as before.
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

/// The `nft-experimental` S1 build (⑳, `permutation-frontier` `PROGRAM_VERSION`
/// under that feature): S1's rules plus the resident instructions. The value
/// is provisional (workstream 4's allocation, rev 5): the integrated program's
/// version is fixed at integration.
pub const PROGRAM_VERSION_RESIDENT_S1: u16 = 0x8000 | PROGRAM_VERSION_S1;

/// Whether this verifier implements the rules of `pv`.
pub fn known_program_version(pv: u16) -> bool {
    KNOWN_PROGRAM_VERSIONS.contains(&pv) || pv == PROGRAM_VERSION_RESIDENT_S1
}

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
    let pv = cx.f.params.as_ref().map(|p| p.program_version);
    let resident = pv == Some(PROGRAM_VERSION_RESIDENT_S1);
    if let Some(pv) = pv {
        if !known_program_version(pv) {
            cx.unverifiable(
                V,
                UNKNOWN_PROGRAM_VERSION,
                "Season",
                0,
                None,
                format!(
                    "program_version {pv} is not one this verifier implements ({KNOWN_PROGRAM_VERSIONS:?}, {PROGRAM_VERSION_RESIDENT_S1:#06x})"
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
            if frontier_abi::resident_wire::is_resident_tag(tag) {
                resident_instruction(cx, i, ix.index, tag, &ix.data, resident);
                continue;
            }
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

/// What V0 makes of an instruction in ⑳'s band (0xE0–0xE7).
#[derive(Debug, PartialEq, Eq)]
pub enum ResidentVerdict {
    /// Modelled by other checks (JoinResident: V9, the facts, V0E).
    Modelled,
    /// `Unverifiable` with this code and detail.
    Unverifiable(&'static str, String),
    /// A FAIL with this code and detail.
    Fail(&'static str, String),
}

/// See the module doc. `resident`: the Season is the nft-experimental build.
pub fn resident_verdict(index: usize, tag: u8, data: &[u8], resident: bool) -> ResidentVerdict {
    use frontier_abi::resident_wire::{decode, Command};
    if !resident {
        return ResidentVerdict::Fail(UNKNOWN_INSTRUCTION, format!(
            "instruction {index} has the resident tag 0x{tag:02x}, which only the nft-experimental build ({PROGRAM_VERSION_RESIDENT_S1:#06x}) runs, and succeeded"
        ));
    }
    match decode(data) {
        None => ResidentVerdict::Fail(UNDECODABLE, format!(
            "resident instruction 0x{tag:02x} with {} bytes of data does not decode (the wire format takes exact lengths)",
            data.len()
        )),
        Some(Command::Join { .. }) => ResidentVerdict::Modelled,
        Some(Command::CreatePolicy(_)) => ResidentVerdict::Unverifiable(
            UNVERIFIED_INSTRUCTION,
            "CreateResidentPolicy (0xe0) succeeded, and no check of this verifier models it".into(),
        ),
        Some(Command::Act { .. }) => ResidentVerdict::Unverifiable(
            UNVERIFIED_INSTRUCTION,
            "ResidentAct (0xe2) succeeded, and no check of this verifier models an NFT Citizen's wrapped instruction".into(),
        ),
    }
}

fn resident_instruction(
    cx: &mut Ctx,
    i: usize,
    index: usize,
    tag: u8,
    data: &[u8],
    resident: bool,
) {
    match resident_verdict(index, tag, data, resident) {
        ResidentVerdict::Modelled => {}
        ResidentVerdict::Unverifiable(code, why) => {
            cx.unverifiable(V, code, format!("tx#{i}"), 0, Some(i), why)
        }
        ResidentVerdict::Fail(code, why) => cx.fail(V, code, format!("tx#{i}"), 0, Some(i), why),
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

    /// ⑳'s resident band: literal bytes only (no key is generated, derived
    /// or signed).
    #[test]
    fn the_resident_band_is_judged_only_in_the_resident_build() {
        use frontier_abi::resident_wire::{CREATE_RESIDENT_POLICY, JOIN_RESIDENT, RESIDENT_ACT};
        assert!(known_program_version(PROGRAM_VERSION_S1));
        assert!(known_program_version(PROGRAM_VERSION_RESIDENT_S1));
        assert!(!known_program_version(0x8000));
        assert!(!known_program_version(0x8000 | 3));
        let join = [JOIN_RESIDENT, 3, 0, 0, 0, 4];
        // The resident build: a well-formed JoinResident is modelled.
        assert_eq!(
            resident_verdict(0, JOIN_RESIDENT, &join, true),
            ResidentVerdict::Modelled
        );
        // Any other Season: the tag is unknown there (another program ran).
        assert!(matches!(
            resident_verdict(0, JOIN_RESIDENT, &join, false),
            ResidentVerdict::Fail(UNKNOWN_INSTRUCTION, _)
        ));
        // Short, long, or an unused tag of the band: undecodable.
        for bad in [
            &join[..5],
            &[JOIN_RESIDENT, 3, 0, 0, 0, 4, 0][..],
            &[0xE3][..],
            &[JOIN_RESIDENT][..],
        ] {
            assert!(
                matches!(
                    resident_verdict(0, bad[0], bad, true),
                    ResidentVerdict::Fail(UNDECODABLE, _)
                ),
                "{bad:?}"
            );
        }
        // The policy and an NFT Citizen's act: never a PASS.
        let mut policy = vec![CREATE_RESIDENT_POLICY];
        policy.extend_from_slice(&[1u8; 128]);
        assert!(matches!(
            resident_verdict(0, CREATE_RESIDENT_POLICY, &policy, true),
            ResidentVerdict::Unverifiable(UNVERIFIED_INSTRUCTION, _)
        ));
        let act = [RESIDENT_ACT, 0, 0, 0, 0, Ix::SetVigil.tag(), 0x58, 0x02];
        assert!(matches!(
            resident_verdict(0, RESIDENT_ACT, &act, true),
            ResidentVerdict::Unverifiable(UNVERIFIED_INSTRUCTION, _)
        ));
        // An act wrapping a resident command, or nothing: undecodable.
        assert!(matches!(
            resident_verdict(
                0,
                RESIDENT_ACT,
                &[RESIDENT_ACT, 0, 0, 0, 0, JOIN_RESIDENT],
                true
            ),
            ResidentVerdict::Fail(UNDECODABLE, _)
        ));
        assert!(matches!(
            resident_verdict(0, RESIDENT_ACT, &[RESIDENT_ACT, 0, 0, 0, 0], true),
            ResidentVerdict::Fail(UNDECODABLE, _)
        ));
    }
}
