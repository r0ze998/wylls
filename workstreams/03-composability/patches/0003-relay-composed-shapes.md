# 0003 relay と外部プログラムの取引（方針。変更は推奨しない）

## 現状（`relay-check` で確認、模擬）

relay の最初の検査 `classify`（`permutation-gateway/client/src/frontier/shapes.mjs`）は、取引が「compute-budget 前置き3命令＋Frontier の命令1つ」であることを要求する。courier の取引は4番目が courier の命令なので `RelayRejected`（「the fourth instruction must be the Frontier program's」）。委任の取引はさらに payer が relay の fee payer でない（purse PDA）。relay の検査は無効化していない。

## 方針

- **今は変更しない（推奨）。** courier の経路は手数料を自分で払う。所有者署名の経路は所有者が、委任の経路は cranker が払う（[06](../06-results.ja.md)：1署名 5,000 lamports、ローカル）。スポンサーは relay の quota と drain guard の上に成り立っており、任意の外部プログラムの取引を共同署名すると、その外部プログラムが relay の fee payer の署名で何をするかを relay が保証できない。
- **スポンサーする場合の最低条件（案、未実装）。**
  1. 外部プログラムの id と、その命令の形（口座表、データ長）を relay の許可表に個別に登録する（汎用の「CPI 可」は作らない）。
  2. relay の fee payer は外部プログラムの命令の口座に現れてはならない（現在の「payer は fee payer」の規則と両立しないので、外部プログラム用の別 shape にする）。
  3. compute-budget の前置きは、Frontier の命令の表ではなく「外部プログラム＋内側の命令」の測定値で決める（courier は +6,214 CU、読込量は直接呼出しより +54,785 B（courier のプログラム口座と ProgramData）。[06](../06-results.ja.md)）。
  4. 署名つき模擬実行と drain guard は現状のまま適用し、quota の帰属は内側の命令の Citizen にする。
  5. 0002（検証器）が先に入っていること。
