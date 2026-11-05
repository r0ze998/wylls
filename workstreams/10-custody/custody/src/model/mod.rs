//! A model of the program's accounts and instructions around custody.
//!
//! **Not the program.** It keeps the program's transaction rules, so that
//! the custody kernel can be tested where it will live:
//!
//! * **Atomic instructions.** Every instruction runs on a copy of the world
//!   and is committed only if it succeeds (a failed Solana transaction
//!   writes nothing). Events are part of the state, so a refusal logs
//!   nothing.
//! * **Serial execution.** Two requests built on the same state run one
//!   after the other, as write locks on the same lot or caravan make them
//!   (`tests/abuse.rs` runs both orders).
//! * **Real layouts.** Vaults, caravans and lots are byte buffers at the
//!   ABI's offsets (`frontier_abi::v2::layout::s1` plus the amendments in
//!   [`crate::layout`]); a restart ([`World::snapshot`] / [`World::restore`])
//!   is a byte round trip.
//! * **The S1 rules it meets, as the code on 4cd901de has them**
//!   (`permutation-frontier/src/proc/caravan.rs`): SendCaravan debits
//!   `STORES` only; SettleCaravan credits a vault up to its cap and loses a
//!   delivery to a place of another generation; a take moves the whole
//!   caravan to the raider (J2), a burn zeroes its cargo and the empty
//!   caravan goes on; SeizeVault changes the owner and `GEN += 1`, goods
//!   staying in the vault; CloseVault needs an empty vault.
//!
//! Left out, and why it does not change what is tested: paths, Provinces
//! and slots (a caravan arrives `travel_bells` after it leaves; a raid is
//! opened explicitly where the clash would open it), the roster condition
//! of SeizeVault (the call stands for a seizure the program accepted),
//! lamports (fee and rent), holding production.

pub mod fixture;
mod wire;

use std::collections::BTreeMap;

use frontier_abi::v2::layout::s1::{caravan as CV, place as PL, vault as VA};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::RESOURCES;
use permutation_rules::frontier::structure::wear_i64;

use crate::layout::{caravan_custody as CC, lot as LL, vault_custody as VC};
use crate::lot::{self as k, *};

pub type Key = [u8; 32];

/// A signature: the Citizen and whether its session key signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signer {
    pub citizen: Key,
    pub session: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Citizen {
    pub key: Key,
    pub tag: u64,
    pub faction: u8,
    pub caravans: u32,
    pub vaults: u8,
    pub home: PlaceRef,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holding {
    pub place: PlaceRef,
    pub owner: Key,
    pub stores: [i64; RESOURCES],
}

/// Model-only facts of a caravan the program keeps in Province slots.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Exposure {
    /// A raid is open on it (a clash or RaidDomestic opened it), and by
    /// whom.
    pub raid_open: Option<Key>,
}

/// Errors of the model's instructions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Custody(CustodyError),
    /// An account named is missing or not the kind expected.
    NotFound,
    /// Not the owner of the place it spends (S1 `NotOwner`).
    NotOwner,
    /// More than the general stock has (S1 `Insufficient`).
    Insufficient,
    /// A send to another player by a session key (S1 `WalletRequired`).
    WalletRequired,
    /// Before arrival, or a raid still open (S1 `CaravanEarly`, `RaidState`).
    Early,
    RaidState,
    /// Already settled (S1 `AlreadyDone`).
    AlreadyDone,
    /// A custody caravan named to SettleCaravan, or an ordinary one to
    /// SettleCustody (new: `CustodyCaravan`).
    CustodyCaravan,
    /// CloseVault on a vault with goods or lots.
    NotEmpty,
    /// Data that names something impossible (S1 `BadData`).
    BadData,
}

impl From<CustodyError> for Error {
    fn from(e: CustodyError) -> Error {
        Error::Custody(e)
    }
}

pub type MResult<T> = Result<T, Error>;

/// A lot's key: its vault place (with generation), owner tag and resource.
pub type LotKey = (PlaceRef, u64, u8);
/// A caravan's key: the address seed (sender's tag, sequence).
pub type CaravanKey = (u64, u32);

/// The custody log (what the program would chain as `CUSTODY_*` records,
/// and the S1 records the tests read).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    LotOpened {
        lot: LotKey,
        custodian: u64,
        quota: i64,
    },
    QuotaSet {
        lot: LotKey,
        quota: i64,
    },
    /// Goods left the owner's general stock for a lot (DepositLot).
    Deposited {
        lot: LotKey,
        caravan: CaravanKey,
        sent: i64,
        worn: i64,
    },
    /// Goods left a lot (ShipLot): to another lot (custody caravan) or home.
    Shipped {
        from: LotKey,
        caravan: CaravanKey,
        sent: i64,
        worn: i64,
        to_lot: Option<LotKey>,
        by_order: Option<u32>,
        carrier: u64,
    },
    /// A custody caravan settled at its lot.
    Settled {
        lot: LotKey,
        caravan: CaravanKey,
        delivered: i64,
        burned: i64,
        dest_gone: i64,
    },
    OrderSet {
        lot: LotKey,
        slot: u8,
        id: u32,
        kind: u8,
        grantee: u64,
        qty: i64,
        expires_bell: u32,
    },
    OrderRevoked {
        lot: LotKey,
        slot: u8,
        id: u32,
        released: i64,
    },
    Consumed {
        lot: LotKey,
        id: u32,
        user: u64,
        qty: i64,
        purpose: u16,
    },
    /// Goods that left their owner without delivery, use or withdrawal.
    Loss {
        owner: u64,
        resource: u8,
        cause: Loss,
        qty: i64,
        to: u64,
        lot: Option<LotKey>,
        caravan: Option<CaravanKey>,
    },
    LotClosed {
        lot: LotKey,
    },
    // The S1 records the tests read.
    CaravanSent {
        caravan: CaravanKey,
        owner: u64,
        custody: bool,
    },
    CaravanSettled {
        caravan: CaravanKey,
        delivered: bool,
        cargo: [i64; RESOURCES],
        credited: [i64; RESOURCES],
    },
    CaravanRaided {
        caravan: CaravanKey,
        take: bool,
        raider: u64,
    },
    /// A period boundary was crossed (test input; see [`World::boundary`]).
    Boundary {
        n: u32,
        bell: u32,
    },
    VaultSeized {
        vault: PlaceRef,
        captor: u64,
        prev: u64,
    },
}

/// Where an owner's goods are, by the distinction the brief asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Whereabouts {
    /// In a lot, usable (available and reserved).
    Held {
        lot: LotKey,
        held: i64,
        reserved: i64,
    },
    /// On a custody caravan that has not arrived; the owner's.
    InTransit {
        lot: LotKey,
        caravan: CaravanKey,
        qty: i64,
    },
    /// Not determinable yet: a raid is open (take or burn undecided), the
    /// caravan has arrived but is not settled, or it was taken and the lot
    /// not reconciled.
    Unknown {
        lot: LotKey,
        caravan: CaravanKey,
        qty: i64,
        why: &'static str,
    },
    /// Recorded and kept, but no one may move it until a condition
    /// clears: the vault was seized and the lot not yet reconciled. (A
    /// period boundary is never such a condition.)
    Frozen {
        lot: LotKey,
        qty: i64,
        why: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct World {
    pub bell: u32,
    /// Period boundaries crossed (a test input standing for whatever ④/⑧
    /// define as a war-period switch; nothing in custody reads it).
    pub boundaries: u32,
    pub citizens: BTreeMap<Key, Citizen>,
    pub holdings: BTreeMap<PlaceRef, Holding>,
    /// Vault accounts (512 B, S1 layout + custody amendment), by tile.
    pub vaults: BTreeMap<(i16, i16, u8), Vec<u8>>,
    /// Caravan accounts (320 B, S1 layout + custody amendment).
    pub caravans: BTreeMap<CaravanKey, Vec<u8>>,
    pub exposure: BTreeMap<CaravanKey, Exposure>,
    /// Lot accounts (576 B).
    pub lots: BTreeMap<LotKey, Vec<u8>>,
    pub log: Vec<Event>,
}

/// Bells from `a` to `b` (stands for the walk: 2 + the province distance).
pub fn travel_bells(a: &PlaceRef, b: &PlaceRef) -> u32 {
    2 + (a.p - b.p).unsigned_abs() as u32 + (a.q - b.q).unsigned_abs() as u32
}

// ------------------------------------------------------------ account views

fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn wr_i64(d: &mut [u8], o: usize, v: i64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
fn rd_u64(d: &[u8], o: usize) -> u64 {
    rd_i64(d, o) as u64
}
fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn key_at(d: &[u8], o: usize) -> Key {
    d[o..o + 32].try_into().unwrap()
}
fn place_at(d: &[u8], o: usize) -> PlaceRef {
    PlaceRef {
        kind: d[o + PL::KIND],
        p: i16::from_le_bytes([d[o + PL::P], d[o + PL::P + 1]]),
        q: i16::from_le_bytes([d[o + PL::Q], d[o + PL::Q + 1]]),
        at: d[o + PL::SITE_OR_TILE],
        gen: d[o + PL::GEN],
        tile: d[o + PL::TILE],
    }
}
fn put_place(d: &mut [u8], o: usize, p: &PlaceRef) {
    d[o..o + 16].fill(0);
    d[o + PL::KIND] = p.kind;
    d[o + PL::P..o + PL::P + 2].copy_from_slice(&p.p.to_le_bytes());
    d[o + PL::Q..o + PL::Q + 2].copy_from_slice(&p.q.to_le_bytes());
    d[o + PL::SITE_OR_TILE] = p.at;
    d[o + PL::GEN] = p.gen;
    d[o + PL::TILE] = p.tile;
}

/// The kernel's view of a vault account.
pub fn vault_view(d: &[u8]) -> VaultView {
    let mut stores = [0i64; RESOURCES];
    let mut quota = [0i64; RESOURCES];
    for r in 0..RESOURCES {
        stores[r] = rd_i64(d, VA::store(r));
        quota[r] = rd_i64(d, VC::CUSTODY_QUOTA + 8 * r);
    }
    VaultView {
        p: i16::from_le_bytes([d[VA::P], d[VA::P + 1]]),
        q: i16::from_le_bytes([d[VA::Q], d[VA::Q + 1]]),
        tile: d[VA::TILE],
        gen: d[VA::GEN],
        live: d[VA::STATE] == VA::STATE_LIVE,
        owner: key_at(d, VA::OWNER_CITIZEN),
        owner_tag: rd_u64(d, VA::OWNER_TAG),
        stores,
        cap: rd_i64(d, VA::CAP),
        quota,
        lots: u16::from_le_bytes([d[VC::CUSTODY_LOTS], d[VC::CUSTODY_LOTS + 1]]),
    }
}

/// Writes back what the kernel may change of a vault: stores, quota, lots.
fn put_vault_view(d: &mut [u8], v: &VaultView) {
    for r in 0..RESOURCES {
        wr_i64(d, VA::store(r), v.stores[r]);
        wr_i64(d, VC::CUSTODY_QUOTA + 8 * r, v.quota[r]);
    }
    d[VC::CUSTODY_LOTS..VC::CUSTODY_LOTS + 2].copy_from_slice(&v.lots.to_le_bytes());
}

/// The fields of a caravan account the model reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaravanView {
    pub owner: Key,
    pub owner_tag: u64,
    pub seq: u32,
    pub faction: u8,
    pub state: u8,
    pub src: PlaceRef,
    pub dst: PlaceRef,
    /// The arrival, in bells (the program's `ARRIVE_TS`).
    pub arrive_bell: u32,
    pub cargo: [i64; RESOURCES],
    pub custody: u8,
    pub custody_resource: u8,
    pub custody_owner_tag: u64,
    pub taken_by_tag: u64,
}

impl CaravanView {
    pub fn decode(d: &[u8]) -> CaravanView {
        let mut cargo = [0i64; RESOURCES];
        for (r, c) in cargo.iter_mut().enumerate() {
            *c = rd_i64(d, CV::cargo(r));
        }
        CaravanView {
            owner: key_at(d, CV::OWNER_CITIZEN),
            owner_tag: rd_u64(d, CV::OWNER_TAG),
            seq: rd_u32(d, CV::SEQ),
            faction: d[CV::FACTION],
            state: d[CV::STATE],
            src: place_at(d, CV::SRC),
            dst: place_at(d, CV::DST),
            arrive_bell: rd_i64(d, CV::ARRIVE_TS) as u32,
            cargo,
            custody: d[CC::CUSTODY],
            custody_resource: d[CC::CUSTODY_RESOURCE],
            custody_owner_tag: rd_u64(d, CC::CUSTODY_OWNER_TAG),
            taken_by_tag: rd_u64(d, CC::TAKEN_BY_TAG),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut d = vec![0u8; CV::SIZE];
        d[..8].copy_from_slice(&CV::MAGIC);
        d[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32].copy_from_slice(&self.owner);
        wr_i64(&mut d, CV::OWNER_TAG, self.owner_tag as i64);
        d[CV::SEQ..CV::SEQ + 4].copy_from_slice(&self.seq.to_le_bytes());
        d[CV::FACTION] = self.faction;
        d[CV::STATE] = self.state;
        put_place(&mut d, CV::SRC, &self.src);
        put_place(&mut d, CV::DST, &self.dst);
        wr_i64(&mut d, CV::ARRIVE_TS, self.arrive_bell as i64);
        for r in 0..RESOURCES {
            wr_i64(&mut d, CV::cargo(r), self.cargo[r]);
        }
        d[CC::CUSTODY] = self.custody;
        d[CC::CUSTODY_RESOURCE] = self.custody_resource;
        wr_i64(&mut d, CC::CUSTODY_OWNER_TAG, self.custody_owner_tag as i64);
        wr_i64(&mut d, CC::TAKEN_BY_TAG, self.taken_by_tag as i64);
        d
    }
}

// ------------------------------------------------------------ the world

impl Default for World {
    fn default() -> World {
        World::new()
    }
}

impl World {
    pub fn new() -> World {
        World {
            bell: 1,
            boundaries: 0,
            citizens: BTreeMap::new(),
            holdings: BTreeMap::new(),
            vaults: BTreeMap::new(),
            caravans: BTreeMap::new(),
            exposure: BTreeMap::new(),
            lots: BTreeMap::new(),
            log: Vec::new(),
        }
    }

    /// Runs `f` as one transaction: all or nothing.
    pub fn atomic<T>(&mut self, f: impl FnOnce(&mut World) -> MResult<T>) -> MResult<T> {
        let mut w = self.clone();
        let out = f(&mut w)?;
        *self = w;
        Ok(out)
    }

    // -------------------------------------------------------- setup (fixtures)

    /// A citizen with a home holding at (p, q) site 0 holding `stock`.
    pub fn add_citizen(
        &mut self,
        name: u8,
        faction: u8,
        p: i16,
        q: i16,
        stock: [i64; RESOURCES],
    ) -> Key {
        let key = [name; 32];
        let home = PlaceRef {
            kind: PL::KIND_HOLDING,
            p,
            q,
            at: 0,
            gen: 1,
            tile: 30,
        };
        self.citizens.insert(
            key,
            Citizen {
                key,
                tag: 0x1000 + name as u64,
                faction,
                caravans: 0,
                vaults: 0,
                home,
            },
        );
        self.holdings.insert(
            home,
            Holding {
                place: home,
                owner: key,
                stores: stock,
            },
        );
        key
    }

    /// A live vault of `owner` at (p, q, tile) with capacity `cap` (milli),
    /// as BuildVault leaves it (cost not modelled).
    pub fn add_vault(&mut self, owner: Key, p: i16, q: i16, tile: u8, cap: i64) -> PlaceRef {
        let c = self.citizens.get_mut(&owner).expect("citizen");
        c.vaults += 1;
        let mut d = vec![0u8; VA::SIZE];
        d[..8].copy_from_slice(&VA::MAGIC);
        d[VA::P..VA::P + 2].copy_from_slice(&p.to_le_bytes());
        d[VA::Q..VA::Q + 2].copy_from_slice(&q.to_le_bytes());
        d[VA::TILE] = tile;
        d[VA::STATE] = VA::STATE_LIVE;
        d[VA::FACTION] = c.faction;
        d[VA::GEN] = 1;
        d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&owner);
        wr_i64(&mut d, VA::OWNER_TAG, c.tag as i64);
        wr_i64(&mut d, VA::CAP, cap);
        self.vaults.insert((p, q, tile), d);
        PlaceRef::vault(p, q, tile, 1)
    }

    pub fn citizen(&self, k: &Key) -> MResult<&Citizen> {
        self.citizens.get(k).ok_or(Error::NotFound)
    }

    pub fn tag(&self, k: &Key) -> u64 {
        self.citizens[k].tag
    }

    pub fn vault(&self, at: &PlaceRef) -> MResult<VaultView> {
        self.vaults
            .get(&(at.p, at.q, at.tile))
            .map(|d| vault_view(d))
            .ok_or(Error::NotFound)
    }

    pub fn lot(&self, k: &LotKey) -> MResult<Lot> {
        self.lots
            .get(k)
            .and_then(|d| Lot::decode(d))
            .ok_or(Error::NotFound)
    }

    pub fn caravan(&self, k: &CaravanKey) -> MResult<CaravanView> {
        self.caravans
            .get(k)
            .map(|d| CaravanView::decode(d))
            .ok_or(Error::NotFound)
    }

    fn put_lot(&mut self, k: LotKey, l: &Lot) {
        let mut d = vec![0u8; LL::SIZE];
        l.encode(&mut d).expect("size");
        self.lots.insert(k, d);
    }

    fn put_vault(&mut self, v: &VaultView) {
        let d = self.vaults.get_mut(&(v.p, v.q, v.tile)).expect("vault");
        put_vault_view(d, v);
    }

    fn actor(&self, s: &Signer) -> MResult<Actor> {
        let c = self.citizen(&s.citizen)?;
        Ok(Actor {
            citizen: c.key,
            tag: c.tag,
            by_session: s.session,
        })
    }

    /// The live place `pl` names (holding or vault of that generation): its
    /// owner.
    fn place_owner(&self, pl: &PlaceRef) -> Option<Key> {
        match pl.kind {
            PL::KIND_HOLDING => self.holdings.get(pl).map(|h| h.owner),
            PL::KIND_VAULT => self
                .vault(pl)
                .ok()
                .filter(|v| v.live && v.gen == pl.gen)
                .map(|v| v.owner),
            _ => None,
        }
    }

    fn lot_key(place: PlaceRef, owner_tag: u64, resource: u8) -> LotKey {
        (place, owner_tag, resource)
    }

    pub fn advance(&mut self, bells: u32) {
        self.bell += bells;
    }

    /// A period boundary (a war period closes, a scoring window turns).
    /// **Not a Period model**: workstreams 4 and 8 own what a period is and
    /// what it settles. Here it is only an event custody must not react to:
    /// no lot, order, reservation or caravan reads it, so crossing it can
    /// neither freeze, forfeit nor release anything (`tests/continuity.rs`).
    pub fn boundary(&mut self) {
        self.boundaries += 1;
        self.log.push(Event::Boundary {
            n: self.boundaries,
            bell: self.bell,
        });
    }

    /// Bytes of the whole world (a keeper or herald restart reads accounts
    /// again from the chain; here the same bytes come back).
    pub fn snapshot(&self) -> Vec<u8> {
        wire::write(self)
    }

    pub fn restore(b: &[u8]) -> World {
        wire::read(b).expect("snapshot")
    }

    // -------------------------------------------------------- S1 instructions (as on 4cd901de)

    /// SendCaravan (0xB1): from the actor's own place (general stock) to a
    /// live place. A send to another player needs the wallet.
    pub fn send_caravan(
        &mut self,
        s: &Signer,
        src: PlaceRef,
        dst: PlaceRef,
        cargo: [i64; RESOURCES],
    ) -> MResult<CaravanKey> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            if cargo.iter().any(|&c| c < 0) || cargo.iter().all(|&c| c == 0) {
                return Err(Error::BadData);
            }
            if w.place_owner(&src) != Some(a.citizen) {
                return Err(Error::NotOwner);
            }
            let dst_owner = w.place_owner(&dst).ok_or(Error::BadData)?;
            if src == dst {
                return Err(Error::BadData);
            }
            if dst_owner != a.citizen && s.session {
                return Err(Error::WalletRequired);
            }
            w.debit_general(&src, &cargo)?;
            Ok(w.new_caravan(&a, src, dst, cargo, None))
        })
    }

    fn debit_general(&mut self, src: &PlaceRef, cargo: &[i64; RESOURCES]) -> MResult<()> {
        match src.kind {
            PL::KIND_HOLDING => {
                let h = self.holdings.get_mut(src).ok_or(Error::NotFound)?;
                for r in 0..RESOURCES {
                    if h.stores[r] < cargo[r] {
                        return Err(Error::Insufficient);
                    }
                }
                for r in 0..RESOURCES {
                    h.stores[r] -= cargo[r];
                }
            }
            _ => {
                // A vault source: `STORES` only. The lots' goods are not in
                // it, so they cannot be sent, sold or lent from here.
                let mut v = self.vault(src)?;
                for r in 0..RESOURCES {
                    if v.stores[r] < cargo[r] {
                        return Err(Error::Insufficient);
                    }
                    v.stores[r] -= cargo[r];
                }
                self.put_vault(&v);
            }
        }
        Ok(())
    }

    /// Creates a caravan of `carrier` (its sequence, its faction).
    fn new_caravan(
        &mut self,
        carrier: &Actor,
        src: PlaceRef,
        dst: PlaceRef,
        cargo: [i64; RESOURCES],
        custody: Option<(u64, u8)>,
    ) -> CaravanKey {
        let c = self.citizens.get_mut(&carrier.citizen).expect("citizen");
        let seq = c.caravans;
        c.caravans += 1;
        let key = (c.tag, seq);
        let view = CaravanView {
            owner: c.key,
            owner_tag: c.tag,
            seq,
            faction: c.faction,
            state: CV::STATE_MOVING,
            src,
            dst,
            arrive_bell: self.bell + travel_bells(&src, &dst),
            cargo,
            custody: if custody.is_some() {
                CC::CUSTODY_LOT
            } else {
                CC::NONE
            },
            custody_resource: custody.map_or(0, |c| c.1),
            custody_owner_tag: custody.map_or(0, |c| c.0),
            taken_by_tag: 0,
        };
        self.caravans.insert(key, view.encode());
        self.exposure.insert(key, Exposure::default());
        self.log.push(Event::CaravanSent {
            caravan: key,
            owner: view.owner_tag,
            custody: custody.is_some(),
        });
        key
    }

    /// SettleCaravan (0xB2), permissionless, after arrival. **Amended**:
    /// refuses a custody caravan (its cargo is not the destination's), and
    /// fills a vault's general stock only to `CAP − CUSTODY_QUOTA`.
    pub fn settle_caravan(&mut self, k: CaravanKey) -> MResult<()> {
        self.atomic(|w| {
            let cv = w.caravan(&k)?;
            if cv.state != CV::STATE_MOVING {
                return Err(Error::AlreadyDone);
            }
            if cv.custody == CC::CUSTODY_LOT {
                return Err(Error::CustodyCaravan);
            }
            w.check_arrived(&k, &cv)?;
            let mut credited = [0i64; RESOURCES];
            let live = w.place_owner(&cv.dst).is_some();
            if live {
                match cv.dst.kind {
                    PL::KIND_HOLDING => {
                        let h = w.holdings.get_mut(&cv.dst).ok_or(Error::NotFound)?;
                        for r in 0..RESOURCES {
                            h.stores[r] = h.stores[r].saturating_add(cv.cargo[r]);
                            credited[r] = cv.cargo[r];
                        }
                    }
                    _ => {
                        let mut v = w.vault(&cv.dst)?;
                        for r in 0..RESOURCES {
                            let have = v.stores[r];
                            let to = have.saturating_add(cv.cargo[r]).min(v.general_cap(r));
                            credited[r] = to - have;
                            v.stores[r] = to;
                        }
                        w.put_vault(&v);
                    }
                }
            }
            w.log.push(Event::CaravanSettled {
                caravan: k,
                delivered: live,
                cargo: cv.cargo,
                credited,
            });
            w.caravans.remove(&k);
            w.exposure.remove(&k);
            Ok(())
        })
    }

    fn check_arrived(&self, k: &CaravanKey, cv: &CaravanView) -> MResult<()> {
        if self.bell < cv.arrive_bell {
            return Err(Error::Early);
        }
        if self.exposure.get(k).is_some_and(|e| e.raid_open.is_some()) {
            return Err(Error::RaidState);
        }
        Ok(())
    }

    /// The clash of a bell before arrival found a hostile host on the
    /// caravan's tile (or RaidDomestic): the raid opens. The model checks
    /// only that the raider is not the carrier.
    pub fn open_raid(&mut self, k: CaravanKey, raider: Key) -> MResult<()> {
        self.atomic(|w| {
            let cv = w.caravan(&k)?;
            w.citizen(&raider)?;
            if cv.state != CV::STATE_MOVING || w.bell >= cv.arrive_bell || raider == cv.owner {
                return Err(Error::RaidState);
            }
            let e = w.exposure.get_mut(&k).ok_or(Error::NotFound)?;
            if e.raid_open.is_some() {
                return Err(Error::RaidState);
            }
            e.raid_open = Some(raider);
            Ok(())
        })
    }

    /// RaidCaravan (0xB3) / DefaultRaid (0xB6). Take (J2): the caravan, its
    /// cargo included, becomes the raider's and heads for `home` (the
    /// raider's place). **Amended**: a custody caravan's mark becomes
    /// `CUSTODY_TAKEN` (its lot logs the loss at ReconcileLot). Burn: the
    /// cargo is destroyed and the empty caravan goes on.
    pub fn settle_raid(&mut self, s: Option<&Signer>, k: CaravanKey, take: bool) -> MResult<()> {
        self.atomic(|w| {
            let mut cv = w.caravan(&k)?;
            let raider = w
                .exposure
                .get(&k)
                .and_then(|e| e.raid_open)
                .ok_or(Error::RaidState)?;
            if let Some(s) = s {
                if s.citizen != raider {
                    return Err(Error::NotOwner);
                }
            }
            let rc = w.citizen(&raider)?.clone();
            if take {
                let home = rc.home;
                cv.owner = rc.key;
                cv.faction = rc.faction;
                cv.src = PlaceRef { kind: 3, ..cv.dst };
                cv.dst = home;
                cv.arrive_bell = w.bell + travel_bells(&cv.src, &home);
                if cv.custody == CC::CUSTODY_LOT {
                    cv.custody = CC::CUSTODY_TAKEN;
                    cv.taken_by_tag = rc.tag;
                }
            } else {
                cv.cargo = [0; RESOURCES];
            }
            w.caravans.insert(k, cv.encode());
            w.exposure.insert(k, Exposure::default());
            w.log.push(Event::CaravanRaided {
                caravan: k,
                take,
                raider: rc.tag,
            });
            Ok(())
        })
    }

    /// SeizeVault (0xB4): the captor's host stands on the vault and none of
    /// the owner's (not modelled). Owner, tag, faction change; `GEN += 1`;
    /// the goods stay.
    pub fn seize_vault(&mut self, s: &Signer, at: PlaceRef) -> MResult<PlaceRef> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let captor = w.citizen(&a.citizen)?.clone();
            let d = w
                .vaults
                .get_mut(&(at.p, at.q, at.tile))
                .ok_or(Error::NotFound)?;
            let prev = key_at(d, VA::OWNER_CITIZEN);
            if d[VA::STATE] != VA::STATE_LIVE || prev == captor.key {
                return Err(Error::BadData);
            }
            let prev_tag = rd_u64(d, VA::OWNER_TAG);
            let gen = d[VA::GEN].checked_add(1).ok_or(Error::BadData)?;
            d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&captor.key);
            wr_i64(d, VA::OWNER_TAG, captor.tag as i64);
            d[VA::FACTION] = captor.faction;
            d[VA::GEN] = gen;
            let place = PlaceRef::vault(at.p, at.q, at.tile, gen);
            w.citizens.get_mut(&captor.key).unwrap().vaults += 1;
            if let Some(o) = w.citizens.get_mut(&prev) {
                o.vaults = o.vaults.saturating_sub(1);
            }
            w.log.push(Event::VaultSeized {
                vault: place,
                captor: captor.tag,
                prev: prev_tag,
            });
            Ok(place)
        })
    }

    /// CloseVault (0xB5), the owner's wallet, an empty vault. **Amended**:
    /// also no lot (`CUSTODY_LOTS == 0`): a custodian cannot close the
    /// vault under its depositors' goods (EVE Frontier's unanchor burns
    /// the inventories of others; this refuses instead).
    pub fn close_vault(&mut self, s: &Signer, at: PlaceRef) -> MResult<()> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            if s.session {
                return Err(Error::WalletRequired);
            }
            let v = w.vault(&at)?;
            if v.owner != a.citizen {
                return Err(Error::NotOwner);
            }
            if v.stores.iter().any(|&x| x != 0) || v.lots != 0 || v.quota.iter().any(|&x| x != 0) {
                return Err(Error::NotEmpty);
            }
            w.vaults.remove(&(at.p, at.q, at.tile));
            w.citizens.get_mut(&a.citizen).unwrap().vaults -= 1;
            Ok(())
        })
    }

    // -------------------------------------------------------- custody instructions

    /// OpenLot: the custodian (vault owner, wallet) opens a lot for `owner`.
    pub fn open_lot(
        &mut self,
        s: &Signer,
        vault: PlaceRef,
        owner: Key,
        resource: u8,
        quota: i64,
    ) -> MResult<LotKey> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let o = w.citizen(&owner)?.clone();
            let mut v = w.vault(&vault)?;
            if v.gen != vault.gen {
                return Err(Error::BadData);
            }
            let key = World::lot_key(v.place(), o.tag, resource);
            if w.lots.contains_key(&key) {
                return Err(Error::BadData);
            }
            let lot = k::open(
                &mut v,
                &a,
                (o.key, o.tag),
                resource,
                quota,
                w.bell,
                a.citizen,
            )?;
            w.put_vault(&v);
            w.put_lot(key, &lot);
            w.log.push(Event::LotOpened {
                lot: key,
                custodian: a.tag,
                quota,
            });
            Ok(key)
        })
    }

    pub fn set_quota(&mut self, s: &Signer, lot: LotKey, quota: i64) -> MResult<()> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let mut l = w.lot(&lot)?;
            let mut v = w.vault(&lot.0)?;
            k::set_quota(&mut v, &mut l, &a, quota)?;
            w.put_vault(&v);
            w.put_lot(lot, &l);
            w.log.push(Event::QuotaSet { lot, quota });
            Ok(())
        })
    }

    /// DepositLot: the owner (wallet: the vault is another's) sends goods
    /// of its general stock from its own place to its lot, on a custody
    /// caravan it carries itself. Room is reserved at departure.
    pub fn deposit(
        &mut self,
        s: &Signer,
        seq: u32,
        src: PlaceRef,
        lot: LotKey,
        qty: i64,
        wear_bps: u16,
    ) -> MResult<CaravanKey> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            w.expect_seq(&a, seq)?;
            if a.by_session {
                return Err(Error::WalletRequired);
            }
            let mut l = w.lot(&lot)?;
            if l.owner != a.citizen {
                return Err(CustodyError::NotAuthorized.into());
            }
            if w.place_owner(&src) != Some(a.citizen) {
                return Err(Error::NotOwner);
            }
            let r = l.resource as usize;
            if qty <= 0 || qty % MILLI != 0 {
                return Err(CustodyError::Quantity.into());
            }
            let mut cargo = [0i64; RESOURCES];
            cargo[r] = qty;
            w.debit_general(&src, &cargo)?;
            let kept = wear_i64(qty, wear_bps);
            let v = w.vault(&lot.0)?;
            let ck = w.peek_caravan_key(&a.citizen);
            k::begin_inbound(&v, &mut l, ck, kept)?;
            cargo[r] = kept;
            let got = w.new_caravan(&a, src, lot.0, cargo, Some((l.owner_tag, l.resource)));
            debug_assert_eq!(got, ck);
            w.put_lot(lot, &l);
            w.log.push(Event::Deposited {
                lot,
                caravan: ck,
                sent: qty,
                worn: qty - kept,
            });
            w.log_loss(
                l.owner_tag,
                l.resource,
                Loss::Worn,
                qty - kept,
                0,
                Some(lot),
                Some(ck),
            );
            Ok(ck)
        })
    }

    /// SendCaravan's replay guard (`x.seq != Citizen.CARAVANS` is
    /// `BadData`): a resent request names a sequence already used.
    fn expect_seq(&self, a: &Actor, seq: u32) -> MResult<()> {
        if self.citizen(&a.citizen)?.caravans != seq {
            return Err(Error::Custody(CustodyError::Stale));
        }
        Ok(())
    }

    /// The next caravan sequence of `who` (what a client puts in `seq`).
    pub fn next_seq(&self, who: &Key) -> u32 {
        self.citizens[who].caravans
    }

    fn peek_caravan_key(&self, carrier: &Key) -> CaravanKey {
        let c = &self.citizens[carrier];
        (c.tag, c.caravans)
    }

    #[allow(clippy::too_many_arguments)]
    fn log_loss(
        &mut self,
        owner: u64,
        resource: u8,
        cause: Loss,
        qty: i64,
        to: u64,
        lot: Option<LotKey>,
        caravan: Option<CaravanKey>,
    ) {
        if qty > 0 {
            self.log.push(Event::Loss {
                owner,
                resource,
                cause,
                qty,
                to,
                lot,
                caravan,
            });
        }
    }

    /// SetOrder: the owner reserves goods for a carrier or a user.
    pub fn set_order(
        &mut self,
        s: &Signer,
        lot: LotKey,
        slot: u8,
        nonce: u32,
        spec: OrderSpec,
    ) -> MResult<u32> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let g = w.citizen(&spec.grantee)?.tag;
            let mut l = w.lot(&lot)?;
            let v = w.vault(&lot.0)?;
            if spec.kind == ORDER_SHIP {
                // The destination exists now, of that generation.
                let dv = w.vault(&spec.dst).map_err(|_| Error::BadData)?;
                if !dv.live || dv.gen != spec.dst.gen {
                    return Err(Error::BadData);
                }
            }
            let id = k::set_order(&v, &mut l, &a, slot, nonce, &spec, w.bell)?;
            w.put_lot(lot, &l);
            w.log.push(Event::OrderSet {
                lot,
                slot,
                id,
                kind: spec.kind,
                grantee: g,
                qty: spec.qty,
                expires_bell: spec.expires_bell,
            });
            Ok(id)
        })
    }

    pub fn revoke_order(&mut self, s: &Signer, lot: LotKey, slot: u8, id: u32) -> MResult<i64> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let mut l = w.lot(&lot)?;
            let released = k::revoke_order(&mut l, &a, slot, id, w.bell)?;
            w.put_lot(lot, &l);
            w.log.push(Event::OrderRevoked {
                lot,
                slot,
                id,
                released,
            });
            Ok(released)
        })
    }

    /// ShipLot: `qty` leaves `from` for another lot of the same owner (a
    /// custody caravan of the signer: the owner, or the carrier of a ship
    /// order) or for the owner's own place (an ordinary caravan of the
    /// owner: a withdrawal into its general stock).
    #[allow(clippy::too_many_arguments)]
    pub fn ship(
        &mut self,
        s: &Signer,
        seq: u32,
        from: LotKey,
        by: By,
        qty: i64,
        to: ShipTo,
        wear_bps: u16,
    ) -> MResult<CaravanKey> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            w.expect_seq(&a, seq)?;
            let mut l = w.lot(&from)?;
            let v = w.vault(&from.0)?;
            k::spend_ship(&v, &mut l, &a, by, qty, to, w.bell)?;
            let r = l.resource as usize;
            let kept = wear_i64(qty, wear_bps);
            let mut cargo = [0i64; RESOURCES];
            cargo[r] = kept;
            let (ck, to_lot) = match to {
                ShipTo::Lot(dst) => {
                    let tk = World::lot_key(dst, l.owner_tag, l.resource);
                    let mut tl = w.lot(&tk).map_err(|_| CustodyError::Order)?;
                    let tv = w.vault(&dst)?;
                    let ck = w.peek_caravan_key(&a.citizen);
                    k::begin_inbound(&tv, &mut tl, ck, kept)?;
                    w.put_lot(tk, &tl);
                    let got =
                        w.new_caravan(&a, from.0, dst, cargo, Some((l.owner_tag, l.resource)));
                    debug_assert_eq!(got, ck);
                    (ck, Some(tk))
                }
                ShipTo::OwnPlace(dst) => {
                    if w.place_owner(&dst) != Some(l.owner) {
                        return Err(Error::NotOwner);
                    }
                    (w.new_caravan(&a, from.0, dst, cargo, None), None)
                }
            };
            w.put_lot(from, &l);
            w.log.push(Event::Shipped {
                from,
                caravan: ck,
                sent: qty,
                worn: qty - kept,
                to_lot,
                by_order: match by {
                    By::Owner => None,
                    By::Order { id, .. } => Some(id),
                },
                carrier: a.tag,
            });
            w.log_loss(
                l.owner_tag,
                l.resource,
                Loss::Worn,
                qty - kept,
                0,
                Some(from),
                Some(ck),
            );
            Ok(ck)
        })
    }

    /// SettleCustody: permissionless, after arrival and with no raid open:
    /// the custody caravan's cargo goes to its lot (or is lost if the vault
    /// was seized). The caravan closes.
    pub fn settle_custody(&mut self, k: CaravanKey) -> MResult<Settlement> {
        self.atomic(|w| {
            let cv = w.caravan(&k)?;
            if cv.state != CV::STATE_MOVING {
                return Err(Error::AlreadyDone);
            }
            if cv.custody != CC::CUSTODY_LOT {
                return Err(Error::CustodyCaravan);
            }
            w.check_arrived(&k, &cv)?;
            let lk = World::lot_key(cv.dst, cv.custody_owner_tag, cv.custody_resource);
            let mut l = w.lot(&lk)?;
            let v = w.vault(&cv.dst).ok();
            let st = k::finish_inbound(
                v.as_ref(),
                &mut l,
                k,
                cv.cargo[cv.custody_resource as usize],
            )?;
            w.put_lot(lk, &l);
            w.log.push(Event::Settled {
                lot: lk,
                caravan: k,
                delivered: st.delivered,
                burned: st.burned,
                dest_gone: st.dest_gone,
            });
            let raider = 0;
            w.log_loss(
                l.owner_tag,
                l.resource,
                Loss::Burned,
                st.burned,
                raider,
                Some(lk),
                Some(k),
            );
            let holder = v.map_or(0, |v| v.owner_tag);
            w.log_loss(
                l.owner_tag,
                l.resource,
                Loss::DestinationGone,
                st.dest_gone,
                holder,
                Some(lk),
                Some(k),
            );
            w.caravans.remove(&k);
            w.exposure.remove(&k);
            Ok(st)
        })
    }

    /// ReconcileLot (permissionless): forfeits a lot whose vault was seized,
    /// and drops the inbound refs of caravans taken on the way.
    pub fn reconcile(&mut self, lot: LotKey) -> MResult<()> {
        self.atomic(|w| {
            let mut l = w.lot(&lot)?;
            let mut changed = false;
            if let Ok(mut v) = w.vault(&lot.0) {
                if l.state == LOT_OPEN && v.gen != l.vault_gen {
                    let f = k::forfeit(&mut v, &mut l)?;
                    w.put_vault(&v);
                    w.log_loss(
                        l.owner_tag,
                        l.resource,
                        Loss::Seized,
                        f.qty,
                        f.captor_tag,
                        Some(lot),
                        None,
                    );
                    changed = true;
                }
            }
            for i in 0..MAX_INBOUND {
                let ib = l.inbound[i];
                if !ib.live {
                    continue;
                }
                let ck = (ib.caravan_tag, ib.seq);
                let seen = match w.caravan(&ck) {
                    Err(_) => CaravanSeen::Absent,
                    Ok(c) if c.custody == CC::CUSTODY_TAKEN => CaravanSeen::Taken,
                    Ok(_) => CaravanSeen::Custody,
                };
                if seen == CaravanSeen::Custody {
                    continue;
                }
                // The taker, while the caravan stands (0 once it closed:
                // CARAVAN_RAIDED names it in the log).
                let raider = w.caravan(&ck).map_or(0, |c| c.taken_by_tag);
                let q = k::drop_inbound(&mut l, ck, seen)?;
                w.log_loss(
                    l.owner_tag,
                    l.resource,
                    Loss::Raided,
                    q,
                    raider,
                    Some(lot),
                    Some(ck),
                );
                changed = true;
            }
            if !changed {
                return Err(Error::Custody(CustodyError::State));
            }
            w.put_lot(lot, &l);
            Ok(())
        })
    }

    /// ConsumeLot: a use order's grantee uses goods up.
    pub fn consume(
        &mut self,
        s: &Signer,
        lot: LotKey,
        slot: u8,
        id: u32,
        qty: i64,
        purpose: u16,
    ) -> MResult<()> {
        self.atomic(|w| {
            let a = w.actor(s)?;
            let mut l = w.lot(&lot)?;
            let v = w.vault(&lot.0)?;
            k::consume(&v, &mut l, &a, slot, id, qty, purpose, w.bell)?;
            w.put_lot(lot, &l);
            w.log.push(Event::Consumed {
                lot,
                id,
                user: a.tag,
                qty,
                purpose,
            });
            Ok(())
        })
    }

    /// CloseLot.
    pub fn close_lot(&mut self, s: Option<&Signer>, lot: LotKey) -> MResult<()> {
        self.atomic(|w| {
            let a = match s {
                Some(s) => Some(w.actor(s)?),
                None => None,
            };
            let mut l = w.lot(&lot)?;
            let mut v = w.vault(&lot.0).ok();
            k::close(v.as_mut(), &mut l, a.as_ref(), w.bell)?;
            if let Some(v) = v {
                if l.vault_gen == v.gen {
                    w.put_vault(&v);
                }
            }
            w.lots.remove(&lot);
            w.log.push(Event::LotClosed { lot });
            Ok(())
        })
    }

    // -------------------------------------------------------- what is where

    /// Where `owner`'s custody goods are now (`Whereabouts`).
    pub fn whereabouts(&self, owner_tag: u64) -> Vec<Whereabouts> {
        let mut out = Vec::new();
        for (key, d) in &self.lots {
            if key.1 != owner_tag {
                continue;
            }
            let l = Lot::decode(d).expect("lot");
            let seized = self.vault(&key.0).map_or(true, |v| v.gen != l.vault_gen);
            if l.state == LOT_OPEN && l.held > 0 {
                if seized {
                    out.push(Whereabouts::Frozen {
                        lot: *key,
                        qty: l.held,
                        why: "vault seized: forfeiture pending (ReconcileLot)",
                    });
                } else {
                    out.push(Whereabouts::Held {
                        lot: *key,
                        held: l.held,
                        reserved: l.reserved(self.bell),
                    });
                }
            }
            for ib in l.inbound.iter().filter(|i| i.live) {
                let ck = (ib.caravan_tag, ib.seq);
                let w = match self.caravan(&ck) {
                    Ok(c) if c.custody == CC::CUSTODY_LOT => {
                        if self
                            .exposure
                            .get(&ck)
                            .is_some_and(|e| e.raid_open.is_some())
                        {
                            Whereabouts::Unknown {
                                lot: *key,
                                caravan: ck,
                                qty: ib.qty,
                                why: "raid open: take or burn undecided",
                            }
                        } else if self.bell >= c.arrive_bell {
                            Whereabouts::Unknown {
                                lot: *key,
                                caravan: ck,
                                qty: ib.qty,
                                why: "arrived, not settled",
                            }
                        } else {
                            Whereabouts::InTransit {
                                lot: *key,
                                caravan: ck,
                                qty: ib.qty,
                            }
                        }
                    }
                    _ => Whereabouts::Unknown {
                        lot: *key,
                        caravan: ck,
                        qty: ib.qty,
                        why: "taken by a raider: loss confirmed at ReconcileLot",
                    },
                };
                out.push(w);
            }
        }
        out
    }

    /// The confirmed losses of `owner`, by cause.
    pub fn losses(&self, owner_tag: u64) -> BTreeMap<Loss, i64> {
        let mut m = BTreeMap::new();
        for e in &self.log {
            if let Event::Loss {
                owner, cause, qty, ..
            } = e
            {
                if *owner == owner_tag {
                    *m.entry(*cause).or_insert(0) += qty;
                }
            }
        }
        m
    }

    /// The custody conservation law of one owner, from the log against the
    /// accounts: everything deposited is held, coming to a lot, withdrawn,
    /// used, or lost with a recorded cause. Returns `(deposited, accounted)`.
    pub fn custody_balance(&self, owner_tag: u64) -> (i64, i64) {
        let mut deposited = 0;
        let mut withdrawn = 0;
        let mut consumed = 0;
        let mut lost = 0;
        for e in &self.log {
            match e {
                Event::Deposited { lot, sent, .. } if lot.1 == owner_tag => deposited += sent,
                Event::Shipped {
                    from,
                    sent,
                    worn,
                    to_lot: None,
                    ..
                } if from.1 == owner_tag => withdrawn += sent - worn,
                Event::Consumed { lot, qty, .. } if lot.1 == owner_tag => consumed += qty,
                Event::Loss { owner, qty, .. } if *owner == owner_tag => lost += qty,
                _ => {}
            }
        }
        let mut held = 0;
        let mut coming = 0;
        for (key, d) in &self.lots {
            if key.1 == owner_tag {
                let l = Lot::decode(d).expect("lot");
                held += l.held;
                coming += l.incoming();
            }
        }
        (deposited, held + coming + withdrawn + consumed + lost)
    }

    /// Ends everything still open, as keepers eventually would: every open
    /// raid settled (DefaultRaid: a take), every caravan settled once it
    /// arrives, every lot reconciled. Returns the number of steps run.
    pub fn drain(&mut self) -> usize {
        let mut steps = 0;
        for _ in 0..64 {
            let mut moved = false;
            let open: Vec<CaravanKey> = self
                .exposure
                .iter()
                .filter(|(_, e)| e.raid_open.is_some())
                .map(|(k, _)| *k)
                .collect();
            for k in open {
                moved |= self.settle_raid(None, k, true).is_ok();
            }
            self.advance(8);
            let ks: Vec<CaravanKey> = self.caravans.keys().copied().collect();
            for k in ks {
                moved |= self.settle_custody(k).is_ok() || self.settle_caravan(k).is_ok();
            }
            let lots: Vec<LotKey> = self.lots.keys().copied().collect();
            for l in lots {
                moved |= self.reconcile(l).is_ok();
            }
            if moved {
                steps += 1;
            } else if self.caravans.is_empty() {
                break;
            }
        }
        steps
    }

    /// Every invariant the model checks after each step.
    pub fn check(&self) -> Result<(), String> {
        for (key, d) in &self.lots {
            let l = Lot::decode(d).ok_or("lot decode")?;
            if !l.balanced(self.bell) {
                return Err(format!("lot {key:?} out of balance: {l:?}"));
            }
        }
        for (at, d) in &self.vaults {
            let v = vault_view(d);
            let mut quota = [0i64; RESOURCES];
            let mut lots = 0u16;
            for (key, ld) in &self.lots {
                let l = Lot::decode(ld).unwrap();
                if (key.0.p, key.0.q, key.0.tile) == *at && l.state == LOT_OPEN {
                    quota[l.resource as usize] += l.quota;
                    lots += 1;
                }
            }
            if quota != v.quota || lots != v.lots {
                return Err(format!(
                    "vault {at:?} counts {:?}/{} != lots {:?}/{}",
                    v.quota, v.lots, quota, lots
                ));
            }
            for r in 0..RESOURCES {
                if v.stores[r] < 0 {
                    return Err(format!("vault {at:?} negative store"));
                }
                // The room promised to lots is never also the general
                // stock's: the reservation holds against every writer.
                if v.stores[r] + v.quota[r] > v.cap {
                    return Err(format!(
                        "vault {at:?} over-committed: stores {} + quota {} > cap {}",
                        v.stores[r], v.quota[r], v.cap
                    ));
                }
            }
        }
        // Every live reservation names exactly one caravan, which is still
        // custody for this lot, taken (pending ReconcileLot) or closed after
        // a take (pending ReconcileLot); no two lots expect one caravan.
        let mut expected = std::collections::BTreeMap::new();
        for (key, d) in &self.lots {
            let l = Lot::decode(d).unwrap();
            for ib in l.inbound.iter().filter(|i| i.live) {
                let ck = (ib.caravan_tag, ib.seq);
                if expected.insert(ck, *key).is_some() {
                    return Err(format!("caravan {ck:?} reserved twice"));
                }
                match self.caravan(&ck) {
                    Ok(c) if c.custody == CC::CUSTODY_LOT => {
                        let dst = World::lot_key(c.dst, c.custody_owner_tag, c.custody_resource);
                        if dst != *key {
                            return Err(format!(
                                "caravan {ck:?} reserved by {key:?}, bound for {dst:?}"
                            ));
                        }
                    }
                    Ok(c) if c.custody == CC::CUSTODY_TAKEN => {}
                    Ok(_) => {
                        return Err(format!("{key:?} reserves room for ordinary caravan {ck:?}"))
                    }
                    Err(_) => {
                        // Closed: only a taken caravan closes without
                        // SettleCustody (which clears the reservation).
                        let taken = self.log.iter().any(|e| {
                            matches!(e, Event::CaravanRaided { caravan, take: true, .. } if *caravan == ck)
                        });
                        if !taken {
                            return Err(format!(
                                "{key:?} reserves room for vanished caravan {ck:?}"
                            ));
                        }
                    }
                }
            }
        }
        for cv in self.caravans.values().map(|d| CaravanView::decode(d)) {
            if cv.custody == CC::CUSTODY_LOT {
                let lk = World::lot_key(cv.dst, cv.custody_owner_tag, cv.custody_resource);
                let l = self
                    .lot(&lk)
                    .map_err(|_| format!("custody caravan without its lot {lk:?}"))?;
                if !l.inbound.iter().any(|i| i.is(cv.owner_tag, cv.seq)) {
                    return Err(format!(
                        "custody caravan {:?} not expected by {lk:?}",
                        (cv.owner_tag, cv.seq)
                    ));
                }
            }
        }
        let owners: std::collections::BTreeSet<u64> = self
            .log
            .iter()
            .filter_map(|e| match e {
                Event::Deposited { lot, .. } => Some(lot.1),
                _ => None,
            })
            .collect();
        for o in owners {
            let (dep, acc) = self.custody_balance(o);
            if dep != acc {
                return Err(format!("owner {o:#x}: deposited {dep} != accounted {acc}"));
            }
        }
        Ok(())
    }
}
