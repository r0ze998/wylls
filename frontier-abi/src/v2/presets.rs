//! `SeasonParams` v2 (MC contract §5.2.5, §3.12): the 128-B conquest
//! block, its CreateSeason validation, the presets `MC_LOCAL_7D`
//! (Frontier-7), `MC_SEASON_28` (Frontier-28) and `MC_TEST` (R-18), and
//! the v2 ruleset pin.
//!
//! **Wire form.** CreateSeason v2's data is `tag ‖ SeasonParams (224 B,
//! M1's layout, `program_version = 2`) ‖ ConquestParams (128 B) ‖
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
        RSV @ 77 : "rsv" = 51;
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
pub const PROGRAM_VERSION_V2: u16 = 2;
/// `conquest_version` of the block.
pub const CONQUEST_VERSION: u8 = 1;
/// Rules version of the MC kernels (`RULES_VERSION_FRONTIER` 10 → 11, §3.13).
pub const RULES_VERSION_V2: u16 = crate::v2::kernel::RULES_VERSION_FRONTIER_V2;
/// Largest bell timer CreateSeason accepts (§5.2.5: 30 days of bells).
pub const MAX_TIMER_BELLS: u32 = 4_320;
/// `MAX_HOST_TROOPS` in whole troops (keep and Free City guards, R-01).
pub const MAX_GUARD_TROOPS: u32 =
    permutation_rules::frontier::host::MAX_HOST_TROOPS / permutation_rules::fixed::MILLI as u32;

/// `RULESET_HASH_V2` (§3.13, R-16): the hash a v2 program embeds and
/// CreateSeason v2 writes, pinned by `ruleset_hash_v2_is_the_kernels`
/// against [`crate::v2::kernel::ruleset_hash_v2`].
///
/// Pinned once by the integrator after the CQ1-A merge (CQ1-C request R1,
/// `integ-CQ1-NOTES.md`): `1607f62f…2a5a` = `permutation_rules::frontier::
/// ruleset_hash_v2()`, also pinned by CQ1-A's
/// `cq_m1_ruleset_hash_unchanged_and_v2_pinned`. M1's
/// [`crate::presets::RULESET_HASH`] (`72c6b583…4bd9`) is unchanged and
/// still pinned by `ruleset_hash_is_the_kernels`.
pub const RULESET_HASH_V2: [u8; 32] = [
    0x16, 0x07, 0xf6, 0x2f, 0xfb, 0x02, 0x01, 0xf1, 0x13, 0xc4, 0xc3, 0xd8, 0xea, 0x35, 0xff, 0xd0,
    0xc9, 0xc8, 0x8c, 0x9c, 0x8e, 0x48, 0xb3, 0x3f, 0x0d, 0xaa, 0x56, 0x70, 0x75, 0x45, 0x2a, 0x5a,
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
}

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
            & wr_u8(&mut d, L::FLAGS, self.flags);
        d
    }

    /// Decodes the 128-B block; `None` if short or a reserved byte is set.
    pub fn from_bytes(d: &[u8]) -> Option<ConquestParams> {
        use cq_layout as L;
        if d.len() < CONQUEST_PARAMS_LEN || d[L::RSV..CONQUEST_PARAMS_LEN].iter().any(|b| *b != 0) {
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
        let bells_ok = |b: u32| b <= MAX_TIMER_BELLS && b <= end_bell;
        let checks: [(bool, &'static str); 26] = [
            (p.conquest_version == CONQUEST_VERSION, "conquest_version"),
            (p.relations == 0, "relations"),
            (p.flags == 0, "flags"),
            (
                (2..=6).contains(&p.heartland_max_ring),
                "heartland_max_ring",
            ),
            (
                p.free_city_min_ring == 0
                    || (p.free_city_min_ring > p.heartland_max_ring && p.free_city_min_ring <= 64),
                "free_city_min_ring",
            ),
            ((1..=255).contains(&p.keep_bells), "keep_bells"),
            (
                bells_ok(p.keep_consolidate_bells as u32),
                "keep_consolidate_bells",
            ),
            (p.keep_garrison_bps <= 10_000, "keep_garrison_bps"),
            ((1..=8).contains(&p.sieges_per_day), "sieges_per_day"),
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

/// CreateSeason v2's parameters: M1's part (with `program_version = 2`)
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

    /// M1's ranges, `program_version = 2`, the block's ranges and the
    /// dormancy timers agreeing in both parts.
    pub fn validate(&self) -> Result<(), &'static str> {
        self.base.validate()?;
        if self.base.program_version != PROGRAM_VERSION_V2 {
            return Err("program_version");
        }
        if self.base.dormant_after_secs != self.cq.dormant_after_secs
            || self.base.release_after_secs != self.cq.release_after_secs
        {
            return Err("dormancy timers differ");
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
pub const PRESETS: [(&str, SeasonParamsV2); 3] = [
    ("MC_LOCAL_7D", MC_LOCAL_7D),
    ("MC_SEASON_28", MC_SEASON_28),
    ("MC_TEST", MC_TEST),
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
    fn presets_validate_and_round_trip() {
        for (name, p) in PRESETS {
            assert_eq!(p.validate(), Ok(()), "{name}");
            assert_eq!(SeasonParamsV2::from_bytes(&p.to_bytes()), Some(p), "{name}");
            assert_eq!(p.base.program_version, 2);
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
        let mut d = base.to_bytes();
        d[SEASON_PARAMS_LEN + cq_layout::RSV] = 1;
        assert_eq!(SeasonParamsV2::from_bytes(&d), None);
        assert_eq!(MAX_GUARD_TROOPS, 30_000);
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
}
