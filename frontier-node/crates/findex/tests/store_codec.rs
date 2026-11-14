//! Round 13 (TEST-ONLY): the store codec ([`findex::codec`]) through the public API. The default writes the same bytes as
//! before; gzip-v1 gives back every record and every snapshot byte; a store is never reopened in another codec; the frame
//! check, the sequence check and the torn-tail recovery hold for compressed frames. No world, no network.
use std::fs;
use std::path::{Path, PathBuf};

use fclient::ports::{Account, Signature, TxRecord};
use findex::archive::Archive;
use findex::codec::{Codec, GZIP_V1};
use findex::index::Index;
use findex::Findex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

const PROGRAM: [u8; 32] = [0xAB; 32];
const SEG: u64 = 1 << 20;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "findex-codec-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let _ = fs::remove_dir_all(&d);
    d
}

/// A province-like account body: ≈4.7 KB, mostly zero bytes (as the live store's snapshots).
fn province(i: u64) -> Vec<u8> {
    let mut v = vec![0u8; 4736];
    v[..8].copy_from_slice(b"PSF1PROV");
    v[8..16].copy_from_slice(&i.to_le_bytes());
    for k in (64..4736).step_by(211) {
        v[k] = (k as u64 + i) as u8;
    }
    v
}

fn rec(i: u64) -> TxRecord {
    TxRecord {
        seq: i,
        slot: 100 + i,
        signature: Signature::from([i as u8; 64]),
        block_time: 1_800_000_000 + i as i64,
        tx: vec![i as u8; 40],
        logs: vec![],
        err: None,
        code: None,
        units: 1_000,
        fee: 5_000,
        post: vec![(
            Address::new_from_array([(i % 7) as u8 + 1; 32]),
            Some(Account { lamports: 1_000 + i, data: province(i), owner: Address::new_from_array(PROGRAM), executable: false }),
        )],
    }
}

fn recs(n: u64) -> Vec<TxRecord> {
    (1..=n).map(rec).collect()
}

fn write(dir: &Path, codec: Codec, n: u64) -> Archive {
    let mut a = Archive::open_with(dir, SEG, codec).unwrap();
    a.append(&recs(n), json!({"slot": n})).unwrap();
    a.commit().unwrap();
    a
}

fn manifest(dir: &Path) -> Value {
    serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap()
}

/// The frames of a segment: (offset, stored payload).
fn frames(seg: &[u8]) -> Vec<(usize, Vec<u8>)> {
    let (mut o, mut out) = (0usize, vec![]);
    while o + 12 <= seg.len() {
        let n = u32::from_le_bytes(seg[o..o + 4].try_into().unwrap()) as usize;
        out.push((o, seg[o + 12..o + 12 + n].to_vec()));
        o += 12 + n;
    }
    out
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut f = (payload.len() as u32).to_le_bytes().to_vec();
    f.extend_from_slice(&Sha256::digest(payload)[..8]);
    f.extend_from_slice(payload);
    f
}

#[test]
fn the_default_writes_the_same_bytes_as_before_and_records_nothing() {
    let (a, b) = (tmp("plain-a"), tmp("plain-b"));
    // `open` (as every caller before) and `open_with(Plain)` write the same files
    {
        let mut x = Archive::open(&a, SEG).unwrap();
        x.append(&recs(5), json!({"slot": 5})).unwrap();
        x.commit().unwrap();
    }
    write(&b, Codec::Plain, 5);
    for f in ["manifest.json", "seg-000001.log"] {
        assert_eq!(fs::read(a.join(f)).unwrap(), fs::read(b.join(f)).unwrap(), "{f}");
    }
    assert!(manifest(&a).get("codec").is_none(), "no codec key in a default manifest");
    // the frames are the JSON records themselves
    let seg = fs::read(a.join("seg-000001.log")).unwrap();
    let fr = frames(&seg);
    assert_eq!(fr.len(), 5);
    let v: Value = serde_json::from_slice(&fr[0].1).unwrap();
    assert_eq!(v, findex::archive::record_to_json(&TxRecord { seq: 1, ..rec(1) }));
    // the store: no snapshot_codec row in a default index
    let f = tmp("plain-store");
    let s = Findex::open(&f, Address::new_from_array(PROGRAM), Some(3), SEG).unwrap();
    let rows: i64 = s.index.conn.query_row("SELECT COUNT(*) FROM meta WHERE k = 'snapshot_codec'", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
    for d in [a, b, f] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn gzip_gives_back_every_record_and_is_smaller() {
    let (p, g) = (tmp("size-plain"), tmp("size-gzip"));
    write(&p, Codec::Plain, 40);
    write(&g, Codec::GzipV1, 40);
    assert_eq!(manifest(&g)["codec"], json!(GZIP_V1));
    let seg = fs::read(g.join("seg-000001.log")).unwrap();
    assert_eq!(&frames(&seg)[0].1[..2], &[0x1f, 0x8b], "stored gzip");
    let (ps, gs) = (fs::metadata(p.join("seg-000001.log")).unwrap().len(), seg.len() as u64);
    assert!(gs * 5 < ps, "gzip {gs} B vs plain {ps} B");
    let back = Archive::open_with(&g, SEG, Codec::GzipV1).unwrap();
    assert_eq!(back.codec(), Codec::GzipV1);
    assert_eq!(back.verify().unwrap(), 40);
    let read = back.read_after(0).unwrap();
    let want = Archive::open_with(&p, SEG, Codec::Plain).unwrap().read_after(0).unwrap();
    assert_eq!(read, want, "the same records, byte for byte");
    assert_eq!(back.read_after(37).unwrap().len(), 3);
    for d in [p, g] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn gzip_snapshots_give_back_every_byte_and_are_stored_compressed() {
    let d = tmp("snap");
    write(&d.join("archive"), Codec::GzipV1, 12);
    let s = Findex::open_with(&d, Address::new_from_array(PROGRAM), Some(3), SEG, Codec::GzipV1).unwrap();
    for i in 1..=12u64 {
        let a = Address::new_from_array([(i % 7) as u8 + 1; 32]);
        let snap = s.index.snapshot_at(&a, i).unwrap().unwrap();
        assert_eq!(snap.seq, i);
        assert_eq!(snap.data, province(i), "snapshot {i}: every byte");
    }
    let (n, raw): (i64, i64) = s.index.conn.query_row("SELECT COUNT(*), SUM(length(data)) FROM snapshot", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(n, 12);
    assert!(raw * 5 < 12 * 4736, "stored {raw} B for {} B", 12 * 4736);
    let blob: Vec<u8> = s.index.conn.query_row("SELECT data FROM snapshot LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(&blob[..2], &[0x1f, 0x8b]);
    let rows: i64 = s.index.conn.query_row("SELECT v FROM meta WHERE k = 'snapshot_codec'", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1);
    drop(s);
    // reopened in the same codec: the same answers (no rebuild needed)
    let s = Findex::open_with(&d, Address::new_from_array(PROGRAM), Some(3), SEG, Codec::GzipV1).unwrap();
    assert_eq!(s.index.latest(&Address::new_from_array([6; 32])).unwrap().unwrap().data, province(12));
    let _ = fs::remove_dir_all(d);
}

#[test]
fn a_store_is_never_reopened_in_another_codec() {
    let (p, g) = (tmp("mix-plain"), tmp("mix-gzip"));
    write(&p, Codec::Plain, 3);
    write(&g, Codec::GzipV1, 3);
    assert!(Archive::open_with(&p, SEG, Codec::GzipV1).err().unwrap().to_string().contains("never reopened"));
    assert!(Archive::open_with(&g, SEG, Codec::Plain).err().unwrap().to_string().contains("never reopened"));
    assert!(Archive::open(&g, SEG).is_err(), "the default open refuses a gzip archive too");
    // an unknown or malformed recorded codec
    for bad in [json!("gzip-v9"), json!(1), json!(null)] {
        let d = tmp("mix-bad");
        write(&d, Codec::GzipV1, 1);
        let mut m = manifest(&d);
        m["codec"] = bad.clone();
        fs::write(d.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(Archive::open_with(&d, SEG, Codec::GzipV1).is_err(), "{bad}");
        assert!(Archive::open_with(&d, SEG, Codec::Plain).is_err(), "{bad}");
        let _ = fs::remove_dir_all(d);
    }
    // the whole store: gzip ↔ default
    let sg = tmp("mix-store-gzip");
    drop(Findex::open_with(&sg, Address::new_from_array(PROGRAM), Some(3), SEG, Codec::GzipV1).unwrap());
    assert!(Findex::open(&sg, Address::new_from_array(PROGRAM), Some(3), SEG).is_err());
    let sp = tmp("mix-store-plain");
    write(&sp.join("archive"), Codec::Plain, 2);
    drop(Findex::open(&sp, Address::new_from_array(PROGRAM), Some(3), SEG).unwrap());
    assert!(Findex::open_with(&sp, Address::new_from_array(PROGRAM), Some(3), SEG, Codec::GzipV1).is_err());
    // the index on its own: a default index that holds records never turns gzip; a gzip index never turns default
    let ip = tmp("mix-index-plain");
    fs::create_dir_all(&ip).unwrap();
    let mut ix = Index::open(&ip.join("i.sqlite"), Address::new_from_array(PROGRAM), Some(findex::addr_ctx(&Address::new_from_array(PROGRAM), 3))).unwrap();
    ix.add(&recs(2)).unwrap();
    assert!(ix.use_snapshot_codec(Codec::GzipV1).unwrap_err().contains("never reopened"));
    ix.use_snapshot_codec(Codec::Plain).unwrap();
    let ig = tmp("mix-index-gzip");
    fs::create_dir_all(&ig).unwrap();
    let mut ix = Index::open(&ig.join("i.sqlite"), Address::new_from_array(PROGRAM), None).unwrap();
    ix.use_snapshot_codec(Codec::GzipV1).unwrap();
    drop(ix);
    let mut ix = Index::open(&ig.join("i.sqlite"), Address::new_from_array(PROGRAM), None).unwrap();
    assert!(ix.use_snapshot_codec(Codec::Plain).unwrap_err().contains("never reopened"));
    ix.use_snapshot_codec(Codec::GzipV1).unwrap();
    for d in [p, g, sg, sp, ip, ig] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn a_torn_tail_of_compressed_frames_is_recovered() {
    let d = tmp("tail");
    write(&d, Codec::GzipV1, 6);
    let seg = d.join("seg-000001.log");
    let named = fs::metadata(&seg).unwrap().len();
    // a crash after a frame's bytes but before the manifest named them: a whole frame and a half one
    let extra = frame(&Codec::GzipV1.encode(br#"{"seq":7}"#));
    let mut bytes = fs::read(&seg).unwrap();
    bytes.extend_from_slice(&extra);
    bytes.extend_from_slice(&extra[..extra.len() / 2]);
    fs::write(&seg, &bytes).unwrap();
    let a = Archive::open_with(&d, SEG, Codec::GzipV1).unwrap();
    assert_eq!(fs::metadata(&seg).unwrap().len(), named, "truncated to what the manifest names");
    assert_eq!(a.read_after(0).unwrap().len(), 6);
    assert_eq!(a.verify().unwrap(), 6);
    let _ = fs::remove_dir_all(d);
}

#[test]
fn damage_order_and_bad_gzip_are_caught() {
    // a flipped stored byte: the frame's sha256 prefix catches it
    let d = tmp("flip");
    write(&d, Codec::GzipV1, 4);
    let seg = d.join("seg-000001.log");
    let mut bytes = fs::read(&seg).unwrap();
    let (o, _) = frames(&bytes)[1].clone();
    bytes[o + 20] ^= 0x40;
    fs::write(&seg, &bytes).unwrap();
    let a = Archive::open_with(&d, SEG, Codec::GzipV1).unwrap();
    assert!(a.read_after(0).unwrap_err().to_string().contains("damaged"));
    assert!(a.verify().is_err());
    let _ = fs::remove_dir_all(&d);

    // two frames swapped (same total length): the sequence check on the decoded records catches it
    let d = tmp("swap");
    write(&d, Codec::GzipV1, 4);
    let seg = d.join("seg-000001.log");
    let bytes = fs::read(&seg).unwrap();
    let fr = frames(&bytes);
    let mut out = vec![];
    for k in [1, 0, 2, 3] {
        out.extend_from_slice(&frame(&fr[k].1));
    }
    assert_eq!(out.len(), bytes.len());
    fs::write(&seg, &out).unwrap();
    let a = Archive::open_with(&d, SEG, Codec::GzipV1).unwrap();
    assert!(a.read_after(0).unwrap_err().to_string().contains("expected 1"));
    assert!(a.verify().unwrap_err().contains("expected 1"));
    let _ = fs::remove_dir_all(&d);

    // a frame whose sha256 prefix is right but whose gzip is not (its CRC-32 flipped): refused on decode
    let d = tmp("crc");
    write(&d, Codec::GzipV1, 2);
    let seg = d.join("seg-000001.log");
    let bytes = fs::read(&seg).unwrap();
    let fr = frames(&bytes);
    let mut bad = fr[1].1.clone();
    let n = bad.len();
    bad[n - 8] ^= 1;
    let mut out = frame(&fr[0].1);
    out.extend_from_slice(&frame(&bad));
    fs::write(&seg, &out).unwrap();
    let a = Archive::open_with(&d, SEG, Codec::GzipV1).unwrap();
    assert!(a.read_after(0).is_err());
    assert!(a.verify().is_err());
    let _ = fs::remove_dir_all(&d);

    // a plain frame inside a gzip archive (not gzip at all): refused, never read as JSON
    let d = tmp("plain-in-gzip");
    write(&d, Codec::GzipV1, 1);
    let seg = d.join("seg-000001.log");
    let raw = serde_json::to_vec(&findex::archive::record_to_json(&rec(1))).unwrap();
    let mut m = manifest(&d);
    let fr = frame(&raw);
    m["segments"][0]["bytes"] = json!(fr.len());
    fs::write(&seg, &fr).unwrap();
    fs::write(d.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    let a = Archive::open_with(&d, SEG, Codec::GzipV1).unwrap();
    assert!(a.read_after(0).is_err());
    let _ = fs::remove_dir_all(&d);
}
