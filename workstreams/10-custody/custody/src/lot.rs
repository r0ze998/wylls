//! The custody kernel: a lot's record and every change made to it.
//!
//! A **lot** is the goods of one owner, of one resource, kept in one vault
//! of one generation (address seed `cl` ‖ P ‖ Q ‖ tile ‖ gen ‖ owner_tag ‖
//! resource). It is not the vault's: the vault's `STORES` are its owner's
//! general stock and every S1 instruction that spends a vault (SendCaravan,
//! a delivery, CloseVault) reads only those. The lot's goods leave only by
//! the moves below, each of which checks, in one call, who signs, who owns
//! and where the goods are:
//!
//! | Move | Signed by | Effect on the lot |
//! |---|---|---|
//! | [`open`] | the custodian (wallet) | created with a capacity `QUOTA` the vault commits |
//! | [`set_quota`] | the custodian (wallet) | `QUOTA` changes, never below what is held or coming |
//! | [`begin_inbound`] | the owner (deposit) or a carrier (ship) | a caravan coming here reserves room |
//! | [`finish_inbound`] | anyone (settlement) | the caravan's cargo is held; what it lost is logged |
//! | [`drop_inbound`] | anyone (reconciliation) | a caravan taken on the way: its goods are the raider's |
//! | [`set_order`] / [`revoke_order`] | the owner | a reservation for a carrier or a user |
//! | [`spend_ship`] | the owner, or a ship order's carrier | goods leave on a caravan |
//! | [`consume`] | a use order's user | goods are used up (processing is workstream 9's) |
//! | [`forfeit`] | anyone, after the vault was seized | goods become the captor's (workstream 10's proposal, by analogy with S1 §3.6 and stage 2 §5) |
//! | [`close`] | the owner or the custodian; anyone once forfeited | the empty lot closes |
//!
//! **Two phases.** An order *reserves* goods ([`set_order`]); only a spend
//! ([`spend_ship`], [`consume`]) moves them. The reservations of live,
//! unexpired orders never exceed `HELD`, so the same goods cannot be
//! promised twice and an order can always be honoured up to its quantity.
//! An expired order's reservation lapses without a keeper (TigerBeetle's
//! pending-transfer timeout; SPL Token's delegate allowance).
//!
//! **No period.** Nothing here knows a season, a war period or an end of
//! the world: a lot, its orders and its caravans run on bells and on their
//! own terms (an order's `EXPIRES_BELL` is the right's own expiry, chosen by
//! the owner, not the world's). A period boundary is not an input of any
//! move, so it cannot forfeit, freeze or release anything.
//!
//! **Conservation** ([`Lot::balanced`]): `IN_TOTAL = HELD + OUT_TOTAL +
//! CONSUMED + FORFEITED`, in milli-units, at every step. Goods in transit
//! are a caravan's, and every loss on the way is logged with its cause
//! ([`Loss`]); nothing is dropped to make the books balance.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};

/// Kernel version (`KERNEL_VERSIONS_V4` entry `custody`; the S1 list,
/// `KERNEL_VERSIONS_V3`, does not bind it).
pub const CUSTODY_VERSION: u16 = 1;
/// The resources a lot may hold, as a bit mask over `Resource`: stage one of
/// custody starts with ore only (the workshop's input) [proposal].
pub const ENABLED_RESOURCES: u8 = 1 << Resource::Ore as u8;
/// Order slots of a lot [proposal].
pub const MAX_ORDERS: usize = 4;
/// Caravans that may be on their way to one lot at once [proposal].
pub const MAX_INBOUND: usize = 4;
/// The longest an order may run, in bells (a week at 144 a day) [phase 6].
pub const MAX_ORDER_BELLS: u32 = 1_008;

/// Why a move is refused. Every refusal leaves every account unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyError {
    /// The signer is not the one this move needs (owner, custodian,
    /// grantee).
    NotAuthorized,
    /// The move needs the wallet; a session key was used.
    WalletRequired,
    /// The resource is not enabled for custody, or not the lot's.
    Resource,
    /// A quantity is zero, negative or not whole units.
    Quantity,
    /// More than is available (held and not reserved), or than an order's
    /// remainder.
    Insufficient,
    /// The vault has no room for the quota, or the lot for the caravan.
    Capacity,
    /// No free order or inbound slot.
    NoSlot,
    /// The order named is not live, not this one, of another kind, or its
    /// destination or purpose differs.
    Order,
    /// The order has expired.
    Expired,
    /// A replayed or out-of-date request (`NONCE` moved on).
    Stale,
    /// The lot's vault was seized (another generation) or is gone: only
    /// [`forfeit`] and settlements apply.
    Forfeited,
    /// The lot is not open (forfeited or empty and closing).
    State,
    /// The lot still holds goods, expects a caravan or has a live order.
    NotEmpty,
    /// The caravan is still on its way (no reconciliation yet).
    InTransit,
    /// The custodian may not keep its own goods as a lot; a carrier or a
    /// user may not be the owner.
    SelfDealing,
    /// A running total would leave `i64` (a world that runs for good keeps
    /// adding to `IN_TOTAL`, `OUT_TOTAL`, `CONSUMED`, `FORFEITED` and the
    /// vault's stock; the rules crate is built without overflow checks, so
    /// every such sum is checked here instead of wrapping).
    Overflow,
}

pub type CResult<T> = Result<T, CustodyError>;

/// A place in the log form (`frontier_abi::v2::log::log_place`, 8 bytes):
/// kind 1 holding (`at` = site), 2 vault (`at` = tile), 3 field.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlaceRef {
    pub kind: u8,
    pub p: i16,
    pub q: i16,
    pub at: u8,
    pub gen: u8,
    pub tile: u8,
}

pub const PLACE_HOLDING: u8 = 1;
pub const PLACE_VAULT: u8 = 2;

impl PlaceRef {
    pub fn vault(p: i16, q: i16, tile: u8, gen: u8) -> PlaceRef {
        PlaceRef {
            kind: PLACE_VAULT,
            p,
            q,
            at: tile,
            gen,
            tile,
        }
    }

    pub fn encode(&self) -> [u8; 8] {
        let mut b = [0u8; 8];
        b[0] = self.kind;
        b[1..3].copy_from_slice(&self.p.to_le_bytes());
        b[3..5].copy_from_slice(&self.q.to_le_bytes());
        b[5] = self.at;
        b[6] = self.gen;
        b[7] = self.tile;
        b
    }

    pub fn decode(b: &[u8]) -> PlaceRef {
        PlaceRef {
            kind: b[0],
            p: i16::from_le_bytes([b[1], b[2]]),
            q: i16::from_le_bytes([b[3], b[4]]),
            at: b[5],
            gen: b[6],
            tile: b[7],
        }
    }
}

/// What the kernel reads (and may write) of the vault a lot is in: the
/// S1 Vault and the custody fields patches/0001 adds to its reserve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultView {
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    pub gen: u8,
    pub live: bool,
    pub owner: [u8; 32],
    pub owner_tag: u64,
    /// The owner's general stock (`STORES`, milli).
    pub stores: [i64; RESOURCES],
    /// `CAP`, per resource (milli).
    pub cap: i64,
    /// `CUSTODY_QUOTA`: capacity committed to lots (milli).
    pub quota: [i64; RESOURCES],
    /// `CUSTODY_LOTS`: lots opened here and not closed or forfeited.
    pub lots: u16,
}

impl VaultView {
    pub fn place(&self) -> PlaceRef {
        PlaceRef::vault(self.p, self.q, self.tile, self.gen)
    }

    /// Room the general stock may still fill: `CAP − CUSTODY_QUOTA`, never
    /// below what is already there (SettleCaravan's clamp, amended).
    pub fn general_cap(&self, r: usize) -> i64 {
        self.cap.saturating_sub(self.quota[r]).max(self.stores[r])
    }
}

/// Who signs: the Citizen acting and whether by its session key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Actor {
    pub citizen: [u8; 32],
    pub tag: u64,
    pub by_session: bool,
}

/// The lot's state.
pub const LOT_NONE: u8 = 0;
pub const LOT_OPEN: u8 = 1;
/// The vault was seized and [`forfeit`] ran: the goods are the captor's.
pub const LOT_FORFEITED: u8 = 2;

pub const ORDER_FREE: u8 = 0;
/// A carrier may ship up to `qty_left` to `dst`.
pub const ORDER_SHIP: u8 = 1;
/// A user may consume up to `qty_left` for `purpose`.
pub const ORDER_USE: u8 = 2;

/// An order slot (64 B in the lot).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Order {
    pub kind: u8,
    /// Use orders: what the goods may be used for (workstream 9 names
    /// these; 0 = any processing).
    pub purpose: u16,
    /// The lot's `NONCE` when the order was set (its id).
    pub id: u32,
    /// The first bell at which the order no longer applies.
    pub expires_bell: u32,
    /// Ship orders: the destination vault (place, generation).
    pub dst: PlaceRef,
    pub grantee: [u8; 32],
    /// Reserved and not yet spent (milli).
    pub qty_left: i64,
}

impl Order {
    /// Whether the order still reserves goods at `bell`.
    pub fn live(&self, bell: u32) -> bool {
        self.kind != ORDER_FREE && self.qty_left > 0 && bell < self.expires_bell
    }
}

/// A caravan on its way to the lot (24 B in the lot): its address seed and
/// the cargo it left with (after tower wear).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inbound {
    pub live: bool,
    pub caravan_tag: u64,
    pub seq: u32,
    pub qty: i64,
}

impl Inbound {
    pub fn is(&self, tag: u64, seq: u32) -> bool {
        self.live && self.caravan_tag == tag && self.seq == seq
    }
}

/// The lot (576 B; [`crate::layout::lot`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lot {
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    /// The vault's generation at open; another generation = seized.
    pub vault_gen: u8,
    pub resource: u8,
    pub state: u8,
    pub owner: [u8; 32],
    pub owner_tag: u64,
    /// The custodian when opened (the log's; authority is the vault's
    /// owner, read at each step).
    pub custodian_tag: u64,
    pub quota: i64,
    pub held: i64,
    pub in_total: i64,
    pub out_total: i64,
    pub consumed: i64,
    pub forfeited: i64,
    pub nonce: u32,
    pub opened_bell: u32,
    pub orders: [Order; MAX_ORDERS],
    pub inbound: [Inbound; MAX_INBOUND],
    pub rent_to: [u8; 32],
}

/// Why goods left their owner without being delivered, used or withdrawn.
/// Each is logged with its quantity (`CUSTODY_LOSS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Loss {
    /// Towers on the route wore the cargo at departure (S1 1d).
    Worn = 1,
    /// A raider burned the cargo (RaidCaravan / DefaultRaid burn).
    Burned = 2,
    /// A raider took the caravan (decision J2): the goods are the raider's.
    Raided = 3,
    /// The destination vault was seized or is gone at arrival (S1 §3.4:
    /// a destination of another generation does not deliver).
    DestinationGone = 4,
    /// The lot's vault was seized: the goods are the captor's (workstream
    /// 10's proposal, not a decision; see [`forfeit`]).
    Seized = 5,
}

/// What a settlement did with an inbound caravan's cargo.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    pub delivered: i64,
    pub burned: i64,
    pub dest_gone: i64,
}

impl Lot {
    pub fn place(&self) -> PlaceRef {
        PlaceRef::vault(self.p, self.q, self.tile, self.vault_gen)
    }

    /// Goods reserved by live orders at `bell`.
    pub fn reserved(&self, bell: u32) -> i64 {
        self.orders
            .iter()
            .filter(|o| o.live(bell))
            .map(|o| o.qty_left)
            .sum()
    }

    /// Goods neither reserved nor gone: what the owner may still promise or
    /// move.
    pub fn available(&self, bell: u32) -> i64 {
        self.held - self.reserved(bell)
    }

    /// Room promised to caravans on their way.
    pub fn incoming(&self) -> i64 {
        self.inbound.iter().filter(|i| i.live).map(|i| i.qty).sum()
    }

    /// The lot's own conservation law (and its bounds).
    pub fn balanced(&self, bell: u32) -> bool {
        self.held >= 0
            && self.in_total == self.held + self.out_total + self.consumed + self.forfeited
            && self.reserved(bell) <= self.held
            && (self.state != LOT_OPEN || self.held + self.incoming() <= self.quota)
    }

    /// Whether the lot is empty enough to close.
    pub fn empty(&self, bell: u32) -> bool {
        self.held == 0
            && self.inbound.iter().all(|i| !i.live)
            && self.orders.iter().all(|o| !o.live(bell))
    }

    /// The lot is open and its vault is the same vault, of the same
    /// generation, still live.
    fn usable(&self, v: &VaultView) -> CResult<()> {
        if self.state != LOT_OPEN {
            return Err(CustodyError::State);
        }
        if !v.live || v.gen != self.vault_gen || (v.p, v.q, v.tile) != (self.p, self.q, self.tile) {
            return Err(CustodyError::Forfeited);
        }
        Ok(())
    }
}

fn whole(q: i64) -> CResult<()> {
    if q <= 0 || q % MILLI != 0 {
        return Err(CustodyError::Quantity);
    }
    Ok(())
}

fn enabled(resource: u8) -> CResult<usize> {
    if (resource as usize) < RESOURCES && ENABLED_RESOURCES & (1 << resource) != 0 {
        Ok(resource as usize)
    } else {
        Err(CustodyError::Resource)
    }
}

fn wallet(a: &Actor) -> CResult<()> {
    if a.by_session {
        Err(CustodyError::WalletRequired)
    } else {
        Ok(())
    }
}

// ------------------------------------------------------------ open, quota, close

/// OpenLot: the custodian commits `quota` of its vault to `owner`'s goods
/// of `resource`. The vault's general stock and every lot's quota stay
/// within `CAP`. Writes `v.quota`, `v.lots`.
pub fn open(
    v: &mut VaultView,
    custodian: &Actor,
    owner: ([u8; 32], u64),
    resource: u8,
    quota: i64,
    bell: u32,
    rent_to: [u8; 32],
) -> CResult<Lot> {
    let r = enabled(resource)?;
    wallet(custodian)?;
    if custodian.citizen != v.owner {
        return Err(CustodyError::NotAuthorized);
    }
    if !v.live {
        return Err(CustodyError::Forfeited);
    }
    if owner.0 == v.owner {
        return Err(CustodyError::SelfDealing);
    }
    whole(quota)?;
    let need = v.stores[r]
        .checked_add(v.quota[r])
        .and_then(|x| x.checked_add(quota))
        .ok_or(CustodyError::Capacity)?;
    if need > v.cap {
        return Err(CustodyError::Capacity);
    }
    v.quota[r] += quota;
    v.lots = v.lots.checked_add(1).ok_or(CustodyError::Capacity)?;
    Ok(Lot {
        p: v.p,
        q: v.q,
        tile: v.tile,
        vault_gen: v.gen,
        resource,
        state: LOT_OPEN,
        owner: owner.0,
        owner_tag: owner.1,
        custodian_tag: v.owner_tag,
        quota,
        held: 0,
        in_total: 0,
        out_total: 0,
        consumed: 0,
        forfeited: 0,
        nonce: 0,
        opened_bell: bell,
        orders: [Order::default(); MAX_ORDERS],
        inbound: [Inbound::default(); MAX_INBOUND],
        rent_to,
    })
}

/// SetQuota: the custodian changes the room it keeps for the lot; never
/// below what the lot holds and expects.
pub fn set_quota(v: &mut VaultView, lot: &mut Lot, custodian: &Actor, quota: i64) -> CResult<()> {
    lot.usable(v)?;
    wallet(custodian)?;
    if custodian.citizen != v.owner {
        return Err(CustodyError::NotAuthorized);
    }
    whole(quota)?;
    if quota < lot.held + lot.incoming() {
        return Err(CustodyError::NotEmpty);
    }
    let r = lot.resource as usize;
    let others = v.quota[r] - lot.quota;
    if v.stores[r] + others + quota > v.cap && quota > lot.quota {
        return Err(CustodyError::Capacity);
    }
    v.quota[r] = others + quota;
    lot.quota = quota;
    Ok(())
}

/// CloseLot: an empty lot closes. Open: by its owner or the vault's owner
/// (the vault's quota and lot count are released). Forfeited: by anyone,
/// once no caravan is on its way to it.
pub fn close(
    v: Option<&mut VaultView>,
    lot: &mut Lot,
    actor: Option<&Actor>,
    bell: u32,
) -> CResult<()> {
    if !lot.empty(bell) {
        return Err(CustodyError::NotEmpty);
    }
    match lot.state {
        LOT_FORFEITED => {}
        LOT_OPEN => {
            let v = v.ok_or(CustodyError::Forfeited)?;
            lot.usable(v)?;
            let a = actor.ok_or(CustodyError::NotAuthorized)?;
            if a.citizen != lot.owner && a.citizen != v.owner {
                return Err(CustodyError::NotAuthorized);
            }
            let r = lot.resource as usize;
            v.quota[r] -= lot.quota;
            v.lots = v.lots.saturating_sub(1);
        }
        _ => return Err(CustodyError::State),
    }
    lot.state = LOT_NONE;
    Ok(())
}

// ------------------------------------------------------------ inbound

/// A caravan leaves for the lot (DepositLot, ShipLot): it reserves room for
/// `qty` (the cargo after the route's wear) in a free inbound slot.
pub fn begin_inbound(v: &VaultView, lot: &mut Lot, caravan: (u64, u32), qty: i64) -> CResult<()> {
    lot.usable(v)?;
    if qty <= 0 {
        return Err(CustodyError::Quantity);
    }
    if lot.inbound.iter().any(|i| i.is(caravan.0, caravan.1)) {
        return Err(CustodyError::Stale);
    }
    if lot.held + lot.incoming() + qty > lot.quota {
        return Err(CustodyError::Capacity);
    }
    let slot = lot
        .inbound
        .iter_mut()
        .find(|i| !i.live)
        .ok_or(CustodyError::NoSlot)?;
    *slot = Inbound {
        live: true,
        caravan_tag: caravan.0,
        seq: caravan.1,
        qty,
    };
    Ok(())
}

/// SettleCustody: the inbound caravan arrived with `cargo` (less than it
/// left with when burned). The lot of a seized or vanished vault takes
/// nothing: the cargo is lost (`DestinationGone`), as a delivery to a
/// vault of another generation is (S1 §3.4). `v` is `None` when the vault
/// is closed.
pub fn finish_inbound(
    v: Option<&VaultView>,
    lot: &mut Lot,
    caravan: (u64, u32),
    cargo: i64,
) -> CResult<Settlement> {
    let i = lot
        .inbound
        .iter()
        .position(|i| i.is(caravan.0, caravan.1))
        .ok_or(CustodyError::Stale)?;
    let sent = lot.inbound[i].qty;
    if cargo < 0 || cargo > sent {
        return Err(CustodyError::Quantity);
    }
    let here = matches!(v, Some(v) if lot.usable(v).is_ok());
    let (held, in_total) = if here {
        (
            lot.held.checked_add(cargo).ok_or(CustodyError::Overflow)?,
            lot.in_total
                .checked_add(cargo)
                .ok_or(CustodyError::Overflow)?,
        )
    } else {
        (lot.held, lot.in_total)
    };
    lot.inbound[i] = Inbound::default();
    let s = if here {
        lot.held = held;
        lot.in_total = in_total;
        Settlement {
            delivered: cargo,
            burned: sent - cargo,
            dest_gone: 0,
        }
    } else {
        Settlement {
            delivered: 0,
            burned: sent - cargo,
            dest_gone: cargo,
        }
    };
    Ok(s)
}

/// What a reconciliation found of an inbound caravan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaravanSeen {
    /// Present, still custody for this lot (moving, or a raid open).
    Custody,
    /// Present, taken by a raider (custody mark cleared, J2).
    Taken,
    /// Closed: only a taken caravan closes without SettleCustody.
    Absent,
}

/// ReconcileLot: a caravan the lot expected was taken on the way. Its room
/// is released and its quantity is a `Raided` loss.
pub fn drop_inbound(lot: &mut Lot, caravan: (u64, u32), seen: CaravanSeen) -> CResult<i64> {
    let i = lot
        .inbound
        .iter()
        .position(|i| i.is(caravan.0, caravan.1))
        .ok_or(CustodyError::Stale)?;
    match seen {
        CaravanSeen::Custody => Err(CustodyError::InTransit),
        CaravanSeen::Taken | CaravanSeen::Absent => {
            let q = lot.inbound[i].qty;
            lot.inbound[i] = Inbound::default();
            Ok(q)
        }
    }
}

// ------------------------------------------------------------ orders

/// What the owner asks an order to allow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderSpec {
    pub kind: u8,
    pub grantee: [u8; 32],
    pub qty: i64,
    pub expires_bell: u32,
    /// Ship: the destination vault (another vault; its generation now).
    pub dst: PlaceRef,
    /// Use: the purpose.
    pub purpose: u16,
}

/// SetOrder: the owner reserves `spec.qty` of the lot's available goods for
/// a carrier or a user, in slot `slot` (free, spent or expired), if the
/// lot's `NONCE` is still `nonce` (a replay or a request built on an older
/// lot is `Stale`). Returns the order's id.
pub fn set_order(
    v: &VaultView,
    lot: &mut Lot,
    owner: &Actor,
    slot: u8,
    nonce: u32,
    spec: &OrderSpec,
    bell: u32,
) -> CResult<u32> {
    lot.usable(v)?;
    wallet(owner)?;
    if owner.citizen != lot.owner {
        return Err(CustodyError::NotAuthorized);
    }
    if nonce != lot.nonce {
        return Err(CustodyError::Stale);
    }
    if spec.grantee == lot.owner {
        return Err(CustodyError::SelfDealing);
    }
    whole(spec.qty)?;
    if spec.expires_bell <= bell || spec.expires_bell - bell > MAX_ORDER_BELLS {
        return Err(CustodyError::Expired);
    }
    match spec.kind {
        ORDER_SHIP => {
            if spec.dst.kind != PLACE_VAULT
                || (spec.dst.p, spec.dst.q, spec.dst.tile) == (lot.p, lot.q, lot.tile)
            {
                return Err(CustodyError::Order);
            }
        }
        ORDER_USE => {}
        _ => return Err(CustodyError::Order),
    }
    let o = lot.orders.get(slot as usize).ok_or(CustodyError::NoSlot)?;
    if o.live(bell) {
        return Err(CustodyError::NoSlot);
    }
    if lot.available(bell) < spec.qty {
        return Err(CustodyError::Insufficient);
    }
    let id = lot.nonce;
    lot.orders[slot as usize] = Order {
        kind: spec.kind,
        purpose: if spec.kind == ORDER_USE {
            spec.purpose
        } else {
            0
        },
        id,
        expires_bell: spec.expires_bell,
        dst: if spec.kind == ORDER_SHIP {
            spec.dst
        } else {
            PlaceRef::default()
        },
        grantee: spec.grantee,
        qty_left: spec.qty,
    };
    lot.nonce = lot.nonce.checked_add(1).ok_or(CustodyError::Stale)?;
    Ok(id)
}

/// RevokeOrder: the owner (wallet or session: revoking only narrows) ends
/// order `id` in `slot`; its unspent reservation is released. Goods it
/// already moved stay where they went (a caravan cannot be recalled, S1).
/// Allowed on a forfeited lot too (nothing to release). Returns what was
/// released.
pub fn revoke_order(lot: &mut Lot, owner: &Actor, slot: u8, id: u32, bell: u32) -> CResult<i64> {
    if owner.citizen != lot.owner {
        return Err(CustodyError::NotAuthorized);
    }
    let o = lot
        .orders
        .get_mut(slot as usize)
        .ok_or(CustodyError::Order)?;
    if o.kind == ORDER_FREE || o.id != id {
        return Err(CustodyError::Order);
    }
    let released = if o.live(bell) { o.qty_left } else { 0 };
    *o = Order::default();
    Ok(released)
}

/// Who spends: the owner itself, or the grantee of order `id` in `slot`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Owner,
    Order { slot: u8, id: u32 },
}

/// Where a ship goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShipTo {
    /// Another lot of the same owner and resource (a custody caravan).
    Lot(PlaceRef),
    /// One of the owner's own places, into its general stock (an ordinary
    /// caravan of the owner): a withdrawal. Owner only.
    OwnPlace(PlaceRef),
}

fn spend_order(
    lot: &mut Lot,
    actor: &Actor,
    slot: u8,
    id: u32,
    kind: u8,
    qty: i64,
    bell: u32,
) -> CResult<Order> {
    wallet(actor)?;
    let o = lot
        .orders
        .get_mut(slot as usize)
        .ok_or(CustodyError::Order)?;
    if o.kind != kind || o.id != id || o.kind == ORDER_FREE {
        return Err(CustodyError::Order);
    }
    if o.grantee != actor.citizen {
        return Err(CustodyError::NotAuthorized);
    }
    if bell >= o.expires_bell {
        return Err(CustodyError::Expired);
    }
    if qty > o.qty_left {
        return Err(CustodyError::Insufficient);
    }
    let before = *o;
    o.qty_left -= qty;
    if o.qty_left == 0 {
        *o = Order::default();
    }
    Ok(before)
}

/// ShipLot: `qty` leaves the lot on a caravan. The owner may ship any
/// available quantity, to another lot or home (a session key only home);
/// a carrier only within its ship order, to the order's destination, by
/// the wallet. The caller then creates the caravan and, for a lot, calls
/// [`begin_inbound`] on the destination lot in the same instruction.
pub fn spend_ship(
    v: &VaultView,
    lot: &mut Lot,
    actor: &Actor,
    by: By,
    qty: i64,
    to: ShipTo,
    bell: u32,
) -> CResult<()> {
    lot.usable(v)?;
    whole(qty)?;
    if let ShipTo::Lot(dst) = to {
        if dst.kind != PLACE_VAULT || (dst.p, dst.q, dst.tile) == (lot.p, lot.q, lot.tile) {
            return Err(CustodyError::Order);
        }
    }
    match by {
        By::Owner => {
            if actor.citizen != lot.owner {
                return Err(CustodyError::NotAuthorized);
            }
            if matches!(to, ShipTo::Lot(_)) {
                wallet(actor)?;
            }
            if lot.available(bell) < qty {
                return Err(CustodyError::Insufficient);
            }
        }
        By::Order { slot, id } => {
            let ShipTo::Lot(dst) = to else {
                return Err(CustodyError::Order);
            };
            if actor.citizen == lot.owner {
                return Err(CustodyError::SelfDealing);
            }
            // Destination first, so a wrong one spends nothing.
            let o = lot.orders.get(slot as usize).ok_or(CustodyError::Order)?;
            if o.kind == ORDER_SHIP && o.id == id && o.dst != dst {
                return Err(CustodyError::Order);
            }
            if lot.out_total.checked_add(qty).is_none() {
                return Err(CustodyError::Overflow);
            }
            spend_order(lot, actor, slot, id, ORDER_SHIP, qty, bell)?;
        }
    }
    lot.out_total = lot
        .out_total
        .checked_add(qty)
        .ok_or(CustodyError::Overflow)?;
    lot.held -= qty;
    Ok(())
}

/// ConsumeLot: a use order's grantee uses `qty` up, for the order's
/// purpose. What it makes is workstream 9's; here the goods leave.
#[allow(clippy::too_many_arguments)]
pub fn consume(
    v: &VaultView,
    lot: &mut Lot,
    user: &Actor,
    slot: u8,
    id: u32,
    qty: i64,
    purpose: u16,
    bell: u32,
) -> CResult<()> {
    lot.usable(v)?;
    whole(qty)?;
    let o = lot.orders.get(slot as usize).ok_or(CustodyError::Order)?;
    if o.kind == ORDER_USE && o.id == id && o.purpose != 0 && o.purpose != purpose {
        return Err(CustodyError::Order);
    }
    let consumed = lot
        .consumed
        .checked_add(qty)
        .ok_or(CustodyError::Overflow)?;
    spend_order(lot, user, slot, id, ORDER_USE, qty, bell)?;
    lot.held -= qty;
    lot.consumed = consumed;
    Ok(())
}

/// ReturnUnused: goods a use order let out and the user did not use come
/// back into the lot they left (the owner's decision of 2026-11-06, as
/// recorded by workstream 9: unused ore goes back to its lot). They were
/// booked as `CONSUMED` when they left, so they are **un-consumed**, not
/// received again: `CONSUMED −= qty`, `HELD += qty`, and `IN_TOTAL` does
/// not move (a return through [`begin_inbound`]/[`finish_inbound`] would
/// count the same goods as used and as newly in). Whole units only; never
/// more than the lot has consumed; the lot must be usable and have room
/// (`HELD + expected + qty ≤ QUOTA`). The order is not restored: the use
/// happened, only less of it. Who may call it is the caller's (the
/// program's workshop instruction), as for [`consume`].
pub fn return_unused(v: &VaultView, lot: &mut Lot, qty: i64) -> CResult<()> {
    lot.usable(v)?;
    whole(qty)?;
    if qty > lot.consumed {
        return Err(CustodyError::Quantity);
    }
    let held = lot.held.checked_add(qty).ok_or(CustodyError::Overflow)?;
    if held
        .checked_add(lot.incoming())
        .is_none_or(|n| n > lot.quota)
    {
        return Err(CustodyError::Capacity);
    }
    lot.held = held;
    lot.consumed -= qty;
    Ok(())
}

// ------------------------------------------------------------ seizure

/// What [`forfeit`] moved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Forfeit {
    pub qty: i64,
    pub captor_tag: u64,
    pub orders_voided: u8,
}

/// ReconcileLot after a seizure: the lot's vault (the same tile, live) is
/// of a later generation, so it was seized (SeizeVault, `GEN += 1`). What
/// the lot holds becomes the vault's general stock, its current owner's;
/// the lot's quota is released and its orders voided. **This is workstream
/// 10's proposal, not a decision**: S1 §3.6 gives a seized vault's goods to
/// the captor, and the stage 2 rule adopted on 2026-10-23 voids a seized
/// vault's share and receipt tokens (札); lots are neither, and are treated
/// alike so a deposit is not safer than the vault's own goods. The
/// loss is logged (`Seized`), never dropped. Permissionless: the captor is
/// the one who wants it, and until then the lot is frozen ([`Lot::usable`]
/// refuses every other move).
pub fn forfeit(v: &mut VaultView, lot: &mut Lot) -> CResult<Forfeit> {
    if lot.state != LOT_OPEN {
        return Err(CustodyError::State);
    }
    if (v.p, v.q, v.tile) != (lot.p, lot.q, lot.tile) || !v.live || v.gen == lot.vault_gen {
        return Err(CustodyError::State);
    }
    let r = lot.resource as usize;
    let qty = lot.held;
    // HELD ≤ QUOTA, and the quota leaves the vault's count: STORES stays
    // within CAP.
    let stores = v.stores[r].checked_add(qty).ok_or(CustodyError::Overflow)?;
    let forfeited = lot
        .forfeited
        .checked_add(qty)
        .ok_or(CustodyError::Overflow)?;
    v.stores[r] = stores;
    v.quota[r] -= lot.quota;
    v.lots = v.lots.saturating_sub(1);
    let voided = lot.orders.iter().filter(|o| o.kind != ORDER_FREE).count() as u8;
    lot.orders = [Order::default(); MAX_ORDERS];
    lot.held = 0;
    lot.forfeited = forfeited;
    lot.quota = 0;
    lot.state = LOT_FORFEITED;
    Ok(Forfeit {
        qty,
        captor_tag: v.owner_tag,
        orders_voided: voided,
    })
}

/// Canonical bytes of the tables here (for a ruleset hash). Append only.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&CUSTODY_VERSION.to_le_bytes());
    out.push(ENABLED_RESOURCES);
    out.push(MAX_ORDERS as u8);
    out.push(MAX_INBOUND as u8);
    out.extend_from_slice(&MAX_ORDER_BELLS.to_le_bytes());
}
