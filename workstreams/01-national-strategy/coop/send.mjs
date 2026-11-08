// 依頼に応じて、物を送る：既存の S1 の隊商の道（SendCaravan）を、ゲームの画面と同じコードで組み立てて送る。
//
// ゲームの画面の s1Caravan（permutation-server/web/frontier/controller.mjs）と同じ手順・同じ関数：
//   道（fcaravan.mjs landsWanted・landOfProvince・fastestPath・pack）、口座と欄（fplay.mjs accountsFor・placeData・cargoBytes）、
//   取引の組み立てと中継への送信（fplay.mjs submit：buildShape・messageProblems・ウォレットの署名・中継の署名の確かめ）。
// 違うのは、画面の状態（FS）の代わりに、送る人の Citizen・村・州をチェーンの口座から読むこと（chain.mjs）。
//
// 守っていること：
//   - 署名するのは送る人本人のウォレットだけ（ほかの人の村あての隊商は WalletRequired：caravan.rs）。板もこの画面も代わりに署名しない。
//   - 依頼に応じた（accept）だけでは何も送らない。送るのは本人がこの操作をしたときだけ。
//   - 届け先は依頼の村（依頼した人の村だとチェーンで確かめた村）だけ。荷は依頼の資源だけで、依頼の量を超えない。
//   - 送った後の結び付け（link）は、別の署名付きの記録（record.mjs）。

import { fastestPath, pack, landsWanted, landOfProvince, CARAVAN_FEE } from '../../../permutation-server/web/frontier/fcaravan.mjs';
import * as fplay from '../../../permutation-server/web/frontier/fplay.mjs';
import * as io from '../../../permutation-server/web/frontier/fchainio.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { RESOURCES, ownerTagOf } from './record.mjs';
import { PRESETS as V2 } from '../../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';

/** S1 の規則の hash（frontier-abi v2 presets RULESET_HASH_V3）。シーズンが S1 でなければ、ゲームのコード（setPin）が断る。 */
export const S1_RULESET_HASH = V2.ruleset_hash_v3;
import { encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { citizenOf, holdingOf } from './chain.mjs';

const fail = (code, why) => ({ ok: false, code, why });

/** 村の口座（v2）から、送り元・届け先に要る欄。 */
async function holdingAt(reader, season, ref) {
  const A = seasonAddresses(season.programId, season.seasonId);
  const bytes = await reader.account(A.of('Holding', ref));
  if (!bytes) return null;
  const h = decode('Holding', bytes, { seasonId: season.seasonId });
  return { p: h.p, q: h.q, site: h.site, gen: h.gen, tile: h.tile, ownerCitizen: toBase58(h.ownerCitizen) };
}

/** 州の口座から、道を探すのに要る地形の印（ゲームの画面が herald の封筒から得るのと同じ欄）。 */
async function landsFromChain(reader, season, a, b) {
  const A = seasonAddresses(season.programId, season.seasonId);
  const out = [];
  for (const c of landsWanted(a, b)) {
    const bytes = await reader.account(A.of('Province', c));
    if (!bytes) continue;
    out.push(landOfProvince(decode('Province', bytes, { seasonId: season.seasonId })));
  }
  return out;
}

/**
 * 送る計画を立てる（まだ署名も送信もしない）。
 *   reader：chain.mjs の rpcReader、season：{programId, seasonId}、wallet：送る人、request：依頼（fold の形）、
 *   cargo：{resource: 量}（依頼の資源だけ、依頼の量まで）、source：送り元の村 {p, q, site}（省略すると Citizen の最初の村）。
 * → {ok: true, name: 'SendCaravan', accounts, fields, plan, caravan: {ownerTag, seq}, src, dst} か {ok: false, code, why}
 */
export async function planSend({ reader, season, wallet, request, cargo, source = null, profile = 3 }) {
  if (!reader) return fail('NoChain', 'チェーンを読めないので、送り元・道・番号を決められない');
  if (request.requester === wallet) return fail('OwnRequest', '自分の依頼には送れない（自分の村の間の移動はゲームの画面から）');
  // 荷：依頼の資源だけ、依頼の量まで
  const amounts = Array(8).fill(0);
  for (const [r, v] of Object.entries(cargo ?? {})) {
    if (!(r in request.need)) return fail('NotRequested', `依頼にない資源：${r}`);
    if (!Number.isInteger(v) || v < 0 || v > request.need[r]) return fail('BadAmount', `量が依頼の範囲にない：${r} ${v}`);
    amounts[RESOURCES.indexOf(r)] = v;
  }
  if (amounts.every(v => v === 0)) return fail('NoCargo', '運ぶものがない');
  // 送る人の Citizen（番号 CARAVANS と村）
  const me = await citizenOf(reader, season, wallet);
  if (!me.citizen) return fail('NoCitizen', `送る人の Citizen を確かめられない：${me.why}`);
  const ref = source ?? me.holdings?.slice(0, me.holdingsN ?? 0)[0];
  if (!ref) return fail('NoVillage', '送り元の村がない');
  const src = await holdingAt(reader, season, { p: ref.p, q: ref.q, site: ref.site });
  if (!src) return fail('NoVillage', '送り元の村の口座がない');
  const A = seasonAddresses(season.programId, season.seasonId);
  if (src.ownerCitizen !== me.citizen) return fail('NotYourVillage', '送り元の村の持ち主ではない');
  // 届け先：依頼の村が、依頼した人の村で、世代が同じ
  const host = await holdingOf(reader, season, request.to, request.requester);
  if (host.status !== 'verified') return fail('BadDestination', `届け先を確かめられない：${host.why}`);
  const dstH = await holdingAt(reader, season, request.to);
  // 道（ゲームの画面と同じ関数）
  const plan = fastestPath({ p: src.p, q: src.q, tile: src.tile }, { p: dstH.p, q: dstH.q, tile: dstH.tile }, await landsFromChain(reader, season, src, dstH));
  if (!plan || !plan.dirs.length) return fail('NoPath', 'そこまで隊商の道が届かない（32マス・4州まで）');
  const seq = Number(me.caravans ?? 0);
  const srcPlace = { kind: 'holding', p: src.p, q: src.q, site: src.site, gen: src.gen };
  const dst = { kind: 'holding', p: request.to.p, q: request.to.q, site: request.to.site, gen: request.to.gen };
  // 口座と欄（ゲームの画面の s1Caravan と同じ組み立て。ほかの人あてなので actor はウォレット）
  const accounts = fplay.accountsFor('SendCaravan', { addresses: A, wallet, actor: wallet, profile, seq, src: srcPlace, dst, provinces: plan.provinces });
  const fields = { seq, ...fplay.placeData(dst), steps: plan.dirs.length, path: pack(plan.dirs), cargo: fplay.cargoBytes(amounts), fee: CARAVAN_FEE };
  return { ok: true, name: 'SendCaravan', accounts, fields, plan, src: srcPlace, dst, cargo: amounts, caravan: { ownerTag: ownerTagOf(season, wallet), seq } };
}

/**
 * 計画を送る：中継（relay）とシーズンを合わせ、送る人のウォレットで署名して、ゲームと同じ fplay.submit で送る。
 *   wallet：{address, signTransaction(wire) → wire}（Wallet Standard の solana:signTransaction。wallet.mjs の connected()）
 * → fplay.submit の結果（{ok: true, signature, …} か {ok: false, code, error}）
 */
export async function sendPlanned(planned, { relay, season, rulesetHash = S1_RULESET_HASH, wallet }) {
  if (!planned?.ok) return planned;
  io.setRelay(relay);
  io.setPin({ programId: season.programId, cluster: 'localnet', seasonId: season.seasonId, rulesetHash });
  return fplay.submit({ name: planned.name, accounts: planned.accounts, fields: planned.fields, signer: { wallet } });
}
