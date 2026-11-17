//! Error codes (contract §3, stable numbers).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum CapError {
    NotOwner = 1,
    NotUser = 2,
    WrongGeneration = 3,
    FacilityGone = 4,
    NotEnoughWorkshops = 5,
    CapacityExceeded = 6,
    ReclaimBlocked = 7,
    GrantUnitsExceeded = 8,
    GrantOutputExceeded = 9,
    OutsideGrantWindow = 10,
    GrantRevoked = 11,
    BadWindow = 12,
    AlreadyStarted = 13,
    AlreadyFinal = 14,
    UnknownGrant = 15,
    UnknownJob = 16,
    Conflict = 17,
    OwnerAway = 18,
    WrongRecipe = 19,
    WrongResource = 20,
    TooMany = 21,
    Custody = 22,
    Overflow = 23,
    TimeReversed = 24,
    UnknownPool = 25,
    FacilityLive = 26,
    BadPlace = 27,
    Retired = 28,
    GenerationReused = 29,
    NotRetirable = 30,
}

impl CapError {
    pub const fn code(self) -> u16 {
        self as u16
    }
}

impl core::fmt::Display for CapError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?} ({})", self, self.code())
    }
}

impl std::error::Error for CapError {}
