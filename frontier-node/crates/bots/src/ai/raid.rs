//! **Stub (AC3a).** The `raid` candidate: another nation's village tile that
//! `policy::shield_refuses` allows at the arrival bell (contract §4.3).
//! AC3b replaces this file; `brain::candidates` calls [`offer`] and an empty
//! answer means "no raid candidate".

use super::brain::{Inputs, Offer};

pub fn offer(_inp: &Inputs) -> Vec<Offer> {
    Vec::new()
}
