//! The core side of proposal B, modelled on the host: what the program's
//! extension instructions would check and write (patches/0002 maps each
//! step to an account and an instruction). It owns the registry, the
//! citizens' keys, the Holdings, the grants, the instances and the log of
//! receipts the program would emit.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use permutation_rules::frontier::holding::Holding;

use crate::error::ExtError;
use crate::exec::{run_entry, run_withdraw, Instance, Key, Outcome};
use crate::grant::{Grant, GrantAdapter};
use crate::manifest::{CoreVersion, ManifestId, EFFECT_SET};
use crate::receipt::{Call, Receipt, RECEIPT_VERSION, WITHDRAW};
use crate::registry::{Registry, Status};

/// `Citizen.WALLET`, `SESSION`, `SESSION_EXPIRY` (the prologue's rule:
/// the wallet, or the session key before its expiry).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CitizenKeys {
    pub wallet: Key,
    pub session: Key,
    pub session_expiry: i64,
}

#[derive(Clone, Debug)]
pub struct HoldingAcct {
    pub owner_citizen: Key,
    pub holding: Holding,
}

#[derive(Clone, Debug)]
pub struct Host {
    pub core: CoreVersion,
    pub registry: Registry,
    pub citizens: BTreeMap<Key, CitizenKeys>,
    pub holdings: BTreeMap<Key, HoldingAcct>,
    pub grants: BTreeMap<(Key, ManifestId), Grant>,
    pub instances: BTreeMap<(ManifestId, Key), Instance>,
    /// Instances created per manifest (never lowered: closing an instance
    /// is not modelled, so the cap bounds accounts ever created).
    pub created: BTreeMap<ManifestId, u32>,
    /// What the program would log: each accepted call with its receipt.
    pub log: Vec<(Call, Receipt)>,
}

impl Host {
    pub fn new(core: CoreVersion, operator: Key) -> Host {
        Host {
            core,
            registry: Registry::new(operator),
            citizens: BTreeMap::new(),
            holdings: BTreeMap::new(),
            grants: BTreeMap::new(),
            instances: BTreeMap::new(),
            created: BTreeMap::new(),
            log: Vec::new(),
        }
    }

    fn signer_ok(&self, citizen: &Key, signer: &Key, now_ts: i64) -> Result<(), ExtError> {
        let c = self.citizens.get(citizen).ok_or(ExtError::NotSigned)?;
        if signer == &c.wallet {
            return Ok(());
        }
        if c.session == [0; 32] || signer != &c.session {
            return Err(ExtError::NotSigned);
        }
        if now_ts >= c.session_expiry {
            return Err(ExtError::SessionExpired);
        }
        Ok(())
    }

    fn holding_of(&self, call: &Call) -> Result<&HoldingAcct, ExtError> {
        let h = self.holdings.get(&call.holding).ok_or(ExtError::NotOwner)?;
        if h.owner_citizen != call.citizen {
            return Err(ExtError::NotOwner);
        }
        Ok(h)
    }

    /// The user's own grant, only signed by the user's wallet (a session key
    /// cannot widen what the wallet allowed).
    pub fn set_grant(&mut self, signer: &Key, g: Grant) -> Result<(), ExtError> {
        let c = self.citizens.get(&g.citizen).ok_or(ExtError::NotSigned)?;
        if signer != &c.wallet {
            return Err(ExtError::NotSigned);
        }
        self.grants.insert((g.citizen, g.manifest_id), g);
        Ok(())
    }

    /// A user's grant for `id`; `GrantVersion` when the user granted some
    /// other version of anything but not this one.
    fn grant_for(&self, citizen: &Key, id: &ManifestId) -> Result<&Grant, ExtError> {
        if let Some(g) = self.grants.get(&(*citizen, *id)) {
            return Ok(g);
        }
        // A grant for a version this one supersedes (or that supersedes it).
        let related = |a: &ManifestId, b: &ManifestId| {
            let sup = |x: &ManifestId| self.registry.get(x).and_then(|r| r.supersedes);
            sup(a) == Some(*b) || sup(b) == Some(*a)
        };
        if self
            .grants
            .keys()
            .any(|(c, g)| c == citizen && related(g, id))
        {
            return Err(ExtError::GrantVersion);
        }
        Err(ExtError::NoGrant)
    }

    /// One call (contract §5). Every check comes before any write; the
    /// writes are the outcome's, all together.
    pub fn call(&mut self, call: &Call) -> Result<Receipt, ExtError> {
        let reg = self
            .registry
            .get(&call.manifest_id)
            .ok_or(ExtError::NotRegistered)?;
        match reg.status() {
            Status::Active => {}
            Status::Paused => return Err(ExtError::Paused),
            Status::Revoked => return Err(ExtError::Revoked),
        }
        let m = reg.manifest.clone();
        if m.core != self.core {
            return Err(ExtError::CoreVersion);
        }
        if call.entry == WITHDRAW {
            return Err(ExtError::NoEntry);
        }
        self.signer_ok(&call.citizen, &call.signer, call.now_ts)?;
        let h = self.holding_of(call)?.holding.clone();
        self.grant_for(&call.citizen, &call.manifest_id)?
            .authorize(&call.citizen, &call.manifest_id, call.entry, call.now_ts)?;
        let key = (call.manifest_id, call.citizen);
        let (inst, new) = match self.instances.get(&key) {
            Some(i) => (i.clone(), false),
            None => {
                if *self.created.get(&call.manifest_id).unwrap_or(&0) >= m.max_instances {
                    return Err(ExtError::InstanceCap);
                }
                (Instance::fresh(&m), true)
            }
        };
        if call.seq != inst.seq {
            return Err(ExtError::SeqMismatch);
        }
        let out = run_entry(&m, call.entry, &call.args, call.now_ts, &inst, &h)?;
        self.grants[&(call.citizen, call.manifest_id)].check_spend(&out.spent)?;
        // Commit.
        if let Some(g) = self.grants.get_mut(&(call.citizen, call.manifest_id)) {
            g.consume(&out.spent);
        }
        if new {
            *self.created.entry(call.manifest_id).or_insert(0) += 1;
        }
        Ok(self.commit(call, &inst, out))
    }

    /// The core-defined exit: only while the extension is stopped, only by
    /// the user, the whole escrow back to the user's own Holding.
    pub fn withdraw(&mut self, call: &Call) -> Result<Receipt, ExtError> {
        let reg = self
            .registry
            .get(&call.manifest_id)
            .ok_or(ExtError::NotRegistered)?;
        if reg.status() == Status::Active {
            return Err(ExtError::NotStopped);
        }
        if call.entry != WITHDRAW || !call.args.is_empty() {
            return Err(ExtError::NoEntry);
        }
        self.signer_ok(&call.citizen, &call.signer, call.now_ts)?;
        let h = self.holding_of(call)?.holding.clone();
        let inst = self
            .instances
            .get(&(call.manifest_id, call.citizen))
            .cloned()
            .ok_or(ExtError::EscrowInsufficient)?;
        if call.seq != inst.seq {
            return Err(ExtError::SeqMismatch);
        }
        let out = run_withdraw(call.now_ts, &inst, &h)?;
        Ok(self.commit(call, &inst, out))
    }

    fn commit(&mut self, call: &Call, pre: &Instance, out: Outcome) -> Receipt {
        let id = call.manifest_id;
        let mut post = out.instance;
        let r = Receipt {
            receipt_version: RECEIPT_VERSION,
            effect_set: EFFECT_SET,
            manifest_id: id,
            citizen: call.citizen,
            holding: call.holding,
            entry: call.entry,
            args: call.args.clone(),
            seq: call.seq,
            now_ts: call.now_ts,
            pre_state: pre.state_hash(&id, &call.citizen),
            post_state: post.state_hash(&id, &call.citizen),
            holding_delta: out.holding_delta,
            escrow_delta: out.escrow_delta,
            burned: out.burned,
            events: out.events,
            prev_receipt: pre.last_receipt,
        };
        post.last_receipt = r.id();
        self.instances.insert((id, call.citizen), post);
        if let Some(h) = self.holdings.get_mut(&call.holding) {
            h.holding = out.holding;
        }
        self.log.push((call.clone(), r.clone()));
        r
    }
}
