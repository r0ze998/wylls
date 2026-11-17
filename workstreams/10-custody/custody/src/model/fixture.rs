//! The cast of the demo and the tests: A owns the ore, B keeps it, C
//! carries it, D keeps it at the destination, E is a raider of another
//! nation. Ore is resource 3 (`Resource::Ore`); quantities in milli.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};

use super::{Key, Signer, World};
use crate::lot::PlaceRef;

pub const ORE: u8 = Resource::Ore as u8;

/// `n` whole units in milli.
pub const fn units(n: i64) -> i64 {
    n * MILLI
}

pub fn ore(n: i64) -> [i64; RESOURCES] {
    let mut a = [0i64; RESOURCES];
    a[ORE as usize] = units(n);
    a
}

pub struct Cast {
    pub w: World,
    pub a: Key,
    pub b: Key,
    pub c: Key,
    pub d: Key,
    pub e: Key,
    /// B's vault (capacity 1,000 ore) and D's (capacity 600).
    pub vb: PlaceRef,
    pub vd: PlaceRef,
}

impl Cast {
    pub fn new() -> Cast {
        let mut w = World::new();
        let a = w.add_citizen(b'A', 0, 0, 0, ore(1_000));
        let b = w.add_citizen(b'B', 1, 2, 0, ore(100));
        let c = w.add_citizen(b'C', 2, 1, 1, ore(0));
        let d = w.add_citizen(b'D', 3, 4, 1, ore(0));
        let e = w.add_citizen(b'E', 4, 3, 0, ore(0));
        let vb = w.add_vault(b, 2, 0, 10, units(1_000));
        let vd = w.add_vault(d, 4, 1, 20, units(600));
        Cast {
            w,
            a,
            b,
            c,
            d,
            e,
            vb,
            vd,
        }
    }

    pub fn wallet(k: Key) -> Signer {
        Signer {
            citizen: k,
            session: false,
        }
    }

    pub fn session(k: Key) -> Signer {
        Signer {
            citizen: k,
            session: true,
        }
    }

    pub fn home(&self, k: &Key) -> PlaceRef {
        self.w.citizens[k].home
    }
}

impl Default for Cast {
    fn default() -> Cast {
        Cast::new()
    }
}
