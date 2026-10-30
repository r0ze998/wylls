// チェーンの口座を読んで確かめる：ウォレットと Citizen の対応・国（陣営）、届け先の村の持ち主と世代。
//
// 国は自己申告を使わない。対象シーズンの Citizen の口座（住所はウォレットから計算：faddr.mjs）を読み、
//   口座がある・シーズンが同じ・WALLET が署名したウォレットと同じ、のときだけ FACTION を「確かめた国」にする。
// 読めない・合わないときは「未検証」で、国際協力の達成は確定しない（goal.mjs）。
// 読む口座の形は、ゲームの画面と同じ表（fcodec.mjs、frontier-abi の v2 の配置）。

import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { equal, fromBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { pubkeyBytes, pubkeyString } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { LAYOUTS as V2 } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { decodeRecord } from '../../../permutation-server/web/frontier/flog.mjs';
import { encode as toBase58, decode as fromBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { decodeIxData } from '../../../permutation-server/web/sdk/frontier/codec.mjs';

/**
 * JSON-RPC でチェーンを読む。account(address) → バイト列か null、signatures(address) → [{signature, err}]（新しい順）、
 * transaction(signature) → {err, logs, programIds} か null。読むだけで、何も送らない。
 */
export function rpcReader(rpcUrl, { fetchImpl = fetch } = {}) {
  const call = async (method, params) => {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? j.error.code}`);
    return j.result;
  };
  return {
    async account(address) {
      const v = (await call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
      return v ? fromBase64(v.data[0]) : null;
    },
    async signatures(address) {
      return (await call('getSignaturesForAddress', [address, { limit: 100, commitment: 'confirmed' }])) ?? [];
    },
    async transaction(signature) {
      const t = await call('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!t) return null;
      const m = t.transaction?.message;
      return { err: t.meta?.err ?? null, logs: t.meta?.logMessages ?? [], slot: t.slot, blockTime: t.blockTime ?? null,
        signatures: t.transaction?.signatures ?? [],
        message: m ? { accountKeys: m.accountKeys ?? [], numSigners: m.header?.numRequiredSignatures ?? 0, instructions: (m.instructions ?? []).map(i => ({ programIdIndex: i.programIdIndex, accounts: i.accounts ?? [], data: i.data })) } : null };
    },
    /** まだ着地しうる blockhash か（false なら、その blockhash の取引はもう着地しない）。 */
    async blockhashValid(blockhash) {
      return (await call('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]))?.value ?? null;
    },
  };
}

// ------------------------------------------------------------------ 口座の欄を、配置の表から名前で読む（fcodec が読めない型があるため）

const LAYOUT = Object.fromEntries(V2.accounts.map(a => [a.kind, a]));
const RECORD = Object.fromEntries(V2.records.map(r => [r.name, r]));
function readScalar(dv, o, ty) {
  switch (ty) {
    case 'u8': return dv.getUint8(o);
    case 'u16': return dv.getUint16(o, true);
    case 'i16': return dv.getInt16(o, true);
    case 'u32': return dv.getUint32(o, true);
    case 'i64': return dv.getBigInt64(o, true);
    case 'u64': return dv.getBigUint64(o, true);
    default: throw new Error(`型 ${ty} は読まない`);
  }
}
/** 口座の欄を名前で読む：{magic を確かめ、シーズンを確かめ、names の欄だけ}。読めなければ例外。 */
export function readAccount(kind, bytes, seasonId, names) {
  const L = LAYOUT[kind];
  if (!L || bytes.length !== L.size) throw new Error(`${kind}: ${bytes.length} B（${L?.size} B のはず）`);
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== L.magic) throw new Error(`${kind}: magic が違う`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getBigUint64(8, true) !== BigInt(seasonId)) throw new Error(`${kind}: シーズンが違う`);
  const out = {};
  for (const n of names) {
    const f = L.fields.find(x => x.name === n);
    if (!f) throw new Error(`${kind}: 欄 ${n} がない`);
    let m = /^\[u8;(\d+)\]$/.exec(f.ty);
    if (m) { out[n] = bytes.slice(f.off, f.off + Number(m[1])); continue; }
    m = /^\[(u16|i16|u32|i64|u64);(\d+)\]$/.exec(f.ty);
    if (m) { const w = { u16: 2, i16: 2, u32: 4, i64: 8, u64: 8 }[m[1]]; out[n] = Array.from({ length: Number(m[2]) }, (_, i) => readScalar(dv, f.off + i * w, m[1])); continue; }
    m = /^rec:(\w+) x(\d+)$/.exec(f.ty);
    if (m) {
      const r = RECORD[m[1]];
      const one = base => Object.fromEntries(r.fields.filter(x => x.ty !== 'rsv').map(x => [x.name, readScalar(dv, base + x.off, x.ty)]));
      out[n] = Number(m[2]) === 1 ? one(f.off) : Array.from({ length: Number(m[2]) }, (_, i) => one(f.off + i * r.size));
      continue;
    }
    out[n] = readScalar(dv, f.off, f.ty);
  }
  return out;
}

/** S1 の Caravan の STATE（frontier-abi v2 layout s1.rs）。 */
export const CARAVAN_STATE = Object.freeze({ 1: 'moving', 2: 'delivered', 3: 'lost' });

/**
 * 隊商の口座を読む（輸送中の隊商は口座がある。確定すると口座は閉じる：caravan.rs close_caravan）。
 * {status: 'found', ownerCitizen, ownerTag, seq, state, dst: {kind, p, q, at, gen}, cargo: [whole units]} か {status: 'absent'|'unverified', why}
 */
export async function caravanAccount(reader, season, caravan) {
  if (!reader) return { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' };
  const addr = seasonAddresses(season.programId, season.seasonId).of('Caravan', { ownerTag: BigInt(caravan.ownerTag), seq: caravan.seq });
  let bytes;
  try { bytes = await reader.account(addr); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (!bytes) return { status: 'absent', why: '隊商の口座がない（まだ載っていない、または確定して閉じた）', address: addr };
  try {
    const c = readAccount('Caravan', bytes, season.seasonId, ['OWNER_CITIZEN', 'OWNER_TAG', 'SEQ', 'STATE', 'DST', 'CARGO']);
    return {
      status: 'found', address: addr, ownerCitizen: pubkeyString(c.OWNER_CITIZEN), ownerTag: String(c.OWNER_TAG), seq: c.SEQ,
      state: CARAVAN_STATE[c.STATE] ?? `state ${c.STATE}`,
      dst: { kind: c.DST.KIND, p: c.DST.P, q: c.DST.Q, at: c.DST.SITE_OR_TILE, gen: c.DST.GEN },
      cargo: c.CARGO.map(m => Number((m > 0n ? m : 0n) / 1000n)),   // ミリ単位 → 整数（切り捨て）
    };
  } catch (e) { return { status: 'unverified', why: `隊商の口座が読めない：${e.message ?? e}` }; }
}

// ------------------------------------------------------------------ 取引の記録（PS2）から、隊商の確定・襲撃を読む

const PS2_PREFIX_B64 = 'UFMy';   // base64("PS2")：sol_log_data(["PS2", body]) の最初の欄

/**
 * 取引のログから、指定のプログラムが出した PS2 の記録だけを取り出す（ほかのプログラムの「Program data:」は捨てる）。
 * ログの並び：「Program <id> invoke [n]」…「Program <id> success|failed」。今どのプログラムの中かを積んで追う。
 */
export function programRecords(logs, programId) {
  const stack = [], out = [];
  for (const line of logs ?? []) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]); continue; }
    m = /^Program (\w+) (success|failed)/.exec(line);
    if (m) { if (stack.at(-1) === m[1]) stack.pop(); continue; }
    m = /^Program data: (\S+) (\S+)$/.exec(line);
    if (m && m[1] === PS2_PREFIX_B64 && stack.at(-1) === programId) {
      try { const r = decodeRecord(m[2]); if (r) out.push(r); } catch { /* 読めない記録は使わない */ }
    }
  }
  return out;
}

/** 8バイトの場所（log_place：kind u8, p i16, q i16, at u8, gen u8, tile u8）。flog は8バイトの欄を整数（BigInt）で返すので、バイトに戻して読む。 */
function placeOf(v) {
  const b = new Uint8Array(8), dv = new DataView(b.buffer);
  if (typeof v === 'bigint') dv.setBigUint64(0, v, true); else b.set(v.subarray(0, 8));
  return { kind: b[0], p: dv.getInt16(1, true), q: dv.getInt16(3, true), at: b[5], gen: b[6], tile: b[7] };
}
const cargoOfLog = b => Array.from({ length: 8 }, (_, i) => new DataView(b.buffer, b.byteOffset).getUint32(4 * i, true));

/**
 * 隊商の終わり方を、チェーンの取引の記録から読む（ヘラルドを通さない）。
 * 隊商の口座の住所に触れた取引を新しい順に読み、成功した取引の、このプログラムの CARAVAN_SETTLED（92）と CARAVAN_RAIDED（93）を探す。
 * {status: 'settled', outcome, dst, cargo, signature} / {status: 'raided', choice, raiderTag, signature} / {status: 'none'} / {status: 'unverified', why}
 * 襲撃のあとに確定した隊商は、両方を返す（raided を先に見る）。
 */
export async function caravanEndFromChain(reader, season, caravan) {
  const h = await caravanHistory(reader, season, caravan);
  if (h.status !== 'ok') return h;
  if (!h.settled && !h.raided) return { status: 'none', why: 'この隊商の確定・襲撃の記録はまだない' };
  return { status: h.raided ? 'raided' : 'settled', settled: h.settled, raided: h.raided };
}

/**
 * 隊商の口座の住所に触れた、このプログラムの成功した取引の記録を集める。
 * {status: 'ok', sent: 最初の CARAVAN_SENT（元の送信。奪われた後の CARAVAN_SENT は同じ鍵なので、いちばん古いもの）, settled, raided} か {status: 'unverified', why}
 */
export async function caravanHistory(reader, season, caravan) {
  if (!reader?.signatures || !reader?.transaction) return { status: 'unverified', why: 'チェーンの取引を読めない（板に --rpc がない）' };
  const A = seasonAddresses(season.programId, season.seasonId);
  const addr = A.of('Caravan', { ownerTag: BigInt(caravan.ownerTag), seq: caravan.seq });
  const tag = BigInt(caravan.ownerTag);
  let sigs;
  try { sigs = await reader.signatures(addr); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  const found = { settled: null, raided: null, sent: null };
  for (const s of sigs) {
    if (s.err) continue;
    let t;
    try { t = await reader.transaction(s.signature); } catch (e) { return { status: 'unverified', why: `取引を読めない：${e.message ?? e}` }; }
    if (!t || t.err) continue;
    for (const r of programRecords(t.logs, A.programId)) {
      if (r.owner_tag !== tag || r.seq !== caravan.seq) continue;
      if (r.name === 'CARAVAN_SETTLED' && !found.settled) found.settled = { outcome: r.outcome, dst: placeOf(r.dst), cargo: cargoOfLog(r.cargo), signature: s.signature };
      if (r.name === 'CARAVAN_RAIDED' && !found.raided) found.raided = { choice: r.choice, raiderTag: String(r.raider_tag), signature: s.signature };
      if (r.name === 'CARAVAN_SENT') {
        const x = { dst: placeOf(r.dst), cargo: cargoOfLog(r.cargo), signature: s.signature, slot: t.slot, blockTime: t.blockTime };
        if (!found.sent || (t.slot ?? 0) < (found.sent.slot ?? 0)) found.sent = x;   // いちばん古い送信（元の送り主の送信）
      }
    }
  }
  return { status: 'ok', ...found };
}

/**
 * 自分が送った取引を見つけ、その中身が計画（＝依頼）と一致するかを確かめる。
 * ④ STATE-MACHINE「別の送信経路と owner の連番」：(owner, seq) が一致するだけでは自分の送信とみなさない。
 *
 *   plan：{wallet, programId, caravan: {ownerTag, seq}, src: {p,q,site,gen}, dst: {p,q,site,gen}, cargo: [8]（整数単位）, srcAddress}
 *   ev：{signature?（取引の署名＝手数料の鍵の署名）, walletSig?（送る人のウォレットの署名。sending の記録にある）, blockhash?}
 *
 * 取引は、署名で直接読むか、隊商の口座の住所に触れた取引の中からウォレットの署名を含むものを探す。見つけたら、次をすべて確かめる：
 *   - 取引が成功している（失敗なら 'failed'：在庫不足・番号の不一致などをプログラムが断った）
 *   - 送る人のウォレットが署名者で、署名が取引に入っている
 *   - 対象のプログラムの命令が SendCaravan で、番号・届け先（p, q, 村, 世代）・荷（8資源の整数、経路の目減りの前）が計画と同じ
 *   - 命令の口座に、計画の送り元の村と隊商の口座がある
 *   - このプログラムの CARAVAN_SENT の記録の送り元・届け先が計画と同じで、荷が計画以下（経路の塔の目減り）
 * 一つでも違えば 'mismatch'（理由つき）。見つからなければ、blockhash が切れていれば 'expired'（もう着地しない。送り直してよい）、
 * 番号が進んでいれば 'seq-taken'、どちらでもなければ 'unknown'（送り直さない）。
 */
export async function sendOutcome(reader, season, plan, ev = {}) {
  if (!reader?.transaction) return { status: 'unknown', why: 'チェーンを読めない' };
  const evidence = typeof ev === 'string' || ev === null ? { signature: ev } : ev;
  const A = seasonAddresses(season.programId, season.seasonId);
  const caravanAddr = A.of('Caravan', { ownerTag: BigInt(plan.caravan.ownerTag), seq: plan.caravan.seq });
  let t = null;
  try {
    if (evidence.signature) t = await reader.transaction(evidence.signature);
    if (!t && evidence.walletSig && reader.signatures) {
      for (const s of await reader.signatures(caravanAddr)) {
        const x = await reader.transaction(s.signature);
        if (x?.signatures?.includes(evidence.walletSig)) { t = x; break; }
      }
    }
  } catch (e) { return { status: 'unknown', why: `取引を読めない：${e.message ?? e}` }; }
  if (t) {
    if (t.err) return { status: 'failed', why: `プログラムが断った：${JSON.stringify(t.err)}`, slot: t.slot };
    const why = txMismatch(t, A, plan, caravanAddr, evidence);
    if (why) return { status: 'mismatch', why };
    const r = programRecords(t.logs, A.programId).find(x => x.name === 'CARAVAN_SENT' && x.owner_tag === BigInt(plan.caravan.ownerTag) && x.seq === plan.caravan.seq);
    return { status: 'landed', slot: t.slot, blockTime: t.blockTime, cargoLogged: cargoOfLog(r.cargo) };
  }
  if (evidence.blockhash && reader.blockhashValid) {
    try { if (await reader.blockhashValid(evidence.blockhash) === false) return { status: 'expired', why: 'この取引の blockhash は切れた。もう着地しないので、送り直してよい' }; } catch { /* 分からない */ }
  }
  const me = await citizenOf(reader, season, plan.wallet);
  if (me.caravans !== undefined && Number(me.caravans) > plan.caravan.seq) return { status: 'seq-taken', why: `自分の取引は見えないが、隊商の番号は ${me.caravans} まで進んだ（番号 #${plan.caravan.seq} は別の送信が使った可能性）` };
  return { status: 'unknown', why: '自分の取引も、blockhash の期限切れも、番号の進みも見えない（まだ着地していない可能性がある）' };
}

/** 取引の中身が計画と一致しないなら理由。命令（口座・データ）と、記録（CARAVAN_SENT）の両方を見る。 */
function txMismatch(t, A, plan, caravanAddr, evidence) {
  const m = t.message;
  if (!m) return '取引の中身（message）を読めない';
  const keys = m.accountKeys;
  const signerAt = keys.indexOf(plan.wallet);
  if (signerAt < 0 || signerAt >= m.numSigners) return '送る人のウォレットが、この取引の署名者ではない';
  if (evidence.walletSig && t.signatures[signerAt] !== evidence.walletSig) return 'この取引のウォレットの署名が、記録した署名と違う';
  const ixs = m.instructions.filter(i => keys[i.programIdIndex] === A.programId);
  if (ixs.length !== 1) return `対象のプログラムの命令が ${ixs.length} 個（1個のはず）`;
  let d;
  try { d = decodeIxData(fromBase58(ixs[0].data), 3); } catch (e) { return `命令を読めない：${e.message ?? e}`; }
  if (d.name !== 'SendCaravan') return `命令が SendCaravan ではない（${d.name}）`;
  if (Number(d.seq) !== plan.caravan.seq) return `番号が違う（${d.seq}、計画 ${plan.caravan.seq}）`;
  if (Number(d.dst_kind) !== 1 || Number(d.dst_p) !== plan.dst.p || Number(d.dst_q) !== plan.dst.q || Number(d.dst_at) !== plan.dst.site || Number(d.dst_gen) !== plan.dst.gen) return '命令の届け先が計画と違う';
  const cargo = Array.from({ length: 8 }, (_, i) => new DataView(d.cargo.buffer, d.cargo.byteOffset).getUint32(4 * i, true));
  if (cargo.some((v, i) => v !== (plan.cargo[i] ?? 0))) return `命令の荷が計画と違う（${cargo.join(',')}）`;
  const ixKeys = ixs[0].accounts.map(i => keys[i]);
  if (!ixKeys.includes(caravanAddr)) return '命令の口座に、計画の隊商の口座がない';
  const srcAddr = A.of('Holding', { p: plan.src.p, q: plan.src.q, site: plan.src.site });
  if (!ixKeys.includes(srcAddr)) return '命令の口座に、計画の送り元の村がない';
  const r = programRecords(t.logs, A.programId).find(x => x.name === 'CARAVAN_SENT' && x.owner_tag === BigInt(plan.caravan.ownerTag) && x.seq === plan.caravan.seq);
  if (!r) return 'このプログラムの CARAVAN_SENT の記録がない';
  const rs = placeOf(r.src), rd = placeOf(r.dst), rc = cargoOfLog(r.cargo);
  if (rs.p !== plan.src.p || rs.q !== plan.src.q || rs.at !== plan.src.site || rs.gen !== plan.src.gen) return '記録の送り元が計画と違う';
  if (rd.kind !== 1 || rd.p !== plan.dst.p || rd.q !== plan.dst.q || rd.at !== plan.dst.site || rd.gen !== plan.dst.gen) return '記録の届け先が計画と違う';
  if (rc.some((v, i) => v > (plan.cargo[i] ?? 0))) return '記録の荷が計画より多い';
  return null;
}

/**
 * シーズンの規則の版（Season の口座の RULESET_HASH・PROGRAM_VERSION）。到着時の受取人を世代から決める規則は、
 * この版のプログラムのコードで確かめたもの（goal.mjs RECIPIENT_RULE）。{status: 'verified', rulesetHash, programVersion} か {status: 'unverified', why}
 */
export async function seasonRules(reader, season) {
  if (!reader) return { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' };
  const A = seasonAddresses(season.programId, season.seasonId);
  let bytes;
  try { bytes = await reader.account(A.season); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (!bytes) return { status: 'unverified', why: 'シーズンの口座がない' };
  try {
    const x = readAccount('Season', bytes, season.seasonId, ['RULESET_HASH', 'PROGRAM_VERSION']);
    return { status: 'verified', rulesetHash: Array.from(x.RULESET_HASH, b => b.toString(16).padStart(2, '0')).join(''), programVersion: x.PROGRAM_VERSION };
  } catch (e) { return { status: 'unverified', why: `シーズンの口座が読めない：${e.message ?? e}` }; }
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
  // 国から追放されている間は、その国の一員として数えない（nation.rs：EXPELLED_SINCE、村には FLAG_EXPELLED）
  if (c.expelledSince && c.expelledSince !== 0n) return { status: 'unverified', why: `国（${c.faction + 1}）から追放されている`, expelled: true, faction: c.faction, caravans: c.caravans };
  return { status: 'verified', faction: c.faction, citizen, caravans: c.caravans, holdings: c.holding, holdingsN: c.holdingsN };
}

/**
 * 村の今の口座：{status: 'found', gen, ownerCitizen, faction} か {status: 'unverified', why}。
 * 「今の持ち主」であって、過去の到着時の持ち主ではない（到着時の受取人は goal.mjs recipientOf で世代と合わせて決める）。
 */
export async function holdingNow(reader, season, place) {
  if (!reader) return { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' };
  const A = seasonAddresses(season.programId, season.seasonId);
  let bytes;
  try { bytes = await reader.account(A.of('Holding', { p: place.p, q: place.q, site: place.site })); } catch (e) { return { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (!bytes) return { status: 'unverified', why: '村の口座がない' };
  try {
    const h = decode('Holding', bytes, { seasonId: season.seasonId });
    return { status: 'found', gen: h.gen, ownerCitizen: toBase58(h.ownerCitizen), faction: h.faction };
  } catch (e) { return { status: 'unverified', why: `村の口座が読めない：${e.code ?? e.message}` }; }
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
