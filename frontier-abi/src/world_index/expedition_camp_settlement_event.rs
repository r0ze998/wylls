//! Explicit camp-only settlement v2. The member-v1 reader refuses byte 6 = 2.
//! The account contract is exactly the member prefix (14 or 15 roles), followed
//! by one distinct writable original Citizen. This is not an optional suffix
//! accepted by the member instruction. Proof and camp eligibility remain the
//! same-call handler's responsibility; this codec checks the complete effects.
use super::*;
use crate::v2::layout::player::citizen as C;

pub const VERSION: u8 = 2;

fn receipt(input: [u8; 32], output: [u8; 32]) -> Receipt {
    Receipt {
        operation_id: sha256(&[b"PSF-BOUNDARY-CAMP-SETTLEMENT-OP-v2", &input, &output]),
        input,
        output,
    }
}
fn identity(id: Identity) -> Result<(), Error> {
    if id.citizen != Some(id.original_owner)
        || id.changed_home.is_some()
        || id.changed_previous_home.is_some()
    {
        return Err(Error::Identity);
    }
    Ok(())
}

/// Strict 15/16-role camp-v2 contract. Command is `[2, slot, commit, seal]`.
/// Exact original Works delta is bound in both the full output manifest and
/// the v2 outcome commitment. The Citizen cannot alias any prefix role.
pub fn prepare(
    ctx: &AddrCtx,
    id: Identity,
    c: &Context<'_>,
    before: &[AccountSnapshot<'_>],
    after: &[AccountSnapshot<'_>],
    o: Outcomes,
) -> Result<Prepared, Error> {
    id.validate(ctx)?;
    identity(id)?;
    let n = before.len();
    if ![15, 16].contains(&n)
        || after.len() != n
        || c.command.len() != 2 + 32 + super::super::seal::WIDE_SEAL_LEN
        || c.command[0] != VERSION
        || c.command[1] != id.slot
        || o.fate != super::super::arrival::wide_arrival::FATE_STAYS
        || o.credited_milli != 0
    {
        return Err(Error::Manifest);
    }
    let citizen = before[n - 1];
    let next = after[n - 1];
    if citizen.role as usize != n
        || citizen.address != id.original_owner
        || citizen.owner != ctx.program
        || !citizen.present
        || !citizen.writable
        || citizen.data.len() != C::SIZE
        || before[..n - 1].iter().any(|a| a.address == citizen.address)
        || citizen.role != next.role
        || citizen.address != next.address
        || citizen.owner != next.owner
        || citizen.present != next.present
        || citizen.signer != next.signer
        || citizen.writable != next.writable
        || citizen.lamports != next.lamports
    {
        return Err(Error::Manifest);
    }
    let works = u64::from_le_bytes(citizen.data[C::WORKS..C::WORKS + 8].try_into().unwrap());
    let loot = permutation_rules::frontier::camp::loot() as u64;
    let total = works.checked_add(loot).ok_or(Error::Outcome)?;
    let mut expected = citizen.data.to_vec();
    expected[C::WORKS..C::WORKS + 8].copy_from_slice(&total.to_le_bytes());
    if next.data != expected {
        return Err(Error::Effects);
    }
    // Reuse the unchanged member accounting/cleanup validator on the EXACT
    // prefix. Its v1 receipt is discarded, never emitted or used as authority.
    let member = Identity {
        citizen: None,
        ..id
    };
    let member_context = Context {
        command: &c.command[1..],
        ..*c
    };
    super::prepare(
        ctx,
        member,
        &member_context,
        &before[..n - 1],
        &after[..n - 1],
        o,
    )?;
    let targets = id.original_targets(ctx)?;
    let mut chained: Vec<_> = targets.iter().map(|(_, address)| *address).collect();
    chained.push(id.province);
    previous(&citizen, ctx)?;
    previous(&next, ctx)?;
    let mut identity_bytes = Vec::new();
    id.write(&mut identity_bytes);
    identity_bytes[0] = VERSION;
    let context = sha256(&[
        b"PSF-BOUNDARY-CAMP-SETTLEMENT-CONTEXT-v2",
        &ctx.program,
        &ctx.season,
        &identity_bytes,
        &c.now_ts.to_le_bytes(),
        &c.now_slot.to_le_bytes(),
        &c.bell.to_le_bytes(),
        &(n as u64).to_le_bytes(),
        &(c.command.len() as u64).to_le_bytes(),
        c.command,
        &(c.season.len() as u64).to_le_bytes(),
        c.season,
        &(c.evidence.len() as u64).to_le_bytes(),
        c.evidence,
    ]);
    let input = sha256(&[
        b"PSF-BOUNDARY-CAMP-SETTLEMENT-INPUT-v2",
        &context,
        &manifest(before, &[])?,
    ]);
    let output = sha256(&[
        b"PSF-BOUNDARY-CAMP-SETTLEMENT-OUTPUT-v2",
        &context,
        &manifest(after, &chained)?,
        &o.bytes()?,
        &loot.to_le_bytes(),
    ]);
    let r = receipt(input, output);
    let mut original = body_version(false, c.bell, id, r, VERSION);
    let mut original_links = Vec::new();
    for (entity, address) in targets {
        let (seq, head) = previous(find(before, &address)?, ctx)?;
        original_links.push(log::advance(entity, seq, &head, &original).ok_or(Error::Chain)?);
    }
    original.push(original_links.len() as u8);
    for l in &original_links {
        tail(&mut original, l.entity as u8, l.seq, &l.head);
    }
    let mut wide = body_version(true, c.bell, id, r, VERSION);
    let (seq, head) = previous(find(before, &id.province)?, ctx)?;
    let wide_link =
        event::advance(event::WideEntity::Province, seq, &head, &wide).ok_or(Error::Chain)?;
    wide.push(1);
    tail(
        &mut wide,
        wide_link.entity as u8,
        wide_link.seq,
        &wide_link.head,
    );
    Ok(Prepared {
        original,
        original_links,
        wide,
        wide_link,
    })
}

/// Separate reader: neither v1 nor an arbitrary member fate is a camp record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CampRecord {
    pub record: Record,
}
impl CampRecord {
    pub fn decode(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, Error> {
        let record = Record::decode_version(ctx, bytes, VERSION, receipt)?;
        identity(record.identity)?;
        Ok(Self { record })
    }
    pub fn pair(&self, other: &Self) -> Result<(), Error> {
        identity(self.record.identity)?;
        identity(other.record.identity)?;
        self.record.pair(&other.record)
    }
    pub fn verify_previous(
        &self,
        ctx: &AddrCtx,
        original: &[Link],
        wide: Option<event::WideLink>,
    ) -> Result<(), Error> {
        identity(self.record.identity)?;
        self.record
            .verify_previous_version(ctx, original, wide, VERSION, receipt)
    }
}
