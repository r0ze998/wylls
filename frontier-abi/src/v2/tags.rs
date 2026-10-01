//! ABI v2 instruction tags (MC contract §5.4): M1's 50 tags unchanged
//! plus 0xA0–0xA3 and 0xA5–0xA7. 0xA4 (CollectTribute, M3) and 0xA8–0xAF
//! (Settler march, SettleFounding, Raid, AutoReinforce) are reserved.
//!
//! **Staged (v1.1, R-16):** v1's [`crate::tags::Ix`] keeps its 50 variants
//! (the M1 program's dispatch and the svm coverage table match it
//! exhaustively); the v2 set is this enum, and `tags::Ix::ALL_V2` names
//! it for the twin tests of CQ2-D.

use crate::tags::Class;

macro_rules! tags_v2 {
    ($( $name:ident = $tag:literal, $class:ident, $top:literal; )*) => {
        /// Every ABI v2 instruction (57: M1's 50 and 7 new).
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[repr(u8)]
        pub enum Ix { $( $name = $tag, )* }

        impl Ix {
            pub const ALL: &'static [Ix] = &[ $( Ix::$name, )* ];

            pub const fn tag(self) -> u8 { self as u8 }

            pub const fn from_tag(t: u8) -> Option<Ix> {
                match t { $( $tag => Some(Ix::$name), )* _ => None }
            }

            pub const fn name(self) -> &'static str {
                match self { $( Ix::$name => stringify!($name), )* }
            }

            /// Keeper class.
            pub const fn class(self) -> Class {
                match self { $( Ix::$name => Class::$class, )* }
            }

            /// Refuses `get_stack_height() > 1` (`NotTopLevel`).
            pub const fn top_level_only(self) -> bool {
                match self { $( Ix::$name => $top, )* }
            }
        }
    };
}

tags_v2! {
    CreateSeason = 0x01, O, false;
    InitShards = 0x02, O, false;
    ConsumeGenesisSeed = 0x03, D, true;
    EndSeason = 0x04, N, false;
    CloseSeason = 0x05, O, false;
    AbortSeason = 0x06, N, false;
    SetWindowSchedule = 0x07, O, false;
    AnnounceSeason = 0x08, O, false;
    InitBeaconLogs = 0x09, O, false;
    PostAnchor = 0x10, D, true;
    PostAnchorMulti = 0x11, D, true;
    PostSeed = 0x12, D, true;
    PostBeacon = 0x13, N, true;
    ArchiveAnchors = 0x14, D, false;
    CloseSeedCache = 0x15, N, false;
    OpenRing = 0x20, D, false;
    ConsumeRingSeed = 0x21, D, true;
    OpenProvince = 0x22, D, true;
    FoldOccupancy = 0x23, D, false;
    CloseProvince = 0x24, N, false;
    Join = 0x30, P, false;
    SetSession = 0x31, P, false;
    SetVigil = 0x32, P, false;
    FileTicket = 0x33, P, false;
    SettleTicket = 0x34, D, false;
    ReleaseDormant = 0x35, N, false;
    CloseHolding = 0x36, N, false;
    CloseCitizen = 0x37, N, false;
    Harvest = 0x40, P, false;
    Build = 0x41, P, false;
    Train = 0x42, P, false;
    Muster = 0x43, P, false;
    Dissolve = 0x44, P, false;
    Garrison = 0x45, P, false;
    Explore = 0x46, P, false;
    SettleExplore = 0x47, N, false;
    DisbandStranded = 0x48, N, false;
    Depart = 0x50, P, false;
    Reveal = 0x51, W, true;
    SettleDeparture = 0x52, D, false;
    SettleTransit = 0x54, D, false;
    SweepPoolOwed = 0x55, N, false;
    GatherClash = 0x60, D, true;
    ResolveFromInputs = 0x61, D, true;
    ResolveClash = 0x62, Test, true;
    SkipQuiet = 0x63, D, true;
    CloseClashInputs = 0x64, N, false;
    CloseArrivalDay = 0x65, N, false;
    CloseArrivalSlot = 0x66, N, false;
    ClaimDefence = 0x70, D, false;
    // MC (§5.5)
    DeclareSiege = 0xA0, P, false;
    SettleSiege = 0xA1, N, false;
    SettleCapture = 0xA2, D, false;
    FileOutpost = 0xA3, P, false;
    FoldMarch = 0xA5, D, false;
    RetireHost = 0xA6, P, false;
    CloseMarch = 0xA7, N, false;
}

impl Ix {
    /// The seven MC instructions.
    pub const NEW: [Ix; 7] = [
        Ix::DeclareSiege,
        Ix::SettleSiege,
        Ix::SettleCapture,
        Ix::FileOutpost,
        Ix::FoldMarch,
        Ix::RetireHost,
        Ix::CloseMarch,
    ];

    /// The M1 instruction of the same tag (`None` for the MC ones).
    pub const fn to_v1(self) -> Option<crate::tags::Ix> {
        crate::tags::Ix::from_tag(self.tag())
    }

    /// The v2 instruction of an M1 one (same tag).
    pub const fn of_v1(ix: crate::tags::Ix) -> Ix {
        match Ix::from_tag(ix.tag()) {
            Some(x) => x,
            // Every M1 tag is a v2 tag (`tests::v2_extends_m1`).
            None => Ix::CreateSeason,
        }
    }

    /// Whether the instruction is new in MC.
    pub const fn is_new(self) -> bool {
        self.tag() >= 0xA0
    }

    /// Whether MC changed its account list or data (§5.6).
    pub const fn changed_in_v2(self) -> bool {
        matches!(
            self,
            Ix::CreateSeason
                | Ix::OpenRing
                | Ix::OpenProvince
                | Ix::FoldOccupancy
                | Ix::FileTicket
                | Ix::SettleTicket
                | Ix::ReleaseDormant
                | Ix::Harvest
                | Ix::Build
                | Ix::Train
                | Ix::Muster
                | Ix::Dissolve
                | Ix::Garrison
                | Ix::Explore
                | Ix::Depart
                | Ix::Reveal
                | Ix::SettleDeparture
                | Ix::SettleTransit
                | Ix::GatherClash
                | Ix::ResolveFromInputs
                | Ix::SkipQuiet
                | Ix::SettleExplore
        )
    }
}

impl crate::tags::Ix {
    /// Every ABI v2 instruction (v1.1, R-16: the name CQ2-D's twin tests
    /// use beside `Ix::ALL`). The v2 enum is [`Ix`].
    pub const ALL_V2: &'static [Ix] = Ix::ALL;
}

/// Reserved v2 tags: M1's reserved set, 0xA4 and 0xA8–0xAF.
pub const fn is_reserved(t: u8) -> bool {
    crate::tags::is_reserved(t) || matches!(t, 0xA4 | 0xA8..=0xAF)
}

/// Player instructions the relay may sponsor (§8.3): M1's, DeclareSiege,
/// FileOutpost and RetireHost (the victim, during the season).
pub const fn relay_player_shape(ix: Ix) -> bool {
    match ix.to_v1() {
        Some(v1) => crate::tags::relay_player_shape(v1),
        None => matches!(ix, Ix::DeclareSiege | Ix::FileOutpost | Ix::RetireHost),
    }
}

/// Settle shapes the relay may sponsor, charged to the requester (§8.3):
/// M1's, SettleSiege, SettleCapture, FoldMarch, CloseMarch, and RetireHost
/// after `end_bell`.
pub const fn relay_settle_shape(ix: Ix) -> bool {
    match ix.to_v1() {
        Some(v1) => crate::tags::relay_settle_shape(v1),
        None => matches!(
            ix,
            Ix::SettleSiege | Ix::SettleCapture | Ix::FoldMarch | Ix::CloseMarch | Ix::RetireHost
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_extends_m1() {
        assert_eq!(Ix::ALL.len(), 57);
        assert_eq!(crate::tags::Ix::ALL_V2.len(), 57);
        for v1 in crate::tags::Ix::ALL {
            let v = Ix::of_v1(*v1);
            assert_eq!(v.tag(), v1.tag());
            assert_eq!(v.name(), v1.name());
            assert_eq!(v.class(), v1.class(), "{}", v1.name());
            assert_eq!(v.top_level_only(), v1.top_level_only());
            assert_eq!(v.to_v1(), Some(*v1));
            assert_eq!(relay_player_shape(v), crate::tags::relay_player_shape(*v1));
            assert_eq!(relay_settle_shape(v), crate::tags::relay_settle_shape(*v1));
        }
        for (i, a) in Ix::ALL.iter().enumerate() {
            assert_eq!(Ix::from_tag(a.tag()), Some(*a));
            assert!(!is_reserved(a.tag()), "{}", a.name());
            for b in &Ix::ALL[i + 1..] {
                assert_ne!(a.tag(), b.tag());
            }
        }
        for t in [0xA4u8, 0xA8, 0xAF, 0x53] {
            assert!(is_reserved(t));
            assert_eq!(Ix::from_tag(t), None);
        }
    }

    #[test]
    fn new_classes_are_the_contract_table() {
        use Class::*;
        let want = [
            (Ix::DeclareSiege, P),
            (Ix::SettleSiege, N),
            (Ix::SettleCapture, D),
            (Ix::FileOutpost, P),
            (Ix::FoldMarch, D),
            (Ix::RetireHost, P),
            (Ix::CloseMarch, N),
        ];
        for (ix, c) in want {
            assert_eq!(ix.class(), c, "{}", ix.name());
            assert!(ix.is_new() && ix.to_v1().is_none());
            assert!(!ix.top_level_only(), "{}", ix.name());
        }
        assert_eq!(Ix::NEW.len(), 7);
        assert!(relay_player_shape(Ix::DeclareSiege));
        assert!(relay_settle_shape(Ix::FoldMarch));
        assert!(!relay_player_shape(Ix::SettleCapture));
        let w = Ix::ALL.iter().filter(|i| i.class() == W).count();
        assert_eq!(w, 1, "only Reveal is class W in MC too");
    }
}
