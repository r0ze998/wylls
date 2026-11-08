// 口座の住所（シーズンの PDA から作る Citizen・Holding・Caravan などのアドレス）と、隊商の鍵の持ち主の印（owner tag）を一か所で決める。
//
// 本番：ゲームと同じ faddr.mjs `seasonAddresses`（find_program_address・create_with_seed で住所を導出する）。
// 試験：`useAddresses(tableAddresses())` で、導出をしない表に差し替えられる（鍵の生成・導出・署名を伴う試験を行わないため）。
//   表の住所は、要求された順に番号を振っただけの 32 バイト（先頭 8 バイトが番号）。本物の住所とは一致しない。
//   owner tag は本物と同じ読み方（Citizen の住所の先頭 8 バイト、little-endian：faddr.mjs `citizenTag`）。
// 住所の決め方は①が作らない（④⑧・S1 の正本）。ここは差し替えの口だけ。

import { citizenTag, seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';

let make = seasonAddresses;

/** 文脈（{programId, seasonId}）の住所の表（seasonAddresses と同じ形：programId, seasonId, season, bump, of(kind, key), absent(n), holdingOfHost）。 */
export const addressesOf = ctx => make(ctx.programId, ctx.seasonId);
/** 隊商の鍵の持ち主の印：その文脈の Citizen の住所の先頭 8 バイト（10 進の文字列）。 */
export const ownerTagOf = (ctx, wallet) => citizenTag(addressesOf(ctx).of('Citizen', { wallet })).toString();

/** 住所の決め方を差し替える（試験用）。元に戻す関数を返す。 */
export function useAddresses(f) {
  const prev = make;
  make = f;
  return () => { make = prev; };
}

// 種類ごとに住所を決める欄（faddr.mjs RAW と同じ欄。ほかの欄は住所に効かない：例えば村の kind・gen）
const FIELDS = Object.freeze({
  Citizen: ['wallet'], Holding: ['p', 'q', 'site'], Province: ['p', 'q'], Vault: ['p', 'q', 'tile'], Structure: ['p', 'q', 'tile'],
  Caravan: ['ownerTag', 'seq'], Nation: ['faction'], JoinShard: ['faction', 'shard'], ProvinceFund: ['w'], RingSeed: ['d'], BeaconLog: ['region'],
});
const keyText = (kind, key) => JSON.stringify((FIELDS[kind] ?? Object.keys(key).sort()).map(k => [k, key[k] === undefined ? null : String(key[k])]));

/**
 * 導出をしない住所の表（試験用）。同じ文脈・種類・鍵には同じ住所、違えば違う住所。番号は 1001 から。
 * 先頭 8 バイトが番号、9 バイト目以降は 0xA5（本物のウォレットの住所と取り違えないための目印）。
 */
export function tableAddresses() {
  const table = new Map();
  const addr = text => {
    if (!table.has(text)) {
      const b = new Uint8Array(32).fill(0xa5);
      new DataView(b.buffer).setBigUint64(0, BigInt(1001 + table.size), true);
      table.set(text, toBase58(b));
    }
    return table.get(text);
  };
  const book = (programId, seasonId) => {
    const ctx = `${programId}/${String(BigInt(String(seasonId)))}`;
    const of = (kind, key = {}) => addr(`${ctx}|${kind}|${keyText(kind, key)}`);
    return Object.freeze({
      programId, seasonId: String(BigInt(String(seasonId))), season: addr(`${ctx}|Season`), bump: 255, of,
      absent: n => addr(`${ctx}|absent|${n & 0xff}`),
      holdingOfHost: () => null,
    });
  };
  book.table = table;
  return book;
}
