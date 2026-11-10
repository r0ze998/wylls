//! Closed reverse expedition v1: original issuer, wide origin, original destination.
//! Independent wire and marker version; outbound v1/v2 readers reject these bytes.
//! Shape/pairing only, never account authenticity or execution admission.
use super::{
    expedition::{AccountFamily, AccountResolver},
    march::{self, MarchEvent, MarchState, WideTransit},
    ProvinceKey,
};
use crate::{addr::AddrCtx, layout::player::transit as T};
use permutation_rules::hash::sha256;
pub const MAGIC: [u8; 8] = *b"PSWLREV1";
pub const LEN: usize = 386;
pub const MARKER_LEN: usize = 96;
pub const MARKER_VERSION: u8 = 2;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Family,
    State,
    Owner,
    Pair,
    Money,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReverseTransit {
    slot: u8,
    transit: WideTransit,
    original_owner: [u8; 32],
    destination: ProvinceKey,
}
impl ReverseTransit {
    pub fn new(
        ctx: &AddrCtx,
        slot: u8,
        transit: WideTransit,
        original_owner: [u8; 32],
        destination: ProvinceKey,
    ) -> Result<Self, Error> {
        let r = Self {
            slot,
            transit,
            original_owner,
            destination,
        };
        r.validate(ctx)?;
        Ok(r)
    }
    fn validate(&self, ctx: &AddrCtx) -> Result<(), Error> {
        let r = AccountResolver::for_season(ctx).map_err(|_| Error::Family)?;
        let t = self.transit;
        if self.slot >= 4 || self.original_owner == [0; 32] || t.rent_to == [0; 32] {
            return Err(Error::Owner);
        }
        if r.family(t.host.key()).map_err(|_| Error::Family)? != AccountFamily::Legacy
            || r.family(t.origin.key()).map_err(|_| Error::Family)? != AccountFamily::Wide
            || r.family(self.destination).map_err(|_| Error::Family)? != AccountFamily::Legacy
        {
            return Err(Error::Family);
        }
        r.legacy_host_id(&t.host).map_err(|_| Error::Family)?;
        if t.tip != 0
            || t.flags != 0
            || (if t.state == MarchState::Gathered {
                t.dest != Some(self.destination)
            } else {
                t.dest.is_some()
            })
            || !matches!(
                t.state,
                MarchState::Departed
                    | MarchState::Settled
                    | MarchState::DestroyedAtOrigin
                    | MarchState::Gathered
            )
        {
            return Err(Error::State);
        }
        let initial = WideTransit::depart(
            t.host_identity,
            t.host,
            t.unit,
            t.faction,
            t.origin,
            t.depart_bell,
            t.arrive_bell,
            t.depart_ts,
            t.dep_mass,
            t.march_stamina,
            t.dealt_bps,
            t.seal_root,
            0,
            0,
            t.rent_to,
        )
        .map_err(|_| Error::State)?;
        if WideTransit::from_bytes(&t.to_bytes()).map_err(|_| Error::Shape)? != t
            || t.troops_after > t.dep_mass
            || (t.state == MarchState::Departed && t != initial)
            || (t.state == MarchState::DestroyedAtOrigin
                && (t.troops_after != 0 || t.stamina_after != 0))
        {
            return Err(Error::State);
        }
        Ok(())
    }
    pub const fn slot(&self) -> u8 {
        self.slot
    }
    pub const fn transit(&self) -> WideTransit {
        self.transit
    }
    pub const fn original_owner(&self) -> [u8; 32] {
        self.original_owner
    }
    pub const fn destination(&self) -> ProvinceKey {
        self.destination
    }
    pub fn to_bytes(&self) -> [u8; LEN] {
        let mut b = [0; LEN];
        b[..8].copy_from_slice(&MAGIC);
        b[8] = 1;
        b[9] = self.slot;
        b[16..304].copy_from_slice(&self.transit.to_bytes());
        b[304..336].copy_from_slice(&self.original_owner);
        b[336..].copy_from_slice(&self.destination.to_bytes());
        b
    }
    pub fn from_bytes(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() != LEN || b[..8] != MAGIC || b[8] != 1 || b[10..16].iter().any(|x| *x != 0) {
            return Err(Error::Shape);
        }
        Self::new(
            ctx,
            b[9],
            WideTransit::from_bytes(&b[16..304]).map_err(|_| Error::Shape)?,
            b[304..336].try_into().map_err(|_| Error::Shape)?,
            ProvinceKey::from_bytes(&b[336..]).map_err(|_| Error::Shape)?,
        )
    }
    pub fn settle_origin(
        &self,
        ctx: &AddrCtx,
        destroyed: bool,
        values: (u32, u16, u16),
    ) -> Result<Self, Error> {
        Self::new(
            ctx,
            self.slot,
            self.transit
                .step(MarchEvent::SettleDeparture { destroyed }, Some(values))
                .map_err(|_| Error::State)?,
            self.original_owner,
            self.destination,
        )
    }
    /// Caller authenticates the canonical original arrival slot and its wear.
    pub fn gather_worn(
        &self,
        ctx: &AddrCtx,
        destination: ProvinceKey,
        worn_bps: u16,
    ) -> Result<Self, Error> {
        use permutation_rules::frontier::structure::{wear, TOWER_WEAR_CAP_BPS};
        if destination != self.destination || worn_bps > TOWER_WEAR_CAP_BPS {
            return Err(Error::Pair);
        }
        let mut t = self.transit;
        match t.state {
            MarchState::Gathered => return Ok(*self),
            MarchState::Settled => t.troops_after = wear(t.troops_after as u64, worn_bps) as u32,
            MarchState::DestroyedAtOrigin => {}
            _ => return Err(Error::State),
        }
        Self::new(
            ctx,
            self.slot,
            t.step(MarchEvent::Gather { dest: destination }, None)
                .map_err(|_| Error::State)?,
            self.original_owner,
            self.destination,
        )
    }
    fn initial(&self, ctx: &AddrCtx) -> Result<Self, Error> {
        let mut t = self.transit;
        t.state = MarchState::Departed;
        t.dest = None;
        t.troops_after = 0;
        t.stamina_after = 0;
        t.ready_bell_off = 0;
        Self::new(ctx, self.slot, t, self.original_owner, self.destination)
    }
}
/// New marker version keeps only the existing host-lock and money offsets.
/// Its digest binds the complete immutable reverse record, including wide origin.
/// Old capture/terminal readers reject it; this closed contract does not widen them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReverseMarker([u8; MARKER_LEN]);
impl ReverseMarker {
    pub fn new(ctx: &AddrCtx, r: &ReverseTransit, tip: u64, flags: u8) -> Result<Self, Error> {
        if flags & !(T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED) != 0 {
            return Err(Error::Money);
        }
        let initial = r.initial(ctx)?;
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::Family)?;
        let id = resolver
            .legacy_host_id(&r.transit.host)
            .map_err(|_| Error::Family)?;
        let mut b = [0; MARKER_LEN];
        b[T::STATE] = 4;
        b[T::RSV_93] = MARKER_VERSION;
        b[T::HOST_ID..T::HOST_ID + 8].copy_from_slice(&id.to_le_bytes());
        b[T::TIP..T::TIP + 8].copy_from_slice(&tip.to_le_bytes());
        b[T::FLAGS] = flags;
        b[T::SEAL_ROOT..T::SEAL_ROOT + 32].copy_from_slice(&sha256(&[
            b"PSF-REVERSE-MARKER-v1",
            &ctx.program,
            &ctx.season,
            &initial.to_bytes(),
        ]));
        Ok(Self(b))
    }
    pub fn from_bytes(ctx: &AddrCtx, b: &[u8]) -> Result<Self, Error> {
        if b.len() != MARKER_LEN
            || b[T::STATE] != 4
            || b[T::RSV_93] != MARKER_VERSION
            || b[T::FLAGS] & !(T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED) != 0
        {
            return Err(Error::Shape);
        }
        let mut canonical = [0; MARKER_LEN];
        for (at, len) in [
            (T::STATE, 1),
            (T::HOST_ID, 8),
            (T::SEAL_ROOT, 32),
            (T::TIP, 8),
            (T::FLAGS, 1),
            (T::RSV_93, 1),
        ] {
            canonical[at..at + len].copy_from_slice(&b[at..at + len]);
        }
        if canonical != b {
            return Err(Error::Shape);
        }
        AccountResolver::for_season(ctx)
            .map_err(|_| Error::Family)?
            .legacy_host_ref(u64::from_le_bytes(
                b[T::HOST_ID..T::HOST_ID + 8]
                    .try_into()
                    .map_err(|_| Error::Shape)?,
            ))
            .map_err(|_| Error::Family)?;
        Ok(Self(canonical))
    }
    pub const fn to_bytes(&self) -> [u8; MARKER_LEN] {
        self.0
    }
    pub fn tip(&self) -> u64 {
        u64::from_le_bytes(self.0[T::TIP..T::TIP + 8].try_into().unwrap())
    }
    pub fn flags(&self) -> u8 {
        self.0[T::FLAGS]
    }
}
pub fn authenticate_pair(
    ctx: &AddrCtx,
    holding: &[u8; 32],
    slot: u8,
    external: &[u8; 32],
    marker: &ReverseMarker,
    reverse: &ReverseTransit,
) -> Result<(), Error> {
    reverse.validate(ctx)?;
    let r = AccountResolver::for_season(ctx).map_err(|_| Error::Family)?;
    if slot != reverse.slot
        || r.holding_address(&reverse.transit.host)
            .map_err(|_| Error::Family)?
            != *holding
        || march::transit_address(ctx, holding, slot) != *external
        || ReverseMarker::new(ctx, reverse, marker.tip(), marker.flags())? != *marker
    {
        return Err(Error::Pair);
    }
    Ok(())
}
