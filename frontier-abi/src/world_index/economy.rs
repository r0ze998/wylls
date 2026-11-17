//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **host-only wide economy** wire action and receipt (phase A,
//! 2026-11-08): what a wide Harvest, Build or Train *says* on the wire and
//! what its record *commits to*. Nothing here executes an action, reads an
//! account, or decides who may act.
//!
//! **The action** ([`Action`]) is the S1 owner action of
//! `docs/frontier/map-growth/WIDE-ECONOMY-SCOPE-20261108.md` in a fixed
//! six-byte form, carried as op 3 of the 0xDA class-P envelope
//! (`wide_ix::Economy`): `tag u8 ‖ arg u8 ‖ LE32`. Tag 0 is Harvest and
//! every other byte is zero; tag 1 is Build with the item in the second
//! byte (0–5 the buildings, 6 walls, 7 the tier-up, 8 the workshop: the
//! deployed `proc::holding` range) and the rest zero; tag 2 is Train with
//! the unit in the second byte (0–6, the units `arms::train_v3` prices)
//! and `n ≥ 1` in the four that follow. Non-zero padding, an unknown tag,
//! an item or unit outside those ranges and `n = 0` are refused: exactly
//! the arguments the deployed Build and Train handlers refuse as `BadData`
//! (`item > ITEM_TIER_UP && item != ITEM_WORKSHOP`; `train_cost(unit, n)`
//! is `None` for an unknown unit or `n = 0`). No cost, yield, schedule or
//! rule is restated or changed: the ranges are read from
//! `permutation_rules` and pinned by const assertions. The program's
//! preview (`proc::wide_economy::Action`) is a separate type today; its
//! conversion from this one is the next phase.
//!
//! [`Action::mirror_write`] is the one predicate the wire needs: walls and
//! the tier-up write the province's site mirror, so their account table
//! names the province writable and their receipt chains the province; the
//! other seven actions write the holding alone.
//!
//! **The receipt** ([`EconomyReceipt`], 80 bytes, version 1) is the payload
//! of the wide event kinds 15 `Economy` and 16 `EconomyMirror`
//! (`event::WideKind`), keyed by the **56-byte holding reference**
//! (`WideHostRef` with sequence 0, a live generation and a wide ring,
//! [`economy_key`] / [`check_holding_ref`]): the action's six
//! canonical bytes, the `now_ts` the action ran at, whether the lazy
//! provisional → final flip happened, and two domain-separated digests.
//! The record's kind is a function of the action alone
//! ([`EconomyReceipt::kind`]); a receipt under the other kind is refused by
//! the event codec.
//!
//! **The digests.** [`input_digest`] commits to the holding reference, the
//! action, `now_ts`, and, each length-delimited and complete, the Season
//! bytes, the Citizen bytes and the holding and province bytes **as read**
//! (their chain headers included: the input is the account state the
//! action saw). [`output_digest`] commits to the same identity, action,
//! time and the flip, then the complete Citizen bytes after and the holding
//! and province bytes after **normalized** by `event::normalize_chained`
//! (the chain header's `event_seq` and `event_head` zeroed), so the output
//! does not depend on the record's own link: the record's link commits the
//! chain, the digest the state. Both validate the snapshots minimally
//! before hashing — the holding by `WideHolding::read`, the province by
//! `WideProvince::read`, the Citizen by its exact v2 size, and the holding
//! as the reference's and the province as the holding's — so a wrong-shaped
//! or foreign snapshot never yields a digest. The Citizen is **not** a wide
//! entity: it is committed by content only; its own PS2 chain is untouched
//! and it is linked by no wide record.
//!
//! **What a receipt is not.** It establishes **no authorisation and no
//! provenance**: it does not show that the actor could act, that the
//! Citizen owned the holding, that the Season was running, that the bytes
//! were the chain's, or that anything was written anywhere. A verifier can
//! recompute both digests from the snapshots it reads, and the chain from
//! the records, and nothing more; whole-Season replay of the economy is
//! **not supported** by this module or any other. The record is a
//! commitment the next phase's handler may log and a reader may check, and
//! that is all it is.

use super::event::{normalize_chained, WideKind};
use super::holding::{HoldingError, WideHolding};
use super::key::{KeyError, WideHostRef, HOST_REF_LEN};
use super::land::{LandError, WideProvince, FIRST_WIDE_RING};
use crate::bytes::{Cursor, Writer};
use crate::v2::layout::player::citizen as C2;
use alloc::vec::Vec;
use permutation_rules::frontier::arms::{ITEM_WORKSHOP, TRAIN_ARMS_PER_100};
use permutation_rules::frontier::catalog::{ITEM_COUNT, ITEM_WALLS, TRAIN_PROD_COST_V2};
use permutation_rules::hash::sha256;

/// The action's wire width.
pub const ACTION_LEN: usize = 6;
/// `Action::Harvest`.
pub const TAG_HARVEST: u8 = 0;
/// `Action::Build { item }`.
pub const TAG_BUILD: u8 = 1;
/// `Action::Train { unit, n }`.
pub const TAG_TRAIN: u8 = 2;
/// The highest action tag.
pub const TAG_MAX: u8 = TAG_TRAIN;

/// The walls item (`catalog::ITEM_WALLS`): writes the site mirror.
pub const BUILD_ITEM_WALLS: u8 = ITEM_WALLS;
/// The tier-up item (`proc::holding::ITEM_TIER_UP = catalog::ITEM_COUNT`):
/// writes the site mirror.
pub const BUILD_ITEM_TIER_UP: u8 = ITEM_COUNT;
/// The highest Build item (`arms::ITEM_WORKSHOP`).
pub const BUILD_ITEM_MAX: u8 = ITEM_WORKSHOP;
/// The units Train accepts: `0..TRAIN_UNITS`, the ids `arms::train_v3`
/// prices (every other is `None` there, `BadData` in the handler).
pub const TRAIN_UNITS: u8 = TRAIN_ARMS_PER_100.len() as u8;

const _: () = {
    assert!(BUILD_ITEM_WALLS == 6);
    assert!(BUILD_ITEM_TIER_UP == 7);
    assert!(BUILD_ITEM_MAX == 8);
    assert!(TRAIN_UNITS == 7);
    assert!(TRAIN_ARMS_PER_100.len() == TRAIN_PROD_COST_V2.len());
};

/// The receipt's version byte. A later layout is a new version.
pub const RECEIPT_VERSION: u8 = 1;
/// `version ‖ action ‖ now_ts ‖ became_final ‖ input ‖ output`.
pub const RECEIPT_LEN: usize = 1 + ACTION_LEN + 8 + 1 + 32 + 32;
/// Domain of [`input_digest`].
pub const INPUT_DOMAIN: &[u8] = b"PSF-WIDE-ECONOMY-INPUT-v1";
/// Domain of [`output_digest`].
pub const OUTPUT_DOMAIN: &[u8] = b"PSF-WIDE-ECONOMY-OUTPUT-v1";

/// Why an action, a receipt, a key or a snapshot is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EconomyError {
    Length {
        expected: usize,
        got: usize,
    },
    /// An action tag above [`TAG_MAX`].
    Tag(u8),
    /// A byte the tag leaves unused is not zero.
    Padding,
    /// A Build item above [`BUILD_ITEM_MAX`].
    Item(u8),
    /// A Train unit at or above [`TRAIN_UNITS`].
    Unit(u8),
    /// A Train of zero troops.
    Count,
    /// A receipt version other than [`RECEIPT_VERSION`].
    Version(u8),
    /// A `became_final` byte other than 0 or 1.
    Bool(u8),
    /// The key is no canonical host reference.
    Key(KeyError),
    /// The key names a host (`seq ≠ 0`), not a holding.
    Sequence(u32),
    /// The key's site generation is 0 or `citizen::EMPTY_GEN`: no holding
    /// is ever founded or read under either (`WideHolding::found` /
    /// `WideHolding::read` refuse them as `SiteOrGen`).
    Generation(u8),
    /// The key's coordinate lies inside the legacy map (ring below
    /// `land::FIRST_WIDE_RING`): no wide holding is ever founded or read
    /// there (`HoldingError::NotWide`).
    NotWide {
        ring: u64,
    },
    /// The holding snapshot does not read (`WideHolding::read`).
    Holding(HoldingError),
    /// The province snapshot does not read (`WideProvince::read`).
    Province(LandError),
    /// The Citizen snapshot is not exactly the Citizen v2 size.
    Citizen {
        expected: usize,
        got: usize,
    },
    /// The holding snapshot is not the reference's holding (world,
    /// coordinate, site, generation), or the province snapshot is not the
    /// holding's province (season, world, coordinate).
    Identity,
}

impl From<KeyError> for EconomyError {
    fn from(e: KeyError) -> Self {
        EconomyError::Key(e)
    }
}

impl From<HoldingError> for EconomyError {
    fn from(e: HoldingError) -> Self {
        EconomyError::Holding(e)
    }
}

impl From<LandError> for EconomyError {
    fn from(e: LandError) -> Self {
        EconomyError::Province(e)
    }
}

// ------------------------------------------------------------ action

/// The canonical wide owner action (module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// Settle and touch; the stores move, nothing is bought.
    Harvest,
    /// Build `item` (0–5 the buildings, 6 walls, 7 the tier-up, 8 the
    /// workshop).
    Build { item: u8 },
    /// Train `n ≥ 1` whole troops of `unit` (0–6) into the reserve.
    Train { unit: u8, n: u32 },
}

impl Action {
    pub const fn tag(&self) -> u8 {
        match self {
            Action::Harvest => TAG_HARVEST,
            Action::Build { .. } => TAG_BUILD,
            Action::Train { .. } => TAG_TRAIN,
        }
    }

    /// Whether the action writes the province's site mirror (walls or the
    /// tier-up): its table names the province writable and its receipt
    /// chains the province.
    pub const fn mirror_write(&self) -> bool {
        matches!(
            self,
            Action::Build {
                item: BUILD_ITEM_WALLS
            } | Action::Build {
                item: BUILD_ITEM_TIER_UP
            }
        )
    }

    /// The event kind of the action's receipt: `EconomyMirror` exactly
    /// when [`Action::mirror_write`], else `Economy`.
    pub const fn kind(&self) -> WideKind {
        if self.mirror_write() {
            WideKind::EconomyMirror
        } else {
            WideKind::Economy
        }
    }

    /// Whether the arguments are in the ranges the deployed handlers
    /// accept (module doc): `Item`, `Unit` or `Count` otherwise. An
    /// `Action` built by [`Action::decode`] always passes; one built by
    /// hand may not.
    pub const fn check(&self) -> Result<(), EconomyError> {
        match self {
            Action::Harvest => Ok(()),
            Action::Build { item } => {
                if *item > BUILD_ITEM_MAX {
                    Err(EconomyError::Item(*item))
                } else {
                    Ok(())
                }
            }
            Action::Train { unit, n } => {
                if *unit >= TRAIN_UNITS {
                    Err(EconomyError::Unit(*unit))
                } else if *n == 0 {
                    Err(EconomyError::Count)
                } else {
                    Ok(())
                }
            }
        }
    }

    pub const fn is_valid(&self) -> bool {
        self.check().is_ok()
    }

    fn raw_bytes(&self) -> [u8; ACTION_LEN] {
        let mut b = [0u8; ACTION_LEN];
        match *self {
            Action::Harvest => {}
            Action::Build { item } => b[1] = item,
            Action::Train { unit, n } => {
                b[1] = unit;
                b[2..6].copy_from_slice(&n.to_le_bytes());
            }
        }
        b[0] = self.tag();
        b
    }

    /// The six canonical bytes, or why the action has none
    /// ([`Action::check`]).
    pub fn checked_bytes(&self) -> Result<[u8; ACTION_LEN], EconomyError> {
        self.check()?;
        Ok(self.raw_bytes())
    }

    /// The six canonical bytes (`None` for an invalid action, which has
    /// no canonical form).
    pub fn to_bytes(&self) -> Option<[u8; ACTION_LEN]> {
        self.checked_bytes().ok()
    }

    /// Exactly six bytes: a known tag, zero in every byte the tag leaves
    /// unused, the arguments in range (module doc). Nothing else decodes.
    pub fn decode(b: &[u8]) -> Result<Action, EconomyError> {
        if b.len() != ACTION_LEN {
            return Err(EconomyError::Length {
                expected: ACTION_LEN,
                got: b.len(),
            });
        }
        match b[0] {
            TAG_HARVEST => {
                if b[1..] != [0u8; ACTION_LEN - 1] {
                    return Err(EconomyError::Padding);
                }
                Ok(Action::Harvest)
            }
            TAG_BUILD => {
                if b[2..] != [0u8; ACTION_LEN - 2] {
                    return Err(EconomyError::Padding);
                }
                let item = b[1];
                if item > BUILD_ITEM_MAX {
                    return Err(EconomyError::Item(item));
                }
                Ok(Action::Build { item })
            }
            TAG_TRAIN => {
                let unit = b[1];
                let n = u32::from_le_bytes([b[2], b[3], b[4], b[5]]);
                if unit >= TRAIN_UNITS {
                    return Err(EconomyError::Unit(unit));
                }
                if n == 0 {
                    return Err(EconomyError::Count);
                }
                Ok(Action::Train { unit, n })
            }
            t => Err(EconomyError::Tag(t)),
        }
    }
}

// ------------------------------------------------------------ key

/// The one validation every economy key passes, at both ends and before
/// any snapshot: the reference names a holding that could exist. Sequence
/// 0 (a sequence names a host: `Sequence`, never silently cleared); a
/// generation that is neither 0 nor `citizen::EMPTY_GEN` (`Generation`);
/// a coordinate on a wide ring (`NotWide`). The last two are exactly the
/// constraints `WideHolding::found` and `WideHolding::read` already apply
/// to the record itself; the site bound is the reference codec's own
/// (`WideHostRef::new`). Nothing about `WideHostRef` changes: a host
/// reference elsewhere is as free as before.
pub fn check_holding_ref(holding: &WideHostRef) -> Result<(), EconomyError> {
    if holding.seq() != 0 {
        return Err(EconomyError::Sequence(holding.seq()));
    }
    let gen = holding.gen();
    if gen == 0 || gen == C2::EMPTY_GEN {
        return Err(EconomyError::Generation(gen));
    }
    let ring = holding.key().coord().ring();
    if ring < FIRST_WIDE_RING {
        return Err(EconomyError::NotWide { ring });
    }
    Ok(())
}

/// The record key of a holding's economy: its 56-byte reference under
/// [`check_holding_ref`] (sequence 0, a live generation, a wide ring).
pub fn economy_key(holding: &WideHostRef) -> Result<[u8; HOST_REF_LEN], EconomyError> {
    check_holding_ref(holding)?;
    Ok(holding.to_bytes())
}

/// Inverse of [`economy_key`]: a canonical reference under
/// [`check_holding_ref`].
pub fn decode_key(bytes: &[u8]) -> Result<WideHostRef, EconomyError> {
    let h = WideHostRef::from_bytes(bytes)?;
    check_holding_ref(&h)?;
    Ok(h)
}

// ------------------------------------------------------------ receipt

/// The fixed receipt payload of an `Economy` or `EconomyMirror` record
/// (module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EconomyReceipt {
    pub action: Action,
    /// The clock the action ran at.
    pub now_ts: i64,
    /// The lazy provisional → final flip happened in this action.
    pub became_final: bool,
    /// [`input_digest`].
    pub input_digest: [u8; 32],
    /// [`output_digest`].
    pub output_digest: [u8; 32],
}

impl EconomyReceipt {
    /// The record kind this receipt belongs under, by its action alone.
    pub const fn kind(&self) -> WideKind {
        self.action.kind()
    }

    /// `RECEIPT_VERSION ‖ action 6 ‖ LE64(now_ts) ‖ became_final ‖ input
    /// ‖ output` (`None` for an invalid action).
    pub fn to_bytes(&self) -> Option<[u8; RECEIPT_LEN]> {
        let mut b = [0u8; RECEIPT_LEN];
        Writer::new(&mut b)
            .u8(RECEIPT_VERSION)
            .bytes(&self.action.to_bytes()?)
            .i64(self.now_ts)
            .u8(self.became_final as u8)
            .bytes(&self.input_digest)
            .bytes(&self.output_digest)
            .finish()?;
        Some(b)
    }

    /// Exactly [`RECEIPT_LEN`] bytes under this version, a canonical
    /// action, a canonical bool.
    pub fn decode(b: &[u8]) -> Result<EconomyReceipt, EconomyError> {
        let short = EconomyError::Length {
            expected: RECEIPT_LEN,
            got: b.len(),
        };
        if b.len() != RECEIPT_LEN {
            return Err(short);
        }
        let mut c = Cursor::new(b);
        let v = c.u8().ok_or(short)?;
        if v != RECEIPT_VERSION {
            return Err(EconomyError::Version(v));
        }
        let action = Action::decode(c.take(ACTION_LEN).ok_or(short)?)?;
        let now_ts = c.i64().ok_or(short)?;
        let became_final = match c.u8().ok_or(short)? {
            0 => false,
            1 => true,
            x => return Err(EconomyError::Bool(x)),
        };
        let input_digest = c.arr::<32>().ok_or(short)?;
        let output_digest = c.arr::<32>().ok_or(short)?;
        Ok(EconomyReceipt {
            action,
            now_ts,
            became_final,
            input_digest,
            output_digest,
        })
    }
}

// ------------------------------------------------------------ digests

/// The three account snapshots an action reads or leaves: the Citizen
/// (exactly Citizen v2), the wide holding (exactly `wide_holding::SIZE`)
/// and the holding's own wide province (exactly `province::SIZE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Snapshots<'a> {
    pub citizen: &'a [u8],
    pub holding: &'a [u8],
    pub province: &'a [u8],
}

/// The minimal validation both digests apply (module doc): the reference
/// is an economy key ([`check_holding_ref`], judged before any snapshot),
/// the holding and the province read as wide records, the Citizen has the
/// v2 size, the holding is the reference's and the province is the
/// holding's.
pub fn check_snapshots(holding: &WideHostRef, s: &Snapshots<'_>) -> Result<(), EconomyError> {
    check_holding_ref(holding)?;
    let h = WideHolding::read(s.holding)?;
    let p = WideProvince::read(s.province)?;
    if s.citizen.len() != C2::SIZE {
        return Err(EconomyError::Citizen {
            expected: C2::SIZE,
            got: s.citizen.len(),
        });
    }
    let key = holding.key();
    if h.world != key.world()
        || h.coord != key.coord()
        || h.site != holding.site()
        || h.gen != holding.gen()
    {
        return Err(EconomyError::Identity);
    }
    if p.season_id != h.season_id || p.world != h.world || p.coord != h.coord {
        return Err(EconomyError::Identity);
    }
    Ok(())
}

fn len64(b: &[u8]) -> [u8; 8] {
    (b.len() as u64).to_le_bytes()
}

/// `sha256(INPUT_DOMAIN ‖ key 56 ‖ action 6 ‖ LE64(now_ts) ‖ LE64(|season|)
/// ‖ season ‖ LE64(|citizen|) ‖ citizen ‖ LE64(|holding|) ‖ holding ‖
/// LE64(|province|) ‖ province)`: the holding reference (sequence 0), the
/// action, the clock, and the complete Season, Citizen, holding and
/// province bytes **as read**, chain headers included (module doc). The
/// snapshots are validated first ([`check_snapshots`]); the Season bytes
/// are committed whole and not interpreted.
pub fn input_digest(
    holding: &WideHostRef,
    action: Action,
    now_ts: i64,
    season: &[u8],
    before: &Snapshots<'_>,
) -> Result<[u8; 32], EconomyError> {
    let key = economy_key(holding)?;
    let a = action.checked_bytes()?;
    check_snapshots(holding, before)?;
    Ok(sha256(&[
        INPUT_DOMAIN,
        &key,
        &a,
        &now_ts.to_le_bytes(),
        &len64(season),
        season,
        &len64(before.citizen),
        before.citizen,
        &len64(before.holding),
        before.holding,
        &len64(before.province),
        before.province,
    ]))
}

/// `sha256(OUTPUT_DOMAIN ‖ key 56 ‖ action 6 ‖ LE64(now_ts) ‖ became_final
/// ‖ LE64(|citizen|) ‖ citizen ‖ LE64(|holding|) ‖ normalized holding ‖
/// LE64(|province|) ‖ normalized province)`: the same identity, action and
/// clock, the flip, the complete Citizen bytes after, and the holding and
/// province bytes after with their chain headers zeroed
/// (`event::normalize_chained`), so the digest is independent of the
/// record's own link (module doc). Validated first ([`check_snapshots`]).
pub fn output_digest(
    holding: &WideHostRef,
    action: Action,
    now_ts: i64,
    became_final: bool,
    after: &Snapshots<'_>,
) -> Result<[u8; 32], EconomyError> {
    let key = economy_key(holding)?;
    let a = action.checked_bytes()?;
    check_snapshots(holding, after)?;
    let h: Vec<u8> = normalize_chained(after.holding);
    let p: Vec<u8> = normalize_chained(after.province);
    Ok(sha256(&[
        OUTPUT_DOMAIN,
        &key,
        &a,
        &now_ts.to_le_bytes(),
        &[became_final as u8],
        &len64(after.citizen),
        after.citizen,
        &len64(&h),
        &h,
        &len64(&p),
        &p,
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ranges are the deployed handlers' and nothing else decodes.
    #[test]
    fn action_ranges_follow_the_deployed_handlers() {
        assert_eq!(ACTION_LEN, 6);
        assert_eq!((TAG_HARVEST, TAG_BUILD, TAG_TRAIN, TAG_MAX), (0, 1, 2, 2));
        assert_eq!(
            (BUILD_ITEM_WALLS, BUILD_ITEM_TIER_UP, BUILD_ITEM_MAX),
            (6, 7, 8)
        );
        assert_eq!(TRAIN_UNITS, 7);
        // the handler's own refusal set, by the same tables
        for item in 0..=u8::MAX {
            let deployed_refuses = item > ITEM_COUNT && item != ITEM_WORKSHOP;
            assert_eq!(
                Action::decode(&[TAG_BUILD, item, 0, 0, 0, 0]).is_err(),
                deployed_refuses,
                "item {item}"
            );
        }
        for unit in 0..=u8::MAX {
            let deployed_refuses = permutation_rules::frontier::arms::train_v3(unit, 1).is_none();
            assert_eq!(
                Action::decode(&[TAG_TRAIN, unit, 1, 0, 0, 0]).is_err(),
                deployed_refuses,
                "unit {unit}"
            );
        }
        assert!(permutation_rules::frontier::arms::train_v3(0, 0).is_none());
        assert_eq!(
            Action::decode(&[TAG_TRAIN, 0, 0, 0, 0, 0]),
            Err(EconomyError::Count)
        );
    }
}
