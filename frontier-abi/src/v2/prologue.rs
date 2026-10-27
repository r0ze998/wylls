//! ABI v2 account lists (MC contract §5.5, §5.6) and the v2 reads the
//! prologues add. M1's checks ([`crate::prologue`]) are unchanged and
//! apply to v2 accounts (a v2 Province passes `check_present` for kind
//! Province: it is longer, never shorter).
//!
//! Lists are M1's types ([`Spec`], [`Group`]); a position holding a v2
//! Province or a MarchState is `Acc::KindV2`. Where §5.5 is silent on an
//! account the instruction needs, the table adds it and the notes say so
//! (D-6, D-8).

use crate::error::FrontierError;
use crate::layout::AccountKind as K;
use crate::prologue::{accounts_of as accounts_of_v1, Acc, AccountView, Group, Spec, Wr};
use crate::v2::layout::AccountKind as K2;
use crate::v2::tags::Ix;

macro_rules! s {
    ($name:expr, $acc:expr, $signer:expr, $wr:expr $(,)?) => {
        Spec {
            name: $name,
            acc: $acc,
            signer: $signer,
            wr: $wr,
        }
    };
}
macro_rules! one {
    ($specs:expr $(,)?) => {
        Group {
            specs: $specs,
            min: 1,
            max: 1,
        }
    };
}
macro_rules! rep {
    ($specs:expr, $min:expr, $max:expr $(,)?) => {
        Group {
            specs: $specs,
            min: $min,
            max: $max,
        }
    };
}

use Acc::{EitherV2, Kind, KindV2, System, Wallet};
use Wr::{R, W};

const ACTOR: Spec = s!("actor", Wallet, true, R);
const PAYER_SW: Spec = s!("payer", Wallet, true, W);
const FEE_PAYER: Spec = s!("fee_payer", Wallet, true, W);
const ANY_S: Spec = s!("any", Wallet, true, R);
const SEASON_R: Spec = s!("season", KindV2(K2::Season), false, R);
const CITIZEN_W: Spec = s!("citizen", KindV2(K2::Citizen), false, W);
const HOLDING_W: Spec = s!("holding", KindV2(K2::Holding), false, W);
const PROVINCE_W: Spec = s!("province", KindV2(K2::Province), false, W);
const PROVINCE_R: Spec = s!("province", KindV2(K2::Province), false, R);
const PROVINCE_RW: Spec = s!("province", KindV2(K2::Province), false, Wr::Either);
const SYSTEM: Spec = s!("system", System, false, R);

/// v2 player prologue `[actor s] [payer s,w] [season r] [citizen w]`.
pub const PLAYER_PROLOGUE: &[Spec] = &[ACTOR, PAYER_SW, SEASON_R, CITIZEN_W];

/// Most evidence accounts of a FastForward (a legacy transaction of 31
/// accounts fits 1,232 B).
pub const FAST_FORWARD_EVIDENCE_MAX: u8 = 28;

/// The account list of every v2 instruction: M1's for the instructions
/// MC does not reshape, the §5.5/§5.6 lists for the others.
pub fn accounts_of(ix: Ix) -> &'static [Group] {
    match ix {
        Ix::PlaceHome => {
            const {
                &[one!(&[
                    ACTOR,
                    PAYER_SW,
                    SEASON_R,
                    CITIZEN_W,
                    s!("frontier", KindV2(K2::Frontier), false, R),
                    PROVINCE_W,
                    HOLDING_W,
                    s!("joinshard", KindV2(K2::JoinShard), false, W),
                    SYSTEM,
                ])]
            }
        }
        Ix::DeclareSiege => {
            const {
                &[one!(&[
                    ACTOR,
                    PAYER_SW,
                    SEASON_R,
                    CITIZEN_W,
                    s!("src_holding", KindV2(K2::Holding), false, W),
                    PROVINCE_W,
                    s!("target_holding", KindV2(K2::Holding), false, R),
                    s!("owner_citizen", KindV2(K2::Citizen), false, R),
                    s!("nearby_province", KindV2(K2::Province), false, R),
                    SYSTEM,
                    s!("holding_province", KindV2(K2::Province), false, Wr::Either),
                ])]
            }
        }
        Ix::SettleSiege => {
            const {
                &[
                    one!(&[
                        ANY_S,
                        SEASON_R,
                        PROVINCE_W,
                        s!("recipient_holding", KindV2(K2::Holding), false, W),
                        s!("slot_citizen", KindV2(K2::Citizen), false, W),
                    ]),
                    // D-6: the escrow refund's destination (the Citizen's
                    // `ticket_funder`), present when a slot is owed back.
                    rep!(&[s!("ticket_funder", Wallet, false, W)], 0, 1),
                ]
            }
        }
        Ix::SettleCapture => {
            const {
                &[one!(&[
                    FEE_PAYER,
                    SEASON_R,
                    HOLDING_W,
                    PROVINCE_W,
                    s!("captor_citizen", KindV2(K2::Citizen), false, W),
                    s!("captor_joinshard", KindV2(K2::JoinShard), false, W),
                    s!("victim_citizen", KindV2(K2::Citizen), false, W),
                    s!("victim_joinshard", KindV2(K2::JoinShard), false, W),
                    s!("victim_rent_payer", Wallet, false, W),
                    s!("stake_holding", KindV2(K2::Holding), false, W),
                    SYSTEM,
                ])]
            }
        }
        Ix::FileOutpost => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[s!("frontier", Kind(K::Frontier), false, R)]),
                    rep!(&[PROVINCE_W], 1, 3),
                    one!(&[
                        SYSTEM,
                        s!("anchor_holding", KindV2(K2::Holding), false, W),
                        s!("anchor_province", KindV2(K2::Province), false, R),
                        s!("slot2_holding", KindV2(K2::Holding), false, Wr::Either),
                        s!("slot2_province", KindV2(K2::Province), false, Wr::Either)
                    ]),
                ]
            }
        }
        Ix::FoldMarch => {
            const {
                &[
                    one!(&[
                        FEE_PAYER,
                        SEASON_R,
                        s!("march", KindV2(K2::MarchState), false, W)
                    ]),
                    rep!(&[s!("member", KindV2(K2::Province), false, R)], 7, 7),
                    one!(&[SYSTEM]),
                ]
            }
        }
        Ix::RetireHost => {
            const {
                &[one!(&[
                    ACTOR,
                    PAYER_SW,
                    SEASON_R,
                    s!("victim_citizen", KindV2(K2::Citizen), false, R),
                    PROVINCE_W,
                    s!("captured_holding", KindV2(K2::Holding), false, R),
                    s!("home_holding", KindV2(K2::Holding), false, R),
                ])]
            }
        }
        Ix::CloseMarch => {
            const {
                &[one!(&[
                    ANY_S,
                    SEASON_R,
                    s!("march", KindV2(K2::MarchState), false, W),
                    s!("rent_to", Wallet, false, W),
                ])]
            }
        }
        // S1 (1b; S1-1B-CONTRACT §3). The origin's Province is the first
        // path Province (writable: it gets the caravan's first slot).
        Ix::BuildVault => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        HOLDING_W,
                        s!("holding_province", KindV2(K2::Province), false, R),
                        s!("province", KindV2(K2::Province), false, R),
                        s!("vault", KindV2(K2::Vault), false, W),
                        SYSTEM,
                    ]),
                ]
            }
        }
        Ix::SendCaravan => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("src", EitherV2(K2::Holding, K2::Vault), false, W),
                        s!("dst", EitherV2(K2::Holding, K2::Vault), false, R),
                        s!("caravan", KindV2(K2::Caravan), false, W),
                        SYSTEM,
                    ]),
                    rep!(&[s!("path_province", KindV2(K2::Province), false, W)], 1, 4),
                ]
            }
        }
        Ix::SettleCaravan => {
            const {
                &[
                    one!(&[
                        FEE_PAYER,
                        SEASON_R,
                        s!("caravan", KindV2(K2::Caravan), false, W),
                        s!("dst", EitherV2(K2::Holding, K2::Vault), false, W),
                        s!("beneficiary", Wallet, false, W),
                        s!("rent_to", Wallet, false, W),
                    ]),
                    rep!(&[s!("path_province", KindV2(K2::Province), false, R)], 1, 4),
                ]
            }
        }
        Ix::RaidCaravan => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("caravan", KindV2(K2::Caravan), false, W),
                        s!("raider_holding", KindV2(K2::Holding), false, R),
                        s!("dst", EitherV2(K2::Holding, K2::Vault), false, R),
                    ]),
                    // J2: a take reroutes the raided caravan itself. The new
                    // walk's Provinces first (the raid's first, `n_path` of
                    // them), then the old route's others, whose slots it
                    // clears.
                    rep!(&[s!("path_province", KindV2(K2::Province), false, W)], 1, 7),
                ]
            }
        }
        Ix::SeizeVault => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("vault", KindV2(K2::Vault), false, W),
                        PROVINCE_R,
                        s!("host_holding", KindV2(K2::Holding), false, R),
                        s!("owner_citizen", KindV2(K2::Citizen), false, W),
                    ]),
                ]
            }
        }
        Ix::CloseVault => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("vault", KindV2(K2::Vault), false, W),
                        s!("rent_to", Wallet, false, W),
                    ]),
                ]
            }
        }
        // S1 (1d; S1-1D-CONTRACT §3.4–3.6): the structure's Province is
        // writable (its structure list); the holding's is `r|w` (the same
        // account when the structure stands in the holding's Province).
        Ix::BuildStructure => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        HOLDING_W,
                        // Writable when it is also the structure's Province.
                        s!("holding_province", KindV2(K2::Province), false, Wr::Either),
                        PROVINCE_W,
                        s!("structure", KindV2(K2::Structure), false, W),
                        SYSTEM,
                    ]),
                ]
            }
        }
        Ix::SeizeStructure => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("structure", KindV2(K2::Structure), false, W),
                        PROVINCE_W,
                        s!("host_holding", KindV2(K2::Holding), false, R),
                        s!("owner_citizen", KindV2(K2::Citizen), false, W),
                    ]),
                ]
            }
        }
        Ix::CloseStructure => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("structure", KindV2(K2::Structure), false, W),
                        PROVINCE_W,
                        s!("rent_to", Wallet, false, W),
                    ]),
                ]
            }
        }
        // S1 (1e; S1-1E-CONTRACT §2.6): the holding pays from its reserve;
        // the fort's Province holds its record (the holding's own).
        Ix::FortGarrison => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        HOLDING_W,
                        PROVINCE_W,
                        s!("structure", KindV2(K2::Structure), false, R),
                    ]),
                ]
            }
        }
        // S1 (1e; S1-1E-CONTRACT §3.3): the target is the Citizen to expel
        // or readmit, or (a stance) the Nation itself, `r|w` either way.
        Ix::Propose => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("nation", KindV2(K2::Nation), false, W),
                        s!(
                            "target",
                            EitherV2(K2::Citizen, K2::Nation),
                            false,
                            Wr::Either
                        ),
                        SYSTEM,
                    ]),
                ]
            }
        }
        Ix::Vote => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[s!("nation", KindV2(K2::Nation), false, W)]),
                ]
            }
        }
        // The Season is writable (a passed stance); the holdings are the
        // target's live ones (a passed expulsion or readmission flags them).
        Ix::SettleProposal => {
            const {
                &[
                    one!(&[
                        FEE_PAYER,
                        s!("season", KindV2(K2::Season), false, W),
                        s!("nation", KindV2(K2::Nation), false, W),
                        s!(
                            "target",
                            EitherV2(K2::Citizen, K2::Nation),
                            false,
                            Wr::Either
                        ),
                    ]),
                    rep!(&[s!("holding", KindV2(K2::Holding), false, W)], 0, 3),
                ]
            }
        }
        // S1 (1e; S1-1E-CONTRACT §4): the owner's Citizen names its
        // holdings (none of its hosts may stand on the tile).
        Ix::RaidDomestic => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        s!("caravan", KindV2(K2::Caravan), false, R),
                        PROVINCE_W,
                        s!("host_holding", KindV2(K2::Holding), false, R),
                        s!("owner_citizen", KindV2(K2::Citizen), false, R),
                    ]),
                ]
            }
        }
        // S1 (map growth, keeper-load-rules.ja.md §2.4): the Province, then
        // the evidence: `days` ArrivalDays (absent ones included) and the
        // region's anchors or archives, each checked by its canonical
        // address in the program. Typed as the larger kinds so the loaded
        // size counts an archive (6,144 B) at every position.
        Ix::FastForward => {
            const {
                &[
                    one!(&[s!("payer", Wallet, true, R), SEASON_R, PROVINCE_W]),
                    rep!(
                        &[s!(
                            "evidence",
                            Acc::Either(K::ArrivalDay, K::AnchorArchive),
                            false,
                            R
                        )],
                        1,
                        FAST_FORWARD_EVIDENCE_MAX
                    ),
                ]
            }
        }
        Ix::DefaultRaid => {
            const {
                &[
                    one!(&[
                        FEE_PAYER,
                        SEASON_R,
                        s!("caravan", KindV2(K2::Caravan), false, W),
                        s!("raider_holding", KindV2(K2::Holding), false, R),
                        s!("raider_citizen", KindV2(K2::Citizen), false, R),
                        s!("beneficiary", Wallet, false, W),
                    ]),
                    rep!(&[s!("path_province", KindV2(K2::Province), false, W)], 1, 7),
                ]
            }
        }
        // §5.6: Harvest and Train gain `[province r]` (the capture lock).
        Ix::Harvest | Ix::Train => {
            const { &[one!(PLAYER_PROLOGUE), one!(&[HOLDING_W, PROVINCE_R])] }
        }
        // §5.6: Build gains `[province r]`, writable only for a tier-up
        // (`tier_next`): `Wr::Either`, decided by the item, as M1's Reveal
        // (integ-W1, review CQ1-C: a write lock on every Build would
        // serialise the Province's Builds against each other and against
        // GatherClash / Resolve).
        Ix::Build => const { &[one!(PLAYER_PROLOGUE), one!(&[HOLDING_W, PROVINCE_RW])] },
        Ix::Muster | Ix::Garrison => {
            const { &[one!(PLAYER_PROLOGUE), one!(&[HOLDING_W, PROVINCE_W])] }
        }
        Ix::Dissolve | Ix::Explore => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        HOLDING_W,
                        PROVINCE_W,
                        s!("holding_province", KindV2(K2::Province), false, Wr::Either)
                    ]),
                ]
            }
        }
        Ix::SettleDeparture => {
            const {
                &[one!(&[
                    PAYER_SW,
                    SEASON_R,
                    PROVINCE_W,
                    HOLDING_W,
                    s!("holding_province", KindV2(K2::Province), false, Wr::Either)
                ])]
            }
        }
        Ix::Depart => {
            const {
                &[
                    one!(PLAYER_PROLOGUE),
                    one!(&[
                        HOLDING_W,
                        PROVINCE_W,
                        SYSTEM,
                        s!("holding_province", KindV2(K2::Province), false, Wr::Either)
                    ]),
                ]
            }
        }
        // §5.6 0x54: `[prev_home_holding w]` when `holding.gen ≠ id.gen`
        // (D-8: an optional trailing group; CQ2-C may pin another place).
        Ix::SettleTransit => {
            const {
                &[
                    one!(&[
                        PAYER_SW,
                        SEASON_R,
                        HOLDING_W,
                        s!("dest_province", KindV2(K2::Province), false, W),
                        s!("inputs", Kind(K::ClashInputs), false, W),
                        s!("slot", Kind(K::ArrivalSlot), false, W),
                        s!("home_province", KindV2(K2::Province), false, W),
                        s!(
                            "anchor_or_archive",
                            Acc::Either(K::BellAnchor, K::AnchorArchive),
                            false,
                            R
                        ),
                        s!("slot_beneficiary", Wallet, false, W),
                        s!("resolver", Wallet, false, W),
                        s!("holding_rent_payer", Wallet, false, W),
                        s!("settle_beneficiary", Wallet, false, W),
                        SYSTEM,
                    ]),
                    rep!(&[CITIZEN_W], 0, 1),
                    rep!(
                        &[s!("prev_home_holding", KindV2(K2::Holding), false, W)],
                        0,
                        1
                    ),
                    one!(&[s!(
                        "holding_province",
                        KindV2(K2::Province),
                        false,
                        Wr::Either
                    )]),
                ]
            }
        }
        other => match other.to_v1() {
            Some(v1) => accounts_of_v1(v1),
            None => &[],
        },
    }
}

/// Fewest and most accounts of a v2 instruction.
pub fn count_bounds(ix: Ix) -> (usize, usize) {
    crate::prologue::bounds_in(accounts_of(ix))
}

/// The v2 position list for given repeat counts
/// ([`crate::prologue::resolve`] over the v2 table).
pub fn resolve(ix: Ix, counts: &[u8], out: &mut [Spec]) -> Option<usize> {
    crate::prologue::resolve_in(accounts_of(ix), counts, out)
}

/// The v2 repeat counts from the account count
/// ([`crate::prologue::counts_from_len`] over the v2 table).
pub fn counts_from_len(ix: Ix, n_accounts: usize, out: &mut [u8]) -> Option<usize> {
    crate::prologue::counts_in(accounts_of(ix), n_accounts, out)
}

/// The position of the `nth` account named `name` in a v2 instruction of
/// `n_accounts` accounts (the names of [`accounts_of`]); see
/// [`crate::prologue::position_in`].
pub fn position(ix: Ix, n_accounts: usize, name: &str, nth: usize) -> Option<usize> {
    crate::prologue::position_in(accounts_of(ix), n_accounts, name, nth)
}

/// The data size SIMD-0186 counts for one position under ABI v2 (an M1
/// table's Province position is a v2 Province in an MC season).
pub fn kind_size_v2(acc: Acc) -> Option<u32> {
    Some(match acc {
        Acc::Kind(k) => K2::of_v1(k).size() as u32,
        Acc::KindV2(k) => k.size() as u32,
        Acc::EitherV2(a, b) => a.size().max(b.size()) as u32,
        Acc::Either(a, b) => (K2::of_v1(a).size().max(K2::of_v1(b).size())) as u32,
        _ => return None,
    })
}

/// A present v2 program account: owner, the exact v2 size, magic, season
/// and `layout_version = 2` for chained kinds (`BadAccount`). An M1
/// account (v1 size or `layout_version` 1) is refused, as R-22 requires of
/// the v2 program.
pub fn check_present_v2(
    a: &AccountView<'_>,
    program: &[u8; 32],
    kind: K2,
    season_id: u64,
) -> Result<(), FrontierError> {
    if a.owner != program || a.data.len() != kind.size() {
        return Err(FrontierError::BadAccount);
    }
    match crate::layout::read_short_header(a.data) {
        Some((m, id)) if m == kind.magic() && id == season_id => {}
        _ => return Err(FrontierError::BadAccount),
    }
    if kind.chained()
        && crate::v2::layout::layout_version(a.data) != Some(crate::v2::layout::LAYOUT_VERSION_V2)
    {
        return Err(FrontierError::BadAccount);
    }
    Ok(())
}

/// The capture lock (§5.8, v1.4 A-30): a live Holding at `holding_gen`
/// whose Province mirrors its site as a **holding of the next generation**
/// (`state == HOLDING` and `mirror.gen == holding_gen + 1`) has a capture
/// that completed in a resolve and has not been settled: the instruction
/// refuses `CapturePending` (62).
///
/// The rule reads the mirror alone. `capture_flags` plays no part: a
/// settled capture has `holding.gen == mirror.gen` (no lock), and a
/// second capture of an already captured Holding (`capture_flags` still 1)
/// must lock exactly like the first, so a flag clause would leave it open.
/// On every state a live Holding can reach this equals `mirror.gen ≠
/// holding.gen`; the exact `+ 1` keeps M1 seasons (whose mirror always
/// carries its live Holding's generation) and released sites unlocked.
/// `None` when the Province data is too short.
pub fn capture_locked(province: &[u8], site: u8, holding_gen: u8) -> Option<bool> {
    use crate::v2::layout::province::{province as P, site as SM};
    let s = P::site(site as usize);
    let state = crate::bytes::rd_u8(province, s + SM::STATE)?;
    let g = crate::bytes::rd_u8(province, s + SM::GEN)?;
    Some(state == SM::STATE_HOLDING && g == holding_gen.wrapping_add(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_v2_instruction_has_a_consistent_table() {
        for ix in Ix::ALL {
            let groups = accounts_of(*ix);
            assert!(!groups.is_empty(), "{}", ix.name());
            for g in groups {
                assert!(g.min <= g.max && !g.specs.is_empty(), "{}", ix.name());
            }
            let (lo, hi) = count_bounds(*ix);
            assert!(lo <= hi);
        }
        // §5.5 counts
        assert_eq!(count_bounds(Ix::DeclareSiege), (11, 11));
        assert_eq!(count_bounds(Ix::SettleCapture), (11, 11));
        assert_eq!(count_bounds(Ix::FoldMarch), (11, 11));
        assert_eq!(count_bounds(Ix::RetireHost), (7, 7));
        assert_eq!(count_bounds(Ix::CloseMarch), (4, 4));
        assert_eq!(count_bounds(Ix::FileOutpost), (11, 13));
        // S1 (1b)
        assert_eq!(count_bounds(Ix::BuildVault), (9, 9));
        assert_eq!(count_bounds(Ix::SendCaravan), (9, 12));
        assert_eq!(count_bounds(Ix::SettleCaravan), (7, 10));
        assert_eq!(count_bounds(Ix::RaidCaravan), (8, 14));
        assert_eq!(count_bounds(Ix::SeizeVault), (8, 8));
        assert_eq!(count_bounds(Ix::CloseVault), (6, 6));
        assert_eq!(count_bounds(Ix::BuildStructure), (9, 9));
        assert_eq!(count_bounds(Ix::SeizeStructure), (8, 8));
        assert_eq!(count_bounds(Ix::CloseStructure), (7, 7));
        assert_eq!(count_bounds(Ix::Propose), (7, 7));
        assert_eq!(count_bounds(Ix::Vote), (5, 5));
        assert_eq!(count_bounds(Ix::SettleProposal), (4, 7));
        assert_eq!(count_bounds(Ix::RaidDomestic), (8, 8));
        assert_eq!(count_bounds(Ix::FortGarrison), (7, 7));
        assert_eq!(count_bounds(Ix::DefaultRaid), (7, 13));
        // S1 (map growth)
        assert_eq!(count_bounds(Ix::FastForward), (4, 31));
        // Named positions, as off-chain readers look them up.
        let at = |ix, n, name| position(ix, n, name, 0);
        assert_eq!(at(Ix::FileOutpost, 11, "citizen"), Some(3));
        assert_eq!(at(Ix::FileOutpost, 11, "frontier"), Some(4));
        assert_eq!(at(Ix::FileOutpost, 11, "anchor_holding"), Some(7));
        assert_eq!(at(Ix::FileOutpost, 13, "anchor_holding"), Some(9));
        assert_eq!(position(Ix::FileOutpost, 13, "province", 2), Some(7));
        assert_eq!(position(Ix::FileOutpost, 13, "province", 3), None);
        assert_eq!(at(Ix::FileOutpost, 14, "citizen"), None);
        assert_eq!(at(Ix::DeclareSiege, 11, "target_holding"), Some(6));
        assert_eq!(at(Ix::SettleCapture, 11, "stake_holding"), Some(9));
        assert_eq!(position(Ix::FoldMarch, 11, "member", 6), Some(9));
        // S1, as the verifier's V7, V23, V24 and V25 read them.
        assert_eq!(at(Ix::BuildVault, 9, "holding"), Some(4));
        assert_eq!(at(Ix::BuildVault, 9, "province"), Some(6));
        assert_eq!(at(Ix::BuildVault, 9, "vault"), Some(7));
        assert_eq!(at(Ix::SendCaravan, 9, "src"), Some(4));
        assert_eq!(at(Ix::SettleCaravan, 7, "caravan"), Some(2));
        assert_eq!(at(Ix::SettleCaravan, 10, "dst"), Some(3));
        assert_eq!(at(Ix::CloseVault, 6, "vault"), Some(4));
        assert_eq!(at(Ix::BuildStructure, 9, "structure"), Some(7));
        assert_eq!(at(Ix::CloseStructure, 7, "structure"), Some(4));
        assert_eq!(at(Ix::CloseStructure, 7, "province"), Some(5));
        assert_eq!(at(Ix::FortGarrison, 7, "structure"), Some(6));
        assert_eq!(at(Ix::Propose, 7, "target"), Some(5));
        assert_eq!(at(Ix::Vote, 5, "nation"), Some(4));
        let mut counts = [0u8; 4];
        let ng = counts_from_len(Ix::FileOutpost, 12, &mut counts).unwrap();
        assert_eq!(&counts[..ng], &[1, 1, 2, 1]);
        let mut specs = [PLAYER_PROLOGUE[0]; 16];
        assert_eq!(
            resolve(Ix::FileOutpost, &counts[..ng], &mut specs),
            Some(12)
        );
        assert_eq!(specs[8].name, "anchor_holding");
        // §5.6: the three resident actions gain the Province
        for ix in [Ix::Harvest, Ix::Build, Ix::Train] {
            let v1 = crate::prologue::count_bounds(ix.to_v1().unwrap());
            assert_eq!(count_bounds(ix).0, v1.0 + 1, "{}", ix.name());
        }
        // §5.6: Build's Province is writable only for a tier-up.
        let build_province = accounts_of(Ix::Build)
            .iter()
            .flat_map(|g| g.specs.iter())
            .find(|s| s.name == "province")
            .expect("Build names the Province");
        assert_eq!(build_province.wr, Wr::Either);
        assert_eq!(
            kind_size_v2(Acc::Kind(K::Province)),
            Some(4_736),
            "an M1 table's Province is v2-sized in an MC season"
        );
    }

    #[test]
    fn present_v2_refuses_m1_accounts() {
        let program = [7u8; 32];
        let mut d = std::vec![0u8; K2::Province.size()];
        assert!(crate::v2::layout::write_header(&mut d, K2::Province, 3));
        let view = |d: &[u8]| -> Result<(), FrontierError> {
            let key = [0u8; 32];
            let a = AccountView {
                key: &key,
                owner: &program,
                lamports: 1,
                data: d,
                is_signer: false,
                is_writable: true,
            };
            check_present_v2(&a, &program, K2::Province, 3)
        };
        assert_eq!(view(&d), Ok(()));
        let mut v1 = d.clone();
        v1[16] = 1; // layout_version 1
        assert_eq!(view(&v1), Err(FrontierError::BadAccount));
        assert_eq!(view(&d[..4_096]), Err(FrontierError::BadAccount));
        // capture lock
        let mut p = d.clone();
        use crate::v2::layout::province::{province as P, site as SM};
        p[P::site(4) + SM::STATE] = SM::STATE_HOLDING;
        p[P::site(4) + SM::GEN] = 3;
        // A-30: the mirror one generation ahead locks, whatever the
        // Holding's capture flags are (they are not an argument).
        assert_eq!(capture_locked(&p, 4, 2), Some(true));
        assert_eq!(capture_locked(&p, 4, 3), Some(false));
        // a released or free site never locks
        p[P::site(4) + SM::STATE] = SM::STATE_RELEASED_FREE;
        assert_eq!(capture_locked(&p, 4, 2), Some(false));
        assert_eq!(capture_locked(&p[..8], 4, 2), None);
    }
}
