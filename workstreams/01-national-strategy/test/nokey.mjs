// 鍵の生成・導出・署名をしない試験の入力（2026-11-08）。既存の試験の testSigner・signRecord をこれに差し替える。
//   - 人：決まった 32 バイトの base58 の住所（鍵の対ではない。秘密鍵が無いので署名できない）。
//   - 記録：sig に 'unsigned:<signer>' を入れるだけ（署名ではない）。
//   - 板：verify を、その印を確かめるだけの関数にする（Ed25519 の verifySig は呼ばない）。本物の署名の確かめは、この試験では確かめない。
//   - 口座の住所（PDA・create_with_seed）は本物（公開の住所の計算。2026-11-08 に許可）。
import { encode as b58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { createBoard as realCreateBoard } from '../coop/board.mjs';

/** testSigner の代わり：seed のバイト列をそのまま住所にする（鍵を作らない）。 */
export const fixedSigner = async seed => ({ address: b58(Uint8Array.from(seed)) });
export const UNSIGNED = signer => `unsigned:${signer}`;
/** signRecord の代わり：署名の欄に印を入れるだけ。 */
export const unsignedRecord = async (who, rec) => ({ ...rec, signer: who.address, sig: UNSIGNED(who.address) });
export const verifyUnsigned = async rec => typeof rec?.sig === 'string' && rec.sig === UNSIGNED(rec.signer);
/** 板：verify だけを差し替える（ほかは本物）。 */
export const createBoard = opts => realCreateBoard({ verify: verifyUnsigned, ...opts });
