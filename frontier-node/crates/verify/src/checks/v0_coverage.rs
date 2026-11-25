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
//!   judged (V27, with ⑳'s V9 and facts), and so is a ResidentAct whose inner
//!   instruction the act runs (r14: V28 and the inner instruction's own check,
//!   with S1's checks on); CreateResidentPolicy decodes but is
//!   `UnverifiedInstruction`. Elsewhere, and for
//!   every tag workstream 4 allocated to a workstream (see
//!   [`allocated_band`]) that a known program version does not run, the
//!   FAIL names the band: a known program refuses it. Under a program
//!   version this verifier does not know (or none the archive shows), any
//!   tag outside ABI v2, allocated or not, is `UnverifiedInstruction` instead
//!   (r13) (that program may run it, e.g. ②'s
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

/// The PLAYABLE lane (Q16-1 = A, 2026-11-18): S1 (4) | wide 0x4000 | the
/// expedition dispatch revision 0x0800
/// (`frontier_abi::world_index::expedition_dispatch_ix::PROGRAM_VERSION`),
/// which the devnet build `devnet-playable-sbf` (conquest-dispatch +
/// land-preview) and the localnet expedition / conquest / land lanes run.
/// A known version only in the `playable-lane` build: there its ABI v2
/// instructions are judged by the S1 checks (since 2026-11-19 on a recorded
/// sealed march too: Muster, Depart, Reveal, GatherClash,
/// ResolveFromInputs, SkipQuiet, SettleDeparture, SettleTransit,
/// `tests/playable_march.rs`; the program runs S1's
/// handlers, which differ only where a wide marker or bridge is present,
/// and only a wide instruction writes one), its land preview instructions
/// by VL, the wide land opening (WideSetRules, WideRequestRingSeed,
/// WideConsumeRingSeed, WideOpenProvince) and the wide claims
/// (WideClaimSite in its wallet form, WideSettleTicket, WideFinalize), the
/// season-end WideClose of a ticket record, a holding and a province, and
/// the wide economy and garrison (wallet forms), WideMuster (wallet form)
/// and WideResolve (the bell, the wide keep capture) and player territory
/// (WideClaimTile, WideTerritorySettle / Decay / Conquer, #209;
/// verifier-territory) by VWL, the expedition
/// dispatch envelope (`[tag, 0xff, 2, kind]`, kinds 0–18: the expedition
/// wrapper and the Free City conquest, 2026-11-19) by VX (re-executed by the
/// pinned program, `vx_reexec`), the wide-native host lifecycle's
/// WideDissolve, WideReturn, WideCloseRoster and WideDisbandStranded by VX
/// too (verifier-coverage), a successful WideResidentAct is a FAIL (the
/// lane's program refuses every one), and since verifier-coverage-2 every
/// other decodable wide command is VX's too (WideClaimDefence, WideClose
/// what 2–5, the raw WideDepart / WideGather / WideSettleDeparture /
/// WideSettleTransit / WideReveal and the raw expedition and conquest
/// commands: `vx_reexec::native_of`), and V0 FAILs (`GateClosed`) the ones
/// the pinned devnet-playable binary can never run ([`gate_closed`],
/// [`GATE_CLOSED_BINARIES`]). Only data neither the wide codec nor the
/// dispatch envelope decodes stays UNVERIFIABLE (`WideUnmodelled`): see
/// [`judge_outside_v2`].
pub const PROGRAM_VERSION_PLAYABLE: u16 = 0x4804;

#[cfg(feature = "playable-lane")]
const _: () = assert!(
    PROGRAM_VERSION_PLAYABLE == frontier_abi::world_index::expedition_dispatch_ix::PROGRAM_VERSION
);

/// sha256 of the program binaries whose closed gates verifier-coverage-2
/// checked IN THE BINARY (not only by source flag), for [`gate_closed`]:
/// the devnet-playable build `da3dc1aa…b9741` (`devnet-playable-sbf`,
/// committed as `fixtures/verify/devnet-playable-da3dc1aa.so.gz`). Its
/// markers are `PSF_DEVNET_PLAYABLE_BUILD` and no `PSF_LOCALNET_*`; the
/// recorder (`tests/playable_expedition.rs`, `Sc::Closes` / `Sc::WideRaw`)
/// sends every gated raw command to it and archives the refusal: code 99
/// (NotImplemented) for the EXPEDITION / CONQUEST_LIFECYCLE / Depart-debit
/// gates (the raw WideDepart of a standing wide host that passes every
/// other check: the same transaction departs on the local land build with
/// `localnet-wide-depart`), code 2 (BadAccount) for the v1-slot readers
/// over the expedition's v2 slot. A rebuilt binary (any source change
/// alters the hash) is NOT in this list until its gates are re-checked:
/// its raw commands then stay with VX's re-execution alone.
pub const GATE_CLOSED_BINARIES: &[[u8; 32]] = &[[
    0xda, 0x3d, 0xc1, 0xaa, 0xe6, 0x6d, 0x26, 0x2b, 0xa7, 0x93, 0x21, 0xca, 0x90, 0x31, 0xb4, 0xb3,
    0x51, 0x0a, 0xcc, 0x13, 0xb6, 0x90, 0x15, 0x4f, 0x02, 0xb2, 0xe3, 0x04, 0xb3, 0x8b, 0x97, 0x41,
]];

/// Whether the season's program is pinned to a binary of
/// [`GATE_CLOSED_BINARIES`]: the configured `program_hash` is one, and every
/// hash the archive observed on chain (if any) is that one (a chain that
/// served another binary is V2's / CQ2's FAIL, never this rule's).
pub fn pinned_gate_closed(pinned: Option<[u8; 32]>, observed: &[(u64, [u8; 32])]) -> bool {
    pinned
        .is_some_and(|h| GATE_CLOSED_BINARIES.contains(&h) && observed.iter().all(|(_, o)| *o == h))
}

/// The reason a binary of [`GATE_CLOSED_BINARIES`] refuses every instance
/// of this wide command, whatever the state (verifier-coverage-2), or
/// `None` when it may run:
///
/// * the raw expedition commands (ExpeditionDepart, ExpeditionSettleOrigin,
///   ExpeditionReveal, ExpeditionGather outside the dispatch envelope):
///   `proc::wide::dispatch` refuses them with `EXPEDITION_ENABLED` (a
///   `const false`) before reading any account;
/// * the raw conquest commands (DeclareSiege, SettleCapture,
///   ResolveWithConquest, SettleSiege, CloseConquest, CloseCaptureEscrow):
///   `require_conquest_lifecycle` (`CONQUEST_LIFECYCLE_ENABLED`, `const
///   false`) first; the dispatch kinds 12–18 reach the same handlers
///   through the envelope's `*_inner` entries, which VX judges;
/// * WideDepart: `DEPART_DEBIT_ENABLED` (true only under `cfg(test)` with
///   `native-crypto-tests` or with `localnet-wide-depart`) refuses after
///   every check and before the first effect: no success path exists;
/// * WideReveal, WideSettleDeparture, WideSettleTransit and WideClose(5):
///   each reads the 288-byte v1 wide transit record (`WideTransit::
///   from_bytes`, exact length) and refuses without one; the only creator
///   of such a record is WideDepart's effect (`proc::wide` `depart_as`,
///   behind the debit gate). The expedition's transit is the 336-byte
///   `OwnedBridgeTransit`;
/// * WideClaimDefence and WideClose(2): each reads the v1 arrival slot
///   (`WideArrivalSlot::read`, family version 2), which refuses the
///   expedition's v2 slot (`ExpeditionArrivalSlot`, version 3: "the
///   original v2 bytes never pass v1 read"); the only creator of a v1 slot
///   is the raw WideReveal (above). The program's v2-slot ClaimDefence
///   (`claim_expedition_defence`) has no dispatcher.
///
/// NOT here (they can run on that binary; VX re-executes them): WideGather
/// (over a bell with no ArrivalDay bit it creates a no-arrival ClashInputs
/// and succeeds: recorded in `Sc::WideRaw`), WideClose(3) and WideClose(4)
/// (the expedition's ArrivalDay and ClashInputs are the shared wide
/// layouts: recorded in `Sc::Closes`).
#[cfg(feature = "playable-lane")]
pub fn gate_closed(data: &[u8]) -> Option<&'static str> {
    use frontier_abi::world_index::wide_ix::{self as wix, WideCommand as C};
    Some(match wix::WideCommand::decode(data).ok()? {
        C::ExpeditionDepart(_)
        | C::ExpeditionSettleOrigin(_)
        | C::ExpeditionReveal(_)
        | C::ExpeditionGather(_) => {
            "its raw form is refused by EXPEDITION_ENABLED (compiled false) before any account is read"
        }
        C::DeclareSiege(_)
        | C::SettleCapture(_)
        | C::ResolveWithConquest(_)
        | C::SettleSiege(_)
        | C::CloseConquest(_)
        | C::CloseCaptureEscrow(_) => {
            "its raw form is refused by CONQUEST_LIFECYCLE_ENABLED (compiled false) before any account is read"
        }
        C::Depart(_) => {
            "WideDepart's debit gate (DEPART_DEBIT_ENABLED, off in this build) refuses it after every check, before any effect"
        }
        C::Reveal(_) | C::SettleDeparture(_) | C::SettleTransit(_) => {
            "it needs a v1 wide transit record, which only WideDepart (gated off in this build) creates"
        }
        C::Close(x) if x.what == wix::CLOSE_WHAT_TRANSIT => {
            "it needs a v1 wide transit record, which only WideDepart (gated off in this build) creates"
        }
        C::ClaimDefence(_) => {
            "it reads only v1 arrival slots, which only the raw WideReveal (itself unreachable in this build) creates; the expedition's v2 slots are refused"
        }
        C::Close(x) if x.what == wix::CLOSE_WHAT_SLOT => {
            "it reads only v1 arrival slots, which only the raw WideReveal (itself unreachable in this build) creates; the expedition's v2 slots are refused"
        }
        _ => return None,
    })
}

/// Whether `pv` is the playable lane and this build judges it.
pub fn playable(pv: Option<u16>) -> bool {
    cfg!(feature = "playable-lane") && pv == Some(PROGRAM_VERSION_PLAYABLE)
}

/// Whether a wide instruction (0xD6–0xDF, 0xEE) succeeded anywhere in the
/// archive: only one writes the wide build's own accounts and markers, so
/// without one the playable program ran S1's handlers exactly (VR, VL).
///
/// The wide land commands VWL re-judges (`vwl_wide_land::judged`) write
/// only the records VR knows, so they do not count.
pub fn wide_ran(w: &crate::world::World) -> bool {
    w.txs
        .iter()
        .filter(|t| t.ok)
        .flat_map(|t| t.ixs.iter())
        .any(|ix| {
            ix.tag().is_some_and(is_wide_tag) && !vwl_judged(&ix.data) && !vx_judged(&ix.data)
        })
}

/// Whether VX re-executes this wide instruction's transaction (the
/// expedition dispatch envelope, kinds 0–18; playable-lane build only).
/// The accounts such a transaction writes are VX's to judge, byte for
/// byte, so they do not count for [`wide_ran`] either (VR leaves them to
/// VX: `vr_rights::unknown_account`).
pub fn vx_judged(data: &[u8]) -> bool {
    #[cfg(feature = "playable-lane")]
    {
        super::vx_reexec::judged(data)
    }
    #[cfg(not(feature = "playable-lane"))]
    {
        let _ = data;
        false
    }
}

/// Whether VX re-executes transaction `t` (a successful one with an
/// expedition dispatch envelope instruction) in a playable-lane season.
pub fn vx_tx(t: &crate::world::Tx, pv: Option<u16>) -> bool {
    playable(pv)
        && t.ok
        && t.ixs
            .iter()
            .any(|ix| ix.tag().is_some_and(is_wide_tag) && vx_judged(&ix.data))
}

/// Whether VWL re-judges transaction `t` as a whole: every program
/// instruction a wide one VWL names (one instruction, or — player
/// territory, verifier-territory — the keeper's settle + decay / settle +
/// conquer, which VWL re-runs in order; any other mix is VWL's
/// `MissingData`, never a PASS). Its writes are VWL's to judge.
pub fn vwl_tx(t: &crate::world::Tx) -> bool {
    !t.ixs.is_empty()
        && t.ixs
            .iter()
            .all(|ix| ix.tag().is_some_and(is_wide_tag) && vwl_judged(&ix.data))
}

/// Whether VWL re-judges this wide instruction (playable-lane build only).
pub fn vwl_judged(data: &[u8]) -> bool {
    #[cfg(feature = "playable-lane")]
    {
        super::vwl_wide_land::judged(data).is_some()
    }
    #[cfg(not(feature = "playable-lane"))]
    {
        let _ = data;
        false
    }
}

/// The ②+⑨+⑩ coexist builds (#113, workstream 4's allocation rev 8,
/// provisional; `frontier_abi::feature_registry`): custody's base 5 (S1
/// with custody, `RULESET_HASH_V4`, rules version 13) with the rights bit
/// 0x2000 and the capacity bit 0x1000 — on S1 alone (`COEXIST_S1_VERSION`,
/// host builds) and on the playable lane (`COEXIST_LANE_VERSION`, wide
/// 0x4000 | expedition 0x0800; `localnet-coexist-sbf`, LOCAL only).
pub const PROGRAM_VERSION_COEXIST_S1: u16 = 0x3005;
pub const PROGRAM_VERSION_COEXIST_LANE: u16 = 0x7805;

/// Whether VR models the Grant instructions of a season of version `pv`
/// (rights-play, 2026-11-20; D-feature-coexist-4): exactly the
/// `rights-experimental` build alone (`PROGRAM_VERSION_RIGHTS_S1`, base 4)
/// and the two coexist versions (base 5). Their Grant handlers are the
/// same code (`proc/rights.rs`), and VR judges the Grant's records,
/// account and station Vault, none of which custody or capacity changes.
/// The coexist versions stay UNKNOWN to [`known_version`]: their ⑨
/// capacity tags (0xF0–0xFD, no check), ⑩ custody (V26: never better than
/// UNVERIFIABLE) and, on the lane, the wide tags (`WideUnmodelled`) are
/// never a PASS, and a coexist season's verdict is at best UNVERIFIABLE
/// (`UnknownProgramVersion`). Any other combination of the rights bit
/// (0xA004, 0x6004, 0x7804, …) stays UNVERIFIABLE, never left to VR (r7).
pub fn grants_modelled(pv: Option<u16>) -> bool {
    pv == Some(frontier_abi::v2::rights::PROGRAM_VERSION_RIGHTS_S1)
        || pv == Some(PROGRAM_VERSION_COEXIST_S1)
        || pv == Some(PROGRAM_VERSION_COEXIST_LANE)
}

/// Whether this verifier implements `pv`'s rules.
pub fn known_version(pv: u16) -> bool {
    KNOWN_PROGRAM_VERSIONS.contains(&pv)
        || pv == PROGRAM_VERSION_NFT_S1
        || pv == frontier_abi::v2::rights::PROGRAM_VERSION_RIGHTS_S1
        || playable(Some(pv))
}

/// The wide command `data` names, as the playable program's dispatch reads
/// it (`proc::wide::dispatch`: the tag's own codec first, then the
/// expedition dispatch envelope `[tag, 0xff, 2, kind]`); `None` when
/// neither decodes.
#[cfg(feature = "playable-lane")]
pub fn wide_command(data: &[u8]) -> Option<String> {
    use frontier_abi::world_index::{expedition_dispatch_ix as dx, wide_ix as wix};
    if let Ok(c) = wix::WideCommand::decode(data) {
        return Some(c.name().to_string());
    }
    dx::Command::decode(data)
        .ok()
        .map(|c| format!("expedition dispatch {:?}", c.kind()))
}

/// The version bit of the experimental wide-world build
/// (`frontier_abi::world_index::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT`,
/// behind `world-index-experimental`; provisional, not an allocation). Its
/// seasons are not a known version (no wide rule is modelled), so they are
/// never a PASS (`UnknownProgramVersion`).
pub const WIDE_EXPERIMENTAL_VERSION_BIT: u16 = 0x4000;

/// The wide build's provisional tags: the draft band `0xD6..=0xDF`
/// (`wide_ix::DRAFT_TAG_FIRST..=DRAFT_TAG_LAST`) and WideReveal `0xEE`
/// (`wide_ix::TAG_REVEAL`). Not an allocation.
pub fn is_wide_tag(tag: u8) -> bool {
    (0xD6..=0xDF).contains(&tag) || tag == 0xEE
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
            // ⑳'s ResidentAct (r14): the world lists its inner player
            // instruction as an instruction of its own (`world::unwrap_resident`),
            // which V0 and the check that models it judge like a wallet
            // Citizen's; V28 judges the rest (holder, owner-only acts, proof
            // accounts, the join, the Citizen after). So it is left to them
            // only where V28 runs (`s1`) and the act can run the inner tag.
            Some(Command::Act { inner, .. }) if s1 && rw::act_runs(inner[0]) => None,
            Some(Command::Act { .. }) => Some((
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                format!("ResidentAct 0x{tag:02x} whose inner instruction the act does not run, or in a season whose S1 checks (V28) did not run"),
            )),
            Some(_) => Some((
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                format!("resident instruction 0x{tag:02x} succeeded, and no check of this verifier models it"),
            )),
        };
    }
    // Workstream 02-rights (proposal): a Grant instruction of the
    // `rights-experimental` build alone (`PROGRAM_VERSION_RIGHTS_S1`, the S1
    // rules with the provisional rights bit; an exact match, as the NFT
    // build's above) is VR's to judge in a season whose S1 checks run; VR
    // does not run otherwise, so it is `Unverifiable`, never left unjudged.
    // A combined experimental build (the rights bit beside the wide or the
    // NFT bit) runs Grants under rules this verifier does not implement, so
    // its Grant tags fall to the band rule below: `Unverifiable` under that
    // unknown version, never left to VR (r7). Under a known version that
    // does not run Grants (M1, production S1) the band rule is `Fail`.
    // rights-play (2026-11-20): and the two coexist versions' Grant tags
    // ([`grants_modelled`]), the same handlers on custody's base 5.
    if frontier_abi::v2::rights::is_rights_tag(tag) && grants_modelled(pv) {
        return if s1 {
            None
        } else {
            Some((
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                format!("Grant instruction 0x{tag:02x} in a season whose S1 checks did not run (VR did not judge it)"),
            ))
        };
    }
    // The wide build's own tags, in its own seasons: left to VW (r16), which
    // judges the wide event chains and nothing of the wide rules, so they
    // stay UNVERIFIABLE (`WideUnmodelled`), never a PASS (outside the
    // playable lane; in it, VWL, VX and `gate_closed` judge them).
    // Q16-1 continued: what `vwl_wide_land::judged` names is VWL's (it
    // re-runs those commands from the states before them).
    #[cfg(feature = "playable-lane")]
    if is_wide_tag(tag) && playable(pv) && vwl_judged(data) {
        return None;
    }
    // verifier-coverage (2026-11-20): a WideResidentAct (0xDD) runs its
    // inner command only for an NFT resident's Citizen
    // (`proc::wide::resident_act` → `player_start_as` / the conquest's
    // `declare_siege_resident` → `resident::start` → `resident::check`:
    // the Citizen's `resident_citizen::resident_asset` must be the asset).
    // The playable lane's program is never built with `nft-experimental`
    // (`permutation-frontier` lib.rs refuses it beside `devnet-playable-sbf`,
    // and the lane's version 0x4804 is the plain one; the NFT lane is
    // 0xC804), and only `nft-experimental`'s JoinResident
    // (`resident::join`) marks a Citizen as a resident; the wallet Join
    // writes a non-zero WALLET, which `resident_asset` refuses. So no
    // Citizen of a playable-lane season is a resident, and the pinned
    // program refuses every WideResidentAct: a successful one is a FAIL
    // (another program ran), as for any tag a known version refuses.
    #[cfg(feature = "playable-lane")]
    if tag == frontier_abi::world_index::wide_ix::TAG_RESIDENT_ACT && playable(pv) {
        return Some((
            Fail,
            UNKNOWN_INSTRUCTION,
            format!("WideResidentAct (0x{tag:02x}) succeeded in a playable-lane season (program version {PROGRAM_VERSION_PLAYABLE:#06x}), whose program refuses every one: it runs only for an NFT resident's Citizen, and no Citizen of this lane can be one (only the nft-experimental build's JoinResident marks one)"),
        ));
    }
    // Q16-1 = A (prize gate): the expedition dispatch envelope (the
    // expedition wrapper and the Free City conquest kinds) is VX's: its
    // whole transaction is re-executed by the pinned program.
    #[cfg(feature = "playable-lane")]
    if is_wide_tag(tag) && playable(pv) && vx_judged(data) {
        return None;
    }
    #[cfg(feature = "playable-lane")]
    if is_wide_tag(tag) && playable(pv) {
        // Q16-1: no check of this verifier re-judges a wide command yet (the
        // opt-in replays of `wide_economy` & co. take caller-supplied
        // snapshots and no season verdict), so each stays UNVERIFIABLE and
        // says which command it was.
        return Some(match wide_command(data) {
            Some(name) => (
                Unverifiable,
                WIDE_UNMODELLED,
                format!("wide instruction 0x{tag:02x} ({name}) in a playable-lane season: no check of this verifier re-judges it"),
            ),
            None => (
                Unverifiable,
                WIDE_UNMODELLED,
                format!("wide instruction 0x{tag:02x} of {} bytes that neither the wide codec nor the dispatch envelope decodes, yet it succeeded in a playable-lane season", data.len()),
            ),
        });
    }
    // The land preview's FoldLand / ClaimLandYield (0xCD / 0xCE) in a
    // playable-lane season: VL's (it re-runs both from the states before).
    #[cfg(feature = "playable-lane")]
    if frontier_abi::land_preview::is_land_tag(tag) && playable(pv) {
        return None;
    }
    if is_wide_tag(tag) && pv.is_some_and(|v| v & WIDE_EXPERIMENTAL_VERSION_BIT != 0) {
        return Some((
            Unverifiable,
            WIDE_UNMODELLED,
            format!("wide instruction 0x{tag:02x} in a wide-world season: left to VW (its event chains); no wide rule is modelled"),
        ));
    }
    let Some(band) = allocated_band(tag) else {
        // Only a program version this verifier knows refuses the tag: that is
        // the evidence for a FAIL. Under another version (an experimental
        // build such as the wide-world draft band 0xD6–0xDA, which carries
        // its own version bit) or none in the archive, nothing says which
        // program ran, so the tag is not a forgery claim (⑪ r13).
        return Some(match pv {
            Some(v) if known_version(v) => (
                Fail,
                UNKNOWN_INSTRUCTION,
                format!("tag 0x{tag:02x}, not in ABI v2, succeeded under program version {v}, which refuses it"),
            ),
            _ => (
                Unverifiable,
                UNVERIFIED_INSTRUCTION,
                format!("tag 0x{tag:02x}, not in ABI v2, succeeded under a program version this verifier does not know, or one the archive does not show"),
            ),
        });
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
                    "program_version {pv} ({pv:#06x}) is not one this verifier implements ({KNOWN_PROGRAM_VERSIONS:?}, {PROGRAM_VERSION_NFT_S1:#06x}, {:#06x}{})", frontier_abi::v2::rights::PROGRAM_VERSION_RIGHTS_S1,
                    if cfg!(feature = "playable-lane") {
                        format!(", {PROGRAM_VERSION_PLAYABLE:#06x}")
                    } else if pv == PROGRAM_VERSION_PLAYABLE {
                        "; the playable lane is judged only by a build with the `playable-lane` feature".into()
                    } else {
                        String::new()
                    },
                ) + if pv == PROGRAM_VERSION_COEXIST_S1 || pv == PROGRAM_VERSION_COEXIST_LANE {
                    "; a ②+⑨+⑩ coexist build: VR judges its Grants, but its capacity (⑨), custody (⑩, V26) and wide rules are not modelled"
                } else {
                    ""
                },
            );
        }
    }
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        for ix in &t.ixs {
            let Some(tag) = ix.tag() else {
                // A known program refuses an empty instruction; under another
                // version, or none the archive shows, it is not a forgery
                // claim (r13, as for a tag outside ABI v2).
                let pv = cx.f.params.as_ref().map(|p| p.program_version);
                let d = format!(
                    "instruction {} of the program has no data (no tag) and succeeded",
                    ix.index
                );
                if pv.is_some_and(known_version) {
                    cx.fail(V, UNKNOWN_INSTRUCTION, format!("tx#{i}"), 0, Some(i), d);
                } else {
                    cx.unverifiable(V, UNVERIFIED_INSTRUCTION, format!("tx#{i}"), 0, Some(i), d);
                }
                continue;
            };
            let Some(known) = Ix::from_tag(tag) else {
                let pv = cx.f.params.as_ref().map(|p| p.program_version);
                // verifier-coverage-2: a wide command the PINNED binary can
                // never run is known-bad, keyed on that binary's hash.
                #[cfg(feature = "playable-lane")]
                if is_wide_tag(tag)
                    && playable(pv)
                    && pinned_gate_closed(cx.cfg.program_hash, &cx.input.program_hashes)
                {
                    if let Some(why) = gate_closed(&ix.data) {
                        let name = wide_command(&ix.data).unwrap_or_default();
                        cx.fail(
                            V,
                            GATE_CLOSED,
                            format!("tx#{i}"),
                            0,
                            Some(i),
                            format!(
                                "instruction {}: {name} (0x{tag:02x}) succeeded, but the pinned program binary ({}) refuses every one: {why}",
                                ix.index,
                                hex::encode(cx.cfg.program_hash.unwrap_or_default())
                            ),
                        );
                        continue;
                    }
                }
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

    /// verifier-coverage-2: exactly the commands the devnet-playable binary
    /// can never run are `gate_closed`; the ones it runs are not, and every
    /// decodable wide command is judged by VWL, VX or V0 (none is left
    /// `WideUnmodelled`).
    #[cfg(feature = "playable-lane")]
    #[test]
    fn gate_closed_names_exactly_the_never_running_commands() {
        use frontier_abi::world_index::wide_ix as wix;
        let closed = |d: &[u8]| gate_closed(d).is_some();
        let close = |what| wix::Close { what }.to_bytes().to_vec();
        for what in [wix::CLOSE_WHAT_SLOT, wix::CLOSE_WHAT_TRANSIT] {
            assert!(closed(&close(what)), "WideClose({what})");
        }
        for what in [
            wix::CLOSE_WHAT_TICKET,
            wix::CLOSE_WHAT_HOLDING,
            wix::CLOSE_WHAT_DAY,
            wix::CLOSE_WHAT_INPUTS,
            wix::CLOSE_WHAT_PROVINCE,
        ] {
            assert!(!closed(&close(what)), "WideClose({what}) runs");
        }
        let gather = wix::Gather {
            bell: 9,
            start: 0,
            n: 24,
        }
        .to_bytes()
        .to_vec();
        assert!(!closed(&gather), "WideGather runs (a no-arrival bell)");
        let claim = wix::ClaimDefence { day: 0, n: 1 }
            .to_bytes()
            .unwrap()
            .to_vec();
        assert!(closed(&claim));
        assert!(closed(
            &wix::ExpeditionSettleOrigin { transit_slot: 0 }.to_bytes()
        ));
        assert!(closed(&wix::CloseCaptureEscrow.to_bytes()));
        assert!(closed(&wix::CloseConquest { p: 1, q: 2 }.to_bytes()));
        assert!(!closed(&wix::CloseRoster.to_bytes()));
        assert!(!closed(&wix::Return.to_bytes()));
        // every one of these is VX's or VWL's, never WideUnmodelled
        for d in [
            close(wix::CLOSE_WHAT_SLOT),
            close(wix::CLOSE_WHAT_DAY),
            close(wix::CLOSE_WHAT_INPUTS),
            close(wix::CLOSE_WHAT_TRANSIT),
            gather,
            claim,
        ] {
            assert!(vx_judged(&d) && !vwl_judged(&d), "{d:?}");
        }
        for what in [
            wix::CLOSE_WHAT_TICKET,
            wix::CLOSE_WHAT_HOLDING,
            wix::CLOSE_WHAT_PROVINCE,
        ] {
            assert!(vwl_judged(&close(what)) && !vx_judged(&close(what)));
        }
        let pv = Some(PROGRAM_VERSION_PLAYABLE);
        assert!(judge_outside_v2(0xDE, &close(wix::CLOSE_WHAT_DAY), pv, true).is_none());
        // the pinned-binary key
        let devnet = GATE_CLOSED_BINARIES[0];
        assert_eq!(
            hex::encode(devnet),
            "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741"
        );
        assert!(pinned_gate_closed(Some(devnet), &[(0, devnet)]));
        assert!(!pinned_gate_closed(Some([1; 32]), &[]));
        assert!(!pinned_gate_closed(
            Some(devnet),
            &[(0, devnet), (9, [1; 32])]
        ));
    }

    /// verifier-coverage: in the playable lane a successful WideResidentAct
    /// is a FAIL (its program refuses every one: no Citizen of the lane is
    /// an NFT resident); the four wide-native host-lifecycle commands are
    /// VX's (re-executed), not `WideUnmodelled`.
    #[cfg(feature = "playable-lane")]
    #[test]
    fn wide_native_ops_in_the_playable_lane() {
        use crate::Severity::Fail;
        use frontier_abi::world_index::wide_ix as wix;
        let pv = Some(PROGRAM_VERSION_PLAYABLE);
        let muster = wix::Muster {
            unit: 0,
            troops: 10,
            tile: 3,
        }
        .to_bytes();
        let mut act = vec![0u8; 5 + muster.len()];
        wix::ResidentAct {
            generation: 0,
            inner: &muster,
        }
        .encode_into(&mut act)
        .unwrap();
        assert!(wix::WideCommand::decode(&act).is_ok());
        for s1 in [true, false] {
            let j = judge_outside_v2(act[0], &act, pv, s1).expect("judged");
            assert_eq!((j.0, j.1), (Fail, UNKNOWN_INSTRUCTION), "{j:?}");
        }
        let host = [1u8; frontier_abi::world_index::key::HOST_REF_LEN];
        for d in [
            wix::Dissolve { host }.to_bytes().to_vec(),
            wix::Return.to_bytes().to_vec(),
            wix::CloseRoster.to_bytes().to_vec(),
            wix::DisbandStranded { entry: 3 }.to_bytes().to_vec(),
        ] {
            assert!(vx_judged(&d), "{d:?}");
            assert!(judge_outside_v2(d[0], &d, pv, true).is_none(), "{d:?}");
        }
        // WideMuster and WideResolve stay VWL's, not VX's
        assert!(!vx_judged(&muster));
    }

    /// Q16-1: the playable lane (0x4804) is a known version only in the
    /// `playable-lane` build. There a wide tag is UNVERIFIABLE (named), a
    /// land tag is VL's, and any other tag outside ABI v2 is a FAIL (the
    /// build refuses it); elsewhere 0x4804 is an unknown version.
    #[test]
    fn the_playable_lane_is_known_only_with_its_feature() {
        use crate::Severity::{Fail, Unverifiable};
        let pv = Some(PROGRAM_VERSION_PLAYABLE);
        assert_eq!(
            known_version(PROGRAM_VERSION_PLAYABLE),
            cfg!(feature = "playable-lane")
        );
        assert_eq!(playable(pv), cfg!(feature = "playable-lane"));
        // Its siblings stay unknown: the dispatch revision without the wide
        // bit, the wide build without the revision, a rights/NFT/capacity mix.
        for v in [0x0804u16, 0x4004, 0x6804, 0xC804, 0x5804] {
            assert!(!known_version(v), "{v:#06x}");
        }
        for s1 in [true, false] {
            let wide = judge_outside_v2(0xDA, &[0xDA], pv, s1).expect("judged");
            assert_eq!((wide.0, wide.1), (Unverifiable, WIDE_UNMODELLED));
            let grant = judge_outside_v2(0xD0, &[0xD0], pv, s1).expect("judged");
            let land = judge_outside_v2(0xCD, &[0xCD, 1], pv, s1);
            if cfg!(feature = "playable-lane") {
                assert_eq!(grant.0, Fail, "the playable build refuses a Grant");
                assert!(land.is_none(), "VL judges the land tags");
                let none = judge_outside_v2(0xFE, &[0xFE], pv, s1).expect("judged");
                assert_eq!((none.0, none.1), (Fail, UNKNOWN_INSTRUCTION));
            } else {
                assert_eq!(grant.0, Unverifiable);
                assert_eq!(land.map(|l| l.0), Some(Unverifiable));
            }
        }
    }

    #[test]
    fn every_abi_tag_has_a_coverage_answer() {
        let unmodelled: Vec<&str> = Ix::ALL
            .iter()
            .filter(|ix| !supported(**ix, true, true))
            .map(|ix| ix.name())
            .collect();
        // Workstream 10's custody instructions (0xC2–0xCC) are deliberately
        // unmodelled: V0 reports them UnverifiedInstruction, and V26's
        // custody guard makes any custody trace a FAIL or UNVERIFIABLE, until
        // V26 replays custody (⑪, 2026-11-07).
        assert_eq!(
            unmodelled,
            [
                "CloseMarch",
                "FastForward",
                "OpenLot",
                "SetLotQuota",
                "DepositLot",
                "SetLotOrder",
                "RevokeLotOrder",
                "ShipLot",
                "SettleCustody",
                "ConsumeLot",
                "ReconcileLot",
                "CloseLot",
                "WithdrawLot",
            ]
        );
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

    /// The order of the outside-v2 judgement — Grant, then wide, then the
    /// bands — over every combination of program version and season kind
    /// (02-rights with ⑪'s r13 and r16 rules; key-free: pure function,
    /// literal bytes). A version is "modelled" only when this verifier
    /// implements it exactly (`known_version`): a combined experimental
    /// build (rights with NFT `0xA004`, with wide `0x6004`, all three
    /// `0xE004`) is not, so none of its tags may be left to a check (`None`)
    /// or called a forgery (`Fail`): each stays UNVERIFIABLE.
    #[test]
    fn grant_then_wide_then_bands_and_unknown_combinations_stay_unverifiable() {
        use crate::Severity::{Fail, Unverifiable};
        use frontier_abi::v2::rights::{is_rights_tag, PROGRAM_VERSION_RIGHTS_S1 as RIGHTS};
        const S1: u16 = PROGRAM_VERSION_S1;
        let versions: [Option<u16>; 13] = [
            None,
            // rights-play: the coexist versions (Grants VR's), and two
            // near misses (base 4 with every coexist bit; base 6).
            Some(PROGRAM_VERSION_COEXIST_S1),
            Some(PROGRAM_VERSION_COEXIST_LANE),
            Some(PROGRAM_VERSION_COEXIST_LANE - 1),
            Some(PROGRAM_VERSION_COEXIST_LANE + 1),
            Some(1),
            Some(S1),
            Some(RIGHTS),
            Some(WIDE_EXPERIMENTAL_VERSION_BIT | S1),
            Some(PROGRAM_VERSION_NFT_S1),
            Some(RIGHTS | WIDE_EXPERIMENTAL_VERSION_BIT),
            Some(RIGHTS | 0x8000),
            Some(RIGHTS | 0x8000 | WIDE_EXPERIMENTAL_VERSION_BIT),
        ];
        // A Grant tag, a wide draft tag, WideReveal, another band (custody),
        // ⑪'s band, and two tags no band holds.
        let tags = [0xD0u8, 0xD5, 0xD6, 0xEE, 0xC2, 0xE8, 0xFE, 0xD9, 0xF0, 0xFD];
        for pv in versions {
            for s1 in [true, false] {
                for tag in tags {
                    let got = judge_outside_v2(tag, &[tag], pv, s1);
                    let sev = got.as_ref().map(|g| g.0);
                    let at = format!("tag {tag:#04x}, pv {pv:?}, s1 {s1}: {got:?}");
                    let known = pv.is_some_and(known_version);
                    if grants_modelled(pv) && is_rights_tag(tag) {
                        // VR's, where it runs; never left unjudged.
                        if s1 {
                            assert!(got.is_none(), "{at}");
                        } else {
                            assert_eq!(sev, Some(Unverifiable), "{at}");
                        }
                    } else if is_wide_tag(tag)
                        && pv.is_some_and(|v| v & WIDE_EXPERIMENTAL_VERSION_BIT != 0)
                    {
                        assert_eq!(
                            got.map(|g| (g.0, g.1)),
                            Some((Unverifiable, WIDE_UNMODELLED)),
                            "{at}"
                        );
                    } else if known {
                        // A known program refuses the tag: a forgery.
                        assert_eq!(sev, Some(Fail), "{at}");
                    } else {
                        // Unknown, combined or absent version: never a check's,
                        // never a forgery claim.
                        assert_eq!(sev, Some(Unverifiable), "{at}");
                    }
                }
            }
        }
        // The combined builds are not versions this verifier implements.
        for v in [RIGHTS | WIDE_EXPERIMENTAL_VERSION_BIT, RIGHTS | 0x8000] {
            assert!(!known_version(v), "{v:#06x}");
        }
        // rights-play: the coexist versions are the registry's arithmetic
        // (base 5 = PROGRAM_VERSION_CUSTODY | rights 0x2000 | capacity
        // 0x1000 [| wide 0x4000 | expedition 0x0800]); their Grants are VR's
        // but the versions are not known (⑨/⑩/wide unmodelled).
        let custody = frontier_abi::v2::presets::PROGRAM_VERSION_CUSTODY;
        let rights_bit = frontier_abi::v2::rights::RIGHTS_EXPERIMENTAL_VERSION_BIT;
        assert_eq!(PROGRAM_VERSION_COEXIST_S1, custody | rights_bit | 0x1000);
        assert_eq!(
            PROGRAM_VERSION_COEXIST_LANE,
            PROGRAM_VERSION_COEXIST_S1 | WIDE_EXPERIMENTAL_VERSION_BIT | 0x0800
        );
        for v in [PROGRAM_VERSION_COEXIST_S1, PROGRAM_VERSION_COEXIST_LANE] {
            assert!(!known_version(v), "{v:#06x}");
            assert!(grants_modelled(Some(v)), "{v:#06x}");
        }
        for v in [
            None,
            Some(PROGRAM_VERSION_S1),
            Some(RIGHTS | 0x8000),
            Some(0x7804),
            Some(0x7806),
            Some(0x3004),
        ] {
            assert!(!grants_modelled(v), "{v:?}");
        }
    }
}
