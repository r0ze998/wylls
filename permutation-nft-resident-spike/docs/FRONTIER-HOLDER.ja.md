# Frontier 側の現所有者・世代の検査：棚卸しと仕様案（2026-11-06、未実装）

**確定仕様**（所有者の指示、2026-11-06）：最初に NFT でログインし、1 NFT につき 1 アカウント。NFT の譲渡で操作権が新所有者へ移り、旧所有者は操作できない。

**2026-11-06 追記**：候補 20 を受け取り、比較と実装の続きは `CANDIDATE-20-REVIEW.ja.md` に記した。§3 の推奨は F1 から F2（毎回 Core と住民プログラムを読む、候補 20 の方式）に改めた。

**この文書の位置**：実装ではなく、Frontier program のどこを変えればこの仕様になるかの棚卸しと、比較のための仕様案。別作業で作成中の「認証」「NFT と Citizen の一対一登録」「命令接続」「検証器対応」の候補を受け取る前に program を書くと重複するため、ここで止めている（受け取りの状況は §6）。

## 1. 今の Frontier program で、誰が操作できるかを決めている場所

| 場所 | 規則 | 範囲 |
|---|---|---|
| `frontier-abi/src/prologue.rs:1085` `player_prologue`（`permutation-frontier/src/proc/citizen.rs:136` `player()` から呼ぶ） | actor が署名者で、`Citizen.WALLET` と同じか、`Citizen.SESSION`（0 でない）と同じで `SESSION_EXPIRY` 前。`session_ok = false` なら財布だけ | `player()` の呼び出し 26 か所（caravan 6、citizen 5、holding 5、host 4、structure 4、nation 2） |
| `proc/citizen.rs:468` SetSession | 財布だけ（`session_ok = false`）。session と期限を上書きする | — |
| `proc/caravan.rs:727`、`:1855` | 他人あての送り（と 1855 の命令）は session では不可（`WalletRequired`） | prologue の後の追加検査 |
| `proc/structure.rs:557` CloseStructure | session では不可（`WalletRequired`） | 同上 |
| `proc/conquest.rs:1599` RetireHost | prologue を使わず、財布か session かを自前で判定（`:1646-1653`） | 例外。prologue だけを変えると漏れる |
| `proc/citizen.rs:2452` CloseCitizen | 誰でも（終了 72 時間後など） | 継続世界では ④ の P-C3 で変わる予定 |
| Citizen の住所と tag | `sha256("PSF-CIT" ‖ wallet)`。隊商・倉の持ち主の tag、隊商の口座の seed | 住所は最初の財布から決まり、変わらない |
| `permutation-prize/src/lib.rs:569`、`:824` | 賞金の Entry と受取は財布で決まる | 別 program |

v2 の Citizen（`frontier-abi/src/v2/layout/player.rs`）には `RSV_348`（36 byte）の空きがある。v1 の Citizen の空きは未確認。

## 2. 仕様を満たすために program に要るもの

1. Citizen ごとに「今の操作者」（NFT の現所有者）と「保有者の世代」を持つ。住所と tag は今のまま（④ の N1。隊商・倉・seq の住所を変えない）。
2. prologue は、住民に紐付いた Citizen では `WALLET` ではなく「今の操作者」を本人として扱う。session は「今の操作者が今の世代で設定したもの」だけを認める。
3. 譲渡と同時に、操作者を新所有者へ替え、世代を 1 増やし、session を消す。**同じ取引の中で**行わないと、譲渡から反映までの間に旧所有者が操作できる。
4. §1 の例外（`WalletRequired` の 2 か所、RetireHost、SetSession）も「今の操作者」で判定する。
5. 検証器（verifier）が、操作者の替わりと世代を再判定できる記録（ログ）を出す。

## 3. 3 の「同じ取引の中で」を満たす方式（比較）

| 方式 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **F1：住民プログラムからの CPI** | 住民プログラムの `TransferResident`（Core の譲渡・世代＋1・session 消去を既に 1 命令で行う。実 Core で検証済み）が、同じ命令の中で Frontier の新命令（例 `ResidentHolderChanged`）を CPI で呼ぶ。Frontier は住民プログラムの PDA の署名だけを受け付け、`OPERATOR`・`HOLDER_GEN` を更新し `SESSION` を消す | 各命令の口座の並びを変えない。譲渡と反映が分かれない | Frontier が住民プログラムを信頼する（その program id を Frontier に固定する）。Core の永続凍結のガードが前提（一般マーケットでの譲渡はできない） |
| **F2：毎回 Core の口座を読む** | 住民に紐付いた Citizen の命令では、Core の asset 口座も渡し、その owner を prologue で読む | 信頼する program が増えない。どの譲渡方法でも効く | 26 か所以上の命令の口座の並びが変わる（ABI・SDK・relay の shape・keeper・検証器すべて）。世代は別に持つ必要がある |
| F3：新所有者が後から申告する | 新所有者が `ClaimResident` を出して操作者を替える | 変更が小さい | 申告までの間、旧所有者が操作できる。**仕様を満たさない** |

推奨は F1。ただし、受け取る予定の「一対一登録」「命令接続」の候補と重なる部分なので、候補を見てから決める。

## 4. 仕様の各項目と、program で確かめる試験（案）

| 仕様 | program 上の判定 | 確かめる試験（案） |
|---|---|---|
| 最初に NFT でログイン | Join（または新命令）で、NFT の現所有者が署名し、住民プログラムの一対一の記録が無いことを確かめて Citizen を作り、`OPERATOR` を設定する | 所有者でない署名は拒否。既に結ばれた NFT での 2 回目は拒否 |
| 1 NFT につき 1 アカウント | NFT → Citizen の記録（住民プログラムの PDA）が一意。Citizen → NFT も一意 | 同じ NFT で 2 つ目の Citizen は拒否。1 つの Citizen に 2 つ目の NFT は拒否 |
| 譲渡で操作権が新所有者へ | `TransferResident` の中で `OPERATOR` = 新所有者 | 譲渡直後、新所有者の署名で操作が通る |
| 旧所有者は操作できない | prologue で `actor == OPERATOR` | 譲渡後、旧所有者の署名は拒否（relay を通さず直接送っても） |
| 譲渡前の署名の拒否 | 譲渡前に作った旧所有者・旧 session の取引が、譲渡の後に着地 → actor が操作者でも今世代の session でもない | 譲渡前に作った取引を譲渡後に着地させ、拒否されること |
| A→B→A 後の古い session の拒否 | 譲渡ごとに `SESSION` を消し、世代を増やす | A→B→A の後、A が売る前に設定した session は拒否。A が今の世代で設定し直せば通る |

**試験の方法の制約**：今回の指示で、固定 seed を含む鍵の生成・導出・署名を行う試験は禁止された。LiteSVM には署名検査を切る設定があり、秘密鍵を持たない公開鍵だけで命令を組める。これで上の試験を書けるかは確認待ち（§6 の問い 2）。

## 5. 決めずに残すこと（所有者の判断）

- 既存の Citizen（財布で作られたもの）の移行
- 市場方式（専用の売買経路だけか、一般マーケットにも対応するか。F1 は一般マーケットの譲渡を前提にしない）
- 私的記憶の移転、未決済のもの（移動中の隊商、預かり、未受取の賞金の Entry、agent の預け入れ）の扱い

## 6. 受け取りの状況（2026-11-06）

GitHub（`origin` の全ブランチ）を検索した。別作業の「認証」「NFT と Citizen の一対一登録」「命令接続」「検証器対応」に当たるブランチ・コミットは見つからなかった。19 の担当セッションの題名にも当たるものが無い。④ の `CONTINUITY-DECISIONS.ja.md` §7.4（`bc09689a`）は「④は⑳の資料を受け取っていない」とし、N1（住所は最初の財布、NFT の所有者を今の操作者として記録）を推奨の方向としている。受け取りに要るもの：各候補のブランチ名と完全な SHA、または bundle と、その前提のコミット。

## 7. 既存の試験と、今回の禁止（固定 seed を含む鍵の生成・導出・署名）

このブランチの既存の試験は、ほぼすべてが固定 seed から鍵を作り、署名している。今回はどれも実行していない。消してもいない（成果の保全のため）。

| 試験 | 鍵の作り方 |
|---|---|
| `test/fixtures.mjs` と、それを使う `test/*.test.mjs` 9 本（auth、buyback、core-asset、entry、http、registry、restart、sale、transfer-loop） | `keypair(sha256('wallet A'))` など、ラベルの sha256 を seed にする |
| `test/browser.mint.test.mjs`、`test/browser.localnet.test.mjs` | テストウォレットに固定の seed（`'a'.repeat(64)` など）を入れる |
| `test-gateway/worlds.mjs`（`gateway-residents.test.mjs`） | ラベルの sha256 を seed にする |
| `svm-core/tests/core.rs`（LiteSVM 9 件） | `Keypair::new_from_array(sha256(label))` |
| `test/real-bytes.test.mjs` | 鍵を作らない（実 Core が作った口座のバイトを読むだけ） |

扱い（残す・隔離する・書き直す）は確認待ち（§6 の問い 2）。
