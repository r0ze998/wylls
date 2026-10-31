# 秘密の進軍・drand 接続・結果の検証（⑱、2026-10-31）

基点 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（統合候補 `integrate/claude-consolidation-20261029`）。作業ブランチ `claude/brave-bohr-xe4n4p`（ローカル commit のみ、push していない）。2026-10-31 の方針訂正（シーズン制を廃止し世界は継続、戦期は世界の寿命と別）を受けて、⑱ の範囲「封印進軍と drand round が戦期をまたいでも秘密性と決着を保つ」を含める。World／Period の正本や移行処理はここでは作らない（④・⑧の担当）。

この文書は事実・試験結果・提案を分けて書く。試験が通ったことは、ここに書いた入力についての結果であり、tlock・BLS・drand の暗号学的安全性全体を証明したものではない。

## 1. 公開 drand へ実際に接続する箇所（確定）

| 構成要素 | drand との関係 | 根拠 |
|---|---|---|
| keeper（`frontier-keeper`） | **接続する**。起動時に chain info、毎 tick に `T(b)`・`S(b, r)` 等の round を `HttpDrand` で取得し、署名を検証して anchor・seed cache・BeaconLog に載せる | `crates/keeper/src/main.rs`、`beacon.rs`、`rounds.rs` |
| drand-replay `prefetch` | 承認済みの一回限りのアーカイブ取得（O-M1-12 item 3）で接続した。以後は取得しない | `crates/drand-replay/src/prefetch.rs`、DECISIONS part A |
| drand-replay（サーバ） | 接続しない。保存済み round か試験鍵を、ゲーム時刻で絞ってローカルに配る | `crates/drand-replay/src/lib.rs` |
| ブラウザ（封印） | **接続しない**。公開鍵は herald の `/h/season` から受け取り、`checkBeacon` で quicknet（localnet のみ試験鍵）に固定。round は鐘の時計から計算 | `web/frontier/seal.mjs`、`seal-worker.mjs` |
| ブラウザ（開封・自己公開） | 開封しない。平文と salt を relay `/f/reveal` → keeper `/v1/reveal` へ送るだけ | `marchbook.mjs`、`controller.mjs`、gateway `routes/keeper.mjs` |
| relay（gateway） | 接続しない。reveal material を keeper へ中継 | `permutation-gateway/src/frontier/keeperlink.mjs` |
| herald | 接続しない。drand info は `--test-key` か `--drand-info FILE` | `crates/herald/src/main.rs` |
| プログラム | 接続しない。keeper が載せた署名を hash-to-curve の hint 付きで検証し、`T(arrive)` の署名で封印を開く | `permutation-frontier/src/crypto/{quick,seal}.rs` |
| 検証器 | 接続しない。アーカイブ内の取引が運んだ署名を、固定した鍵で blstrs 検証し、stock tlock で開く | `crates/verify/src/checks/v3_random.rs`、`v5_seals.rs` |
| bots | 接続しない。herald の鍵で封印し、relay へ reveal | `crates/bots/src/seal.rs` |

継続世界では保存済みアーカイブ（有限の round 範囲）だけでは足りず、keeper が公開 drand を HTTPS で読むことが前提になる。これが今回の HTTPS 対応の位置づけである。

## 2. 脅威と保証範囲

| 脅威 | 対策（今回の状態） | 保証の根拠 | 保証しないこと |
|---|---|---|---|
| 偽の drand 相手（DNS・proxy・ミラーの差し替え） | 署名を固定鍵で BLS 検証。chain info は pin と全項目一致（鍵・chain hash・period・genesis・scheme・genesis seed）でなければ起動しない | `beacon::pin_info`、`discover_pinned`、`check_served` | TLS は経路の秘匿と可用性のためで、正しさの根拠ではない |
| 違うネットワーク（default/mainnet chain、試験鍵） | `/{chain}/info` を pin の chain hash で引く。試験鍵は全 URL が loopback のときだけ候補 | `pins_for` | — |
| 違う round・再送 | 返った round が要求と一致しなければ拒否。同じ round の正しい応答の再送は同じ値（unchained 署名は一意） | `check_served` | — |
| 偽署名・壊れた署名・randomness 不一致 | 拒否し、次の endpoint へ | `check_served`、`tests/hostile.rs` | — |
| 遅延・欠落（425/404） | 他の endpoint を試し、どこにも無いときだけ「未公開」 | `HttpDrand::round` | 公開そのものの遅れは待つしかない |
| 接続失敗・TLS 検証失敗 | Io エラー、次の endpoint へ。証明書検証は無効化しない（`-k` なし、`.curlrc` 無視） | `http::curl_args`、`curl_get` | 信頼ストアは実行環境のもの（この試験環境では egress proxy の CA） |
| 時刻ずれ | keeper は chain の Clock で `round_time ≤ now` のときだけ取りに行く。早すぎても 425 で待つだけ。署名の存在が公開の証拠で、ローカル時刻は判定に使わない | `keeper/src/beacon.rs` | chain の Clock が実時間より大きく遅れると決着が遅れる |
| 再起動 | `HttpDrand` は状態を持たない。`Rounds` は取得のたびに再検証。keeper journal の再開は既存試験 | `rounds.rs`、keeper 既存試験 | — |
| 公開前の平文漏えい（オンチェーン） | **修正**：keeper は THE anchor（`T(arrive)` の署名が要る）が出るまで Reveal を作らない | §4、`play.rs` 試験 | 他人が自分の封印を早く公開すること（本人の情報）は防がない |
| 公開前の平文漏えい（オフチェーン、relay・keeper 運用者） | **未修正（提案のみ）**：ブラウザは到着鐘の開始＋0〜20 秒で平文と salt を送る（`T(arrive)` の約 600 秒前） | §6、提案パッチ | 運用者を信用する設計（I-24）のままでは、運用者は最大約 10 分早く知りうる |
| AI 入力への漏えい | bots の AI は自分の進軍の行き先を「到着鐘の終了後かつ公開後」まで入力に入れない（既存） | `bots/src/ai/meview.rs` | gateway citizens は marchbook を入力にしない旨の記述を確認（`citizens/audit/episodes.mjs`）。全経路の網羅確認はしていない |
| ログ | 変更箇所は平文・salt・k・σ をログに出さない。tlock の FO 失敗時の panic 表示は封印の公開点 U と誤った σ 由来の点だけ | `tlock-0.0.10/src/ibe.rs:313` | 運用ログの全量監査はしていない |

## 3. 実装した変更（コード差分は commit とパッチ参照）

1. **`fclient::http` の HTTPS（GET のみ）**：既存の prefetch と同じ「システムの curl を使う」構成に揃えた（W2-C D7）。新しい crate は追加していない。`-q` を先頭（`.curlrc` 無効）、`--proto =https`、リダイレクトを追わない、TLS 1.2 以上、時間と 64 KiB の上限、URL は厳格な検査の後 `--url` で渡す、curl の `ssl_verify_result` が 0 かつ scheme が HTTPS でなければ拒否。`https://` の POST（公開 RPC）は引き続き `Unsupported`。
2. **`is_loopback` の一本化**：prefetch の同名関数を `fclient::http` に移し、prefetch は再利用（重複実装をなくした）。prefetch の curl 経路も同じ堅牢化 GET を使う。
3. **`beacon::parse_info_json`**：api.drand.sh の `/{chain}/info`（v1 形：`hash`、`groupHash`）を読めるようにした。従来は `chain_hash` 必須で、実際の公開 drand の info を読めなかった（keeper は起動できなかった）。
4. **`beacon::pin_info`・`pins_for`・`discover_pinned`・`check_served`**：OSS の drand クライアント（drand/drand-client の `isValidInfo`・`verifyBeacon`、thibmeu/drand-rs の `verify_beacon`）と比べ、chain hash・公開鍵の固定、round 一致、署名検証、`randomness = sha256(signature)` を同じ水準で行い、さらに時計（period・genesis）と scheme も比較する。
5. **`HttpDrand::round`**：最初の endpoint の 425/404 で探索を打ち切っていた点、不正な JSON で即エラーにしていた点を修正。
6. **keeper**：起動時の info 取得を `discover_pinned` に置換（従来は最初に応答した URL の `/info` を無検証で採用）。`keeper.toml` の `drand` は `https://` か loopback の `http://` のみ。
7. **keeper の Reveal 計画**：THE anchor が無い到着には Reveal を作らない（§4）。待っている間の所有者の material は journal の新しい表 `owner_material` に書き、再起動後に一度読み戻す（追加のみの schema 変更）。
8. **検証器 V0（独立パッチ、⑪の試作とは別）**：成功した取引の命令について、タグ無し・ABI v2 に無いタグは FAIL（`UnknownInstruction`）、ABI の長さ範囲外は FAIL（`Undecodable`）、ABI に名前はあるがこの検証器がモデル化していない命令は UNVERIFIABLE（`UnverifiedInstruction`）、CreateSeason の `program_version` が 1..=4 以外は UNVERIFIABLE（`UnknownProgramVersion`）。モデル化していない命令は現時点で **CloseMarch（0xA7）と FastForward（0xC0）**。

## 4. 見つけた不具合：公開前の平文がオンチェーンに出る

- 事実：ブラウザ（と bots）は到着鐘の開始から reveal material を送る。keeper は anchor の有無を見ずに Reveal を計画・送信していた（`reveal_transient` が `NoAnchor` を「再試行」扱い）。その Reveal は台帳に載り、**命令データ（平文 37 B と salt）が公開される**。これは `T(arrive)` の公開（鐘の終わり）より最大約 600 秒早い。
  - **訂正（2026-10-31、④の指摘を `permutation-frontier/src/proc/reveal.rs` で確認）**：当初「プログラムが `NoAnchor` で拒否し、失敗取引として載る」と書いたが不正確。プログラムの Reveal は、BellAnchor も archive も無いときは窓の確認を飛ばして先へ進む（step 4、803〜835 行）。そのため早すぎる Reveal は**成功して着地しうる**。他の理由で拒否された場合も、`skipPreflight: true`（`fclient/src/rpc.rs:423`）なので命令データは載る。いずれにせよ、送らないことだけが対策になる。
  - program 側で「THE anchor か archive が無ければ Reveal を拒否する」に変えるかどうかは、共有コアの判断（④・利用者）。現行の設計は到着鐘の中での自己公開を受け付けている（`reveal_accept.rs` の「窓がまだ開いていない」で 202）。関係者の公式経路（ブラウザ → relay → keeper）は relay が Reveal の形を拒否して keeper 経由に限るので、keeper の条件で塞がる。自分の取引を直接 RPC に送るプレイヤーが、自分の進軍を早く公開することは防げない（本人の情報）。
- 再現：`no_reveal_before_the_anchor_of_its_arrival`（keeper `play.rs`）は修正前のコードで失敗した（`Reveal planned before THE anchor at 1800120030`、ログ `reveal-before-anchor.fail.log`）。既存試験 `reveals_skip_arrivals_at_or_after_end_bell` と `reveal_sources_deduped_by_host_arrive` も、anchor 無し・到着鐘の 30 秒時点で Reveal を計画・送信する前提で書かれていた。
- 修正：anchor が無ければ material を保持して待つ。上の 2 試験は「anchor あり・鐘の終了後」に書き換えた（試験の意図は保持）。
- 修正で入れた後退と、その修正：material を anchor まで**メモリだけ**で保持したため、所有者の送信から anchor までの間に keeper が落ちると、keeper 自身では開けない封印（所有者だけが公開する不正封印）の進軍が失われた。`crash_injection_every_journal_point`（通常は ignored、Gate W4 で実行）の `reveal/plaintext#1` が決着 digest の不一致で失敗した（基点では成功、ログ `base-crash-injection.log`）。修正前は material がすぐ Reveal の試行として journal に入っていたため起きなかった。`owner_material` 表で journal に残すようにし、同試験は成功（reveal 22 点、`keeper-play-include-ignored.log`）。単体試験 `held_owner_material_survives_a_restart` を追加。
- **追加の条件（2026-10-31、利用者の検証要求を受けて）**：RPC が返す anchor だけに頼らないよう、Reveal を作る前に、keeper 自身が `T(arrive)` の署名を drand から取得して固定鍵で検証できていることも必須にした（`Rounds::get`、通常は開封処理で既に取得済み）。あわせて、チェーンから読んだ BellAnchor は bell・region・season が一致しなければ anchor とみなさない（beacon duty と同じ確認。`play.rs` の読取りには無かった）。
- **送信されたバイト列で確かめる試験**（keeper `play.rs`、擬似 RPC が受け取った全取引の全命令から、Reveal の tag と平文 37 B・salt 32 B の出現を探す）：
  - `no_plaintext_reaches_the_rpc_without_an_anchor`：anchor が無い。到着鐘の 30 秒時点から窓の終わりまで、同じ slot での再試行も含めて送信しない。
  - `rpc_read_failures_send_nothing`：RPC の読取りが失敗する。tick は途中で失敗し、送信しない。
  - `drand_unreachable_sends_nothing_even_with_an_anchor`：anchor はあるが、drand に届かない（検証済みの `T(arrive)` が無い）。
  - `a_stale_or_foreign_anchor_read_sends_nothing`：正規の住所に、古い鐘・別 season・別 region・program 以外の持ち主の BellAnchor がある。
  - `an_anchor_read_before_the_round_sends_nothing`：RPC が `T(arrive)` の公開前に anchor を見せる（虚偽、または先行した読取り）。
  - `restarts_and_resends_send_nothing_before_and_reveal_after`：所有者の再送と再起動（duty も engine も作り直し、journal は同じ）を繰り返しても送信しない。
  - いずれも、条件がそろった後（anchor があり、`T(arrive)` が検証済み）には Reveal が送られ、その中に平文が入っていることを確かめる。
  - 変異試験（`mutations.log`）：anchor の条件を外すと 4 件、drand の条件を外すと 2 件、anchor の項目確認を外すと 1 件、journal 保存を外すと 2 件が失敗する。両方の条件を外す（基点相当）と 7 件が失敗する。`rpc_read_failures_send_nothing` は、読取り失敗で tick 全体が止まる既存の性質（`?`）を確かめるもので、新しい条件を外しても失敗しない。
  - `skipPreflight` は変えていない。送らないことが対策で、preflight はこの不具合の対策にならない（preflight をしても、拒否される取引の内容は RPC 運用者には届く）。
- material は以前から keeper の journal（Reveal 試行の取引バイト）に公開前から入っていたので、ディスク上の保存は増えていない。運用者を信用する点（I-24）は変わらない。
- 実チェーンでの確認は未実行（SBF ツールチェーンが無く `.so` を作れない）。

### 試験に使った鍵と、示していること

- **時刻前の秘匿性**の根拠にしているのは、公開 drand の quicknet（秘密鍵は誰も持たない）に対する live 試験（`fclient/tests/live_drand.rs`）と、web 経路の試験（`permutation-gateway/test/frontier-relay.test.mjs` の ⑱ の試験）で封印に quicknet の鍵を使ったものだけ。
- keeper の送信試験（`play.rs` の w6t_tests）は、秘密鍵が既知の試験ビーコン（I-53）を時刻で配る擬似 drand を使う。これで示しているのは「条件がそろうまで送らない」という**送信の判定**だけで、暗号の秘匿性ではない。
- 公開可能の条件、アプリ側の防止、program 側の拒否、証拠不足の区分と、未修正の点の詳細は、公開範囲の確認が済むまで repo に置かず、④・⑯ 向けのパッケージ内の文書（`CONDITIONS-for-4.ja.md`）に置く。

## 5. 試験（実行したもの）

| 試験 | 内容 | 結果 |
|---|---|---|
| `fclient` lib：`http::tests` 4 件、`beacon::tests` 4 件追加 | URL 検査、curl 引数に検証無効化が無いこと、trailer の検証、v1/v2 info、pin の全項目、served round の拒否条件、試験鍵の loopback 限定 | PASS |
| `keeper` lib：`drand_urls_are_https_or_loopback`、`no_reveal_before_the_anchor_of_its_arrival`、`held_owner_material_survives_a_restart` | 設定の拒否、Reveal の時期、待機中の material の再起動耐性 | PASS（2 件目は修正前 FAIL） |
| `keeper` lib：受付と送信の試験（`the_intake_gate_only_reads`、`intake_to_duty_sends_nothing_before_publication`、`archive_entries_count_only_when_present_for_the_bell` ほか w6t_tests の 17 件） | 受付は読むだけで、送信も simulate もしない。API で受けた material が、anchor 欠落・読取り失敗・古い応答・再送・再起動を通して、条件がそろうまで RPC に出ない | PASS（変異試験 `mutations2.log`） |
| gateway：`frontier-relay.test.mjs` の ⑱ の試験 | web 経路で、平文や salt を含む取引が RPC に届かない（Reveal は relay が simulate より前に拒否、material は keeper にだけ届く、Depart の wire には平文も salt も無い） | PASS（gateway 全体 2,529/2,530、1 件は既存の skip） |
| `keeper --test play`（ignored を含む 7 件） | 鐘の pipeline、保留下の Reveal、二重 keeper、crash injection（journal の各書込み点で落として再起動、決着 digest 一致） | PASS |
| `drand-replay --test hostile`（5 件、うち TLS 1 件は `--include-ignored`） | ゴミ、古い round、他鍵、ビット反転、randomness 不一致、500、閉じたポート、425/404 → 次へ、info の差し替え、ローカル TLS（未知 CA → curl 60、名前違い → curl 60、閉ポート → curl 7） | PASS（`not_yet…` は修正前 FAIL） |
| `fclient --test period_boundary`（3 件） | 戦期境界（鐘 1008）をまたぐ進軍は `T(arrive)` の署名だけで開く。境界で鐘番号を振り直すと code 5、genesis がずれると code 1 で破棄。u32 の鐘全域で `T` は単調・正確 | PASS |
| `fclient --test live_drand`（`FRONTIER_LIVE_DRAND=1`、公開 drand 4 endpoint） | 未来 round `R = latest + 20` に Rust とブラウザ実装で封印 → 公開前に `HttpDrand` は 425、最新署名・試験鍵の署名・壊れた署名では開かない → 公開後 HTTPS で取得・検証 → 両封印が両実装で開き judge code 0、hint が RFC 9380 と一致 | PASS（2026-10-31 に 3 回：round 33534078、33535230（署名を別途 curl で drand.cloudflare.com から取り直して一致）、最終コード tree で 33535562。ログ `live1.log`・`live-final.log`） |
| `verify --test coverage`（5 件） | 未知タグ、データ不足・過多、モデル化外命令、未知版 | PASS（V0 を外すと 4 件 FAIL＝従来は PASS 判定） |
| `fclient`・`keeper`・`drand-replay`・`verify` の全試験（ignored を含む。公開 drand と `record_*` を除く） | 回帰 | PASS（最終コード tree `fb8dd442`、`final-run.log`。整形前の workspace 全体の実行も PASS、`workspace-test.log`） |

## 6. 提案（未適用）：ブラウザの自己公開を `T(arrive)` 公開後へ

`marchbook.revealStep` に `notBefore`（`T(arrive)` の round 時刻 + 5 秒）を足し、controller から渡すパッチを `proposals/browser-reveal-after-T.patch` に置いた。marchbook の単体試験は通るが、`web-frontier-marches.test.mjs` の 4 件が失敗する。原因は、試験用のサンプル世界が「到着鐘の中で Reveal が着地し、その鐘の envelope に slot が出る」前提で作られており、実プログラム（Reveal は THE anchor が要り、anchor は鐘の終わりの `T(b)` が要る）と時系列が違うこと。サンプル世界を実プログラムの時系列に合わせるのは ⑦・④ の判断と作業なので、ここでは適用しない。

## 7. 継続世界：⑱ の範囲

### 残っていたシーズン依存（封印・drand・決着の経路）

| 箇所 | 依存 |
|---|---|
| `permutation-frontier/src/proc/host.rs:657` | Depart は `arrive_bell ≥ end_bell` を拒否 |
| `proc/beacon.rs:192, 240` | `bell ≥ end_bell` の anchor を拒否（終了後の鐘の `T(b)` は載らない） |
| `proc/clash.rs:444` | `bell ≥ end_bell` の解決を拒否 |
| `proc/reveal.rs:761` | Ended かつ `arrive ≥ end_bell` の Reveal を拒否 |
| `proc/season.rs:572, 643` | 窓の変更・終了処理が `end_bell` 基準 |
| `keeper/src/beacon.rs:188-193`、`play.rs`（`reveals`）、`reveal_accept.rs:141` | anchor・Reveal・受付を `end_bell` で止める |
| `verify/src/checks/v5_seals.rs:97` | `ArrivalAfterEnd` を FAIL |
| `bots`（`plan_march`）・web `clock.mjs`（`endBell`） | 到着を `end_bell − 1` 以下に丸める |
| drand-replay アーカイブ | G0 から 8.5 日分の有限範囲。範囲外は 404 で anchor が止まる |
| 時計 | `T(b)` は Season の `genesis_ts` と鐘番号（u32）から計算。封印平文は `host_id` と `arrive_bell` を含み、季節 ID は含まない |
| CloseMarch（0xA7） | 「Season が Ended して 72 時間後」が条件。継続世界では発火しない／意味が変わる |

### 変更した挙動

- 公開 drand を HTTPS で読めるようにした（有限アーカイブに頼らない継続運用の前提）。
- keeper は anchor（`T(arrive)` の署名）の前に Reveal を出さない。戦期境界の有無に関係なく、秘密性は「round の公開」だけに結び付く。
- 検証器は、モデル化していない命令（FastForward など継続世界で重要になる命令を含む）を PASS にしない。

### 試験で確認したこと

- 境界をまたぐ進軍は、鐘の時計が連続していれば境界の無い進軍と同じく `T(arrive)` の署名だけで開き、隣の round では開かない。
- 境界で時計を振り直すと（今の「新しい Season」の形）、封印済みの進軍は code 5 か code 1 で破棄される。**戦期の切替で `genesis_ts` や鐘番号を変えてはいけない**、が移行の制約。
- u32 の鐘（600 秒、約 81,700 年）全域で `T` は単調で正確。範囲の理由で振り直す必要は無い。
- 長期運用で状態が増え続ける点（anchor・archive の口座、keeper の保持期間）は今回は測っていない。keeper のメモリ保持は既存の上限（`Rounds` 4,096 件、anchor は 48 時間＋余裕）。一方、keeper の `PlayDuty.owner`（所有者 material）と journal の `plaintexts`・`owner_material` 表は**削除の経路が無く、継続世界では増え続ける**（今回の追加も既存の `plaintexts` と同じ扱いに揃えた）。決着後の削除規則は ④・⑧ と決める必要がある。

### 移行や仕様判断が残る点（④・⑧へ）

1. `end_bell` を「世界の終わり」から外す方法（戦期の集計境界は別の値にする）。巨大値にするだけでは不十分で、CloseMarch・終了後の口座閉鎖・`ArrivalAfterEnd` の意味を決め直す必要がある。
2. 戦期をまたいで鐘の時計（`genesis_ts`、鐘番号）を連続させること。Season ID で導かれる口座（anchor、arrival slot、transit）の扱い。
3. 検証器は CreateSeason から最終状態まで全履歴を読む設計。継続世界では「信用する前状態（checkpoint）」の定義が要る。
4. FastForward（休眠 Province の閉形式前進）の検証器モデル。
5. ブラウザの自己公開時期（§6）とサンプル世界の時系列。

## 8. ブラウザの戦闘照合と、シーズン全体の検証の違い

| | ブラウザ「このブラウザで確かめる」（`screens/report.mjs` `verifyClash`） | 検証器（`frontier-verify`） |
|---|---|---|
| 対象 | 1 つの Province の 1 つの鐘の戦闘 | シーズン全体の取引と最終状態 |
| 入力の出所 | herald が配る口座バイト（BellAnchor、SeedCache またはアーカイブ、解決前の Province、ClashInputs）と記録 | アーカイブ（findex）またはローカル RPC の取引列（失敗取引を含む）と、固定スロットの最終口座状態 |
| 確かめること | kernel の ruleset hash が Season と一致、seed が THE anchor の A と `S` に対応、入力がその鐘のもの、kernel の再計算結果の digest と各 fate が記録と一致 | V0〜V25：命令の網羅（V0）、実体の連鎖と最終 head、プログラム・ruleset・`.so` hash、drand 署名の BLS 検証、窓、封印（stock tlock で開封）、割当、再計算、住所、土地、支払い、S1 の隊商・施設・国 |
| 信用しているもの | herald のバイトが実際のチェーン状態であること（チェーンへの照合はしない）、seed の値そのもの（drand 署名からの再導出はしない）、wasm の sha256 と ruleset（固定値と照合） | 取引列の完全性（各実体の連鎖で欠落は検出するが、どの連鎖にも触れない取引の欠落は分からない）、最終状態を返した RPC、固定した drand 鍵（`--quicknet-pk`／`--test-key`、指定が無いと fixture の鍵で警告）、ruleset hash、`--program-hash`（指定時のみ）、前状態は「シーズン作成時点の空」 |
| 結果の意味 | 「配られたバイトの範囲で、kernel は記録どおりの結果を出す」 | 「この入力の範囲で、記録された全取引が規則どおり」。モデル化していない命令・版があれば PASS しない（V0） |

## 9. 未実行・未確認

- オンチェーンの SettleTransit／Reveal（実プログラム）での決着：**未実行**。この環境に Solana SBF ツールチェーン（`cargo-build-sbf`）が無く、`.so` を作れない。導入は未承認のソフト導入にあたるので行っていない。オフチェーンでは検証器と同じ `seal::judge`（stock tlock）とブラウザの開封で code 0 を確認しただけ。
- ignored の記録用試験 `record_land_program`（`PSF_FRONTIER_SO` の `.so` が要る）は失敗＝未実行扱い。`record_march_synth` は `fixtures/verify/march-synth.json` を書き換えた（封印の鍵が毎回変わるため event head が変わる）。記録済み fixture は変えないので元に戻し、差分だけ保存した（`record_march_synth-rewrote-fixture.diff`）。
- `cargo fmt --check`：1.95.0 には rustfmt が無いので、W1-F と同じ代替 `cargo +1.89.0 fmt --all -- --check` を実行（1.89.0 はパッケージ作成中に repo 直下で `rustc --version` を実行した際、rustup が直下の `rust-toolchain.toml` に従って**意図せず自動導入**したもの）。今回の変更ファイルだけに差分があったので整形し、整形後は PASS。
- `cargo clippy`：**未実行**。1.95.0 に clippy が無く、代替の 1.89.0 では依存の `solana-syscalls 4.2.2` がコンパイルできない（`maybe_uninit_write_slice` が不安定機能、`logs/clippy-1.89.log`）。
- ⑪ の未知命令検証パッチ：**受け取っていない**（remote の枝にも見当たらない）。V0 は独立に作ったので、受領後に照合が要る。
- 運用ログ・gateway citizens・MCP の全経路の平文漏えい監査：一部のみ（§2）。
- 長期運用での状態量の測定：未実行。
- 公開 drand の round 取得は、この試験のための数件（info 5 回、latest 数回、未来 round 1 件と 425 の確認）。

## 10. 文書とコードの食い違い（見つけたもの）

1. W1-F-NOTES D5 は fclient の HTTPS を「dependency request R2」と書き、同じ文書の §6 では R4。
2. `fclient/src/beacon.rs` の旧コメント「quicknet as published at `https://api.drand.sh/52db9b…/info`」：その URL の実際の形は v1（`hash`、`groupHash`）で、旧 `parse_info_json` は読めなかった（`chain_hash` を要求）。
3. `keeper/src/main.rs` の旧モジュール注釈「HTTPS endpoints wait for a TLS client」に対し、drand-replay の prefetch は curl で HTTPS を既に扱っていた。
4. `reveal_accept.rs` の注釈「owners submit from the arrival bell's start … the keeper holds the material until THE anchor lands」に対し、keeper の `play.rs` は anchor を待たずに Reveal を送っていた（§4、今回修正）。
5. 試験用サンプル世界（`web-frontier-marches.test.mjs`）は到着鐘の中で Reveal が着地する前提。実プログラムでは Reveal は鐘の終わりの `T(b)` の後（§6）。
6. 検証器 `conquest.rs` の `s1_applies` は `program_version >= 4` を S1 とみなすので、未知の新しい版も S1 の規則で PASS しえた（V0 で UNVERIFIABLE に）。
7. `verify/src/lib.rs` の表は V1〜V13 だけを挙げるが、実際には V14〜V25 と（今回）V0 がある。
8. `frontier-abi/src/v2/tags.rs` の冒頭は「M1's 51 tags」、6 行目は「v1's `crate::tags::Ix` keeps its 50 variants」と書くが、`frontier-abi/src/tags.rs` の試験は `assert_eq!(Ix::ALL.len(), 51)`（コードは 51）。
