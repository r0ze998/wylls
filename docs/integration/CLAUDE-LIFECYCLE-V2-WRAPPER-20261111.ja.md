# lifecycle → version-2 wrapper: 旧 v1 fixture 不一致の記録（未統合）

- 変更: `wide_expedition_lifecycle_tests.rs` の `run_step` / `versioned()`。`expedition-dispatch-experimental` 時だけ成功呼び出しを既存 version-2 wrapper（`crate::dispatch` → `expedition_dispatch::execute`）経由にする。既定 build は従来の private 経路のまま。
- 実測（1.95 pinned, offline/locked）: 既定 features で対象 lifecycle 1/1 pass。experimental 追加時は resident home Return まで wrapper で成功し、`anchor_resident_fixture` の `return_v1.bin` / `dissolve_v1.bin` 比較だけで不一致。
- 原因: build 差（Season `program_version` 0x4004 → 0x4804）。平文差は Season data offset 139 の 1 byte（before/after）のみ。他は Citizen/Holding/両 Province の `header::EVENT_HEAD`（data 32..64）と log receipt body の hash 領域。同じ experimental build で一時的に private 経路を強制しても wrapper 経路と byte 完全一致したため、routing 起因ではない（診断用変更は復元済み）。
- 未確定: version が chain head へ伝播する具体的経路。2 byte 正規化では hash 差が残るため不可。
- 方針候補（未実施）: 経路の具体確認、または 0x4804 build 用の別 immutable v2 fixture。v1 fixture・skip・Season 除外は変更しない。
