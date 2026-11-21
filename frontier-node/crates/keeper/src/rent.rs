//! The cluster's rent rate, as the keeper's decisions need it
//! (keeper-rent-floor, D-verify-pr144-1).
//!
//! The program charges every created account `init::rent(size)`: the Rent
//! sysvar's minimum balance. The keeper used to predict those charges
//! from the compile-time `frontier_abi::layout::RENT_PER_BYTE` (5,080
//! lamports/byte). On a cluster at another rate (6,960, the pre-SIMD-0194
//! mainnet rate) the `rings` duty's province-fund floor and its OpenRing
//! readiness were wrong by the ratio of the rates, and the reveal pool's
//! floor `F_r` was priced at the wrong rent.
//!
//! [`RentCache`] reads the Rent sysvar account (`SysvarRent1111…`; the
//! same `getMultipleAccounts` the keeper uses for every other account, so
//! no new RPC method and the same port in tests) at most every
//! [`RENT_REFRESH_SLOTS`]. A failed read keeps the last good value for up
//! to [`RENT_STALE_SLOTS`] after it was read; past that (or before the
//! first good read) [`RentCache::current`] is an error and every rent
//! decision **fails safe**: no on-demand OpenProvince, no OpenRing past
//! the genesis rings, and the keeper raises a `rent-unknown` alert.

use fclient::land::LandRent;
use fclient::ports::ChainPort;
use fclient::rent::{rent_sysvar, sysvar_owner, RentSysvar};

use crate::rings::WIDE_PROVINCE_BYTES;

/// Re-read the Rent sysvar after this many slots (≈ 10 min at 400 ms).
pub const RENT_REFRESH_SLOTS: u64 = 1_500;
/// A cached rate older than this (≈ 1 h) is not used: rent decisions stop.
pub const RENT_STALE_SLOTS: u64 = 9_000;

/// Every rent figure the keeper's land decisions use, from one sysvar read.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeeperRent {
    pub sysvar: RentSysvar,
    pub land: LandRent,
    /// A wide Province (4,864 B, [`WIDE_PROVINCE_BYTES`]).
    pub wide_province: u64,
    /// An ArrivalSlot and an ArrivalDay (the reveal floor `F_r`).
    pub arrival_slot: u64,
    pub arrival_day: u64,
}

impl KeeperRent {
    /// `None` if any figure overflows (an absurd sysvar).
    pub fn from_sysvar(sysvar: RentSysvar) -> Option<KeeperRent> {
        use fclient::abi::size;
        Some(KeeperRent {
            sysvar,
            land: LandRent::from_sysvar(&sysvar)?,
            wide_province: sysvar.minimum_balance(WIDE_PROVINCE_BYTES)?,
            arrival_slot: sysvar.minimum_balance(size::ARRIVAL_SLOT)?,
            arrival_day: sysvar.minimum_balance(size::ARRIVAL_DAY)?,
        })
    }

    /// The SIMD-0194 form `(128 + size) × lamports_per_byte` (tests,
    /// offline examples).
    pub fn at_rate(lamports_per_byte: u64) -> KeeperRent {
        KeeperRent::from_sysvar(RentSysvar {
            lamports_per_byte_year: lamports_per_byte,
            exemption_threshold: 1.0,
            burn_percent: 0,
        })
        .expect("a sane rate")
    }

    /// Lamports per byte as the runtime applies them (rate × threshold;
    /// status and logs).
    pub fn per_byte(&self) -> u64 {
        self.sysvar.minimum_balance(0).map_or(0, |m| m / 128)
    }
}

/// The last good read of the Rent sysvar and when it was made.
#[derive(Clone, Debug, Default)]
pub struct RentCache {
    value: Option<(KeeperRent, u64)>,
    /// Slot of the last read attempt (good or not).
    tried: Option<u64>,
    /// Why the last read failed (`None` after a good one).
    pub last_error: Option<String>,
    /// Good reads so far (status, tests).
    pub reads: u64,
}

impl RentCache {
    /// A cache holding `r`, read at `slot` (tests).
    pub fn with(r: KeeperRent, slot: u64) -> RentCache {
        RentCache {
            value: Some((r, slot)),
            tried: Some(slot),
            last_error: None,
            reads: 1,
        }
    }

    /// Whether a read is due at `slot`.
    pub fn due(&self, slot: u64) -> bool {
        self.tried
            .is_none_or(|t| slot >= t.saturating_add(RENT_REFRESH_SLOTS) || slot < t)
            || (self.value.is_none() && self.tried != Some(slot))
    }

    /// Re-reads the Rent sysvar if due. Never fails the tick: a failed or
    /// garbled read is recorded in `last_error` and the old value kept.
    /// `Some(old, new)` when the rate changed (or was read for the first
    /// time: `old = None`).
    pub async fn refresh<P: ChainPort>(
        &mut self,
        port: &P,
        slot: u64,
    ) -> Option<(Option<KeeperRent>, KeeperRent)> {
        if !self.due(slot) {
            return None;
        }
        self.tried = Some(slot);
        let got = match port.accounts(&[rent_sysvar()], 0).await {
            Ok(v) => v.into_iter().next().flatten(),
            Err(e) => {
                self.last_error = Some(format!("Rent sysvar read failed: {e}"));
                return None;
            }
        };
        let Some(acct) = got else {
            self.last_error = Some("Rent sysvar absent".into());
            return None;
        };
        let parsed = (acct.owner == sysvar_owner())
            .then(|| RentSysvar::decode(&acct.data))
            .flatten()
            .and_then(KeeperRent::from_sysvar);
        let Some(r) = parsed else {
            self.last_error = Some(format!(
                "Rent sysvar unreadable (owner {}, {} bytes)",
                acct.owner,
                acct.data.len()
            ));
            return None;
        };
        self.last_error = None;
        self.reads += 1;
        let old = self.value.map(|v| v.0);
        self.value = Some((r, slot));
        (old != Some(r)).then_some((old, r))
    }

    /// The rate to decide with at `slot`, or why there is none (never
    /// read, or the last good read is older than [`RENT_STALE_SLOTS`]).
    pub fn current(&self, slot: u64) -> Result<KeeperRent, String> {
        match self.value {
            Some((r, at)) if slot.saturating_sub(at) <= RENT_STALE_SLOTS => Ok(r),
            Some((_, at)) => Err(format!(
                "rent rate stale: last read at slot {at} ({} slots ago; {})",
                slot.saturating_sub(at),
                self.last_error.as_deref().unwrap_or("no read since")
            )),
            None => Err(format!(
                "rent rate unknown ({})",
                self.last_error.as_deref().unwrap_or("not read yet")
            )),
        }
    }

    /// The last good read, however old (repricing, not decisions).
    pub fn last(&self) -> Option<KeeperRent> {
        self.value.map(|v| v.0)
    }

    /// `/v1/status`'s `rent` object.
    pub fn status(&self, slot: u64) -> serde_json::Value {
        let (rate, read_slot) = match self.value {
            Some((r, at)) => (Some(r.per_byte()), Some(at)),
            None => (None, None),
        };
        serde_json::json!({
            "lamports_per_byte": rate,
            "read_slot": read_slot,
            "usable": self.current(slot).is_ok(),
            "error": self.last_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakePort;
    use fclient::ports::Account;

    fn rent_account(rate: u64, threshold: f64) -> Account {
        Account {
            lamports: 1_009_200,
            owner: sysvar_owner(),
            data: RentSysvar {
                lamports_per_byte_year: rate,
                exemption_threshold: threshold,
                burn_percent: 0,
            }
            .encode()
            .to_vec(),
            executable: false,
        }
    }

    #[test]
    fn figures_at_5080_and_6960() {
        let a = KeeperRent::at_rate(5_080);
        assert_eq!(a.per_byte(), 5_080);
        assert_eq!(a.land.province_v2, 24_709_120);
        assert_eq!(a.wide_province, (128 + 4_864) * 5_080);
        let b = KeeperRent::at_rate(6_960);
        assert_eq!(b.per_byte(), 6_960);
        assert_eq!(b.land.province_v2, 33_853_440);
        assert_eq!(b.wide_province, (128 + 4_864) * 6_960);
        // The reveal floor's two creates.
        assert_eq!(
            a.arrival_slot,
            fclient::abi::rent(fclient::abi::size::ARRIVAL_SLOT)
        );
        assert_eq!(
            a.arrival_day,
            fclient::abi::rent(fclient::abi::size::ARRIVAL_DAY)
        );
    }

    #[tokio::test]
    async fn reads_caches_refreshes_and_fails_safe() {
        let port = FakePort::default();
        let mut c = RentCache::default();
        // Nothing on chain: unknown, no value, an error.
        assert_eq!(c.refresh(&port, 100).await, None);
        assert!(c.current(100).unwrap_err().contains("absent"));
        // The sysvar appears: read on the next tick (not every slot).
        port.put(rent_sysvar(), rent_account(3_480, 2.0));
        let (old, new) = c.refresh(&port, 101).await.unwrap();
        assert_eq!(old, None);
        assert_eq!(new.per_byte(), 6_960);
        // (the 3,480 × 2.0 sysvar charges what 6,960 × 1.0 does)
        let (got, want) = (c.current(101).unwrap(), KeeperRent::at_rate(6_960));
        assert_eq!(
            (
                got.land,
                got.wide_province,
                got.arrival_slot,
                got.arrival_day
            ),
            (
                want.land,
                want.wide_province,
                want.arrival_slot,
                want.arrival_day
            )
        );
        // Cached: no read until RENT_REFRESH_SLOTS have passed.
        let before = port.reads_of(&rent_sysvar());
        assert_eq!(c.refresh(&port, 102).await, None);
        assert_eq!(c.refresh(&port, 101 + RENT_REFRESH_SLOTS - 1).await, None);
        assert_eq!(port.reads_of(&rent_sysvar()), before);
        // The rate changes: the refresh reports it.
        port.put(rent_sysvar(), rent_account(5_080, 1.0));
        let s = 101 + RENT_REFRESH_SLOTS;
        let (old, new) = c.refresh(&port, s).await.unwrap();
        assert_eq!(old.unwrap().per_byte(), 6_960);
        assert_eq!(new.per_byte(), 5_080);
        // A garbled sysvar keeps the old value while it is fresh ...
        let mut bad = rent_account(5_080, 1.0);
        bad.data.pop();
        port.put(rent_sysvar(), bad);
        let s2 = s + RENT_REFRESH_SLOTS;
        assert_eq!(c.refresh(&port, s2).await, None);
        assert!(c.last_error.as_deref().unwrap().contains("unreadable"));
        assert_eq!(c.current(s2).unwrap().per_byte(), 5_080);
        // ... and stops being used once stale.
        let late = s + RENT_STALE_SLOTS + 1;
        let e = c.current(late).unwrap_err();
        assert!(e.contains("stale"), "{e}");
        assert_eq!(c.status(late)["usable"], false);
        // A sysvar not owned by the sysvar owner is refused.
        let mut forged = rent_account(1, 1.0);
        forged.owner = solana_address::Address::new_from_array([7; 32]);
        port.put(rent_sysvar(), forged);
        let mut fresh = RentCache::default();
        assert_eq!(fresh.refresh(&port, 5).await, None);
        assert!(fresh.current(5).is_err());
    }
}
