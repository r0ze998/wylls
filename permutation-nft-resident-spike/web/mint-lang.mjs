// The mint page's two languages. Japanese is written in the page; `T` returns the English when the page is in
// English: the key is the Japanese template with its values as {0}, {1}… (as the game's L`…`). The language comes
// from `?lang=en|ja` (kept for the next visit), else the last choice, else English (the default for every browser). Every TEST label stays: price, supply and sale are test values in both languages.
const STORE = 'wylls-mint-lang';
const store = {
  get() { try { return globalThis.localStorage?.getItem(STORE) ?? null; } catch { return null; } },
  set(v) { try { globalThis.localStorage?.setItem(STORE, v); } catch { /* private mode: this visit only */ } },
};

export function pickLang({ search = globalThis.location?.search ?? '', saved = store.get() } = {}) {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'en' || q === 'ja') return { lang: q, save: true };
  if (saved === 'en' || saved === 'ja') return { lang: saved, save: false };
  // English by default: Japanese only when asked for (?lang=ja or the toggle, which is kept).
  return { lang: 'en', save: false };
}

let current = 'en';
export const lang = () => current;
export function setLang(l, { save = true } = {}) { current = l === 'en' ? 'en' : 'ja'; if (save) store.set(current); }

const keyOf = strings => strings.reduce((k, s, i) => k + (i ? `{${i - 1}}` : '') + s, '');
const fill = (text, values) => text.replace(/\{(\d+)\}/g, (m, i) => (+i < values.length ? String(values[+i]) : m));

/** A template in the current language. */
export function T(strings, ...values) {
  if (current === 'en') { const en = EN[keyOf(strings)]; if (en !== undefined) return fill(en, values); }
  return strings.reduce((out, s, i) => out + (i ? String(values[i - 1]) : '') + s, '');
}
/** A whole Japanese string from elsewhere (the server's price label, a sale refusal) in the current language. */
export const tr = s => (current === 'en' && typeof s === 'string' && EN[s] !== undefined ? EN[s] : s);

/** The page's static text: `<html lang>`, the title and every `[data-i18n]` element. */
export function translateStatic(doc = globalThis.document) {
  if (!doc) return;
  doc.documentElement.lang = current;
  if (!doc.documentElement.dataset.titleJa) doc.documentElement.dataset.titleJa = doc.title;
  doc.title = tr(doc.documentElement.dataset.titleJa);
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.ja) el.dataset.ja = el.textContent.trim();
    el.textContent = tr(el.dataset.ja);
  }
}

export const EN = Object.freeze({
  // static
  'Wylls 住民 NFT — devnet テスト mint': 'Wylls resident NFT — test mint',
  'DEVNET のテストです。本番の参加権や金銭的価値を保証しません。テスト用 SOL だけを使ってください。': 'A DEVNET TEST. No entry right or money value is promised. Use test SOL only.',
  'ローカル検証ネット（実 program、ループバック validator）のテストです。本番の参加権や金銭的価値を保証しません。テスト用 SOL だけを使ってください。': 'A LOCAL TEST network (the real programs on a loopback validator). No entry right or money value is promised. Use test SOL only.',
  '接続先と費用の見込み': 'Network and estimated cost',
  'ネットワーク': 'Network', '価格': 'Price', '発行数': 'Minted', '販売': 'Sale', 'ネットワーク手数料': 'Network fee',
  '口座作成費（NFT＋住民）': 'Account rent (NFT + resident)', '合計の見込み': 'Estimated total',
  '価格はテスト用で、本番の販売条件ではありません。費用は見込みで、確定値は取引で決まります。': 'The price is a TEST value, not the terms of a real sale. Costs are estimates; the transaction decides the final amounts.',
  'ウォレット': 'Wallet', '接続中': 'Connected', '残高': 'Balance',
  'スマホの場合：ウォレットアプリ内のブラウザでこのページを開くか、アプリで署名してこのページへ戻ってください。戻った後、進行中の取引は自動で照会します。': 'On a phone: open this page in your wallet app\'s browser, or sign in the app and come back here. A transaction in progress is looked up again automatically.',
  'NFT を mint して waitlist に登録する': 'Mint the NFT (your entry pass)',
  'NFT の取得がそのまま waitlist 登録です。別の登録フォームはありません。支払い・NFT 発行・住民 ID への紐付けは 1 つの取引で成立し、途中で失敗すれば支払いも戻ります（ネットワーク手数料を除く）。': 'Holding the NFT is your place on the waitlist; there is no other form. Payment, the NFT and its resident ID happen in one transaction: if any part fails, the payment comes back (except the network fee).',
  'テスト SOL で mint する': 'Mint with test SOL', '保有状態を再確認': 'Check again', '準備中…': 'Getting ready…',
  '住民 ID': 'Resident ID', '取引署名': 'Signature', '保有者': 'Holder',
  'あなたの住民（チェーンの読取結果）': 'Your residents (read from the chain)',
  // the server's price label
  'TEST PRICE — 試験用の仮値、本番価格ではない': 'TEST PRICE — a test value, not a real price',
  // sale refusals (sale.mjs)
  '販売はまだ始まっていません（運営が販売条件を設定し、開始するまでお待ちください）。': 'The sale has not started (wait until the operator sets the terms and opens it).',
  '供給数がまだ設定されていません。': 'No supply is set yet.',
  '予定数をすべて発行しました。': 'All planned passes are minted.',
  '販売の開始時刻前です。': 'The sale has not reached its start time.',
  '販売期間は終了しました。': 'The sale has ended.',
  'このウォレットで取得できる上限に達しています。': 'This wallet has reached its limit.',
  'NFT の名前・メタデータがまだ設定されていません。': 'The NFT\'s name and metadata are not set yet.',
  // dynamic
  '{0} ({1}){2}': '{0} ({1}){2}', '［模擬チェーン］': ' [mock chain]',
  '約 {0}（署名 2 件）': 'about {0} (2 signatures)', '約 {0}': 'about {0}',
  '接続先ネットワークが違います（RPC の genesis {0}… ≠ 期待 {1}…）。この画面は {2} 専用です。': 'Wrong network (the RPC\'s genesis {0}… ≠ expected {1}…). This page is for {2} only.',
  'RPC に到達できません：{0}': 'Cannot reach the RPC: {0}',
  'ウォレットを接続してください。': 'Connect a wallet.',
  '未設定': 'not set', '{0} / {1}（残り {2}）': '{0} / {1} ({2} left)',
  '開始 {0}': 'starts {0}', '終了 {0}': 'ends {0}', '1 ウォレット {0} 枚まで': 'up to {0} per wallet', '、': ', ',
  '販売中{0}': 'On sale (TEST){0}', '（{0}）': ' ({0})', '{0}{1}': '{0}{1}',
  'ウォレットが見つかりません（Phantom / Solflare / Backpack をインストールするか、スマホはウォレットアプリ内ブラウザで開いてください）': 'No wallet found (install Phantom / Solflare / Backpack, or on a phone open this page in the wallet app\'s browser).',
  'waitlist 登録済みです（チェーンの読取で確認）。公開後はこの NFT で住民へログインします。': 'You hold the pass (read from the chain). Use this NFT to enter the game as its resident.',
  '保有を確認できません：{0}': 'Holding not confirmed: {0}',
  'テスト SOL が不足しています（必要 約 {0}、残高 {1}）。devnet の faucet で補充してください。': 'Not enough test SOL (about {0} needed, {1} held). Top up from the test faucet.',
  'mint できます。ボタンを押すとウォレットで取引を確認・署名します。': 'Ready to mint. The button asks your wallet to review and sign the transaction.',
  '（このウォレットが保有する住民 NFT はありません）': '(this wallet holds no resident NFT)',
  '（あなた）': ' (you)', '（別のウォレット）': ' (another wallet)',
  '進行中の取引を照会しています… {0}…': 'Looking up the transaction in progress… {0}…',
  '前回の取引は失敗しました（{0}）。支払いは戻っています。もう一度 mint できます。': 'The last transaction failed ({0}). The payment is back. You can mint again.',
  '取引が確定し、正規 collection の NFT の保有を確認しました：waitlist 登録完了。': 'Confirmed: you hold the NFT of the real collection. Your pass is ready.',
  '取引は確定しましたが保有を確認できません（{0}）。再確認を押してください。': 'The transaction is confirmed but the holding is not ({0}). Press "Check again".',
  '取引は確定していました（期限切れ後に口座で確認）：waitlist 登録完了。': 'The transaction had landed (found by its account after it expired). Your pass is ready.',
  'asset の口座はありますが': 'The asset account exists but ', 'asset の口座を一度観測したため発行済みとして扱いますが、今は': 'The asset account was seen once, so it counts as minted, but now ',
  '{0}保有を確認できません（{1}）。再確認を押してください。再課金・再発行はしません。': '{0}the holding is not confirmed ({1}). Press "Check again". Nothing is charged or minted again.',
  '期限は切れましたが、確定済み（finalized）の高さ {0} がまだ有効期限 {1} を過ぎていません。再課金・再発行はしません。しばらくして「保有状態を再確認」を押してください。': 'The transaction expired, but the finalized height {0} has not passed its last valid height {1} yet. Nothing is charged or minted again. Press "Check again" in a moment.',
  'asset の口座を finalized で観測しました。再確認を押してください。再課金・再発行はしません。': 'The asset account is finalized. Press "Check again". Nothing is charged or minted again.',
  '前回の取引は期限切れで、finalized でも asset の口座が無く、着地していません（課金なし）。もう一度 mint できます。': 'The last transaction expired and did not land (no asset account at finalized; nothing charged). You can mint again.',
  '結果がまだ分かりません（有効期限 block {0}、現在 {1}）。再課金・再発行はしません。しばらくして「保有状態を再確認」を押してください。': 'The result is not known yet (valid until block {0}, now {1}). Nothing is charged or minted again. Press "Check again" in a moment.',
  'テスト SOL が不足しています（必要 約 {0}）': 'Not enough test SOL (about {0} needed)',
  '取引を作成しています…': 'Building the transaction…',
  '設定の PDA がページの導出と一致しません': 'The configuration addresses do not match the page\'s own derivation',
  'ウォレットで取引を確認し、署名してください…': 'Review and sign the transaction in your wallet…',
  'ウォレットが返した取引の中身が違います': 'The wallet returned a different transaction',
  '送信しています…': 'Sending…',
  '同じ取引が処理済みです': 'This transaction was already processed',
  '取引の期限が切れました。もう一度お試しください': 'The transaction expired. Please try again',
  'テスト SOL が不足しています': 'Not enough test SOL',
  '{0}（課金なし）': '{0} (nothing charged)',
  '価格が変わりました。画面を再読込してください（課金なし）': 'The price changed. Reload the page (nothing charged)',
  'この asset は既に発行済みです（課金なし）': 'This asset is already minted (nothing charged)',
  'プログラムが拒否しました：{0}（課金なし）': 'Refused by the program: {0} (nothing charged)',
  '応答が消えました。署名でチェーンを照会します（再送はしません）…': 'The answer was lost. Looking up the chain by its signature (nothing is resent)…',
  '確定を待っています…': 'Waiting for confirmation…',
  // transfer (TEST)
  '住民を譲渡する（テスト）': 'Transfer your resident (TEST)',
  '譲渡すると、この住民を遊べるのは宛先のウォレットだけになります。このウォレットの操作・署名・session はすべて無効になり、取り消せません（戻すには新しい持ち主からの譲渡が要ります）。': 'After a transfer, only the destination wallet can play this resident. This wallet\'s actions, signatures and sessions for it stop working, and this wallet cannot undo it (only the new owner can transfer it back).',
  '譲渡する住民 NFT': 'Resident NFT to transfer', '宛先のウォレットアドレス': 'Destination wallet address', '内容を確認する': 'Review the transfer',
  'この譲渡を確認してください': 'Check this transfer', '送り主（あなた）': 'From (you)', '宛先': 'To',
  '譲渡後、このウォレットではこの住民を遊べなくなることを理解しました。': 'I understand that this wallet can no longer play this resident after the transfer.',
  '譲渡する（ウォレットで署名）': 'Transfer (sign in your wallet)', 'やめる': 'Cancel',
  '譲渡をやめました。何も送っていません。住民はこのウォレットのままです。': 'Transfer cancelled. Nothing was sent; the resident stays in this wallet.',
  'ウォレットを接続してください。': 'Connect a wallet.',
  '宛先のウォレットアドレスを入力してください。': 'Enter the destination wallet address.',
  '宛先がウォレットアドレスの形ではありません（base58 の文字だけを使います）。': 'The destination is not a wallet address (base58 characters only).',
  '宛先の長さが違います（32 バイトの公開鍵ではありません）。': 'The destination has the wrong length (not a 32-byte public key).',
  '自分自身には譲渡できません。': 'You cannot transfer to your own wallet.',
  '宛先がこのページの program・collection・treasury などの口座です。人のウォレットを指定してください。': 'The destination is one of the system\'s own accounts (a program, the collection, the treasury…). Enter a person\'s wallet.',
  '宛先は署名できない口座（program が導出したアドレス）です。譲渡すると住民を二度と動かせないため、受け付けません。': 'Nobody can sign for the destination (a program-derived address): the resident could never move or play again, so it is refused.',
  'この NFT は今このウォレットのものではありません（チェーンの読取）。譲渡できるのは持ち主だけです。': 'This NFT is not in this wallet now (read from the chain). Only its owner can transfer it.',
  'この NFT は住民として登録されていません。': 'This NFT is not a registered resident.',
  '譲渡できません：{0}': 'Cannot transfer: {0}',
  '宛先はすでに住民 NFT を {0} 枚保有しています。': 'The destination already holds {0} resident NFT(s).',
  '宛先はまだ住民 NFT を保有していません。': 'The destination holds no resident NFT yet.',
  '宛先の保有は読めませんでした。': 'The destination\'s holdings could not be read.',
  '宛先と NFT を確かめ、チェックを入れてから「譲渡する」を押してください。': 'Check the destination and the NFT, tick the box, then press "Transfer".',
  'ウォレットで譲渡の取引を確認し、署名してください…': 'Review and sign the transfer in your wallet…',
  'ウォレットが署名しませんでした（{0}）。何も送っていません。住民はこのウォレットのままです。': 'The wallet did not sign ({0}). Nothing was sent; the resident stays in this wallet.',
  'ウォレットが返した取引の中身が違います。送っていません。': 'The wallet returned a different transaction. Nothing was sent.',
  'この NFT は今このウォレットのものではありません（プログラムが拒否、何も変わっていません）。': 'This NFT is not in this wallet now (refused by the program; nothing changed).',
  'プログラムが拒否しました：{0}（何も変わっていません）': 'Refused by the program: {0} (nothing changed)',
  '拒否されました：{0}（何も変わっていません）': 'Refused: {0} (nothing changed)',
  '応答が消えました。署名とチェーンで結果を照会します（再送はしません）…': 'The answer was lost. Looking up the result by its signature and the chain (nothing is resent)…',
  '進行中の譲渡を照会しています… {0}…': 'Looking up the transfer in progress… {0}…',
  '譲渡の結果がまだ分かりません（有効期限 block {0}）。再送はしません。しばらくして「保有状態を再確認」を押してください。': 'The transfer\'s result is not known yet (valid until block {0}). Nothing is resent. Press "Check again" in a moment.',
  '譲渡しました（チェーンで確認）：住民 {0} の持ち主は {1} です。このウォレットではもうこの住民を遊べません。': 'Transferred (confirmed on the chain): resident {0} now belongs to {1}. This wallet can no longer play this resident.',
  '譲渡の取引は失敗しました（{0}）。何も変わっていません。住民はこのウォレットのままです。': 'The transfer failed ({0}). Nothing changed; the resident stays in this wallet.',
  '譲渡の取引は期限切れで、着地していません。住民はこのウォレットのままです。確認からやり直せます。': 'The transfer expired and did not land. The resident stays in this wallet; you can start again from the review.',
  '取引は決着しましたが、今の持ち主は {0} です（宛先ではありません）。再送はしません。': 'The transaction is decided, but the owner now is {0} (not the destination). Nothing is resent.',
  '取引の処理中はウォレットを切り替えられません。': 'You cannot switch wallets while a transaction is in progress.',
  '別のネットワーク（genesis {0}…）で記録された譲渡を照会から外しました（この画面のネットワークでは答えが出ません）。': 'A transfer recorded on another network (genesis {0}…) was set aside: this page\'s network cannot answer it.',
  '読めない譲渡の記録を照会から外しました。': 'An unreadable transfer record was set aside.',
  'この譲渡の記録をブラウザに保存できません（{0}）。送っていません。': 'This browser cannot save the transfer record ({0}). Nothing was sent.',
  'この譲渡の記録をブラウザに保存できません（読み戻しが違います）。送っていません。': 'This browser cannot save the transfer record (it read back differently). Nothing was sent.',
  '接続中のウォレットまたはネットワークが、確認したときと違います。確認からやり直してください。何も送っていません。': 'The connected wallet or network is not the one you reviewed with. Start again from the review. Nothing was sent.',
  '別のタブでこのウォレットの譲渡が進行中です。そちらの結果を待ってください（このタブからは送っていません）。': 'Another tab is transferring from this wallet. Wait for its result (nothing was sent from this tab).',
  '接続先のネットワークが変わりました。画面を再読込してください。何も送っていません。': 'The network has changed. Reload the page. Nothing was sent.',
  '住民の世代を読めません。何も送っていません。': 'The resident\'s generation cannot be read. Nothing was sent.',
  'ウォレットの署名が送り主の鍵のものではありません。送っていません。': 'The wallet\'s signature is not from the sender\'s key. Nothing was sent.',
  '譲渡は着地し、その後この住民はこのウォレットに戻っています（世代 {0} → {1}）。譲渡前の署名と session は無効です。再送はしません。': 'The transfer landed, and the resident has since come back to this wallet (generation {0} → {1}). Signatures and sessions from before the transfer no longer work. Nothing is resent.',
});
