// 国をまたぐ依頼のテストで使う偽のチェーン：口座のバイト列を、ゲームの画面と同じ v2 の配置（abi-v2-layouts.mjs）で書く。
// citizen(who, faction)：このシーズンの Citizen、holding(to, who, faction)：その人の村。

import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { pubkeyBytes } from '../../../permutation-server/web/sdk/solana-tx.mjs';

export function fakeChain(programId, seasonId) {
  const accounts = new Map();
  const A = seasonAddresses(programId, seasonId);
  const head = (size, magic) => {
    const b = new Uint8Array(size), dv = new DataView(b.buffer);
    b.set(new TextEncoder().encode(magic), 0);
    dv.setBigUint64(8, BigInt(seasonId), true);
    dv.setUint16(16, 2, true);   // 配置の版 2（S1）
    return { b, dv };
  };
  return {
    reader: { account: async addr => accounts.get(addr) ?? null },
    citizen(who, faction, { wallet = who.address } = {}) {
      const { b } = head(384, 'PSF1CITZ');
      b.set(pubkeyBytes(wallet), 64);
      b[136] = faction;
      accounts.set(A.of('Citizen', { wallet: who.address }), b);
    },
    holding(to, who, faction) {
      const { b, dv } = head(1280, 'PSF1HOLD');
      dv.setInt16(64, to.p, true); dv.setInt16(66, to.q, true); b[68] = to.site; b[69] = to.gen;
      b.set(pubkeyBytes(A.of('Citizen', { wallet: who.address })), 72);
      b[112] = faction;
      accounts.set(A.of('Holding', { p: to.p, q: to.q, site: to.site }), b);
    },
    drop(addr) { accounts.delete(addr); },
  };
}
