//! Byte layouts (ABI v2 style: a 64-byte chained header, then fields at
//! fixed offsets, little-endian). patches/0001 adds `lot` to
//! `frontier_abi::v2::layout::s1` and the two amendments to `vault` and
//! `caravan`, taken from their reserves (no account grows).

use crate::lot::{Inbound, Lot, Order, PlaceRef, MAX_INBOUND, MAX_ORDERS};

/// Lot (576 B): `cl‖P,Q,tile,gen,owner_tag,resource`. Kind 24, entity kind
/// 14 [proposal: the next free numbers on 4cd901de; ④ assigns].
pub mod lot {
    pub const MAGIC: [u8; 8] = *b"PSF1CLOT";
    pub const SIZE: usize = 576;
    pub const P: usize = 64;
    pub const Q: usize = 66;
    pub const TILE: usize = 68;
    pub const VAULT_GEN: usize = 69;
    pub const RESOURCE: usize = 70;
    pub const STATE: usize = 71;
    pub const OWNER_CITIZEN: usize = 72;
    pub const OWNER_TAG: usize = 104;
    pub const CUSTODIAN_TAG: usize = 112;
    pub const QUOTA: usize = 120;
    pub const HELD: usize = 128;
    pub const IN_TOTAL: usize = 136;
    pub const OUT_TOTAL: usize = 144;
    pub const CONSUMED: usize = 152;
    pub const FORFEITED: usize = 160;
    pub const NONCE: usize = 168;
    pub const OPENED_BELL: usize = 172;
    /// `ORDERS[4]`, 64 B each.
    pub const ORDERS: usize = 176;
    pub const ORDER_SIZE: usize = 64;
    /// `INBOUND[4]`, 24 B each.
    pub const INBOUND: usize = 432;
    pub const INBOUND_SIZE: usize = 24;
    pub const RENT_TO: usize = 528;
    pub const RSV: usize = 560;

    /// Within an order: KIND u8, rsv u8, PURPOSE u16, ID u32, EXPIRES_BELL
    /// u32, DST place (8), GRANTEE [32] at 20, rsv 4, QTY_LEFT i64 at 56.
    pub mod order {
        pub const KIND: usize = 0;
        pub const PURPOSE: usize = 2;
        pub const ID: usize = 4;
        pub const EXPIRES_BELL: usize = 8;
        pub const DST: usize = 12;
        pub const GRANTEE: usize = 20;
        pub const QTY_LEFT: usize = 56;
    }

    /// Within an inbound ref: CARAVAN_TAG u64, SEQ u32, LIVE u8, rsv 3,
    /// QTY i64.
    pub mod inbound {
        pub const CARAVAN_TAG: usize = 0;
        pub const SEQ: usize = 8;
        pub const LIVE: usize = 12;
        pub const QTY: usize = 16;
    }

    pub const fn order(i: usize) -> usize {
        ORDERS + ORDER_SIZE * i
    }
    pub const fn inbound(i: usize) -> usize {
        INBOUND + INBOUND_SIZE * i
    }
}

/// Amendment to the S1 Vault (512 B): from `RSV @232` (280 B, "stage 2:
/// shares"), 66 B used.
pub mod vault_custody {
    /// Capacity committed to lots, per resource (milli). `STORES[r] +
    /// CUSTODY_QUOTA[r] ≤ CAP` is kept by OpenLot/SetQuota; SettleCaravan
    /// fills the general stock only to `CAP − CUSTODY_QUOTA[r]`.
    pub const CUSTODY_QUOTA: usize = 232;
    /// Lots of this vault not closed or forfeited (CloseVault: 0).
    pub const CUSTODY_LOTS: usize = 296;
    pub const END: usize = 298;
}

/// Amendment to the S1 Caravan (320 B): from `RSV @296` (24 B), all used.
pub mod caravan_custody {
    /// 0 an ordinary caravan; 1 custody: the cargo is `CUSTODY_OWNER_TAG`'s
    /// and goes to its lot at `DST`; 2 custody taken by a raider (J2): the
    /// caravan is the raider's, the lot's inbound ref is a `Raided` loss.
    pub const CUSTODY: usize = 296;
    pub const CUSTODY_RESOURCE: usize = 297;
    pub const CUSTODY_OWNER_TAG: usize = 304;
    /// The raider's `citizen_tag` once taken. `OWNER_TAG` cannot say it:
    /// J2 keeps it as the address seed (the carrier's).
    pub const TAKEN_BY_TAG: usize = 312;
    pub const END: usize = 320;
    pub const NONE: u8 = 0;
    pub const CUSTODY_LOT: u8 = 1;
    pub const CUSTODY_TAKEN: u8 = 2;
}

// The records tile the account, and the amendments stay inside the
// reserves they take (Vault `RSV @232` 280 B, Caravan `RSV @296` 24 B).
const _: () = {
    assert!(lot::order(MAX_ORDERS) == lot::INBOUND);
    assert!(lot::inbound(MAX_INBOUND) == lot::RENT_TO);
    assert!(lot::RENT_TO + 32 == lot::RSV);
    assert!(lot::RSV <= lot::SIZE);
    assert!(lot::order::QTY_LEFT + 8 <= lot::ORDER_SIZE);
    assert!(lot::order::GRANTEE + 32 <= lot::order::QTY_LEFT);
    assert!(lot::inbound::QTY + 8 <= lot::INBOUND_SIZE);
    assert!(vault_custody::CUSTODY_QUOTA >= 232 && vault_custody::END <= 512);
    assert!(caravan_custody::CUSTODY >= 296 && caravan_custody::END <= 320);
};

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap_or([0; 4]))
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap_or([0; 8]))
}
fn i64_at(b: &[u8], o: usize) -> i64 {
    u64_at(b, o) as i64
}
fn arr32(b: &[u8], o: usize) -> [u8; 32] {
    b[o..o + 32].try_into().unwrap_or([0; 32])
}

impl Lot {
    /// Reads a lot from its account data (`None`: too short or not a lot).
    pub fn decode(d: &[u8]) -> Option<Lot> {
        use lot as L;
        if d.len() < L::SIZE || d[..8] != L::MAGIC {
            return None;
        }
        let mut orders = [Order::default(); MAX_ORDERS];
        for (i, o) in orders.iter_mut().enumerate() {
            let b = L::order(i);
            *o = Order {
                kind: d[b + L::order::KIND],
                purpose: u16_at(d, b + L::order::PURPOSE),
                id: u32_at(d, b + L::order::ID),
                expires_bell: u32_at(d, b + L::order::EXPIRES_BELL),
                dst: PlaceRef::decode(&d[b + L::order::DST..b + L::order::DST + 8]),
                grantee: arr32(d, b + L::order::GRANTEE),
                qty_left: i64_at(d, b + L::order::QTY_LEFT),
            };
        }
        let mut inbound = [Inbound::default(); MAX_INBOUND];
        for (i, x) in inbound.iter_mut().enumerate() {
            let b = L::inbound(i);
            *x = Inbound {
                live: d[b + L::inbound::LIVE] != 0,
                caravan_tag: u64_at(d, b + L::inbound::CARAVAN_TAG),
                seq: u32_at(d, b + L::inbound::SEQ),
                qty: i64_at(d, b + L::inbound::QTY),
            };
        }
        Some(Lot {
            p: u16_at(d, L::P) as i16,
            q: u16_at(d, L::Q) as i16,
            tile: d[L::TILE],
            vault_gen: d[L::VAULT_GEN],
            resource: d[L::RESOURCE],
            state: d[L::STATE],
            owner: arr32(d, L::OWNER_CITIZEN),
            owner_tag: u64_at(d, L::OWNER_TAG),
            custodian_tag: u64_at(d, L::CUSTODIAN_TAG),
            quota: i64_at(d, L::QUOTA),
            held: i64_at(d, L::HELD),
            in_total: i64_at(d, L::IN_TOTAL),
            out_total: i64_at(d, L::OUT_TOTAL),
            consumed: i64_at(d, L::CONSUMED),
            forfeited: i64_at(d, L::FORFEITED),
            nonce: u32_at(d, L::NONCE),
            opened_bell: u32_at(d, L::OPENED_BELL),
            orders,
            inbound,
            rent_to: arr32(d, L::RENT_TO),
        })
    }

    /// Writes the lot's fields (bytes 64..576; the header is the
    /// program's). `d` must be at least `lot::SIZE`.
    pub fn encode(&self, d: &mut [u8]) -> Option<()> {
        use lot as L;
        if d.len() < L::SIZE {
            return None;
        }
        d[..8].copy_from_slice(&L::MAGIC);
        d[L::P..L::P + 2].copy_from_slice(&self.p.to_le_bytes());
        d[L::Q..L::Q + 2].copy_from_slice(&self.q.to_le_bytes());
        d[L::TILE] = self.tile;
        d[L::VAULT_GEN] = self.vault_gen;
        d[L::RESOURCE] = self.resource;
        d[L::STATE] = self.state;
        d[L::OWNER_CITIZEN..L::OWNER_CITIZEN + 32].copy_from_slice(&self.owner);
        let w64 = |d: &mut [u8], o: usize, v: u64| d[o..o + 8].copy_from_slice(&v.to_le_bytes());
        w64(d, L::OWNER_TAG, self.owner_tag);
        w64(d, L::CUSTODIAN_TAG, self.custodian_tag);
        w64(d, L::QUOTA, self.quota as u64);
        w64(d, L::HELD, self.held as u64);
        w64(d, L::IN_TOTAL, self.in_total as u64);
        w64(d, L::OUT_TOTAL, self.out_total as u64);
        w64(d, L::CONSUMED, self.consumed as u64);
        w64(d, L::FORFEITED, self.forfeited as u64);
        d[L::NONCE..L::NONCE + 4].copy_from_slice(&self.nonce.to_le_bytes());
        d[L::OPENED_BELL..L::OPENED_BELL + 4].copy_from_slice(&self.opened_bell.to_le_bytes());
        for (i, o) in self.orders.iter().enumerate() {
            let b = L::order(i);
            d[b..b + L::ORDER_SIZE].fill(0);
            d[b + L::order::KIND] = o.kind;
            d[b + L::order::PURPOSE..b + L::order::PURPOSE + 2]
                .copy_from_slice(&o.purpose.to_le_bytes());
            d[b + L::order::ID..b + L::order::ID + 4].copy_from_slice(&o.id.to_le_bytes());
            d[b + L::order::EXPIRES_BELL..b + L::order::EXPIRES_BELL + 4]
                .copy_from_slice(&o.expires_bell.to_le_bytes());
            d[b + L::order::DST..b + L::order::DST + 8].copy_from_slice(&o.dst.encode());
            d[b + L::order::GRANTEE..b + L::order::GRANTEE + 32].copy_from_slice(&o.grantee);
            w64(d, b + L::order::QTY_LEFT, o.qty_left as u64);
        }
        for (i, x) in self.inbound.iter().enumerate() {
            let b = L::inbound(i);
            d[b..b + L::INBOUND_SIZE].fill(0);
            w64(d, b + L::inbound::CARAVAN_TAG, x.caravan_tag);
            d[b + L::inbound::SEQ..b + L::inbound::SEQ + 4].copy_from_slice(&x.seq.to_le_bytes());
            d[b + L::inbound::LIVE] = x.live as u8;
            w64(d, b + L::inbound::QTY, x.qty as u64);
        }
        d[L::RENT_TO..L::RENT_TO + 32].copy_from_slice(&self.rent_to);
        d[L::RSV..L::SIZE].fill(0);
        Some(())
    }
}

/// Raw key length of a lot's address (`LOT_RAW_LEN`).
pub const LOT_RAW_LEN: usize = 15;

/// The lot's raw address key: `P i16 ‖ Q i16 ‖ tile u8 ‖ gen u8 ‖
/// owner_tag u64 ‖ resource u8` (15 B). The ABI seed is `cl` ‖ its hex (32
/// B, the `init_with_seed` limit), under the Season PDA like the vault's
/// `va` seed. The vault's generation is part of the key: a lot opened after
/// a seizure is a new account.
pub fn lot_raw_key(
    p: i16,
    q: i16,
    tile: u8,
    gen: u8,
    owner_tag: u64,
    resource: u8,
) -> [u8; LOT_RAW_LEN] {
    let mut s = [0u8; LOT_RAW_LEN];
    s[0..2].copy_from_slice(&p.to_le_bytes());
    s[2..4].copy_from_slice(&q.to_le_bytes());
    s[4] = tile;
    s[5] = gen;
    s[6..14].copy_from_slice(&owner_tag.to_le_bytes());
    s[14] = resource;
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lot::*;

    #[test]
    fn a_lot_round_trips() {
        let mut l = Lot {
            p: -3,
            q: 7,
            tile: 30,
            vault_gen: 2,
            resource: 3,
            state: LOT_OPEN,
            owner: [7; 32],
            owner_tag: 0xA1,
            custodian_tag: 0xB2,
            quota: 900_000,
            held: 400_000,
            in_total: 500_000,
            out_total: 60_000,
            consumed: 40_000,
            forfeited: 0,
            nonce: 9,
            opened_bell: 77,
            orders: [Order::default(); MAX_ORDERS],
            inbound: [Inbound::default(); MAX_INBOUND],
            rent_to: [3; 32],
        };
        l.orders[2] = Order {
            kind: ORDER_SHIP,
            purpose: 0,
            id: 8,
            expires_bell: 500,
            dst: PlaceRef::vault(1, -1, 12, 1),
            grantee: [9; 32],
            qty_left: 100_000,
        };
        l.inbound[1] = Inbound {
            live: true,
            caravan_tag: 0xC3,
            seq: 4,
            qty: 50_000,
        };
        let mut d = [0u8; lot::SIZE];
        l.encode(&mut d).unwrap();
        assert_eq!(Lot::decode(&d), Some(l));
        let mut other = d;
        other[0] = b'X';
        assert_eq!(Lot::decode(&other), None);
        let k = lot_raw_key(-3, 7, 30, 2, 0xA1, 3);
        assert_eq!((k[4], k[5], k[14]), (30, 2, 3));
        assert_ne!(
            k,
            lot_raw_key(-3, 7, 30, 3, 0xA1, 3),
            "another generation, another lot"
        );
    }
}
