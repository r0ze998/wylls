//! **Stub (AC3a).** The `recall:<handle>` candidate: a new Depart of an
//! arrived own host to the own holding tile (contract §4.3; there is no
//! recall of an in-flight march). AC3b replaces this file; AC3a step 0 (a)
//! records whether the program accepts a march onto the own holding tile.

use super::brain::{Inputs, Offer};

pub fn offer(_inp: &Inputs) -> Vec<Offer> {
    Vec::new()
}
