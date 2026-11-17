//! The custody demo on the model (`cargo run --example demo`).
//!
//! Case 1: A's ore is deposited in B's vault; B cannot use it; C, whom A
//! allowed, carries it to D's vault, where it is still A's; A withdraws it.
//! Case 2: A lets B use a bounded amount for processing; B cannot use more;
//! A revokes the rest.
//!
//! Every step checks the model's invariants (`World::check`) and the world
//! survives a restart (snapshot → restore) unchanged.

use wylls_custody::model::fixture::{ore, units, Cast, ORE};
use wylls_custody::model::{Whereabouts, World};
use wylls_custody::*;

fn u(m: i64) -> String {
    format!("{}", m / 1000)
}

fn step(c: &mut Cast, what: &str) {
    c.w.check()
        .unwrap_or_else(|e| panic!("invariant after '{what}': {e}"));
    let back = World::restore(&c.w.snapshot());
    assert_eq!(back, c.w, "restart changed the world after '{what}'");
    println!("\n== {what}  (bell {})", c.w.bell);
    let tag = c.w.tag(&c.a);
    for x in c.w.whereabouts(tag) {
        match x {
            Whereabouts::Held {
                lot,
                held,
                reserved,
            } => println!(
                "   A の鉱石: 倉 ({},{}) tile {} gen {} に {} 保管（うち予約 {}）",
                lot.0.p,
                lot.0.q,
                lot.0.tile,
                lot.0.gen,
                u(held),
                u(reserved)
            ),
            Whereabouts::InTransit { caravan, qty, .. } => {
                println!(
                    "   A の鉱石: 輸送中 {} （隊商 {:#x}/{}）",
                    u(qty),
                    caravan.0,
                    caravan.1
                )
            }
            Whereabouts::Unknown { qty, why, .. } => {
                println!("   A の鉱石: 不明 {} — {why}", u(qty))
            }
            Whereabouts::Frozen { qty, why, .. } => {
                println!("   A の鉱石: 凍結 {} — {why}", u(qty))
            }
        }
    }
    let home = c.home(&c.a);
    println!(
        "   A の村の一般在庫 {}、B の倉の一般在庫 {}、D の倉の一般在庫 {}",
        u(c.w.holdings[&home].stores[ORE as usize]),
        u(c.w.vault(&c.vb).unwrap().stores[ORE as usize]),
        u(c.w.vault(&c.vd).unwrap().stores[ORE as usize]),
    );
    let (dep, acc) = c.w.custody_balance(tag);
    if dep > 0 {
        println!(
            "   保存則: 預け入れ {} = 保管+輸送中+引出し+消費+損失 {}",
            u(dep),
            u(acc)
        );
    }
}

fn refused(what: &str, r: Result<impl std::fmt::Debug, wylls_custody::model::Error>) {
    match r {
        Err(e) => println!("   拒否 ✓ {what}: {e:?}"),
        Ok(x) => panic!("{what} should be refused, got {x:?}"),
    }
}

fn main() {
    let mut c = Cast::new();
    let (a, b, cc, d) = (
        Cast::wallet(c.a),
        Cast::wallet(c.b),
        Cast::wallet(c.cc()),
        Cast::wallet(c.d),
    );
    println!("WYLLS ⑩ 所有権を保った保管・輸送・利用（モデル上のデモ。プログラムではない）");
    println!("A=所有者 B=保管者 C=運搬者 D=指定先の保管者 E=別国の襲撃者。資源は鉱石のみ。");

    // ---- Case 1
    let lot_b = c.w.open_lot(&b, c.vb, c.a, ORE, units(500)).unwrap();
    step(
        &mut c,
        "1. B が自分の倉に A 用の区画（容量 500）を開く（B の財布署名）",
    );

    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let k1 = c.w.deposit(&a, seq, home, lot_b, units(300), 0).unwrap();
    step(
        &mut c,
        "2. A が村から 300 を預け入れに出す（A の財布署名、到着先の容量を予約）",
    );
    refused(
        "同じ依頼の再送",
        c.w.deposit(&a, seq, home, lot_b, units(300), 0),
    );
    c.w.advance(10);
    c.w.settle_custody(k1).unwrap();
    step(
        &mut c,
        "3. 到着・精算（誰でも実行できる）：B の倉の A の区画に入る。B の一般在庫は増えない",
    );

    println!("   -- B が勝手に使おうとする --");
    refused(
        "B が倉から A の鉱石を売り送る（一般在庫からしか出せない）",
        c.w.send_caravan(&b, c.vb, c.home(&c.d), ore(200)),
    );
    refused(
        "B が A の区画で運搬依頼を出す",
        c.w.set_order(
            &b,
            lot_b,
            0,
            0,
            OrderSpec {
                kind: ORDER_SHIP,
                grantee: c.cc(),
                qty: units(100),
                expires_bell: c.w.bell + 50,
                dst: c.vd,
                purpose: 0,
            },
        ),
    );
    refused(
        "B が倉を閉じる（預かり品の上で閉じられない）",
        c.w.close_vault(&b, c.vb),
    );
    refused(
        "B が区画の容量を保管量より下げる",
        c.w.set_quota(&b, lot_b, units(100)),
    );
    refused(
        "B が倉の容量（1000 のうち 500 を約束済み）を別の預かりに 600 約束する",
        c.w.open_lot(&b, c.vb, c.d, ORE, units(600)),
    );

    let lot_d = c.w.open_lot(&d, c.vd, c.a, ORE, units(400)).unwrap();
    let id =
        c.w.set_order(
            &a,
            lot_b,
            0,
            0,
            OrderSpec {
                kind: ORDER_SHIP,
                grantee: c.cc(),
                qty: units(200),
                expires_bell: c.w.bell + 100,
                dst: c.vd,
                purpose: 0,
            },
        )
        .unwrap();
    step(
        &mut c,
        "4. D が A 用の区画を開き、A が C に「200 を D の倉へ」運搬を許可（予約）",
    );
    refused(
        "A が同じ鉱石を別の依頼に二重に予約する（利用可能 100 に 150）",
        c.w.set_order(
            &a,
            lot_b,
            1,
            1,
            OrderSpec {
                kind: ORDER_USE,
                grantee: c.b,
                qty: units(150),
                expires_bell: c.w.bell + 100,
                dst: Default::default(),
                purpose: 1,
            },
        ),
    );

    let seq = c.w.next_seq(&c.cc());
    refused(
        "C が指定先以外（自分の村）へ運ぶ",
        c.w.ship(
            &cc,
            seq,
            lot_b,
            By::Order { slot: 0, id },
            units(200),
            ShipTo::OwnPlace(c.home(&c.cc())),
            0,
        ),
    );
    refused(
        "C が許可量を超えて運ぶ",
        c.w.ship(
            &cc,
            seq,
            lot_b,
            By::Order { slot: 0, id },
            units(250),
            ShipTo::Lot(c.vd),
            0,
        ),
    );
    let k2 =
        c.w.ship(
            &cc,
            seq,
            lot_b,
            By::Order { slot: 0, id },
            units(200),
            ShipTo::Lot(c.vd),
            0,
        )
        .unwrap();
    step(
        &mut c,
        "5. C が 200 を D の倉へ発送（隊商は C のもの・C の国、積荷は A のもの）",
    );

    c.w.advance(10);
    refused(
        "通常の精算（SettleCaravan）で D の一般在庫へ入れようとする",
        c.w.settle_caravan(k2),
    );
    c.w.settle_custody(k2).unwrap();
    step(
        &mut c,
        "6. 到着：D の倉でも A の区画に入る（D の一般在庫は 0 のまま）",
    );
    refused(
        "D が倉から A の鉱石を送る",
        c.w.send_caravan(&d, c.vd, c.home(&c.d), ore(1)),
    );

    let seq = c.w.next_seq(&c.a);
    let k3 =
        c.w.ship(
            &a,
            seq,
            lot_d,
            By::Owner,
            units(200),
            ShipTo::OwnPlace(home),
            0,
        )
        .unwrap();
    c.w.advance(10);
    c.w.settle_caravan(k3).unwrap();
    step(
        &mut c,
        "7. A が D の倉から 200 を自分の村へ引き出す（A の一般在庫に戻る）",
    );

    // ---- Case 2
    println!("\n---- ケース2：数量を限った加工への消費許可 ----");
    let uid =
        c.w.set_order(
            &a,
            lot_b,
            0,
            1,
            OrderSpec {
                kind: ORDER_USE,
                grantee: c.b,
                qty: units(60),
                expires_bell: c.w.bell + 100,
                dst: Default::default(),
                purpose: 7,
            },
        )
        .unwrap();
    step(
        &mut c,
        "8. A が B に「目的 7 の加工に 60 まで」消費を許可（予約。消費はまだ）",
    );
    c.w.consume(&b, lot_b, 0, uid, units(40), 7).unwrap();
    step(&mut c, "9. B が 40 を消費（加工そのものは⑨の担当）");
    refused(
        "B が残り 20 を超えて 30 消費",
        c.w.consume(&b, lot_b, 0, uid, units(30), 7),
    );
    refused(
        "B が別の目的に消費",
        c.w.consume(&b, lot_b, 0, uid, units(10), 8),
    );
    refused(
        "B が session 鍵で消費",
        c.w.consume(&Cast::session(c.b), lot_b, 0, uid, units(10), 7),
    );
    let released = c.w.revoke_order(&a, lot_b, 0, uid).unwrap();
    println!("   A が取り消し：未使用の予約 {} を解放", u(released));
    refused(
        "取消し後に B が消費",
        c.w.consume(&b, lot_b, 0, uid, units(10), 7),
    );
    step(&mut c, "10. 取消し後");

    let tag = c.w.tag(&c.a);
    let (dep, acc) = c.w.custody_balance(tag);
    assert_eq!(dep, acc);
    println!(
        "\n完了：全段階で不変条件と再起動後の一致を確認。損失 {:?}",
        c.w.losses(tag)
    );
}

trait Carrier {
    fn cc(&self) -> [u8; 32];
}

impl Carrier for Cast {
    fn cc(&self) -> [u8; 32] {
        self.c
    }
}
