//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **wide roster**, the full-identity side table of a wide province's
//! entry table.
//!
//! A wide province is the whole Province v2 layout, so its 56 roster
//! entries carry a `u64 id` the deployed readers parse as a dense host id.
//! A wide host's entry carries the roster **alias** instead
//! (`march::wide_host_alias`: top bit set, refused by every dense-id
//! parser), and the full 56-byte reference it stands for lives here, at
//! the same index, in a record at `with_seed(season, wo ‖ hash(province
//! key))`. The record's header names the province whose entry table it
//! mirrors: the province the hosts **stand in**, which is not in general
//! the province that issued them (a host marches on; its reference keeps
//! its home holding's key for good). The table therefore accepts any host
//! of the same **world**; a cross-world reference is refused.
//!
//! **Authentication.** Every method takes the roster it expects (`&self`)
//! and refuses bytes whose header is not that roster's, so a record of one
//! province can never be read or written as another's. Every write of an
//! alias into the entry table must go through [`WideRoster::claim`], which
//! runs `march::claim_alias` over the whole table (every stored alias
//! authenticated against its own reference, no alias under two
//! references, no reference twice). Every read of an entry must check
//! [`WideRoster::entry_matches`] (the entry's `u64` is the alias of the
//! reference stored at its index). [`WideRoster::table`] **regenerates**
//! the aliases from the stored references: it proves what this record
//! vouches for, not what the Province's entry table actually holds;
//! [`WideRoster::validate_paired`] is the explicit check of the two
//! against each other that a handler must run before trusting either.
//!
//! The camp and the keep are tagged combat identities
//! (`march::WideCombatant`), never roster entries; the table stores hosts
//! only. **No handler writes or reads this record yet** (no wide Muster
//! exists); it is the layout a wide Muster, Depart, SettleDeparture and the
//! clash gather must share.

use super::key::{KeyError, ProvinceKey, WideHostRef, HOST_REF_LEN};
use super::land::WIDE_LAND_FAMILY_VERSION;
use super::march::{claim_alias, is_wide_alias, wide_host_alias, AliasError};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_u16, rd_u64, wr_arr, wr_u16, wr_u64};
use crate::layout::province::province::ENTRIES_N;
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

/// Seed tag of a wide roster (**provisional**; not a kernel `SeedKind`).
pub const ROSTER_TAG: [u8; 2] = *b"wo";
pub const ROSTER_SEED_DOMAIN: &[u8] = b"PSF-WIDE-ROSTER-SEED-v1";

/// The wide roster record (3,248 B): header, the province key, then one
/// 56-byte reference per Province entry index (all zero: no wide host at
/// that index). **Provisional magic.**
pub mod wide_roster {
    crate::layout::fields!(size = 3_248;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RSV_18 @ 18 : "rsv" = 6;
        WORLD @ 24 : "[u8;32]" = 32;
        SORT_KEY @ 56 : "[u8;17]" = 17;
        RSV_73 @ 73 : "rsv" = 7;
        RENT_TO @ 80 : "[u8;32]" = 32;
        REFS @ 112 : "[[u8;56];56]" = 3_136;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWRO2";

    /// Offset of the reference at Province entry index `i`.
    pub const fn slot(i: usize) -> usize {
        REFS + i * super::HOST_REF_LEN
    }
}

const _: () = assert!(wide_roster::REFS + ENTRIES_N * HOST_REF_LEN == wide_roster::SIZE);

/// Why a roster record or a roster write is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RosterError {
    Length {
        expected: usize,
        got: usize,
    },
    Magic,
    Version {
        expected: u16,
        got: u16,
    },
    Reserved,
    Key(KeyError),
    /// The bytes' header is not this roster's (season, world or province).
    Header,
    /// An index at or above 56.
    Index(usize),
    /// A reference of another world than the roster's.
    World,
    /// The alias check refused the write.
    Alias(AliasError),
    /// The slot is not empty.
    Occupied(usize),
    /// The Province's entry at `index` and this table disagree: a live
    /// wide alias without a reference, a reference without a live entry,
    /// or an entry whose alias is not the stored reference's.
    Paired {
        index: usize,
    },
}

impl From<KeyError> for RosterError {
    fn from(e: KeyError) -> Self {
        RosterError::Key(e)
    }
}

/// `wo ‖ hex(sha256(domain ‖ province key)[..15])`.
pub fn roster_seed(province: ProvinceKey) -> Seed {
    let h = sha256(&[ROSTER_SEED_DOMAIN, &province.to_bytes()]);
    Seed::new(ROSTER_TAG, &h[..15])
}

/// `with_seed(season, wo ‖ hash(province key), program)`.
pub fn roster_address(ctx: &AddrCtx, province: ProvinceKey) -> [u8; 32] {
    ctx.of(&roster_seed(province))
}

/// A wide roster's header, decoded; the references are read in place
/// through the methods, each of which first checks the bytes are this
/// roster's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideRoster {
    pub season_id: u64,
    /// The province whose entry table this record mirrors (where the
    /// hosts stand).
    pub province: ProvinceKey,
    /// Immutable original funder, retained for cleanup after Province closure.
    pub rent_to: [u8; 32],
}

impl WideRoster {
    /// A fresh roster of `province` for `season_id`.
    pub const fn new(season_id: u64, province: ProvinceKey, rent_to: [u8; 32]) -> WideRoster {
        WideRoster {
            season_id,
            province,
            rent_to,
        }
    }

    /// Decodes the header of exactly `wide_roster::SIZE` bytes.
    pub fn read(d: &[u8]) -> Result<WideRoster, RosterError> {
        use wide_roster as L;
        if d.len() != L::SIZE {
            return Err(RosterError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = RosterError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(RosterError::Magic);
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(RosterError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        for (o, n) in [(L::RSV_18, 6usize), (L::RSV_73, 7)] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(RosterError::Reserved);
            }
        }
        let w = super::key::WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?;
        let k: [u8; super::coord::SORT_KEY_LEN] = rd_arr(d, L::SORT_KEY).ok_or(t)?;
        let c = super::coord::WideCoord::from_sort_key(&k).map_err(KeyError::Coord)?;
        Ok(WideRoster {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            province: ProvinceKey::new(w, c),
            rent_to: rd_arr(d, L::RENT_TO).ok_or(t)?,
        })
    }

    /// Writes the header (the references are untouched).
    pub fn write_header(&self, d: &mut [u8]) -> Result<(), RosterError> {
        use wide_roster as L;
        if d.len() != L::SIZE {
            return Err(RosterError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_arr(d, L::RSV_18, &[0u8; 6])
            & wr_arr(d, L::WORLD, self.province.world().as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.province.coord().sort_key())
            & wr_arr(d, L::RSV_73, &[0u8; 7])
            & wr_arr(d, L::RENT_TO, &self.rent_to);
        if ok {
            Ok(())
        } else {
            Err(RosterError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }

    /// The bytes decode to exactly this roster (`Header` otherwise).
    fn check(&self, d: &[u8]) -> Result<(), RosterError> {
        if Self::read(d)? == *self {
            Ok(())
        } else {
            Err(RosterError::Header)
        }
    }

    /// The reference stored at `i`, without the header check (the
    /// methods run it first).
    fn raw_ref_at(d: &[u8], i: usize) -> Result<Option<WideHostRef>, RosterError> {
        if i >= ENTRIES_N {
            return Err(RosterError::Index(i));
        }
        let o = wide_roster::slot(i);
        let s = d.get(o..o + HOST_REF_LEN).ok_or(RosterError::Length {
            expected: wide_roster::SIZE,
            got: d.len(),
        })?;
        if s.iter().all(|b| *b == 0) {
            return Ok(None);
        }
        Ok(Some(WideHostRef::from_bytes(s)?))
    }

    /// The reference at Province entry index `i` of this roster's bytes,
    /// `None` when empty.
    pub fn ref_at(&self, d: &[u8], i: usize) -> Result<Option<WideHostRef>, RosterError> {
        self.check(d)?;
        let r = Self::raw_ref_at(d, i)?;
        if r.is_some_and(|h| h.key().world() != self.province.world()) {
            return Err(RosterError::World);
        }
        Ok(r)
    }

    /// Every filled index as `(index, alias, reference)`, the table
    /// `march::claim_alias` checks. The aliases are **regenerated** from
    /// the stored references: this is what the record vouches for, not
    /// what the Province's entries hold ([`WideRoster::validate_paired`]).
    pub fn table(&self, d: &[u8]) -> Result<Vec<(usize, u64, WideHostRef)>, RosterError> {
        self.check(d)?;
        let mut out = Vec::new();
        for i in 0..ENTRIES_N {
            if let Some(h) = Self::raw_ref_at(d, i)? {
                if h.key().world() != self.province.world() {
                    return Err(RosterError::World);
                }
                out.push((i, wide_host_alias(&h), h));
            }
        }
        Ok(out)
    }

    /// The authenticated roster write: the bytes this roster's (`Header`),
    /// `host` of this world (`World`; its home province may be any), slot
    /// `i` empty (`Occupied`), and `claim_alias` over the whole table must
    /// accept it (`Alias`). Writes the reference at `i` and returns the
    /// alias the Province entry must carry at the same index. Nothing is
    /// written on a refusal.
    pub fn claim(&self, d: &mut [u8], i: usize, host: &WideHostRef) -> Result<u64, RosterError> {
        if host.key().world() != self.province.world() {
            return Err(RosterError::World);
        }
        if self.ref_at(d, i)?.is_some() {
            return Err(RosterError::Occupied(i));
        }
        let table: Vec<(u64, WideHostRef)> =
            self.table(d)?.into_iter().map(|(_, a, h)| (a, h)).collect();
        let alias = claim_alias(&table, host).map_err(RosterError::Alias)?;
        let o = wide_roster::slot(i);
        d[o..o + HOST_REF_LEN].copy_from_slice(&host.to_bytes());
        Ok(alias)
    }

    /// Frees index `i` (the entry left the roster).
    pub fn release(&self, d: &mut [u8], i: usize) -> Result<Option<WideHostRef>, RosterError> {
        let was = self.ref_at(d, i)?;
        let o = wide_roster::slot(i);
        d[o..o + HOST_REF_LEN].fill(0);
        Ok(was)
    }

    /// Whether a Province entry's `u64 id` at index `i` is the alias of
    /// `host`, and `host` is the reference stored at `i` of this roster's
    /// bytes: the check every reader of a wide province's entry must make
    /// before trusting the entry as `host`'s.
    pub fn entry_matches(&self, d: &[u8], i: usize, entry_id: u64, host: &WideHostRef) -> bool {
        matches!(
            self.ref_at(d, i),
            Ok(Some(h)) if h == *host && wide_host_alias(&h) == entry_id
        )
    }

    /// The explicit pairing check of the Province's entry table against
    /// this record: `entries[i]` is the `u64 id` of the Province's entry
    /// `i` when that entry is live (states 1–3), `None` when free. Every
    /// live wide alias must have the reference it is the alias of at the
    /// same index, every stored reference must have its live alias, and a
    /// live id that is not a wide alias (a dense id) must have no reference
    /// (`Paired { index }` otherwise). A handler must run this before it
    /// trusts either table for a wide host.
    pub fn validate_paired(
        &self,
        d: &[u8],
        entries: &[Option<u64>; ENTRIES_N],
    ) -> Result<(), RosterError> {
        self.check(d)?;
        let aliases: Vec<_> = self.table(d)?.into_iter().map(|(_, a, h)| (a, h)).collect();
        super::march::validate_alias_table(&aliases).map_err(RosterError::Alias)?;
        for (i, e) in entries.iter().enumerate() {
            let stored = Self::raw_ref_at(d, i)?;
            if stored.is_some_and(|h| h.key().world() != self.province.world()) {
                return Err(RosterError::World);
            }
            let ok = match (e, stored) {
                (Some(id), Some(h)) => is_wide_alias(*id) && wide_host_alias(&h) == *id,
                (Some(id), None) => !is_wide_alias(*id),
                (None, Some(_)) => false,
                (None, None) => true,
            };
            if !ok {
                return Err(RosterError::Paired { index: i });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Field;
    use crate::world_index::coord::WideCoord;
    use crate::world_index::key::WorldId;

    fn tiles(size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{} at {} not {at}", f.name, f.off);
            at += f.len;
        }
        assert_eq!(at, size);
    }

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn key(p: i64, q: i64) -> ProvinceKey {
        ProvinceKey::new(world(0x77), WideCoord::checked(p, q).unwrap())
    }

    /// A host of province `(p, q)` of the roster's world.
    fn r(p: i64, q: i64, site: u8, gen: u8, seq: u32) -> WideHostRef {
        WideHostRef::new(key(p, q), site, gen, seq).unwrap()
    }

    fn fresh(ro: &WideRoster) -> std::vec::Vec<u8> {
        let mut d = std::vec![0u8; wide_roster::SIZE];
        ro.write_header(&mut d).unwrap();
        d
    }

    #[test]
    fn duplicate_existing_hosts_and_refund_header_substitution_are_refused() {
        let ro = WideRoster::new(11, key(129, 0), [0xa1; 32]);
        let mut d = fresh(&ro);
        let host = r(130, 0, 1, 2, 3);
        let alias = ro.claim(&mut d, 0, &host).unwrap();
        let wrong_payer = WideRoster {
            rent_to: [0xb2; 32],
            ..ro
        };
        assert_eq!(wrong_payer.ref_at(&d, 0), Err(RosterError::Header));
        assert_eq!(WideRoster::read(&d).unwrap().rent_to, [0xa1; 32]);
        // Both paired tables contain the same host twice: local per-index
        // alias checks alone would miss the duplicate.
        assert!(wr_arr(&mut d, wide_roster::slot(1), &host.to_bytes()));
        let mut entries = [None; ENTRIES_N];
        entries[0] = Some(alias);
        entries[1] = Some(alias);
        assert_eq!(
            ro.validate_paired(&d, &entries),
            Err(RosterError::Alias(AliasError::AlreadyPresent { alias }))
        );
        let before = d.clone();
        assert_eq!(
            ro.claim(&mut d, 2, &r(131, 0, 2, 0, 1)),
            Err(RosterError::Alias(AliasError::AlreadyPresent { alias }))
        );
        assert_eq!(d, before);
    }

    #[test]
    fn layout_is_one_reference_per_province_entry() {
        tiles(wide_roster::SIZE, wide_roster::FIELDS);
        assert_eq!(ENTRIES_N, 56);
        assert_eq!(wide_roster::slot(55) + HOST_REF_LEN, wide_roster::SIZE);
        assert_eq!(&wide_roster::MAGIC[..4], b"PSFX");
        assert_eq!(
            crate::layout::AccountKind::from_magic(&wide_roster::MAGIC),
            None
        );
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&ROSTER_TAG),
            None
        );
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        let a = roster_address(&ctx, key(129, 0));
        assert_eq!(a, roster_address(&ctx, key(129, 0)));
        assert_ne!(a, roster_address(&ctx, key(129, 1)));
        assert_ne!(
            a,
            crate::world_index::land::province_address(&ctx, key(129, 0).coord())
        );
    }

    #[test]
    fn header_round_trips_and_refuses_bad_bytes() {
        let ro = WideRoster::new(11, key(129, 0), [0xa1; 32]);
        let d = fresh(&ro);
        assert_eq!(WideRoster::read(&d), Ok(ro));
        assert_eq!(
            WideRoster::read(&d[..10]),
            Err(RosterError::Length {
                expected: 3_248,
                got: 10
            })
        );
        let mut x = d.clone();
        x[0] ^= 1;
        assert_eq!(WideRoster::read(&x), Err(RosterError::Magic));
        let mut x = d.clone();
        x[wide_roster::FAMILY_VERSION] = 9;
        assert!(matches!(
            WideRoster::read(&x),
            Err(RosterError::Version { got: 9, .. })
        ));
        let mut x = d.clone();
        x[wide_roster::RSV_73 + 2] = 1;
        assert_eq!(WideRoster::read(&x), Err(RosterError::Reserved));
        let mut x = d.clone();
        x[wide_roster::WORLD..wide_roster::WORLD + 32].fill(0);
        assert_eq!(
            WideRoster::read(&x),
            Err(RosterError::Key(KeyError::ReservedWorld))
        );
        for i in 0..ENTRIES_N {
            assert_eq!(ro.ref_at(&d, i), Ok(None));
        }
        assert_eq!(ro.ref_at(&d, 56), Err(RosterError::Index(56)));
    }

    /// Every method refuses bytes whose header is another roster's (another
    /// province, another season): no record is read or written as another.
    #[test]
    fn every_method_checks_the_bytes_are_this_rosters() {
        let a = WideRoster::new(11, key(129, 0), [0xa1; 32]);
        let b = WideRoster::new(11, key(130, -1), [0xb1; 32]);
        let other_season = WideRoster::new(12, key(129, 0), [0xc1; 32]);
        let mut d = fresh(&a);
        let host = r(129, 0, 2, 1, 1);
        a.claim(&mut d, 0, &host).unwrap();
        for wrong in [b, other_season] {
            assert_eq!(wrong.ref_at(&d, 0), Err(RosterError::Header));
            assert_eq!(wrong.table(&d), Err(RosterError::Header));
            assert_eq!(
                wrong.claim(&mut d, 1, &r(130, -1, 1, 1, 1)),
                Err(RosterError::Header)
            );
            assert_eq!(wrong.release(&mut d, 0), Err(RosterError::Header));
            assert!(!wrong.entry_matches(&d, 0, wide_host_alias(&host), &host));
            let entries = [None; ENTRIES_N];
            assert_eq!(
                wrong.validate_paired(&d, &entries),
                Err(RosterError::Header)
            );
        }
        assert_eq!(a.ref_at(&d, 0), Ok(Some(host)), "untouched by the refusals");
        assert_eq!(a.ref_at(&d, 1), Ok(None));
        // malformed bytes are refused the same way, before any read
        let mut x = d.clone();
        x[0] ^= 1;
        assert_eq!(a.ref_at(&x, 0), Err(RosterError::Magic));
        assert_eq!(
            a.claim(&mut x, 1, &r(129, 0, 3, 1, 1)),
            Err(RosterError::Magic)
        );
    }

    /// The authenticated write: an onward arrival (a host whose home is
    /// another province of the same world) is a normal entry; the alias
    /// returned is the reference's; a cross-world host, a second write of
    /// the same reference, an occupied slot and a stored reference the
    /// table cannot vouch for are refused; a release frees the slot; the
    /// entry check reads the full reference.
    #[test]
    fn claims_are_authenticated_against_the_whole_table() {
        let ro = WideRoster::new(11, key(129, 0), [0xa1; 32]);
        let mut d = fresh(&ro);
        // a host of this very province, and a host that marched here from
        // (130, -1) and from the far side of the world
        let home = r(129, 0, 2, 1, 1);
        let onward = r(130, -1, 4, 2, 9);
        let far = WideHostRef::new(
            ProvinceKey::new(
                world(0x77),
                WideCoord::checked((1i64 << 40) + 129, -(1i64 << 40)).unwrap(),
            ),
            1,
            1,
            1,
        )
        .unwrap();
        let a_home = ro.claim(&mut d, 0, &home).unwrap();
        let a_onward = ro.claim(&mut d, 1, &onward).unwrap();
        let a_far = ro.claim(&mut d, 2, &far).unwrap();
        for (i, h, a) in [(0, home, a_home), (1, onward, a_onward), (2, far, a_far)] {
            assert_eq!(a, wide_host_alias(&h));
            assert!(is_wide_alias(a));
            assert_eq!(ro.ref_at(&d, i), Ok(Some(h)), "the full original identity");
            assert_eq!(
                ro.ref_at(&d, i).unwrap().unwrap().key(),
                h.key(),
                "home kept"
            );
            assert!(ro.entry_matches(&d, i, a, &h));
            assert!(!ro.entry_matches(&d, i, a ^ 1, &h));
        }
        assert!(!ro.entry_matches(&d, 0, a_home, &onward));
        assert!(!ro.entry_matches(&d, 1, a_home, &home));
        // a cross-world host, whatever its province
        let alien = WideHostRef::new(
            ProvinceKey::new(world(0x78), WideCoord::checked(129, 0).unwrap()),
            2,
            1,
            1,
        )
        .unwrap();
        assert_eq!(ro.claim(&mut d, 3, &alien), Err(RosterError::World));
        assert_eq!(
            ro.claim(&mut d, 3, &home),
            Err(RosterError::Alias(AliasError::AlreadyPresent {
                alias: a_home
            }))
        );
        assert_eq!(
            ro.claim(&mut d, 0, &r(129, 0, 5, 1, 1)),
            Err(RosterError::Occupied(0))
        );
        assert_eq!(ro.ref_at(&d, 3), Ok(None), "nothing written by a refusal");
        assert_eq!(
            ro.table(&d).unwrap(),
            std::vec![(0, a_home, home), (1, a_onward, onward), (2, a_far, far)]
        );
        // a stored cross-world reference written behind the API poisons the
        // table (every read, claim and pairing refuses) until released
        let o = wide_roster::slot(9);
        d[o..o + HOST_REF_LEN].copy_from_slice(&alien.to_bytes());
        assert_eq!(ro.ref_at(&d, 9), Err(RosterError::World));
        assert_eq!(ro.table(&d), Err(RosterError::World));
        assert_eq!(
            ro.claim(&mut d, 4, &r(129, 0, 6, 1, 1)),
            Err(RosterError::World)
        );
        d[o..o + HOST_REF_LEN].fill(0);
        assert_eq!(ro.release(&mut d, 0), Ok(Some(home)));
        assert_eq!(ro.ref_at(&d, 0), Ok(None));
        assert_eq!(ro.release(&mut d, 0), Ok(None));
        assert_eq!(ro.claim(&mut d, 0, &home), Ok(a_home), "free again");
    }

    /// The pairing check against the Province's actual entries: the record
    /// alone proves nothing about them.
    #[test]
    fn paired_validation_compares_the_entry_table_with_the_record() {
        let ro = WideRoster::new(11, key(129, 0), [0xa1; 32]);
        let mut d = fresh(&ro);
        let (h0, h1) = (r(129, 0, 2, 1, 1), r(130, -1, 4, 2, 9));
        let a0 = ro.claim(&mut d, 0, &h0).unwrap();
        let a1 = ro.claim(&mut d, 5, &h1).unwrap();
        let mut entries: [Option<u64>; ENTRIES_N] = [None; ENTRIES_N];
        entries[0] = Some(a0);
        entries[5] = Some(a1);
        // a legacy dense id in another live entry has no reference: fine
        entries[7] = Some(crate::addr::host_id(3, -1, 2, 1, 9).unwrap());
        assert_eq!(ro.validate_paired(&d, &entries), Ok(()));
        // the entry's alias is not the stored reference's
        let mut e = entries;
        e[5] = Some(a1 ^ 2);
        assert_eq!(
            ro.validate_paired(&d, &e),
            Err(RosterError::Paired { index: 5 })
        );
        // a stored reference whose entry is free: stale
        let mut e = entries;
        e[0] = None;
        assert_eq!(
            ro.validate_paired(&d, &e),
            Err(RosterError::Paired { index: 0 })
        );
        // a live wide alias without a reference
        let mut e = entries;
        e[8] = Some(wide_host_alias(&r(129, 0, 9, 1, 1)));
        assert_eq!(
            ro.validate_paired(&d, &e),
            Err(RosterError::Paired { index: 8 })
        );
        // a dense id where a reference is stored
        let mut e = entries;
        e[0] = Some(crate::addr::host_id(3, -1, 2, 1, 1).unwrap());
        assert_eq!(
            ro.validate_paired(&d, &e),
            Err(RosterError::Paired { index: 0 })
        );
        // the table regenerates aliases from the record and says nothing
        // about the entries: it is the same whatever `entries` holds
        assert_eq!(ro.table(&d).unwrap().len(), 2);
    }
}
