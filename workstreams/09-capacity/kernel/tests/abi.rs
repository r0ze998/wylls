//! 09's numbers against workstream 4's provisional allocation (rev 3,
//! 8e96f24d): inside 09's bands, distinct, and clear of every band and
//! number 4 gave to the base or to another workstream.
#![cfg(feature = "abi-04-provisional")]

use std::collections::BTreeSet;
use wylls_capacity::abi::*;
use wylls_capacity::CapError::{self, *};

const ALL_ERRORS: [CapError; 30] = [
    NotOwner,
    NotUser,
    WrongGeneration,
    FacilityGone,
    NotEnoughWorkshops,
    CapacityExceeded,
    ReclaimBlocked,
    GrantUnitsExceeded,
    GrantOutputExceeded,
    OutsideGrantWindow,
    GrantRevoked,
    BadWindow,
    AlreadyStarted,
    AlreadyFinal,
    UnknownGrant,
    UnknownJob,
    Conflict,
    OwnerAway,
    WrongRecipe,
    WrongResource,
    TooMany,
    Custody,
    Overflow,
    TimeReversed,
    UnknownPool,
    FacilityLive,
    BadPlace,
    Retired,
    GenerationReused,
    NotRetirable,
];

/// Every kernel error is listed (a new one fails to compile here).
#[allow(dead_code)]
fn listed(e: CapError) -> bool {
    match e {
        NotOwner | NotUser | WrongGeneration | FacilityGone | NotEnoughWorkshops
        | CapacityExceeded | ReclaimBlocked | GrantUnitsExceeded | GrantOutputExceeded
        | OutsideGrantWindow | GrantRevoked | BadWindow | AlreadyStarted | AlreadyFinal
        | UnknownGrant | UnknownJob | Conflict | OwnerAway | WrongRecipe | WrongResource
        | TooMany | Custody | Overflow | TimeReversed | UnknownPool | FacilityLive | BadPlace
        | Retired | GenerationReused | NotRetirable => true,
    }
}

#[test]
fn instruction_tags_are_09s_band_and_no_one_elses() {
    let tags = [
        TAG_OPEN_CAPACITY_POOL,
        TAG_LEND_CAPACITY,
        TAG_RECLAIM_CAPACITY,
        TAG_GRANT_CAPACITY,
        TAG_REVOKE_CAPACITY,
        TAG_RESERVE_CAPACITY,
        TAG_DEPOSIT_TO_JOB,
        TAG_SETTLE_JOB,
        TAG_CANCEL_JOB,
        TAG_CLAIM_JOB,
        TAG_RECORD_FACILITY_LOSS,
        TAG_RETIRE_JOB,
        TAG_RETIRE_GRANT,
        TAG_RETIRE_POOL,
    ];
    let set: BTreeSet<u8> = tags.into_iter().collect();
    assert_eq!(set.len(), 14);
    assert_eq!(
        set,
        TAGS.collect::<BTreeSet<_>>(),
        "the whole band, in order"
    );
    // 4's other bands: 8's 0xC1, 10's 0xC2-0xCC, 2's 0xD0-0xD5, 20's
    // 0xE0-0xE7, 11's 0xE8-0xED, the never-assigned 0xFE, test-only 0xFF,
    // and the reserved tags.
    let others = [
        0xC1..=0xCC,
        0xD0..=0xD5,
        0xE0..=0xED,
        0xFE..=0xFF,
        0x80..=0x91,
        0xA8..=0xAF,
    ];
    for t in &set {
        assert!(!others.iter().any(|r| r.contains(t)), "{t:#x}");
        assert!(![0x53, 0xA4, 0xBF].contains(t));
    }
}

#[test]
fn program_errors_are_the_kernel_codes_in_09s_band() {
    let codes: BTreeSet<u16> = ALL_ERRORS.iter().map(|e| e.code()).collect();
    assert_eq!(codes, (1..=30).collect(), "codes 1-30, each once");
    assert!(ALL_ERRORS.iter().all(|e| listed(*e)));
    let errs: BTreeSet<u32> = ALL_ERRORS.iter().map(|e| program_error(*e)).collect();
    assert_eq!(errs, (110..=139).collect());
    assert!(errs.iter().all(|e| ERRORS.contains(e)));
    // The base (1-94, 99), 10's 100-104, 11's 150-169, 20's 170-179, 2's 200-213.
    let others = [1..=94, 99..=104, 150..=179, 200..=213];
    assert!(errs.iter().all(|e| !others.iter().any(|r| r.contains(e))));
}

#[test]
fn accounts_are_4s_kinds_with_seeds_and_magic_no_one_else_uses() {
    assert_eq!(
        (ACCOUNT_KIND_CAPACITY_POOL, ACCOUNT_KIND_CAPACITY_JOB),
        (25, 26)
    );
    assert_eq!((SEED_CAPACITY_POOL, SEED_CAPACITY_JOB), (b"cp", b"cj"));
    // Seeds and magic of the base (frontier-abi at ef63544c) and of the
    // proposals in 4's inventory.
    let seeds = [
        "aa", "ad", "an", "ar", "bl", "ci", "ct", "cv", "dc", "dp", "fr", "ho", "js", "mc", "na",
        "pf", "po", "pv", "rs", "sd", "sv", "tw", "va", "cl", "gr", "xr", "xg", "xi", "xb",
    ];
    for s in [SEED_CAPACITY_POOL, SEED_CAPACITY_JOB] {
        assert!(!seeds.contains(&std::str::from_utf8(s).unwrap()));
    }
    let magic = [
        "PSF1ADAY", "PSF1ANCH", "PSF1ARCH", "PSF1ASLT", "PSF1BLOG", "PSF1CITZ", "PSF1CLIN",
        "PSF1CRVN", "PSF1DCLM", "PSF1DPOL", "PSF1FRNT", "PSF1HOLD", "PSF1JSHD", "PSF1MRCH",
        "PSF1NATN", "PSF1PFND", "PSF1PROV", "PSF1RING", "PSF1SEAS", "PSF1SEED", "PSF1STRC",
        "PSF1SVRD", "PSF1VALT", "PSF1CLOT", "PSF1ESCR", "PSF1ISSU", "PSF1TLOT", "PSF2GRNT",
        "PSFNP002", "PSFNR001",
    ];
    for m in [MAGIC_CAPACITY_POOL, MAGIC_CAPACITY_JOB] {
        assert!(!magic.contains(&std::str::from_utf8(m).unwrap()));
    }
}

#[test]
fn records_need_more_kinds_than_the_band_holds() {
    // Not a decision: the numbers 4 must choose between (20 kinds, or the
    // band's 10 with a sub-kind byte).
    assert_eq!(LOG_KINDS.count(), 10);
    assert_eq!(EVENT_KINDS, 20);
    // event_index matches every Event (a new kind fails to compile).
}
