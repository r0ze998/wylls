//! ABI v2 error codes (MC contract §5.3), **stable forever**: 62–78 (MC)
//! and 79–86 (S1, 1b), beside
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
    /// S1: BuildVault on a tile that does not qualify (a site, the keep or
    /// camp tile, impassable, or a vault already there).
    VaultSite = 79,
    /// S1: `MAX_VAULTS` reached (BuildVault, SeizeVault).
    VaultLimit = 80,
    /// S1: a send to another player's place needs the wallet's signature.
    WalletRequired = 81,
    /// S1: no free caravan slot in a Province of the path.
    ProvinceBusy = 82,
    /// S1: SettleCaravan before the arrival, or before a path Province has
    /// resolved past the caravan's last bell there (lag only waits).
    CaravanEarly = 83,
    /// S1: a raid is open (SettleCaravan waits), or none is (RaidCaravan,
    /// DefaultRaid).
    RaidState = 84,
    /// S1: RaidCaravan after the raider's window, DefaultRaid before it.
    RaidWindow = 85,
    /// S1: SeizeVault or SeizeStructure without the captor's host on the
    /// tile, or with one of the owner's there.
    NotOnTile = 86,
    /// S1 (1d/1e): BuildStructure on a tile that does not qualify (a site,
    /// the keep or camp tile, impassable, or a structure already there).
    StructureSite = 87,
    /// S1 (1d/1e): `structure::max_of(kind)` reached (BuildStructure,
    /// SeizeStructure).
    StructureLimit = 88,
    /// S1 (1d/1e): the Province's structure list (or its fort block) is full.
    StructureFull = 89,
    /// S1 (1e): SeizeStructure of a fort that still has troops.
    FortManned = 90,
    /// S1 (1e): Propose with every proposal slot of the Nation open.
    ProposalsFull = 91,
    /// S1 (1e): Propose or Vote by a Citizen not yet eligible, or expelled.
    NotVoter = 92,
    /// S1 (1e): the proposal is not in the state the instruction needs (a
    /// vote on a closed one, a settle of an open one, a second open
    /// proposal of the proposer, a target that does not qualify).
    ProposalState = 93,
    /// S2 (2a): IssueTickets beyond `ticket::MAX_OPEN_ISSUES`.
    TicketLimit = 94,
    /// S2 (2a): the lot or issue is void (its source changed generation or
    /// closed), closed, or held in an escrow.
    TicketVoid = 95,
    /// S2 (2a): the ticket's terms (kind, amount, resource, per unit, until
    /// day) or the source do not qualify.
    TicketTerms = 96,
    /// S2 (2b): the vault is shared: its goods belong to its share holders
    /// (no plain send, settle, close or receipt; withdraw with shares).
    VaultShared = 97,
}

impl CqError {
    pub const ALL: [CqError; 36] = {
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
            VaultSite,
            VaultLimit,
            WalletRequired,
            ProvinceBusy,
            CaravanEarly,
            RaidState,
            RaidWindow,
            NotOnTile,
            StructureSite,
            StructureLimit,
            StructureFull,
            FortManned,
            ProposalsFull,
            NotVoter,
            ProposalState,
            TicketLimit,
            TicketVoid,
            TicketTerms,
            VaultShared,
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
            VaultSite => "VaultSite",
            VaultLimit => "VaultLimit",
            WalletRequired => "WalletRequired",
            ProvinceBusy => "ProvinceBusy",
            CaravanEarly => "CaravanEarly",
            RaidState => "RaidState",
            RaidWindow => "RaidWindow",
            NotOnTile => "NotOnTile",
            StructureSite => "StructureSite",
            StructureLimit => "StructureLimit",
            StructureFull => "StructureFull",
            FortManned => "FortManned",
            ProposalsFull => "ProposalsFull",
            NotVoter => "NotVoter",
            ProposalState => "ProposalState",
            TicketLimit => "TicketLimit",
            TicketVoid => "TicketVoid",
            TicketTerms => "TicketTerms",
            VaultShared => "VaultShared",
        }
    }

    /// What an off-chain duty does on the code: lag-type refusals wait
    /// (the keeper resolves or settles first), the rest are refusals.
    pub const fn keeper_action(self) -> KeeperAction {
        match self {
            CqError::FoldTooEarly
            | CqError::CapturePending
            | CqError::NotDue
            | CqError::CaravanEarly
            | CqError::RaidWindow => KeeperAction::Wait,
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

/// Every v2 code in code order (M1's 1–61, MC's 62–78, S1's 79–90,
/// then 99).
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

    /// One name a code: the clients name codes, so an MC or S1 code never
    /// reuses an M1 name (S1 1e's 92 was drafted as M1's NotEligible).
    #[test]
    fn names_are_unique_across_both_spaces() {
        let names: std::vec::Vec<&str> = all_codes().map(|c| c.name()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "a name names two codes");
    }

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
        assert_eq!(all.len(), 62 + 36);
        assert_eq!(CqError::VaultShared.code(), 97);
        assert_eq!(CqError::TicketTerms.code(), 96);
        assert_eq!(CqError::ProposalState.code(), 93);
        assert_eq!(CqError::NotOnTile.code(), 86);
        assert_eq!(CqError::StructureFull.code(), 89);
        assert!(all.windows(2).all(|w| w[0] < w[1]), "code order");
        assert_eq!(all[60], 61);
        assert_eq!(all[61], 62);
        assert_eq!(*all.last().unwrap(), 99);
        assert_eq!(Code::from_code(66), Some(Code::Cq(CqError::SiegeCap)));
        assert_eq!(
            Code::from_code(52),
            Some(Code::V1(FrontierError::AlreadyDone))
        );
        assert_eq!(Code::from_code(79), Some(Code::Cq(CqError::VaultSite)));
        assert_eq!(Code::from_code(87), Some(Code::Cq(CqError::StructureSite)));
        assert_eq!(Code::from_code(91), Some(Code::Cq(CqError::ProposalsFull)));
        assert_eq!(Code::from_code(94), Some(Code::Cq(CqError::TicketLimit)));
        assert_eq!(Code::from_code(98), None);
        assert_eq!(
            Code::Cq(CqError::FoldTooEarly).keeper_action(),
            KeeperAction::Wait
        );
    }
}
