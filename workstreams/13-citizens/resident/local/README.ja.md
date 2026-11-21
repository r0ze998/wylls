# ⑬ 住民をローカルの世界の外部の住民として動かす（TEST のみ）

2026-11-22。`reports/playable-2-3-4-13.md` §2 の 2 番目。⑬ の頭脳（目標・上限・記憶）を、⑤B（#57）の外部の住民の道に載せた。
プログラムも relay もランチャーも変えていない。モデルも有料 API も使わない（規則だけ）。

## 動かし方

```sh
# 1 回だけ：TEST 鍵（0600、公開アドレスだけを表示）
node -e "import('./workstreams/03-composability/mcp/examples/external-resident/key.mjs').then(m => console.log(m.createKeyFile('/path/r13.json').address))"
# 世界：運営がそのアドレスを受け入れる
scripts/play-local.sh --demo --ai 1 --external <アドレス>
# 住民：自分のプロセス、自分の鍵
node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41920 --key /path/r13.json \
  --dir /絶対パス/r13 [--goal village-first|surplus-use] [--nation 0-5] [--mcp http://127.0.0.1:<port>/mcp]
```

判断の記録は `<dir>/decisions.jsonl`、記憶は `<dir>/state.json`（rename で書く）。`touch <dir>/HALT` で一時停止。

## 対応表

| ⑬ の部品 | ローカルでの意味 | ファイル |
|---|---|---|
| 参加（`live/candidates.mjs` UNSUPPORTED.join） | ⑤B の新しい住民の道：運営が公開アドレスを受け入れ、住民がページと同じ開始の道を押し、自分で Join に署名する | `client.mjs` → `agent.mjs` `discoverWorld` |
| 目標 `GOALS`（growth・use・planDepth・reserve・patienceBells） | growth：計画の建物（その村がいちばん少なく作る資源、ページの `BUILD_ITEMS` と `buildOffers` の数）。use：計画と蓄えを超えた在庫で兵を訓練、予備兵 100 以上で部隊を編成 | `brain.mjs` `assessReal`・`localCandidates` |
| 候補と「保留の理由」 | 6 つの命令それぞれ。読めない数は保留（0 とみなさない） | `brain.mjs` |
| 決め方 | 料金のかからない規則（点数がいちばん高い保留なしの候補）。provider を差すときは ⑬ の `decideLive` の境界（`charges:false`、提示した候補だけ） | `brain.mjs` `decideLocal` |
| 上限 `DEFAULT_LIMITS` | 1 ターン 1 回（世界の規則、設定ではない）。失敗ごとに保留が倍（4・8・16・32、最大 36 ターン）。待つと見る間隔が倍（最大 4 ターン）。判断回数 500。1 日 144 回。Harvest は他にすることがないとき 6 ターンに 1 回 | `brain.mjs` `LOCAL_LIMITS`、`runner.mjs` |
| 記憶・再起動 | `intended` を保存 → 署名を保存（送る前）→ 送る → 署名で結果を追う。再起動で `intended` は「送っていない」。署名のある未決の行がある間は新しい命令を出さない | `journal.mjs`、`runner.mjs` |
| 観測 | 公開の herald の自分の記録だけ（`/h/season`、`/h/status`、`/h/me/<自分>`、村が無い間は自分の国の州の空き地、村ができたら自分の州だけ：`resolvedNext` を見て、世界の決着が前のターンに届くまで編成を保留する。プログラムの `resident_ok` と同じで、ページの「編成」ボタンも同じ理由で止まる）。MCP は読み取りだけ（記録用に村の在庫を読む） | `observe.mjs` |

S1 の値から変えた上限（住民自身の設定。世界より厳しい側）：`wakeEveryBells` 3→1、`actionsPerDay` 12→144、`idleBackoffMaxBells` 24→4。
S1 の値は S1 の 30/時のバケットに合わせたもので、1 ターン 1 回の世界では 30 ターンに 10 回しか動けないため。

## できないこと

- 隊商・掲示板の返答と送り・行軍・投票：ローカルの act relay にない（6 つの命令だけ）。隊商は Q4（r0ze の判断待ち）。
- 広い土地（`--wide`）：play-local が `--external` と一緒に使わせない（住民は PlaceHome で家を置く）。
