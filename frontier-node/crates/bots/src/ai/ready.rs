//! Readiness of a host, a private copy of `ready_host` and `can_depart`
//! (`agents/src/policy.rs` 430–453), because they are private there and
//! `agents` is not edited (contract §0.2, §4.3). Test
//! `ai_ready_matches_policy.rs` checks that every host `policy::decide`
//! departs is ready by this copy. When cq-integ's public versions land the
//! integrator may delete this file.

use fclient::abi::layout::entry as le;
use fclient::decode::{Entry, Holding};
use permutation_rules::frontier::host::Stamina;
use permutation_rules::frontier::travel::{march_stamina, MAX_PATH_STEPS};

/// The Scout's unit id (`policy::SCOUT`).
pub const SCOUT: u8 = frontier_agents::policy::SCOUT;

fn in_transit(h: &Holding, id: u64) -> bool {
    h.transit_of(id).is_some()
}

/// A host that can leave now: roster, settled, no pending op, not in
/// transit, not a Scout (unless `scout`).
pub fn ready_host(h: &Holding, e: &Entry, bell: u32, scout: bool) -> bool {
    e.state == le::STATE_ROSTER
        && e.from_bell <= bell
        && e.pend_op == 0
        && e.ready_bell <= bell
        && (e.unit == SCOUT) == scout
        && !in_transit(h, e.id)
}

/// The stamina a Depart charges (the maximum, `march_stamina(MAX_PATH_STEPS)`).
pub fn depart_stamina() -> u16 {
    march_stamina(MAX_PATH_STEPS as u32)
}

/// Stamina of the host at `bell`.
pub fn stamina_at(e: &Entry, bell: u32) -> u16 {
    Stamina {
        value: e.stamina_value,
        bell: e.stamina_bell,
    }
    .at(bell)
}

/// A host that can march now: ready, and with the stamina Depart charges.
pub fn can_depart(h: &Holding, e: &Entry, bell: u32) -> bool {
    ready_host(h, e, bell, false) && stamina_at(e, bell) >= depart_stamina()
}

/// The first bell at which the host could have departed (the later of its
/// roster, ready and stamina bells), for the `idle_bells` fact; `None` for a
/// host that cannot depart for a reason other than time (in transit, a
/// pending op, a scout, not in the roster).
pub fn departable_from(h: &Holding, e: &Entry) -> Option<u32> {
    if e.state != le::STATE_ROSTER || e.pend_op != 0 || e.unit == SCOUT || in_transit(h, e.id) {
        return None;
    }
    let need = depart_stamina();
    let regen = need.saturating_sub(e.stamina_value) as u32;
    Some(e.from_bell.max(e.ready_bell).max(e.stamina_bell + regen))
}

/// Why a combat host cannot march now, in the words of a candidate fact
/// (never shown for a ready host).
pub fn why_not(h: &Holding, e: &Entry, bell: u32) -> Option<&'static str> {
    if e.unit == SCOUT {
        return Some("scout");
    }
    if in_transit(h, e.id) {
        return Some("on the march");
    }
    if e.state != le::STATE_ROSTER {
        return Some("not mustered yet");
    }
    if e.pend_op != 0 {
        return Some("order pending");
    }
    if e.from_bell > bell || e.ready_bell > bell {
        return Some("not ready yet");
    }
    if stamina_at(e, bell) < depart_stamina() {
        return Some("resting");
    }
    None
}
