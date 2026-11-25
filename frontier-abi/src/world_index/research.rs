//! **Research records** (world goal ②, world-first technology; plan
//! `docs/design/win-conditions/02-research-plan.ja.md` §3; owner r0ze
//! 2026-11-25 08:56 JST: every Q-RS recommendation). The pure rules are
//! `permutation_rules::frontier::research`; the program
//! (`proc::wide_research`) is the only writer.
//!
//! | record | bytes | address | holds |
//! |---|---|---|---|
//! | [`ResearchWorld`] | 256 | `we ‖ hash(domain)` | the rule byte, the pause flag, the start bell/second, the world's era and the bell each era opened, per tech the first bell, the nations that learned it at that bell (a tie) and every nation that knows it |
//! | [`NationResearch`] | 384 | `wk ‖ hash(domain ‖ faction)` | one per nation: the techs it knows, per tech the science pledged, the first pledge bell and the learned bell, the totals |
//!
//! Both are created by the Season authority's StartResearch (no player pays
//! rent). No existing layout changes; the village's two spare bytes
//! (`Holding.RSV_1258`) carry [`VillageResearch`].
//!
//! **Receipts.** Every pledge, learn and era step is logged as one
//! `sol_log_data(&[RECEIPT_PREFIX, body])` ([`Receipt`]): not a PS2 record
//! (no chain head moves), so the herald and the verifier, which read only
//! PS2/PSW1 prefixes, pass it by. The contribution ledger is rebuilt from
//! these receipts (anyone can, from the chain's history).

use super::key::WorldId;
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u16, wr_u32, wr_u64, wr_u8};
pub use permutation_rules::frontier::research::{
    self as kr, NationView, ResearchRefusal, ResearchRule, VillageResearch, ERAS, NO_BELL,
    TECH_COUNT,
};
use permutation_rules::hash::sha256;

/// Version of the research record family.
pub const RESEARCH_FAMILY_VERSION: u16 = 1;
/// Seed tag of the world's research record (**provisional**).
pub const WORLD_TAG: [u8; 2] = *b"we";
/// Seed tag of a nation's research record (**provisional**).
pub const NATION_TAG: [u8; 2] = *b"wk";
pub const WORLD_SEED_DOMAIN: &[u8] = b"PSF-RESEARCH-WORLD-v1";
pub const NATION_SEED_DOMAIN: &[u8] = b"PSF-RESEARCH-NATION-v1";
/// Nations.
pub const NATIONS: u8 = 6;
/// Log prefix of a research receipt.
pub const RECEIPT_PREFIX: &[u8; 4] = b"PSR1";
/// Rent payers of the record pair are the Season authority.
const SLOTS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResearchError {
    Length { expected: usize, got: usize },
    Magic,
    Version { expected: u16, got: u16 },
    Reserved,
    Corrupt,
    Mismatch,
    Rule(ResearchRefusal),
}

// ------------------------------------------------------------ addresses

pub fn world_seed() -> Seed {
    let h = sha256(&[WORLD_SEED_DOMAIN]);
    Seed::new(WORLD_TAG, &h[..15])
}

pub fn world_address(ctx: &AddrCtx) -> [u8; 32] {
    ctx.of(&world_seed())
}

pub fn nation_seed(faction: u8) -> Seed {
    let h = sha256(&[NATION_SEED_DOMAIN, &[faction]]);
    Seed::new(NATION_TAG, &h[..15])
}

pub fn nation_address(ctx: &AddrCtx, faction: u8) -> [u8; 32] {
    ctx.of(&nation_seed(faction))
}

// ------------------------------------------------------------ the world record

/// The world's research record (256 B). **Provisional magic.**
pub mod research_world {
    crate::layout::fields!(size = 256;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RULE @ 18 : "u8" = 1;
        PAUSED @ 19 : "u8" = 1;
        WORLD @ 20 : "[u8;32]" = 32;
        START_BELL @ 52 : "u32" = 4;
        ERA @ 56 : "u8" = 1;
        RSV_57 @ 57 : "rsv" = 3;
        START_TS @ 60 : "i64" = 8;
        ERA_BELL @ 68 : "[u32;3]" = 12;
        FIRST_BELL @ 80 : "[u32;16]" = 64;
        FIRST_NATIONS @ 144 : "[u8;16]" = 16;
        KNOWN_BY @ 160 : "[u8;16]" = 16;
        RENT_PAYER @ 176 : "[u8;32]" = 32;
        LEARNED @ 208 : "u32" = 4;
        RSV @ 212 : "rsv" = 44;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWRW1";
}

/// The world's research state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResearchWorld {
    pub season_id: u64,
    pub rule: ResearchRule,
    pub paused: bool,
    pub world: WorldId,
    /// Pledges are refused before this bell (announced ahead, Q-RS-3).
    pub start_bell: u32,
    /// The chain second of the start bell (the banked-science cut, Q-RS-3 (b)).
    pub start_ts: i64,
    /// 1–3.
    pub era: u8,
    /// The bell each era opened (era 1 = the start bell; `NO_BELL` = not yet).
    pub era_bell: [u32; ERAS as usize],
    /// Per tech: the first bell any nation learned it (`NO_BELL`: nobody).
    pub first_bell: [u32; SLOTS],
    /// Per tech: the nations that learned it at the first bell (a tie).
    pub first_nations: [u8; SLOTS],
    /// Per tech: every nation that knows it.
    pub known_by: [u8; SLOTS],
    pub rent_payer: [u8; 32],
    /// Learn events, ever.
    pub learned: u32,
}

impl ResearchWorld {
    pub fn new(
        season_id: u64,
        rule: ResearchRule,
        world: WorldId,
        start_bell: u32,
        start_ts: i64,
        rent_payer: [u8; 32],
    ) -> Self {
        ResearchWorld {
            season_id,
            rule,
            paused: false,
            world,
            start_bell,
            start_ts,
            era: 1,
            era_bell: [start_bell, NO_BELL, NO_BELL],
            first_bell: [NO_BELL; SLOTS],
            first_nations: [0; SLOTS],
            known_by: [0; SLOTS],
            rent_payer,
            learned: 0,
        }
    }

    /// Other nations than `faction` that know tech `t`.
    pub fn others_knowing(&self, t: u8, faction: u8) -> u32 {
        let m = self.known_by.get(t as usize).copied().unwrap_or(0) & !(1u8 << faction);
        m.count_ones()
    }

    /// Records nation `faction` learning tech `t` at `bell`; returns
    /// whether it is (one of) the world's first, and the era step (the new
    /// era) when the nation's knowledge `known_after` advances the world.
    pub fn learn(
        &mut self,
        t: u8,
        faction: u8,
        bell: u32,
        known_after: u16,
    ) -> Result<(bool, Option<u8>), ResearchError> {
        let i = t as usize;
        if i >= TECH_COUNT || faction >= NATIONS {
            return Err(ResearchError::Corrupt);
        }
        let bit = 1u8 << faction;
        if self.known_by[i] & bit != 0 {
            return Err(ResearchError::Rule(ResearchRefusal::Known));
        }
        self.known_by[i] |= bit;
        let first = if self.first_bell[i] == NO_BELL {
            self.first_bell[i] = bell;
            self.first_nations[i] = bit;
            true
        } else if self.first_bell[i] == bell {
            // the same bell: a tie (design 01 §3.2)
            self.first_nations[i] |= bit;
            true
        } else {
            false
        };
        self.learned = self.learned.checked_add(1).ok_or(ResearchError::Corrupt)?;
        let next = kr::era_after(self.rule.params(), self.era, known_after);
        let step = if next > self.era {
            self.era = next;
            self.era_bell[(next - 1) as usize] = bell;
            Some(next)
        } else {
            None
        };
        Ok((first, step))
    }

    pub fn read(d: &[u8]) -> Result<ResearchWorld, ResearchError> {
        use research_world as L;
        if d.len() != L::SIZE {
            return Err(ResearchError::Length { expected: L::SIZE, got: d.len() });
        }
        let c = ResearchError::Corrupt;
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(c)? != L::MAGIC {
            return Err(ResearchError::Magic);
        }
        let v = rd_u16(d, L::FAMILY_VERSION).ok_or(c)?;
        if v != RESEARCH_FAMILY_VERSION {
            return Err(ResearchError::Version { expected: RESEARCH_FAMILY_VERSION, got: v });
        }
        if d[L::RSV_57..L::RSV_57 + 3].iter().any(|b| *b != 0) || d[L::RSV..L::SIZE].iter().any(|b| *b != 0) {
            return Err(ResearchError::Reserved);
        }
        let rule = ResearchRule::from_byte(rd_u8(d, L::RULE).ok_or(c)?).ok_or(c)?;
        let paused = match rd_u8(d, L::PAUSED).ok_or(c)? {
            0 => false,
            1 => true,
            _ => return Err(c),
        };
        let era = rd_u8(d, L::ERA).ok_or(c)?;
        if !(1..=ERAS).contains(&era) {
            return Err(c);
        }
        let mut era_bell = [0u32; ERAS as usize];
        for (i, e) in era_bell.iter_mut().enumerate() {
            *e = rd_u32(d, L::ERA_BELL + 4 * i).ok_or(c)?;
        }
        let mut first_bell = [0u32; SLOTS];
        for (i, e) in first_bell.iter_mut().enumerate() {
            *e = rd_u32(d, L::FIRST_BELL + 4 * i).ok_or(c)?;
        }
        let first_nations: [u8; SLOTS] = rd_arr(d, L::FIRST_NATIONS).ok_or(c)?;
        let known_by: [u8; SLOTS] = rd_arr(d, L::KNOWN_BY).ok_or(c)?;
        for i in 0..SLOTS {
            let bad_bits = first_nations[i] & !known_by[i] != 0 || known_by[i] >> NATIONS != 0;
            let past = i >= TECH_COUNT && (known_by[i] != 0 || first_bell[i] != NO_BELL);
            let first_mismatch = (first_bell[i] == NO_BELL) != (first_nations[i] == 0);
            if bad_bits || past || first_mismatch {
                return Err(c);
            }
        }
        Ok(ResearchWorld {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(c)?,
            rule,
            paused,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(c)?).map_err(|_| c)?,
            start_bell: rd_u32(d, L::START_BELL).ok_or(c)?,
            start_ts: rd_i64(d, L::START_TS).ok_or(c)?,
            era,
            era_bell,
            first_bell,
            first_nations,
            known_by,
            rent_payer: rd_arr(d, L::RENT_PAYER).ok_or(c)?,
            learned: rd_u32(d, L::LEARNED).ok_or(c)?,
        })
    }

    pub fn write(&self, d: &mut [u8]) -> Result<(), ResearchError> {
        use research_world as L;
        if d.len() != L::SIZE {
            return Err(ResearchError::Length { expected: L::SIZE, got: d.len() });
        }
        let mut ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, RESEARCH_FAMILY_VERSION)
            & wr_u8(d, L::RULE, self.rule.to_byte())
            & wr_u8(d, L::PAUSED, self.paused as u8)
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_u32(d, L::START_BELL, self.start_bell)
            & wr_u8(d, L::ERA, self.era)
            & wr_arr(d, L::RSV_57, &[0u8; 3])
            & wr_i64(d, L::START_TS, self.start_ts)
            & wr_arr(d, L::FIRST_NATIONS, &self.first_nations)
            & wr_arr(d, L::KNOWN_BY, &self.known_by)
            & wr_arr(d, L::RENT_PAYER, &self.rent_payer)
            & wr_u32(d, L::LEARNED, self.learned);
        for (i, e) in self.era_bell.iter().enumerate() {
            ok &= wr_u32(d, L::ERA_BELL + 4 * i, *e);
        }
        for (i, e) in self.first_bell.iter().enumerate() {
            ok &= wr_u32(d, L::FIRST_BELL + 4 * i, *e);
        }
        d[L::RSV..L::SIZE].fill(0);
        if ok {
            Ok(())
        } else {
            Err(ResearchError::Corrupt)
        }
    }
}

// ------------------------------------------------------------ the nation record

/// A nation's research record (384 B). **Provisional magic.**
pub mod nation_research {
    crate::layout::fields!(size = 384;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RULE @ 18 : "u8" = 1;
        FACTION @ 19 : "u8" = 1;
        WORLD @ 20 : "[u8;32]" = 32;
        KNOWN @ 52 : "u16" = 2;
        RSV_54 @ 54 : "rsv" = 2;
        PLEDGED @ 56 : "[u32;16]" = 64;
        FIRST_PLEDGE_BELL @ 120 : "[u32;16]" = 64;
        LEARNED_BELL @ 184 : "[u32;16]" = 64;
        TOTAL @ 248 : "u64" = 8;
        PLEDGES @ 256 : "u32" = 4;
        RSV_260 @ 260 : "rsv" = 4;
        RENT_PAYER @ 264 : "[u8;32]" = 32;
        RSV @ 296 : "rsv" = 88;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWRN1";
}

/// One nation's research.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NationResearch {
    pub season_id: u64,
    pub rule: ResearchRule,
    pub faction: u8,
    pub world: WorldId,
    pub known: u16,
    /// Whole science pledged per tech (kept after learning).
    pub pledged: [u32; SLOTS],
    pub first_pledge_bell: [u32; SLOTS],
    pub learned_bell: [u32; SLOTS],
    /// Whole science pledged, ever.
    pub total: u64,
    /// Accepted pledges, ever.
    pub pledges: u32,
    pub rent_payer: [u8; 32],
}

impl NationResearch {
    pub fn new(season_id: u64, rule: ResearchRule, faction: u8, world: WorldId, rent_payer: [u8; 32]) -> Self {
        NationResearch {
            season_id,
            rule,
            faction,
            world,
            known: 0,
            pledged: [0; SLOTS],
            first_pledge_bell: [NO_BELL; SLOTS],
            learned_bell: [NO_BELL; SLOTS],
            total: 0,
            pledges: 0,
            rent_payer,
        }
    }

    pub fn view(&self) -> NationView {
        NationView { known: self.known, pledged: self.pledged }
    }

    /// Adds an accepted pledge.
    pub fn add(&mut self, t: u8, accepted: u32, bell: u32) -> Result<(), ResearchError> {
        let i = t as usize;
        if i >= TECH_COUNT {
            return Err(ResearchError::Corrupt);
        }
        self.pledged[i] = self.pledged[i].checked_add(accepted).ok_or(ResearchError::Corrupt)?;
        if self.first_pledge_bell[i] == NO_BELL {
            self.first_pledge_bell[i] = bell;
        }
        self.total = self.total.checked_add(accepted as u64).ok_or(ResearchError::Corrupt)?;
        self.pledges = self.pledges.checked_add(1).ok_or(ResearchError::Corrupt)?;
        Ok(())
    }

    /// Marks tech `t` known at `bell`.
    pub fn learn(&mut self, t: u8, bell: u32) -> Result<(), ResearchError> {
        let i = t as usize;
        if i >= TECH_COUNT || self.known & (1 << t) != 0 {
            return Err(ResearchError::Corrupt);
        }
        self.known |= 1 << t;
        self.learned_bell[i] = bell;
        Ok(())
    }

    pub fn read(d: &[u8]) -> Result<NationResearch, ResearchError> {
        use nation_research as L;
        if d.len() != L::SIZE {
            return Err(ResearchError::Length { expected: L::SIZE, got: d.len() });
        }
        let c = ResearchError::Corrupt;
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(c)? != L::MAGIC {
            return Err(ResearchError::Magic);
        }
        let v = rd_u16(d, L::FAMILY_VERSION).ok_or(c)?;
        if v != RESEARCH_FAMILY_VERSION {
            return Err(ResearchError::Version { expected: RESEARCH_FAMILY_VERSION, got: v });
        }
        if d[L::RSV_54..L::RSV_54 + 2].iter().any(|b| *b != 0)
            || d[L::RSV_260..L::RSV_260 + 4].iter().any(|b| *b != 0)
            || d[L::RSV..L::SIZE].iter().any(|b| *b != 0)
        {
            return Err(ResearchError::Reserved);
        }
        let rule = ResearchRule::from_byte(rd_u8(d, L::RULE).ok_or(c)?).ok_or(c)?;
        let faction = rd_u8(d, L::FACTION).ok_or(c)?;
        let known = rd_u16(d, L::KNOWN).ok_or(c)?;
        if faction >= NATIONS || known >> TECH_COUNT != 0 {
            return Err(c);
        }
        let arr = |off: usize| -> Result<[u32; SLOTS], ResearchError> {
            let mut a = [0u32; SLOTS];
            for (i, e) in a.iter_mut().enumerate() {
                *e = rd_u32(d, off + 4 * i).ok_or(c)?;
            }
            Ok(a)
        };
        let learned_bell = arr(L::LEARNED_BELL)?;
        for (i, b) in learned_bell.iter().enumerate() {
            if (known & (1 << i) != 0) != (*b != NO_BELL) {
                return Err(c);
            }
        }
        Ok(NationResearch {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(c)?,
            rule,
            faction,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(c)?).map_err(|_| c)?,
            known,
            pledged: arr(L::PLEDGED)?,
            first_pledge_bell: arr(L::FIRST_PLEDGE_BELL)?,
            learned_bell,
            total: rd_u64(d, L::TOTAL).ok_or(c)?,
            pledges: rd_u32(d, L::PLEDGES).ok_or(c)?,
            rent_payer: rd_arr(d, L::RENT_PAYER).ok_or(c)?,
        })
    }

    pub fn write(&self, d: &mut [u8]) -> Result<(), ResearchError> {
        use nation_research as L;
        if d.len() != L::SIZE {
            return Err(ResearchError::Length { expected: L::SIZE, got: d.len() });
        }
        let mut ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, RESEARCH_FAMILY_VERSION)
            & wr_u8(d, L::RULE, self.rule.to_byte())
            & wr_u8(d, L::FACTION, self.faction)
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_u16(d, L::KNOWN, self.known)
            & wr_arr(d, L::RSV_54, &[0u8; 2])
            & wr_u64(d, L::TOTAL, self.total)
            & wr_u32(d, L::PLEDGES, self.pledges)
            & wr_arr(d, L::RSV_260, &[0u8; 4])
            & wr_arr(d, L::RENT_PAYER, &self.rent_payer);
        for i in 0..SLOTS {
            ok &= wr_u32(d, L::PLEDGED + 4 * i, self.pledged[i])
                & wr_u32(d, L::FIRST_PLEDGE_BELL + 4 * i, self.first_pledge_bell[i])
                & wr_u32(d, L::LEARNED_BELL + 4 * i, self.learned_bell[i]);
        }
        d[L::RSV..L::SIZE].fill(0);
        if ok {
            Ok(())
        } else {
            Err(ResearchError::Corrupt)
        }
    }
}

// ------------------------------------------------------------ receipts

/// Receipt kinds.
pub mod receipt_kind {
    /// A pledge (accepted science).
    pub const PLEDGE: u8 = 1;
    /// A nation learned a tech (by a pledge or a settle).
    pub const LEARN: u8 = 2;
    /// The world advanced an era.
    pub const ERA: u8 = 3;
    /// Research started / paused / resumed (authority).
    pub const START: u8 = 4;
    pub const PAUSE: u8 = 5;
}

/// One research receipt: `kind u8 ‖ tech u8 ‖ nation u8 ‖ flags u8 ‖ bell
/// u32 ‖ citizen [32] ‖ amount u32 ‖ total u32 ‖ cost u32 ‖ era u8` (57 B).
/// `flags` bit 0: the learn was (one of) the world's first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub kind: u8,
    pub tech: u8,
    pub nation: u8,
    pub flags: u8,
    pub bell: u32,
    pub citizen: [u8; 32],
    pub amount: u32,
    pub total: u32,
    pub cost: u32,
    pub era: u8,
}

impl Receipt {
    pub const LEN: usize = 57;
    pub const FLAG_FIRST: u8 = 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        b[0] = self.kind;
        b[1] = self.tech;
        b[2] = self.nation;
        b[3] = self.flags;
        b[4..8].copy_from_slice(&self.bell.to_le_bytes());
        b[8..40].copy_from_slice(&self.citizen);
        b[40..44].copy_from_slice(&self.amount.to_le_bytes());
        b[44..48].copy_from_slice(&self.total.to_le_bytes());
        b[48..52].copy_from_slice(&self.cost.to_le_bytes());
        b[52] = self.era;
        b
    }

    pub fn decode(b: &[u8]) -> Option<Receipt> {
        if b.len() != Self::LEN || b[53..].iter().any(|x| *x != 0) {
            return None;
        }
        Some(Receipt {
            kind: b[0],
            tech: b[1],
            nation: b[2],
            flags: b[3],
            bell: u32::from_le_bytes(b[4..8].try_into().ok()?),
            citizen: b[8..40].try_into().ok()?,
            amount: u32::from_le_bytes(b[40..44].try_into().ok()?),
            total: u32::from_le_bytes(b[44..48].try_into().ok()?),
            cost: u32::from_le_bytes(b[48..52].try_into().ok()?),
            era: b[52],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> WorldId {
        WorldId::new([7; 32]).unwrap()
    }

    #[test]
    fn world_record_round_trips_and_ties() {
        let mut w = ResearchWorld::new(9, ResearchRule::V1, world(), 100, 60_000, [1; 32]);
        assert_eq!(w.learn(0, 2, 150, 0b1).unwrap(), (true, None));
        // same bell, another nation: a tie
        assert_eq!(w.learn(0, 4, 150, 0b1).unwrap(), (true, None));
        // a later bell: not first
        assert_eq!(w.learn(0, 1, 151, 0b1).unwrap(), (false, None));
        assert_eq!(w.first_nations[0], 0b10100);
        assert_eq!(w.known_by[0], 0b10110);
        assert_eq!(w.others_knowing(0, 2), 2);
        assert_eq!(w.learn(0, 2, 160, 0b1), Err(ResearchError::Rule(ResearchRefusal::Known)));
        // a third era-1 tech advances the era
        w.learn(1, 2, 170, 0b011).unwrap();
        assert_eq!(w.learn(2, 2, 180, 0b111).unwrap(), (true, Some(2)));
        assert_eq!(w.era, 2);
        assert_eq!(w.era_bell, [100, 180, NO_BELL]);
        let mut d = [0u8; research_world::SIZE];
        w.write(&mut d).unwrap();
        assert_eq!(ResearchWorld::read(&d).unwrap(), w);
        d[research_world::RSV] = 1;
        assert_eq!(ResearchWorld::read(&d), Err(ResearchError::Reserved));
    }

    #[test]
    fn nation_record_round_trips() {
        let mut n = NationResearch::new(9, ResearchRule::V1, 3, world(), [2; 32]);
        n.add(1, 120, 140).unwrap();
        n.add(1, 180, 150).unwrap();
        n.learn(1, 150).unwrap();
        assert_eq!(n.first_pledge_bell[1], 140);
        assert_eq!(n.total, 300);
        let mut d = [0u8; nation_research::SIZE];
        n.write(&mut d).unwrap();
        assert_eq!(NationResearch::read(&d).unwrap(), n);
        // a known bit without its bell is corrupt
        d[nation_research::KNOWN] |= 1;
        assert_eq!(NationResearch::read(&d), Err(ResearchError::Corrupt));
    }

    #[test]
    fn receipts_round_trip() {
        let r = Receipt { kind: 1, tech: 2, nation: 5, flags: 1, bell: 77, citizen: [9; 32], amount: 10, total: 30, cost: 300, era: 1 };
        assert_eq!(Receipt::decode(&r.to_bytes()), Some(r));
    }

    #[test]
    fn addresses_differ_per_nation() {
        let s: [Seed; NATIONS as usize] = core::array::from_fn(|f| nation_seed(f as u8));
        for i in 0..s.len() {
            for j in 0..i {
                assert_ne!(s[i].as_bytes(), s[j].as_bytes());
            }
            assert!(s[i].as_bytes().starts_with(b"wk"));
        }
        assert!(world_seed().as_bytes().starts_with(b"we"));
    }
}
