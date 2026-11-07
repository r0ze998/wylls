//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! versioned march record of a wide host and its **complete lifecycle**,
//! gated on a host identity that is not yet allocated.
//!
//! A legacy march is one transit record of the origin Holding (96 B,
//! `layout::player::transit`) keyed by a `u64` host id, settled at the
//! origin (SettleDeparture), revealed into an ArrivalSlot at the
//! destination (Reveal), gathered (GatherClash), resolved and finally
//! settled back (SettleTransit, which frees the record and returns or
//! strands the host). Every one of those stages keys the host by the same
//! `u64`, whose 20-bit dense province field no wide province has.
//!
//! This module states the wide form of that record over a `WideHostRef`
//! and a `ProvinceKey`, with the same fields and the same stage order
//! ([`MarchState`], [`MarchEvent`], [`step`]), so that every future stage
//! handler shares one identity and one state table. It does **not** price,
//! time, resolve or settle anything: the clash kernel, `host::march_values`,
//! `travel::check_arrival_bell` and the seal remain the only rules, and
//! the legacy handlers remain the only code that runs them. What it adds
//! is the invariant the owner asked for: [`WideTransit::depart`] refuses
//! [`MarchError::HostIdentityUnallocated`] while
//! [`super::holding::HOST_IDENTITY_UNALLOCATED`] is the only identity
//! version, so **no wide march can be debited before the identity that
//! could settle it exists**, and [`step`] refuses every transition the
//! legacy lifecycle does not have.
//!
//! **The experimental identity proposal (fourth slice, 2026-11-07).** The host identity
//! version [`HOST_IDENTITY_FULL_REF_V1`] names the shape every wide march
//! stage must share, so that the stages can be written one by one against
//! one definition and never against a shortened id:
//!
//! * the **canonical identity** of a wide host is the 56-byte
//!   [`WideHostRef`] (`world ‖ 17-byte sort key ‖ site ‖ gen ‖ seq`), never
//!   a `u64`: it is what a transit record, an arrival, a gather and a
//!   settle key the host by, and what every ownership check compares
//!   (`holding_ref` for the issuing holding, as `holding_key_of_host`);
//! * the **roster alias** [`wide_host_alias`] is the `u64` a wide
//!   province's entry table and a Holding-layout transit slot can carry
//!   for *lookup only*: its top bit is set, so `addr::split_host_id` and
//!   every legacy reader refuse it, and it is **not** an input of any
//!   kernel formula (the reviewer's finding: `tie_key(cs, id)`,
//!   `slot_key(P, Q, bell, id)`, `clash_seed(seed, P, Q, bell)` and the
//!   retreat's `wedge` are legacy byte formulas over the dense id and the
//!   `i32` pair, and a sorted local index or a hash fed into them would
//!   re-roll unrelated outcomes whenever another host is inserted);
//! * the **wide formulas** [`wide_slot_key`], [`wide_tie_key`] and
//!   [`wide_clash_seed`] are the explicit, domain-separated full-identity
//!   counterparts a wide reveal, gather and resolve must use instead. They
//!   are experimental versioning for the wide path only; the legacy path
//!   keeps its formulas byte for byte, and no production rule is decided
//!   by their existence;
//! * the **transit record** of a wide march is this module's 256-byte
//!   [`WideTransit`] at [`transit_address`] (`with_seed(season, wm ‖
//!   hash(holding ‖ slot))`), not the 96-byte slot inside the Holding
//!   layout, which cannot carry the identity; the slot keeps only the
//!   alias and the legacy `in_transit` state so `prologue::host_in_transit`
//!   keeps refusing a second departure.
//!
//! **What is not here.** No wide holding carries
//! [`HOST_IDENTITY_FULL_REF_V1`]: `WideHolding::read` still refuses any
//! version but the unallocated one, so no wide host can be mustered, no
//! march can be debited and [`WideTransit::depart`] keeps refusing the
//! program's version 0. Allocating the version to a holding is the step
//! that would need a wide Muster, Reveal, Gather, Resolve, SettleDeparture
//! and SettleTransit to exist first (`WIDE-LAND-WRITER.md` §−2).

use super::key::{KeyError, ProvinceKey, WideHostRef, HOST_REF_LEN, PROVINCE_KEY_LEN};
use super::tiles::{TileAddress, TileError};
use crate::addr::{AddrCtx, Seed as AddrSeed};
use crate::bytes::{
    rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u16, wr_u32, wr_u64, wr_u8,
};
use crate::layout::player::transit as T;
use alloc::vec::Vec;
use permutation_rules::frontier::clash::{
    resolve_clash_core, ClashErrorOf, ClashIdentity, ClashInputOf, Fate, FighterOf,
    FighterResultOf, GarrisonOf, GarrisonResultOf,
};
use permutation_rules::frontier::geometry::PROVINCE_TILES;
use permutation_rules::hash::sha256;
use permutation_rules::params::Ruleset;
use permutation_rules::rng::{rand, Seed};

/// Layout version of the wide transit bytes.
pub const WIDE_TRANSIT_VERSION: u8 = 1;
/// Bytes of a wide transit record.
pub const WIDE_TRANSIT_LEN: usize = 256;

/// The one allocated wide host identity version (module doc): the
/// canonical identity is the full [`WideHostRef`]; the roster alias is
/// [`wide_host_alias`]; the formulas are the `wide_*` ones. Every wide
/// holding is founded under `holding::HOST_IDENTITY_UNALLOCATED`; the
/// experimental program writes this version at the holding's **first wide
/// Muster** (`WideHolding::allocate_identity`), once the closed muster /
/// resolve / dissolve / return path exists for the hosts it debits. A
/// departure stays refused under it (no wide transit exists). Not a
/// production protocol number.
pub const HOST_IDENTITY_FULL_REF_V1: u16 = 1;

/// Domain of [`wide_host_alias`].
pub const HOST_ALIAS_DOMAIN: &[u8] = b"PSF-WIDE-HOST-ALIAS-v1";
/// The bit every alias carries and no legacy host id can (a legacy id's
/// province index is below `2^20`, so bits 63..=64 are clear).
pub const HOST_ALIAS_BIT: u64 = 1 << 63;
/// Seed tag of a wide transit record (**provisional**; not a kernel
/// `SeedKind`).
pub const TRANSIT_TAG: [u8; 2] = *b"wm";
/// Domain of the hashed raw key of a wide transit record.
pub const TRANSIT_SEED_DOMAIN: &[u8] = b"PSF-WIDE-TRANSIT-SEED-v1";
/// `rng::rand` domains of the wide formulas (distinct from the legacy
/// `frontier/slot`, `tie` and `frontier/clash`).
pub const SLOT_DOMAIN_WIDE: &[u8] = b"frontier/slot/wide-v1";
pub const TIE_DOMAIN_WIDE: &[u8] = b"tie/wide-v1";
pub const CLASH_DOMAIN_WIDE: &[u8] = b"frontier/clash/wide-v1";

/// The `u64` a wide province's entry table may carry for a wide host, for
/// lookup only: `HOST_ALIAS_BIT | sha256(HOST_ALIAS_DOMAIN ‖ host
/// ref)[..8] >> 1`. Refused by `addr::split_host_id` (its province index
/// field is at least `2^19`), so no legacy reader can mistake it for a
/// dense id, and never an input of a kernel formula (module doc).
pub fn wide_host_alias(host: &WideHostRef) -> u64 {
    let h = sha256(&[HOST_ALIAS_DOMAIN, &host.to_bytes()]);
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    HOST_ALIAS_BIT | (u64::from_le_bytes(b) >> 1)
}

/// Whether a `u64` in an entry table is a wide alias (the top bit).
pub const fn is_wide_alias(id: u64) -> bool {
    id & HOST_ALIAS_BIT != 0
}

/// `wm ‖ hex(sha256(TRANSIT_SEED_DOMAIN ‖ holding ‖ slot)[..15])`: the seed
/// of the wide transit record of transit slot `slot` of the wide holding
/// at `holding`.
pub fn transit_seed(holding: &[u8; 32], slot: u8) -> AddrSeed {
    let h = sha256(&[TRANSIT_SEED_DOMAIN, holding, &[slot]]);
    AddrSeed::new(TRANSIT_TAG, &h[..15])
}

/// `with_seed(season, wm ‖ hash(holding ‖ slot), program)`.
pub fn transit_address(ctx: &AddrCtx, holding: &[u8; 32], slot: u8) -> [u8; 32] {
    ctx.of(&transit_seed(holding, slot))
}

/// The province-and-bell seed the wide formulas hash under: `sha256(domain
/// ‖ world ‖ sort key ‖ LE32(bell))`, the full coordinate where the legacy
/// formulas take the `i32` pair.
fn province_bell_seed(domain: &[u8], key: ProvinceKey, bell: u32) -> Seed {
    sha256(&[
        domain,
        key.world().as_bytes(),
        &key.coord().sort_key(),
        &bell.to_le_bytes(),
    ])
}

/// The wide counterpart of the kernel's `slot_key(P, Q, bell, host_id)`
/// (the arrival quota's ranking key): the full province key and the full
/// host reference under [`SLOT_DOMAIN_WIDE`]. Experimental; used by no
/// handler yet (module doc).
pub fn wide_slot_key(key: ProvinceKey, bell: u32, host: &WideHostRef) -> u64 {
    let seed = province_bell_seed(SLOT_DOMAIN_WIDE, key, bell);
    rand(&seed, SLOT_DOMAIN_WIDE, &host.to_bytes())
}

/// The wide counterpart of `rng::tie_key(seed, id)` (the clash's unit
/// tie-break) over the full host reference under [`TIE_DOMAIN_WIDE`].
pub fn wide_tie_key(seed: &Seed, host: &WideHostRef) -> u64 {
    rand(seed, TIE_DOMAIN_WIDE, &host.to_bytes())
}

/// The wide counterpart of the kernel's `clash_seed(seed, P, Q, bell)`:
/// `sha256(CLASH_DOMAIN_WIDE ‖ seed ‖ world ‖ sort key ‖ LE32(bell))`.
pub fn wide_clash_seed(seed: &Seed, key: ProvinceKey, bell: u32) -> Seed {
    sha256(&[
        CLASH_DOMAIN_WIDE,
        seed,
        key.world().as_bytes(),
        &key.coord().sort_key(),
        &bell.to_le_bytes(),
    ])
}

// ------------------------------------------------------------ the wide clash

/// Tag byte of a [`WideCombatant`] in its bytes and its engagement key.
pub const COMBATANT_TAG_HOST: u8 = 1;
pub const COMBATANT_TAG_CAMP: u8 = 2;
pub const COMBATANT_TAG_KEEP: u8 = 3;
/// Bytes of a combatant: tag, then a 56-byte payload (a host reference, or
/// a 50-byte province key ‖ synthetic marker ‖ LE32 generation ‖ zero byte).
pub const COMBATANT_LEN: usize = 1 + HOST_REF_LEN;

/// What fights in a wide clash: the kernel's identity scheme
/// (`clash::ClashIdentity`; experimental, decides no production rule). A
/// **host** is a strict [`WideHostRef`] (the host codec decodes no other
/// site); the **camp** and the **keep** are the province's synthetic
/// garrisons, tagged variants that carry the province key and the full
/// `u32` generation the deployed records keep (no truncation, no repeated
/// derivation), so they can never be read as a host and no host can be
/// read as one of them. Residents and arrivals must be hosts
/// ([`resolve_wide_clash`] refuses a synthetic fighter); garrisons may be
/// any variant (a holding's garrison is `Host(holding_ref)`, as the legacy
/// garrison id is `host_id(P, Q, site, gen, 0)`).
///
/// The province is the world-scoped [`ProvinceKey`]; the clash seed is
/// [`wide_clash_seed`]; a host's tie key is [`wide_tie_key`] (a synthetic
/// garrison has none: the kernel gives garrisons no tie); the engagement
/// key is `city ‖ tag ‖ payload`; the withdraw search turns by the
/// coordinate's **exact geometric wedge** (`WideCoord::wedge`, the legacy
/// `ProvinceCoord::wedge` rule, 0 for the Concord: no new retreat rule);
/// the sorts are the stable `sort_by_key` over the variant's own order
/// (hosts first, then camps, then keeps; within a variant the key's
/// order). The roster alias ([`wide_host_alias`]) is never read here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WideCombatant {
    Host(WideHostRef),
    Camp { key: ProvinceKey, gen: u32 },
    Keep { key: ProvinceKey, gen: u32 },
}

impl WideCombatant {
    /// The host behind a `Host`; `None` for a synthetic garrison.
    pub const fn host(&self) -> Option<WideHostRef> {
        match self {
            WideCombatant::Host(h) => Some(*h),
            _ => None,
        }
    }

    /// A synthetic garrison identity (the camp or the keep).
    pub const fn is_synthetic(&self) -> bool {
        !matches!(self, WideCombatant::Host(_))
    }

    /// The province the combatant belongs to (a host's issuing province).
    pub const fn province(&self) -> ProvinceKey {
        match self {
            WideCombatant::Host(h) => h.key(),
            WideCombatant::Camp { key, .. } | WideCombatant::Keep { key, .. } => *key,
        }
    }

    /// `tag ‖ payload` (module doc).
    pub fn to_bytes(&self) -> [u8; COMBATANT_LEN] {
        let mut b = [0u8; COMBATANT_LEN];
        match self {
            WideCombatant::Host(h) => {
                b[0] = COMBATANT_TAG_HOST;
                b[1..].copy_from_slice(&h.to_bytes());
            }
            WideCombatant::Camp { key, gen } | WideCombatant::Keep { key, gen } => {
                b[0] = if matches!(self, WideCombatant::Camp { .. }) {
                    COMBATANT_TAG_CAMP
                } else {
                    COMBATANT_TAG_KEEP
                };
                b[1..1 + PROVINCE_KEY_LEN].copy_from_slice(&key.to_bytes());
                b[1 + PROVINCE_KEY_LEN] = 0xfc | b[0];
                b[2 + PROVINCE_KEY_LEN..2 + PROVINCE_KEY_LEN + 4]
                    .copy_from_slice(&gen.to_le_bytes());
            }
        }
        b
    }

    /// Inverse of [`WideCombatant::to_bytes`]: a known tag, a strict host
    /// reference or a province key, a disjoint synthetic marker, full generation and zero pad.
    pub fn from_bytes(b: &[u8]) -> Result<WideCombatant, MarchError> {
        if b.len() != COMBATANT_LEN {
            return Err(MarchError::Length {
                expected: COMBATANT_LEN,
                got: b.len(),
            });
        }
        match b[0] {
            COMBATANT_TAG_HOST => Ok(WideCombatant::Host(WideHostRef::from_bytes(&b[1..])?)),
            t @ (COMBATANT_TAG_CAMP | COMBATANT_TAG_KEEP) => {
                let key = ProvinceKey::from_bytes(&b[1..1 + PROVINCE_KEY_LEN])?;
                let mut g = [0u8; 4];
                g.copy_from_slice(&b[2 + PROVINCE_KEY_LEN..2 + PROVINCE_KEY_LEN + 4]);
                if b[1 + PROVINCE_KEY_LEN] != (0xfc | t)
                    || b[2 + PROVINCE_KEY_LEN + 4..].iter().any(|x| *x != 0)
                {
                    return Err(MarchError::Reserved);
                }
                let gen = u32::from_le_bytes(g);
                Ok(if t == COMBATANT_TAG_CAMP {
                    WideCombatant::Camp { key, gen }
                } else {
                    WideCombatant::Keep { key, gen }
                })
            }
            t => Err(MarchError::CombatantTag(t)),
        }
    }
}

impl ClashIdentity for WideCombatant {
    type Province = ProvinceKey;
    type Key = [u8; 1 + COMBATANT_LEN];
    fn clash_seed(seed: &Seed, province: &ProvinceKey, bell: u32) -> Seed {
        wide_clash_seed(seed, *province, bell)
    }
    fn wedge(province: &ProvinceKey) -> u8 {
        province.coord().wedge().unwrap_or(0)
    }
    fn tie(cs: &Seed, id: &WideCombatant) -> u64 {
        match id {
            WideCombatant::Host(h) => wide_tie_key(cs, h),
            // A garrison never takes a tie key (the kernel sets 0); kept
            // explicit so no caller can draw one for a synthetic identity.
            _ => 0,
        }
    }
    fn key(&self, city: bool) -> [u8; 1 + COMBATANT_LEN] {
        let mut k = [0u8; 1 + COMBATANT_LEN];
        k[0] = city as u8;
        k[1..].copy_from_slice(&self.to_bytes());
        k
    }
    fn sort_by_order<T: Copy>(v: &mut [T], key: impl Fn(&T) -> (u64, u64, WideCombatant)) {
        v.sort_by_key(key)
    }
    fn sort_by_id<T: Copy>(v: &mut [T], key: impl Fn(&T) -> WideCombatant) {
        v.sort_by_key(key)
    }
}

/// A host of a wide clash (the kernel's fighter under the tagged identity;
/// always a `Host` variant, enforced by [`resolve_wide_clash`]).
pub type WideFighter = FighterOf<WideCombatant>;
/// A garrison of a wide clash: a holding's (`Host(holding_ref)`), the
/// camp's or the keep's.
pub type WideGarrison = GarrisonOf<WideCombatant>;
/// Everything one wide clash reads.
pub type WideClashInput<'a> = ClashInputOf<'a, WideCombatant>;

/// A wide clash's refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideClashError {
    /// The kernel's refusal, naming the combatant.
    Kernel(ClashErrorOf<WideCombatant>),
    /// A resident or an arrival that is a synthetic garrison identity.
    SyntheticFighter(WideCombatant),
}

impl From<ClashErrorOf<WideCombatant>> for WideClashError {
    fn from(e: ClashErrorOf<WideCombatant>) -> Self {
        WideClashError::Kernel(e)
    }
}

/// Domain of [`WideClashOutcome::digest`].
pub const CLASH_OUTCOME_DOMAIN_WIDE: &[u8] = b"PSF-WIDE-CLASH-OUTCOME-v1";

/// The outcome of a wide clash: the kernel's results under the tagged
/// identity, with the province key. No event record kind carries it yet
/// (nothing logs a wide clash); [`WideClashOutcome::digest`] hashes its
/// canonical bytes under [`CLASH_OUTCOME_DOMAIN_WIDE`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideClashOutcome {
    pub province: ProvinceKey,
    pub bell: u32,
    /// Sorted by identity.
    pub fighters: Vec<FighterResultOf<WideCombatant>>,
    /// Sorted by identity.
    pub garrisons: Vec<GarrisonResultOf<WideCombatant>>,
    pub engagements: u32,
}

/// Every resident and arrival must be a host.
fn check_fighters(inp: &WideClashInput) -> Result<(), WideClashError> {
    if let Some(s) = inp
        .residents
        .iter()
        .chain(inp.arrivals.iter())
        .find(|f| f.id.is_synthetic())
    {
        return Err(WideClashError::SyntheticFighter(s.id));
    }
    Ok(())
}

/// `(code, tile)` of a fate: Stays 0, Withdrew 1, Bounced 2, Retreated 3,
/// Destroyed 4; the tile where the fate has one, else 0xff.
pub const fn fate_code(f: Fate) -> (u8, u8) {
    match f {
        Fate::Stays { tile } => (0, tile),
        Fate::Withdrew { tile } => (1, tile),
        Fate::Bounced => (2, 0xff),
        Fate::Retreated => (3, 0xff),
        Fate::Destroyed => (4, 0xff),
    }
}

impl WideClashOutcome {
    pub fn fighter(&self, id: &WideCombatant) -> Option<&FighterResultOf<WideCombatant>> {
        self.fighters.iter().find(|f| f.id == *id)
    }

    /// `sha256(domain ‖ province key ‖ LE32(bell) ‖ LE32(n) ‖ fighters ‖
    /// LE32(m) ‖ garrisons ‖ LE32(engagements))`, each fighter `combatant
    /// bytes ‖ arrival ‖ LE32(troops) ‖ LE16(stamina) ‖ fate code ‖ fate
    /// tile ‖ engaged`, each garrison `combatant bytes ‖ LE32(troops) ‖
    /// attackers_hold ‖ holders ‖ defender_present`.
    pub fn digest(&self) -> [u8; 32] {
        let mut b: Vec<u8> = Vec::with_capacity(
            PROVINCE_KEY_LEN + 12 + self.fighters.len() * 67 + self.garrisons.len() * 64,
        );
        b.extend_from_slice(&self.province.to_bytes());
        b.extend_from_slice(&self.bell.to_le_bytes());
        b.extend_from_slice(&(self.fighters.len() as u32).to_le_bytes());
        for f in &self.fighters {
            let (code, tile) = fate_code(f.fate);
            b.extend_from_slice(&f.id.to_bytes());
            b.push(f.arrival as u8);
            b.extend_from_slice(&f.troops.to_le_bytes());
            b.extend_from_slice(&f.stamina.to_le_bytes());
            b.push(code);
            b.push(tile);
            b.push(f.engaged as u8);
        }
        b.extend_from_slice(&(self.garrisons.len() as u32).to_le_bytes());
        for g in &self.garrisons {
            b.extend_from_slice(&g.id.to_bytes());
            b.extend_from_slice(&g.troops.to_le_bytes());
            b.push(g.attackers_hold as u8);
            b.push(g.holders);
            b.push(g.defender_present as u8);
        }
        b.extend_from_slice(&self.engagements.to_le_bytes());
        sha256(&[CLASH_OUTCOME_DOMAIN_WIDE, &b])
    }
}

/// The clash kernel's production body (`clash::resolve_clash_core`, the
/// one the chain runs for the legacy scheme) over the tagged identity.
/// Every resident and arrival must be a host (`SyntheticFighter`
/// otherwise, before the kernel runs). Pure: it reads what it is given and
/// writes nothing; no handler calls it yet (no wide roster, arrival or
/// ClashInputs record is written by any instruction), so it is the
/// **executable combat core** of the wide world and not a movement.
pub fn resolve_wide_clash(
    rules: &Ruleset,
    inp: &WideClashInput,
) -> Result<WideClashOutcome, WideClashError> {
    check_fighters(inp)?;
    let c = resolve_clash_core(rules, inp)?;
    Ok(WideClashOutcome {
        province: inp.province,
        bell: c.bell,
        fighters: c.fighters,
        garrisons: c.garrisons,
        engagements: c.engagements,
    })
}

/// The kernel's step-by-step reference over the tagged identity (host
/// only), the oracle [`resolve_wide_clash`] is held to.
#[cfg(not(any(target_os = "solana", target_arch = "wasm32")))]
pub fn resolve_wide_clash_ref(
    rules: &Ruleset,
    inp: &WideClashInput,
) -> Result<WideClashOutcome, WideClashError> {
    check_fighters(inp)?;
    let c = permutation_rules::frontier::clash::resolve_clash_ref_core(rules, inp)?;
    Ok(WideClashOutcome {
        province: inp.province,
        bell: c.bell,
        fighters: c.fighters,
        garrisons: c.garrisons,
        engagements: c.engagements,
    })
}

// ------------------------------------------------------------ the alias, authenticated

/// Why a roster write may not use an alias.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AliasError {
    /// The alias is already in the table under **another** full reference:
    /// a hash collision, or a forged entry. Refused: an alias stands for one
    /// host or for none.
    Collision { alias: u64 },
    /// The same full reference is already in the table.
    AlreadyPresent { alias: u64 },
    /// A table entry's alias is not the alias of its own reference: the
    /// table is not what this program writes.
    Unauthenticated { alias: u64 },
}

/// The alias a roster write may use for `host`, checked against the whole
/// table of `(alias, full reference)` pairs it would join: every entry's
/// alias must be its own reference's ([`wide_host_alias`]), no entry may
/// carry `host`'s alias under another reference, and `host` must not be
/// present. The full reference is the authenticated identity of every
/// comparison; the alias alone proves nothing. A roster or transit writer
/// must call this before writing an alias, and store the reference beside
/// it.
/// Validates every existing mapping and uniqueness, independently of a new candidate.
pub fn validate_alias_table(table: &[(u64, WideHostRef)]) -> Result<(), AliasError> {
    for (i, (alias, host)) in table.iter().enumerate() {
        if wide_host_alias(host) != *alias {
            return Err(AliasError::Unauthenticated { alias: *alias });
        }
        for (other_alias, other_host) in &table[..i] {
            if other_host == host {
                return Err(AliasError::AlreadyPresent { alias: *alias });
            }
            if other_alias == alias {
                return Err(AliasError::Collision { alias: *alias });
            }
        }
    }
    Ok(())
}

pub fn claim_alias(table: &[(u64, WideHostRef)], host: &WideHostRef) -> Result<u64, AliasError> {
    validate_alias_table(table)?;
    let alias = wide_host_alias(host);
    for (a, h) in table {
        if wide_host_alias(h) != *a {
            return Err(AliasError::Unauthenticated { alias: *a });
        }
        if h == host {
            return Err(AliasError::AlreadyPresent { alias });
        }
        if *a == alias {
            return Err(AliasError::Collision { alias });
        }
    }
    Ok(alias)
}

// ------------------------------------------------------------ what a wide seal must commit to

/// Domain of [`wide_plain_commit`].
pub const WIDE_PLAIN_DOMAIN: &[u8] = b"PSF-WIDE-PLAIN-v1";

/// The commitment a wide seal must open to (a model of the preimage, not a
/// seal format: no ciphertext, no beacon binding and no bond exist for it).
/// The legacy `Plain37` authenticates only its narrow fields (an `i16`
/// destination, a tile, a bell, the retreat ratio, the stance); a wide
/// seal must bind the **full host reference and the full destination key**
/// inside the commitment, so that no settle or forfeit can be steered by an
/// unauthenticated side input: `sha256(domain ‖ host ref ‖ destination key
/// ‖ dest tile ‖ LE32(arrive bell) ‖ LE16(retreat bps) ‖ stance ‖ salt)`.
#[allow(clippy::too_many_arguments)]
pub fn wide_plain_commit(
    host: &WideHostRef,
    dest: ProvinceKey,
    dest_tile: u8,
    arrive_bell: u32,
    retreat_bps: u16,
    stance: u8,
    salt: &[u8; 32],
) -> [u8; 32] {
    sha256(&[
        WIDE_PLAIN_DOMAIN,
        &host.to_bytes(),
        &dest.to_bytes(),
        &[dest_tile],
        &arrive_bell.to_le_bytes(),
        &retreat_bps.to_le_bytes(),
        &[stance],
        salt,
    ])
}

/// The stages of a march, in the legacy order. The legacy record keeps
/// the first four as its `state` byte and the fifth as `FLAG_GATHERED`;
/// the settle that frees the record is the return to `Free`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchState {
    /// No march (the record is free).
    Free,
    /// Departed; the origin's clash of the departure bell is not resolved.
    Departed,
    /// The departure settled: post-clash troops and stamina known.
    Settled,
    /// The departure settled and the host was destroyed at the origin.
    DestroyedAtOrigin,
    /// A gather at the destination recorded the transit (the legacy
    /// `FLAG_GATHERED`); it may now settle only against that destination.
    Gathered,
}

impl MarchState {
    const fn to_byte(self) -> u8 {
        match self {
            MarchState::Free => T::STATE_FREE,
            MarchState::Departed => T::STATE_DEPARTED,
            MarchState::Settled => T::STATE_SETTLED,
            MarchState::DestroyedAtOrigin => T::STATE_DESTROYED_AT_ORIGIN,
            MarchState::Gathered => 4,
        }
    }
    const fn from_byte(b: u8) -> Option<MarchState> {
        match b {
            T::STATE_FREE => Some(MarchState::Free),
            T::STATE_DEPARTED => Some(MarchState::Departed),
            T::STATE_SETTLED => Some(MarchState::Settled),
            T::STATE_DESTROYED_AT_ORIGIN => Some(MarchState::DestroyedAtOrigin),
            4 => Some(MarchState::Gathered),
            _ => None,
        }
    }
    /// The host may not act (the legacy `in_transit`).
    pub const fn in_transit(self) -> bool {
        !matches!(self, MarchState::Free)
    }
}

/// The events of the legacy lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchEvent {
    /// SettleDeparture: the origin resolved the departure bell.
    SettleDeparture { destroyed: bool },
    /// GatherClash recorded the transit at `dest`.
    Gather { dest: ProvinceKey },
    /// SettleTransit: the march ends (returned, stayed, stranded or
    /// forfeited; the outcome is the settle's, not the record's).
    SettleTransit,
}

/// Why a record or a transition is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchError {
    /// No wider host identity is allocated: a wide host cannot depart.
    HostIdentityUnallocated,
    UnknownHostIdentity(u16),
    Unit(u8),
    Faction(u8),
    /// The event is not a transition of the lifecycle from this state.
    InvalidTransition {
        from: MarchState,
        event: u8,
    },
    /// A gather names a destination of another world.
    WorldMismatch,
    /// An arrival bell outside `depart + 2 ..= depart + 72`.
    ArrivalBell {
        depart_bell: u32,
        arrive_bell: u32,
    },
    Length {
        expected: usize,
        got: usize,
    },
    Version {
        expected: u8,
        got: u8,
    },
    Reserved,
    State(u8),
    Key(KeyError),
    Tile(TileError),
    /// A `Gathered` record without a destination, or a destination on an
    /// ungathered record.
    Destination,
    /// A combatant tag that is not host, camp or keep.
    CombatantTag(u8),
}

impl From<KeyError> for MarchError {
    fn from(e: KeyError) -> Self {
        MarchError::Key(e)
    }
}

impl From<TileError> for MarchError {
    fn from(e: TileError) -> Self {
        MarchError::Tile(e)
    }
}

/// The legacy bounds of a chosen arrival bell (`travel::MIN_ARRIVAL_LEAD_BELLS`,
/// `travel::MAX_ARRIVAL_LEAD_BELLS`), restated from the kernel.
pub const MIN_ARRIVAL_LEAD_BELLS: u32 = permutation_rules::frontier::travel::MIN_ARRIVAL_LEAD_BELLS;
pub const MAX_ARRIVAL_LEAD_BELLS: u32 = permutation_rules::frontier::travel::MAX_ARRIVAL_LEAD_BELLS;

/// One march of a wide host: the legacy transit fields over wide
/// identities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideTransit {
    pub state: MarchState,
    /// The host identity version the march was opened under.
    pub host_identity: u16,
    pub host: WideHostRef,
    pub unit: u8,
    pub faction: u8,
    /// Where the host stood at the departure.
    pub origin: TileAddress,
    /// Set by the gather; `None` before.
    pub dest: Option<ProvinceKey>,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub depart_ts: i64,
    pub dep_mass: u32,
    pub march_stamina: u16,
    pub dealt_bps: u16,
    pub troops_after: u32,
    pub stamina_after: u16,
    pub ready_bell_off: u16,
    pub seal_root: [u8; 32],
    pub tip: u64,
    pub flags: u8,
}

/// Offsets of the record.
mod off {
    pub const VERSION: usize = 0;
    pub const STATE: usize = 1;
    pub const UNIT: usize = 2;
    pub const FACTION: usize = 3;
    pub const HOST_IDENTITY: usize = 4;
    pub const FLAGS: usize = 6;
    pub const HAS_DEST: usize = 7;
    pub const HOST: usize = 8; // 56
    pub const ORIGIN_KEY: usize = 64; // 50
    pub const ORIGIN_TILE: usize = 114;
    pub const RSV_115: usize = 115;
    pub const DEST_KEY: usize = 116; // 50
    pub const RSV_166: usize = 166;
    pub const DEPART_BELL: usize = 168;
    pub const ARRIVE_BELL: usize = 172;
    pub const DEPART_TS: usize = 176;
    pub const DEP_MASS: usize = 184;
    pub const MARCH_STAMINA: usize = 188;
    pub const DEALT_BPS: usize = 190;
    pub const TROOPS_AFTER: usize = 192;
    pub const STAMINA_AFTER: usize = 196;
    pub const READY_BELL_OFF: usize = 198;
    pub const SEAL_ROOT: usize = 200; // 32
    pub const TIP: usize = 232;
    pub const RSV: usize = 240;
    pub const RSV_LEN: usize = 16;
    const _: () = {
        assert!(HOST + super::HOST_REF_LEN == ORIGIN_KEY);
        assert!(ORIGIN_KEY + super::PROVINCE_KEY_LEN == ORIGIN_TILE);
        assert!(DEST_KEY + super::PROVINCE_KEY_LEN == RSV_166);
        assert!(RSV + RSV_LEN == super::WIDE_TRANSIT_LEN);
    };
}

impl WideTransit {
    /// The departure of `host` from `origin` under `host_identity`: refused
    /// [`MarchError::HostIdentityUnallocated`] under version 0 (what the
    /// program knows), so the record can never be written and no debit
    /// can be taken; otherwise the legacy arrival-bell bounds. The seal
    /// root, tip, mass and doctrine values are the caller's (the legacy
    /// Depart computes them; nothing is priced here).
    #[allow(clippy::too_many_arguments)]
    pub fn depart(
        host_identity: u16,
        host: WideHostRef,
        unit: u8,
        faction: u8,
        origin: TileAddress,
        depart_bell: u32,
        arrive_bell: u32,
        depart_ts: i64,
        dep_mass: u32,
        march_stamina: u16,
        dealt_bps: u16,
        seal_root: [u8; 32],
        tip: u64,
        flags: u8,
    ) -> Result<WideTransit, MarchError> {
        if host_identity == super::holding::HOST_IDENTITY_UNALLOCATED {
            return Err(MarchError::HostIdentityUnallocated);
        }
        if host_identity != HOST_IDENTITY_FULL_REF_V1 {
            return Err(MarchError::UnknownHostIdentity(host_identity));
        }
        if unit >= 8 {
            return Err(MarchError::Unit(unit));
        }
        if faction >= 6 {
            return Err(MarchError::Faction(faction));
        }
        let err = MarchError::ArrivalBell {
            depart_bell,
            arrive_bell,
        };
        let lo = depart_bell.checked_add(MIN_ARRIVAL_LEAD_BELLS).ok_or(err)?;
        let hi = depart_bell.checked_add(MAX_ARRIVAL_LEAD_BELLS).ok_or(err)?;
        if arrive_bell < lo || arrive_bell > hi {
            return Err(MarchError::ArrivalBell {
                depart_bell,
                arrive_bell,
            });
        }
        if host.key().world() != origin.world() {
            return Err(MarchError::WorldMismatch);
        }
        Ok(WideTransit {
            state: MarchState::Departed,
            host_identity,
            host,
            unit,
            faction,
            origin,
            dest: None,
            depart_bell,
            arrive_bell,
            depart_ts,
            dep_mass,
            march_stamina,
            dealt_bps,
            troops_after: 0,
            stamina_after: 0,
            ready_bell_off: 0,
            seal_root,
            tip,
            flags,
        })
    }

    /// The record after `event`, by the legacy lifecycle: a departure
    /// settles once (to `Settled` or `DestroyedAtOrigin`); a settled
    /// transit may be gathered once, at a destination of its world; a
    /// settled or gathered transit ends with the settle, which frees the
    /// record. Every other pair is refused. The settled values are the
    /// caller's (`host::march_values` in the legacy settle).
    pub fn step(
        self,
        event: MarchEvent,
        settled: Option<(u32, u16, u16)>,
    ) -> Result<WideTransit, MarchError> {
        let code = match event {
            MarchEvent::SettleDeparture { .. } => 1,
            MarchEvent::Gather { .. } => 2,
            MarchEvent::SettleTransit => 3,
        };
        let invalid = MarchError::InvalidTransition {
            from: self.state,
            event: code,
        };
        match (self.state, event) {
            (MarchState::Departed, MarchEvent::SettleDeparture { destroyed }) => {
                let (troops_after, stamina_after, ready_bell_off) = if destroyed {
                    (0, 0, settled.map_or(0, |s| s.2))
                } else {
                    settled.ok_or(invalid)?
                };
                Ok(WideTransit {
                    state: if destroyed {
                        MarchState::DestroyedAtOrigin
                    } else {
                        MarchState::Settled
                    },
                    troops_after,
                    stamina_after,
                    ready_bell_off,
                    ..self
                })
            }
            (MarchState::Settled | MarchState::DestroyedAtOrigin, MarchEvent::Gather { dest }) => {
                if dest.world() != self.origin.world() {
                    return Err(MarchError::WorldMismatch);
                }
                Ok(WideTransit {
                    state: MarchState::Gathered,
                    dest: Some(dest),
                    ..self
                })
            }
            (
                MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered,
                MarchEvent::SettleTransit,
            ) => Ok(WideTransit {
                state: MarchState::Free,
                dest: None,
                ..self
            }),
            _ => Err(invalid),
        }
    }

    /// `WIDE_TRANSIT_VERSION ‖ state ‖ unit ‖ faction ‖ identity ‖ flags ‖
    /// has_dest ‖ host ref ‖ origin key ‖ origin tile ‖ dest key ‖ bells,
    /// times, values ‖ seal root ‖ tip`, 256 bytes.
    pub fn to_bytes(&self) -> [u8; WIDE_TRANSIT_LEN] {
        let mut b = [0u8; WIDE_TRANSIT_LEN];
        let _ = wr_u8(&mut b, off::VERSION, WIDE_TRANSIT_VERSION)
            & wr_u8(&mut b, off::STATE, self.state.to_byte())
            & wr_u8(&mut b, off::UNIT, self.unit)
            & wr_u8(&mut b, off::FACTION, self.faction)
            & wr_u16(&mut b, off::HOST_IDENTITY, self.host_identity)
            & wr_u8(&mut b, off::FLAGS, self.flags)
            & wr_u8(&mut b, off::HAS_DEST, self.dest.is_some() as u8)
            & wr_arr(&mut b, off::HOST, &self.host.to_bytes())
            & wr_arr(&mut b, off::ORIGIN_KEY, &self.origin.key().to_bytes())
            & wr_u8(&mut b, off::ORIGIN_TILE, self.origin.local())
            & wr_arr(
                &mut b,
                off::DEST_KEY,
                &self.dest.map_or([0u8; PROVINCE_KEY_LEN], |k| k.to_bytes()),
            )
            & wr_u32(&mut b, off::DEPART_BELL, self.depart_bell)
            & wr_u32(&mut b, off::ARRIVE_BELL, self.arrive_bell)
            & wr_i64(&mut b, off::DEPART_TS, self.depart_ts)
            & wr_u32(&mut b, off::DEP_MASS, self.dep_mass)
            & wr_u16(&mut b, off::MARCH_STAMINA, self.march_stamina)
            & wr_u16(&mut b, off::DEALT_BPS, self.dealt_bps)
            & wr_u32(&mut b, off::TROOPS_AFTER, self.troops_after)
            & wr_u16(&mut b, off::STAMINA_AFTER, self.stamina_after)
            & wr_u16(&mut b, off::READY_BELL_OFF, self.ready_bell_off)
            & wr_arr(&mut b, off::SEAL_ROOT, &self.seal_root)
            & wr_u64(&mut b, off::TIP, self.tip);
        b
    }

    /// Inverse of [`WideTransit::to_bytes`]: exact length, this version, a
    /// known state, a destination exactly when gathered, zero reserved
    /// bytes, canonical keys.
    pub fn from_bytes(d: &[u8]) -> Result<WideTransit, MarchError> {
        if d.len() != WIDE_TRANSIT_LEN {
            return Err(MarchError::Length {
                expected: WIDE_TRANSIT_LEN,
                got: d.len(),
            });
        }
        let t = MarchError::Length {
            expected: WIDE_TRANSIT_LEN,
            got: 0,
        };
        let v = rd_u8(d, off::VERSION).ok_or(t)?;
        if v != WIDE_TRANSIT_VERSION {
            return Err(MarchError::Version {
                expected: WIDE_TRANSIT_VERSION,
                got: v,
            });
        }
        let sb = rd_u8(d, off::STATE).ok_or(t)?;
        let state = MarchState::from_byte(sb).ok_or(MarchError::State(sb))?;
        for (o, n) in [
            (off::RSV_115, 1usize),
            (off::RSV_166, 2),
            (off::RSV, off::RSV_LEN),
        ] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(MarchError::Reserved);
            }
        }
        let host = WideHostRef::from_bytes(&d[off::HOST..off::HOST + HOST_REF_LEN])?;
        let origin_key =
            ProvinceKey::from_bytes(&d[off::ORIGIN_KEY..off::ORIGIN_KEY + PROVINCE_KEY_LEN])?;
        let tile = rd_u8(d, off::ORIGIN_TILE).ok_or(t)?;
        if tile as usize >= PROVINCE_TILES {
            return Err(MarchError::Tile(TileError::LocalIndex(tile)));
        }
        let origin = TileAddress::new(origin_key, tile)?;
        let has_dest = rd_u8(d, off::HAS_DEST).ok_or(t)?;
        let dest_bytes = &d[off::DEST_KEY..off::DEST_KEY + PROVINCE_KEY_LEN];
        let dest = match (state, has_dest) {
            (MarchState::Gathered, 1) => Some(ProvinceKey::from_bytes(dest_bytes)?),
            (MarchState::Gathered, _) => return Err(MarchError::Destination),
            (_, 0) if dest_bytes.iter().all(|b| *b == 0) => None,
            _ => return Err(MarchError::Destination),
        };
        let host_identity = rd_u16(d, off::HOST_IDENTITY).ok_or(t)?;
        if host_identity == super::holding::HOST_IDENTITY_UNALLOCATED {
            return Err(MarchError::HostIdentityUnallocated);
        }
        if host_identity != HOST_IDENTITY_FULL_REF_V1 {
            return Err(MarchError::UnknownHostIdentity(host_identity));
        }
        if host.key().world() != origin.world() || dest.is_some_and(|d| d.world() != origin.world())
        {
            return Err(MarchError::WorldMismatch);
        }
        let unit = rd_u8(d, off::UNIT).ok_or(t)?;
        let faction = rd_u8(d, off::FACTION).ok_or(t)?;
        if unit >= 8 {
            return Err(MarchError::Unit(unit));
        }
        if faction >= 6 {
            return Err(MarchError::Faction(faction));
        }
        Ok(WideTransit {
            state,
            host_identity,
            host,
            unit,
            faction,
            origin,
            dest,
            depart_bell: rd_u32(d, off::DEPART_BELL).ok_or(t)?,
            arrive_bell: rd_u32(d, off::ARRIVE_BELL).ok_or(t)?,
            depart_ts: rd_i64(d, off::DEPART_TS).ok_or(t)?,
            dep_mass: rd_u32(d, off::DEP_MASS).ok_or(t)?,
            march_stamina: rd_u16(d, off::MARCH_STAMINA).ok_or(t)?,
            dealt_bps: rd_u16(d, off::DEALT_BPS).ok_or(t)?,
            troops_after: rd_u32(d, off::TROOPS_AFTER).ok_or(t)?,
            stamina_after: rd_u16(d, off::STAMINA_AFTER).ok_or(t)?,
            ready_bell_off: rd_u16(d, off::READY_BELL_OFF).ok_or(t)?,
            seal_root: rd_arr(d, off::SEAL_ROOT).ok_or(t)?,
            tip: rd_u64(d, off::TIP).ok_or(t)?,
            flags: rd_u8(d, off::FLAGS).ok_or(t)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WideCoord;
    use crate::world_index::holding::HOST_IDENTITY_UNALLOCATED;
    use crate::world_index::key::WorldId;

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn host(w: WorldId) -> WideHostRef {
        let key = ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap());
        WideHostRef::new(key, 3, 1, 7).unwrap()
    }

    fn origin(w: WorldId) -> TileAddress {
        TileAddress::new(ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap()), 30).unwrap()
    }

    /// A model exercise under a hypothetical allocated identity (1); the
    /// program passes 0 and gets the refusal below.
    fn departed() -> WideTransit {
        WideTransit::depart(
            1,
            host(world(1)),
            2,
            4,
            origin(world(1)),
            100,
            110,
            1_800_060_000,
            500_000,
            74,
            10_000,
            [0xab; 32],
            14_441,
            T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        )
        .unwrap()
    }

    /// Under the only identity version the program has, no wide march can
    /// be opened: the first check, before any other.
    #[test]
    fn no_departure_under_an_unallocated_host_identity() {
        assert_eq!(
            WideTransit::depart(
                HOST_IDENTITY_UNALLOCATED,
                host(world(1)),
                2,
                4,
                origin(world(1)),
                100,
                110,
                0,
                500_000,
                74,
                10_000,
                [0; 32],
                0,
                0,
            ),
            Err(MarchError::HostIdentityUnallocated)
        );
        // even a malformed request is refused by the identity gate first
        assert_eq!(
            WideTransit::depart(
                HOST_IDENTITY_UNALLOCATED,
                host(world(1)),
                2,
                4,
                origin(world(2)),
                100,
                1,
                0,
                0,
                0,
                0,
                [0; 32],
                0,
                0,
            ),
            Err(MarchError::HostIdentityUnallocated)
        );
        assert_eq!(HOST_IDENTITY_UNALLOCATED, 0);
    }

    /// The lifecycle is the legacy one: departure settle once, gather once
    /// in the same world, the settle frees; nothing else; the arrival bell
    /// obeys the legacy lead bounds (restated from the kernel).
    #[test]
    fn lifecycle_is_the_legacy_order_and_nothing_else() {
        assert_eq!(MIN_ARRIVAL_LEAD_BELLS, 2);
        assert_eq!(MAX_ARRIVAL_LEAD_BELLS, 72);
        for arrive in [0u32, 99, 100, 101, 173, u32::MAX] {
            assert_eq!(
                WideTransit::depart(
                    1,
                    host(world(1)),
                    2,
                    4,
                    origin(world(1)),
                    100,
                    arrive,
                    0,
                    1,
                    1,
                    1,
                    [0; 32],
                    0,
                    0
                ),
                Err(MarchError::ArrivalBell {
                    depart_bell: 100,
                    arrive_bell: arrive
                })
            );
        }
        for arrive in [102u32, 110, 172] {
            assert!(WideTransit::depart(
                1,
                host(world(1)),
                2,
                4,
                origin(world(1)),
                100,
                arrive,
                0,
                1,
                1,
                1,
                [0; 32],
                0,
                0
            )
            .is_ok());
        }
        assert_eq!(
            WideTransit::depart(
                1,
                host(world(1)),
                2,
                4,
                origin(world(2)),
                100,
                110,
                0,
                1,
                1,
                1,
                [0; 32],
                0,
                0
            ),
            Err(MarchError::WorldMismatch)
        );
        let d = departed();
        assert_eq!(d.state, MarchState::Departed);
        assert!(d.state.in_transit());
        assert_eq!(d.dest, None);
        let dest = ProvinceKey::new(world(1), WideCoord::checked(130, 0).unwrap());
        let other = ProvinceKey::new(world(2), WideCoord::checked(130, 0).unwrap());
        // a departed march may only settle its departure
        assert!(matches!(
            d.step(MarchEvent::Gather { dest }, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Departed,
                event: 2
            })
        ));
        assert!(matches!(
            d.step(MarchEvent::SettleTransit, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Departed,
                event: 3
            })
        ));
        assert!(matches!(
            d.step(MarchEvent::SettleDeparture { destroyed: false }, None),
            Err(MarchError::InvalidTransition { .. })
        ));
        let s = d
            .step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((450_000, 40, 3)),
            )
            .unwrap();
        assert_eq!(s.state, MarchState::Settled);
        assert_eq!(
            (s.troops_after, s.stamina_after, s.ready_bell_off),
            (450_000, 40, 3)
        );
        let x = d
            .step(MarchEvent::SettleDeparture { destroyed: true }, None)
            .unwrap();
        assert_eq!(x.state, MarchState::DestroyedAtOrigin);
        assert_eq!((x.troops_after, x.stamina_after), (0, 0));
        // settled: gather once in the same world, or settle back
        assert!(matches!(
            s.step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((1, 1, 1))
            ),
            Err(MarchError::InvalidTransition {
                from: MarchState::Settled,
                event: 1
            })
        ));
        assert_eq!(
            s.step(MarchEvent::Gather { dest: other }, None),
            Err(MarchError::WorldMismatch)
        );
        let g = s.step(MarchEvent::Gather { dest }, None).unwrap();
        assert_eq!(g.state, MarchState::Gathered);
        assert_eq!(g.dest, Some(dest));
        assert!(matches!(
            g.step(MarchEvent::Gather { dest }, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Gathered,
                event: 2
            })
        ));
        let f = g.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f.state, MarchState::Free);
        assert_eq!(f.dest, None);
        assert!(!f.state.in_transit());
        let f2 = s.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f2.state, MarchState::Free);
        let f3 = x.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f3.state, MarchState::Free);
        // a free record takes no event
        for ev in [
            MarchEvent::SettleDeparture { destroyed: false },
            MarchEvent::Gather { dest },
            MarchEvent::SettleTransit,
        ] {
            assert!(matches!(
                f.step(ev, Some((1, 1, 1))),
                Err(MarchError::InvalidTransition {
                    from: MarchState::Free,
                    ..
                })
            ));
        }
    }

    #[test]
    fn record_round_trips_at_every_stage_and_refuses_bad_bytes() {
        let d = departed();
        let dest = ProvinceKey::new(world(1), WideCoord::checked(1 << 40, -(1 << 41)).unwrap());
        let s = d
            .step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((450_000, 40, 3)),
            )
            .unwrap();
        let g = s.step(MarchEvent::Gather { dest }, None).unwrap();
        let f = g.step(MarchEvent::SettleTransit, None).unwrap();
        for r in [d, s, g, f] {
            let b = r.to_bytes();
            assert_eq!(b.len(), 256);
            assert_eq!(b[0], WIDE_TRANSIT_VERSION);
            assert_eq!(WideTransit::from_bytes(&b), Ok(r), "{:?}", r.state);
            assert_eq!(b[off::HAS_DEST], r.dest.is_some() as u8);
        }
        // the state bytes of the first four stages are the legacy transit's
        assert_eq!(MarchState::Free.to_byte(), T::STATE_FREE);
        assert_eq!(MarchState::Departed.to_byte(), T::STATE_DEPARTED);
        assert_eq!(MarchState::Settled.to_byte(), T::STATE_SETTLED);
        assert_eq!(
            MarchState::DestroyedAtOrigin.to_byte(),
            T::STATE_DESTROYED_AT_ORIGIN
        );
        for st in [1u8, 2, 3] {
            assert!(MarchState::from_byte(st).unwrap().in_transit());
            assert!(T::in_transit(st));
        }
        let b = g.to_bytes();
        assert_eq!(
            WideTransit::from_bytes(&b[..255]),
            Err(MarchError::Length {
                expected: 256,
                got: 255
            })
        );
        let mut x = b;
        x[off::VERSION] = 2;
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Version {
                expected: 1,
                got: 2
            })
        );
        let mut x = b;
        x[off::STATE] = 5;
        assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::State(5)));
        for o in [off::RSV_115, off::RSV_166 + 1, off::RSV + off::RSV_LEN - 1] {
            let mut x = b;
            x[o] = 1;
            assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::Reserved));
        }
        let mut x = b;
        x[off::ORIGIN_TILE] = 61;
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Tile(TileError::LocalIndex(61)))
        );
        // a gathered record without a destination, a settled one with one
        let mut x = b;
        x[off::HAS_DEST] = 0;
        assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::Destination));
        let mut y = s.to_bytes();
        y[off::HAS_DEST] = 1;
        assert_eq!(WideTransit::from_bytes(&y), Err(MarchError::Destination));
        let mut y = s.to_bytes();
        y[off::DEST_KEY + 5] = 1;
        assert_eq!(WideTransit::from_bytes(&y), Err(MarchError::Destination));
        // a reserved world in the host ref
        let mut x = b;
        x[off::HOST + 1..off::HOST + 33].fill(0);
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Key(KeyError::ReservedWorld))
        );
    }
    /// The identity decision: the alias is a lookup key no legacy reader
    /// accepts and no formula takes; the wide formulas read the whole
    /// coordinate and the whole reference under their own domains, so an
    /// unrelated host's insertion, a coordinate that agrees in its low 32
    /// bits or a legacy id with the same numbers never share an outcome
    /// with them; the transit record has its own canonical address.
    #[test]
    fn identity_is_the_full_reference_the_alias_is_lookup_only_and_formulas_are_wide() {
        use crate::addr::split_host_id;
        assert_eq!(HOST_IDENTITY_FULL_REF_V1, 1);
        assert_ne!(HOST_IDENTITY_FULL_REF_V1, HOST_IDENTITY_UNALLOCATED);
        let w = world(1);
        let h = host(w);
        let a = wide_host_alias(&h);
        assert!(is_wide_alias(a));
        assert_eq!(split_host_id(a), None, "no legacy reader parses it");
        assert_ne!(a, wide_host_alias(&h.holding_ref()));
        let other_seq = WideHostRef::new(h.key(), h.site(), h.gen(), 8).unwrap();
        assert_ne!(a, wide_host_alias(&other_seq));
        let far = WideHostRef::new(
            ProvinceKey::new(
                w,
                WideCoord::checked((1i64 << 32) + 129, -(1i64 << 32)).unwrap(),
            ),
            3,
            1,
            7,
        )
        .unwrap();
        assert_ne!(a, wide_host_alias(&far), "full width, not the low 32 bits");
        assert_eq!(a, wide_host_alias(&h), "deterministic");
        // every legacy id is refused as an alias, every alias as a legacy id
        let legacy = crate::addr::host_id(3, -1, 2, 1, 9).unwrap();
        assert!(!is_wide_alias(legacy));
        assert!(split_host_id(legacy).is_some());
        // the formulas
        let seed = [0x5a; 32];
        let k = h.key();
        let kf = far.key();
        assert_ne!(wide_slot_key(k, 7, &h), wide_slot_key(kf, 7, &far));
        assert_ne!(wide_slot_key(k, 7, &h), wide_slot_key(k, 8, &h));
        assert_ne!(wide_slot_key(k, 7, &h), wide_slot_key(k, 7, &other_seq));
        assert_ne!(wide_tie_key(&seed, &h), wide_tie_key(&seed, &other_seq));
        assert_ne!(
            wide_tie_key(&seed, &h),
            permutation_rules::rng::tie_key(&seed, a),
            "the alias is not the tie-break input"
        );
        assert_ne!(wide_clash_seed(&seed, k, 7), wide_clash_seed(&seed, kf, 7));
        assert_ne!(wide_clash_seed(&seed, k, 7), wide_clash_seed(&seed, k, 8));
        assert_ne!(
            wide_clash_seed(&seed, k, 7),
            permutation_rules::frontier::clash::clash_seed(
                &seed,
                permutation_rules::frontier::geometry::ProvinceCoord::new(129, 0),
                7
            ),
            "not the legacy formula over the same numbers"
        );
        // the transit record's address: one per (holding, slot), a with-seed
        // address distinct from the holding's and the ticket's tags
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        let hk = [0x66; 32];
        let t0 = transit_address(&ctx, &hk, 0);
        assert_eq!(t0, transit_address(&ctx, &hk, 0));
        assert_ne!(t0, transit_address(&ctx, &hk, 1));
        assert_ne!(t0, transit_address(&ctx, &[0x67; 32], 0));
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&TRANSIT_TAG),
            None
        );
        assert_ne!(TRANSIT_TAG, super::super::ticket::TICKET_TAG);
        assert_ne!(TRANSIT_TAG, super::super::holding::HOLDING_TAG);
    }

    #[test]
    fn native_review_refuses_unknown_identity_cross_world_and_clock_overflow() {
        let d = departed();
        let mut bad = d.to_bytes();
        bad[off::UNIT] = 255;
        assert_eq!(WideTransit::from_bytes(&bad), Err(MarchError::Unit(255)));
        let mut bad = d.to_bytes();
        bad[off::FACTION] = 255;
        assert_eq!(WideTransit::from_bytes(&bad), Err(MarchError::Faction(255)));
        let mut bytes = d.to_bytes();
        wr_u16(&mut bytes, off::HOST_IDENTITY, 2);
        assert_eq!(
            WideTransit::from_bytes(&bytes),
            Err(MarchError::UnknownHostIdentity(2))
        );
        let mut bytes = d.to_bytes();
        let other = origin(world(2));
        bytes[off::ORIGIN_KEY..off::ORIGIN_KEY + PROVINCE_KEY_LEN]
            .copy_from_slice(&other.key().to_bytes());
        assert_eq!(
            WideTransit::from_bytes(&bytes),
            Err(MarchError::WorldMismatch)
        );
        assert!(matches!(
            WideTransit::depart(
                1,
                d.host,
                d.unit,
                d.faction,
                d.origin,
                u32::MAX,
                u32::MAX,
                0,
                0,
                0,
                0,
                [0; 32],
                0,
                0
            ),
            Err(MarchError::ArrivalBell { .. })
        ));
    }

    /// The clash kernel over the tagged identity: the production body and
    /// the reference body agree on fixed data that fights; results are
    /// named by full identities (a holding's garrison by its holding's
    /// reference, the keep by its tagged variant with the full `u32`
    /// generation), sorted by identity; input order and an unrelated
    /// host's insertion change nothing; a synthetic fighter is refused; the
    /// wedge is the coordinate's exact geometric one.
    mod wide_clash {
        use super::*;
        use permutation_rules::fixed::BPS_ONE;
        use permutation_rules::frontier::clash::{frontier_ruleset, Occupancy, Relations};
        use permutation_rules::frontier::geometry::{ProvinceCoord, PROVINCE_TILES};
        use permutation_rules::frontier::host::STAMINA_CAP;
        use permutation_rules::frontier::stance::{Posture, Stance};
        use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};
        use permutation_rules::map::Terrain;
        use permutation_rules::units::UnitType;
        use std::vec::Vec;

        const FIELD: u8 = 30;
        const FAR: u8 = 0;

        fn key() -> ProvinceKey {
            ProvinceKey::new(world(1), WideCoord::checked(129, 0).unwrap())
        }

        fn r(site: u8, gen: u8, seq: u32) -> WideHostRef {
            WideHostRef::new(key(), site, gen, seq).unwrap()
        }

        fn h(site: u8, gen: u8, seq: u32) -> WideCombatant {
            WideCombatant::Host(r(site, gen, seq))
        }

        fn keep() -> WideCombatant {
            WideCombatant::Keep {
                key: key(),
                gen: 70_001,
            }
        }

        /// A fixture terrain: the legacy generator's tiles, all plains (the
        /// wide terrain kernel is not what this test is about).
        fn plains() -> ProvinceTerrain {
            let mut t = generate_province(&[7u8; 32], ProvinceCoord::new(3, -1));
            t.terrain = [Terrain::Plains; PROVINCE_TILES];
            t
        }

        fn fighter(
            id: WideCombatant,
            faction: u8,
            unit: UnitType,
            troops: u32,
            tile: u8,
        ) -> WideFighter {
            WideFighter {
                id,
                faction,
                unit,
                troops: troops * 1000,
                stamina: STAMINA_CAP,
                tile,
                posture: Posture::default(),
                retreat_bps: None,
                dealt_bps: BPS_ONE,
            }
        }

        fn arrival(
            id: WideCombatant,
            faction: u8,
            unit: UnitType,
            troops: u32,
            tile: u8,
        ) -> WideFighter {
            WideFighter {
                posture: Posture::Stance(Stance::Assault),
                ..fighter(id, faction, unit, troops, tile)
            }
        }

        struct Fixture {
            terrain: ProvinceTerrain,
            residents: Vec<WideFighter>,
            garrisons: Vec<WideGarrison>,
            arrivals: Vec<WideFighter>,
        }

        fn fixture() -> Fixture {
            Fixture {
                terrain: plains(),
                residents: std::vec![
                    fighter(h(2, 1, 1), 0, UnitType::Spearman, 9_000, FIELD),
                    fighter(h(2, 1, 2), 0, UnitType::Archer, 6_000, FIELD),
                    fighter(h(5, 1, 1), 2, UnitType::Pikeman, 7_000, 44),
                ],
                garrisons: std::vec![
                    WideGarrison {
                        id: WideCombatant::Host(r(2, 1, 1).holding_ref()),
                        faction: 0,
                        tile: FIELD,
                        troops: 4_000 * 1000,
                        walls: true,
                        posture: Posture::default(),
                    },
                    // the keep: a synthetic garrison on an uncontested hex
                    WideGarrison {
                        id: keep(),
                        faction: 4,
                        tile: 10,
                        troops: 3_000 * 1000,
                        walls: false,
                        posture: Posture::default(),
                    },
                ],
                arrivals: std::vec![
                    arrival(h(7, 2, 1), 1, UnitType::Knight, 12_000, FIELD),
                    arrival(h(7, 2, 2), 1, UnitType::Horseman, 8_000, FIELD),
                ],
            }
        }

        fn input<'a>(f: &'a Fixture) -> WideClashInput<'a> {
            WideClashInput {
                province: key(),
                bell: 11,
                seed: sha256(&[b"wide-identity"]),
                terrain: &f.terrain,
                residents: &f.residents,
                garrisons: &f.garrisons,
                arrivals: &f.arrivals,
                relations: Relations::ALL_HOSTILE,
                occupancy: Occupancy::EMPTY,
            }
        }

        #[test]
        fn production_body_matches_the_reference_under_the_full_reference() {
            let f = fixture();
            let a = resolve_wide_clash(&frontier_ruleset(), &input(&f)).unwrap();
            let b = resolve_wide_clash_ref(&frontier_ruleset(), &input(&f)).unwrap();
            assert_eq!(a, b);
            assert_eq!(a.digest(), b.digest());
            assert_eq!(a.province, key());
            assert!(a.engagements > 0, "{a:?}");
            assert_eq!(a.garrisons.len(), 2);
            // sorted by identity: hosts before keeps
            assert_eq!(
                a.garrisons[0].id,
                WideCombatant::Host(r(2, 1, 1).holding_ref())
            );
            assert_eq!(a.garrisons[1].id, keep());
            assert!(a.garrisons[0].troops < 4_000 * 1000);
            assert_eq!(
                a.garrisons[1].troops,
                3_000 * 1000,
                "the keep was not fought"
            );
            assert!(a
                .fighters
                .iter()
                .any(|x| x.engaged && x.troops < 6_000 * 1000));
            let outsider = a.fighter(&h(5, 1, 1)).unwrap();
            assert_eq!(
                (outsider.fate, outsider.engaged, outsider.troops),
                (Fate::Stays { tile: 44 }, false, 7_000 * 1000)
            );
            assert!(a.fighters.windows(2).all(|w| w[0].id < w[1].id));
            assert!(a.fighters.iter().all(|f| !f.id.is_synthetic()));
            // the scheme's inputs: the exact geometric wedge, the tagged
            // identity as the engagement key, no tie for a garrison
            assert_eq!(
                <WideCombatant as ClashIdentity>::wedge(&key()),
                key().coord().wedge().unwrap()
            );
            let k = <WideCombatant as ClashIdentity>::key(&h(7, 2, 1), true);
            assert_eq!((k[0], k[1]), (1, COMBATANT_TAG_HOST));
            assert_eq!(&k[2..], &r(7, 2, 1).to_bytes());
            let kk = <WideCombatant as ClashIdentity>::key(&keep(), true);
            assert_eq!((kk[0], kk[1]), (1, COMBATANT_TAG_KEEP));
            assert_eq!(&kk[2..2 + PROVINCE_KEY_LEN], &key().to_bytes());
            assert_eq!(kk[2 + PROVINCE_KEY_LEN], 0xfc | COMBATANT_TAG_KEEP);
            assert_eq!(
                &kk[3 + PROVINCE_KEY_LEN..3 + PROVINCE_KEY_LEN + 4],
                &70_001u32.to_le_bytes()
            );
            assert_eq!(
                <WideCombatant as ClashIdentity>::tie(&[9; 32], &h(7, 2, 1)),
                wide_tie_key(&[9; 32], &r(7, 2, 1))
            );
            assert_eq!(<WideCombatant as ClashIdentity>::tie(&[9; 32], &keep()), 0);
            assert_eq!(
                <WideCombatant as ClashIdentity>::clash_seed(&[9; 32], &key(), 11),
                wide_clash_seed(&[9; 32], key(), 11)
            );
            // the digest is a function of the results
            let mut other = a.clone();
            other.engagements += 1;
            assert_ne!(other.digest(), a.digest());
        }

        #[test]
        fn far_coordinates_all_wedges_equal_mass_and_garrison_permutations() {
            for radius in [129i64, (1i64 << 53) + 17] {
                let mut coord = WideCoord::checked(radius, 0).unwrap();
                for _ in 0..6 {
                    let province = ProvinceKey::new(world(9), coord);
                    let remap = |id: WideCombatant| match id {
                        WideCombatant::Host(x) => WideCombatant::Host(
                            WideHostRef::new(province, x.site(), x.gen(), x.seq()).unwrap(),
                        ),
                        WideCombatant::Camp { gen, .. } => {
                            WideCombatant::Camp { key: province, gen }
                        }
                        WideCombatant::Keep { gen, .. } => {
                            WideCombatant::Keep { key: province, gen }
                        }
                    };
                    let mut f = fixture();
                    f.garrisons.push(WideGarrison {
                        id: WideCombatant::Host(r(5, 1, 0)),
                        faction: 2,
                        tile: 44,
                        troops: 4_000_000,
                        walls: true,
                        posture: Posture::default(),
                    });
                    for host in f.residents.iter_mut().chain(f.arrivals.iter_mut()) {
                        host.id = remap(host.id);
                        host.troops = 6_000_000;
                    }
                    for garrison in &mut f.garrisons {
                        garrison.id = remap(garrison.id);
                    }
                    let expected = {
                        let mut i = input(&f);
                        i.province = province;
                        i.occupancy.storage_free = 1;
                        let a = resolve_wide_clash(&frontier_ruleset(), &i).unwrap();
                        assert_eq!(a, resolve_wide_clash_ref(&frontier_ruleset(), &i).unwrap());
                        assert!(a.engagements > 0);
                        assert_eq!(a.garrisons.len(), 3);
                        assert!(a.garrisons.iter().any(|g| g.id == remap(keep())));
                        a
                    };
                    f.residents.reverse();
                    f.arrivals.reverse();
                    f.garrisons.reverse();
                    let mut i = input(&f);
                    i.province = province;
                    i.occupancy.storage_free = 1;
                    assert_eq!(
                        resolve_wide_clash(&frontier_ruleset(), &i).unwrap(),
                        expected
                    );
                    assert_eq!(
                        resolve_wide_clash_ref(&frontier_ruleset(), &i).unwrap(),
                        expected
                    );
                    assert_eq!(
                        <WideCombatant as ClashIdentity>::wedge(&province),
                        coord.wedge().unwrap()
                    );
                    coord = coord.rotate().unwrap();
                }
            }
        }

        #[test]
        fn order_and_an_unrelated_insertion_change_nothing() {
            let f = fixture();
            let base = resolve_wide_clash(&frontier_ruleset(), &input(&f)).unwrap();
            let mut g = fixture();
            g.residents.reverse();
            g.arrivals.reverse();
            assert_eq!(
                resolve_wide_clash(&frontier_ruleset(), &input(&g)).unwrap(),
                base
            );
            // a newcomer whose identity sorts before every other (site 0):
            // every unit index shifts; no result does
            let mut g2 = fixture();
            let newcomer = h(0, 0, 1);
            assert!(g2.residents.iter().all(|x| newcomer < x.id));
            g2.residents
                .push(fighter(newcomer, 3, UnitType::Crossbowman, 5_000, FAR));
            for out in [
                resolve_wide_clash(&frontier_ruleset(), &input(&g2)).unwrap(),
                resolve_wide_clash_ref(&frontier_ruleset(), &input(&g2)).unwrap(),
            ] {
                assert_eq!(out.engagements, base.engagements);
                assert_eq!(out.garrisons, base.garrisons);
                assert_eq!(out.fighters.len(), base.fighters.len() + 1);
                for x in &base.fighters {
                    assert_eq!(out.fighter(&x.id), Some(x), "{x:?}");
                }
                let n = out.fighter(&newcomer).unwrap();
                assert_eq!(
                    (n.fate, n.engaged, n.troops),
                    (Fate::Stays { tile: FAR }, false, 5_000 * 1000)
                );
            }
        }

        #[test]
        fn a_duplicate_identity_is_refused_and_a_synthetic_fighter_never_fights() {
            let mut f = fixture();
            let dup = f.residents[0];
            f.arrivals.push(WideFighter {
                posture: Posture::Stance(Stance::Hold),
                ..dup
            });
            assert_eq!(
                resolve_wide_clash(&frontier_ruleset(), &input(&f)),
                Err(WideClashError::Kernel(ClashErrorOf::DuplicateId(dup.id)))
            );
            // the keep as an arrival: refused before the kernel runs, by
            // both bodies
            let mut s = fixture();
            s.arrivals
                .push(arrival(keep(), 4, UnitType::Knight, 1_000, FAR));
            assert_eq!(
                resolve_wide_clash(&frontier_ruleset(), &input(&s)),
                Err(WideClashError::SyntheticFighter(keep()))
            );
            assert_eq!(
                resolve_wide_clash_ref(&frontier_ruleset(), &input(&s)),
                Err(WideClashError::SyntheticFighter(keep()))
            );
            let camp = WideCombatant::Camp {
                key: key(),
                gen: u32::MAX,
            };
            let mut c = fixture();
            c.residents
                .push(fighter(camp, 5, UnitType::Spearman, 1_000, FAR));
            assert_eq!(
                resolve_wide_clash(&frontier_ruleset(), &input(&c)),
                Err(WideClashError::SyntheticFighter(camp))
            );
        }

        /// The tagged identity's bytes: a host is its strict reference
        /// behind the host tag; the camp and the keep carry the province
        /// key and the full `u32` generation; no variant decodes as another,
        /// an unknown tag or a non-zero pad is refused, and the order is
        /// hosts, camps, keeps.
        #[test]
        fn combatant_bytes_round_trip_and_never_cross_variants() {
            let host = h(7, 2, 1);
            let camp = WideCombatant::Camp {
                key: key(),
                gen: 0xdead_beef,
            };
            let kp = keep();
            for c in [host, camp, kp] {
                let b = c.to_bytes();
                assert_eq!(b.len(), COMBATANT_LEN);
                assert_eq!(WideCombatant::from_bytes(&b), Ok(c));
                assert_eq!(c.province(), key());
            }
            assert_eq!(host.host(), Some(r(7, 2, 1)));
            assert_eq!(camp.host(), None);
            assert!(!host.is_synthetic() && camp.is_synthetic() && kp.is_synthetic());
            assert!(host < camp && camp < kp);
            // the generation is lossless
            assert!(matches!(
                WideCombatant::from_bytes(&camp.to_bytes()),
                Ok(WideCombatant::Camp {
                    gen: 0xdead_beef,
                    ..
                })
            ));
            // a host's bytes under the camp tag: the payload is not a key
            // with zero padding (a reference's site/gen/seq bytes follow)
            let mut x = host.to_bytes();
            x[0] = COMBATANT_TAG_CAMP;
            assert!(WideCombatant::from_bytes(&x).is_err());
            // a camp's bytes under the host tag: the payload is not a
            // strict host reference (its version byte is the key's)
            let mut y = camp.to_bytes();
            y[0] = COMBATANT_TAG_HOST;
            assert!(WideCombatant::from_bytes(&y).is_err());
            let mut z = camp.to_bytes();
            z[0] = 9;
            assert_eq!(
                WideCombatant::from_bytes(&z),
                Err(MarchError::CombatantTag(9))
            );
            let mut p = kp.to_bytes();
            p[COMBATANT_LEN - 1] = 1;
            assert_eq!(WideCombatant::from_bytes(&p), Err(MarchError::Reserved));
            assert_eq!(
                WideCombatant::from_bytes(&p[..56]),
                Err(MarchError::Length {
                    expected: 57,
                    got: 56
                })
            );
            // a camp and a keep of the same province and generation differ
            assert_ne!(
                WideCombatant::Camp { key: key(), gen: 1 },
                WideCombatant::Keep { key: key(), gen: 1 }
            );
            assert_ne!(
                WideCombatant::Camp { key: key(), gen: 1 }.to_bytes(),
                WideCombatant::Keep { key: key(), gen: 1 }.to_bytes()
            );
        }

        #[test]
        fn claim_alias_authenticates_the_full_reference_before_a_write() {
            let (h1, h2, h3) = (r(2, 1, 1), r(2, 1, 2), r(7, 2, 1));
            let (a1, a2) = (wide_host_alias(&h1), wide_host_alias(&h2));
            assert_eq!(claim_alias(&[], &h1), Ok(a1));
            assert_eq!(claim_alias(&[(a1, h1)], &h2), Ok(a2));
            assert_eq!(
                claim_alias(&[(a1, h1), (a2, h2)], &h3),
                Ok(wide_host_alias(&h3))
            );
            assert_eq!(
                claim_alias(&[(a1, h1), (a2, h2)], &h1),
                Err(AliasError::AlreadyPresent { alias: a1 })
            );
            // an entry whose alias is not its own reference's: the table is
            // not this program's writing, whatever host asks
            assert_eq!(
                claim_alias(&[(a1, h2)], &h3),
                Err(AliasError::Unauthenticated { alias: a1 })
            );
            assert_eq!(
                claim_alias(&[(a2, h2), (a1, h2)], &h3),
                Err(AliasError::Unauthenticated { alias: a1 })
            );
            assert!(is_wide_alias(a1) && is_wide_alias(a2));
        }

        #[test]
        fn a_wide_commitment_binds_the_host_and_the_destination() {
            let dest = ProvinceKey::new(world(1), WideCoord::checked(130, -1).unwrap());
            let salt = [0x51u8; 32];
            let c = wide_plain_commit(&r(2, 1, 1), dest, 17, 40, 0, 1, &salt);
            assert_eq!(c, wide_plain_commit(&r(2, 1, 1), dest, 17, 40, 0, 1, &salt));
            assert_ne!(c, wide_plain_commit(&r(2, 1, 2), dest, 17, 40, 0, 1, &salt));
            assert_ne!(
                c,
                wide_plain_commit(&r(2, 1, 1), key(), 17, 40, 0, 1, &salt)
            );
            assert_ne!(c, wide_plain_commit(&r(2, 1, 1), dest, 18, 40, 0, 1, &salt));
            assert_ne!(c, wide_plain_commit(&r(2, 1, 1), dest, 17, 41, 0, 1, &salt));
            assert_ne!(c, wide_plain_commit(&r(2, 1, 1), dest, 17, 40, 1, 1, &salt));
            assert_ne!(c, wide_plain_commit(&r(2, 1, 1), dest, 17, 40, 0, 2, &salt));
            assert_ne!(
                c,
                wide_plain_commit(&r(2, 1, 1), dest, 17, 40, 0, 1, &[0x52u8; 32])
            );
        }
    }
}
