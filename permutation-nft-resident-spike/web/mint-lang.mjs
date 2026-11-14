// The mint page's two languages. Japanese is written in the page; `T` returns the English when the page is in
// English: the key is the Japanese template with its values as {0}, {1}… (as the game's L`…`). The language comes
// from `?lang=en|ja` (kept for the next visit), else the last choice, else the browser's language (Japanese for
// `ja*`, English otherwise). Every TEST label stays: price, supply and sale are test values in both languages.
const STORE = 'wylls-mint-lang';
const store = {
  get() { try { return globalThis.localStorage?.getItem(STORE) ?? null; } catch { return null; } },
  set(v) { try { globalThis.localStorage?.setItem(STORE, v); } catch { /* private mode: this visit only */ } },
};

export function pickLang({ search = globalThis.location?.search ?? '', saved = store.get(), language = globalThis.navigator?.language ?? 'ja' } = {}) {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'en' || q === 'ja') return { lang: q, save: true };
  if (saved === 'en' || saved === 'ja') return { lang: saved, save: false };
  return { lang: /^ja\b/i.test(language) ? 'ja' : 'en', save: false };
}

let current = 'ja';
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
});
