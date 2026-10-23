//! The rules version a season runs under, where a bot's choices differ
//! (redesign stage 1, S1): M1, the conquest rules (program version 3) and
//! the S1 rules (program version 4: MC plus the arms economy).
//!
//! | | M1 | MC | S1 |
//! |---|---|---|---|
//! | Train | `catalog::train` | `catalog::train_v2` (K2) | `arms::train_v3` (strong units cost arms) |
//! | Build items | 0..=6 | 0..=6 | 0..=6 and the workshop (`arms::ITEM_WORKSHOP`) |
//! | Doctrines | `DOCTRINES` | `DOCTRINES` | `DOCTRINES_V3` (A Pikeman, C Crossbowman, F Knight) |
//!
//! The program refuses a season of another version, so a bot that reads
//! the Season's `program_version` prices exactly what the chain charges.

use permutation_rules::frontier::arms;
use permutation_rules::frontier::catalog::{self, Cost};
use permutation_rules::frontier::doctrine::{Doctrine, DOCTRINES, DOCTRINES_V3};
use permutation_rules::frontier::holding::Effect;
use permutation_rules::frontier::holding::RESOURCES;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rules {
    #[default]
    M1,
    /// The conquest rules (`program_version` 3).
    Mc,
    /// The S1 rules (`program_version` 4).
    S1,
}

impl Rules {
    /// The rules of a Season with `program_version`.
    pub fn of_program_version(v: u16) -> Rules {
        if v >= frontier_abi::v2::presets::PROGRAM_VERSION_S1 {
            Rules::S1
        } else if v >= frontier_abi::v2::presets::PROGRAM_VERSION_V2 {
            Rules::Mc
        } else {
            Rules::M1
        }
    }

    /// The rules of the season an observation reads (M1 when no Season
    /// account was read).
    pub fn of_obs(obs: &crate::obs::Observation) -> Rules {
        obs.season.rules()
    }

    /// Whether the conquest rules apply (MC and S1).
    pub fn conquest(self) -> bool {
        self != Rules::M1
    }

    /// The doctrine table.
    pub fn doctrines(self) -> &'static [Doctrine; 6] {
        match self {
            Rules::S1 => &DOCTRINES_V3,
            _ => &DOCTRINES,
        }
    }

    /// The doctrine of `faction` (taken mod 6, as the bots always have).
    pub fn doctrine(self, faction: u8) -> &'static Doctrine {
        &self.doctrines()[(faction % 6) as usize]
    }

    /// What Train charges for `n` troops of `unit`.
    pub fn train(self, unit: u8, n: u32) -> Option<Cost> {
        match self {
            Rules::S1 => arms::train_v3(unit, n),
            Rules::Mc => catalog::train_v2(unit, n),
            Rules::M1 => catalog::train(unit, n),
        }
    }

    /// The building items a bot may Build (walls and the tier-up apart):
    /// the six producers, and the workshop under S1.
    pub fn building_items(self) -> &'static [u8] {
        match self {
            Rules::S1 => &[0, 1, 2, 3, 4, 5, arms::ITEM_WORKSHOP],
            _ => &[0, 1, 2, 3, 4, 5],
        }
    }

    /// What Build charges for item `item` as the `n`-th copy.
    pub fn building(self, item: u8, n: u32, d: &Doctrine) -> Option<(Cost, Effect, u32)> {
        match self {
            Rules::S1 => arms::building(item, n, d),
            _ => catalog::building(item, n, d),
        }
    }

    /// Whether training `unit` needs arms under these rules.
    pub fn needs_arms(self, unit: u8) -> bool {
        self == Rules::S1
            && arms::TRAIN_ARMS_PER_100
                .get(unit as usize)
                .is_some_and(|&a| a > 0)
    }
}

/// Whether `stores` cover `cost`.
pub fn covers(stores: &[i64; RESOURCES], cost: &Cost) -> bool {
    (0..RESOURCES).all(|r| stores[r] >= cost[r])
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, PROGRAM_VERSION_V2};
    use permutation_rules::units::UnitType;

    #[test]
    fn versions_and_costs() {
        assert_eq!(Rules::of_program_version(2), Rules::M1);
        assert_eq!(Rules::of_program_version(PROGRAM_VERSION_V2), Rules::Mc);
        assert_eq!(Rules::of_program_version(PROGRAM_VERSION_S1), Rules::S1);
        let k = UnitType::Knight as u8;
        let arms_of = |r: Rules| r.train(k, 100).unwrap()[arms::ARMS as usize];
        assert_eq!(arms_of(Rules::Mc), 0);
        assert!(arms_of(Rules::S1) > 0);
        assert!(Rules::S1.needs_arms(k));
        assert!(!Rules::S1.needs_arms(UnitType::Spearman as u8));
        assert!(!Rules::Mc.needs_arms(k));
        assert_eq!(Rules::S1.doctrine(5).unit, UnitType::Knight);
        assert_eq!(Rules::Mc.doctrine(5).unit, UnitType::Horseman);
        assert!(Rules::S1.building_items().contains(&arms::ITEM_WORKSHOP));
        assert!(Rules::Mc
            .building(arms::ITEM_WORKSHOP, 1, Rules::Mc.doctrine(0))
            .is_none());
        assert!(Rules::S1
            .building(arms::ITEM_WORKSHOP, 1, Rules::S1.doctrine(0))
            .is_some());
    }
}
