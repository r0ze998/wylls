# ⑫ ④・⑧の正本から受け取る契約と、⑬ f40ac0d1 との照合（2026-11-05）

起点は⑫の `4bc76d05`。照合した相手は、⑬の最新版 `f40ac0d19abe2c9ae15a2b18216152c5a072bd06`（`origin/claude/eager-cerf-k74z5s`）と、統合候補 `origin/integration/ws09-13-v16-d0949fd4`（`ef63544c727490fc6801d30affd11c5b7106c480`。④・⑧・herald は `d0949fd4` から変わっていない）。データはすべて合成で、鍵の生成・導出・署名はこの回の実装と試験では行っていない（既存の試験の一部は、v3 から使っている試験専用の決まった鍵で allocation に署名する。新しい試験はそれを使わない）。

## 1. 正本から受け取るもの（`adapters/canonical.mjs`）

| 受け取るもの | 正本 | 受け取り方 | 無いとき・合わないとき |
|---|---|---|---|
| 世界・partition | ⑧ herald `GET /h/season`（`programId`・`cluster`・`season`・`seasonAddress`・`continuous`） | `worldFromSeason` → `{cluster, world_id: <program>/<seasonAddress>}` | 欄が欠けたら例外（世界を推測しない）。`continuous` でなければ world なし |
| bell の長さ・起点 | 同 `genesisTs`・`bellSecs` | `clock: {genesisTs, bellSecs, source}`。`clockFromGenesis` も `bellSecs` 必須にした（以前は 600 を固定で持っていた） | `bellSecs` が無ければ例外 |
| slot → bell | ⑧ herald `GET /h/events` の行 `{slot, bell}` | `clockFromHeraldEvents`：行のある slot だけ | 行が無い・PRE_GENESIS（0xffffffff）・行どうしが食い違う slot は不明（Receipt は `clock_unmapped` で保留）。補間しない |
| 観測した時点 | 同 `latestUnix` | `currentBellFromSeason` | 無ければ全件を `observed_bell_unknown` で保留 |
| finalized の slot | **公開されていない**。④・⑧が `{commitment: 'finalized', slot, world_id, source}` を渡す | `finalizedSlotFrom` | 無い・`finalized` でない・別の世界・出典なし → 全件を `no_finality_attestation` 等で保留。herald の `latestSlot` は確定性の表明ではないので使わない |
| 財布 ↔ 住民 ID（citizen tag） | ⑧ herald `GET /h/me/{wallet}` が返す citizen 口座のバイト列 | `identityFromHeraldMe`：WALLET @ 64 と CITIZEN_TAG @ 208 を**読む**（Citizen v2 配置）。照会した wallet と一致し、tag が返された口座アドレスの先頭 8 バイトと一致するときだけ採用 | 口座なし・短い・別の wallet・アドレスと不一致 → その wallet は対応なし（理由つきで返す）。同じ tag に 2 つの wallet → どちらにも解決しない |
| Receipt・run の spec | ④ runexec の SQLite（`receipts`・`runs.spec`・`meta('world')`） | `readWs04Store`：読み取り専用で開き、本文は u64 を正確に読む | 世界の束縛が無いストアは world なし |
| ④のストアがどの herald 世界か | **公開されていない**（④の world 文字列の書式が決まっていない） | 運用者の宣言 `{ws04World, programId, seasonAddress, source}` と照合（`storeWorldMismatch`） | 宣言なし・出典なし・別の世界 → 全件保留 |

`connectCanonical(memory, {season, events, me, store, binding, finality})` が全体を 1 回まわす。保留した Receipt は理由つきで返し、⑫は写しを持たない。保留の置き場は④のストアそのもので、同じ呼び出しを後でもう一度行えば（再起動のあとでも、確定・時計・本人の対応が追いついたあとでも）、新しく分かった分だけが入る。

## 2. ⑬ f40ac0d1 との照合

⑬は `#publicEvidence` で `ports.evidence.read({counterparty, worldBell})` を呼び、`{status, lines[{about, epistemic, text, sources}]}` を受け取る。`status` が `ok` 以外なら何も表示しない。⑬が渡す `worldBell` は住民自身の bell で、「⑫の世界の bell への読み替えと wallet → principal の対応は port の仕事（④・⑧が両方を出す）」と書かれている。

`ws12EvidencePort(memory, {identity, worldBellOf})` は、この契約をそのまま満たす⑫側の読み取り専用の port である。

- 相手は herald が citizen と対にした wallet のときだけ答える。それ以外は `identity_unverified`。
- ⑬の bell を世界の bell に読み替える関数が渡されなければ `clock_unverified`。⑬の bell が世界の bell と同じ時計だと、まだ誰も公表していないからである。
- 公開の記録だけを読み、⑫にも⑬にも何も書かない。各行に本人対応の出典（`identitySource`）を付ける。

**食い違い**：統合担当の sidecar（`ws12-public-evidence.mjs`）は principal を `/^[A-Za-z0-9_-]{1,32}$/` で検査する。実際の wallet アドレスは 43〜44 文字なので、実データの wallet はすべて `identity_unverified` になる。⑫の principal は⑬に合わせて wallet（64 文字まで）にしてあるため、⑫の port はこの制限を持たない。sidecar の検査を 44 文字まで広げるか、⑫の port に置き換えるかは、統合担当と⑬が判断する。⑫は sidecar を書き換えていない。

## 3. 試験

`test/adapters-canonical.test.mjs`（11 件）。herald の応答は herald の形（views.rs・server.rs）で組み、wallet・口座アドレスはただの 32 バイトの base58 で、鍵ではない。④のストアは store.rs の表定義で作り、④の実際の Receipt（`fixtures/ws04-receipts`）を入れる。

| 観点 | 確認したこと |
|---|---|
| ⑧ 世界 | 7 つの欄それぞれの欠落で世界を作らない。`bellSecs` を変えると bell が変わる（固定値でない） |
| ⑧ 時計 | 行のある slot だけ bell になる。PRE_GENESIS・食い違い・型違いは不明 |
| 確定 | `finalized` 以外・出典なし・別の世界・herald の `latestSlot` は確定とみなさない |
| 本人の対応 | 口座から読んだ wallet・tag とアドレス先頭の照合。別の wallet・短い口座・不正アドレス・同じ tag に 2 つの wallet を拒否。base58 の往復（先頭 0 バイトを含む） |
| ④ ストア | 読み取り専用（書き込みは失敗）、u64 が正確、世界の束縛の有無 |
| 欠落 | 宣言なし・確定なし・束縛なし・観測時点なしのそれぞれで、全件が理由つきで保留され、何も書かれない |
| 接続 | すべてそろうと送出・決済・入金・襲撃・本人対応が事実になる。本人対応が拒否されると対応の事実は作らない。時計の欠けた slot と未確定の slot は、それぞれの理由で保留 |
| 再起動 | 確定が途中の状態で取り込み、開き直して同じ呼び出しをしても 0 件。確定が進むと残りが入り、一度に取り込んだ場合と同じ |
| ⑬ の port | ⑬の契約の形（欄の名前）で答える。私的な発言は出ない。対になっていない wallet・wallet でない文字列・時計の読み替えなし・世界なしは、それぞれの status。読んでも何も書かない |
| ④ 実ストア | `WS04_DB` を指定すると、runexec の実際の SQLite を読み、vectors と同じ Receipt になり、接続全体が衝突・拒否なしで通る。4 つの demo（d0949fd4 で build）すべてで確認した。`tools/check-integration.sh REF --regen-ws04` がこれを自動で行う |

変異試験：`tools/mutate.sh` の 80 か所すべてで試験が失敗する（この回の 13 か所を含む）。

⑬ f40ac0d1 の上に、この⑫を重ねた結果（`tools/check-integration.sh origin/claude/eager-cerf-k74z5s`）：⑫の試験 111 件中 108 件成功・3 件 skip・失敗 0。⑬の `ws12-public-evidence.test.mjs` 6 件成功。⑬の `ws12-adapter.test.mjs` と、住民を走らせる⑫の比較試験 2 件は、⑬の `small()` が `permutation-gateway` の npm 依存（`@solana/web3.js`）を読み込むため動かない。その依存の導入は未承認のソフト導入にあたり、また⑬の模擬世界は起動時に鍵の生成と署名を行う（この回の禁止事項）ので、**実行していない**。skip は理由を表示する。

## 4. ④への CI の差分

`handoff/ci-ws12-tests.patch`（sha256 `1df8efb8c1c612f73541c7440aa57254ab562ca2614eac27bc14f49e87576d50`）。`.github/workflows/ci.yml` に job `memory12` を足し、Node 22 で⑫の試験と⑬の sidecar 試験を走らせる。npm の導入も、ネットワークも、鍵も使わない。統合候補 `ef63544c` と `main`（`921429322d5aecd1a3df0dd8d82c405c87dd985a`）の両方で `git apply --check` が通り、適用後の YAML が読めることを確認した。共有の CI ファイルには適用していない。

## 5. 残件

1. **確定性（④・⑧）**：finalized の slot を誰がどの形で出すか。今は呼び出し側が渡す表明を受け取るだけ。
2. **④のストアと herald の世界の対応（④）**：④の world 文字列の書式を決めれば、宣言は照合に置き換えられる。
3. **slot → bell（⑧）**：herald の event 行がない slot（④の Receipt の slot に記録が無いとき）は不明のまま。⑧が slot の block time か bell を出せば埋まる。
4. **⑬の bell（⑬・⑧）**：住民の bell が世界の bell と同じかどうかの表明。それまで⑫の port は `clock_unverified`。
5. **sidecar の principal の長さ（統合担当・⑬）**：上の 2 節。
6. **⑬の全試験**：npm 依存の導入と、⑬の模擬世界の鍵生成の扱いについて承認が要る。
7. **coverage と所有者の区間**：この回も作る主体が無い。そのため「未発送」は、実データでは証明できないまま（`no_record_found` などの未確認にとどまる）。
8. **未決のまま変えていないもの**：遅れた返済・襲われた返送の評価、私的記憶の公開範囲、譲渡時の記憶の扱い。
