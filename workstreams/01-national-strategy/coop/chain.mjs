// チェーンの口座を読んで確かめる：ウォレットと Citizen の対応・国（陣営）、届け先の村の持ち主と世代。
//
// 国は自己申告を使わない。対象シーズンの Citizen の口座（住所はウォレットから計算：faddr.mjs）を読み、
//   口座がある・シーズンが同じ・WALLET が署名したウォレットと同じ、のときだけ FACTION を「確かめた国」にする。
// 読めない・合わないときは「未検証」で、国際協力の達成は確定しない（goal.mjs）。
// 読む口座の形は、ゲームの画面と同じ表（fcodec.mjs、frontier-abi の v2 の配置）。

import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { equal, fromBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { pubkeyBytes } from '../../../permutation-server/web/sdk/solana-tx.mjs';

/** JSON-RPC の getAccountInfo で口座のバイト列を読む（ない口座は null）。 */
export function rpcReader(rpcUrl, { fetchImpl = fetch } = {}) {
  return {
    async account(address) {
      const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed' }] }) });
      const j = await r.json();
      if (j.error) throw new Error(`rpc: ${j.error.message ?? j.error.code}`);
      const v = j.result?.value;
      return v ? fromBase64(v.data[0]) : null;
    },
  };
}

/**
 * ウォレットの国を確かめる。{status: 'verified', faction, citizen} か {status: 'unverified', why}。
 * `reader` がない（チェーンを読めない）ときも unverified。
 */
export async function citizenOf(reader, season, wallet) {
  if (!reader) return { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' };
  const citizen = seasonAddresses(season.programId, season.seasonId).of('Citizen', { wallet });
  let bytes;
  try { bytes = await reader.account(citizen); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (!bytes) return { status: 'unverified', why: 'このシーズンの Citizen の口座がない（参加していない）' };
  let c;
  try { c = decode('Citizen', bytes, { seasonId: season.seasonId }); } catch (e) { return { status: 'unverified', why: `Citizen の口座が読めない：${e.code ?? e.message}` }; }
  if (!equal(c.wallet, pubkeyBytes(wallet))) return { status: 'unverified', why: 'Citizen の口座のウォレットが署名した人と違う' };
  return { status: 'verified', faction: c.faction, citizen };
}

/**
 * 届け先の村が、依頼した人の Citizen の村で、世代が依頼と同じかを確かめる。
 * {status: 'verified', faction} か {status: 'unverified', why}。
 */
export async function holdingOf(reader, season, to, wallet) {
  if (!reader) return { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' };
  const A = seasonAddresses(season.programId, season.seasonId);
  let bytes;
  try { bytes = await reader.account(A.of('Holding', { p: to.p, q: to.q, site: to.site })); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (!bytes) return { status: 'unverified', why: '届け先の村の口座がない' };
  let h;
  try { h = decode('Holding', bytes, { seasonId: season.seasonId }); } catch (e) { return { status: 'unverified', why: `村の口座が読めない：${e.code ?? e.message}` }; }
  if (!equal(h.ownerCitizen, pubkeyBytes(A.of('Citizen', { wallet })))) return { status: 'unverified', why: '届け先の村の持ち主が、依頼した人ではない' };
  if (h.gen !== to.gen) return { status: 'unverified', why: `届け先の村の世代が違う（依頼 ${to.gen}・今 ${h.gen}）` };
  return { status: 'verified', faction: h.faction };
}
