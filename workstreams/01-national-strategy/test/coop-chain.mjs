// 国をまたぐ依頼のテストで使う偽のチェーン：口座のバイト列を、ゲームの画面と同じ v2 の配置（abi-v2-layouts.mjs）で書く。
// citizen(who, faction)：このシーズンの Citizen、holding(to, who, faction)：その人の村。

import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { pubkeyBytes } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { LAYOUTS } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { PRESETS as V2PRESETS } from '../../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';

/** PS2 の記録の本体：ver ‖ kind ‖ bell u32 ‖ key ‖ payload ‖ tail（n=0）。欄の並びと長さは abi-v2-logs.mjs の表から。 */
export function ps2Body(name, bell, fields) {
  const k = LOGS.kinds.find(x => x.name === name);
  const parts = [];
  const head = new Uint8Array(6); head[0] = 1; head[1] = k.kind; new DataView(head.buffer).setUint32(2, bell, true);
  parts.push(head);
  for (const f of [...k.key, ...k.payload]) {
    const v = fields[f.name] ?? 0, b = new Uint8Array(f.len), dv = new DataView(b.buffer);
    if (v instanceof Uint8Array) b.set(v.subarray(0, f.len));
    else if (f.len === 1) b[0] = Number(v);
    else if (f.len === 2) dv.setUint16(0, Number(v) & 0xffff, true);
    else if (f.len === 4) dv.setUint32(0, Number(v) >>> 0, true);
    else if (f.len === 8) dv.setBigUint64(0, BigInt.asUintN(64, BigInt(v)), true);
    parts.push(b);
  }
  parts.push(new Uint8Array([0]));
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
/** log_place（8バイト）。 */
export function logPlace({ kind = 1, p, q, at, gen, tile = 0 }) {
  const b = new Uint8Array(8), dv = new DataView(b.buffer);
  b[0] = kind; dv.setInt16(1, p, true); dv.setInt16(3, q, true); b[5] = at; b[6] = gen; b[7] = tile;
  return b;
}
const kindNum = k => (k === 'holding' ? 1 : k === 'vault' ? 2 : k ?? 1);
/** 中継が受け取った取引（solana-tx parseTransaction の形）を、getTransaction の形（message・signatures）にする。 */
export function txJson(parsed, sigs) {
  return {
    message: { accountKeys: parsed.accountKeys, numSigners: parsed.header.numRequiredSignatures,
      instructions: parsed.instructions.map(i => ({ programIdIndex: i.programIdIndex, accounts: i.accounts, data: toBase58(i.data) })) },
    signatures: sigs,
  };
}
const cargoLog = c => { const b = new Uint8Array(32), dv = new DataView(b.buffer); c.forEach((v, i) => dv.setUint32(4 * i, v, true)); return b; };

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
  const sigs = new Map(), txs = new Map();
  let n = 0;
  let clock = () => 1_790_000_000;   // 取引の blockTime（テストの時計に合わせる：setClock）
  /** 取引を一つ足す：触れた口座の住所、ログの記録（[name, fields]）。ほかのプログラムの記録を混ぜることもできる。 */
  const tx = (addrs, records, { err = null, foreign = [], signature: named = null, message = null, signatures = [] } = {}) => {
    const signature = named ?? `sig${++n}`;
    if (named) ++n;
    const logs = [`Program ${programId} invoke [1]`, ...records.map(([name, f]) => `Program data: UFMy ${toBase64(ps2Body(name, 100 + n, f))}`), `Program ${programId} success`,
      ...foreign.map(([pid, name, f]) => [`Program ${pid} invoke [1]`, `Program data: UFMy ${toBase64(ps2Body(name, 1, f))}`, `Program ${pid} success`]).flat()];
    txs.set(signature, { err, logs, slot: n, blockTime: clock(), message, signatures: signatures.length ? signatures : [signature] });
    for (const a of addrs) sigs.set(a, [{ signature, err }, ...(sigs.get(a) ?? [])]);
    return signature;
  };
  const CV = LAYOUTS.accounts.find(a => a.kind === 'Caravan');
  const off = name => CV.fields.find(f => f.name === name).off;
  const writeCaravan = (who, ownerTag, seq, dst, cargo, state = 1, owner = who) => {
    const { b, dv } = head(320, 'PSF1CRVN');
    b.set(pubkeyBytes(A.of('Citizen', { wallet: owner.address })), off('OWNER_CITIZEN'));
    dv.setBigUint64(off('OWNER_TAG'), BigInt(ownerTag), true);
    dv.setUint32(off('SEQ'), seq, true);
    b[off('STATE')] = state;
    const d = off('DST');
    b[d] = kindNum(dst.kind); dv.setInt16(d + 1, dst.p, true); dv.setInt16(d + 3, dst.q, true); b[d + 5] = dst.site ?? dst.at; b[d + 6] = dst.gen;
    cargo.forEach((v, i) => dv.setBigInt64(off('CARGO') + 8 * i, BigInt(v) * 1000n, true));
    accounts.set(A.of('Caravan', { ownerTag: BigInt(ownerTag), seq }), b);
  };
  const this_expired = new Set();
  return {
    tx, txs, sigs,
    setClock(f) { clock = f; },
    /** 隊商を送る（口座を作り、CARAVAN_SENT を記録する）。 */
    caravanSent(who, ownerTag, seq, dst, cargo, opts = {}) {
      writeCaravan(who, ownerTag, seq, dst, cargo);
      const src = opts.src ?? { p: 0, q: 0, site: 0, gen: 0 };
      return tx([A.of('Caravan', { ownerTag: BigInt(ownerTag), seq })], [['CARAVAN_SENT', { owner_tag: ownerTag, seq, src: logPlace({ kind: 1, p: src.p, q: src.q, at: src.site, gen: src.gen }), dst: logPlace({ kind: kindNum(dst.kind), p: dst.p, q: dst.q, at: dst.site ?? dst.at, gen: dst.gen }), cargo: cargoLog(cargo) }]], opts);
    },
    /** 確定（口座を閉じ、CARAVAN_SETTLED を記録する）。 */
    caravanSettled(ownerTag, seq, outcome, dst, cargo, opts = {}) {
      const addr = A.of('Caravan', { ownerTag: BigInt(ownerTag), seq });
      accounts.delete(addr);
      return tx([addr], [['CARAVAN_SETTLED', { owner_tag: ownerTag, seq, outcome, dst: logPlace({ kind: kindNum(dst.kind), p: dst.p, q: dst.q, at: dst.site ?? dst.at, gen: dst.gen }), cargo: cargoLog(cargo), fee: 50000 }]], opts);
    },
    /** 襲撃（奪う：口座は奪った人の物になり行き先が変わる。焼く：積荷が0）。 */
    caravanRaided(who, ownerTag, seq, choice, raider, raiderTag, newDst, cargo) {
      const addr = A.of('Caravan', { ownerTag: BigInt(ownerTag), seq });
      if (choice === 0) writeCaravan(who, ownerTag, seq, newDst, cargo, 1, raider);
      else writeCaravan(who, ownerTag, seq, newDst, cargo.map(() => 0), 1);
      tx([addr], [['CARAVAN_RAIDED', { owner_tag: ownerTag, seq, choice, raider_tag: raiderTag, taken: cargoLog(cargo) }]]);
    },
    /** 期限の切れた blockhash（isBlockhashValid が false を返す）。 */
    expired: this_expired,
    reader: {
      blockhashValid: async h => !this_expired.has(h),
      account: async addr => accounts.get(addr) ?? null,
      signatures: async addr => sigs.get(addr) ?? [],
      transaction: async sig => txs.get(sig) ?? null,
    },
    /** Citizen：国、隊商の番号（CARAVANS）、村（HOLDING・HOLDINGS_N）、追放（EXPELLED_SINCE）。 */
    citizen(who, faction, { wallet = who.address, caravans = 0, holdings = [], expelledSince = 0 } = {}) {
      const { b, dv } = head(384, 'PSF1CITZ');
      const CZ = LAYOUTS.accounts.find(a => a.kind === 'Citizen');
      const at = name => CZ.fields.find(f => f.name === name).off;
      b.set(pubkeyBytes(wallet), at('WALLET'));
      b[at('FACTION')] = faction;
      b[at('HOLDINGS_N')] = holdings.length;
      holdings.forEach((h, i) => { const o = at('HOLDING') + 6 * i; dv.setInt16(o, h.p, true); dv.setInt16(o + 2, h.q, true); b[o + 4] = h.site; b[o + 5] = h.gen; });
      dv.setUint32(at('CARAVANS'), caravans, true);
      dv.setBigInt64(at('EXPELLED_SINCE'), BigInt(expelledSince), true);
      accounts.set(A.of('Citizen', { wallet: who.address }), b);
    },
    /** シーズンの口座：規則の hash（RULESET_HASH）と版。既定は S1 の RULESET_HASH_V3。 */
    season(rulesetHashHex = V2PRESETS.ruleset_hash_v3, programVersion = 4) {
      const { b, dv } = head(2048, 'PSF1SEAS');
      const SE = LAYOUTS.accounts.find(a => a.kind === 'Season');
      const at = name => SE.fields.find(f => f.name === name).off;
      b.set(Uint8Array.from(rulesetHashHex.match(/../g).map(h => parseInt(h, 16))), at('RULESET_HASH'));
      dv.setUint16(at('PROGRAM_VERSION'), programVersion, true);
      accounts.set(A.season, b);
    },
    /** 州：地形の印（ここではすべて通れる平地）。 */
    province(p, q) {
      const { b, dv } = head(4736, 'PSF1PROV');
      const PV = LAYOUTS.accounts.find(a => a.kind === 'Province');
      const at = name => PV.fields.find(f => f.name === name).off;
      dv.setInt16(at('P'), p, true); dv.setInt16(at('Q'), q, true);
      dv.setBigUint64(at('PASSABLE_MASK'), (1n << 61n) - 1n, true);
      accounts.set(A.of('Province', { p, q }), b);
    },
    /** 村：stores は整数単位の在庫（rate 0、t0 = 0。STORES は Accrual ×8：VALUE ミリ・RATE・CAP・T0・FRAC）。 */
    holding(to, who, faction, { tile = 20, stores = [] } = {}) {
      const { b, dv } = head(1280, 'PSF1HOLD');
      dv.setInt16(64, to.p, true); dv.setInt16(66, to.q, true); b[68] = to.site; b[69] = to.gen; b[70] = tile;
      stores.forEach((v, i) => { dv.setBigInt64(152 + 40 * i, BigInt(v) * 1000n, true); dv.setBigInt64(152 + 40 * i + 16, 10_000_000n, true); });
      b.set(pubkeyBytes(A.of('Citizen', { wallet: who.address })), 72);
      b[112] = faction;
      accounts.set(A.of('Holding', { p: to.p, q: to.q, site: to.site }), b);
    },
    drop(addr) { accounts.delete(addr); },
  };
}
