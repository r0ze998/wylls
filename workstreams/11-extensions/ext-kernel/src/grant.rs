//! The user's permission (contract §4), pinned to one manifest id. This is
//! a placeholder adapter: workstreams 02/09/10 own the rights, custody and
//! permission contracts, and [`GrantAdapter`] is where theirs replaces it.

use permutation_rules::frontier::holding::RESOURCES;

use crate::error::ExtError;
use crate::exec::Key;
use crate::manifest::ManifestId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub citizen: Key,
    pub manifest_id: ManifestId,
    /// Bit `i` allows entry id `i` (ids 0–7).
    pub entries: u8,
    pub per_call: [i64; RESOURCES],
    /// What the user still allows in total; spending lowers it.
    pub budget: [i64; RESOURCES],
    pub calls_left: u32,
    pub expires_ts: i64,
    pub revoked: bool,
}

/// The seam for the rights contract: decide before the run, consume after.
pub trait GrantAdapter {
    fn authorize(
        &self,
        citizen: &Key,
        id: &ManifestId,
        entry: u8,
        now_ts: i64,
    ) -> Result<(), ExtError>;
    fn check_spend(&self, spent: &[i64; RESOURCES]) -> Result<(), ExtError>;
    fn consume(&mut self, spent: &[i64; RESOURCES]);
}

impl GrantAdapter for Grant {
    fn authorize(
        &self,
        citizen: &Key,
        id: &ManifestId,
        entry: u8,
        now_ts: i64,
    ) -> Result<(), ExtError> {
        if &self.citizen != citizen {
            return Err(ExtError::NoGrant);
        }
        // A grant names one exact manifest: an author's update (a new id)
        // needs a new grant, so its meaning never changes under the user.
        if &self.manifest_id != id {
            return Err(ExtError::GrantVersion);
        }
        if self.revoked {
            return Err(ExtError::GrantRevoked);
        }
        if now_ts >= self.expires_ts {
            return Err(ExtError::GrantExpired);
        }
        if entry >= 8 || self.entries & (1 << entry) == 0 {
            return Err(ExtError::GrantEntry);
        }
        if self.calls_left == 0 {
            return Err(ExtError::GrantCalls);
        }
        Ok(())
    }

    fn check_spend(&self, spent: &[i64; RESOURCES]) -> Result<(), ExtError> {
        if (0..RESOURCES).any(|r| spent[r] > self.per_call[r] || spent[r] > self.budget[r]) {
            return Err(ExtError::GrantCap);
        }
        Ok(())
    }

    fn consume(&mut self, spent: &[i64; RESOURCES]) {
        for (b, s) in self.budget.iter_mut().zip(spent) {
            *b -= s;
        }
        self.calls_left -= 1;
    }
}
