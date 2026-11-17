// The sale state of the resident pass, as the resident program decides it
// (program/src/lib.rs `sale_check`): every value — price, supply, window,
// per-wallet limit — is the config authority's setting; nothing is fixed
// here. Browser-safe, dependency-free (the page and the node tests import it).
//
//   saleState(terms, nowSecs, walletMinted = 0) →
//     {open: bool, code: null | 'SaleClosed' | 'SupplyNotSet' | 'SoldOut' | 'SaleNotStarted' | 'SaleEnded' | 'WalletLimit' | 'MetadataNotSet',
//      remaining: bigint | null}

/** Japanese reasons the page shows (the program's error names). */
export const SALE_TEXT = Object.freeze({
  SaleClosed: '販売はまだ始まっていません（運営が販売条件を設定し、開始するまでお待ちください）。',
  SupplyNotSet: '供給数がまだ設定されていません。',
  SoldOut: '予定数をすべて発行しました。',
  SaleNotStarted: '販売の開始時刻前です。',
  SaleEnded: '販売期間は終了しました。',
  WalletLimit: 'このウォレットで取得できる上限に達しています。',
  MetadataNotSet: 'NFT の名前・メタデータがまだ設定されていません。',
});

const big = v => BigInt(v ?? 0);

/** The program's order of checks, for one more mint now by a wallet that has minted `walletMinted`. */
export function saleState(terms, nowSecs, walletMinted = 0) {
  const t = terms ?? {};
  const max = big(t.maxSupply), minted = big(t.minted);
  const remaining = max > 0n ? (max > minted ? max - minted : 0n) : null;
  const refuse = code => ({ open: false, code, remaining });
  if (!t.open) return refuse('SaleClosed');
  if (max === 0n) return refuse('SupplyNotSet');
  if (minted >= max) return refuse('SoldOut');
  const now = big(nowSecs), start = big(t.saleStart), end = big(t.saleEnd);
  if (start !== 0n && now < start) return refuse('SaleNotStarted');
  if (end !== 0n && now >= end) return refuse('SaleEnded');
  if (Number(t.perWallet ?? 0) > 0 && Number(walletMinted) >= Number(t.perWallet)) return refuse('WalletLimit');
  if (!t.name || !t.uri) return refuse('MetadataNotSet');
  return { open: true, code: null, remaining };
}
