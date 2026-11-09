//! Provisional paired member settlement. No dispatch, economic rule or authority.
//! PS2/148 and PSW1/25 are intentionally decoded only by this bounded codec.
//! Original links can repeat Holding for the distinct PREV_HOME address;
//! their identity/order is fixed here, never inferred from an entity byte.
pub use super::expedition_event::AccountSnapshot;
use super::{
    event,
    expedition::{AccountFamily, AccountResolver},
    key::{HOST_REF_LEN, PROVINCE_KEY_LEN},
    march::transit_address,
    ProvinceKey, WideHostRef,
};
use crate::{
    addr::AddrCtx,
    layout::header,
    log::{self, EntityKind, Link},
};
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

pub const ORIGINAL_KIND: u8 = 148;
pub const WIDE_KIND: u8 = 25;
pub const VERSION: u8 = 1;
pub const BODY_LEN: usize = 454;
pub const MAX_RECORD_LEN: usize = BODY_LEN + 1 + 4 * log::LINK_LEN;
const _: () = assert!(MAX_RECORD_LEN <= 800);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Manifest,
    Effects,
    Outcome,
    Chain,
    Receipt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub host: WideHostRef,
    pub slot: u8,
    /// Immutable original Citizen account address, not its wallet key.
    pub original_owner: [u8; 32],
    pub holding: [u8; 32],
    pub external: [u8; 32],
    pub destination: ProvinceKey,
    pub province: [u8; 32],
    pub changed_home: Option<ProvinceKey>,
    pub changed_previous_home: Option<[u8; 32]>,
    pub citizen: Option<[u8; 32]>,
}
impl Identity {
    pub fn validate(self, ctx: &AddrCtx) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
        if self.slot >= 4
            || self.original_owner == [0; 32]
            || r.family(self.host.key()).map_err(|_| Error::Identity)? != AccountFamily::Legacy
            || r.family(self.destination).map_err(|_| Error::Identity)? != AccountFamily::Wide
            || r.holding_address(&self.host).map_err(|_| Error::Identity)? != self.holding
            || transit_address(ctx, &self.holding, self.slot) != self.external
            || r.province_address(self.destination)
                .map_err(|_| Error::Identity)?
                != self.province
            || (self.changed_home.is_some() && self.changed_previous_home.is_some())
            || self.changed_previous_home == Some(self.holding)
        {
            return Err(Error::Identity);
        }
        r.legacy_host_id(&self.host).map_err(|_| Error::Identity)?;
        if let Some(k) = self.changed_home {
            if k != self.host.key() {
                return Err(Error::Identity);
            }
        }
        if let Some(c) = self.citizen {
            if c != self.original_owner {
                return Err(Error::Identity);
            }
        }
        let mut addresses = alloc::vec![self.holding, self.external, self.province];
        for (_, a) in self.original_targets(ctx)?.into_iter().skip(1) {
            addresses.push(a);
        }
        for (i, a) in addresses.iter().enumerate() {
            if *a == [0; 32] || addresses[..i].contains(a) {
                return Err(Error::Identity);
            }
        }
        Ok(())
    }
    /// Stable tail order; a second Holding means PREV_HOME, not the issuer.
    pub fn original_targets(self, ctx: &AddrCtx) -> Result<Vec<(EntityKind, [u8; 32])>, Error> {
        let mut v = alloc::vec![(EntityKind::Holding, self.holding)];
        if let Some(k) = self.changed_home {
            let r = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
            v.push((
                EntityKind::Province,
                r.province_address(k).map_err(|_| Error::Identity)?,
            ));
        }
        if let Some(a) = self.changed_previous_home {
            v.push((EntityKind::Holding, a));
        }
        if let Some(a) = self.citizen {
            v.push((EntityKind::Citizen, a));
        }
        Ok(v)
    }
    fn write(self, b: &mut Vec<u8>) {
        b.extend_from_slice(&[
            VERSION,
            self.changed_home.is_some() as u8
                | ((self.changed_previous_home.is_some() as u8) << 1)
                | ((self.citizen.is_some() as u8) << 2),
            self.slot,
            0,
        ]);
        b.extend_from_slice(&self.host.to_bytes());
        for a in [self.original_owner, self.holding, self.external] {
            b.extend_from_slice(&a);
        }
        b.extend_from_slice(&self.destination.to_bytes());
        b.extend_from_slice(&self.province);
        b.extend_from_slice(
            &self
                .changed_home
                .map(|k| k.to_bytes())
                .unwrap_or([0; PROVINCE_KEY_LEN]),
        );
        b.extend_from_slice(&self.changed_previous_home.unwrap_or([0; 32]));
        b.extend_from_slice(&self.citizen.unwrap_or([0; 32]));
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
pub struct Payment {
    pub recipient: [u8; 32],
    pub amount: u64,
    pub diverted: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcomes {
    pub fate: u8,
    pub credited_milli: u32,
    /// Sequential tip, fee, bond, including zero-valued legs.
    pub payments: [Payment; 3],
    pub pool_owed: u64,
    pub bridge_rent: u64,
    pub slot_rent: u64,
    pub slot_rent_to: [u8; 32],
    pub slot_retained: bool,
}
impl Outcomes {
    fn bytes(self) -> Result<Vec<u8>, Error> {
        if !(1..=5).contains(&self.fate) {
            return Err(Error::Outcome);
        }
        let mut b = alloc::vec![VERSION, self.fate, self.slot_retained as u8];
        b.extend_from_slice(&self.credited_milli.to_le_bytes());
        let mut diverted = 0u64;
        for p in self.payments {
            if p.diverted {
                diverted = diverted.checked_add(p.amount).ok_or(Error::Outcome)?;
            }
            b.extend_from_slice(&p.recipient);
            b.extend_from_slice(&p.amount.to_le_bytes());
            b.push(p.diverted as u8);
        }
        if diverted != self.pool_owed
            || (self.slot_retained && (self.slot_rent != 0 || self.slot_rent_to != [0; 32]))
        {
            return Err(Error::Outcome);
        }
        for n in [self.pool_owed, self.bridge_rent, self.slot_rent] {
            b.extend_from_slice(&n.to_le_bytes());
        }
        b.extend_from_slice(&self.slot_rent_to);
        Ok(b)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub operation_id: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn new(input: [u8; 32], output: [u8; 32]) -> Self {
        Self {
            operation_id: sha256(&[b"PSF-BOUNDARY-SETTLEMENT-OP-v1", &input, &output]),
            input,
            output,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    pub original: Vec<u8>,
    pub original_links: Vec<Link>,
    pub wide: Vec<u8>,
    pub wide_link: event::WideLink,
}

fn same(a: &AccountSnapshot<'_>, b: &AccountSnapshot<'_>) -> bool {
    a.owner == b.owner && a.present == b.present && a.lamports == b.lamports && a.data == b.data
}
fn manifest(a: &[AccountSnapshot<'_>], normalized: &[[u8; 32]]) -> Result<[u8; 32], Error> {
    let mut h = sha256(&[
        b"PSF-BOUNDARY-SETTLEMENT-MANIFEST-v1",
        &(a.len() as u64).to_le_bytes(),
    ]);
    for (i, x) in a.iter().enumerate() {
        if x.role as usize != i + 1 || (!x.present && !x.data.is_empty()) {
            return Err(Error::Manifest);
        }
        for p in &a[..i] {
            if p.address == x.address && !same(p, x) {
                return Err(Error::Manifest);
            }
        }
        let norm;
        let data = if normalized.contains(&x.address) {
            if !x.present || x.data.len() < header::EVENT_HEAD + 32 {
                return Err(Error::Manifest);
            }
            norm = event::normalize_chained(x.data);
            &norm[..]
        } else {
            x.data
        };
        let leaf = sha256(&[
            b"PSF-BOUNDARY-SETTLEMENT-ACCOUNT-v1",
            &x.role.to_le_bytes(),
            &x.address,
            &x.owner,
            &[x.present as u8, x.signer as u8, x.writable as u8],
            &x.lamports.to_le_bytes(),
            &(data.len() as u64).to_le_bytes(),
            data,
        ]);
        h = sha256(&[b"PSF-BOUNDARY-SETTLEMENT-ORDER-v1", &h, &leaf]);
    }
    Ok(h)
}
fn find<'a, 'b>(
    a: &'a [AccountSnapshot<'b>],
    address: &[u8; 32],
) -> Result<&'a AccountSnapshot<'b>, Error> {
    a.iter()
        .find(|x| &x.address == address)
        .ok_or(Error::Manifest)
}
fn previous(a: &AccountSnapshot<'_>, ctx: &AddrCtx) -> Result<(u64, [u8; 32]), Error> {
    if !a.present || a.owner != ctx.program || !a.writable || a.data.len() < 64 {
        return Err(Error::Chain);
    }
    Ok((
        u64::from_le_bytes(a.data[24..32].try_into().unwrap()),
        a.data[32..64].try_into().unwrap(),
    ))
}
fn body(wide: bool, bell: u32, id: Identity, r: Receipt) -> Vec<u8> {
    let mut b = alloc::vec![
        if wide {
            event::WIDE_EVENT_VERSION
        } else {
            log::VERSION
        },
        if wide { WIDE_KIND } else { ORIGINAL_KIND }
    ];
    b.extend_from_slice(&bell.to_le_bytes());
    id.write(&mut b);
    for d in [r.operation_id, r.input, r.output] {
        b.extend_from_slice(&d);
    }
    b
}
fn tail(b: &mut Vec<u8>, entity: u8, seq: u64, head: &[u8; 32]) {
    b.push(entity);
    b.extend_from_slice(&seq.to_le_bytes());
    b.extend_from_slice(head);
}

/// Complete private member-settlement account order, 14/15 accounts. Does not
/// validate seals, history, owner authorization or rules: caller must do so in
/// the same invocation. After snapshots are staged BEFORE event header writes.
pub fn prepare(
    ctx: &AddrCtx,
    id: Identity,
    c: &Context<'_>,
    before: &[AccountSnapshot<'_>],
    after: &[AccountSnapshot<'_>],
    o: Outcomes,
) -> Result<Prepared, Error> {
    id.validate(ctx)?;
    let n = before.len();
    if ![14, 15].contains(&n)
        || after.len() != n
        || id.citizen.is_some()
        || c.command.len() != 1 + 32 + super::seal::WIDE_SEAL_LEN
        || c.command[0] != id.slot
        || c.season.is_empty()
        || before[0].address != ctx.season
        || before[0].data != c.season
        || before[1].address != id.holding
        || before[2].address != id.external
        || before[4].address != id.province
        || !before[n - 5].signer
    {
        return Err(Error::Manifest);
    }
    let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::Identity)?;
    if before[3].address
        != resolver
            .province_address(id.host.key())
            .map_err(|_| Error::Identity)?
        || id
            .changed_previous_home
            .map(|k| n != 15 || before[8].address != k)
            .unwrap_or(false)
    {
        return Err(Error::Manifest);
    }
    let targets = id.original_targets(ctx)?;
    let mut chained: Vec<[u8; 32]> = targets.iter().map(|(_, a)| *a).collect();
    chained.push(id.province);
    let mut allowed = alloc::vec![
        id.holding,
        id.external,
        id.province,
        before[5].address,
        before[6].address
    ];
    allowed.extend_from_slice(&chained);
    for (a, b) in before.iter().zip(after) {
        if a.role != b.role
            || a.address != b.address
            || a.signer != b.signer
            || a.writable != b.writable
        {
            return Err(Error::Effects);
        }
        if !same(a, b) && !a.writable {
            return Err(Error::Effects);
        }
        if !allowed.contains(&a.address)
            && (a.owner != b.owner || a.present != b.present || a.data != b.data)
        {
            return Err(Error::Effects);
        }
        if chained.contains(&a.address) {
            previous(a, ctx)?;
            previous(b, ctx)?;
            if a.data[24..64] != b.data[24..64] {
                return Err(Error::Chain);
            }
        }
    }
    for (_, address) in targets.iter().skip(1) {
        if find(before, address)?.data == find(after, address)?.data {
            return Err(Error::Effects);
        }
    }
    let outcome = o.bytes()?;
    // Check every distinct lamport balance, including repeated payment aliases.
    for (i, a) in before.iter().enumerate() {
        if before[..i].iter().any(|p| p.address == a.address) {
            continue;
        }
        let mut delta = 0i128;
        for p in o.payments {
            find(before, &p.recipient)?;
            // A diverted leg retains its intended recipient; no lamports leave
            // the issuer. POOL_OWED records the liability in original data.
            if !p.diverted {
                if a.address == id.holding {
                    delta -= p.amount as i128;
                }
                if a.address == p.recipient {
                    delta += p.amount as i128;
                }
            }
        }
        for (source, to, amount) in [
            (id.external, before[7].address, o.bridge_rent),
            (before[6].address, o.slot_rent_to, o.slot_rent),
        ] {
            if amount != 0 {
                find(before, &to)?;
                if source == to {
                    return Err(Error::Outcome);
                }
            }
            if a.address == source {
                delta -= amount as i128;
            }
            if a.address == to {
                delta += amount as i128;
            }
        }
        if after[i].lamports as i128 - a.lamports as i128 != delta {
            return Err(Error::Effects);
        }
    }
    if o.bridge_rent != before[2].lamports
        || after[2].present
        || !after[2].data.is_empty()
        || after[2].lamports != 0
        || after[2].owner != [0; 32]
    {
        return Err(Error::Effects);
    }
    if o.slot_retained {
        if !before[6].present
            || !after[6].present
            || before[6].owner != after[6].owner
            || before[6].lamports != after[6].lamports
        {
            return Err(Error::Effects);
        }
    } else if before[6].present {
        if o.slot_rent != before[6].lamports
            || o.slot_rent_to == [0; 32]
            || after[6].present
            || !after[6].data.is_empty()
            || after[6].lamports != 0
            || after[6].owner != [0; 32]
        {
            return Err(Error::Effects);
        }
    } else if o.slot_rent != 0 || o.slot_rent_to != [0; 32] || !same(&before[6], &after[6]) {
        return Err(Error::Effects);
    }
    let mut identity = Vec::new();
    id.write(&mut identity);
    let context = sha256(&[
        b"PSF-BOUNDARY-SETTLEMENT-CONTEXT-v1",
        &ctx.program,
        &ctx.season,
        &identity,
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
    let input = sha256(&[
        b"PSF-BOUNDARY-SETTLEMENT-INPUT-v1",
        &context,
        &manifest(before, &[])?,
    ]);
    let output = sha256(&[
        b"PSF-BOUNDARY-SETTLEMENT-OUTPUT-v1",
        &context,
        &manifest(after, &chained)?,
        &outcome,
    ]);
    let r = Receipt::new(input, output);
    let mut original = body(false, c.bell, id, r);
    let mut original_links = Vec::new();
    for (entity, address) in targets {
        let (seq, head) = previous(find(before, &address)?, ctx)?;
        original_links.push(log::advance(entity, seq, &head, &original).ok_or(Error::Chain)?);
    }
    original.push(original_links.len() as u8);
    for l in &original_links {
        tail(&mut original, l.entity as u8, l.seq, &l.head);
    }
    let mut wide = body(true, c.bell, id, r);
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (AddrCtx, Identity) {
        let ctx = AddrCtx {
            program: [4; 32],
            season: [3; 32],
        };
        let r = AccountResolver::for_season(&ctx).unwrap();
        let adapter = super::super::legacy::LegacyAdapter::for_season(&ctx).unwrap();
        let host = adapter
            .host_ref(crate::addr::host_id(1, 0, 1, 2, 3).unwrap())
            .unwrap();
        let destination = ProvinceKey::new(
            adapter.world(),
            super::super::WideCoord::checked(129, 0).unwrap(),
        );
        let holding = r.holding_address(&host).unwrap();
        let id = Identity {
            host,
            slot: 0,
            original_owner: [7; 32],
            holding,
            external: transit_address(&ctx, &holding, 0),
            destination,
            province: r.province_address(destination).unwrap(),
            changed_home: Some(host.key()),
            changed_previous_home: None,
            citizen: None,
        };
        (ctx, id)
    }
    fn record(wide: bool, ctx: &AddrCtx, id: Identity) -> Vec<u8> {
        let mut b = body(wide, 9, id, Receipt::new([1; 32], [2; 32]));
        assert_eq!(b.len(), BODY_LEN);
        if wide {
            let l = event::advance(event::WideEntity::Province, 0, &[0; 32], &b).unwrap();
            b.push(1);
            tail(&mut b, l.entity as u8, l.seq, &l.head);
        } else {
            let ls: Vec<_> = id
                .original_targets(ctx)
                .unwrap()
                .iter()
                .map(|(e, _)| log::advance(*e, 0, &[0; 32], &b).unwrap())
                .collect();
            b.push(ls.len() as u8);
            for l in ls {
                tail(&mut b, l.entity as u8, l.seq, &l.head);
            }
        }
        b
    }
    #[test]
    fn paired_roundtrip_and_original_vs_wide_chains() {
        let (ctx, id) = fixture();
        let a = Record::decode(&ctx, &record(false, &ctx, id)).unwrap();
        let b = Record::decode(&ctx, &record(true, &ctx, id)).unwrap();
        a.pair(&b).unwrap();
        let ps: Vec<_> = id
            .original_targets(&ctx)
            .unwrap()
            .iter()
            .map(|(e, _)| Link {
                entity: *e,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        a.verify_previous(&ctx, &ps, None).unwrap();
        b.verify_previous(
            &ctx,
            &[],
            Some(event::WideLink {
                entity: event::WideEntity::Province,
                seq: 0,
                head: [0; 32],
            }),
        )
        .unwrap();
        assert!(a.pair(&a).is_err());
        let mut bad = b.clone();
        bad.bell += 1;
        assert!(a.pair(&bad).is_err());
    }
    #[test]
    fn strict_truncation_trailing_reserved_and_receipt_mutation() {
        let (ctx, id) = fixture();
        let a = record(false, &ctx, id);
        for n in 0..a.len() {
            assert!(Record::decode(&ctx, &a[..n]).is_err());
        }
        let mut bad = a.clone();
        bad.push(0);
        assert!(Record::decode(&ctx, &bad).is_err());
        for i in [6, 7, 9, 358, 390, 422, BODY_LEN] {
            let mut bad = a.clone();
            bad[i] ^= 128;
            assert!(Record::decode(&ctx, &bad).is_err());
        }
    }
    #[test]
    fn distinct_previous_holding_and_optional_citizen_attribution() {
        let (ctx, mut id) = fixture();
        id.changed_home = None;
        id.changed_previous_home = Some([8; 32]);
        id.citizen = Some(id.original_owner);
        let a = Record::decode(&ctx, &record(false, &ctx, id)).unwrap();
        assert_eq!(
            a.original_links
                .iter()
                .map(|l| l.entity)
                .collect::<Vec<_>>(),
            alloc::vec![
                EntityKind::Holding,
                EntityKind::Holding,
                EntityKind::Citizen
            ]
        );
        id.changed_previous_home = Some(id.holding);
        assert_eq!(id.validate(&ctx), Err(Error::Identity));
        id.changed_previous_home = Some([8; 32]);
        id.citizen = Some(ctx.citizen(&id.original_owner));
        assert_eq!(id.validate(&ctx), Err(Error::Identity));
        id.original_owner = id.holding;
        id.citizen = Some(id.holding);
        assert_eq!(id.validate(&ctx), Err(Error::Identity));
        assert_eq!(
            Record::decode(&ctx, &record(false, &ctx, id)),
            Err(Error::Identity)
        );
    }
    #[test]
    fn manifest_keeps_order_aliases_presence_privileges_and_raw_input_headers() {
        let data = alloc::vec![0;80];
        let mut next = data.clone();
        next[24] = 1;
        let a = AccountSnapshot {
            role: 1,
            address: [1; 32],
            owner: [2; 32],
            present: true,
            signer: false,
            writable: true,
            lamports: 9,
            data: &data,
        };
        let b = AccountSnapshot { data: &next, ..a };
        assert_ne!(manifest(&[a], &[]).unwrap(), manifest(&[b], &[]).unwrap());
        assert_eq!(
            manifest(&[a], &[a.address]).unwrap(),
            manifest(&[b], &[a.address]).unwrap()
        );
        assert_ne!(
            manifest(&[a], &[]).unwrap(),
            manifest(&[AccountSnapshot { signer: true, ..a }], &[]).unwrap()
        );
        assert!(manifest(
            &[
                a,
                AccountSnapshot {
                    role: 2,
                    data: &next,
                    ..a
                }
            ],
            &[]
        )
        .is_err());
        assert!(manifest(
            &[AccountSnapshot {
                present: false,
                ..a
            }],
            &[]
        )
        .is_err());
    }
    #[test]
    fn wrong_tail_entity_zero_sequence_and_chain_corruption_refuse() {
        let (ctx, id) = fixture();
        let a = record(true, &ctx, id);
        let mut bad = a.clone();
        bad[BODY_LEN + 1] = event::WideEntity::Holding as u8;
        assert!(Record::decode(&ctx, &bad).is_err());
        let mut bad = a.clone();
        bad[BODY_LEN + 2..BODY_LEN + 10].fill(0);
        assert!(Record::decode(&ctx, &bad).is_err());
        let mut bad = a;
        bad[BODY_LEN + 10] ^= 1;
        let r = Record::decode(&ctx, &bad).unwrap();
        assert!(r
            .verify_previous(
                &ctx,
                &[],
                Some(event::WideLink {
                    entity: event::WideEntity::Province,
                    seq: 0,
                    head: [0; 32]
                })
            )
            .is_err());
    }
    #[test]
    fn payment_diversion_is_exact_and_retention_has_no_refund() {
        let p = Payment {
            recipient: [1; 32],
            amount: 3,
            diverted: true,
        };
        let mut o = Outcomes {
            fate: 1,
            credited_milli: 0,
            payments: [p; 3],
            pool_owed: 9,
            bridge_rent: 5,
            slot_rent: 0,
            slot_rent_to: [0; 32],
            slot_retained: true,
        };
        assert!(o.bytes().is_ok());
        o.pool_owed = 8;
        assert!(o.bytes().is_err());
        o.pool_owed = 9;
        o.slot_rent = 1;
        assert!(o.bytes().is_err());
    }
    #[test]
    fn complete_prepare_and_manifest_effect_refusals() {
        let (ctx, id) = fixture();
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        let mut addresses: Vec<[u8; 32]> = (20..34).map(|i| [i; 32]).collect();
        addresses[0] = ctx.season;
        addresses[1] = id.holding;
        addresses[2] = id.external;
        addresses[3] = resolver.province_address(id.host.key()).unwrap();
        addresses[4] = id.province;
        let raw = alloc::vec![alloc::vec![1;80];14];
        let mut staged = raw.clone();
        staged[2].clear();
        staged[3][70] ^= 1;
        let mut before: Vec<_> = (0..14)
            .map(|i| AccountSnapshot {
                role: (i + 1) as u16,
                address: addresses[i],
                owner: ctx.program,
                present: true,
                signer: i == 9,
                writable: true,
                lamports: 100,
                data: &raw[i],
            })
            .collect();
        let mut after: Vec<_> = (0..14)
            .map(|i| AccountSnapshot {
                data: &staged[i],
                ..before[i]
            })
            .collect();
        after[2].present = false;
        after[2].owner = [0; 32];
        after[2].lamports = 0;
        after[7].lamports = 200;
        let command = alloc::vec![0;1+32+super::super::seal::WIDE_SEAL_LEN];
        let c = Context {
            command: &command,
            now_ts: 2,
            now_slot: 3,
            bell: 9,
            season: &raw[0],
            evidence: &[],
        };
        let p = Payment {
            recipient: addresses[10],
            amount: 0,
            diverted: false,
        };
        let o = Outcomes {
            fate: 1,
            credited_milli: 0,
            payments: [p; 3],
            pool_owed: 0,
            bridge_rent: 100,
            slot_rent: 0,
            slot_rent_to: [0; 32],
            slot_retained: true,
        };
        let prepared = prepare(&ctx, id, &c, &before, &after, o).unwrap();
        Record::decode(&ctx, &prepared.original)
            .unwrap()
            .pair(&Record::decode(&ctx, &prepared.wide).unwrap())
            .unwrap();
        after[7].lamports -= 1;
        assert_eq!(
            prepare(&ctx, id, &c, &before, &after, o),
            Err(Error::Effects)
        );
        after[7].lamports += 1;
        before[9].signer = false;
        after[9].signer = false;
        assert_eq!(
            prepare(&ctx, id, &c, &before, &after, o),
            Err(Error::Manifest)
        );
    }
    #[test]
    fn public_record_cannot_bypass_identity_receipt_or_side_shape() {
        let (ctx, id) = fixture();
        let a = Record::decode(&ctx, &record(false, &ctx, id)).unwrap();
        let b = Record::decode(&ctx, &record(true, &ctx, id)).unwrap();
        let ps: Vec<_> = id
            .original_targets(&ctx)
            .unwrap()
            .iter()
            .map(|(e, _)| Link {
                entity: *e,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        let wp = event::WideLink {
            entity: event::WideEntity::Province,
            seq: 0,
            head: [0; 32],
        };
        let mut bad = a.clone();
        bad.original_links.clear();
        assert_eq!(bad.verify_previous(&ctx, &[], None), Err(Error::Chain));
        let mut bad = a.clone();
        bad.original_links[0].entity = EntityKind::Citizen;
        assert_eq!(bad.verify_previous(&ctx, &ps, None), Err(Error::Chain));
        let mut bad = b.clone();
        bad.original_links = a.original_links.clone();
        assert_eq!(bad.verify_previous(&ctx, &[], Some(wp)), Err(Error::Chain));
        let mut bad = b.clone();
        bad.wide_link.as_mut().unwrap().entity = event::WideEntity::Holding;
        assert_eq!(bad.verify_previous(&ctx, &[], Some(wp)), Err(Error::Chain));
        let wrong = AddrCtx {
            program: [99; 32],
            ..ctx
        };
        assert_eq!(a.verify_previous(&wrong, &ps, None), Err(Error::Identity));
        assert_eq!(
            b.verify_previous(&wrong, &[], Some(wp)),
            Err(Error::Identity)
        );
        let mut bad = a;
        bad.receipt.operation_id[0] ^= 1;
        assert_eq!(bad.verify_previous(&ctx, &ps, None), Err(Error::Receipt));
        let mut bad = b;
        bad.receipt.input[0] ^= 1;
        assert_eq!(
            bad.verify_previous(&ctx, &[], Some(wp)),
            Err(Error::Receipt)
        );
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub bell: u32,
    pub identity: Identity,
    pub receipt: Receipt,
    pub original_links: Vec<Link>,
    pub wide_link: Option<event::WideLink>,
}
impl Record {
    pub fn decode(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() < BODY_LEN + 1
            || b.len() > MAX_RECORD_LEN
            || b[6] != VERSION
            || b[7] & !7 != 0
            || b[9] != 0
        {
            return Err(Error::Shape);
        }
        let wide = match (b[0], b[1]) {
            (log::VERSION, ORIGINAL_KIND) => false,
            (event::WIDE_EVENT_VERSION, WIDE_KIND) => true,
            _ => return Err(Error::Shape),
        };
        let mut at = 10;
        fn take<const N: usize>(b: &[u8], at: &mut usize) -> [u8; N] {
            let x = b[*at..*at + N].try_into().unwrap();
            *at += N;
            x
        }
        let host = WideHostRef::from_bytes(&take::<HOST_REF_LEN>(b, &mut at))
            .map_err(|_| Error::Identity)?;
        let original_owner = take(b, &mut at);
        let holding = take(b, &mut at);
        let external = take(b, &mut at);
        let destination = ProvinceKey::from_bytes(&take::<PROVINCE_KEY_LEN>(b, &mut at))
            .map_err(|_| Error::Identity)?;
        let province = take(b, &mut at);
        let home = take::<PROVINCE_KEY_LEN>(b, &mut at);
        let prev = take(b, &mut at);
        let citizen = take(b, &mut at);
        let id = Identity {
            host,
            slot: b[8],
            original_owner,
            holding,
            external,
            destination,
            province,
            changed_home: if b[7] & 1 != 0 {
                Some(ProvinceKey::from_bytes(&home).map_err(|_| Error::Identity)?)
            } else {
                if home != [0; PROVINCE_KEY_LEN] {
                    return Err(Error::Shape);
                }
                None
            },
            changed_previous_home: if b[7] & 2 != 0 {
                Some(prev)
            } else {
                if prev != [0; 32] {
                    return Err(Error::Shape);
                }
                None
            },
            citizen: if b[7] & 4 != 0 {
                Some(citizen)
            } else {
                if citizen != [0; 32] {
                    return Err(Error::Shape);
                }
                None
            },
        };
        id.validate(ctx)?;
        let operation_id = take(b, &mut at);
        let input = take(b, &mut at);
        let output = take(b, &mut at);
        let receipt = Receipt::new(input, output);
        if operation_id != receipt.operation_id {
            return Err(Error::Receipt);
        }
        let targets = id.original_targets(ctx)?;
        let count = if wide { 1 } else { targets.len() };
        if b[at] as usize != count || b.len() != at + 1 + 41 * count {
            return Err(Error::Shape);
        }
        at += 1;
        let mut original_links = Vec::new();
        let mut wide_link = None;
        for i in 0..count {
            let entity = b[at];
            at += 1;
            let seq = u64::from_le_bytes(take(b, &mut at));
            let head = take(b, &mut at);
            if seq == 0 {
                return Err(Error::Chain);
            }
            if wide {
                if entity != event::WideEntity::Province as u8 {
                    return Err(Error::Chain);
                }
                wide_link = Some(event::WideLink {
                    entity: event::WideEntity::Province,
                    seq,
                    head,
                });
            } else {
                if entity != targets[i].0 as u8 {
                    return Err(Error::Chain);
                }
                original_links.push(Link {
                    entity: targets[i].0,
                    seq,
                    head,
                });
            }
        }
        Ok(Self {
            bell: u32::from_le_bytes(b[2..6].try_into().unwrap()),
            identity: id,
            receipt,
            original_links,
            wide_link,
        })
    }
    /// Pair identity/commitments, then recompute each chain against full prior
    /// authenticated headers with verify_previous. Neither alone proves history.
    pub fn pair(&self, other: &Self) -> Result<(), Error> {
        if self.wide_link.is_some() == other.wide_link.is_some()
            || self.bell != other.bell
            || self.identity != other.identity
            || self.receipt != other.receipt
        {
            return Err(Error::Receipt);
        }
        Ok(())
    }
    pub fn verify_previous(
        &self,
        ctx: &AddrCtx,
        original: &[Link],
        wide: Option<event::WideLink>,
    ) -> Result<(), Error> {
        // Public fields are not a decoded-record capability. Revalidate shape,
        // identity and checksum even when the caller never used decode.
        self.identity.validate(ctx)?;
        if self.receipt != Receipt::new(self.receipt.input, self.receipt.output) {
            return Err(Error::Receipt);
        }
        let targets = self.identity.original_targets(ctx)?;
        if let Some(actual) = self.wide_link {
            if !self.original_links.is_empty() || actual.entity != event::WideEntity::Province {
                return Err(Error::Chain);
            }
        } else if self.original_links.len() != targets.len()
            || self
                .original_links
                .iter()
                .zip(&targets)
                .any(|(link, (entity, _))| link.entity != *entity)
        {
            return Err(Error::Chain);
        }
        let b = body(
            self.wide_link.is_some(),
            self.bell,
            self.identity,
            self.receipt,
        );
        if let Some(actual) = self.wide_link {
            if !original.is_empty() {
                return Err(Error::Chain);
            }
            let p = wide.ok_or(Error::Chain)?;
            if p.entity != event::WideEntity::Province
                || event::advance(p.entity, p.seq, &p.head, &b) != Some(actual)
            {
                return Err(Error::Chain);
            }
        } else {
            if wide.is_some() || original.len() != self.original_links.len() {
                return Err(Error::Chain);
            }
            for (p, a) in original.iter().zip(&self.original_links) {
                if p.entity != a.entity || log::advance(p.entity, p.seq, &p.head, &b) != Some(*a) {
                    return Err(Error::Chain);
                }
            }
        }
        Ok(())
    }
}
