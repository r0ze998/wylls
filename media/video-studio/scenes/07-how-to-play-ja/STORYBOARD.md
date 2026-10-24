# 07 how-to-play-ja: 遊び方 (16:9, 55 s, heroic)

Left column: STEP numeral, title, two-line body, fact chips, step rail. Right: a framed viewport that shows a real client capture (assets/ui, labelled 実際のクライアント画面(テストデータ)) or a map illustration (labelled 説明用のイメージ). Badge ローカルテストチェーンで実行 throughout.

| t (s) | Step | Viewport | Sources |
|---|---|---|---|
| 0–4.5 | Wyllsの遊び方 / 5つのステップ | WYMap assemble | |
| 4.5–13.5 | 1 国を選ぶ: 選ぶのは国だけ。村はその場で置かれる。 | scene-join-ja: push to the six cards, then the start button | FACTS §3 PlaceHome |
| 13.5–23.5 | 2 育てる: 資源はリアルタイムで増える。建てて、兵を訓練する。 | scene-hand-build-ja then scene-hand-train-ja (訓練はすぐに終わり…); time-lapse counters (rates from the capture) | FACTS §3 |
| 23.5–32 | 3 偵察する: 結果は次のターンに届く。 1ターン=10分・1日144ターン | Map: a Scout walks to the fog, bell 42→43, fog clears on a camp | FACTS §3; unit text (hud/orderparts.mjs) |
| 32–42 | 4 封印して進軍: 最短2ターン。取り消しはできない。 public vs sealed chips | scene-march-ja (seal notice, 封をして出発する), then a sealed march 42→44, opens on arrival | FACTS §3 |
| 42–50.5 | 5 報告を読む: ブラウザが同じルールで再計算する。 監査ではなく、同じルールでの再計算 | scene-report-ja (このブラウザで確かめる), Rust → WebAssembly → このブラウザ → Match | FACTS §3 (describe Match, not "Verified") |
| 50.5–55 | End card | | |
