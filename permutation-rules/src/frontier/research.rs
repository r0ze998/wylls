//! **Research: world-first technology** (world goal ②, design record
//! `docs/design/win-conditions/01-proposal.ja.md` §4.2 / §5, plan
//! `02-research-plan.ja.md`; owner r0ze 2026-11-25 08:56 JST: every
//! Q-RS-1 … Q-RS-10 recommendation). Pure, integer only: the program, the
//! verifier, the page's mirror and the AI call the same numbers.
//!
//! | decision | here |
//! |---|---|
//! | §5.2 the twelve techs, eras, prerequisites, base costs | [`TECHS`] |
//! | Q-RS-1 (a) all four era-1 techs; "+5 %" speed = −5 % time; roads built last | [`ResearchParams::roads_travel_bps`]; the roads effect is **not wired yet** ([`ROADS_EFFECT_LIVE`] = false, open question Q-RI-1) |
//! | Q-RS-2 (a) production multipliers in (farming +10 % food) | [`food_rate`] (the holding kernel's `net_rate`) |
//! | Q-RS-3 (b) only science made after the research start counts | [`VillageResearch::REBASED`], [`rebased_science`] |
//! | Q-RS-4 (a) no headcount factor (factor 1) | [`HeadcountRule::None`] |
//! | Q-RS-5 (a) catch-up discount from the count at each pledge | [`cost`] over the live count |
//! | Q-RS-6 (a) era 1 first; eras 2–3 later | [`ResearchParams::open_eras`] = 1 in V1 (eras 2–3 learnable only under a later rule byte) |
//! | Q-RS-7 (a) costs 300 / 800 / 2,000 for the local slice | [`ResearchParams::era_cost`] |
//! | Q-RS-10 (d) points = Σ pledged ÷ 10 per citizen | [`points`] |
//!
//! A later change of any number is a new [`ResearchRule`] byte, never a
//! reinterpretation of a stored one (the territory pattern).

use super::holding::{Resource, RESOURCES};
use crate::fixed::{Bps, Milli, BPS_ONE, MILLI};

/// Kernel version (not bound by the ruleset hash: research is selected per
/// world by its record's rule byte, as territory is).
pub const RESEARCH_VERSION: u16 = 1;
/// Number of techs (12; the stored masks are 16 bits).
pub const TECH_COUNT: usize = 12;
/// Eras.
pub const ERAS: u8 = 3;
/// "No bell".
pub const NO_BELL: u32 = u32::MAX;

/// The techs (design 01 §5.2). Ids are stored; never renumber.
pub mod tech {
    pub const AGRICULTURE: u8 = 0;
    pub const MASONRY: u8 = 1;
    pub const BRONZE: u8 = 2;
    pub const ROADS: u8 = 3;
    pub const WRITING: u8 = 4;
    pub const WALLCRAFT: u8 = 5;
    pub const IRON: u8 = 6;
    pub const CARTOGRAPHY: u8 = 7;
    pub const CURRENCY: u8 = 8;
    pub const FORTIFICATION: u8 = 9;
    pub const NAVIGATION: u8 = 10;
    pub const ADMINISTRATION: u8 = 11;
}

/// One tech of the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tech {
    pub id: u8,
    /// 1–3.
    pub era: u8,
    /// Techs the nation must know first (bit mask).
    pub prereq: u16,
    /// English key (page, judge, AI).
    pub key: &'static str,
}

const fn b(t: u8) -> u16 {
    1 << t
}

/// The table of design 01 §5.2 (prerequisites as there; base cost by era).
pub const TECHS: [Tech; TECH_COUNT] = [
    Tech { id: tech::AGRICULTURE, era: 1, prereq: 0, key: "agriculture" },
    Tech { id: tech::MASONRY, era: 1, prereq: 0, key: "masonry" },
    Tech { id: tech::BRONZE, era: 1, prereq: 0, key: "bronze" },
    Tech { id: tech::ROADS, era: 1, prereq: 0, key: "roads" },
    Tech { id: tech::WRITING, era: 2, prereq: b(tech::AGRICULTURE), key: "writing" },
    Tech { id: tech::WALLCRAFT, era: 2, prereq: b(tech::MASONRY), key: "wallcraft" },
    Tech { id: tech::IRON, era: 2, prereq: b(tech::BRONZE), key: "iron" },
    Tech { id: tech::CARTOGRAPHY, era: 2, prereq: b(tech::ROADS), key: "cartography" },
    Tech { id: tech::CURRENCY, era: 3, prereq: b(tech::WRITING), key: "currency" },
    Tech {
        id: tech::FORTIFICATION,
        era: 3,
        prereq: b(tech::WALLCRAFT) | b(tech::IRON),
        key: "fortification",
    },
    Tech { id: tech::NAVIGATION, era: 3, prereq: b(tech::CARTOGRAPHY), key: "navigation" },
    Tech { id: tech::ADMINISTRATION, era: 3, prereq: b(tech::WRITING), key: "administration" },
];

/// The roads effect (travel time −5 %) is not wired into the march and
/// caravan clocks yet (Q-RS-1 (a): "roads last"; open question Q-RI-1 asks
/// whether to keep roads learnable meanwhile or switch to (b)). The page
/// says so on the card.
pub const ROADS_EFFECT_LIVE: bool = false;

/// How the cost scales with the nation's size (design 01 §5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeadcountRule {
    /// Q-RS-4 (a): factor 1 (no per-nation active count exists on chain).
    None,
}

/// One rule's numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResearchParams {
    /// Base cost per era (whole science), index era − 1.
    pub era_cost: [u32; ERAS as usize],
    /// Catch-up discount per other nation that knows the tech (bps).
    pub discount_bps_per_nation: Bps,
    /// The discount counts at most this many nations.
    pub discount_max_nations: u32,
    pub headcount: HeadcountRule,
    /// A nation that learns this many techs of the world's era advances the
    /// world to the next era.
    pub techs_to_advance: u8,
    /// Techs of eras above this are refused (`EraClosed`) whatever the
    /// world's era (Q-RS-6 (a): era 1 first).
    pub open_eras: u8,
    /// Q-RS-3 (b): a village's banked science is cut, once, to what it made
    /// since the research start.
    pub pledge_after_start_only: bool,
    /// Effects (bps): agriculture food production up, masonry build time
    /// down, bronze training ore down, roads travel time down.
    pub agriculture_food_bps: Bps,
    pub masonry_build_bps: Bps,
    pub bronze_ore_bps: Bps,
    pub roads_travel_bps: Bps,
    /// Contribution points: one per this much science pledged (Q-RS-10 (d)).
    pub science_per_point: u32,
}

/// The research rule a world plays (its `ResearchWorld` record's rule byte).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ResearchRule {
    /// The 2026-11-25 08:56 decisions (every Q-RS recommendation).
    V1 = 1,
    /// Host tests only: V1 with every era open (eras 2–3 learnable, no
    /// effects). Refused by the program's StartResearch.
    TestAllEras = 255,
}

impl ResearchRule {
    pub const fn from_byte(b: u8) -> Option<ResearchRule> {
        match b {
            1 => Some(ResearchRule::V1),
            255 => Some(ResearchRule::TestAllEras),
            _ => None,
        }
    }
    pub const fn to_byte(self) -> u8 {
        self as u8
    }
    pub const fn params(self) -> &'static ResearchParams {
        match self {
            ResearchRule::V1 => &RESEARCH_V1,
            ResearchRule::TestAllEras => &RESEARCH_TEST_ALL_ERAS,
        }
    }
}

/// V1 (owner 2026-11-25 08:56: all recommendations).
pub const RESEARCH_V1: ResearchParams = ResearchParams {
    era_cost: [300, 800, 2_000],
    discount_bps_per_nation: 2_000,
    discount_max_nations: 3,
    headcount: HeadcountRule::None,
    techs_to_advance: 3,
    open_eras: 1,
    pledge_after_start_only: true,
    agriculture_food_bps: 1_000,
    masonry_build_bps: 1_000,
    bronze_ore_bps: 1_000,
    roads_travel_bps: 500,
    science_per_point: 10,
};

const RESEARCH_TEST_ALL_ERAS: ResearchParams = ResearchParams {
    open_eras: 3,
    ..RESEARCH_V1
};

/// The tech of an id.
pub const fn tech_of(t: u8) -> Option<&'static Tech> {
    if (t as usize) < TECH_COUNT {
        Some(&TECHS[t as usize])
    } else {
        None
    }
}

/// Number of nations in a mask.
pub const fn nations_in(mask: u8) -> u32 {
    mask.count_ones()
}

/// The cost of tech `t` for a nation when `others` other nations know it:
/// `base × headcount × (1 − d × min(max, others))`, rounded up (a discount
/// never rounds a cost to below what the formula gives). `None` for an
/// unknown tech.
pub const fn cost(p: &ResearchParams, t: u8, others: u32) -> Option<u32> {
    let Some(tc) = tech_of(t) else {
        return None;
    };
    let base = p.era_cost[(tc.era - 1) as usize] as u64;
    let k = if others < p.discount_max_nations {
        others
    } else {
        p.discount_max_nations
    };
    let off = p.discount_bps_per_nation as u64 * k as u64;
    let keep = if off >= BPS_ONE as u64 {
        0
    } else {
        BPS_ONE as u64 - off
    };
    let c = (base * keep).div_ceil(BPS_ONE as u64);
    Some(c as u32)
}

/// Why a pledge (or a settle) is refused. Each maps to an existing program
/// code (`proc::wide_research`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResearchRefusal {
    /// Before the start bell, or paused.
    NotStarted,
    UnknownTech,
    /// The tech's era is above the world's era or above the rule's open eras.
    EraClosed,
    /// A prerequisite is not known by the nation.
    Prereq,
    /// The nation already knows it.
    Known,
    /// Amount 0.
    Zero,
    /// The village has less science than the amount.
    Insufficient,
    /// Settle: the total is still below the cost.
    NotDue,
    Overflow,
}

/// A nation's research state the judge needs (the record's view).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NationView {
    pub known: u16,
    pub pledged: [u32; 16],
}

/// What one accepted pledge does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PledgeOk {
    /// Taken from the village (≤ the amount asked: never past the cost).
    pub accepted: u32,
    /// The nation's total for the tech after.
    pub total: u32,
    /// The cost at this pledge.
    pub cost: u32,
    /// The nation learns the tech with this pledge.
    pub learns: bool,
}

/// Checks a tech is pledgeable for a nation (world era, open eras,
/// prerequisites, not known).
pub const fn pledgeable(
    p: &ResearchParams,
    t: u8,
    world_era: u8,
    known: u16,
) -> Result<&'static Tech, ResearchRefusal> {
    let Some(tc) = tech_of(t) else {
        return Err(ResearchRefusal::UnknownTech);
    };
    if tc.era > world_era || tc.era > p.open_eras {
        return Err(ResearchRefusal::EraClosed);
    }
    if known & tc.prereq != tc.prereq {
        return Err(ResearchRefusal::Prereq);
    }
    if known & (1 << t) != 0 {
        return Err(ResearchRefusal::Known);
    }
    Ok(tc)
}

/// Judges a pledge of `amount` (whole science; the village has `balance`).
/// The accepted part never exceeds the rest of the cost (the rest stays in
/// the village, plan §3.3 step 4); a total already at or over the cost (a
/// discount since) learns with the smallest pledge (1).
pub fn judge_pledge(
    p: &ResearchParams,
    t: u8,
    world_era: u8,
    nation: &NationView,
    others: u32,
    amount: u32,
    balance: u64,
) -> Result<PledgeOk, ResearchRefusal> {
    pledgeable(p, t, world_era, nation.known)?;
    if amount == 0 {
        return Err(ResearchRefusal::Zero);
    }
    let c = cost(p, t, others).ok_or(ResearchRefusal::UnknownTech)?;
    let had = nation.pledged[t as usize];
    let rest = c.saturating_sub(had);
    // a total already ≥ cost (a discount since): one science learns it
    let accepted = amount.min(rest.max(1));
    if (accepted as u64) > balance {
        return Err(ResearchRefusal::Insufficient);
    }
    let total = had.checked_add(accepted).ok_or(ResearchRefusal::Overflow)?;
    Ok(PledgeOk {
        accepted,
        total,
        cost: c,
        learns: total >= c,
    })
}

/// Settle (anyone): a nation whose total already reaches the (now
/// discounted) cost learns the tech without a pledge.
pub fn judge_settle(
    p: &ResearchParams,
    t: u8,
    world_era: u8,
    nation: &NationView,
    others: u32,
) -> Result<u32, ResearchRefusal> {
    pledgeable(p, t, world_era, nation.known)?;
    let c = cost(p, t, others).ok_or(ResearchRefusal::UnknownTech)?;
    if nation.pledged[t as usize] < c {
        return Err(ResearchRefusal::NotDue);
    }
    Ok(c)
}

/// The world's era after a nation that now knows `known` learned a tech of
/// era `learned_era`: one step up when the nation knows `techs_to_advance`
/// techs of the world's era (never past 3, never back).
pub const fn era_after(p: &ResearchParams, world_era: u8, known: u16) -> u8 {
    if world_era >= ERAS {
        return world_era;
    }
    let mut n = 0u8;
    let mut i = 0;
    while i < TECH_COUNT {
        if TECHS[i].era == world_era && known & (1 << i) != 0 {
            n += 1;
        }
        i += 1;
    }
    if n >= p.techs_to_advance {
        world_era + 1
    } else {
        world_era
    }
}

// ------------------------------------------------------------ the village mask

/// The two bytes a village (Holding `RSV_1258`) carries: the techs applied
/// to it (bits 0–11), the nation they belong to (bits 12–14: faction + 1;
/// 0 = none) and the Q-RS-3 (b) "banked science cut" flag (bit 15).
///
/// The techs count only while the village's faction is the stored one: a
/// captured village (its faction rewritten by the capture) plays without
/// them until the next apply (Q-RS-10 (a)) — no capture path writes these
/// bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VillageResearch(pub u16);

impl VillageResearch {
    pub const TECH_MASK: u16 = 0x0FFF;
    pub const FACTION_SHIFT: u32 = 12;
    pub const REBASED: u16 = 0x8000;

    pub const fn new(techs: u16, faction: u8, rebased: bool) -> VillageResearch {
        let f = if faction < 6 { (faction as u16 + 1) & 7 } else { 0 };
        VillageResearch(
            (techs & Self::TECH_MASK)
                | (f << Self::FACTION_SHIFT)
                | if rebased { Self::REBASED } else { 0 },
        )
    }
    pub const fn from_le(b: [u8; 2]) -> VillageResearch {
        VillageResearch(u16::from_le_bytes(b))
    }
    pub const fn to_le(self) -> [u8; 2] {
        self.0.to_le_bytes()
    }
    pub const fn techs(self) -> u16 {
        self.0 & Self::TECH_MASK
    }
    /// The stored nation (`None` when no tech was ever applied).
    pub const fn faction(self) -> Option<u8> {
        let f = (self.0 >> Self::FACTION_SHIFT) & 7;
        if f == 0 || f > 6 {
            None
        } else {
            Some(f as u8 - 1)
        }
    }
    pub const fn rebased(self) -> bool {
        self.0 & Self::REBASED != 0
    }
    /// The techs in effect for a village of `faction` now.
    pub const fn effective(self, faction: u8) -> u16 {
        match self.faction() {
            Some(f) if f == faction => self.techs(),
            _ => 0,
        }
    }
}

const fn has(techs: u16, t: u8) -> bool {
    techs & (1 << t) != 0
}

const fn scale_down(x: i64, bps: Bps) -> i64 {
    // x × (1 − bps), rounded down (a cost or a time never rounds up)
    x * (BPS_ONE - bps) as i64 / BPS_ONE as i64
}

/// Food production with agriculture (+10 %, rounded down); any other
/// resource unchanged. `prod` is the gross production (milli/h).
pub const fn food_rate(p: &ResearchParams, techs: u16, r: usize, prod: i64) -> i64 {
    if r == Resource::Food as usize && has(techs, tech::AGRICULTURE) {
        prod + prod * p.agriculture_food_bps as i64 / BPS_ONE as i64
    } else {
        prod
    }
}

/// A build item's seconds with masonry (−10 %, rounded down).
pub const fn build_secs(p: &ResearchParams, techs: u16, secs: i64) -> i64 {
    if has(techs, tech::MASONRY) {
        scale_down(secs, p.masonry_build_bps)
    } else {
        secs
    }
}

/// A training cost with bronze: the ore item −10 % (rounded down); arms and
/// every other item unchanged (D-research-slice-plan-8).
pub fn train_cost(p: &ResearchParams, techs: u16, cost: [Milli; RESOURCES]) -> [Milli; RESOURCES] {
    let mut c = cost;
    if has(techs, tech::BRONZE) {
        let o = Resource::Ore as usize;
        c[o] = scale_down(c[o], p.bronze_ore_bps);
    }
    c
}

/// Travel seconds with roads (−5 %, rounded down). Not wired yet
/// ([`ROADS_EFFECT_LIVE`]).
pub const fn travel_secs(p: &ResearchParams, techs: u16, secs: i64) -> i64 {
    if ROADS_EFFECT_LIVE && has(techs, tech::ROADS) {
        scale_down(secs, p.roads_travel_bps)
    } else {
        secs
    }
}

/// Q-RS-3 (b): the science (milli) a village may keep at its first touch
/// after the start: what it made since the start at its current net rate
/// (milli/h), never more than it holds.
pub const fn rebased_science(stock: Milli, net_rate: i64, start_ts: i64, now: i64) -> Milli {
    if now <= start_ts || net_rate <= 0 {
        return 0;
    }
    let made = (net_rate as i128 * (now - start_ts) as i128 / 3_600) as i64;
    if made < stock {
        if made < 0 {
            0
        } else {
            made
        }
    } else {
        stock
    }
}

/// Contribution points of a citizen's total pledge to one tech (Q-RS-10 (d):
/// summed per citizen, then ÷ 10, rounded down).
pub const fn points(p: &ResearchParams, total: u64) -> u64 {
    total / p.science_per_point as u64
}

/// Whole science of a milli stock.
pub const fn whole(m: Milli) -> u64 {
    if m <= 0 {
        0
    } else {
        (m / MILLI) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const P: &ResearchParams = &RESEARCH_V1;

    fn nv(known: u16) -> NationView {
        NationView {
            known,
            pledged: [0; 16],
        }
    }

    #[test]
    fn costs_and_catch_up() {
        assert_eq!(cost(P, tech::AGRICULTURE, 0), Some(300));
        assert_eq!(cost(P, tech::AGRICULTURE, 1), Some(240));
        assert_eq!(cost(P, tech::AGRICULTURE, 2), Some(180));
        assert_eq!(cost(P, tech::AGRICULTURE, 3), Some(120));
        assert_eq!(cost(P, tech::AGRICULTURE, 5), Some(120)); // max −60 %
        assert_eq!(cost(P, tech::WRITING, 0), Some(800));
        assert_eq!(cost(P, tech::CURRENCY, 3), Some(800)); // plan §5.5
        assert_eq!(cost(P, 12, 0), None);
    }

    #[test]
    fn table_matches_design_01() {
        for (i, t) in TECHS.iter().enumerate() {
            assert_eq!(t.id as usize, i);
            assert_eq!(t.era, 1 + (i / 4) as u8);
        }
        assert_eq!(TECHS[tech::FORTIFICATION as usize].prereq, 0b110_0000);
        assert_eq!(TECHS[tech::ADMINISTRATION as usize].prereq, 1 << tech::WRITING);
    }

    #[test]
    fn pledge_rules() {
        let v = nv(0);
        assert_eq!(
            judge_pledge(P, tech::WRITING, 2, &v, 0, 10, 100),
            Err(ResearchRefusal::EraClosed)
        );
        assert_eq!(
            judge_pledge(P, tech::AGRICULTURE, 1, &v, 0, 0, 100),
            Err(ResearchRefusal::Zero)
        );
        assert_eq!(
            judge_pledge(P, tech::AGRICULTURE, 1, &v, 0, 101, 100),
            Err(ResearchRefusal::Insufficient)
        );
        let ok = judge_pledge(P, tech::AGRICULTURE, 1, &v, 0, 120, 500).unwrap();
        assert_eq!((ok.accepted, ok.total, ok.cost, ok.learns), (120, 120, 300, false));
        // never past the cost: the rest stays in the village
        let mut v2 = v;
        v2.pledged[0] = 250;
        let ok = judge_pledge(P, tech::AGRICULTURE, 1, &v2, 0, 120, 500).unwrap();
        assert_eq!((ok.accepted, ok.total, ok.learns), (50, 300, true));
        // known
        assert_eq!(
            judge_pledge(P, tech::AGRICULTURE, 1, &nv(1), 0, 1, 5),
            Err(ResearchRefusal::Known)
        );
        // catch-up after pledging: total 250 ≥ cost 240 → one science learns
        let ok = judge_pledge(P, tech::AGRICULTURE, 1, &v2, 1, 120, 500).unwrap();
        assert_eq!((ok.accepted, ok.learns), (1, true));
        assert_eq!(judge_settle(P, tech::AGRICULTURE, 1, &v2, 1), Ok(240));
        assert_eq!(
            judge_settle(P, tech::AGRICULTURE, 1, &v2, 0),
            Err(ResearchRefusal::NotDue)
        );
    }

    #[test]
    fn prerequisites_and_open_eras() {
        let all = ResearchRule::TestAllEras.params();
        assert_eq!(
            judge_pledge(all, tech::WRITING, 2, &nv(0), 0, 1, 9),
            Err(ResearchRefusal::Prereq)
        );
        assert!(judge_pledge(all, tech::WRITING, 2, &nv(1), 0, 1, 9).is_ok());
        assert_eq!(
            judge_pledge(all, tech::FORTIFICATION, 3, &nv(1 << tech::WALLCRAFT), 0, 1, 9),
            Err(ResearchRefusal::Prereq)
        );
        // V1: era 2 closed even when the world reached it
        assert_eq!(
            judge_pledge(P, tech::WRITING, 2, &nv(1), 0, 1, 9),
            Err(ResearchRefusal::EraClosed)
        );
    }

    #[test]
    fn era_advances_at_three_of_the_era() {
        assert_eq!(era_after(P, 1, 0b0011), 1);
        assert_eq!(era_after(P, 1, 0b0111), 2);
        assert_eq!(era_after(P, 1, 0b1011), 2);
        assert_eq!(era_after(P, 2, 0b1111), 2); // era 2 techs count in era 2
        assert_eq!(era_after(P, 2, 0b0111_0000), 3);
        assert_eq!(era_after(P, 3, 0xFFF), 3);
    }

    #[test]
    fn village_mask() {
        let m = VillageResearch::new(0b0101, 2, true);
        assert_eq!(m.techs(), 0b0101);
        assert_eq!(m.faction(), Some(2));
        assert!(m.rebased());
        assert_eq!(m.effective(2), 0b0101);
        assert_eq!(m.effective(3), 0); // captured: until the next apply
        assert_eq!(VillageResearch::from_le(m.to_le()), m);
        assert_eq!(VillageResearch(0).faction(), None);
        assert_eq!(VillageResearch(0).effective(0), 0);
        assert_eq!(VillageResearch::new(0, 9, false).faction(), None);
    }

    #[test]
    fn effects() {
        let ag = 1 << tech::AGRICULTURE;
        assert_eq!(food_rate(P, ag, Resource::Food as usize, 40_000), 44_000);
        assert_eq!(food_rate(P, ag, Resource::Wood as usize, 40_000), 40_000);
        assert_eq!(food_rate(P, 0, Resource::Food as usize, 40_000), 40_000);
        assert_eq!(build_secs(P, 1 << tech::MASONRY, 5_400), 4_860);
        assert_eq!(build_secs(P, 0, 5_400), 5_400);
        let mut c = [0; RESOURCES];
        c[Resource::Ore as usize] = 20_000;
        c[Resource::Food as usize] = 100_000;
        let t = train_cost(P, 1 << tech::BRONZE, c);
        assert_eq!(t[Resource::Ore as usize], 18_000);
        assert_eq!(t[Resource::Food as usize], 100_000);
        assert_eq!(train_cost(P, 0, c), c);
        // roads not wired yet
        assert_eq!(travel_secs(P, 1 << tech::ROADS, 6_000), 6_000);
    }

    #[test]
    fn banked_science_is_cut_to_what_was_made_since_start() {
        // 5 science/h = 5,000 milli/h; 2 h since the start → 10,000
        assert_eq!(rebased_science(840_000, 5_000, 1_000, 1_000 + 7_200), 10_000);
        assert_eq!(rebased_science(3_000, 5_000, 1_000, 1_000 + 7_200), 3_000);
        assert_eq!(rebased_science(840_000, 5_000, 1_000, 500), 0);
        assert_eq!(rebased_science(840_000, 0, 1_000, 9_000), 0);
    }

    #[test]
    fn points_sum_then_divide() {
        assert_eq!(points(P, 9 + 9 + 9), 2);
        assert_eq!(points(P, 9), 0);
    }
}
