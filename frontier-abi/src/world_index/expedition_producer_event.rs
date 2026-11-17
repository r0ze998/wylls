//! Closed provisional PS2 kind147: mixed Reveal/Gather producer commitments.
//! These operations write only unchained accounts, so the exact tail count is
//! ZERO. Never advance a legacy/wide entity header for this receipt. Kinds145
//! and146 retain their existing semantics. Strict old PS2 readers reject147.
//! Full raw account snapshots, including headers, v1/v2 slot discriminators,
//! original owner, wear, absence, aliases and privileges are committed. Nothing
//! is normalized. Shape/pair commitments are not proof of authorization,
//! producer history, route correctness, source issuance or economic replay.
//! Hashing uses small per-account metadata plus borrowed raw slices, not a copy
//! of the complete account manifest. Account order is an explicit hash fold.

pub use super::expedition_event::AccountSnapshot;
use super::{
    expedition::{AccountFamily, AccountResolver},
    expedition_transport::OwnedBridgeTransit,
    key::{HOST_REF_LEN, PROVINCE_KEY_LEN},
    march::transit_address,
    seal, wide_ix as wix, ProvinceKey, WideHostRef,
};
use crate::{addr::AddrCtx, log};
use alloc::vec::Vec;
use permutation_rules::{frontier::structure::TOWER_WEAR_CAP_BPS, hash::sha256};

pub const KIND: u8 = 147;
pub const VERSION: u8 = 1;
pub const PREFIX: &[u8; 3] = log::PREFIX;
pub const RECEIPT_LEN: usize = 100;
pub const REVEAL_RECORD_LEN: usize = 314;
pub const GATHER_RECORD_LEN: usize = 161;
pub const MAX_RECORD_LEN: usize = REVEAL_RECORD_LEN;
const _: () = assert!(MAX_RECORD_LEN <= 800);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Manifest,
    Command,
    Outcome,
    Receipt,
    Effects,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Action {
    Reveal = 1,
    Gather = 2,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevealIdentity {
    pub host: WideHostRef,
    pub original_owner: [u8; 32],
    pub holding: [u8; 32],
    pub external: [u8; 32],
    pub transit_slot: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Reveal {
        destination: ProvinceKey,
        identity: RevealIdentity,
    },
    Gather {
        destination: ProvinceKey,
    },
}
impl Target {
    pub const fn action(self) -> Action {
        match self {
            Self::Reveal { .. } => Action::Reveal,
            Self::Gather { .. } => Action::Gather,
        }
    }
    pub const fn destination(self) -> ProvinceKey {
        match self {
            Self::Reveal { destination, .. } | Self::Gather { destination } => destination,
        }
    }
    pub fn validate(self, ctx: &AddrCtx) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        if r.family(self.destination()).map_err(|_| Error::Identity)? != AccountFamily::Wide {
            return Err(Error::Identity);
        }
        if let Self::Reveal { identity: i, .. } = self {
            if i.transit_slot >= 4
                || i.original_owner == [0; 32]
                || r.family(i.host.key()).map_err(|_| Error::Identity)? != AccountFamily::Legacy
                || r.holding_address(&i.host).map_err(|_| Error::Identity)? != i.holding
                || transit_address(ctx, &i.holding, i.transit_slot) != i.external
            {
                return Err(Error::Identity);
            }
            r.legacy_host_id(&i.host).map_err(|_| Error::Identity)?;
        }
        Ok(())
    }
    fn bytes(self) -> Vec<u8> {
        let mut b = self.destination().to_bytes().to_vec();
        if let Self::Reveal { identity: i, .. } = self {
            b.extend_from_slice(&i.host.to_bytes());
            b.extend_from_slice(&i.original_owner);
            b.extend_from_slice(&i.holding);
            b.extend_from_slice(&i.external);
            b.push(i.transit_slot);
        }
        b
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub command: &'a [u8],
    pub now_ts: i64,
    pub now_slot: u64,
    pub bell: u32,
    pub season: &'a [u8],
    pub evidence: &'a [u8],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevealOutcomes {
    pub raw_secs: u32,
    pub watched_secs: u32,
    pub travel_secs: u32,
    pub wear_bps: u16,
    pub target_i: u8,
    pub create_slot: bool,
    pub create_day: bool,
    pub write_day: bool,
    pub displaced: bool,
    /// Target minimum rents and actual prefund-adjusted transfers, separately.
    pub rent_slot: u64,
    pub rent_day: u64,
    pub paid_slot: u64,
    pub paid_day: u64,
    pub payer_debit: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GatherOutcomes {
    pub create_inputs: bool,
    pub rent_inputs: u64,
    pub paid_inputs: u64,
    pub payer_debit: u64,
    pub arrivals_mask: u32,
    pub stamped_mask: u32,
    pub n_present: u8,
    pub no_arrivals: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcomes {
    Reveal(RevealOutcomes),
    Gather(GatherOutcomes),
}
impl Outcomes {
    pub const fn action(self) -> Action {
        match self {
            Self::Reveal(_) => Action::Reveal,
            Self::Gather(_) => Action::Gather,
        }
    }
    pub fn encode(self) -> Result<Vec<u8>, Error> {
        let mut b = alloc::vec![VERSION, self.action() as u8];
        match self {
            Self::Reveal(x) => {
                if x.target_i >= 4
                    || x.wear_bps > TOWER_WEAR_CAP_BPS
                    || x.watched_secs > x.raw_secs
                    || x.displaced == x.create_slot
                    || (x.create_day && !x.write_day)
                    || (!x.create_slot && x.paid_slot != 0)
                    || (!x.create_day && x.paid_day != 0)
                    || x.paid_slot.checked_add(x.paid_day) != Some(x.payer_debit)
                {
                    return Err(Error::Outcome);
                }
                for n in [x.raw_secs, x.watched_secs, x.travel_secs] {
                    b.extend_from_slice(&n.to_le_bytes());
                }
                b.extend_from_slice(&x.wear_bps.to_le_bytes());
                b.extend_from_slice(&[
                    x.target_i,
                    x.create_slot as u8,
                    x.create_day as u8,
                    x.write_day as u8,
                    x.displaced as u8,
                ]);
                for n in [
                    x.rent_slot,
                    x.rent_day,
                    x.paid_slot,
                    x.paid_day,
                    x.payer_debit,
                ] {
                    b.extend_from_slice(&n.to_le_bytes());
                }
            }
            Self::Gather(x) => {
                if x.arrivals_mask & !0xffffff != 0
                    || x.stamped_mask & !x.arrivals_mask != 0
                    || x.n_present > 24
                    || (x.no_arrivals && (x.n_present != 0 || x.arrivals_mask != 0xffffff))
                    || (!x.create_inputs && x.paid_inputs != 0)
                    || x.paid_inputs != x.payer_debit
                {
                    return Err(Error::Outcome);
                }
                b.push(x.create_inputs as u8);
                for n in [x.rent_inputs, x.paid_inputs, x.payer_debit] {
                    b.extend_from_slice(&n.to_le_bytes());
                }
                b.extend_from_slice(&x.arrivals_mask.to_le_bytes());
                b.extend_from_slice(&x.stamped_mask.to_le_bytes());
                b.extend_from_slice(&[x.n_present, x.no_arrivals as u8]);
            }
        }
        Ok(b)
    }
}
fn same(a: &AccountSnapshot<'_>, b: &AccountSnapshot<'_>) -> bool {
    a.owner == b.owner && a.present == b.present && a.lamports == b.lamports && a.data == b.data
}
fn validate_manifest(
    ctx: &AddrCtx,
    target: Target,
    c: &Context<'_>,
    a: &[AccountSnapshot<'_>],
) -> Result<(), Error> {
    target.validate(ctx)?;
    let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
    let dest_index = match target {
        Target::Reveal { identity: i, .. } => {
            let cmd = wix::ExpeditionReveal::decode(c.command).map_err(|_| Error::Command)?;
            let plain = seal::unpack(&cmd.plain).map_err(|_| Error::Command)?;
            if !(16..=19).contains(&a.len())
                || cmd.transit_slot != i.transit_slot
                || plain.host != i.host
                || plain.dest != target.destination()
            {
                return Err(Error::Manifest);
            }
            if a[2].address != i.holding || a[3].address != i.external {
                return Err(Error::Identity);
            }
            let b = OwnedBridgeTransit::from_bytes(ctx, a[3].data).map_err(|_| Error::Identity)?;
            if !a[3].present
                || b.slot() != i.transit_slot
                || b.transit().host != i.host
                || b.original_owner() != i.original_owner
                || b.transit().arrive_bell != plain.arrive_bell
            {
                return Err(Error::Identity);
            }
            8
        }
        Target::Gather { .. } => {
            let cmd = wix::ExpeditionGather::decode(c.command).map_err(|_| Error::Command)?;
            if a.len() != 8 + 3 * cmd.n as usize {
                return Err(Error::Manifest);
            }
            2
        }
    };
    if c.season.is_empty()
        || a[1].address != ctx.season
        || a[1].data != c.season
        || a[dest_index].address
            != r.province_address(target.destination())
                .map_err(|_| Error::Identity)?
    {
        return Err(Error::Manifest);
    }
    for (idx, x) in a.iter().enumerate() {
        if x.role as usize != idx + 1 || (!x.present && !x.data.is_empty()) {
            return Err(Error::Manifest);
        }
        for prior in &a[..idx] {
            if prior.address == x.address && !same(prior, x) {
                return Err(Error::Manifest);
            }
        }
    }
    Ok(())
}
fn manifest_digest(a: &[AccountSnapshot<'_>]) -> [u8; 32] {
    let mut head = sha256(&[
        b"PSF-EXPEDITION-PRODUCER-MANIFEST-v1",
        &(a.len() as u64).to_le_bytes(),
    ]);
    for x in a {
        let leaf = sha256(&[
            b"PSF-EXPEDITION-PRODUCER-ACCOUNT-v1",
            &x.role.to_le_bytes(),
            &x.address,
            &x.owner,
            &[x.present as u8, x.signer as u8, x.writable as u8],
            &x.lamports.to_le_bytes(),
            &(x.data.len() as u64).to_le_bytes(),
            x.data,
        ]);
        head = sha256(&[b"PSF-EXPEDITION-PRODUCER-ORDER-v1", &head, &leaf]);
    }
    head
}
fn digest(
    ctx: &AddrCtx,
    target: Target,
    c: &Context<'_>,
    a: &[AccountSnapshot<'_>],
    outcomes: Option<Outcomes>,
) -> Result<[u8; 32], Error> {
    validate_manifest(ctx, target, c, a)?;
    let outcome = if let Some(x) = outcomes {
        if x.action() != target.action() {
            return Err(Error::Outcome);
        }
        x.encode()?
    } else {
        Vec::new()
    };
    let context = sha256(&[
        b"PSF-EXPEDITION-PRODUCER-CONTEXT-v1",
        &ctx.program,
        &ctx.season,
        &[VERSION, target.action() as u8],
        &target.bytes(),
        &c.now_ts.to_le_bytes(),
        &c.now_slot.to_le_bytes(),
        &c.bell.to_le_bytes(),
        &(c.command.len() as u64).to_le_bytes(),
        c.command,
        &(c.season.len() as u64).to_le_bytes(),
        c.season,
        &(c.evidence.len() as u64).to_le_bytes(),
        c.evidence,
    ]);
    let domain: &[u8] = if outcomes.is_some() {
        b"PSF-EXPEDITION-PRODUCER-OUTPUT-v1"
    } else {
        b"PSF-EXPEDITION-PRODUCER-INPUT-v1"
    };
    Ok(sha256(&[
        domain,
        &context,
        &manifest_digest(a),
        &(outcome.len() as u64).to_le_bytes(),
        &outcome,
    ]))
}
pub fn input_digest(
    ctx: &AddrCtx,
    target: Target,
    c: &Context<'_>,
    a: &[AccountSnapshot<'_>],
) -> Result<[u8; 32], Error> {
    digest(ctx, target, c, a, None)
}
pub fn output_digest(
    ctx: &AddrCtx,
    target: Target,
    c: &Context<'_>,
    a: &[AccountSnapshot<'_>],
    outcomes: Outcomes,
) -> Result<[u8; 32], Error> {
    digest(ctx, target, c, a, Some(outcomes))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub action: Action,
    pub operation_id: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn new(action: Action, input: [u8; 32], output: [u8; 32]) -> Self {
        Self {
            action,
            operation_id: sha256(&[
                b"PSF-EXPEDITION-PRODUCER-OP-v1",
                &[VERSION, action as u8],
                &input,
                &output,
            ]),
            input,
            output,
        }
    }
    pub fn encode(self) -> [u8; RECEIPT_LEN] {
        let mut b = [0; RECEIPT_LEN];
        b[0] = VERSION;
        b[1] = self.action as u8;
        b[4..36].copy_from_slice(&self.operation_id);
        b[36..68].copy_from_slice(&self.input);
        b[68..].copy_from_slice(&self.output);
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() != RECEIPT_LEN || b[0] != VERSION || b[2..4] != [0, 0] {
            return Err(Error::Receipt);
        }
        let action = match b[1] {
            1 => Action::Reveal,
            2 => Action::Gather,
            _ => return Err(Error::Receipt),
        };
        let r = Self::new(
            action,
            b[36..68].try_into().unwrap(),
            b[68..100].try_into().unwrap(),
        );
        if r.operation_id != b[4..36] {
            return Err(Error::Receipt);
        }
        Ok(r)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub bell: u32,
    pub target: Target,
    pub receipt: Receipt,
}
impl Record {
    pub fn encode(self, ctx: &AddrCtx) -> Result<Vec<u8>, Error> {
        self.target.validate(ctx)?;
        Receipt::decode(&self.receipt.encode())?;
        if self.receipt.action != self.target.action() {
            return Err(Error::Receipt);
        }
        let mut b = alloc::vec![log::VERSION, KIND];
        b.extend_from_slice(&self.bell.to_le_bytes());
        b.extend_from_slice(&[VERSION, self.target.action() as u8, 0, 0]);
        b.extend_from_slice(&self.target.bytes());
        b.extend_from_slice(&self.receipt.encode());
        b.push(0);
        Ok(b)
    }
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if ![REVEAL_RECORD_LEN, GATHER_RECORD_LEN].contains(&b.len())
            || b[0] != log::VERSION
            || b[1] != KIND
            || b[6] != VERSION
            || b[8..10] != [0, 0]
            || b[b.len() - 1] != 0
        {
            return Err(Error::Shape);
        }
        let destination =
            ProvinceKey::from_bytes(&b[10..10 + PROVINCE_KEY_LEN]).map_err(|_| Error::Identity)?;
        let mut at = 10 + PROVINCE_KEY_LEN;
        let target = match b[7] {
            1 if b.len() == REVEAL_RECORD_LEN => {
                let host = WideHostRef::from_bytes(&b[at..at + HOST_REF_LEN])
                    .map_err(|_| Error::Identity)?;
                at += HOST_REF_LEN;
                let original_owner = b[at..at + 32].try_into().unwrap();
                at += 32;
                let holding = b[at..at + 32].try_into().unwrap();
                at += 32;
                let external = b[at..at + 32].try_into().unwrap();
                at += 32;
                let transit_slot = b[at];
                at += 1;
                Target::Reveal {
                    destination,
                    identity: RevealIdentity {
                        host,
                        original_owner,
                        holding,
                        external,
                        transit_slot,
                    },
                }
            }
            2 if b.len() == GATHER_RECORD_LEN => Target::Gather { destination },
            _ => return Err(Error::Shape),
        };
        let receipt = Receipt::decode(&b[at..at + RECEIPT_LEN])?;
        let r = Self {
            bell: u32::from_le_bytes(b[2..6].try_into().unwrap()),
            target,
            receipt,
        };
        if r.encode(ctx)? != b {
            return Err(Error::Shape);
        }
        Ok(r)
    }
}

/// Full before/after pairing, including readonly aliases and actual transfer
/// deltas. Does not replace authenticated staging or commit atomically itself.
/// Mutability here is a role-set consistency check, not permission: the caller
/// validates writable privileges, program ownership, exact account layouts,
/// route/stance provenance and every staged state transition before calling.
pub fn prepare(
    ctx: &AddrCtx,
    target: Target,
    c: &Context<'_>,
    before: &[AccountSnapshot<'_>],
    after: &[AccountSnapshot<'_>],
    outcomes: Outcomes,
) -> Result<Record, Error> {
    let input = input_digest(ctx, target, c, before)?;
    let output = output_digest(ctx, target, c, after, outcomes)?;
    if before.len() != after.len() {
        return Err(Error::Effects);
    }
    let mut mutable = alloc::vec![0usize];
    let payments: Vec<(usize, u64, u64, bool)>;
    let debit;
    match outcomes {
        Outcomes::Reveal(x) => {
            let cmd = wix::ExpeditionReveal::decode(c.command).map_err(|_| Error::Command)?;
            if x.target_i != cmd.target_i {
                return Err(Error::Outcome);
            }
            mutable.push(10 + x.target_i as usize);
            if x.write_day {
                mutable.push(9);
            }
            payments = alloc::vec![
                (
                    10 + x.target_i as usize,
                    x.rent_slot,
                    x.paid_slot,
                    x.create_slot
                ),
                (9, x.rent_day, x.paid_day, x.create_day)
            ];
            debit = x.payer_debit;
        }
        Outcomes::Gather(x) => {
            let cmd = wix::ExpeditionGather::decode(c.command).map_err(|_| Error::Command)?;
            let scan = ((1u32 << cmd.n) - 1) << cmd.start;
            if x.stamped_mask & !scan != 0 {
                return Err(Error::Outcome);
            }
            mutable.push(4);
            for j in 0..cmd.n as usize {
                if x.stamped_mask & (1 << (cmd.start as usize + j)) != 0 {
                    mutable.push(10 + 3 * j);
                }
            }
            payments = alloc::vec![(4, x.rent_inputs, x.paid_inputs, x.create_inputs)];
            debit = x.payer_debit;
        }
    }
    for (i, (a, b)) in before.iter().zip(after).enumerate() {
        if a.address != b.address
            || a.role != b.role
            || a.signer != b.signer
            || a.writable != b.writable
        {
            return Err(Error::Effects);
        }
        let can_write = mutable.iter().any(|j| before[*j].address == a.address);
        if !can_write && !same(a, b) {
            return Err(Error::Effects);
        }
        if i >= 8
            && target.action() == Action::Gather
            && (i - 8) % 3 == 2
            && (a.owner != b.owner || a.present != b.present || a.lamports != b.lamports)
        {
            return Err(Error::Effects);
        }
    }
    if before[0].lamports.checked_sub(debit) != Some(after[0].lamports)
        || before[0].owner != after[0].owner
        || before[0].present != after[0].present
        || before[0].data != after[0].data
    {
        return Err(Error::Effects);
    }
    for (idx, rent, paid, created) in payments {
        if (created && (before[idx].present || !after[idx].present))
            || (!created
                && (before[idx].owner != after[idx].owner
                    || before[idx].present != after[idx].present))
        {
            return Err(Error::Effects);
        }
        if paid
            != if created {
                rent.saturating_sub(before[idx].lamports)
            } else {
                0
            }
            || before[idx].lamports.checked_add(paid) != Some(after[idx].lamports)
        {
            return Err(Error::Effects);
        }
    }
    Ok(Record {
        bell: c.bell,
        target,
        receipt: Receipt::new(target.action(), input, output),
    })
}
