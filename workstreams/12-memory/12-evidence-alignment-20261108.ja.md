# ⑫ ④の実行記録と⑬の判断に渡す証拠の整合（2026-11-08）

起点は⑫の `c6877a1a`。そこへ、④の公開統合候補 `cf517b558d1303a84dba618550f40cb460b7ad99`（`claude/gallant-ride-cunptv`）で統合担当が⑫に加えた修正 2 件をそのまま取り込んだ。

- `2d72f548`：Receipt の本文の owner・seq・slot を外側と照合する。
- `b3920a55`：書込み先の memory の世界と partition を照合する。

二重実装はしていない。⑬は `81a03cf5b32abe7d757a5cd224b2abce74308a6d`（`claude/eager-cerf-k74z5s`）と照合した。⑬が作業中の ws04-run ポートと⑲の history 欄への対応には手を入れていない。

## 1. この回の変更

| 変更 | 内容 | 理由 |
|---|---|---|
| 来歴（`provenanceOf`、`connectCanonical(...).provenance`） | ⑬の `PROVENANCE_PARTS`（world・clock・finality・identity・records）と同じ形で、各部分の `{kind, source}` を返す。kind は⑬の語（`chain`・`integration-output`・`fixture`）。**呼出し元が入力ごとに述べたものを運ぶだけで、⑫は格上げしない**。述べられていない部分は null（⑬では unstated）。clock は `/h/season` と `/h/events` のうち弱い方。records には完全性を書かない | ⑬ 81a03cf5 の `basisCheck` は、この形の provenance を受けて、chain のときだけ住民が証拠に基づいて動く。fixture を実チェーンの証拠として通さない |
| cross-check を確定とみなさない（`finalizedSlotFrom`） | 確定の表明に `cross_checked`・`proof: 'cross_checked'`・`state: 'cross_checked'`・`complete` のいずれかがあれば拒否し、全件を保留する | ⑲の取り決め §1・§2。照合が一致したことは確定の証明ではない |
| coverage の契約（`coverageFromHistory`） | 索引の 1 送り手・1 区間の報告から、⑫の coverage を作れるのは条件がすべて**明示された**ときだけ。条件は、basis `ledger_feed`、`complete === true`、`not_fetched`・`gap`・`unverifiable` でない、`heldBack === 0`、送出経路 3 つすべて、区間末尾以上が finalized、slot が bell に対応する、の 7 つ。**⑲が今出す history はすべて拒否される**（`complete` は true にならない） | 「未発送」を、欠落や cross_checked から作らない。作り手に必要な欄を、実行できる形で示す |
| ④のストアを一つの snapshot で読む（`readWs04Store`） | 世界・Receipt・run の spec を一つの読み取り transaction で読む | ④の `runexec view` は `Store::read_snapshot` で読む。読みの途中に実行器が commit すると、⑫は別の時点の Receipt と spec を組み合わせていた。試験で再現し、修正後に直ったことを確かめた |
| 試験の実行範囲（`tools/keyfree-tests.txt`、`tools/test-nokey.sh`） | 呼出し先まで監査した試験ファイルだけを走らせる。一覧に無いファイル（署名つきの allocation、`keysFor`、⑬のデモを読み込むもの）は**起動しない**。一覧のファイルが鍵の操作に届いたら失敗にする | 「監査した許可分だけ」。前回までは全ファイルを起動し、鍵の直前でガードが止めていた |
| CI の差分（`handoff/ci-ws12-tests.patch`） | ④の候補の `ci.yml` に job `memory12` を足す。中身は④の `scripts/ci/node-keyfree.sh` で⑫の一覧を走らせるだけ。④の `check-ci-keyfree.py` は「ok: push/PR jobs are key-free」と判定した | ④の鍵なし CI の仕組みに合わせ、別の仕組みを持ち込まない |

## 2. ④の実行記録・⑫・⑬の対応

| ④が出すもの | ⑫での扱い | ⑬が受け取るもの |
|---|---|---|
| Receipt（`caravan_sent`・`caravan_settled`・`caravan_raided`）。確定性は持たない | 確定の表明・世界の宣言・時計・本人の対応がそろったときだけ事実にする。それ以外は理由つきで保留 | 公開の約束の行と、約束の状態（⑬が `memory.knowledge` から読む） |
| act の登録簿（7 状態、`commitment`、`final`） | **取り込まない**。住民自身の送信の運命であって、相手の約束の証拠ではない。`commitment` は送信 1 件ごとの値で、Receipt の slot の確定ではない | ⑬が④から直接読む（⑬の領域） |
| `runexec view`（snapshot） | ⑫は同じ snapshot の規則で SQLite を直接読む | — |
| ストアの `meta('world')` | 運用者の宣言で herald の世界と照合する | provenance の records |

## 3. coverage と finality の作り手に必要な API（具体）

今は⑫に coverage を渡せる主体がいない。そのため、記録の無い約束は「未確認」のままで、「未発送」にはならない。作り手は次を出す必要がある（`coverageFromHistory` の入力そのもの）。

1. **送り手ごとの発送の索引**（④の findex か⑲）：`GET /h/departures?world=<world_id>&sender=<tag 16 進>&from_slot=&to_slot=` で、次の欄を返す。
   - `{basis: 'ledger_feed', state, complete: true|false|null, heldBack, range: {from_slot, to_slot}, routes: ['send_caravan/top_level', 'send_caravan/cpi', 'settle_raid/take'], finality: {commitment, slot}, sender, caravans: [{seq}], source}`
   - `complete: true` は、その区間のその送り手の発送が、3 経路すべてで、ノード自身の台帳から**欠けなく**読めたことを、作り手が責任をもって述べる値。今の⑲は、設計上これを true にしない（archive-only もノード照合後も Unknown）。誰がどの証拠でこれを出すかは、④・⑲の判断。
2. **finality**（④か⑧）：`GET /h/finality` で `{commitment: 'finalized', slot, world_id, source}` を返す。RPC の `getSlot(finalized)` を読んだもの。herald の `latestSlot` や cross_checked は代わりにならない。
3. **任意の slot の bell**（⑧）：今は herald の `/h/events` の行がある slot しか bell にならない。`GET /h/bell?slot=` か、Receipt の slot の block time が要る。
4. **ストアの世界の書式**（④）：`meta('world')` を `<program>/<world account>` に決めれば、運用者の宣言を照合に置き換えられる。

## 4. 試験（すべて鍵なし。呼出し先まで監査した 6 ファイル）

- **⑫だけの木**（`sh workstreams/12-memory/tools/test-nokey.sh`）：ran・skipped・FAILED の数は報告に記す。
- **組み合わせた木**：④ cf517b55 を土台に、⑬ 81a03cf5 と⑫を重ねた。
  - ⑫の一覧：57 件成功、1 件 skip（実ストア未指定）、失敗 0。
  - 同じ一覧を④の `scripts/ci/node-keyfree.sh` と④のガード（web3・noble も止める）で走らせた結果：58 件中 57 成功、失敗 0。
  - ⑬の `ws12-public-evidence.test.mjs`：6/6。
  - ⑬ 81a03cf5 の `basisCheck` に⑫の provenance を渡す試験：fixture は fixture、混在も fixture、すべて chain で確定の表明があるときだけ chain、records が無ければ unstated、確定の表明が無ければ chain にならない。
- **④ cf517b55 の実ストア**：runexec の demo 4 種（④の src に鍵・署名・乱数のコードが無く、demo は模擬の世界であることを確かめてから build した）を⑫で読んだ。4/4 で vectors と同じ Receipt になり、取り込み全体が衝突・拒否なしで通った。この出力は `integration-output` であって、チェーンの証拠ではない。
- **変異試験**：一覧の試験だけで、この回の規則 9 か所をすべて検出した。そのほかの数は報告に記す。

## 5. 未確認・依頼

- **④へ**：④の候補自身で `scripts/ci/node-key-tests.txt` が古い（`node scripts/ci/scan-node-key-tests.mjs --check` が失敗する）。足りない行は `permutation-gateway/test/web-frontier-resident-home.test.mjs` の 1 つで、⑫・⑬の変更とは関係ない。このままでは、⑫の CI の job も④の gateway の job も最初の検査で止まる。
- **⑬へ**：provenance は、⑫が `connectCanonical(...).provenance` として⑬の形で返す。統合する呼出し元は、それを `ws12CanonicalEvidence({provenance})` にそのまま渡せる。⑬の ws04-run ポートと⑲の history 欄の作業には触れていない。
- **⑬の試験の多く**は、デモが gateway を通して `@solana/web3.js` を読み込み、npm 依存が無いので動かない。呼出し先も監査していないので、走らせていない。
- **⑤ 9a4051c7**：③が取得を調整中。⑫は⑤と直接にはつないでいない。
- **未決のまま変えていないもの**：遅れた返済、私的記憶の公開・譲渡、NFT 譲渡時の記憶、金銭の条件。

## 6. 追補：記録ごとの出どころ（⑬の指摘への対応）

⑬から指摘があった。`provenance.records` は `connectCanonical` に渡したストアの出どころしか述べていない。そのため、同じ memory に別の経路で fixture の coverage が入っても、⑬が fixture の not_sent を chain の根拠として扱えてしまう。

- **事実の `basis`**（`src/records.mjs`）：事実に任意で `{kind: chain|integration-output|fixture, source}` を付けられるようにした。`basis` は本文（と body_sha）に含める。そのため、同じ記録を別の basis で読み直すと衝突になり、先のものが残る（chain の読みが fixture の読みを上書きすることはない）。basis の無い既存の記録は今までと同じで、unstated として扱う。
- **書き手**：`connectCanonical` は、Receipt の事実にはストアの、本人の対応には `/h/me` の、呼出し元が述べた basis を付ける。述べられていなければ付けない。`coverageFromHistory({basis})` も同じ。
- **約束の `evidence_basis`**（`src/fold.mjs`）：その状態の根拠になった事実すべてについて、`{id, kind, source}` と、最も弱い kind を出す。根拠には、coverage を債務者に結び付けた本人の対応も含める。basis の無い事実が一つでもあれば `unstated`、事実が一つも無ければ null。`ws12EvidencePort` の約束の行にも同じものを載せる。
- **試験**（`test/evidence-basis.test.mjs`、鍵なし、allocation なし）：
  - chain の本人の対応に fixture の coverage を組み合わせた not_sent は、fixture になる。
  - 根拠がすべて chain のときだけ chain になる。
  - basis の無い記録が混じると unstated になる。
  - 別の basis での読み直しは衝突になり、再起動しても先のものが残る。
  - port の行が evidence_basis を運ぶ。
  - 変異試験 4 か所はすべて検出した。
- **⑬側の作業（⑬の判断）**：違反の根拠が chain かどうかは、`commitments[].evidence_basis.kind === 'chain'` で判定できる。
