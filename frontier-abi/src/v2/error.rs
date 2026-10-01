//! ABI v2 error codes (MC contract §5.3), **stable forever**: 62–78, beside
//! M1's 1–61 and 99 ([`crate::error::FrontierError`], unchanged).
//!
//! The program returns `ProgramError::Custom(code)` for either enum;
//! [`Code`] is the union the web table, the relay and the keeper map from
//! (`vectors/v2/errors.json`).

use crate::error::{keeper_action, FrontierError, KeeperAction};

/// The MC program's new error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u32)]
pub enum CqError {
    /// An instruction would write a Holding whose site was captured but
    /// not yet settled (§5.8).
    CapturePending = 62,
    /// Immunity or Respite bars the declarer's faction.
    Immune = 63,
    /// Any conquest record on the site.
    SiegeBusy = 64,
    /// A stake or a reservation is still owed on the site.
    StakeUnsettled = 65,
    /// `sieges_per_day` reached.
    SiegeCap = 66,
    /// No qualifying host of the declarer on the target's hex.
    NotOnHex = 67,
    /// The siege cannot finish before `end_bell`.
    TooLate = 68,
    /// No free holding slot (K-25).
    HoldingsFull = 69,
    NotBesiegeable = 70,
    Friendly = 71,
    FrontierProtected = 72,
    Heartland = 73,
    /// SettleCapture on a record that is not capture due.
    NotDue = 74,
    /// FileOutpost: ring, range, tier, share or close.
    OutpostRule = 75,
    /// FoldMarch `hour != next_hour`.
    FoldOutOfOrder = 76,
    /// FoldMarch before a member resolved past the hour (lag only waits).
    FoldTooEarly = 77,
    /// v1.1: the declaring host is not the hex's lead host; RetireHost by
    /// a non-victim during the season.
    NotLead = 78,
}

impl CqError {
    pub const ALL: [CqError; 17] = {
        use CqError::*;
        [
            CapturePending,
            Immune,
            SiegeBusy,
            StakeUnsettled,
            SiegeCap,
            NotOnHex,
            TooLate,
            HoldingsFull,
            NotBesiegeable,
            Friendly,
            FrontierProtected,
            Heartland,
            NotDue,
            OutpostRule,
            FoldOutOfOrder,
            FoldTooEarly,
            NotLead,
        ]
    };

    pub const fn code(self) -> u32 {
        self as u32
    }

    pub fn from_code(code: u32) -> Option<CqError> {
        Self::ALL.iter().copied().find(|e| e.code() == code)
    }

    pub const fn name(self) -> &'static str {
        use CqError::*;
        match self {
            CapturePending => "CapturePending",
            Immune => "Immune",
            SiegeBusy => "SiegeBusy",
            StakeUnsettled => "StakeUnsettled",
            SiegeCap => "SiegeCap",
            NotOnHex => "NotOnHex",
            TooLate => "TooLate",
            HoldingsFull => "HoldingsFull",
            NotBesiegeable => "NotBesiegeable",
            Friendly => "Friendly",
            FrontierProtected => "FrontierProtected",
            Heartland => "Heartland",
            NotDue => "NotDue",
            OutpostRule => "OutpostRule",
            FoldOutOfOrder => "FoldOutOfOrder",
            FoldTooEarly => "FoldTooEarly",
            NotLead => "NotLead",
        }
    }

    /// What an off-chain duty does on the code: lag-type refusals wait
    /// (the keeper resolves or settles first), the rest are refusals.
    pub const fn keeper_action(self) -> KeeperAction {
        match self {
            CqError::FoldTooEarly | CqError::CapturePending | CqError::NotDue => KeeperAction::Wait,
            _ => KeeperAction::Refused,
        }
    }
}

/// Any code an ABI v2 program can return.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Code {
    V1(FrontierError),
    Cq(CqError),
}

impl Code {
    pub const fn code(self) -> u32 {
        match self {
            Code::V1(e) => e.code(),
            Code::Cq(e) => e.code(),
        }
    }
    pub fn from_code(c: u32) -> Option<Code> {
        FrontierError::from_code(c)
            .map(Code::V1)
            .or_else(|| CqError::from_code(c).map(Code::Cq))
    }
    pub const fn name(self) -> &'static str {
        match self {
            Code::V1(e) => e.name(),
            Code::Cq(e) => e.name(),
        }
    }
    /// Whether the program may return the code.
    pub const fn program_code(self) -> bool {
        match self {
            Code::V1(e) => e.program_code(),
            Code::Cq(_) => true,
        }
    }
    pub const fn keeper_action(self) -> KeeperAction {
        match self {
            Code::V1(e) => keeper_action(e),
            Code::Cq(e) => e.keeper_action(),
        }
    }
}

/// Every v2 code in code order (M1's 1–61, MC's 62–78, then 99).
pub fn all_codes() -> impl Iterator<Item = Code> {
    let v1 = FrontierError::ALL.iter().copied();
    v1.clone()
        .filter(|e| e.code() < 99)
        .map(Code::V1)
        .chain(CqError::ALL.iter().copied().map(Code::Cq))
        .chain(v1.filter(|e| e.code() >= 99).map(Code::V1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_contract_table() {
        let mut expect = 62u32;
        for e in CqError::ALL {
            assert_eq!(e.code(), expect, "{}", e.name());
            assert_eq!(CqError::from_code(expect), Some(e));
            assert_eq!(FrontierError::from_code(expect), None, "no M1 collision");
            expect += 1;
        }
        assert_eq!(CqError::NotLead.code(), 78);
        let all: std::vec::Vec<u32> = all_codes().map(|c| c.code()).collect();
        assert_eq!(all.len(), 62 + 17);
        assert!(all.windows(2).all(|w| w[0] < w[1]), "code order");
        assert_eq!(all[60], 61);
        assert_eq!(all[61], 62);
        assert_eq!(*all.last().unwrap(), 99);
        assert_eq!(Code::from_code(66), Some(Code::Cq(CqError::SiegeCap)));
        assert_eq!(
            Code::from_code(52),
            Some(Code::V1(FrontierError::AlreadyDone))
        );
        assert_eq!(Code::from_code(79), None);
        assert_eq!(
            Code::Cq(CqError::FoldTooEarly).keeper_action(),
            KeeperAction::Wait
        );
    }
}
