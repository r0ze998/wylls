//! Standing orders (contract §3.6): code-held in the mind's ledger,
//! returned in every `/v1/decide` answer, cached by the brain and used
//! unchanged if the mind is unreachable, expiring by bell.
//!
//! - `reserved`: hosts the model chose to keep home (a `hold` choice or a
//!   recall); the Strike-Order follow never moves them before `until_bell`;
//! - `declined_calls`: periods whose Call the AI declined; the autopilot
//!   never follows them;
//! - `caps`: `march_troops_left` and `home_floor` (§4.5 V3), which the
//!   brain also recomputes itself at V6.
//!
//! (v1.1's `avoid` order is deferred, Appendix A.)

use serde_json::Value;

use frontier_agents::policy::Intent;

use super::mindport::id_of;

/// How many bells a `hold` reserves its hosts by default (§3.6).
pub const RESERVE_BELLS: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserved {
    pub host_id: u64,
    pub until_bell: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Standing {
    pub reserved: Vec<Reserved>,
    pub declined_calls: Vec<u32>,
    pub march_troops_left: Option<u32>,
    pub home_floor: Option<u32>,
}

impl Standing {
    /// From the answer's `standing` and `caps` objects (either may be null).
    pub fn from_wire(standing: &Value, caps: &Value) -> Standing {
        let mut s = Standing::default();
        if let Some(a) = standing.get("reserved").and_then(Value::as_array) {
            for r in a {
                if let (Some(h), Some(u)) = (
                    r.get("host_id").and_then(id_of),
                    r.get("until_bell").and_then(Value::as_u64),
                ) {
                    s.reserved.push(Reserved {
                        host_id: h,
                        until_bell: u.min(u32::MAX as u64) as u32,
                    });
                }
            }
        }
        if let Some(a) = standing.get("declined_calls").and_then(Value::as_array) {
            s.declined_calls = a
                .iter()
                .filter_map(Value::as_u64)
                .map(|x| x as u32)
                .collect();
        }
        let n = |k: &str| {
            caps.get(k)
                .and_then(Value::as_u64)
                .map(|x| x.min(u32::MAX as u64) as u32)
        };
        s.march_troops_left = n("march_troops_left");
        s.home_floor = n("home_floor");
        s
    }

    /// Drops orders that ended before `bell`.
    pub fn expire(&mut self, bell: u32) {
        self.reserved.retain(|r| r.until_bell > bell);
    }

    pub fn is_reserved(&self, host_id: u64, bell: u32) -> bool {
        self.reserved
            .iter()
            .any(|r| r.host_id == host_id && r.until_bell > bell)
    }

    pub fn call_declined(&self, period: u32) -> bool {
        self.declined_calls.contains(&period)
    }

    /// Reserves `host_id` until `until_bell` (a later date wins).
    pub fn reserve(&mut self, host_id: u64, until_bell: u32) {
        match self.reserved.iter_mut().find(|r| r.host_id == host_id) {
            Some(r) => r.until_bell = r.until_bell.max(until_bell),
            None => self.reserved.push(Reserved {
                host_id,
                until_bell,
            }),
        }
    }
}

/// The Strike-Order follow filter (§3.6): the follow's Departs of hosts that
/// are reserved, or of a declined Call period, are dropped. Other intents
/// pass. (AC3b feeds `follow` from `follow.rs`; AC3a has none.)
pub fn filter_follow(
    follow: Vec<Intent>,
    st: &Standing,
    bell: u32,
    call_period: Option<u32>,
) -> Vec<Intent> {
    if call_period.is_some_and(|p| st.call_declined(p)) {
        return follow
            .into_iter()
            .filter(|i| !matches!(i, Intent::Depart(_)))
            .collect();
    }
    follow
        .into_iter()
        .filter(|i| match i {
            Intent::Depart(d) => !st.is_reserved(d.host_id, bell),
            _ => true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn standing_parses_strings_and_numbers_and_expires() {
        let s = Standing::from_wire(
            &json!({"reserved": [{"host_id": "1234567890123456789", "until_bell": 410},
                                  {"host_id": 7, "until_bell": 400}],
                    "declined_calls": [3, 5]}),
            &json!({"march_troops_left": 300, "home_floor": null}),
        );
        assert_eq!(s.reserved.len(), 2);
        assert_eq!(s.reserved[0].host_id, 1234567890123456789);
        assert_eq!(s.declined_calls, vec![3, 5]);
        assert_eq!((s.march_troops_left, s.home_floor), (Some(300), None));
        let mut s = s;
        assert!(s.is_reserved(7, 399));
        s.expire(400);
        assert!(!s.is_reserved(7, 400));
        assert!(s.is_reserved(1234567890123456789, 409));
        assert!(s.call_declined(5) && !s.call_declined(4));
        s.reserve(9, 420);
        s.reserve(9, 415);
        assert_eq!(
            s.reserved
                .iter()
                .find(|r| r.host_id == 9)
                .unwrap()
                .until_bell,
            420
        );
    }

    #[test]
    fn null_standing_is_empty() {
        assert_eq!(
            Standing::from_wire(&Value::Null, &Value::Null),
            Standing::default()
        );
    }
}
