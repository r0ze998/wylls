# 05 スポンサー relay が受理する形と、実験の取引形

relay の検査は無効化も変更もしていない。比べたのは relay の最初の判定 `classify`（`permutation-gateway/client/src/frontier/shapes.mjs`、`POST /f/relay` が署名・quota・模擬実行より前に呼ぶ）で、`relay-check/relay-shape.test.mjs` が実際の関数に wire 取引を通す（**模擬**: relay を起動せず、何も送らない）。

## 比較

| 項目 | relay が受理する player shape | courier・所有者署名（op 0） | courier・委任（op 2） |
|---|---|---|---|
| 命令の数と順 | 前置き3（CU 上限、CU 価格 0、読込上限）＋ Frontier の命令1 | 前置き＋**courier の命令1**（中で Frontier を CPI） | 同左 |
| 4番目の命令の program | Frontier | courier → **拒否**（`RelayRejected`: the fourth instruction must be the Frontier program's） | courier → **拒否**（同） |
| CU 上限 | 表の値と完全一致（SendCaravan: 140,000） | 実測 34,023 で収まるが、program 違いで先に拒否 | 実測 39,127 |
| 読込上限 | `L(kind)` と完全一致（SendCaravan, S1: 1,835,008） | 必要量 1,809,312（validator の規則、1 Province）で収まる。ただし Province 4つなら約 11 KB の余裕しかない | 1,809,592 |
| payer | relay の fee payer | 所有者（または relay を payer にした形も、program 違いで拒否） | courier の purse PDA（fee payer でない） |
| 署名者 | fee payer ＋ 命令の署名者だけ | 所有者 | cranker だけ（所有者は署名しない） |
| 結果 | `ok: true, kind: 'player'`（試験1） | `ok: false`（試験2） | `ok: false`（試験3、試験4は前置きを Frontier の表の値にしても拒否されることを確認） |

## 使えない経路と、別途必要な対応

1. **courier の取引を relay にスポンサーさせる経路は使えない。** 変えるには relay の許可表に外部プログラム用の shape を新設する必要がある（[patches/0003](patches/0003-relay-composed-shapes.md)、推奨しない・未実装）。
2. **使える経路:** 所有者署名の courier 取引は所有者が手数料を払って RPC に直接送る。委任の取引は cranker が払う。どちらも relay の quota を使わない。
3. **MCP（エージェント財布）経路とは両立しない場合がある。** エージェント財布は Citizen の session 枠にエージェント鍵を置く。courier の委任も同じ枠を使うので、片方を設定すると他方は `Auth` になる（[04](04-interface-contract.ja.md) §4）。
4. **relay の予算表は CPI 取引を想定していない。** CU と読込量の表は Frontier の命令単独の値。外部プログラム分（+6,214 CU、+54,785 B、ローカル）を含めた値が要る。
