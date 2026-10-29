# 提案：共有 UI と CI への接続（適用していない差分）

**状態：** 提案。共通コア・共有 UI・CI の設定は変更していない。採用するなら、それぞれの持ち主の判断で、別の PR として入れる。

## 1. CI にテストを足す差分（案）

`.github/workflows/ci.yml` の、JS のテストを流しているジョブに次の手順を足す案。依存はない（Node の標準だけ）。Node 20.20（今の CI の版）と Node 22.22 で全テストが通ることを確認した。

```diff
       - name: Run civilization strategy simulation tests
         run: node --test permutation-state-prototype/civilization/*.test.mjs
+      - name: Creation manifests (workstream 06)
+        run: |
+          node workstreams/06-creation/cli/fixtures.mjs --check
+          node --test workstreams/06-creation/test/*.test.mjs
```

（`ci.yml` の該当ジョブの名前と位置は、適用時に持ち主が合わせる。ブラウザの通し確認 `proto/e2e.mjs` は Playwright が要るので CI には入れない案。）

## 2. 共有 UI（`permutation-server/web/frontier/`）への接続（案）

試作の画面（`workstreams/06-creation/proto/`）は独立したページで、ゲームの画面には入っていない。ゲームの画面に入れるなら、次の順を提案する。

1. **一覧と紙だけ**：herald が公開の一覧を配り、画面は紙（`describe`）と作者の説明を分けて出す。
2. **使う準備**：実行前の確認（`preflight`）の結果を、今ある S1 の注文の欄（荷車・倉）の前に出す。足りない札は、S2 の画面（束の一覧・預かり）へ案内する。
3. **写して編集**：段階4の「テンプレート」と同じ入口。

そのとき⑥のモジュールは、`src/` をそのまま web から読み込める（依存なし、Node とブラウザ両方で動く。WebCrypto の Ed25519 を使う）。

## 3. 本番に入れる前に要るもの（⑥の範囲外）

- 公開の一覧をどこに置くか（チェーン・herald・別のサービス）。この試作ではブラウザの localStorage とメモリだけ。
- 署名の鍵：試作は固定の種（demo seed）から作った模擬の鍵。本番ではウォレットかセッション鍵を使い、どちらで署名するかは S1/S2 の署名の規則（他人あてはウォレット、L7）と合わせる。
- 実行：④の Run が、⑥の計画（署名つき、定義のハッシュに固定）を受け取って、既存の命令を順に送る。⑥の模擬実行は、この部分を置き換えるための目印。
