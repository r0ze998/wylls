//! The conquest records a replayed bell's step leaves (MC contract §6,
//! §5.7 step 5): CONQUEST when the step emits; at a keep taken, KEEP and
//! (a donor that goes home with a rest) the donor's RETIRE — rebuilt as the
//! program's `emit_conquest` builds them (`permutation-frontier/src/proc/
//! clash.rs`) from the step's output and the Province after the bell, so
//! V15/V18/V19 can compare them with the records the chain logged.
//! Not independent: `conquest_model::conquest_payload` and `read_keep` are
//! the program's shared code.

use frontier_abi::conquest_model as cq;
use frontier_abi::v2::log::{conquest_key, keep_cause, retire_by, CqKind};

/// One record a step leaves: its kind, key and payload (the record's own
/// `bell` is the log bell, the keeper's, not compared).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    /// The step's bell.
    pub bell: u32,
    pub kind: CqKind,
    pub key: Vec<u8>,
    pub payload: Vec<u8>,
}

/// The records of bell `b`'s step `st` over the Province `pd` (after the
/// bell's `finish_bell`) of `(p, q)`.
pub fn of_step(
    pd: &[u8],
    p: i32,
    q: i32,
    b: u32,
    st: &cq::StepOut,
) -> Result<Vec<Expected>, String> {
    let mut v = vec![];
    if !st.emits() {
        return Ok(v);
    }
    let payload = cq::conquest_payload(pd, st)
        .map_err(|e| format!("conquest payload: {e:?}"))?
        .to_bytes();
    v.push(Expected {
        bell: b,
        kind: CqKind::CONQUEST,
        key: conquest_key(p, q, b).to_vec(),
        payload: payload.to_vec(),
    });
    let Some(t) = st.keep_taken else {
        return Ok(v);
    };
    let k = cq::read_keep(pd)
        .map_err(|e| format!("keep: {e:?}"))?
        .ok_or("a keep taken in a Province without a keep")?;
    let mut pl = vec![keep_cause::TAKEN, t.to, t.from];
    pl.extend_from_slice(&t.garrison.to_le_bytes());
    pl.extend_from_slice(&k.consolidated_until_bell.to_le_bytes());
    pl.extend_from_slice(&k.gen.to_le_bytes());
    let mut key = p.to_le_bytes().to_vec();
    key.extend_from_slice(&q.to_le_bytes());
    v.push(Expected {
        bell: b,
        kind: CqKind::KEEP,
        key,
        payload: pl,
    });
    if t.donor_host_id != 0 && !t.donor_removed {
        let mut pl = t.donor_rest.to_le_bytes().to_vec();
        pl.extend_from_slice(&(t.donor_host_id & !0xFFFF_FFFF).to_le_bytes());
        pl.push(retire_by::KEEP_DONOR);
        v.push(Expected {
            bell: b,
            kind: CqKind::RETIRE,
            key: t.donor_host_id.to_le_bytes().to_vec(),
            payload: pl,
        });
    }
    Ok(v)
}
