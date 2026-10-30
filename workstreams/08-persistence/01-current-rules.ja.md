# 1. 現行ルール表（基準 commit 4cd901d）

**この表の位置づけ：** PR #22 の統合候補（`4cd901de9f8e0d6c0b2016851d30595c4a70aa46`）の時点で、コードとテストが実際に何をしているかの記録です。main に統合済み・CI 全成功の状態とは扱いません。数値は**現在の設定**であり、永続的な原則ではありません。

- 区分：**［コード］** はプログラム・設定・テストで確かめられるもの。**［文書］** は設計文書・試遊文書にだけあるもの。**［推定］** はコードを読んだ結果の推論で、テストでは確かめていないもの。
- 私が自分でコードを開いて確かめた行には **✔** を付けました。それ以外の行は、調査用エージェントが引用した箇所です。引用先は書いてありますが、私は開いていません。
- 現在のプログラムが受け付けるのは S1 シーズン（program_version 4）だけです（`permutation-frontier/src/proc/season.rs:288-298`）。

## 1-1. 時間とシーズン

| 項目 | 現在の値 | 根拠 | 固定するテスト |
|---|---|---|---|
| ターン（鐘）の長さ ✔ | **600秒（10分）で固定**。これ以外の値は検証で拒否される。1日は144ターン | ［コード］`frontier-abi/src/presets.rs:284`。表示文は `permutation-server/web/frontier/hud/glossary.mjs:20` | `presets_validate_and_round_trip`、`standard_season_dormancy_matches_the_economic_kernel` |
| 標準シーズン ✔ | `S1_LOCAL_14D`（`MC_LOCAL_14D` と同じ値）。`end_bell` 2,016 ターン（14日） | ［コード］`frontier-abi/src/v2/presets.rs:496-514` | 上記に加え `conquest_standard_and_short_integration_seasons_validate` |
| ほかのプリセット | 7日（1,008）、28日（4,032、これが上限） | ［コード］`presets.rs:286,351-403`、`v2/presets.rs:520-551` | `validation_refuses_each_range` |
| 実時間の速さ | stack の `--scale` で実時間だけを速める（既定は100倍、手順書では10倍）。ルール上の1ターンは600秒のまま | ［コード］`frontier-node/crates/stack/src/config.rs:170,298` | — |
| 試遊甲 | 10倍速、`--game-hours 72` で `end_bell` 432、参加締切 324 | ［文書］`docs/frontier/playtest-kou/RUNBOOK.ja.md` | — |

「10分」はターンの長さ、「14日」は標準プリセットのシーズン長です。どちらも設定値なので、以下の比較では変えられるものとして扱います。

## 1-2. 参加と締切

| 項目 | 現在の値 | 根拠 | テスト |
|---|---|---|---|
| 参加締切 ✔ | `now_bell ≥ join_close_bell`（1,512 ターン。**10.5日目**、シーズンの75%）で Join が `WrongStatus` になる | ［コード］`permutation-frontier/src/proc/citizen.rs:341-351` | `citizen_join_creates_the_citizen`（ターン756で拒否） |
| 締切の日数 | 「14日のうち何日まで参加を受け付けるかは未決（Q14）」 | ［文書］`docs/DESIGN-OVERVIEW.md:110` | — |
| 参加の単位 | 1つのウォレットにつき、1シーズン1つの Citizen。2回目の Join は `AlreadyDone` | ［コード］`citizen.rs:375-381` | 同上 |
| 拠点の数 | 1ウォレットあたり最大3つ。枠1が本拠、枠2と3が前哨 | ［コード］`permutation-rules/src/frontier/holding.rs:143` | `cq_join_writes_empty_slots` |
| 本拠の場所 ✔ | PlaceHome は**自国の楔の2〜3環目**にしか置けない（`ReservedSite`／`BadData`）。1シーズンに1回だけ | ［コード］`citizen.rs:1180-1188`、`1095-1112` | `first_home_is_final_sponsored_and_chained_immediately` |
| 国の数 | 6（固定） | ［コード］`permutation-rules/src/frontier/structure.rs:54` | — |
| 国の移籍 | **できない**。所属は Join で一度だけ書かれる | ［コード］`citizen.rs:421`。移籍と無所属は「戦期の作業」に先送り（`docs/frontier/stage1e/S1-1E-CONTRACT.md:16`） | — |

## 1-3. 保護

標準14日プリセットの値です。M1 の定数（48時間・72時間・7日）は、いまの S1 の攻城判定では使われていません。

| 項目 | 標準14日 | 根拠 | テスト |
|---|---|---|---|
| 最初の拠点の盾 ✔ | **24時間**（86,400秒） | ［コード］`v2/presets.rs:442` | `g13_cq_declare_siege_refusals_steps_8_to_10` |
| 遅れて来た拠点の盾 ✔ | 2日目より後に作られた拠点も 24時間 | ［コード］`v2/presets.rs:443-444` | 同上 |
| 辺境の保護 ✔ | ゲーム開始から12時間より後に作った拠点は、盾が切れた後さらに **36時間**。攻撃側の国の最初の拠点が2州以内にあると外れる | ［コード］`v2/presets.rs:445-446`、`permutation-rules/src/frontier/siege.rs:703-707` | 同上（外れる場合も確認） |
| 前哨の盾 | 2時間 | ［コード］`v2/presets.rs:441` | — |
| 本拠の不可侵 | 自国の楔の2〜3環目（中心地）では攻城できない（`Heartland`）。MC と S1 では戦争を宣言できないので、**PlaceHome で置いた本拠は攻められない** | ［コード］`siege.rs:708-713`、`conquest.rs:757-758` | `g13_cq_declare_siege_refusals_steps_8_to_10` |
| 攻撃と保護 | 攻撃しても盾は早く切れない。代わりに、盾のある拠点からは攻城も他国への進軍もできない（`Shielded`） | ［コード］`conquest.rs:731-739`、`reveal.rs:918-928` | 同上 |
| 休眠 | 5日間何もしないと休眠。生産が半分になり、盾が効かなくなる | ［コード］`v2/presets.rs:505,510`、`holding.rs:416-418`、`siege.rs:700` | `standard_season_dormancy_matches_the_economic_kernel` |
| 本拠の手放し | 14日間休眠すると（＝標準シーズン中には起きない） | ［コード］`v2/presets.rs:506` | `citizen_release_dormant_frees_the_site_and_strands_the_gen` |

文書との食い違い：`docs/DESIGN-OVERVIEW.md:134` と `siege.rs:17` の説明文は「盾48時間」としているが、標準14日の値は24時間。

## 1-4. 攻城・占領・失うもの

| 項目 | 現在の動き | 根拠 | テスト |
|---|---|---|---|
| 最初の拠点の陥落 | **占領であって、持ち主は変わらない**。72ターンの在任期間か、解放で終わる。占領後の「年貢」は未実装 | ［コード］`frontier-abi/src/conquest_model.rs:702-721`、`siege.rs:944-990` | `p_cq_p10_respite_bars_only_the_occupier_and_only_when_earned` |
| 奪取 | 前哨（枠2〜3）と自由都市だけが持ち主を変える | ［コード］`conquest.rs:1340-1342` | `g13_cq_settle_capture_takes_the_outpost` |
| 奪われたとき | 壁が半分になり、守備兵は失われ、倉の中身は0になる（144ターン以上持っていた場合は残る）。盾も0。預けた保証金と賃料は持ち主の支払元に戻る | ［コード］`conquest.rs:1385-1451` | `g13_cq_settle_capture_credited_keeps_the_stores` |
| 奪取後の免疫 | 36ターン、どの国もその場所を取れない | ［コード］`conquest.rs:1491-1499` | — |
| 前哨の建て直し | 枠が空けば再び FileOutpost できる。入植費用（2つ目は1倍、3つ目は1.5倍）は戻らない。待ち時間はない | ［コード］`citizen.rs:603-645` | `g13_cq_file_outpost_capture_lock_on_the_anchor` |
| 本拠を失う道 | 休眠からの手放し（ReleaseDormant）だけ。その後は難民として FileTicket で戻れるが、PlaceHome はもう使えない | ［コード］`citizen.rs:2173-2341` | `citizen_release_dormant_frees_the_site_and_strands_the_gen` |
| 退出 | **退出・放棄・辞退の命令はない**。アカウントはシーズン終了から72時間後にだけ閉じられる | ［コード］`citizen.rs:2405-2509` | `citizen_season_end_closes_holding_and_citizen` |

まとめ：シーズン中に「全部を失って村がなくなる」ことは、現在のコードでは起きません。失うのは前哨・倉・守備兵・荷・砦の取り合いの結果です。

## 1-5. 地図の拡大

| 項目 | 現在の動き | 根拠 | テスト |
|---|---|---|---|
| 開き方 | 誰でも OpenRing を送れる。1ターンに最大1環 | ［コード］`permutation-frontier/src/proc/map.rs:252-260,279-431` | `map_ring_beyond_genesis_waits_for_occupancy_and_its_seed` |
| 条件 | どれかの楔（国）で、埋まった州 ÷ 開いた州 ≥ θ。θ は最初の3日間が55%、その後は65% | ［コード］同上、`presets.rs:384-386` | `ring_theta_changes_theta_only` |
| 大きさ | 最初は4環（61州）、最大16環（817州） | ［コード］`v2/presets.rs:502` | — |
| シーズンをまたぐ広がり | ない。シーズンごとに新しい世界になる | ［コード］Season のアカウントは使い回さない（`season.rs:127-131`） | `g13_close_season_in_parts` |

## 1-6. シーズンの終わりと結果の保存

| 項目 | 現在の動き | 根拠 | テスト |
|---|---|---|---|
| 終了 | `bell ≥ end_bell` で誰でも EndSeason を送れる。`end_bell` 以降のターンは解決されない | ［コード］`season.rs:621-658` | `g13_end_season` |
| 終了後の行動 | プレイヤーの行動はすべて `bell < end_bell` が条件 | ［コード］`citizen.rs:130-155` | — |
| 片付け | 終了から72時間後に CloseSeason。最後に128バイトの記録（tombstone）だけが残る。同じ ID の Season は二度と作れない | ［コード］`season.rs:937-1121` | `g13_close_season_in_parts` |
| 勝敗 | 賞金プログラム（テスト用トークン）が、要塞の数が最も多い国を勝者にする。同数なら領土を持った時間、それも同じなら山分け | ［コード］`permutation-prize/src/lib.rs:256-307` | `largest_area_wins_then_bells_then_all` |
| 記録の保存 | Herald が `/h/season/final.json`（最終の地図・順位・移動）を一度だけ書き、以後は変えない | ［コード］`frontier-node/crates/herald/src/conquest.rs:2303-2446` | herald のテスト |
| ルールの指紋 | シーズンごとに `RULESET_HASH` を Season に書き、命令がそれを確かめる | ［コード］`season.rs:193-195` | `ruleset_hash_v3_is_the_kernels` |
| 次のシーズンへの持ち越し | **コードには何もない**。「年代記だけが持ち越される」は文書だけで、年代記のコードはない | ［文書］`docs/frontier/DECISIONS.md:397` | — |

## 1-7. 区切りの瞬間に宙に浮くもの

| 項目 | 現在の動き | 根拠 |
|---|---|---|
| 軍の移動 ✔ | Depart は、到着がシーズン内（`< end_bell`）でないと拒否される | ［コード］`permutation-frontier/src/proc/host.rs:652-659` |
| 隊商 ✔ | 終了後に新しく送ることはできない（プレイヤーの命令の確認）。一方、SendCaravan は、予定が `end_bell` をまたぐかを確かめない。SettleCaravan は、通ったターンがすべて解決済みでないと動かない。**終了の直前に出した隊商が終了をまたぐと、永久に決着できない** | **［実行で確認］** LiteSVM で再現（11章、`repro/`） |
| 倉・建物 | CloseVault と CloseStructure はプレイヤーの命令なので、終了後は使えない。CloseSeason は倉・建物・隊商のアカウントを閉じない。賃料は戻らない | 倉は**［実行で確認］**（11章）。建物と隊商は［読解］ |
| 行き先を奪われた隊商 | 行き先が奪取中なら `CapturePending`。行き先が失われると荷も失われる | ［コード］`caravan.rs:967-985` |
| 施設の使用権・預け入れ・受け取りの札（段階2） | **ゲームにはない**。試遊では運営がカードと台帳で手動で扱う | ［文書］`docs/frontier/playtest-kou/README.ja.md:25,62-64` |

## 1-8. AI

| 項目 | 現在の値 | 根拠 |
|---|---|---|
| チェーン上の行動の上限 | 人間と AI で同じ。Citizen ごとに**1時間30回、まとめて60回まで** | ［コード］`presets.rs:381-382`、テストは `svm-tests/tests/citizen.rs:330-341` |
| AI の動き方（オフチェーンの設定） | 1ゲーム日に8セッションまで、反応は1日6回など | ［設定］`permutation-gateway/citizens/config/smoke.json` |
| 常時稼働 | 手元の stack が動いている間だけ。公開の常時稼働サービスはない | ［文書］`docs/RUNNING.md` §4 |
| 賞金 | AI と bot は招待で入り、費用を払わず、賞金の対象ではない | ［文書］`AI-CITIZENS-CONTRACT.md:223` |

## 1-9. 設計文書との関係（採用状況の確認）

- 決定ログ（`docs/design/redesign/99-decisions.ja.md`）には、2026-10-23 に「**世界は続き、戦争だけを戦期で区切る（文書23のC案）**」と書かれています。ただし、コードはまだシーズン制（上の表）のままです。決定ログにある J5 は「段階1は新しいシーズンで試し、戦期は別の作業で後から作る」です。
- この作業（⑧）では、文書23の判断を前提として固定しません。比較案の一つ（B1。⑧の追加規則を足したものが B2）として、ほかの案と同じ条件でもう一度確かめます。採用・不採用を変えるものではありません。
- 依頼文にあった `AGENTS.md` と関連スキル（`.claude/skills/` など）は、基準 commit に存在しませんでした。代わりに `docs/DEVELOPMENT-HANDOFF.ja.md` と `docs/frontier/MAINTENANCE.md` に従いました。
