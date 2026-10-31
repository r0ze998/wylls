# P8 は P7 と同じファイル（`src/frontier/routes/prize.mjs`）の末尾のハンクに含まれる

`POST /f/prize/claim` の応答を `amount: entry ? String(entry.claimAmount) : null, amountKnown: !!entry` に変える 2 行。P7 のパッチを当てると一緒に入る。単独で欲しい場合は P7 の最後のハンクだけを適用する。
