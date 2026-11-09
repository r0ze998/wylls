//! Phase A of the host-only wide economy (`world_index::economy`,
//! 2026-11-08): the canonical action wire, the 0xDA op 3 envelope and its
//! tables, the resident act's admission, the receipt, the digests, and the
//! holding-keyed event kinds 15 and 16 — their full-identity keys, their
//! attribution without a phantom host, and the chain-target skipping rule.
//! Nothing here executes an action or reads an account; every snapshot is
//! a synthetic byte image that passes the wide readers and nothing more.
#![cfg(feature = "world-index-experimental")]

use frontier_abi::error::FrontierError;
use frontier_abi::layout::header;
use frontier_abi::prologue::{bounds_in, position_in, Acc, Wr, PLAYER_PROLOGUE};
use frontier_abi::tags::Class;
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::player::holding as H2;
use frontier_abi::v2::layout::province::province as PV2;
use frontier_abi::world_index::economy::{
    self as eco, Action, EconomyError, EconomyReceipt, Snapshots, ACTION_LEN, BUILD_ITEM_MAX,
    BUILD_ITEM_TIER_UP, BUILD_ITEM_WALLS, RECEIPT_LEN, RECEIPT_VERSION, TAG_BUILD, TAG_HARVEST,
    TAG_TRAIN, TRAIN_UNITS,
};
use frontier_abi::world_index::event::{
    advance, economy_payload, encode, resolve_payload, verify_chain, write_body, EventError,
    WideEntity, WideKind, WideLink, WideRecord, WideTarget, ALL_KINDS, ECONOMY_PAYLOAD_LEN,
    HEAD_LEN, HOLDING_KEY_LEN, HOST_KEY_LEN, LINK_LEN, MAX_BODY, MAX_LINKS, WIDE_EVENT_VERSION,
};
use frontier_abi::world_index::holding::{wide_holding, WideHolding};
use frontier_abi::world_index::land::{self, WideProvince};
use frontier_abi::world_index::wide_ix::{
    is_draft_tag, tag_of, Economy, Muster, ResidentAct, WideCommand, WideIx, ECONOMY,
    ECONOMY_HOLDING, ECONOMY_MIRROR, ECONOMY_PROVINCE, OP_ECONOMY, TAG_DEPART,
};
use frontier_abi::world_index::{
    Decision, KeyError, ProvinceKey, WideCoord, WideHostRef, WorldId, HOST_REF_LEN,
    PROVINCE_KEY_LEN,
};

// ------------------------------------------------------------ fixtures

const SEASON: u64 = 11;
const OWNER: [u8; 32] = [0xc1; 32];

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}

fn coord() -> WideCoord {
    WideCoord::checked(129, 0).unwrap()
}

fn key() -> ProvinceKey {
    ProvinceKey::new(world(), coord())
}

fn key_at(p: i64) -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(p, 0).unwrap())
}

/// The holding under test: site 3, generation 1, sequence 0.
fn holding_ref() -> WideHostRef {
    WideHostRef::new(key(), 3, 1, 0).unwrap()
}

/// A wide holding record of site 3, generation 1 at `c`, as the founding
/// writes it: the identity over zeroed economy bytes (a readable image,
/// not a played one).
fn holding_bytes_at(c: WideCoord) -> Vec<u8> {
    let h = WideHolding::found(world(), SEASON, c, 3, 1, 2, OWNER, &Decision::Decided(())).unwrap();
    let mut d = vec![0u8; wide_holding::SIZE];
    h.write_identity(&mut d).unwrap();
    d
}

/// [`holding_bytes_at`] for [`holding_ref`].
fn holding_bytes() -> Vec<u8> {
    holding_bytes_at(coord())
}

/// The holding's own wide province, identity only: a readable image whose
/// game state is zero (not a Resolve fixture).
fn province_bytes_at(c: WideCoord) -> Vec<u8> {
    let p = WideProvince {
        season_id: SEASON,
        world: world(),
        coord: c,
        wedge: c.wedge().unwrap(),
        region: 0,
        opened_bell: 0,
        readiness: land::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [1; 32],
        funded_lamports: 0,
    };
    let mut d = vec![0u8; land::province::SIZE];
    p.write_identity(&mut d).unwrap();
    d
}

fn province_bytes() -> Vec<u8> {
    province_bytes_at(coord())
}

fn citizen_bytes() -> Vec<u8> {
    vec![0u8; C2::SIZE]
}

fn season_bytes() -> Vec<u8> {
    vec![0x11u8; 64]
}

fn receipt(action: Action) -> EconomyReceipt {
    EconomyReceipt {
        action,
        now_ts: 1_700_000_000,
        became_final: false,
        input_digest: [0xa1; 32],
        output_digest: [0xb2; 32],
    }
}

/// A chain state per entity, as the event module's own tests keep it.
struct Chains {
    province: (u64, [u8; 32]),
    holding: (u64, [u8; 32]),
}

impl Chains {
    fn new() -> Chains {
        Chains {
            province: (0, [0; 32]),
            holding: (0, [0; 32]),
        }
    }

    fn record(&mut self, kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut bwt = [0u8; MAX_BODY];
        let n = write_body(kind, bell, key, payload, &mut bwt).unwrap();
        let mut links = Vec::new();
        for e in kind.links() {
            let (seq, head) = match e {
                WideEntity::Province => self.province,
                WideEntity::Holding => self.holding,
            };
            let l = advance(*e, seq, &head, &bwt[..n]).unwrap();
            match e {
                WideEntity::Province => self.province = (l.seq, l.head),
                WideEntity::Holding => self.holding = (l.seq, l.head),
            }
            links.push(l);
        }
        encode(kind, bell, key, payload, &links).unwrap()
    }
}

/// A body built byte by byte, bypassing every check of `write_body`.
fn forged(kind: u8, key: &[u8], payload: &[u8], links: &[WideLink]) -> Vec<u8> {
    let mut v = vec![WIDE_EVENT_VERSION, kind];
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(key);
    v.extend_from_slice(payload);
    v.push(links.len() as u8);
    for l in links {
        v.push(l.entity as u8);
        v.extend_from_slice(&l.seq.to_le_bytes());
        v.extend_from_slice(&l.head);
    }
    v
}

fn link(entity: WideEntity, seq: u64, fill: u8) -> WideLink {
    WideLink {
        entity,
        seq,
        head: [fill; 32],
    }
}

// ------------------------------------------------------------ the action

/// Six bytes, exact: tag 0 all zero, tag 1 the item, tag 2 the unit and
/// `n`; every non-canonical string refused by name; the mirror predicate
/// is the two mirror items and nothing else.
#[test]
fn action_wire_is_canonical_exact_and_refuses_noncanonical_bytes() {
    assert_eq!(ACTION_LEN, 6);
    assert_eq!((TAG_HARVEST, TAG_BUILD, TAG_TRAIN), (0, 1, 2));
    assert_eq!(
        (BUILD_ITEM_WALLS, BUILD_ITEM_TIER_UP, BUILD_ITEM_MAX),
        (6, 7, 8)
    );
    assert_eq!(TRAIN_UNITS, 7);
    // Harvest
    let h = Action::Harvest;
    assert_eq!(h.to_bytes(), Some([0, 0, 0, 0, 0, 0]));
    assert_eq!(Action::decode(&[0, 0, 0, 0, 0, 0]), Ok(h));
    assert!(!h.mirror_write());
    assert_eq!(h.kind(), WideKind::Economy);
    for i in 1..ACTION_LEN {
        let mut b = [0u8; ACTION_LEN];
        b[i] = 1;
        assert_eq!(Action::decode(&b), Err(EconomyError::Padding), "byte {i}");
    }
    // Build 0..=8: the item in byte 1, zero after it
    for item in 0..=BUILD_ITEM_MAX {
        let a = Action::Build { item };
        let b = a.to_bytes().unwrap();
        assert_eq!(b, [1, item, 0, 0, 0, 0]);
        assert_eq!(Action::decode(&b), Ok(a));
        assert_eq!(
            a.mirror_write(),
            item == BUILD_ITEM_WALLS || item == BUILD_ITEM_TIER_UP,
            "item {item}"
        );
        assert_eq!(
            a.kind(),
            if a.mirror_write() {
                WideKind::EconomyMirror
            } else {
                WideKind::Economy
            }
        );
        for i in 2..ACTION_LEN {
            let mut x = b;
            x[i] = 0xFF;
            assert_eq!(Action::decode(&x), Err(EconomyError::Padding));
        }
    }
    for item in [9u8, 10, 0x7F, 0xFF] {
        assert_eq!(
            Action::decode(&[1, item, 0, 0, 0, 0]),
            Err(EconomyError::Item(item))
        );
        assert_eq!(Action::Build { item }.to_bytes(), None);
        assert_eq!(
            Action::Build { item }.check(),
            Err(EconomyError::Item(item))
        );
    }
    // padding is judged before the argument
    assert_eq!(
        Action::decode(&[1, 9, 1, 0, 0, 0]),
        Err(EconomyError::Padding)
    );
    // Train 0..=6 × n ≥ 1: the unit in byte 1, LE32 n after it, no padding
    for unit in 0..TRAIN_UNITS {
        for n in [1u32, 100, 301, u32::MAX] {
            let a = Action::Train { unit, n };
            let b = a.to_bytes().unwrap();
            assert_eq!(b[0], 2);
            assert_eq!(b[1], unit);
            assert_eq!(&b[2..], &n.to_le_bytes());
            assert_eq!(Action::decode(&b), Ok(a));
            assert!(!a.mirror_write());
            assert_eq!(a.kind(), WideKind::Economy);
        }
        assert_eq!(
            Action::decode(&[2, unit, 0, 0, 0, 0]),
            Err(EconomyError::Count)
        );
        assert_eq!(Action::Train { unit, n: 0 }.to_bytes(), None);
    }
    for unit in [TRAIN_UNITS, 8, 0xFF] {
        assert_eq!(
            Action::decode(&[2, unit, 1, 0, 0, 0]),
            Err(EconomyError::Unit(unit))
        );
        assert_eq!(Action::Train { unit, n: 1 }.to_bytes(), None);
    }
    // unknown tags, wrong lengths
    for t in [3u8, 4, 0x80, 0xFF] {
        assert_eq!(
            Action::decode(&[t, 0, 0, 0, 0, 0]),
            Err(EconomyError::Tag(t))
        );
    }
    assert_eq!(
        Action::decode(&[0, 0, 0, 0, 0]),
        Err(EconomyError::Length {
            expected: 6,
            got: 5
        })
    );
    assert_eq!(
        Action::decode(&[0, 0, 0, 0, 0, 0, 0]),
        Err(EconomyError::Length {
            expected: 6,
            got: 7
        })
    );
    assert!(Action::decode(&[]).is_err());
}

// ------------------------------------------------------------ the wire

/// WideEconomy is 0xDA op 3: ten exact bytes, a player command of class P
/// under the existing tag, no new tag, the table chosen by the decoded
/// action and the province writable exactly for the mirror items.
#[test]
fn economy_envelope_is_exact_under_0xda_op3_and_selects_its_table_by_action() {
    assert_eq!(OP_ECONOMY, 3);
    assert_eq!(Economy::LEN, 10);
    assert_eq!(Economy::IX, WideIx::Depart);
    assert_eq!(WideIx::ALL.len(), 11, "no new top-level tag");
    let harvest = Economy {
        action: Action::Harvest,
    };
    let hb = harvest.to_bytes().unwrap();
    assert_eq!(hb, [0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0, 0]);
    assert_eq!(tag_of(&hb), Ok(WideIx::Depart));
    assert!(is_draft_tag(TAG_DEPART));
    assert_eq!(Economy::decode(&hb), Ok(harvest));
    assert_eq!(WideCommand::decode(&hb), Ok(WideCommand::Economy(harvest)));
    // the same length as a WideMuster under the same tag: the op decides
    let m = Muster {
        unit: 0,
        troops: 300,
        tile: 5,
    };
    let mb = m.to_bytes();
    assert_eq!(mb.len(), Economy::LEN);
    assert_eq!(Economy::decode(&mb), Err(FrontierError::BadData));
    assert_eq!(Muster::decode(&hb), Err(FrontierError::BadData));
    assert_eq!(WideCommand::decode(&mb), Ok(WideCommand::Muster(m)));
    // the command's facets
    let c = WideCommand::decode(&hb).unwrap();
    assert_eq!(c.ix(), WideIx::Depart);
    assert_eq!(c.class(), Class::P);
    assert!(!c.top_level_only());
    assert!(!c.march_stage());
    assert!(c.is_player());
    assert_eq!(c.name(), "WideEconomy");
    // the tables, by action
    let ordinary = [
        Action::Harvest,
        Action::Build { item: 0 },
        Action::Build { item: 5 },
        Action::Build { item: 8 },
        Action::Train { unit: 0, n: 1 },
        Action::Train { unit: 6, n: 1_000 },
    ];
    let mirror = [
        Action::Build {
            item: BUILD_ITEM_WALLS,
        },
        Action::Build {
            item: BUILD_ITEM_TIER_UP,
        },
    ];
    for a in ordinary {
        let b = Economy { action: a }.to_bytes().unwrap();
        let c = WideCommand::decode(&b).unwrap();
        assert_eq!(c, WideCommand::Economy(Economy { action: a }));
        assert_eq!(c.accounts().len(), ECONOMY.len());
        assert_eq!(c.accounts()[0].specs, ECONOMY[0].specs, "{a:?}");
        assert!(c.is_player());
    }
    for a in mirror {
        let b = Economy { action: a }.to_bytes().unwrap();
        let c = WideCommand::decode(&b).unwrap();
        assert_eq!(c.accounts()[0].specs, ECONOMY_MIRROR[0].specs, "{a:?}");
        assert!(c.is_player());
    }
    for table in [ECONOMY, ECONOMY_MIRROR] {
        assert_eq!(bounds_in(table), (6, 6));
        for (sp, want) in table[0].specs.iter().zip(PLAYER_PROLOGUE) {
            assert_eq!(
                (sp.name, sp.signer, sp.wr),
                (want.name, want.signer, want.wr)
            );
            assert_eq!(sp.acc, want.acc);
        }
        assert_eq!(position_in(table, 6, "holding", 0), Some(ECONOMY_HOLDING));
        assert_eq!(position_in(table, 6, "province", 0), Some(ECONOMY_PROVINCE));
        assert_eq!(table[0].specs[ECONOMY_HOLDING].acc, Acc::Any);
        assert_eq!(table[0].specs[ECONOMY_HOLDING].wr, Wr::W);
        assert_eq!(table[0].specs[ECONOMY_PROVINCE].acc, Acc::Any);
        assert!(!table[0].specs[ECONOMY_HOLDING].signer);
        assert!(!table[0].specs[ECONOMY_PROVINCE].signer);
    }
    assert_eq!(ECONOMY[0].specs[ECONOMY_PROVINCE].wr, Wr::Either);
    assert_eq!(ECONOMY_MIRROR[0].specs[ECONOMY_PROVINCE].wr, Wr::W);
    // malformed under op 3: a wrong length, bad padding, an unknown action
    // tag, an item or unit out of range, a zero count, a wrong escape or
    // version
    for bad in [
        &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0][..],
        &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0, 0, 0],
        &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0, 1],
        &[0xDA, 0xFF, 1, 3, 1, 2, 0, 0, 1, 0],
        &[0xDA, 0xFF, 1, 3, 3, 0, 0, 0, 0, 0],
        &[0xDA, 0xFF, 1, 3, 1, 9, 0, 0, 0, 0],
        &[0xDA, 0xFF, 1, 3, 2, 7, 1, 0, 0, 0],
        &[0xDA, 0xFF, 1, 3, 2, 0, 0, 0, 0, 0],
        &[0xDA, 0xFE, 1, 3, 0, 0, 0, 0, 0, 0],
        &[0xDA, 0xFF, 2, 3, 0, 0, 0, 0, 0, 0],
        &[0xDC, 0xFF, 1, 3, 0, 0, 0, 0, 0, 0],
    ] {
        assert_eq!(Economy::decode(bad), Err(FrontierError::BadData), "{bad:?}");
        assert!(
            !matches!(WideCommand::decode(bad), Ok(WideCommand::Economy(_))),
            "{bad:?}"
        );
    }
    // an invalid action has no wire form
    assert_eq!(
        Economy {
            action: Action::Build { item: 9 }
        }
        .to_bytes(),
        None
    );
}

/// The band's act (0xDD) admits WideEconomy as it admits WideMuster: by
/// the decoded inner command, under the same envelope, with no new
/// authorisation path; a malformed inner is refused.
#[test]
fn the_resident_act_admits_economy_under_the_existing_envelope() {
    let mut buf = [0u8; 64];
    for a in [
        Action::Harvest,
        Action::Build { item: 2 },
        Action::Build {
            item: BUILD_ITEM_WALLS,
        },
        Action::Train { unit: 3, n: 200 },
    ] {
        let inner = Economy { action: a }.to_bytes().unwrap();
        let n = ResidentAct {
            generation: 5,
            inner: &inner,
        }
        .encode_into(&mut buf)
        .unwrap();
        assert_eq!(n, ResidentAct::HEAD + Economy::LEN);
        assert_eq!(&buf[..5], &[0xDD, 5, 0, 0, 0]);
        let act = ResidentAct::decode(&buf[..n]).unwrap();
        assert_eq!(act.generation, 5);
        assert_eq!(
            act.command(),
            Ok(WideCommand::Economy(Economy { action: a }))
        );
        assert!(matches!(
            WideCommand::decode(&buf[..n]),
            Ok(WideCommand::ResidentAct(_))
        ));
        let outer = WideCommand::decode(&buf[..n]).unwrap();
        assert_eq!(outer.class(), Class::P);
        assert!(!outer.is_player(), "the act itself is not a player command");
    }
    for bad_inner in [
        &[0xDA, 0xFF, 1, 3, 1, 9, 0, 0, 0, 0][..],
        &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0],
        &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0, 1],
        &[0xDA, 0xFF, 1, 3, 2, 0, 0, 0, 0, 0],
    ] {
        let n = ResidentAct {
            generation: 5,
            inner: bad_inner,
        }
        .encode_into(&mut buf)
        .unwrap();
        assert_eq!(
            ResidentAct::decode(&buf[..n]),
            Err(FrontierError::BadData),
            "{bad_inner:?}"
        );
    }
}

// ------------------------------------------------------------ the receipt

/// Eighty bytes under version 1: the action's canonical bytes, the clock,
/// a canonical bool, the two digests; the kind is the action's.
#[test]
fn receipts_round_trip_and_refuse_version_bool_and_action() {
    assert_eq!(RECEIPT_VERSION, 1);
    assert_eq!(RECEIPT_LEN, 80);
    assert_eq!(ECONOMY_PAYLOAD_LEN, RECEIPT_LEN);
    let r = EconomyReceipt {
        action: Action::Train { unit: 4, n: 250 },
        now_ts: -7,
        became_final: true,
        input_digest: [0x11; 32],
        output_digest: [0x22; 32],
    };
    let b = r.to_bytes().unwrap();
    assert_eq!(b.len(), RECEIPT_LEN);
    assert_eq!(b[0], 1);
    assert_eq!(&b[1..7], &[2, 4, 250, 0, 0, 0]);
    assert_eq!(&b[7..15], &(-7i64).to_le_bytes());
    assert_eq!(b[15], 1);
    assert_eq!(&b[16..48], &[0x11; 32]);
    assert_eq!(&b[48..80], &[0x22; 32]);
    assert_eq!(EconomyReceipt::decode(&b), Ok(r));
    assert_eq!(economy_payload(&r), Some(b));
    assert_eq!(r.kind(), WideKind::Economy);
    // refusals
    for v in [0u8, 2, 0x81] {
        let mut x = b;
        x[0] = v;
        assert_eq!(EconomyReceipt::decode(&x), Err(EconomyError::Version(v)));
    }
    for f in [2u8, 0xFF] {
        let mut x = b;
        x[15] = f;
        assert_eq!(EconomyReceipt::decode(&x), Err(EconomyError::Bool(f)));
    }
    let mut x = b;
    x[1] = 3;
    assert_eq!(EconomyReceipt::decode(&x), Err(EconomyError::Tag(3)));
    let mut x = b;
    x[2] = 7;
    assert_eq!(EconomyReceipt::decode(&x), Err(EconomyError::Unit(7)));
    let mut x = b;
    x[3..7].fill(0);
    assert_eq!(EconomyReceipt::decode(&x), Err(EconomyError::Count));
    assert_eq!(
        EconomyReceipt::decode(&b[..79]),
        Err(EconomyError::Length {
            expected: 80,
            got: 79
        })
    );
    let mut long = b.to_vec();
    long.push(0);
    assert_eq!(
        EconomyReceipt::decode(&long),
        Err(EconomyError::Length {
            expected: 80,
            got: 81
        })
    );
    // the kind follows the action alone
    assert_eq!(receipt(Action::Harvest).kind(), WideKind::Economy);
    assert_eq!(receipt(Action::Build { item: 5 }).kind(), WideKind::Economy);
    assert_eq!(receipt(Action::Build { item: 8 }).kind(), WideKind::Economy);
    assert_eq!(
        receipt(Action::Build {
            item: BUILD_ITEM_WALLS
        })
        .kind(),
        WideKind::EconomyMirror
    );
    assert_eq!(
        receipt(Action::Build {
            item: BUILD_ITEM_TIER_UP
        })
        .kind(),
        WideKind::EconomyMirror
    );
    // an invalid action has no receipt bytes
    assert_eq!(receipt(Action::Build { item: 9 }).to_bytes(), None);
    assert_eq!(
        economy_payload(&receipt(Action::Train { unit: 0, n: 0 })),
        None
    );
}

// ------------------------------------------------------------ the digests

/// The input commits the raw snapshots (chain headers included) and the
/// Season; the output commits the normalized holding and province and the
/// flip; both bind the identity, the action and the clock, refuse a
/// snapshot that is not the reference's, and never panic on a bad shape.
#[test]
fn digests_commit_identity_action_time_and_snapshots_and_normalize_only_the_output() {
    let h = holding_ref();
    let (cz, hd, pd, season) = (
        citizen_bytes(),
        holding_bytes(),
        province_bytes(),
        season_bytes(),
    );
    let snaps = Snapshots {
        citizen: &cz,
        holding: &hd,
        province: &pd,
    };
    let a = Action::Build { item: 2 };
    let now = 1_700_000_000i64;
    let input = eco::input_digest(&h, a, now, &season, &snaps).unwrap();
    let output = eco::output_digest(&h, a, now, false, &snaps).unwrap();
    assert_ne!(input, output, "domain-separated");
    assert_ne!(eco::INPUT_DOMAIN, eco::OUTPUT_DOMAIN);
    assert_eq!(
        eco::input_digest(&h, a, now, &season, &snaps),
        Ok(input),
        "deterministic"
    );
    // the identity, the action, the clock
    let other_site = WideHostRef::new(key(), 4, 1, 0).unwrap();
    assert_eq!(
        eco::input_digest(&other_site, a, now, &season, &snaps),
        Err(EconomyError::Identity),
        "the snapshot is not that holding's"
    );
    let other_gen = WideHostRef::new(key(), 3, 2, 0).unwrap();
    assert_eq!(
        eco::output_digest(&other_gen, a, now, false, &snaps),
        Err(EconomyError::Identity)
    );
    assert_ne!(
        eco::input_digest(&h, Action::Build { item: 3 }, now, &season, &snaps).unwrap(),
        input,
        "the action"
    );
    assert_ne!(
        eco::input_digest(&h, a, now + 1, &season, &snaps).unwrap(),
        input,
        "the clock"
    );
    assert_ne!(
        eco::output_digest(&h, a, now + 1, false, &snaps).unwrap(),
        output
    );
    assert_ne!(
        eco::output_digest(&h, a, now, true, &snaps).unwrap(),
        output,
        "the flip"
    );
    // the Season bytes, whole and length-delimited
    assert_ne!(
        eco::input_digest(&h, a, now, &[0x12; 64], &snaps).unwrap(),
        input
    );
    assert_ne!(
        eco::input_digest(&h, a, now, &season[..63], &snaps).unwrap(),
        input,
        "the length"
    );
    // the Citizen, by content
    let mut cz2 = cz.clone();
    cz2[C2::HOLDINGS_N] = 1;
    let s2 = Snapshots {
        citizen: &cz2,
        ..snaps
    };
    assert_ne!(eco::input_digest(&h, a, now, &season, &s2).unwrap(), input);
    assert_ne!(eco::output_digest(&h, a, now, false, &s2).unwrap(), output);
    // a holding economy byte, a province game byte: both digests move
    let mut hd2 = hd.clone();
    hd2[H2::TICKET_SCORE] ^= 1;
    let s3 = Snapshots {
        holding: &hd2,
        ..snaps
    };
    assert_ne!(eco::input_digest(&h, a, now, &season, &s3).unwrap(), input);
    assert_ne!(eco::output_digest(&h, a, now, false, &s3).unwrap(), output);
    let mut pd2 = pd.clone();
    pd2[PV2::OPENED_BELL] = 9;
    let s4 = Snapshots {
        province: &pd2,
        ..snaps
    };
    assert_ne!(eco::input_digest(&h, a, now, &season, &s4).unwrap(), input);
    assert_ne!(eco::output_digest(&h, a, now, false, &s4).unwrap(), output);
    // the chain headers: in the input (raw), out of the output (normalized)
    let mut hd3 = hd.clone();
    hd3[header::EVENT_SEQ] = 1;
    hd3[header::EVENT_HEAD + 5] = 0xee;
    let mut pd3 = pd.clone();
    pd3[header::EVENT_SEQ + 1] = 2;
    pd3[header::EVENT_HEAD] = 0xdd;
    let s5 = Snapshots {
        citizen: &cz,
        holding: &hd3,
        province: &pd3,
    };
    assert_ne!(
        eco::input_digest(&h, a, now, &season, &s5).unwrap(),
        input,
        "the input is the state as read, chain headers included"
    );
    assert_eq!(
        eco::output_digest(&h, a, now, false, &s5).unwrap(),
        output,
        "the output is independent of the records' own links"
    );
    // the Citizen's own header is not normalized: it is no wide entity
    let mut cz3 = cz.clone();
    cz3[header::EVENT_SEQ] = 1;
    let s6 = Snapshots {
        citizen: &cz3,
        ..snaps
    };
    assert_ne!(eco::output_digest(&h, a, now, false, &s6).unwrap(), output);
    // shapes: a short or long holding, province or Citizen never hashes
    let short_h = Snapshots {
        holding: &hd[..H2::SIZE],
        ..snaps
    };
    assert_eq!(
        eco::input_digest(&h, a, now, &season, &short_h),
        Err(EconomyError::Holding(
            frontier_abi::world_index::HoldingError::Length {
                expected: wide_holding::SIZE,
                got: H2::SIZE
            }
        ))
    );
    let short_p = Snapshots {
        province: &pd[..PV2::SIZE],
        ..snaps
    };
    assert!(matches!(
        eco::output_digest(&h, a, now, false, &short_p),
        Err(EconomyError::Province(_))
    ));
    let short_c = Snapshots {
        citizen: &cz[..C2::SIZE - 1],
        ..snaps
    };
    assert_eq!(
        eco::input_digest(&h, a, now, &season, &short_c),
        Err(EconomyError::Citizen {
            expected: C2::SIZE,
            got: C2::SIZE - 1
        })
    );
    let empty = Snapshots {
        citizen: &[],
        holding: &[],
        province: &[],
    };
    assert!(eco::check_snapshots(&h, &empty).is_err());
    // a province that is not the holding's
    let other_p = province_bytes_at(WideCoord::checked(130, 0).unwrap());
    let s7 = Snapshots {
        province: &other_p,
        ..snaps
    };
    assert_eq!(
        eco::input_digest(&h, a, now, &season, &s7),
        Err(EconomyError::Identity)
    );
    // a legacy-magic holding in the position is refused by the wide reader
    let mut legacy = hd.clone();
    legacy[..8].copy_from_slice(&H2::MAGIC);
    let s8 = Snapshots {
        holding: &legacy,
        ..snaps
    };
    assert_eq!(
        eco::input_digest(&h, a, now, &season, &s8),
        Err(EconomyError::Holding(
            frontier_abi::world_index::HoldingError::Magic
        ))
    );
    // the key: a host reference is no economy key, before any snapshot
    let host = WideHostRef::new(key(), 3, 1, 7).unwrap();
    assert_eq!(
        eco::input_digest(&host, a, now, &season, &empty),
        Err(EconomyError::Sequence(7))
    );
    assert_eq!(eco::economy_key(&host), Err(EconomyError::Sequence(7)));
    assert_eq!(eco::economy_key(&h), Ok(h.to_bytes()));
    assert_eq!(eco::decode_key(&h.to_bytes()), Ok(h));
    assert_eq!(
        eco::decode_key(&host.to_bytes()),
        Err(EconomyError::Sequence(7))
    );
    assert_eq!(
        eco::decode_key(&key().to_bytes()),
        Err(EconomyError::Key(KeyError::Length {
            expected: HOST_REF_LEN,
            got: PROVINCE_KEY_LEN
        }))
    );
    // an invalid action has no digest
    assert_eq!(
        eco::input_digest(&h, Action::Build { item: 9 }, now, &season, &snaps),
        Err(EconomyError::Item(9))
    );
    assert_eq!(
        eco::output_digest(&h, Action::Train { unit: 0, n: 0 }, now, false, &snaps),
        Err(EconomyError::Count)
    );
}

// ------------------------------------------------------------ the key

/// An economy key names a holding that could exist, under the constraints
/// `WideHolding::found` and `WideHolding::read` already apply to the
/// record: a generation that is neither 0 nor the empty-slot marker, and
/// a coordinate on a wide ring. Both key entrypoints, the snapshot check
/// and the record codec at both ends refuse the same references; a wide
/// reference at a negative or mixed-sign coordinate passes everywhere.
#[test]
fn economy_keys_require_a_live_generation_and_a_wide_ring() {
    assert_eq!(land::FIRST_WIDE_RING, 129);
    assert_eq!(C2::EMPTY_GEN, 255);
    let pp = economy_payload(&receipt(Action::Harvest)).unwrap();
    let mp = economy_payload(&receipt(Action::Build {
        item: BUILD_ITEM_WALLS,
    }))
    .unwrap();
    let l_h = link(WideEntity::Holding, 1, 1);
    let l_p = link(WideEntity::Province, 1, 2);
    let mut buf = [0u8; MAX_BODY];
    let empty = Snapshots {
        citizen: &[],
        holding: &[],
        province: &[],
    };
    let (cz, season) = (citizen_bytes(), season_bytes());
    // the refusal of one reference, at every entrypoint
    let mut refused = |r: WideHostRef, want: EconomyError, what: &str| {
        let b = r.to_bytes();
        assert_eq!(eco::check_holding_ref(&r), Err(want), "{what}: check");
        assert_eq!(eco::economy_key(&r), Err(want), "{what}: encode");
        assert_eq!(eco::decode_key(&b), Err(want), "{what}: decode");
        assert_eq!(
            eco::check_snapshots(&r, &empty),
            Err(want),
            "{what}: the key is judged before any snapshot"
        );
        assert_eq!(
            eco::input_digest(&r, Action::Harvest, 1, &season, &empty),
            Err(want),
            "{what}: input digest"
        );
        assert_eq!(
            eco::output_digest(&r, Action::Harvest, 1, false, &empty),
            Err(want),
            "{what}: output digest"
        );
        assert!(
            write_body(WideKind::Economy, 1, &b, &pp, &mut buf).is_none(),
            "{what}: write_body"
        );
        assert!(
            write_body(WideKind::EconomyMirror, 1, &b, &mp, &mut buf).is_none(),
            "{what}: write_body (mirror)"
        );
        assert!(
            encode(WideKind::Economy, 1, &b, &pp, &[l_h]).is_none(),
            "{what}: encode"
        );
        assert_eq!(
            WideRecord::decode(&forged(15, &b, &pp, &[l_h])),
            Err(EventError::Key),
            "{what}: decode (plain)"
        );
        assert_eq!(
            WideRecord::decode(&forged(16, &b, &mp, &[l_p, l_h])),
            Err(EventError::Key),
            "{what}: decode (mirror)"
        );
    };
    // generation 0 and the empty-slot marker, on a wide ring
    for g in [0u8, C2::EMPTY_GEN] {
        let r = WideHostRef::new(key(), 3, g, 0).unwrap();
        refused(r, EconomyError::Generation(g), &format!("gen {g}"));
        // the reference codec itself still carries them: the constraint is
        // the economy key's, not WideHostRef's
        assert_eq!(WideHostRef::from_bytes(&r.to_bytes()), Ok(r));
        // ... and the holding record refuses the same generation
        assert!(matches!(
            WideHolding::found(world(), SEASON, coord(), 3, g, 2, OWNER, &Decision::Decided(())),
            Err(frontier_abi::world_index::HoldingError::SiteOrGen { site: 3, gen }) if gen == g
        ));
    }
    // a sequence is still judged first
    let host0 = WideHostRef::new(key(), 3, 0, 7).unwrap();
    assert_eq!(eco::economy_key(&host0), Err(EconomyError::Sequence(7)));
    assert_eq!(
        eco::decode_key(&host0.to_bytes()),
        Err(EconomyError::Sequence(7))
    );
    // the legacy map: ring 128 and below, in every direction
    for (p, q) in [
        (0i64, 0i64),
        (1, 0),
        (128, 0),
        (-128, 0),
        (0, 128),
        (0, -128),
        (64, 64),
        (-64, -64),
        (128, -128),
        (-128, 128),
        (-100, 28),
    ] {
        let c = WideCoord::checked(p, q).unwrap();
        let ring = c.ring();
        assert!(ring <= 128, "({p},{q}) ring {ring}");
        let r = WideHostRef::new(ProvinceKey::new(world(), c), 3, 1, 0).unwrap();
        refused(r, EconomyError::NotWide { ring }, &format!("({p},{q})"));
        assert!(matches!(
            WideHolding::found(world(), SEASON, c, 3, 1, 2, OWNER, &Decision::Decided(())),
            Err(frontier_abi::world_index::HoldingError::NotWide { ring: got }) if got == ring
        ));
    }
    // wide rings at negative and mixed-sign coordinates pass everywhere:
    // the key round-trips, the record writes and decodes to the same
    // holding, and the holding's own snapshot at that coordinate hashes
    for (p, q) in [
        (-129i64, 0i64),
        (0, -129),
        (129, -129),
        (-129, 129),
        (-200, 50),
        (77, -300),
        (-150, -150),
    ] {
        let c = WideCoord::checked(p, q).unwrap();
        assert!(c.ring() >= land::FIRST_WIDE_RING, "({p},{q})");
        let pk = ProvinceKey::new(world(), c);
        for g in [1u8, 2, 254] {
            let r = WideHostRef::new(pk, 3, g, 0).unwrap();
            assert_eq!(eco::check_holding_ref(&r), Ok(()), "({p},{q}) gen {g}");
            let b = eco::economy_key(&r).unwrap();
            assert_eq!(b, r.to_bytes());
            assert_eq!(eco::decode_key(&b), Ok(r));
            let n = write_body(WideKind::Economy, 1, &b, &pp, &mut buf).unwrap();
            assert_eq!(n, HEAD_LEN + HOLDING_KEY_LEN + ECONOMY_PAYLOAD_LEN);
            let body = encode(WideKind::Economy, 1, &b, &pp, &[l_h]).unwrap();
            let rec = WideRecord::decode(&body).unwrap();
            assert_eq!(rec.holding(), Some(r));
            assert_eq!(rec.province_of(), Some(pk));
            assert_eq!(rec.host(), None);
            let bm = encode(WideKind::EconomyMirror, 1, &b, &mp, &[l_p, l_h]).unwrap();
            assert_eq!(WideRecord::decode(&bm).unwrap().holding(), Some(r));
        }
        // the generation-1 holding at this coordinate, as founded
        let r = WideHostRef::new(pk, 3, 1, 0).unwrap();
        let (hd, pd) = (holding_bytes_at(c), province_bytes_at(c));
        let snaps = Snapshots {
            citizen: &cz,
            holding: &hd,
            province: &pd,
        };
        assert_eq!(eco::check_snapshots(&r, &snaps), Ok(()), "({p},{q})");
        let input = eco::input_digest(&r, Action::Harvest, 1, &season, &snaps).unwrap();
        let output = eco::output_digest(&r, Action::Harvest, 1, false, &snaps).unwrap();
        assert_ne!(input, output);
        // the same snapshot under the holding at the fixture's coordinate
        // is not that holding's
        assert_eq!(
            eco::check_snapshots(&holding_ref(), &snaps),
            Err(EconomyError::Identity)
        );
    }
}

// ------------------------------------------------------------ the records

/// Kinds 15 and 16 are keyed by the 56-byte holding reference: a full
/// identity, no host derived from it, attributed to the holding and to
/// its own province; the codec refuses a sequence, a foreign payload and
/// the wrong kind for the action; the maximum body is unchanged.
#[test]
fn economy_records_are_holding_keyed_with_full_identity_and_no_phantom_host() {
    // the kind space
    assert_eq!(WideKind::Economy as u8, 15);
    assert_eq!(WideKind::EconomyMirror as u8, 16);
    assert_eq!(WideKind::from_u8(15), Some(WideKind::Economy));
    assert_eq!(WideKind::from_u8(16), Some(WideKind::EconomyMirror));
    assert_eq!(WideKind::from_u8(18), None);
    assert_eq!(ALL_KINDS.len(), 17);
    assert!(ALL_KINDS.contains(&WideKind::Economy));
    assert!(ALL_KINDS.contains(&WideKind::EconomyMirror));
    for k in [WideKind::Economy, WideKind::EconomyMirror] {
        assert!(!k.host_keyed());
        assert!(k.holding_keyed());
        assert_eq!(k.key_len(), HOLDING_KEY_LEN);
        assert_eq!(k.key_len(), HOST_REF_LEN);
        assert_ne!(k.key_len(), HOST_KEY_LEN);
        assert_ne!(k.key_len(), PROVINCE_KEY_LEN);
        assert_eq!(k.payload_len(), ECONOMY_PAYLOAD_LEN);
        assert!(k.name().starts_with("WIDE_ECONOMY"));
        assert!(
            HEAD_LEN + k.key_len() + k.payload_len() + 1 + k.links().len() * LINK_LEN <= MAX_BODY
        );
    }
    assert_eq!(WideKind::Economy.links(), &[WideEntity::Holding]);
    assert_eq!(
        WideKind::EconomyMirror.links(),
        &[WideEntity::Province, WideEntity::Holding]
    );
    assert_eq!(WideKind::Economy.name(), "WIDE_ECONOMY");
    assert_eq!(WideKind::EconomyMirror.name(), "WIDE_ECONOMY_MIRROR");
    for k in ALL_KINDS {
        assert!(!(k.host_keyed() && k.holding_keyed()));
        assert_eq!(k.holding_keyed(), k.key_len() == HOLDING_KEY_LEN);
    }
    assert_eq!(
        MAX_BODY,
        HEAD_LEN + HOST_KEY_LEN + 82 + 1 + MAX_LINKS * LINK_LEN,
        "the longest body is still a TransitSettled"
    );
    assert_eq!(MAX_BODY, 277);
    // a plain record
    let h = holding_ref();
    let hk = eco::economy_key(&h).unwrap();
    let plain = receipt(Action::Train { unit: 1, n: 100 });
    let pp = economy_payload(&plain).unwrap();
    let mut c = Chains::new();
    let body = c.record(WideKind::Economy, 7, &hk, &pp);
    assert_eq!(body.len(), HEAD_LEN + 56 + 80 + 1 + LINK_LEN);
    assert_eq!(body[0], WIDE_EVENT_VERSION);
    assert_eq!(body[1], 15);
    let r = WideRecord::decode(&body).unwrap();
    assert_eq!((r.kind, r.bell), (WideKind::Economy, 7));
    assert_eq!(r.key, &hk[..]);
    assert_eq!(r.key.len(), 56);
    assert_eq!(r.receipt(), Some(plain));
    assert_eq!(r.host(), None, "no phantom host from a holding key");
    assert_eq!(r.standing(), None);
    assert_eq!(r.province(), None, "a holding key is no province key");
    assert_eq!(r.holding(), Some(h));
    assert_eq!(r.holding_of(), Some(h));
    assert_eq!(r.province_of(), Some(key()), "its own province");
    assert_eq!(r.home_of(), Some(key()));
    assert_eq!(r.sealed_dest(), None);
    assert!(r.concerns(WideTarget::Holding(h)));
    assert!(
        r.concerns(WideTarget::Holding(
            WideHostRef::new(key(), 3, 1, 9).unwrap()
        )),
        "the holding of any sequence"
    );
    assert!(r.concerns(WideTarget::Province(key())));
    assert!(!r.concerns(WideTarget::Province(key_at(130))));
    assert!(!r.concerns(WideTarget::Holding(
        WideHostRef::new(key(), 4, 1, 0).unwrap()
    )));
    assert!(!r.concerns(WideTarget::Holding(
        WideHostRef::new(key(), 3, 2, 0).unwrap()
    )));
    assert!(r.link(WideEntity::Holding).is_some());
    assert_eq!(r.link(WideEntity::Province), None);
    assert_eq!(r.links[1], None);
    // the deployed decoders refuse the version byte, as for every kind
    assert_eq!(
        frontier_abi::log::decode(&body).err(),
        Some(frontier_abi::log::LogError::Version(0x82))
    );
    // a mirror record
    let mirror = receipt(Action::Build {
        item: BUILD_ITEM_TIER_UP,
    });
    let mp = economy_payload(&mirror).unwrap();
    let body_m = c.record(WideKind::EconomyMirror, 8, &hk, &mp);
    assert_eq!(body_m.len(), HEAD_LEN + 56 + 80 + 1 + 2 * LINK_LEN);
    let rm = WideRecord::decode(&body_m).unwrap();
    assert_eq!(rm.kind, WideKind::EconomyMirror);
    assert_eq!(rm.receipt(), Some(mirror));
    assert_eq!(rm.host(), None);
    assert_eq!(rm.holding_of(), Some(h));
    assert_eq!(rm.province_of(), Some(key()));
    assert_eq!(rm.home_of(), Some(key()));
    assert!(rm.link(WideEntity::Province).is_some() && rm.link(WideEntity::Holding).is_some());
    // kind / receipt consistency at encoding
    let mut buf = [0u8; MAX_BODY];
    assert!(write_body(WideKind::Economy, 1, &hk, &mp, &mut buf).is_none());
    assert!(write_body(WideKind::EconomyMirror, 1, &hk, &pp, &mut buf).is_none());
    assert!(encode(
        WideKind::Economy,
        1,
        &hk,
        &mp,
        &[link(WideEntity::Holding, 1, 1)]
    )
    .is_none());
    assert!(encode(
        WideKind::EconomyMirror,
        1,
        &hk,
        &pp,
        &[
            link(WideEntity::Province, 1, 1),
            link(WideEntity::Holding, 1, 2)
        ]
    )
    .is_none());
    // ... and at decoding, on bodies forged past the writer
    let l_h = link(WideEntity::Holding, 1, 1);
    let l_p = link(WideEntity::Province, 1, 2);
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &mp, &[l_h])),
        Err(EventError::Payload),
        "a mirror action under the plain kind"
    );
    assert_eq!(
        WideRecord::decode(&forged(16, &hk, &pp, &[l_p, l_h])),
        Err(EventError::Payload),
        "a plain action under the mirror kind"
    );
    let mut bad_v = pp;
    bad_v[0] = 2;
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &bad_v, &[l_h])),
        Err(EventError::Payload),
        "an unknown receipt version"
    );
    let mut bad_a = pp;
    bad_a[1] = 3;
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &bad_a, &[l_h])),
        Err(EventError::Payload),
        "an unknown action"
    );
    let mut bad_pad = pp;
    bad_pad[1..7].copy_from_slice(&[1, 2, 0, 0, 0, 1]);
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &bad_pad, &[l_h])),
        Err(EventError::Payload),
        "non-canonical padding"
    );
    let mut bad_b = pp;
    bad_b[15] = 2;
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &bad_b, &[l_h])),
        Err(EventError::Payload),
        "a non-canonical bool"
    );
    // the key: a sequence names a host and is refused, at both ends
    let host = WideHostRef::new(key(), 3, 1, 7).unwrap();
    let host_bytes = host.to_bytes();
    assert!(write_body(WideKind::Economy, 1, &host_bytes, &pp, &mut buf).is_none());
    assert_eq!(
        WideRecord::decode(&forged(15, &host_bytes, &pp, &[l_h])),
        Err(EventError::Key),
        "wrong sequence"
    );
    let mut bad_key = hk;
    bad_key[0] = 9;
    assert_eq!(
        WideRecord::decode(&forged(15, &bad_key, &pp, &[l_h])),
        Err(EventError::Key),
        "a reference version byte"
    );
    let mut zero_world = hk;
    zero_world[1..33].fill(0);
    assert_eq!(
        WideRecord::decode(&forged(15, &zero_world, &pp, &[l_h])),
        Err(EventError::Key),
        "the reserved world"
    );
    let mut site12 = hk;
    site12[50] = 12;
    assert_eq!(
        WideRecord::decode(&forged(15, &site12, &pp, &[l_h])),
        Err(EventError::Key),
        "a site that is no holding"
    );
    // the 106-byte host key of the other kinds is not this key: the
    // decoder takes the first 56 bytes as the key (they are the holding
    // reference and pass) and the next 80 as the receipt, so the 50
    // standing-province bytes land where the receipt's version byte and
    // action go and are refused as a payload, before the trailing bytes
    // are ever reached
    let mut hostkey = Vec::new();
    hostkey.extend_from_slice(&hk);
    hostkey.extend_from_slice(&key().to_bytes());
    assert_eq!(hostkey.len(), HOST_KEY_LEN);
    assert_eq!(
        WideRecord::decode(&forged(15, &hostkey, &pp, &[l_h])),
        Err(EventError::Payload)
    );
    // the link set is exact: a province link on a plain receipt, a single
    // link on a mirror one, none on either
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &pp, &[l_p])),
        Err(EventError::Links)
    );
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &pp, &[l_p, l_h])),
        Err(EventError::Links)
    );
    assert_eq!(
        WideRecord::decode(&forged(15, &hk, &pp, &[])),
        Err(EventError::Links)
    );
    assert_eq!(
        WideRecord::decode(&forged(16, &hk, &mp, &[l_h])),
        Err(EventError::Links)
    );
    assert_eq!(
        WideRecord::decode(&forged(16, &hk, &mp, &[l_p])),
        Err(EventError::Links)
    );
    assert!(encode(WideKind::Economy, 1, &hk, &pp, &[l_p]).is_none());
    assert!(encode(WideKind::Economy, 1, &hk, &pp, &[l_p, l_h]).is_none());
    assert!(encode(WideKind::EconomyMirror, 1, &hk, &mp, &[l_h]).is_none());
    // widths: a short or long key or payload never writes
    assert!(write_body(WideKind::Economy, 1, &hk[..55], &pp, &mut buf).is_none());
    assert!(write_body(WideKind::Economy, 1, &key().to_bytes(), &pp, &mut buf).is_none());
    assert!(write_body(WideKind::Economy, 1, &hk, &pp[..79], &mut buf).is_none());
    assert_eq!(
        WideRecord::decode(&body[..body.len() - 1]),
        Err(EventError::Short)
    );
    let mut x = body.clone();
    x.push(0);
    assert_eq!(WideRecord::decode(&x), Err(EventError::Trailing));
}

/// A holding-only Economy receipt is attributed to the holding's own
/// province, yet it chains the holding alone: the province's chain
/// verifies over it unchanged (attribution never demands a link); the
/// mirror receipt chains both; tampering breaks exactly the chain it
/// touches; another holding's receipts never move this one's chain.
#[test]
fn holding_only_economy_attributed_to_its_province_leaves_the_province_chain_unchanged() {
    let h = holding_ref();
    let hk = eco::economy_key(&h).unwrap();
    let zero = (0u64, [0u8; 32]);
    let prov = WideTarget::Province(key());
    let hold = WideTarget::Holding(h);
    let plain = economy_payload(&receipt(Action::Harvest)).unwrap();
    let mirror = economy_payload(&receipt(Action::Build {
        item: BUILD_ITEM_WALLS,
    }))
    .unwrap();
    let mut c = Chains::new();
    let e1 = c.record(WideKind::Economy, 1, &hk, &plain);
    let r1 = WideRecord::decode(&e1).unwrap();
    assert!(r1.concerns(prov), "attributed to its own province");
    assert!(!r1.kind.links().contains(&WideEntity::Province));
    assert_eq!(
        verify_chain(prov, zero, [e1.as_slice()]),
        Ok(zero),
        "the province's chain is left exactly as it was"
    );
    assert_eq!(verify_chain(hold, zero, [e1.as_slice()]), Ok(c.holding));
    assert_eq!(c.holding.0, 1);
    assert_eq!(c.province, zero);
    // a second plain receipt, a province resolve in between, then a mirror
    let e2 = c.record(WideKind::Economy, 2, &hk, &plain);
    let rp = resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true);
    let rs = c.record(WideKind::Resolve, 3, &key().to_bytes(), &rp);
    let m = c.record(WideKind::EconomyMirror, 4, &hk, &mirror);
    let log = [e1.as_slice(), e2.as_slice(), rs.as_slice(), m.as_slice()];
    assert_eq!(verify_chain(prov, zero, log), Ok(c.province));
    assert_eq!(c.province.0, 2, "the resolve and the mirror receipt only");
    assert_eq!(verify_chain(hold, zero, log), Ok(c.holding));
    assert_eq!(c.holding.0, 3, "the three receipts, not the resolve");
    // the province chain is identical with every plain receipt removed
    let no_plain = [rs.as_slice(), m.as_slice()];
    assert_eq!(verify_chain(prov, zero, no_plain), Ok(c.province));
    // ... and the holding chain breaks without them
    assert_eq!(
        verify_chain(hold, zero, no_plain),
        Err(EventError::Chain {
            entity: WideEntity::Holding,
            seq: 0
        })
    );
    // tampering: a receipt byte breaks the holding's chain at that record
    let mut bad = e2.clone();
    bad[HEAD_LEN + HOLDING_KEY_LEN + 7] ^= 1; // now_ts
    let tampered = [e1.as_slice(), bad.as_slice(), rs.as_slice(), m.as_slice()];
    assert_eq!(
        verify_chain(hold, zero, tampered),
        Err(EventError::Chain {
            entity: WideEntity::Holding,
            seq: 1
        })
    );
    assert_eq!(
        verify_chain(prov, zero, tampered),
        Ok(c.province),
        "the province never read the plain receipt"
    );
    // a mirror whose province link skips the resolve is refused as the
    // province's, and accepted as the holding's (its holding link is right)
    let skipped = [e1.as_slice(), e2.as_slice(), m.as_slice()];
    assert_eq!(
        verify_chain(prov, zero, skipped),
        Err(EventError::Chain {
            entity: WideEntity::Province,
            seq: 0
        })
    );
    assert_eq!(verify_chain(hold, zero, skipped), Ok(c.holding));
    // another holding of the same province: its receipts share the
    // province chain through its mirror writes only, and never touch this
    // holding's chain
    let other = WideHostRef::new(key(), 5, 1, 0).unwrap();
    let ok = eco::economy_key(&other).unwrap();
    let mut co = Chains::new();
    co.province = c.province;
    let oe = co.record(WideKind::Economy, 5, &ok, &plain);
    let om = co.record(WideKind::EconomyMirror, 6, &ok, &mirror);
    let all = [
        e1.as_slice(),
        e2.as_slice(),
        rs.as_slice(),
        m.as_slice(),
        oe.as_slice(),
        om.as_slice(),
    ];
    assert_eq!(verify_chain(prov, zero, all), Ok(co.province));
    assert_eq!(co.province.0, 3);
    assert_eq!(verify_chain(hold, zero, all), Ok(c.holding));
    assert_eq!(
        verify_chain(WideTarget::Holding(other), zero, all),
        Ok(co.holding)
    );
    assert_eq!(co.holding.0, 2);
    // a province key that is this holding's home but another world is
    // nothing of this chain
    let elsewhere =
        WideTarget::Province(ProvinceKey::new(WorldId::new([0x78; 32]).unwrap(), coord()));
    assert_eq!(verify_chain(elsewhere, zero, all), Ok(zero));
}
