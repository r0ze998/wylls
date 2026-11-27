//! `SeasonParams` v2 (MC contract §5.2.5, §3.12): the 128-B conquest
//! block, its CreateSeason validation, the presets `MC_LOCAL_7D`
//! (Frontier-7), `MC_SEASON_28` (Frontier-28) and `MC_TEST` (R-18), and
//! the v2 ruleset pin.
//!
//! **Wire form.** CreateSeason v2's data is `tag ‖ SeasonParams (224 B,
//! M1's layout, `program_version = 3`) ‖ ConquestParams (128 B) ‖
//! PayoutParams (borsh)`; the program stores the conquest block at Season
//! 896..1,024. The announced params hash commits to all three
//! ([`params_hash_v2`]).
//!
//! **Dormancy timers.** `dormant_after_secs` / `release_after_secs` exist
//! in both M1's part and the conquest block (§5.2.5 lists them in the
//! block); [`SeasonParamsV2::validate`] requires the two copies to be
//! equal (CQ1-C notes, deviation D-3).
//!
//! **Values marked [placeholder]** are working defaults until the
//! measurement or decision named next to them lands.

use crate::bytes::{rd_u16, rd_u32, rd_u8, wr_u16, wr_u32, wr_u8};
use crate::presets::{SeasonParams, M1_LOCAL_7D, SEASON_PARAMS_LEN};
use permutation_rules::hash::sha256;

/// Byte layout of the conquest block (128 B; Season offset 896).
pub mod cq_layout {
    crate::layout::fields!(size = 128;
        CONQUEST_VERSION @ 0 : "u8" = 1;
        HEARTLAND_MAX_RING @ 1 : "u8" = 1;
        SIEGES_PER_DAY @ 2 : "u8" = 1;
        FREE_CITY_MIN_RING @ 3 : "u8" = 1;
        KEEP_BELLS @ 4 : "u16" = 2;
        KEEP_CONSOLIDATE_BELLS @ 6 : "u16" = 2;
        KEEP_HOME_GUARD @ 8 : "u32" = 4;
        KEEP_GARRISON_BPS @ 12 : "u16" = 2;
        IMMUNITY_BELLS @ 14 : "u16" = 2;
        OCCUPATION_TENURE_BELLS @ 16 : "u16" = 2;
        RESPITE_BELLS @ 18 : "u16" = 2;
        SIEGE_STAKE_GOLD @ 20 : "u32" = 4;
        FREE_CITY_GARRISON @ 24 : "u32" = 4;
        CAPTURE_CREDIT_MIN_BELLS @ 28 : "u32" = 4;
        OUTPOST_SHIELD_SECS @ 32 : "u32" = 4;
        SHIELD_SECS @ 36 : "u32" = 4;
        SHIELD_LATE_SECS @ 40 : "u32" = 4;
        SHIELD_LATE_AFTER_SECS @ 44 : "u32" = 4;
        FRONTIER_PROTECT_SECS @ 48 : "u32" = 4;
        FRONTIER_PROTECT_AFTER_SECS @ 52 : "u32" = 4;
        DORMANT_AFTER_SECS @ 56 : "u32" = 4;
        RELEASE_AFTER_SECS @ 60 : "u32" = 4;
        DOMINION_PER_HOUR @ 64 : "u16" = 2;
        DOMINION_PER_CAPTURE @ 66 : "u16" = 2;
        OUTPOST_RANGE @ 68 : "u8" = 1;
        OUTPOST_TIER_MIN @ 69 : "u8" = 1;
        OUTPOST_SHARE_BPS @ 70 : "u16" = 2;
        OUTPOST_CLOSE_BELLS @ 72 : "u16" = 2;
        RETIRE_HOSTS @ 74 : "u8" = 1;
        RELATIONS @ 75 : "u8" = 1;
        FLAGS @ 76 : "u8" = 1;
        PLACEMENT @ 77 : "u8" = 1;
        R_MAX_CEILING @ 78 : "u16" = 2;
        CONTINUOUS @ 80 : "u8" = 1;
        CENTRE @ 81 : "u8" = 1;
        SPAWN_REACH @ 82 : "u8" = 1;
        PACING @ 83 : "u8" = 1;
        DEPART_STAMINA @ 84 : "u8" = 1;
        STARTER_HOST @ 85 : "u16" = 2;
        RSV @ 87 : "rsv" = 41;
    );
}

/// Length of the conquest block.
pub const CONQUEST_PARAMS_LEN: usize = cq_layout::SIZE;
/// Offset of the conquest block in the Season account.
pub const SEASON_CQ_OFFSET: usize = crate::v2::layout::world::season::CONQUEST_PARAMS;
/// Length of `SeasonParams` v2 in CreateSeason's data (224 + 128).
pub const SEASON_PARAMS_V2_LEN: usize = SEASON_PARAMS_LEN + CONQUEST_PARAMS_LEN;
/// Domain of the v2 announced params hash.
pub const PARAMS_DOMAIN_V2: &[u8] = b"PSF-PARAMS-v2";
/// `program_version` of an MC season.
pub const PROGRAM_VERSION_V2: u16 = 3;
/// `program_version` of an S1 season (redesign stage 1: the arms economy).
/// Readers that test `program_version >= PROGRAM_VERSION_V2` treat an S1
/// season as conquest (S1 keeps every MC rule); S1 behaviour is gated on
/// `>= PROGRAM_VERSION_S1`.
pub const PROGRAM_VERSION_S1: u16 = 4;
/// `program_version` of an S1 season with custody (workstream 10, a
/// preview: the `custody-preview` program build, never deployable as it
/// stands). S1 behaviour stays gated on `>= PROGRAM_VERSION_S1`; custody on
/// `>= PROGRAM_VERSION_CUSTODY`.
pub const PROGRAM_VERSION_CUSTODY: u16 = 5;
/// Rules version of S1 with custody (`RULES_VERSION_FRONTIER_V4` 13).
pub const RULES_VERSION_CUSTODY: u16 = permutation_rules::frontier::RULES_VERSION_FRONTIER_V4;
const _: () = assert!(PROGRAM_VERSION_CUSTODY > PROGRAM_VERSION_S1);
/// Rules version of the S1 kernels (`RULES_VERSION_FRONTIER` 11 → 12).
pub const RULES_VERSION_S1: u16 = permutation_rules::frontier::RULES_VERSION_FRONTIER_V3;
/// `conquest_version` of the block.
pub const CONQUEST_VERSION: u8 = 1;
/// Rules version of the MC kernels (`RULES_VERSION_FRONTIER` 10 → 11, §3.13).
pub const RULES_VERSION_V2: u16 = crate::v2::kernel::RULES_VERSION_FRONTIER_V2;
/// Largest bell timer CreateSeason accepts (§5.2.5: 30 days of bells).
/// The kernel's `conquest_bounds` (bound into `RULESET_HASH_V2`), not a
/// copy (integ-W1, review CQ1-C): tenure, Respite, consolidation and
/// capture credit share the one bound.
pub const MAX_TIMER_BELLS: u32 =
    permutation_rules::frontier::conquest_bounds::TENURE_BELLS_MAX as u32;
/// `MAX_HOST_TROOPS` in whole troops (keep and Free City guards, R-01):
/// the kernel's `conquest_bounds::GARRISON_MAX`.
pub const MAX_GUARD_TROOPS: u32 = permutation_rules::frontier::conquest_bounds::GARRISON_MAX;

const _: () = {
    use permutation_rules::frontier::conquest_bounds as B;
    assert!(B::KEEP_CONSOLIDATE_BELLS_MAX as u32 == MAX_TIMER_BELLS);
    assert!(B::CAPTURE_CREDIT_MIN_BELLS_MAX == MAX_TIMER_BELLS);
};

/// `RULESET_HASH_V2` (§3.13, R-16): the hash a v2 program embeds and
/// CreateSeason v2 writes, pinned by `ruleset_hash_v2_is_the_kernels`
/// against [`crate::v2::kernel::ruleset_hash_v2`].
///
/// Pinned once by the integrator after the CQ1-A merge (CQ1-C request R1,
/// `integ-CQ1-NOTES.md`) as `1607f62f…2a5a`; **re-pinned once by the
/// Wave-1 close** (W1C-A; CQH1, CQH3: KEEP_VERSION 2 for the symmetric keep
/// tile, CATALOG_VERSION_V2 2 for K2's train-cost table, DOCTRINE_VERSION_V2
/// 2 for the Knight bound, and the MC tables appended to the input) as
/// `b6dd0f3f…8274` = `permutation_rules::frontier::ruleset_hash_v2()`,
/// also pinned by `cq_m1_ruleset_hash_unchanged_and_v2_pinned`. M1's
/// [`crate::presets::RULESET_HASH`] (`72c6b583…4bd9`) is unchanged and
/// still pinned by `ruleset_hash_is_the_kernels`.
pub const RULESET_HASH_V2: [u8; 32] = [
    0x5f, 0xba, 0xf6, 0x78, 0xbc, 0xc9, 0xf6, 0x6c, 0x74, 0x99, 0xc2, 0xd2, 0x6c, 0xe1, 0x95, 0xc9,
    0xca, 0x3f, 0x78, 0xb3, 0x2a, 0x9f, 0x67, 0xf1, 0x10, 0x89, 0x78, 0x9b, 0x82, 0xc0, 0x1a, 0x8b,
];

/// `RULESET_HASH_V3`: the hash the S1 program embeds and CreateSeason
/// writes in an S1 season, pinned by `ruleset_hash_v3_is_the_kernels`
/// against `permutation_rules::frontier::ruleset_hash_v3` (and by the rules
/// crate's `s1_ruleset_hash_pinned_and_older_hashes_unchanged`). The M1 and
/// MC hashes are unchanged. Re-pinned 2026-11-18 (⑧ (a): `geometry` 3 for
/// placement 2): `234c0dc2…422d` → `1511ae14…3ea2`; re-pinned 2026-11-19 (⑭
/// R2: the centre-free kernel versions): → `e9059c93…de70`.
pub const RULESET_HASH_V3: [u8; 32] = [
    0xe9, 0x05, 0x9c, 0x93, 0x07, 0x18, 0x9f, 0x33, 0x7b, 0x00, 0xa4, 0xb2, 0x16, 0x6b, 0x72, 0xa4,
    0x6e, 0x1c, 0xbb, 0xf8, 0x88, 0x06, 0x8e, 0xd1, 0x05, 0x70, 0x67, 0x54, 0x6d, 0x89, 0xde, 0x70,
];

/// `RULESET_HASH_V4` (workstream 10, a preview): the hash the
/// `custody-preview` program embeds, pinned by
/// `ruleset_hash_v4_is_the_kernels` against
/// `permutation_rules::frontier::ruleset_hash_v4`. It is not
/// `RULESET_HASH_V3`: a custody program refuses every S1 season, and the S1
/// program (which has no custody instructions) refuses every custody one.
pub const RULESET_HASH_V4: [u8; 32] = [
    0xa1, 0xdd, 0xb3, 0x59, 0x0f, 0x7a, 0x15, 0xc1, 0x66, 0xa7, 0x7d, 0x10, 0x36, 0x2d, 0xd2, 0xa4,
    0x99, 0xc9, 0x71, 0x11, 0xa6, 0x02, 0x1d, 0x1e, 0xb2, 0xba, 0xad, 0x0e, 0xd3, 0x6c, 0x8b, 0x62,
];

/// The conquest block (§5.2.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConquestParams {
    pub conquest_version: u8,
    pub heartland_max_ring: u8,
    pub sieges_per_day: u8,
    pub free_city_min_ring: u8,
    pub keep_bells: u16,
    pub keep_consolidate_bells: u16,
    pub keep_home_guard: u32,
    pub keep_garrison_bps: u16,
    pub immunity_bells: u16,
    pub occupation_tenure_bells: u16,
    pub respite_bells: u16,
    pub siege_stake_gold: u32,
    pub free_city_garrison: u32,
    pub capture_credit_min_bells: u32,
    pub outpost_shield_secs: u32,
    pub shield_secs: u32,
    pub shield_late_secs: u32,
    pub shield_late_after_secs: u32,
    pub frontier_protect_secs: u32,
    pub frontier_protect_after_secs: u32,
    pub dormant_after_secs: u32,
    pub release_after_secs: u32,
    pub dominion_per_hour: u16,
    pub dominion_per_capture: u16,
    pub outpost_range: u8,
    pub outpost_tier_min: u8,
    pub outpost_share_bps: u16,
    pub outpost_close_bells: u16,
    pub retire_hosts: u8,
    pub relations: u8,
    pub flags: u8,
    /// First-home placement: [`PLACEMENT_WEDGE`] (each nation's homes in its
    /// own wedge), [`PLACEMENT_DISPERSED`] (each nation's homes in small
    /// groups spread round the heartland rings,
    /// `permutation_rules::frontier::geometry::home_nation`) or
    /// [`PLACEMENT_MIXED`] (the same mixing on every ring, so outer keeps
    /// start mixed too).
    pub placement: u8,
    /// Map growth: the outermost ring ExtendFrontier may raise the season
    /// to (0 = no extension: `r_max` is final).
    pub r_max_ceiling: u16,
    /// Byte 80 of the conquest block. A new continuous world keeps both its
    /// end and join deadline absent.
    pub continuous: u8,
    /// Byte 81 (⑭ R2, owner decision t346u, 2026-11-18): [`CENTRE_CONCORD`]
    /// (ring 0 the Concord, ring 1 the six Seats: every season before the
    /// byte) or [`CENTRE_FREE`] (rings 0 and 1 are ordinary land: sites,
    /// keeps, camps, tickets, sieges; their keeps follow the mixed nation).
    /// `CENTRE_FREE` needs placement 2 and an S1 season.
    pub centre: u8,
    /// Byte 82 (⑭ R3, owner decision t346u, 2026-11-18): where PlaceHome may
    /// put a first home. [`SPAWN_RING`] (0, every season before the byte):
    /// the heartland rings only. `1..=`[`SPAWN_REACH_MAX`]: the heartland, a
    /// settled province, or a province within this many provinces of a
    /// settled one that the transaction names as a witness
    /// ([`spawn_allows`]). Needs placement 2 and an S1 season.
    pub spawn_reach: u8,
    /// Byte 83 (world4-pacing-impl, owner Q-PM2-2 a / Q-PT-4, 2026-11-26/27):
    /// [`PACING_LEGACY`] (0, every world before the byte, world 3) or
    /// [`PACING_FAST_V1`]: a first home may be placed at once on a settled
    /// province up to the map's effective `r_max` (the rim; the legacy
    /// FileTicket lottery stays the fallback), and the base part may take
    /// `min_lead` 1 and a `reveal_window` below 600 s. Needs an S1 season.
    pub pacing: u8,
    /// Byte 84: the stamina a Depart charges (I-32's "the longest path's").
    /// 0 (every world before the byte): the kernel's `march_stamina(32)` = 74;
    /// otherwise `1..=STAMINA_CAP` (120). Needs `pacing` ≥ 1.
    pub depart_stamina: u8,
    /// Byte 85 (`u16`): whole troops of the starter host PlaceHome musters at
    /// a first home's founding (Muster's own entry: joins the roster the next
    /// bell). 0 (every world before the byte): none. Otherwise within the
    /// kernel's host bounds (100..=30,000). Needs `pacing` ≥ 1.
    pub starter_host: u16,
}

/// `pacing` 0: the legacy pacing (every world before byte 83, world 3).
pub const PACING_LEGACY: u8 = 0;
/// `pacing` 1 (world4-pacing-impl): first village at once on a settled rim
/// province; `min_lead` 1 and `reveal_window` 300..600 become legal.
pub const PACING_FAST_V1: u8 = 1;
/// The smallest `reveal_window` a [`PACING_FAST_V1`] world may take (s).
pub const REVEAL_WINDOW_FAST_MIN: u32 = 300;
/// The starter host's bounds in whole troops: the kernel's host bounds
/// (`host::MIN_HOST_TROOPS` 100, `MAX_HOST_TROOPS` 30,000).
pub const STARTER_HOST_MIN: u16 =
    (permutation_rules::frontier::host::MIN_HOST_TROOPS / permutation_rules::fixed::MILLI as u32) as u16;
pub const STARTER_HOST_MAX: u16 =
    (permutation_rules::frontier::host::MAX_HOST_TROOPS / permutation_rules::fixed::MILLI as u32) as u16;

/// `spawn_reach` 0: first homes in the heartland rings only (the ring rule).
pub const SPAWN_RING: u8 = 0;
/// The largest `spawn_reach` (provinces from a settled province).
pub const SPAWN_REACH_MAX: u8 = 8;
/// The `spawn_reach` of the playable/devnet presets (⑭ R3): one empty
/// province of buffer, below `outpost_range` 3, so a newcomer lands next to
/// the settled land, not inside it.
pub const SPAWN_PLAYABLE: u8 = 2;

/// ⑭ R3's PlaceHome rule beyond the nation and the open rings, shared by the
/// program and the verifier: may a first home go to a province of `ring`?
///
/// - `spawn_reach` 0 (the ring rule): only `2..=heartland_max_ring`, and no
///   witness may be named;
/// - otherwise: ring ≥ 2 and one of: the heartland (the genesis seed of the
///   settled land), the target province already settled
///   (`target_used` = its `N_SITES_USED` > 0), or a witness province
///   (`distance` from the target, its `N_SITES_USED`) that is settled and at
///   most `spawn_reach` provinces away.
pub fn spawn_allows(
    spawn_reach: u8,
    heartland_max_ring: u8,
    ring: u32,
    target_used: u8,
    witness: Option<(u32, u8)>,
) -> bool {
    if ring < 2 {
        return false;
    }
    if spawn_reach == SPAWN_RING {
        return witness.is_none() && ring <= heartland_max_ring as u32;
    }
    ring <= heartland_max_ring as u32
        || target_used > 0
        || witness.is_some_and(|(d, used)| used > 0 && d <= spawn_reach as u32)
}

/// `centre` 0: the Concord (ring 0) and the Seats (ring 1).
pub const CENTRE_CONCORD: u8 = 0;
/// `centre` 1 (⑭ R2): no centre; rings 0 and 1 are ordinary land.
pub const CENTRE_FREE: u8 = 1;

/// `placement` 0: the wedge rule (every season before the field existed).
pub const PLACEMENT_WEDGE: u8 = permutation_rules::frontier::geometry::PLACEMENT_WEDGE;
/// `placement` 1: dispersed small groups in the heartland rings.
pub const PLACEMENT_DISPERSED: u8 = permutation_rules::frontier::geometry::PLACEMENT_DISPERSED;
/// `placement` 2 (⑧ wide land (i)): the dispersed rule on every ring, the
/// heartland and beyond (`geometry::PLACEMENT_MIXED`). A new value: a
/// program built before it refuses it at CreateSeason.
pub const PLACEMENT_MIXED: u8 = permutation_rules::frontier::geometry::PLACEMENT_MIXED;

impl ConquestParams {
    pub fn to_bytes(&self) -> [u8; CONQUEST_PARAMS_LEN] {
        use cq_layout as L;
        let mut d = [0u8; CONQUEST_PARAMS_LEN];
        // Every offset is a constant of the 128-B layout.
        let _ = wr_u8(&mut d, L::CONQUEST_VERSION, self.conquest_version)
            & wr_u8(&mut d, L::HEARTLAND_MAX_RING, self.heartland_max_ring)
            & wr_u8(&mut d, L::SIEGES_PER_DAY, self.sieges_per_day)
            & wr_u8(&mut d, L::FREE_CITY_MIN_RING, self.free_city_min_ring)
            & wr_u16(&mut d, L::KEEP_BELLS, self.keep_bells)
            & wr_u16(
                &mut d,
                L::KEEP_CONSOLIDATE_BELLS,
                self.keep_consolidate_bells,
            )
            & wr_u32(&mut d, L::KEEP_HOME_GUARD, self.keep_home_guard)
            & wr_u16(&mut d, L::KEEP_GARRISON_BPS, self.keep_garrison_bps)
            & wr_u16(&mut d, L::IMMUNITY_BELLS, self.immunity_bells)
            & wr_u16(
                &mut d,
                L::OCCUPATION_TENURE_BELLS,
                self.occupation_tenure_bells,
            )
            & wr_u16(&mut d, L::RESPITE_BELLS, self.respite_bells)
            & wr_u32(&mut d, L::SIEGE_STAKE_GOLD, self.siege_stake_gold)
            & wr_u32(&mut d, L::FREE_CITY_GARRISON, self.free_city_garrison)
            & wr_u32(
                &mut d,
                L::CAPTURE_CREDIT_MIN_BELLS,
                self.capture_credit_min_bells,
            )
            & wr_u32(&mut d, L::OUTPOST_SHIELD_SECS, self.outpost_shield_secs)
            & wr_u32(&mut d, L::SHIELD_SECS, self.shield_secs)
            & wr_u32(&mut d, L::SHIELD_LATE_SECS, self.shield_late_secs)
            & wr_u32(
                &mut d,
                L::SHIELD_LATE_AFTER_SECS,
                self.shield_late_after_secs,
            )
            & wr_u32(&mut d, L::FRONTIER_PROTECT_SECS, self.frontier_protect_secs)
            & wr_u32(
                &mut d,
                L::FRONTIER_PROTECT_AFTER_SECS,
                self.frontier_protect_after_secs,
            )
            & wr_u32(&mut d, L::DORMANT_AFTER_SECS, self.dormant_after_secs)
            & wr_u32(&mut d, L::RELEASE_AFTER_SECS, self.release_after_secs)
            & wr_u16(&mut d, L::DOMINION_PER_HOUR, self.dominion_per_hour)
            & wr_u16(&mut d, L::DOMINION_PER_CAPTURE, self.dominion_per_capture)
            & wr_u8(&mut d, L::OUTPOST_RANGE, self.outpost_range)
            & wr_u8(&mut d, L::OUTPOST_TIER_MIN, self.outpost_tier_min)
            & wr_u16(&mut d, L::OUTPOST_SHARE_BPS, self.outpost_share_bps)
            & wr_u16(&mut d, L::OUTPOST_CLOSE_BELLS, self.outpost_close_bells)
            & wr_u8(&mut d, L::RETIRE_HOSTS, self.retire_hosts)
            & wr_u8(&mut d, L::RELATIONS, self.relations)
            & wr_u8(&mut d, L::FLAGS, self.flags)
            & wr_u8(&mut d, L::PLACEMENT, self.placement)
            & wr_u16(&mut d, L::R_MAX_CEILING, self.r_max_ceiling)
            & wr_u8(&mut d, L::CONTINUOUS, self.continuous)
            & wr_u8(&mut d, L::CENTRE, self.centre)
            & wr_u8(&mut d, L::SPAWN_REACH, self.spawn_reach)
            & wr_u8(&mut d, L::PACING, self.pacing)
            & wr_u8(&mut d, L::DEPART_STAMINA, self.depart_stamina)
            & wr_u16(&mut d, L::STARTER_HOST, self.starter_host);
        d
    }

    /// Decodes the 128-B block; `None` if short or a reserved byte is set.
    pub fn from_bytes(d: &[u8]) -> Option<ConquestParams> {
        use cq_layout as L;
        if d.len() < CONQUEST_PARAMS_LEN
            || d[L::PLACEMENT] > PLACEMENT_MIXED
            || d[L::CONTINUOUS] > 1
            || d[L::CENTRE] > CENTRE_FREE
            || d[L::SPAWN_REACH] > SPAWN_REACH_MAX
            || d[L::PACING] > PACING_FAST_V1
            || d[L::RSV..CONQUEST_PARAMS_LEN].iter().any(|b| *b != 0)
        {
            return None;
        }
        Some(ConquestParams {
            conquest_version: rd_u8(d, L::CONQUEST_VERSION)?,
            heartland_max_ring: rd_u8(d, L::HEARTLAND_MAX_RING)?,
            sieges_per_day: rd_u8(d, L::SIEGES_PER_DAY)?,
            free_city_min_ring: rd_u8(d, L::FREE_CITY_MIN_RING)?,
            keep_bells: rd_u16(d, L::KEEP_BELLS)?,
            keep_consolidate_bells: rd_u16(d, L::KEEP_CONSOLIDATE_BELLS)?,
            keep_home_guard: rd_u32(d, L::KEEP_HOME_GUARD)?,
            keep_garrison_bps: rd_u16(d, L::KEEP_GARRISON_BPS)?,
            immunity_bells: rd_u16(d, L::IMMUNITY_BELLS)?,
            occupation_tenure_bells: rd_u16(d, L::OCCUPATION_TENURE_BELLS)?,
            respite_bells: rd_u16(d, L::RESPITE_BELLS)?,
            siege_stake_gold: rd_u32(d, L::SIEGE_STAKE_GOLD)?,
            free_city_garrison: rd_u32(d, L::FREE_CITY_GARRISON)?,
            capture_credit_min_bells: rd_u32(d, L::CAPTURE_CREDIT_MIN_BELLS)?,
            outpost_shield_secs: rd_u32(d, L::OUTPOST_SHIELD_SECS)?,
            shield_secs: rd_u32(d, L::SHIELD_SECS)?,
            shield_late_secs: rd_u32(d, L::SHIELD_LATE_SECS)?,
            shield_late_after_secs: rd_u32(d, L::SHIELD_LATE_AFTER_SECS)?,
            frontier_protect_secs: rd_u32(d, L::FRONTIER_PROTECT_SECS)?,
            frontier_protect_after_secs: rd_u32(d, L::FRONTIER_PROTECT_AFTER_SECS)?,
            dormant_after_secs: rd_u32(d, L::DORMANT_AFTER_SECS)?,
            release_after_secs: rd_u32(d, L::RELEASE_AFTER_SECS)?,
            dominion_per_hour: rd_u16(d, L::DOMINION_PER_HOUR)?,
            dominion_per_capture: rd_u16(d, L::DOMINION_PER_CAPTURE)?,
            outpost_range: rd_u8(d, L::OUTPOST_RANGE)?,
            outpost_tier_min: rd_u8(d, L::OUTPOST_TIER_MIN)?,
            outpost_share_bps: rd_u16(d, L::OUTPOST_SHARE_BPS)?,
            outpost_close_bells: rd_u16(d, L::OUTPOST_CLOSE_BELLS)?,
            retire_hosts: rd_u8(d, L::RETIRE_HOSTS)?,
            relations: rd_u8(d, L::RELATIONS)?,
            flags: rd_u8(d, L::FLAGS)?,
            placement: rd_u8(d, L::PLACEMENT)?,
            r_max_ceiling: rd_u16(d, L::R_MAX_CEILING)?,
            continuous: rd_u8(d, L::CONTINUOUS)?,
            centre: rd_u8(d, L::CENTRE)?,
            spawn_reach: rd_u8(d, L::SPAWN_REACH)?,
            pacing: rd_u8(d, L::PACING)?,
            depart_stamina: rd_u8(d, L::DEPART_STAMINA)?,
            starter_host: rd_u16(d, L::STARTER_HOST)?,
        })
    }

    /// The block as stored in a Season v2 account (896..1,024).
    pub fn of_season(season: &[u8]) -> Option<ConquestParams> {
        Self::from_bytes(season.get(SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + CONQUEST_PARAMS_LEN)?)
    }

    /// CreateSeason's ranges for the block (§5.2.5) against a season of
    /// `end_bell` bells; `Err` names the first failing field (`BadParams`).
    pub fn validate(&self, end_bell: u32) -> Result<(), &'static str> {
        let p = self;
        let season_secs = end_bell as u64 * 600;
        let secs_ok = |s: u32| s as u64 <= season_secs;
        use permutation_rules::frontier::conquest_bounds as B;
        let bells_ok = |b: u32| b <= MAX_TIMER_BELLS && b <= end_bell;
        let checks: [(bool, &'static str); 27] = [
            (p.conquest_version == CONQUEST_VERSION, "conquest_version"),
            (p.relations == B::RELATIONS_MC, "relations"),
            (p.flags == B::FLAGS_MC, "flags"),
            (
                (B::HEARTLAND_MAX_RING_MIN..=B::HEARTLAND_MAX_RING_MAX)
                    .contains(&p.heartland_max_ring),
                "heartland_max_ring",
            ),
            (
                p.free_city_min_ring == 0
                    || (p.free_city_min_ring > p.heartland_max_ring
                        && p.free_city_min_ring <= B::FREE_CITY_MIN_RING_MAX),
                "free_city_min_ring",
            ),
            (
                (B::KEEP_BELLS_MIN..=B::KEEP_BELLS_MAX).contains(&p.keep_bells),
                "keep_bells",
            ),
            (
                bells_ok(p.keep_consolidate_bells as u32),
                "keep_consolidate_bells",
            ),
            (
                p.keep_garrison_bps <= B::KEEP_GARRISON_BPS_MAX,
                "keep_garrison_bps",
            ),
            (
                (B::SIEGES_PER_DAY_MIN..=B::SIEGES_PER_DAY_MAX).contains(&p.sieges_per_day),
                "sieges_per_day",
            ),
            (
                bells_ok(p.occupation_tenure_bells as u32),
                "occupation_tenure_bells",
            ),
            (bells_ok(p.respite_bells as u32), "respite_bells"),
            (bells_ok(p.immunity_bells as u32), "immunity_bells"),
            (p.keep_home_guard <= MAX_GUARD_TROOPS, "keep_home_guard"),
            (
                p.free_city_garrison <= MAX_GUARD_TROOPS,
                "free_city_garrison",
            ),
            (
                bells_ok(p.capture_credit_min_bells),
                "capture_credit_min_bells",
            ),
            (secs_ok(p.outpost_shield_secs), "outpost_shield_secs"),
            (
                secs_ok(p.shield_secs) && secs_ok(p.shield_late_secs),
                "shield_secs",
            ),
            (secs_ok(p.shield_late_after_secs), "shield_late_after_secs"),
            (
                secs_ok(p.frontier_protect_secs) && secs_ok(p.frontier_protect_after_secs),
                "frontier_protect_secs",
            ),
            (
                secs_ok(p.dormant_after_secs)
                    && secs_ok(p.release_after_secs)
                    && p.release_after_secs >= p.dormant_after_secs,
                "release_after_secs",
            ),
            (p.retire_hosts <= 1, "retire_hosts"),
            (p.placement <= PLACEMENT_MIXED, "placement"),
            (p.outpost_tier_min <= 3, "outpost_tier_min"),
            (p.outpost_share_bps <= 10_000, "outpost_share_bps"),
            ((1..=8).contains(&p.outpost_range), "outpost_range"),
            (
                (p.outpost_close_bells as u32) < end_bell,
                "outpost_close_bells",
            ),
            (
                p.dominion_per_hour > 0 || p.dominion_per_capture > 0,
                "dominion",
            ),
        ];
        match checks.iter().find(|(ok, _)| !ok) {
            Some((_, name)) => Err(name),
            None => Ok(()),
        }
    }
}

/// CreateSeason v2's parameters: M1's part (with `program_version = 3`)
/// and the conquest block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeasonParamsV2 {
    pub base: SeasonParams,
    pub cq: ConquestParams,
}

impl SeasonParamsV2 {
    pub fn to_bytes(&self) -> [u8; SEASON_PARAMS_V2_LEN] {
        let mut d = [0u8; SEASON_PARAMS_V2_LEN];
        d[..SEASON_PARAMS_LEN].copy_from_slice(&self.base.to_bytes());
        d[SEASON_PARAMS_LEN..].copy_from_slice(&self.cq.to_bytes());
        d
    }

    pub fn from_bytes(d: &[u8]) -> Option<SeasonParamsV2> {
        if d.len() != SEASON_PARAMS_V2_LEN {
            return None;
        }
        Some(SeasonParamsV2 {
            base: SeasonParams::from_bytes(&d[..SEASON_PARAMS_LEN])?,
            cq: ConquestParams::from_bytes(&d[SEASON_PARAMS_LEN..])?,
        })
    }

    /// M1's ranges, `program_version` 3 (MC), 4 (S1) or 5 (S1 with
    /// custody, same parameters), the block's ranges and the dormancy timers
    /// agreeing in both parts. The program refuses a version other than its
    /// own.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.cq.continuous > 1 {
            return Err("continuous");
        }
        if self.cq.pacing > PACING_FAST_V1
            || (self.cq.pacing != PACING_LEGACY
                && self.base.program_version < PROGRAM_VERSION_S1)
        {
            return Err("pacing");
        }
        let fast = self.cq.pacing == PACING_FAST_V1;
        // world4-pacing-impl: the Depart stamina and the starter host are
        // new-world bytes (0 = the legacy rule) and need `pacing` ≥ 1.
        if self.cq.depart_stamina != 0
            && (!fast
                || self.cq.depart_stamina as u16 > permutation_rules::frontier::host::STAMINA_CAP)
        {
            return Err("depart_stamina");
        }
        if self.cq.starter_host != 0
            && (!fast
                || !(STARTER_HOST_MIN..=STARTER_HOST_MAX).contains(&self.cq.starter_host))
        {
            return Err("starter_host");
        }
        self.base.validate_paced(self.cq.continuous == 1, fast)?;
        if self.base.program_version != PROGRAM_VERSION_V2
            && self.base.program_version != PROGRAM_VERSION_S1
            && self.base.program_version != PROGRAM_VERSION_CUSTODY
        {
            return Err("program_version");
        }
        // ⑧ (a): placement 2 is an S1 rule (`geometry` 3, bound into
        // RULESET_HASH_V3/V4 only); an MC season, whose RULESET_HASH_V2 does
        // not commit to it, refuses it.
        if self.cq.placement == PLACEMENT_MIXED && self.base.program_version < PROGRAM_VERSION_S1 {
            return Err("placement");
        }
        // ⑭ R2: a centre-free season is an S1 season of placement 2 (its
        // rings 0-1 keeps follow the mixed nation; RULESET_HASH_V2 does not
        // commit to the rule).
        if self.cq.centre > CENTRE_FREE
            || (self.cq.centre == CENTRE_FREE
                && (self.cq.placement != PLACEMENT_MIXED
                    || self.base.program_version < PROGRAM_VERSION_S1))
        {
            return Err("centre");
        }
        // ⑭ R3: a hull-spawn season is an S1 season of placement 2 (a home
        // outside the heartland takes the mixed nation of its ring).
        if self.cq.spawn_reach > SPAWN_REACH_MAX
            || (self.cq.spawn_reach != SPAWN_RING
                && (self.cq.placement != PLACEMENT_MIXED
                    || self.base.program_version < PROGRAM_VERSION_S1))
        {
            return Err("spawn");
        }
        if self.base.dormant_after_secs != self.cq.dormant_after_secs
            || self.base.release_after_secs != self.cq.release_after_secs
        {
            return Err("dormancy timers differ");
        }
        // Map growth: 0, or above `r_max` and within the program's hard
        // maximum (geometry `R_MAX_HARD`).
        let ceiling = self.cq.r_max_ceiling;
        if ceiling != 0
            && (ceiling <= self.base.r_max
                || ceiling > permutation_rules::frontier::geometry::R_MAX_HARD)
        {
            return Err("r_max_ceiling");
        }
        self.cq.validate(self.base.end_bell)
    }

    /// The keep kernel's `KeepParams` of this season.
    pub fn keep_params(&self) -> crate::v2::kernel::keep::KeepParams {
        self.cq.keep_params()
    }
}

impl ConquestParams {
    /// The keep kernel's parameters (`keep_bells` ≤ 255 by validation).
    pub fn keep_params(&self) -> crate::v2::kernel::keep::KeepParams {
        crate::v2::kernel::keep::KeepParams {
            bells: self.keep_bells.min(255) as u8,
            consolidate_bells: self.keep_consolidate_bells as u32,
            home_guard: self.keep_home_guard,
            garrison_bps: self.keep_garrison_bps,
        }
    }
}

/// `params_hash = sha256("PSF-PARAMS-v2" ‖ SeasonParams v2 ‖ PayoutParams)`.
pub fn params_hash_v2(params: &[u8; SEASON_PARAMS_V2_LEN], payout: &[u8]) -> [u8; 32] {
    sha256(&[PARAMS_DOMAIN_V2, params, payout])
}

/// Frontier-7's conquest block (§3.12, the exit, nightlies and demo).
pub const FRONTIER_7: ConquestParams = ConquestParams {
    conquest_version: CONQUEST_VERSION,
    heartland_max_ring: 3,
    sieges_per_day: 2,
    free_city_min_ring: 4,
    keep_bells: 72,
    keep_consolidate_bells: 288,
    keep_home_guard: 100,
    keep_garrison_bps: 5_000,
    immunity_bells: 36,
    occupation_tenure_bells: 72,
    respite_bells: 72,
    siege_stake_gold: 500,
    free_city_garrison: 300,
    capture_credit_min_bells: 144,
    outpost_shield_secs: 7_200,
    shield_secs: 86_400,
    shield_late_secs: 86_400,
    shield_late_after_secs: 172_800,
    frontier_protect_secs: 129_600,
    frontier_protect_after_secs: 43_200,
    // v1.1, R-14: dormant after 3 days, release after the whole season.
    dormant_after_secs: 259_200,
    release_after_secs: 604_800,
    dominion_per_hour: 6,
    dominion_per_capture: 36,
    outpost_range: 3,
    // Town (`holding::Tier::Town as u8`).
    outpost_tier_min: 1,
    outpost_share_bps: 5_000,
    outpost_close_bells: 24,
    retire_hosts: 1,
    relations: 0,
    flags: 0,
    placement: PLACEMENT_WEDGE,
    r_max_ceiling: 0,
    continuous: 0,
    centre: CENTRE_CONCORD,
    spawn_reach: SPAWN_RING,
    pacing: PACING_LEGACY,
    depart_stamina: 0,
    starter_host: 0,
};

/// Frontier-28's conquest block (§3.12).
pub const FRONTIER_28: ConquestParams = ConquestParams {
    occupation_tenure_bells: 288,
    respite_bells: 288,
    capture_credit_min_bells: 288,
    shield_secs: 172_800,
    shield_late_secs: 259_200,
    shield_late_after_secs: 604_800,
    frontier_protect_secs: 604_800,
    frontier_protect_after_secs: 172_800,
    // M1's values (5 / 10 days).
    dormant_after_secs: 432_000,
    release_after_secs: 864_000,
    ..FRONTIER_7
};

/// `MC_LOCAL_7D`: M1's 7-day local season with ABI v2 and Frontier-7
/// (the exit's preset, §13.4).
pub const MC_LOCAL_7D: SeasonParamsV2 = SeasonParamsV2 {
    base: SeasonParams {
        program_version: PROGRAM_VERSION_V2,
        reveal_cu_limit: 26_000,
        reveal_loaded_limit: 1_540_096,
        dormant_after_secs: FRONTIER_7.dormant_after_secs,
        release_after_secs: FRONTIER_7.release_after_secs,
        // [placeholder] OpenRing's fund check is `d × rent(4,736)` (§5.2.1):
        // 817 provinces within ring 16 × 24,709,120 ≈ 20.19 SOL over 6
        // wedge funds, rounded up, test SOL.
        pfund_initial: 21_000_000_000,
        ..M1_LOCAL_7D
    },
    cq: FRONTIER_7,
};

/// Standard shared-world season: fourteen days, ten-minute bells.
/// Protection dormancy and the economic kernel both begin after five
/// inactive days; dormant production is halved until the owner acts.
/// Dormancy never releases a player's home during this standard season.
pub const MC_LOCAL_14D: SeasonParamsV2 = SeasonParamsV2 {
    base: SeasonParams {
        genesis_ring: 4,
        end_bell: 2_016,
        join_close_bell: 1_512,
        dormant_after_secs: 5 * 86_400,
        release_after_secs: 14 * 86_400,
        ..MC_LOCAL_7D.base
    },
    cq: ConquestParams {
        dormant_after_secs: 5 * 86_400,
        release_after_secs: 14 * 86_400,
        ..FRONTIER_7
    },
};

/// `MC_SEASON_28`: a 28-day season with Frontier-28 timers.
/// [placeholder] Every M1 field besides the length, the join close (75 %,
/// as M1's 756 of 1,008) and the dormancy timers is `MC_LOCAL_7D`'s until
/// the M2 season sheet sets them (fees and caps are M2's).
pub const MC_SEASON_28: SeasonParamsV2 = SeasonParamsV2 {
    base: SeasonParams {
        end_bell: 4_032,
        join_close_bell: 3_024,
        dormant_after_secs: FRONTIER_28.dormant_after_secs,
        release_after_secs: FRONTIER_28.release_after_secs,
        ..MC_LOCAL_7D.base
    },
    cq: FRONTIER_28,
};

/// `MC_TEST` (v1.1, R-18; itests and smokes only, never the exit or the
/// demo): Frontier-7 with short timers so one game day shows every event.
pub const MC_TEST: SeasonParamsV2 = SeasonParamsV2 {
    base: MC_LOCAL_7D.base,
    cq: ConquestParams {
        heartland_max_ring: 2,
        free_city_min_ring: 3,
        shield_secs: 7_200,
        shield_late_secs: 7_200,
        // Hamlet.
        outpost_tier_min: 0,
        keep_bells: 24,
        keep_consolidate_bells: 48,
        occupation_tenure_bells: 24,
        respite_bells: 24,
        immunity_bells: 12,
        capture_credit_min_bells: 36,
        frontier_protect_secs: 0,
        ..FRONTIER_7
    },
};

/// Every v2 preset with its name (vectors).
pub const PRESETS: [(&str, SeasonParamsV2); 4] = [
    ("MC_LOCAL_7D", MC_LOCAL_7D),
    ("MC_LOCAL_14D", MC_LOCAL_14D),
    ("MC_SEASON_28", MC_SEASON_28),
    ("MC_TEST", MC_TEST),
];

/// An MC preset as an S1 season: the same parameters with
/// `program_version = 4` (the S1 rules live in the kernels, not in the
/// parameters).
pub const fn s1(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.base.program_version = PROGRAM_VERSION_S1;
    q.base.reveal_loaded_limit = REVEAL_LOADED_LIMIT_S1;
    q.base.reveal_cu_limit = crate::v2::budgets::REVEAL_CU_LIMIT_S1;
    q
}

/// `L(Reveal)` under the S1 release (`budgets::loaded_limit_s1`; pinned by
/// `reveal_profile_matches_v2_budgets`).
pub const REVEAL_LOADED_LIMIT_S1: u32 = 1_867_776;

/// The placement a new playable/devnet season starts with (owner decision
/// t346u, 2026-11-18): ⑭ R1 (no wedge pointing at (0,0)) together with ⑧ (c)
/// — [`PLACEMENT_MIXED`], the dispersed heartland with the same mixing on
/// every outer ring and on into the wide land. Only these presets: every
/// MC preset and `S1_TEST` keep the wedge.
pub const PLACEMENT_PLAYABLE: u8 = PLACEMENT_MIXED;

/// A season with no centre: the playable/devnet presets' first homes are not
/// laid out as six wedges about (0,0) but by [`PLACEMENT_PLAYABLE`] (⑭ R1,
/// ⑧ (c)); its `centre` is [`CENTRE_PLAYABLE`] (⑭ R2) and its first homes
/// follow the settled land ([`SPAWN_PLAYABLE`], ⑭ R3). Every other byte is
/// unchanged.
pub const fn centreless(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.cq.placement = PLACEMENT_PLAYABLE;
    q.cq.centre = CENTRE_PLAYABLE;
    q.cq.spawn_reach = SPAWN_PLAYABLE;
    q
}

/// The `centre` a new playable/devnet season starts with. ⑭ R2 is
/// implemented and validated on chain, in the verifier and in the herald,
/// but stays [`CENTRE_CONCORD`] here until the page's own kernels take the
/// flag (frontier-wasm `generate_province` / the path planner regenerate
/// (0,0)'s land from its seed; with [`CENTRE_FREE`] they would draw and
/// route the old six-fold Concord). Flipping this constant is the switch.
pub const CENTRE_PLAYABLE: u8 = CENTRE_CONCORD;

/// `S1_LOCAL_7D`, `S1_LOCAL_14D` and `S1_TEST`: the MC presets of the same
/// names for the S1 program (redesign 30, J5: stage 1 runs in a new
/// season). `S1_LOCAL_7D` and `S1_LOCAL_14D` are the playable presets (the
/// S1 devnet profile, frontier-operator and the local natural world use
/// them; the playable lane's devnet profile uses [`S1_DEVNET_WIDE_7D`], whose
/// map can reach the wide land) and are [`centreless`] (⑭ R1); `S1_TEST`
/// (itests and smokes only) keeps the wedge, as every MC preset does.
pub const S1_LOCAL_7D: SeasonParamsV2 = centreless(s1(MC_LOCAL_7D));
pub const S1_LOCAL_14D: SeasonParamsV2 = centreless(s1(MC_LOCAL_14D));
pub const S1_TEST: SeasonParamsV2 = s1(MC_TEST);

/// A season as a CONTINUOUS world (conquest byte 80 `continuous = 1`, the
/// end and join-close bells the no-end sentinel): the shape
/// [`SeasonParamsV2::validate`] requires of a continuous world, every other
/// byte unchanged.
pub const fn continuous(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.cq.continuous = 1;
    q.base.end_bell = crate::presets::NO_END_BELL;
    q.base.join_close_bell = crate::presets::NO_END_BELL;
    q
}

/// `S1_LOCAL_7D` as a continuous world (⑧ P1: the local launcher's opt-in
/// `--continuous local-continuous-v1`): the same parameters, no end bell, joins
/// always open, `EndSeason` refused (`CqError::ContinuousWorld`).
pub const S1_LOCAL_CONTINUOUS: SeasonParamsV2 = continuous(S1_LOCAL_7D);

/// θ of [`S1_DEVNET_WIDE_7D`]: 1 bp, i.e. "some wedge has a settler"
/// (`ring_occupancy_met` needs `occupied × 10,000 ≥ 1 × open`, so one
/// occupied site in a wedge of fewer than 10,000 open sites). The ring still
/// needs a bell since the last opening, its drand round and the funds.
pub const THETA_DEVNET_WIDE_BPS: u16 = 1;

/// `pfund_initial` of [`S1_DEVNET_WIDE_7D`]: 36 SOL, 6 SOL per wedge fund
/// (CreateSeason's `wedge_share`). The fund checks are balance checks, not
/// spends: the last legacy ring needs every fund above its rent by
/// `128 × rent(4,736)`, the first wide ring by `129 × rent(4,864)` (wide
/// province). At devnet's measured 5,080 lamports/byte that is 3.163 SOL /
/// 3.271 SOL; at the classic 6,960 (LiteSVM, a possible devnet reset)
/// 4.333 / 4.482 SOL. 6 SOL leaves 2.73 SOL (≈ 110 provinces) per wedge of
/// opening headroom at 5,080 and 1.52 SOL (≈ 44) at 6,960. Test SOL; float
/// (returned by CloseSeason, never paid out).
pub const PFUND_DEVNET_WIDE: u64 = 36_000_000_000;

/// The DEVNET playable season (owner decision B7: the playable lane,
/// expedition / wide land / conquest, on devnet; Q-D3: a smaller preset is
/// fine). `S1_LOCAL_7D` (centre-free placement, 7 days, `r_max` 16) with
/// exactly four changes, the first three so the wide land that starts at ring 129
/// (`world_index::land::FIRST_WIDE_RING`, which needs the legacy ring 128
/// seeded) is reachable in one season:
///
/// - `r_max_ceiling = 128` (map growth: ExtendFrontier raises the outermost
///   ring one ring per bell up to the legacy rim; `S1_LOCAL_7D` has 0, so its
///   map ends at ring 16 and no wide instruction but WideSetRules can land);
/// - `θ = 1 bp` early and late ([`THETA_DEVNET_WIDE_BPS`]): growth needs a
///   settler in some wedge, not 55–65 % of its sites (a 50-player devnet
///   season never crowds 55 % of even the genesis rings);
/// - `pfund_initial` = [`PFUND_DEVNET_WIDE`] (the rim and ring 129 fund
///   checks).
///
/// - `outpost_tier_min = 0` (Hamlet, [`OUTPOST_TIER_DEVNET_WIDE`]; owner
///   decision Q-W1, 2026-11-20 t398u): a first village may also be founded
///   on the RIM (rings 126–128, beside the wide land), as in local wide play,
///   and that rim village anchors a wide claim while it is still a Hamlet.
///   The rim first village itself needs no parameter: FileTicket names any
///   opened ring of the player's nation and a keeper's `tickets` role settles
///   it (PlaceHome stays capped at the base `r_max` 16).
///
/// From genesis ring 3 the rim is 125 openings away, one bell (600 s) each:
/// ≈ 21 h of a 1,008-bell season, then ring 129 the bell after. Rings past
/// the genesis are opened without their provinces (a keeper's
/// `lazy_provinces`); a province opens when someone needs it (the rim's by a
/// keeper's `rim_per_wedge`).
pub const S1_DEVNET_WIDE_7D: SeasonParamsV2 = devnet_wide(S1_LOCAL_7D);

/// The DEVNET playable world as a CONTINUOUS world (owner 2026-11-23 22:42
/// JST: seasons abolished, "the world continues"; t481u Q11 2026-11-24:
/// the devnet world changes to it): [`S1_DEVNET_WIDE_7D`] through
/// [`continuous`], i.e. conquest byte 80 `continuous = 1` and the end and
/// join-close bells the no-end sentinel, every other byte unchanged. Joins
/// stay open, `EndSeason` is refused (`CqError::ContinuousWorld`), no
/// CloseSeason ever runs. The deployed devnet program (base 6912906d)
/// already validates and stores this shape (commit 2c29496f); no program
/// change.
pub const S1_DEVNET_WIDE_CONTINUOUS: SeasonParamsV2 = continuous(S1_DEVNET_WIDE_7D);

/// `release_after_secs` meaning **never** (owner decision 2026-11-24 12:07
/// JST U3: the 7-day idle first-village release, ReleaseDormant, is removed
/// from the new world's rules). The program refuses ReleaseDormant
/// (`NotDormant`) for a Season storing it, before reading anything else;
/// CreateSeason accepts it only in a world with no end bell (a finite
/// season's `release_after_secs ≤ season length` check refuses it). The
/// separate dormancy rule (5 days idle → half production, Shield lapses) is
/// unchanged.
pub const RELEASE_DORMANT_NEVER: u32 = u32::MAX;

/// `p` with the first-village release removed ([`RELEASE_DORMANT_NEVER`]
/// in both blocks, which must agree).
pub const fn no_dormant_release(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.base.release_after_secs = RELEASE_DORMANT_NEVER;
    q.cq.release_after_secs = RELEASE_DORMANT_NEVER;
    q
}

/// **The new devnet world** (territory-impl, owner decisions 2026-11-24
/// 12:03–12:09 JST): [`S1_DEVNET_WIDE_CONTINUOUS`] without the idle
/// first-village release (U3, [`no_dormant_release`]). The wide land's
/// rules ride the experimental rules configuration, not the Season: the
/// operator sends WideSetRules with keep holder
/// `rules::KeepHolderRule::NeutralTerritoryV1` (every wide keep unowned and
/// weaker, player territory V1). Not announced, not created (12:07 U2:
/// after the upgrade).
pub const S1_DEVNET_TERRITORY: SeasonParamsV2 = no_dormant_release(S1_DEVNET_WIDE_CONTINUOUS);

/// The keep hold of a [`pacing_fast`] world (Q-PT-4 e: 72 → 36 bells, every
/// keep; a params byte, no program change).
pub const KEEP_BELLS_FAST: u16 = 36;
/// The reveal window of a [`pacing_fast`] world (Q-PT-4 b: 600 → 300 s).
pub const REVEAL_WINDOW_FAST: u32 = REVEAL_WINDOW_FAST_MIN;
/// The Depart stamina of a [`pacing_fast`] world: today's 74, as a parameter
/// (Q-PT-4 d; the number is r0ze's open Q-PKM-3).
pub const DEPART_STAMINA_FAST: u8 = crate::v2::pacing::DEPART_STAMINA_LEGACY as u8;
/// The starter host of a [`pacing_fast`] world, whole troops (Q-PT-4 a; the
/// size is open, Q-W4P-1: 500 = what the march-first guide trains and forms).
pub const STARTER_HOST_FAST: u16 = 500;

/// `p` as a NEXT-world (world 4) season with the decided pacing (owner
/// Q-PM2-2 (a), Q-PM2-3, Q-PT-4 a/b/d/e; world4-pacing-impl):
/// [`PACING_FAST_V1`] (first village at once on a settled rim province, the
/// rim ticket lottery kept as the fallback), `min_lead` 1, `reveal_window`
/// 300 s, `keep_bells` 36, `depart_stamina` 74 (a parameter at today's
/// value), `starter_host` 500. Every other byte unchanged.
pub const fn pacing_fast(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.cq.pacing = PACING_FAST_V1;
    q.base.min_lead = 1;
    q.base.reveal_window = REVEAL_WINDOW_FAST;
    q.cq.keep_bells = KEEP_BELLS_FAST;
    q.cq.depart_stamina = DEPART_STAMINA_FAST;
    q.cq.starter_host = STARTER_HOST_FAST;
    q
}

/// **The next devnet world** (world 4, beside world 3; Q-PT-5 (a) — its
/// creation needs r0ze's separate FINAL OK): [`S1_DEVNET_TERRITORY`] through
/// [`pacing_fast`]. Not announced, not created.
pub const S1_DEVNET_TERRITORY_FAST: SeasonParamsV2 = pacing_fast(S1_DEVNET_TERRITORY);

/// `outpost_tier_min` of [`S1_DEVNET_WIDE_7D`]: Hamlet (`holding::Tier::Hamlet
/// as u8`), so a fresh rim first village anchors a wide claim (owner Q-W1, the
/// local wide world's rule). Every other preset keeps Town (1).
pub const OUTPOST_TIER_DEVNET_WIDE: u8 = 0;

/// [`S1_DEVNET_WIDE_7D`]'s four changes over any S1 season.
pub const fn devnet_wide(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.cq.r_max_ceiling = permutation_rules::frontier::geometry::R_MAX_HARD;
    q.base.theta_early_bps = THETA_DEVNET_WIDE_BPS;
    q.base.theta_late_bps = THETA_DEVNET_WIDE_BPS;
    q.base.pfund_initial = PFUND_DEVNET_WIDE;
    q.cq.outpost_tier_min = OUTPOST_TIER_DEVNET_WIDE;
    q
}

/// Every S1 preset with its name (vectors).
pub const PRESETS_S1: [(&str, SeasonParamsV2); 8] = [
    ("S1_LOCAL_7D", S1_LOCAL_7D),
    ("S1_LOCAL_14D", S1_LOCAL_14D),
    ("S1_TEST", S1_TEST),
    ("S1_LOCAL_CONTINUOUS", S1_LOCAL_CONTINUOUS),
    ("S1_DEVNET_WIDE_7D", S1_DEVNET_WIDE_7D),
    ("S1_DEVNET_WIDE_CONTINUOUS", S1_DEVNET_WIDE_CONTINUOUS),
    ("S1_DEVNET_TERRITORY", S1_DEVNET_TERRITORY),
    ("S1_DEVNET_TERRITORY_FAST", S1_DEVNET_TERRITORY_FAST),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// v1.1 (R-16): the v2 pin, beside M1's (`presets::tests::
    /// ruleset_hash_is_the_kernels` keeps M1's `72c6b583…4bd9`).
    #[test]
    fn ruleset_hash_v2_is_the_kernels() {
        assert_eq!(
            RULESET_HASH_V2,
            crate::v2::kernel::ruleset_hash_v2(),
            "the v2 kernels changed: update RULESET_HASH_V2 and regenerate the vectors"
        );
        assert_ne!(RULESET_HASH_V2, crate::presets::RULESET_HASH);
        assert_eq!(
            crate::presets::RULESET_HASH[..4],
            [0x72, 0xc6, 0xb5, 0x83],
            "M1's RULESET_HASH is unchanged"
        );
    }

    #[test]
    fn ruleset_hash_v4_is_the_kernels() {
        assert_eq!(
            RULESET_HASH_V4,
            permutation_rules::frontier::ruleset_hash_v4(),
            "the custody kernels changed: update RULESET_HASH_V4"
        );
        assert_ne!(RULESET_HASH_V4, RULESET_HASH_V3);
        assert_eq!(RULES_VERSION_CUSTODY, 13);
    }

    #[test]
    fn ruleset_hash_v3_is_the_kernels() {
        assert_eq!(
            RULESET_HASH_V3,
            permutation_rules::frontier::ruleset_hash_v3(),
            "the S1 kernels changed: update RULESET_HASH_V3 and regenerate the vectors"
        );
        assert_ne!(RULESET_HASH_V3, RULESET_HASH_V2);
        assert_eq!(RULES_VERSION_S1, 12);
        for (name, p) in PRESETS_S1 {
            assert_eq!(p.base.program_version, PROGRAM_VERSION_S1, "{name}");
            assert_eq!(p.validate(), Ok(()), "{name}");
            if name == "S1_LOCAL_CONTINUOUS" {
                assert_eq!(continuous(S1_LOCAL_7D), p);
                continue;
            }
            if name == "S1_DEVNET_WIDE_7D" {
                assert_eq!(devnet_wide(S1_LOCAL_7D), p);
                continue;
            }
            if name == "S1_DEVNET_WIDE_CONTINUOUS" {
                assert_eq!(continuous(devnet_wide(S1_LOCAL_7D)), p);
                continue;
            }
            if name == "S1_DEVNET_TERRITORY" {
                assert_eq!(no_dormant_release(continuous(devnet_wide(S1_LOCAL_7D))), p);
                continue;
            }
            if name == "S1_DEVNET_TERRITORY_FAST" {
                assert_eq!(pacing_fast(S1_DEVNET_TERRITORY), p);
                continue;
            }
            let mc = PRESETS
                .iter()
                .find(|(n, _)| n[3..] == name[3..])
                .map(|(_, q)| *q)
                .unwrap();
            if name == "S1_TEST" {
                assert_eq!(s1(mc), p);
            } else {
                assert_eq!(centreless(s1(mc)), p, "{name}");
            }
        }
    }

    /// ⑭ R1: the playable/devnet presets start centre-free; the MC presets
    /// and `S1_TEST` keep the wedge; only `placement` differs from the MC
    /// preset of the same name.
    #[test]
    fn playable_presets_are_centreless_r1() {
        for p in [S1_LOCAL_7D, S1_LOCAL_14D, S1_LOCAL_CONTINUOUS] {
            assert_eq!(p.cq.placement, PLACEMENT_PLAYABLE);
            assert_ne!(p.cq.placement, PLACEMENT_WEDGE);
            assert_eq!(p.validate(), Ok(()));
        }
        assert_eq!(S1_TEST.cq.placement, PLACEMENT_WEDGE);
        for (_, p) in PRESETS {
            assert_eq!(p.cq.placement, PLACEMENT_WEDGE);
        }
        for p in [S1_LOCAL_7D, S1_LOCAL_14D, S1_LOCAL_CONTINUOUS] {
            assert_eq!(p.cq.centre, CENTRE_PLAYABLE);
        }
        assert_eq!(S1_TEST.cq.centre, CENTRE_CONCORD);
        let mut back = S1_LOCAL_7D;
        back.cq.placement = PLACEMENT_WEDGE;
        back.cq.centre = CENTRE_CONCORD;
        back.cq.spawn_reach = SPAWN_RING;
        assert_eq!(back, s1(MC_LOCAL_7D), "nothing else changed");
        // ⑭ R2: centre 1 needs placement 2 and S1; 2 is refused; it round-trips
        let mut free = S1_LOCAL_7D;
        free.cq.centre = CENTRE_FREE;
        assert_eq!(free.validate(), Ok(()));
        let raw = free.to_bytes();
        assert_eq!(raw[SEASON_PARAMS_LEN + cq_layout::CENTRE], 1);
        assert_eq!(SeasonParamsV2::from_bytes(&raw), Some(free));
        let mut bad = free.cq.to_bytes();
        bad[cq_layout::CENTRE] = 2;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        let mut p = free;
        p.cq.placement = PLACEMENT_DISPERSED;
        assert_eq!(p.validate(), Err("centre"));
        let mut p = MC_LOCAL_7D;
        p.cq.centre = CENTRE_FREE;
        p.cq.placement = PLACEMENT_MIXED;
        assert!(p.validate().is_err());
    }

    /// ⑭ R3: the playable presets spawn by the settled land (byte 82), every
    /// MC preset and `S1_TEST` keep the ring rule; the byte needs placement 2
    /// and S1, is capped at `SPAWN_REACH_MAX`, and round-trips.
    #[test]
    fn playable_presets_spawn_by_the_settled_land_r3() {
        for p in [S1_LOCAL_7D, S1_LOCAL_14D, S1_LOCAL_CONTINUOUS] {
            assert_eq!(p.cq.spawn_reach, SPAWN_PLAYABLE);
            assert_eq!(p.to_bytes()[SEASON_PARAMS_LEN + cq_layout::SPAWN_REACH], 2);
        }
        assert_eq!(S1_TEST.cq.spawn_reach, SPAWN_RING);
        for (_, p) in PRESETS {
            assert_eq!(p.cq.spawn_reach, SPAWN_RING);
        }
        let mut p = S1_LOCAL_7D;
        p.cq.spawn_reach = SPAWN_REACH_MAX;
        assert_eq!(p.validate(), Ok(()));
        assert_eq!(SeasonParamsV2::from_bytes(&p.to_bytes()), Some(p));
        let mut bad = p.cq.to_bytes();
        bad[cq_layout::SPAWN_REACH] = SPAWN_REACH_MAX + 1;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        p.cq.spawn_reach = SPAWN_REACH_MAX + 1;
        assert_eq!(p.validate(), Err("spawn"));
        p.cq.spawn_reach = 1;
        p.cq.placement = PLACEMENT_DISPERSED;
        assert_eq!(p.validate(), Err("spawn"));
        let mut mc = MC_LOCAL_7D;
        mc.cq.spawn_reach = 1;
        assert!(mc.validate().is_err());
        // world4-pacing-impl: 83..87 are the pacing bytes, reserved from 87
        assert_eq!(cq_layout::PACING, 83);
        assert_eq!(cq_layout::RSV, 87);
    }

    /// ⑭ R3's rule table: the ring rule is today's PlaceHome exactly; the
    /// hull rule adds the settled province and the witness within reach.
    #[test]
    fn spawn_allows_ring_and_hull_rules() {
        // ring rule: 2..=heartland, no witness
        for ring in 0..8 {
            assert_eq!(spawn_allows(0, 3, ring, 0, None), (2..=3).contains(&ring));
            assert_eq!(spawn_allows(0, 3, ring, 5, None), (2..=3).contains(&ring));
        }
        assert!(!spawn_allows(0, 3, 2, 0, Some((1, 1))));
        // hull rule
        assert!(!spawn_allows(2, 3, 1, 9, Some((0, 9))), "rings 0-1 never");
        assert!(spawn_allows(2, 3, 3, 0, None), "the heartland seeds it");
        assert!(!spawn_allows(2, 3, 4, 0, None));
        assert!(spawn_allows(2, 3, 9, 1, None), "a settled province");
        assert!(spawn_allows(2, 3, 9, 0, Some((2, 1))));
        assert!(!spawn_allows(2, 3, 9, 0, Some((3, 1))), "beyond reach");
        assert!(!spawn_allows(2, 3, 9, 0, Some((1, 0))), "an empty witness");
        assert!(spawn_allows(8, 3, 100, 0, Some((8, 1))));
    }

    /// ⑧ P1: the local continuous preset is `S1_LOCAL_7D` with exactly the
    /// three continuous fields changed, it round-trips, and its params hash
    /// differs from the finite world's.
    /// B7 / D-1: the devnet playable preset is `S1_LOCAL_7D` with only the
    /// ceiling, θ and the province fund changed; its map can grow to the
    /// legacy rim (so wide ring 129 can be requested), inside the season,
    /// and every fund covers the rim's and ring 129's checks at both rent
    /// rates with headroom. The localnet presets are unchanged.
    #[test]
    fn s1_devnet_wide_7d_reaches_the_wide_land() {
        use permutation_rules::frontier::geometry::R_MAX_HARD;
        // `world_index` is feature-gated; its two numbers, pinned below.
        const FIRST_WIDE_RING: u64 = R_MAX_HARD as u64 + 1;
        const WIDE_PROVINCE_SIZE: u64 = 4_864;
        #[cfg(feature = "world-index-experimental")]
        {
            assert_eq!(FIRST_WIDE_RING, crate::world_index::land::FIRST_WIDE_RING);
            assert_eq!(
                WIDE_PROVINCE_SIZE,
                crate::world_index::land::province::SIZE as u64
            );
        }
        let (l, d) = (S1_LOCAL_7D, S1_DEVNET_WIDE_7D);
        assert_eq!(d.validate(), Ok(()));
        assert_eq!(SeasonParamsV2::from_bytes(&d.to_bytes()), Some(d));
        // D-1: the localnet/devnet-profile preset cannot reach ring 128.
        assert_eq!((l.base.r_max, l.cq.r_max_ceiling), (16, 0));
        assert_eq!(d.cq.r_max_ceiling, R_MAX_HARD);
        assert_eq!(FIRST_WIDE_RING, d.cq.r_max_ceiling as u64 + 1);
        // exactly the four changes (Q-W1: a rim Hamlet anchors a wide claim)
        assert_eq!((l.cq.outpost_tier_min, d.cq.outpost_tier_min), (1, 0));
        assert_eq!(
            d.to_bytes()[SEASON_PARAMS_LEN + cq_layout::OUTPOST_TIER_MIN],
            0
        );
        let mut back = d;
        back.cq.outpost_tier_min = l.cq.outpost_tier_min;
        back.cq.r_max_ceiling = l.cq.r_max_ceiling;
        back.base.theta_early_bps = l.base.theta_early_bps;
        back.base.theta_late_bps = l.base.theta_late_bps;
        back.base.pfund_initial = l.base.pfund_initial;
        assert_eq!(back, l);
        assert_eq!(
            (l.base.theta_early_bps, l.base.theta_late_bps),
            (5_500, 6_500)
        );
        assert_eq!(l.base.pfund_initial, 21_000_000_000);
        // one opening per bell from the genesis ring to the rim, then 129
        let openings = (R_MAX_HARD - d.base.genesis_ring as u16) as u32 + 1;
        assert_eq!(openings, 126);
        assert!(
            openings * 4 < d.base.join_close_bell,
            "reached in the first quarter of the joins"
        );
        // the fund checks (balance, not spend) at 5,080 and 6,960 lamports/byte
        let share = d.base.pfund_initial / 6;
        for (rate, headroom_min) in [(5_080u64, 2_700_000_000u64), (6_960, 1_500_000_000)] {
            let rent = |len: u64| (128 + len) * rate;
            let fund_rent = rent(crate::layout::world::province_fund::SIZE as u64);
            let rim = R_MAX_HARD as u64 * rent(4_736);
            let wide = FIRST_WIDE_RING * rent(WIDE_PROVINCE_SIZE);
            assert!(wide > rim);
            assert!(share - fund_rent >= wide + headroom_min, "rate {rate}");
        }
        // θ = 1 bp: one settler in a wedge of < 10,000 open sites is enough
        // (OpenRing's `ring_occupancy_met`: open > 0 and occ × 10,000 ≥ θ × open)
        let met =
            |occ: u64, open: u64| open > 0 && occ * 10_000 >= THETA_DEVNET_WIDE_BPS as u64 * open;
        assert!(met(1, 9_999));
        assert!(!met(0, 1) && !met(0, 0));
    }

    #[test]
    fn s1_local_continuous_is_s1_local_7d_with_no_end() {
        let (f, c) = (S1_LOCAL_7D, S1_LOCAL_CONTINUOUS);
        assert_eq!(c.cq.continuous, 1);
        assert_eq!(f.cq.continuous, 0);
        assert_eq!(c.base.end_bell, crate::presets::NO_END_BELL);
        assert_eq!(c.base.join_close_bell, crate::presets::NO_END_BELL);
        assert_eq!(c.validate(), Ok(()));
        let mut back = c;
        back.cq.continuous = 0;
        back.base.end_bell = f.base.end_bell;
        back.base.join_close_bell = f.base.join_close_bell;
        assert_eq!(back, f, "nothing else changed");
        let raw = c.to_bytes();
        assert_eq!(SeasonParamsV2::from_bytes(&raw), Some(c));
        assert_eq!(raw[SEASON_PARAMS_LEN + cq_layout::CONTINUOUS], 1);
        let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
        assert_ne!(
            params_hash_v2(&raw, &payout),
            params_hash_v2(&f.to_bytes(), &payout)
        );
    }

    /// devnet-continuous-1: the devnet continuous world is the devnet wide
    /// preset with exactly the three continuous fields changed (same map
    /// growth, θ, funds and Hamlet outposts), it round-trips, and it commits
    /// to another params hash than the announced 7-day season 1.
    #[test]
    fn s1_devnet_wide_continuous_is_the_wide_preset_with_no_end() {
        let (f, c) = (S1_DEVNET_WIDE_7D, S1_DEVNET_WIDE_CONTINUOUS);
        assert_eq!(c.cq.continuous, 1);
        assert_eq!(c.base.end_bell, crate::presets::NO_END_BELL);
        assert_eq!(c.base.join_close_bell, crate::presets::NO_END_BELL);
        assert_eq!(c.validate(), Ok(()));
        let mut back = c;
        back.cq.continuous = 0;
        back.base.end_bell = f.base.end_bell;
        back.base.join_close_bell = f.base.join_close_bell;
        assert_eq!(back, f, "nothing else changed");
        assert_eq!(c.cq.r_max_ceiling, f.cq.r_max_ceiling);
        assert_eq!(c.base.pfund_initial, PFUND_DEVNET_WIDE);
        let raw = c.to_bytes();
        assert_eq!(SeasonParamsV2::from_bytes(&raw), Some(c));
        assert_eq!(raw[SEASON_PARAMS_LEN + cq_layout::CONTINUOUS], 1);
        let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
        assert_ne!(
            params_hash_v2(&raw, &payout),
            params_hash_v2(&f.to_bytes(), &payout)
        );
    }

    #[test]
    fn reveal_profile_matches_v2_budgets() {
        for (_, p) in PRESETS.iter().chain(PRESETS_S1.iter()) {
            assert_eq!(
                p.base.reveal_cu_limit,
                crate::v2::budgets::cu_limit_for(p.base.program_version, crate::v2::Ix::Reveal)
            );
            assert_eq!(
                p.base.reveal_loaded_limit,
                crate::v2::budgets::loaded_limit_for(p.base.program_version, crate::v2::Ix::Reveal)
            );
        }
    }

    #[test]
    fn standard_season_dormancy_matches_the_economic_kernel() {
        let p = MC_LOCAL_14D;
        assert_eq!(
            i64::from(p.base.dormant_after_secs),
            permutation_rules::frontier::holding::DORMANT_AFTER
        );
        assert_eq!(p.cq.dormant_after_secs, p.base.dormant_after_secs);
        assert_eq!(p.base.release_after_secs, 14 * 86_400);
        assert_eq!(p.cq.release_after_secs, p.base.release_after_secs);
        assert_eq!(p.base.end_bell, 2_016);
        assert_eq!(p.base.bell_secs, 600);
    }

    #[test]
    fn presets_validate_and_round_trip() {
        for (name, p) in PRESETS {
            assert_eq!(p.validate(), Ok(()), "{name}");
            assert_eq!(SeasonParamsV2::from_bytes(&p.to_bytes()), Some(p), "{name}");
            assert_eq!(p.base.program_version, PROGRAM_VERSION_V2);
        }
        // provinces within ring 16 are funded at the v2 rent
        let need = permutation_rules::frontier::geometry::provinces_within(16) as u64
            * crate::v2::layout::AccountKind::Province.rent();
        assert!(MC_LOCAL_7D.base.pfund_initial >= need);
        assert_eq!(MC_SEASON_28.base.end_bell, 4_032);
        assert_eq!(MC_TEST.cq.keep_bells, 24);
        // R-14: no home released within a 7-day season.
        assert_eq!(
            MC_LOCAL_7D.cq.release_after_secs as u64,
            MC_LOCAL_7D.base.end_bell as u64 * 600
        );
    }

    #[test]
    fn validation_refuses_each_range() {
        let base = MC_LOCAL_7D;
        let bad = |f: fn(&mut SeasonParamsV2)| {
            let mut p = base;
            f(&mut p);
            p.validate()
        };
        assert_eq!(bad(|p| p.base.program_version = 1), Err("program_version"));
        assert_eq!(bad(|p| p.cq.relations = 1), Err("relations"));
        assert_eq!(bad(|p| p.cq.flags = 1), Err("flags"));
        assert_eq!(bad(|p| p.cq.placement = 3), Err("placement"));
        // ⑧ (a): placement 2 is S1's (RULESET_HASH_V2 does not commit to it)
        assert_eq!(bad(|p| p.cq.placement = PLACEMENT_MIXED), Err("placement"));
        assert_eq!(bad(|p| p.cq.placement = PLACEMENT_DISPERSED), Ok(()));
        let mut s = s1(base);
        s.cq.placement = PLACEMENT_MIXED;
        assert_eq!(s.validate(), Ok(()));
        // Map growth: 0 (no extension), or above r_max (16) and ≤ 128.
        assert_eq!(bad(|p| p.cq.r_max_ceiling = 16), Err("r_max_ceiling"));
        assert_eq!(bad(|p| p.cq.r_max_ceiling = 129), Err("r_max_ceiling"));
        assert_eq!(bad(|p| p.cq.r_max_ceiling = 17), Ok(()));
        assert_eq!(bad(|p| p.cq.r_max_ceiling = 128), Ok(()));
        {
            // The ceiling round-trips at bytes 78..80; existing presets keep 0.
            let mut p = base;
            p.cq.r_max_ceiling = 24;
            let b = p.cq.to_bytes();
            assert_eq!(
                &b[cq_layout::R_MAX_CEILING..cq_layout::R_MAX_CEILING + 2],
                &24u16.to_le_bytes()
            );
            assert_eq!(ConquestParams::from_bytes(&b), Some(p.cq));
            assert_eq!(
                base.cq.to_bytes()[cq_layout::PLACEMENT..cq_layout::CONTINUOUS],
                [0u8; 3]
            );
        }
        assert_eq!(
            bad(|p| p.cq.heartland_max_ring = 1),
            Err("heartland_max_ring")
        );
        assert_eq!(
            bad(|p| p.cq.free_city_min_ring = 3),
            Err("free_city_min_ring")
        );
        assert_eq!(bad(|p| p.cq.keep_bells = 0), Err("keep_bells"));
        assert_eq!(bad(|p| p.cq.keep_bells = 256), Err("keep_bells"));
        assert_eq!(
            bad(|p| p.cq.keep_consolidate_bells = 4_321),
            Err("keep_consolidate_bells")
        );
        assert_eq!(
            bad(|p| p.cq.keep_home_guard = 30_001),
            Err("keep_home_guard")
        );
        assert_eq!(
            bad(|p| p.cq.free_city_garrison = 30_001),
            Err("free_city_garrison")
        );
        assert_eq!(bad(|p| p.cq.sieges_per_day = 9), Err("sieges_per_day"));
        assert_eq!(
            bad(|p| p.cq.keep_garrison_bps = 10_001),
            Err("keep_garrison_bps")
        );
        assert_eq!(
            bad(|p| p.cq.shield_late_after_secs = 604_801),
            Err("shield_late_after_secs")
        );
        assert_eq!(
            bad(|p| p.cq.dormant_after_secs = 1),
            Err("dormancy timers differ")
        );
        assert_eq!(bad(|p| p.cq.conquest_version = 2), Err("conquest_version"));
        assert_eq!(
            bad(|p| p.cq.continuous = 1),
            Err("join_close_bell/end_bell")
        );
        assert_eq!(bad(|p| p.cq.continuous = 2), Err("continuous"));
        let mut existing = base.cq.to_bytes();
        existing[cq_layout::CONTINUOUS] = 1;
        assert_eq!(ConquestParams::from_bytes(&existing).unwrap().continuous, 1);
        existing[cq_layout::RSV] = 1;
        assert_eq!(ConquestParams::from_bytes(&existing), None);
        existing[cq_layout::RSV] = 0;
        existing[cq_layout::CONTINUOUS] = 2;
        assert_eq!(ConquestParams::from_bytes(&existing), None);
        let mut d = base.to_bytes();
        d[SEASON_PARAMS_LEN + cq_layout::RSV] = 1;
        assert_eq!(SeasonParamsV2::from_bytes(&d), None);
        assert_eq!(MAX_GUARD_TROOPS, 30_000);
    }

    #[test]
    fn continuous_creation_keeps_join_open_and_default_map_fixed() {
        let finite = MC_LOCAL_7D;
        let finite_bytes = finite.to_bytes();
        let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
        assert_eq!(
            params_hash_v2(&finite_bytes, &payout),
            [
                0xfc, 0xa9, 0x50, 0xc6, 0x19, 0xbf, 0x18, 0x45, 0x93, 0x0d, 0x4e, 0x3d, 0x3f, 0x19,
                0x78, 0xb8, 0xe2, 0x2c, 0x3d, 0xe6, 0xc0, 0x0c, 0x89, 0x96, 0x83, 0x49, 0xfe, 0x74,
                0xe5, 0x0c, 0x73, 0x9b,
            ]
        );

        let mut continuous = finite;
        continuous.cq.continuous = 1;
        continuous.base.end_bell = crate::presets::NO_END_BELL;
        continuous.base.join_close_bell = crate::presets::NO_END_BELL;
        assert_eq!(continuous.validate(), Ok(()));
        let raw = continuous.to_bytes();
        assert_eq!(
            raw[SEASON_PARAMS_LEN + cq_layout::PLACEMENT
                ..SEASON_PARAMS_LEN + cq_layout::CONTINUOUS],
            [0; 3]
        );
        assert_eq!(SeasonParamsV2::from_bytes(&raw), Some(continuous));
        assert_ne!(
            params_hash_v2(&raw, &payout),
            params_hash_v2(&finite_bytes, &payout)
        );
        continuous.base.join_close_bell = 0;
        assert_eq!(continuous.validate(), Err("join_close_bell/end_bell"));
        continuous.base.join_close_bell = 756;
        assert_eq!(continuous.validate(), Err("join_close_bell/end_bell"));
        continuous.base.join_close_bell = crate::presets::NO_END_BELL;
        continuous.base.end_bell = finite.base.end_bell;
        assert_eq!(continuous.validate(), Err("join_close_bell/end_bell"));
        assert_eq!(finite.to_bytes(), finite_bytes);
    }

    #[test]
    fn continuous_dispersed_extension_fields_coexist_without_repacking() {
        let mut p = S1_LOCAL_7D;
        p.base.end_bell = crate::presets::NO_END_BELL;
        p.base.join_close_bell = crate::presets::NO_END_BELL;
        p.cq.placement = PLACEMENT_DISPERSED;
        p.cq.spawn_reach = SPAWN_RING; // (⑭ R3 needs placement 2)
        p.cq.r_max_ceiling = 128;
        p.cq.continuous = 1;
        assert_eq!(p.validate(), Ok(()));
        let raw = p.cq.to_bytes();
        assert_eq!(&raw[77..81], &[1, 128, 0, 1]);
        assert!(raw[81..].iter().all(|b| *b == 0));
        assert_eq!(ConquestParams::from_bytes(&raw), Some(p.cq));
        assert_eq!(SeasonParamsV2::from_bytes(&p.to_bytes()), Some(p));
        let mut bad = raw;
        bad[80] = 2;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        bad = raw;
        bad[77] = 3; // (2 is PLACEMENT_MIXED since ⑧ wide land (i))
        assert!(ConquestParams::from_bytes(&bad).is_none());
        // byte 81 is `centre` since ⑭ R2 (1 decodes, 2 is refused); 82 is
        // `spawn_reach` since ⑭ R3 (≤ 8 decodes, 9 is refused); 83 is `pacing`
        // since world4-pacing-impl (1 decodes, 2 is refused), 84..87 its bytes;
        // 87 stays reserved
        bad = raw;
        bad[81] = 2;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        bad = raw;
        bad[82] = 9;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        bad = raw;
        bad[83] = 2;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        bad = raw;
        bad[87] = 1;
        assert!(ConquestParams::from_bytes(&bad).is_none());
    }

    /// ⑧ wide land (i): placement 2 round-trips, byte 3 is refused, and the
    /// value is committed by the params hash (a season of placement 2 is
    /// never the same Season as one of placement 1).
    #[test]
    fn placement_mixed_round_trips_and_is_hashed() {
        assert_eq!(PLACEMENT_MIXED, 2);
        let mut p = S1_LOCAL_7D;
        p.cq.placement = PLACEMENT_MIXED;
        assert_eq!(p.validate(), Ok(()));
        let raw = p.to_bytes();
        assert_eq!(raw[SEASON_PARAMS_LEN + cq_layout::PLACEMENT], 2);
        assert_eq!(SeasonParamsV2::from_bytes(&raw), Some(p));
        let mut bad = p.cq.to_bytes();
        bad[cq_layout::PLACEMENT] = 3;
        assert!(ConquestParams::from_bytes(&bad).is_none());
        let mut d = p;
        d.cq.placement = PLACEMENT_DISPERSED;
        let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
        assert_ne!(
            params_hash_v2(&raw, &payout),
            params_hash_v2(&d.to_bytes(), &payout)
        );
    }

    #[test]
    fn params_hash_v2_commits_to_both_parts() {
        let a = params_hash_v2(&MC_LOCAL_7D.to_bytes(), &[1]);
        let b = params_hash_v2(&MC_TEST.to_bytes(), &[1]);
        assert_ne!(a, b);
        assert_ne!(
            a,
            crate::presets::params_hash(&MC_LOCAL_7D.base.to_bytes(), &[1])
        );
    }

    /// U3 (owner 2026-11-24 12:07): the new devnet world has no idle
    /// first-village release; it validates only as a continuous world.
    #[test]
    fn the_territory_world_never_releases_a_dormant_home() {
        let p = S1_DEVNET_TERRITORY;
        assert_eq!(p.base.release_after_secs, RELEASE_DORMANT_NEVER);
        assert_eq!(p.cq.release_after_secs, RELEASE_DORMANT_NEVER);
        assert_eq!(
            p.cq.dormant_after_secs,
            S1_DEVNET_WIDE_CONTINUOUS.cq.dormant_after_secs
        );
        assert_eq!(p.validate(), Ok(()));
        let mut finite = no_dormant_release(S1_DEVNET_WIDE_7D);
        assert_eq!(finite.validate(), Err("release_after_secs"));
        finite.cq.release_after_secs = S1_DEVNET_WIDE_7D.cq.release_after_secs;
        assert!(finite.validate().is_err());
    }

    /// world4-pacing-impl: world 3's preset is byte for byte what it was
    /// (the vectors' REV3-payout hash 38fe3208…, as on main before the
    /// pacing bytes; the operator's own world-3 hash 50edfaaa… — beacon key and
    /// program version applied — is checked by `frontier-operator --offline`),
    /// and the next world's preset differs from it in exactly the six decided
    /// bytes.
    #[test]
    fn world_3_params_hash_is_unchanged_and_world_4_differs_only_in_pacing() {
        let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
        let h3 = params_hash_v2(&S1_DEVNET_TERRITORY.to_bytes(), &payout);
        assert_eq!(
            &h3[..4],
            &[0x38, 0xfe, 0x32, 0x08],
            "world 3's preset bytes must not change"
        );
        let cq3 = S1_DEVNET_TERRITORY.cq.to_bytes();
        assert!(cq3[cq_layout::PACING..].iter().all(|b| *b == 0), "world 3 has zero pacing bytes");
        let f = S1_DEVNET_TERRITORY_FAST;
        assert_eq!(f.validate(), Ok(()));
        let mut back = f;
        back.cq.pacing = 0;
        back.cq.depart_stamina = 0;
        back.cq.starter_host = 0;
        back.cq.keep_bells = S1_DEVNET_TERRITORY.cq.keep_bells;
        back.base.min_lead = 2;
        back.base.reveal_window = 600;
        assert_eq!(back, S1_DEVNET_TERRITORY);
        assert_ne!(params_hash_v2(&f.to_bytes(), &payout), h3);
        assert_eq!(SeasonParamsV2::from_bytes(&f.to_bytes()), Some(f));
    }

    /// The new-world bytes are refused without `pacing` 1, and the base
    /// ranges move only with it (deliberate-break cases).
    #[test]
    fn pacing_bytes_need_the_fast_mode() {
        let w3 = S1_DEVNET_TERRITORY;
        for (what, f) in [
            ("min_lead", (|p: &mut SeasonParamsV2| p.base.min_lead = 1) as fn(&mut SeasonParamsV2)),
            ("reveal_window", |p| p.base.reveal_window = 300),
            ("depart_stamina", |p| p.cq.depart_stamina = 37),
            ("starter_host", |p| p.cq.starter_host = 500),
        ] {
            let mut p = w3;
            f(&mut p);
            assert_eq!(p.validate(), Err(what), "{what} without pacing");
            p.cq.pacing = PACING_FAST_V1;
            assert_eq!(p.validate(), Ok(()), "{what} with pacing");
        }
        let mut p = S1_DEVNET_TERRITORY_FAST;
        p.base.reveal_window = 299;
        assert_eq!(p.validate(), Err("reveal_window"));
        p = S1_DEVNET_TERRITORY_FAST;
        p.base.min_lead = 0;
        assert_eq!(p.validate(), Err("min_lead"));
        p = S1_DEVNET_TERRITORY_FAST;
        p.cq.depart_stamina = 121;
        assert_eq!(p.validate(), Err("depart_stamina"));
        p = S1_DEVNET_TERRITORY_FAST;
        p.cq.starter_host = 99;
        assert_eq!(p.validate(), Err("starter_host"));
        p.cq.starter_host = 30_001;
        assert_eq!(p.validate(), Err("starter_host"));
        let mut mc = MC_LOCAL_7D;
        mc.cq.pacing = PACING_FAST_V1;
        assert_eq!(mc.validate(), Err("pacing"));
        // legacy windows still refuse 599 without pacing
        let mut q = w3;
        q.base.reveal_window = 599;
        assert_eq!(q.validate(), Err("reveal_window"));
    }
}
