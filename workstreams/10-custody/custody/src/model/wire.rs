//! The model world as bytes (a restart). Account buffers go as they are;
//! the model-only records (citizens, holdings, exposure, the log) get a
//! plain little-endian encoding. A restart that loses or changes a byte is
//! a test failure (`tests/restart.rs` compares worlds).

use std::collections::BTreeMap;

use permutation_rules::frontier::holding::RESOURCES;

use super::{CaravanKey, Citizen, Event, Exposure, Holding, LotKey, World};
use crate::lot::{Loss, PlaceRef};

struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i64(&mut self, v: i64) {
        self.u64(v as u64);
    }
    fn key(&mut self, k: &[u8; 32]) {
        self.0.extend_from_slice(k);
    }
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
    }
    fn place(&mut self, p: &PlaceRef) {
        self.0.extend_from_slice(&p.encode());
    }
    fn arr(&mut self, a: &[i64; RESOURCES]) {
        for v in a {
            self.i64(*v);
        }
    }
    fn lot(&mut self, k: &LotKey) {
        self.place(&k.0);
        self.u64(k.1);
        self.u8(k.2);
    }
    fn car(&mut self, k: &CaravanKey) {
        self.u64(k.0);
        self.u32(k.1);
    }
    fn opt_lot(&mut self, k: &Option<LotKey>) {
        match k {
            Some(k) => {
                self.u8(1);
                self.lot(k)
            }
            None => self.u8(0),
        }
    }
    fn opt_car(&mut self, k: &Option<CaravanKey>) {
        match k {
            Some(k) => {
                self.u8(1);
                self.car(k)
            }
            None => self.u8(0),
        }
    }
    fn opt_u32(&mut self, v: &Option<u32>) {
        match v {
            Some(v) => {
                self.u8(1);
                self.u32(*v)
            }
            None => self.u8(0),
        }
    }
}

struct R<'a>(&'a [u8], usize);

impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.0.get(self.1..self.1 + n)?;
        self.1 += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn i64(&mut self) -> Option<i64> {
        Some(self.u64()? as i64)
    }
    fn key(&mut self) -> Option<[u8; 32]> {
        self.take(32)?.try_into().ok()
    }
    fn bytes(&mut self) -> Option<Vec<u8>> {
        let n = self.u32()? as usize;
        Some(self.take(n)?.to_vec())
    }
    fn place(&mut self) -> Option<PlaceRef> {
        Some(PlaceRef::decode(self.take(8)?))
    }
    fn arr(&mut self) -> Option<[i64; RESOURCES]> {
        let mut a = [0i64; RESOURCES];
        for v in a.iter_mut() {
            *v = self.i64()?;
        }
        Some(a)
    }
    fn lot(&mut self) -> Option<LotKey> {
        Some((self.place()?, self.u64()?, self.u8()?))
    }
    fn car(&mut self) -> Option<CaravanKey> {
        Some((self.u64()?, self.u32()?))
    }
    fn opt_lot(&mut self) -> Option<Option<LotKey>> {
        Some(if self.u8()? == 1 {
            Some(self.lot()?)
        } else {
            None
        })
    }
    fn opt_car(&mut self) -> Option<Option<CaravanKey>> {
        Some(if self.u8()? == 1 {
            Some(self.car()?)
        } else {
            None
        })
    }
    fn opt_u32(&mut self) -> Option<Option<u32>> {
        Some(if self.u8()? == 1 {
            Some(self.u32()?)
        } else {
            None
        })
    }
}

fn loss_of(b: u8) -> Option<Loss> {
    Some(match b {
        1 => Loss::Worn,
        2 => Loss::Burned,
        3 => Loss::Raided,
        4 => Loss::DestinationGone,
        5 => Loss::Seized,
        _ => return None,
    })
}

pub fn write(w: &World) -> Vec<u8> {
    let mut o = W(Vec::new());
    o.0.extend_from_slice(b"WYCUST02");
    o.u32(w.bell);
    o.u32(w.boundaries);
    o.u32(w.citizens.len() as u32);
    for c in w.citizens.values() {
        o.key(&c.key);
        o.u64(c.tag);
        o.u8(c.faction);
        o.u32(c.caravans);
        o.u8(c.vaults);
        o.place(&c.home);
    }
    o.u32(w.holdings.len() as u32);
    for h in w.holdings.values() {
        o.place(&h.place);
        o.key(&h.owner);
        o.arr(&h.stores);
    }
    o.u32(w.vaults.len() as u32);
    for (k, d) in &w.vaults {
        o.0.extend_from_slice(&k.0.to_le_bytes());
        o.0.extend_from_slice(&k.1.to_le_bytes());
        o.u8(k.2);
        o.bytes(d);
    }
    o.u32(w.caravans.len() as u32);
    for (k, d) in &w.caravans {
        o.car(k);
        o.bytes(d);
    }
    o.u32(w.exposure.len() as u32);
    for (k, e) in &w.exposure {
        o.car(k);
        match e.raid_open {
            Some(r) => {
                o.u8(1);
                o.key(&r)
            }
            None => o.u8(0),
        }
    }
    o.u32(w.lots.len() as u32);
    for (k, d) in &w.lots {
        o.lot(k);
        o.bytes(d);
    }
    o.u32(w.log.len() as u32);
    for e in &w.log {
        event(&mut o, e);
    }
    o.0
}

fn event(o: &mut W, e: &Event) {
    match e {
        Event::LotOpened {
            lot,
            custodian,
            quota,
        } => {
            o.u8(1);
            o.lot(lot);
            o.u64(*custodian);
            o.i64(*quota);
        }
        Event::QuotaSet { lot, quota } => {
            o.u8(2);
            o.lot(lot);
            o.i64(*quota);
        }
        Event::Deposited {
            lot,
            caravan,
            sent,
            worn,
        } => {
            o.u8(3);
            o.lot(lot);
            o.car(caravan);
            o.i64(*sent);
            o.i64(*worn);
        }
        Event::Shipped {
            from,
            caravan,
            sent,
            worn,
            to_lot,
            by_order,
            carrier,
        } => {
            o.u8(4);
            o.lot(from);
            o.car(caravan);
            o.i64(*sent);
            o.i64(*worn);
            o.opt_lot(to_lot);
            o.opt_u32(by_order);
            o.u64(*carrier);
        }
        Event::Settled {
            lot,
            caravan,
            delivered,
            burned,
            dest_gone,
        } => {
            o.u8(5);
            o.lot(lot);
            o.car(caravan);
            o.i64(*delivered);
            o.i64(*burned);
            o.i64(*dest_gone);
        }
        Event::OrderSet {
            lot,
            slot,
            id,
            kind,
            grantee,
            qty,
            expires_bell,
        } => {
            o.u8(6);
            o.lot(lot);
            o.u8(*slot);
            o.u32(*id);
            o.u8(*kind);
            o.u64(*grantee);
            o.i64(*qty);
            o.u32(*expires_bell);
        }
        Event::OrderRevoked {
            lot,
            slot,
            id,
            released,
        } => {
            o.u8(7);
            o.lot(lot);
            o.u8(*slot);
            o.u32(*id);
            o.i64(*released);
        }
        Event::Consumed {
            lot,
            id,
            user,
            qty,
            purpose,
        } => {
            o.u8(8);
            o.lot(lot);
            o.u32(*id);
            o.u64(*user);
            o.i64(*qty);
            o.0.extend_from_slice(&purpose.to_le_bytes());
        }
        Event::Loss {
            owner,
            resource,
            cause,
            qty,
            to,
            lot,
            caravan,
        } => {
            o.u8(9);
            o.u64(*owner);
            o.u8(*resource);
            o.u8(*cause as u8);
            o.i64(*qty);
            o.u64(*to);
            o.opt_lot(lot);
            o.opt_car(caravan);
        }
        Event::LotClosed { lot } => {
            o.u8(10);
            o.lot(lot);
        }
        Event::CaravanSent {
            caravan,
            owner,
            custody,
        } => {
            o.u8(11);
            o.car(caravan);
            o.u64(*owner);
            o.u8(*custody as u8);
        }
        Event::CaravanSettled {
            caravan,
            delivered,
            cargo,
            credited,
        } => {
            o.u8(12);
            o.car(caravan);
            o.u8(*delivered as u8);
            o.arr(cargo);
            o.arr(credited);
        }
        Event::CaravanRaided {
            caravan,
            take,
            raider,
        } => {
            o.u8(13);
            o.car(caravan);
            o.u8(*take as u8);
            o.u64(*raider);
        }
        Event::Boundary { n, bell } => {
            o.u8(15);
            o.u32(*n);
            o.u32(*bell);
        }
        Event::VaultSeized {
            vault,
            captor,
            prev,
        } => {
            o.u8(14);
            o.place(vault);
            o.u64(*captor);
            o.u64(*prev);
        }
    }
}

fn read_event(r: &mut R) -> Option<Event> {
    Some(match r.u8()? {
        1 => Event::LotOpened {
            lot: r.lot()?,
            custodian: r.u64()?,
            quota: r.i64()?,
        },
        2 => Event::QuotaSet {
            lot: r.lot()?,
            quota: r.i64()?,
        },
        3 => Event::Deposited {
            lot: r.lot()?,
            caravan: r.car()?,
            sent: r.i64()?,
            worn: r.i64()?,
        },
        4 => Event::Shipped {
            from: r.lot()?,
            caravan: r.car()?,
            sent: r.i64()?,
            worn: r.i64()?,
            to_lot: r.opt_lot()?,
            by_order: r.opt_u32()?,
            carrier: r.u64()?,
        },
        5 => Event::Settled {
            lot: r.lot()?,
            caravan: r.car()?,
            delivered: r.i64()?,
            burned: r.i64()?,
            dest_gone: r.i64()?,
        },
        6 => Event::OrderSet {
            lot: r.lot()?,
            slot: r.u8()?,
            id: r.u32()?,
            kind: r.u8()?,
            grantee: r.u64()?,
            qty: r.i64()?,
            expires_bell: r.u32()?,
        },
        7 => Event::OrderRevoked {
            lot: r.lot()?,
            slot: r.u8()?,
            id: r.u32()?,
            released: r.i64()?,
        },
        8 => Event::Consumed {
            lot: r.lot()?,
            id: r.u32()?,
            user: r.u64()?,
            qty: r.i64()?,
            purpose: r.u16()?,
        },
        9 => Event::Loss {
            owner: r.u64()?,
            resource: r.u8()?,
            cause: loss_of(r.u8()?)?,
            qty: r.i64()?,
            to: r.u64()?,
            lot: r.opt_lot()?,
            caravan: r.opt_car()?,
        },
        10 => Event::LotClosed { lot: r.lot()? },
        11 => Event::CaravanSent {
            caravan: r.car()?,
            owner: r.u64()?,
            custody: r.u8()? != 0,
        },
        12 => Event::CaravanSettled {
            caravan: r.car()?,
            delivered: r.u8()? != 0,
            cargo: r.arr()?,
            credited: r.arr()?,
        },
        13 => Event::CaravanRaided {
            caravan: r.car()?,
            take: r.u8()? != 0,
            raider: r.u64()?,
        },
        15 => Event::Boundary {
            n: r.u32()?,
            bell: r.u32()?,
        },
        14 => Event::VaultSeized {
            vault: r.place()?,
            captor: r.u64()?,
            prev: r.u64()?,
        },
        _ => return None,
    })
}

pub fn read(b: &[u8]) -> Option<World> {
    let mut r = R(b, 0);
    if r.take(8)? != b"WYCUST02" {
        return None;
    }
    let mut w = World::new();
    w.bell = r.u32()?;
    w.boundaries = r.u32()?;
    for _ in 0..r.u32()? {
        let c = Citizen {
            key: r.key()?,
            tag: r.u64()?,
            faction: r.u8()?,
            caravans: r.u32()?,
            vaults: r.u8()?,
            home: r.place()?,
        };
        w.citizens.insert(c.key, c);
    }
    for _ in 0..r.u32()? {
        let h = Holding {
            place: r.place()?,
            owner: r.key()?,
            stores: r.arr()?,
        };
        w.holdings.insert(h.place, h);
    }
    for _ in 0..r.u32()? {
        let p = r.u16()? as i16;
        let q = r.u16()? as i16;
        let t = r.u8()?;
        w.vaults.insert((p, q, t), r.bytes()?);
    }
    for _ in 0..r.u32()? {
        let k = r.car()?;
        w.caravans.insert(k, r.bytes()?);
    }
    let mut exposure = BTreeMap::new();
    for _ in 0..r.u32()? {
        let k = r.car()?;
        let raid_open = if r.u8()? == 1 { Some(r.key()?) } else { None };
        exposure.insert(k, Exposure { raid_open });
    }
    w.exposure = exposure;
    for _ in 0..r.u32()? {
        let k = r.lot()?;
        w.lots.insert(k, r.bytes()?);
    }
    for _ in 0..r.u32()? {
        w.log.push(read_event(&mut r)?);
    }
    (r.1 == b.len()).then_some(w)
}
