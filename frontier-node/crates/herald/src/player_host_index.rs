//! Derived `/h/me` host rows and ArrivalSlot memberships. Capture address and
//! entry ordinal retain the old full-scan order, including duplicate host IDs.
//! These are read conveniences only, not ownership or freshness attestations.

use std::collections::{BTreeMap, BTreeSet};

use fclient::decode::{Entry, Province};
use frontier_abi::{addr::holding_key_of_host, layout::AccountKind};
use serde_json::{json, Value};

type Address = [u8; 32];
type Position = (Address, usize);

#[derive(Default)]
pub(crate) struct PlayerHostIndex {
    hosts: BTreeMap<u64, BTreeMap<Position, Host>>,
    arrivals: BTreeMap<u64, BTreeSet<Address>>,
    membership: BTreeMap<Address, Membership>,
    #[cfg(test)]
    pub(super) host_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(super) arrival_reads: std::sync::atomic::AtomicUsize,
}

struct Host {
    province: [i16; 2],
    entry: Entry,
}

enum Membership {
    Hosts(Vec<(u64, usize)>),
    Arrival(u64),
}

impl PlayerHostIndex {
    pub(super) fn remove(&mut self, address: &Address) {
        match self.membership.remove(address) {
            Some(Membership::Hosts(entries)) => {
                for (key, ordinal) in entries {
                    if let Some(rows) = self.hosts.get_mut(&key) {
                        rows.remove(&(*address, ordinal));
                        if rows.is_empty() {
                            self.hosts.remove(&key);
                        }
                    }
                }
            }
            Some(Membership::Arrival(tag)) => {
                if let Some(addresses) = self.arrivals.get_mut(&tag) {
                    addresses.remove(address);
                    if addresses.is_empty() {
                        self.arrivals.remove(&tag);
                    }
                }
            }
            None => {}
        }
    }

    pub(super) fn replace(&mut self, address: &Address, data: &[u8]) {
        // Replacement does not call Fold::unindex_account. Remove even when
        // the new bytes have another kind or cannot be decoded.
        self.remove(address);
        match super::kind_of(data) {
            Some(AccountKind::Province) => {
                let Ok(pv) = Province::decode(data) else {
                    return;
                };
                let mut membership = Vec::new();
                for (ordinal, entry) in pv.entries.into_iter().enumerate() {
                    if entry.state == 0 {
                        continue;
                    }
                    let key = holding_key_of_host(entry.id);
                    self.hosts.entry(key).or_default().insert(
                        (*address, ordinal),
                        Host {
                            province: [pv.p, pv.q],
                            entry,
                        },
                    );
                    membership.push((key, ordinal));
                }
                if !membership.is_empty() {
                    self.membership
                        .insert(*address, Membership::Hosts(membership));
                }
            }
            Some(AccountKind::ArrivalSlot) => {
                // Deliberately match the old scan's tag-only acceptance. A
                // truncated slot with bytes 40..48 present was included too.
                if let Some(bytes) = data.get(40..48) {
                    let tag = u64::from_le_bytes(bytes.try_into().expect("eight bytes"));
                    self.arrivals.entry(tag).or_default().insert(*address);
                    self.membership.insert(*address, Membership::Arrival(tag));
                }
            }
            _ => {}
        }
    }

    pub(crate) fn hosts(&self, keys: &[u64]) -> Vec<Value> {
        let mut ordered = BTreeMap::new();
        // Repeated holding references must not duplicate hosts. Seals retain
        // their separate, existing repeated-key behavior in views.rs.
        for key in keys.iter().copied().collect::<BTreeSet<_>>() {
            if let Some(rows) = self.hosts.get(&key) {
                for (position, host) in rows {
                    #[cfg(test)]
                    self.host_reads
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    ordered.insert(*position, host);
                }
            }
        }
        ordered
            .into_values()
            .map(|host| {
                let e = &host.entry;
                json!({
                    "id": e.id.to_string(), "province": host.province, "state": e.state,
                    "faction": e.faction, "unit": e.unit, "tile": e.tile, "troops": e.troops,
                    "readyBell": e.ready_bell, "fromBell": e.from_bell,
                })
            })
            .collect()
    }

    pub(crate) fn arrivals(&self, tag: u64) -> impl Iterator<Item = &Address> {
        self.arrivals.get(&tag).into_iter().flatten().inspect(|_| {
            #[cfg(test)]
            self.arrival_reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        })
    }
}
