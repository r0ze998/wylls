// RESEARCH — world goal ② "world-first technology" (owner r0ze 2026-11-25 08:56 JST: every Q-RS-1..10 recommendation of
// plan docs/design/win-conditions/02-research-plan.ja.md). The ONE builder the page (flocalplay-act.mjs, the wallet
// signs), the relay (gateway local-play-act.mjs, which rebuilds the stated intent byte for byte), the operator AI and the
// judge (gateway world-research.mjs) use, and the read-only views of the two research records.
//
// Source of truth: permutation-rules frontier/research.rs (the table, the V1 numbers, the village mask, the effects),
// frontier-abi world_index/research.rs (records, receipts), wide_ix.rs (wire), permutation-frontier proc/wide_research.rs.
//
//   pledge    [actor s] [payer s,w] [season r] [citizen w] [village w] [research world w] [nation research w]
//             data 0xDA ‖ 0xFF ‖ 0x01 ‖ 0x08 ‖ tech u8 ‖ amount u32 LE (whole science)
//   apply     [payer s,w] [season r] [research world r] [nation research r] [village w] [owner citizen w]
//             data 0xDC ‖ 0xFF ‖ 0x01 ‖ 0x10
//   settle    [payer s,w] [season r] [research world w] [nation research w]      data 0xDC ‖ 0xFF ‖ 0x01 ‖ 0x0F ‖ tech u8
//   start     [authority s,w] [season r] [research world w] [nation research w] × 6 [system]
//             data 0xDB ‖ 0xFF ‖ 0x01 ‖ 0x01 ‖ rule u8 ‖ start bell u32 LE      (the Season authority only)
//   addresses with_seed(season, 'we' ‖ hex(sha256('PSF-RESEARCH-WORLD-v1')[..15]), program),
//             with_seed(season, 'wk' ‖ hex(sha256('PSF-RESEARCH-NATION-v1' ‖ faction)[..15]), program)
import { seasonAddresses, withSeed } from './faddr.mjs';
import { wideHoldingAddress } from './fwide.mjs';
import { ringPosition } from './map/wide.mjs';
import { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const RESEARCH_PLEDGE = 'ResearchPledge';
export const RESEARCH_APPLY = 'ResearchApply';
export const RESEARCH_ACTS = Object.freeze([RESEARCH_PLEDGE, RESEARCH_APPLY]);
export const RESEARCH_WORLD_BYTES = 256, NATION_RESEARCH_BYTES = 384;
/** The CU limit: the runtime's ceiling, as the territory claim (not measured on the SBF build yet). */
export const RESEARCH_CU = 1_400_000;
export const NO_BELL = 0xffffffff;
export const NATIONS = 6;
export const TECH_COUNT = 12;
const SYSTEM = '11111111111111111111111111111111';

const b = t => 1 << t;
/** The table (design 01 §5.2; ids are stored — never renumber). `effect` keys the card's text (lang tables). */
export const TECHS = Object.freeze([
  { id: 0, key: 'agriculture', era: 1, prereq: 0 },
  { id: 1, key: 'masonry', era: 1, prereq: 0 },
  { id: 2, key: 'bronze', era: 1, prereq: 0 },
  { id: 3, key: 'roads', era: 1, prereq: 0 },
  { id: 4, key: 'writing', era: 2, prereq: b(0) },
  { id: 5, key: 'wallcraft', era: 2, prereq: b(1) },
  { id: 6, key: 'iron', era: 2, prereq: b(2) },
  { id: 7, key: 'cartography', era: 2, prereq: b(3) },
  { id: 8, key: 'currency', era: 3, prereq: b(4) },
  { id: 9, key: 'fortification', era: 3, prereq: b(5) | b(6) },
  { id: 10, key: 'navigation', era: 3, prereq: b(7) },
  { id: 11, key: 'administration', era: 3, prereq: b(4) },
].map(Object.freeze));

/**
 * The numbers of research rule V1 (permutation-rules RESEARCH_V1, owner 2026-11-25 08:56): costs 300 / 800 / 2,000 by era
 * (Q-RS-7 (a)); −20 % per other nation that knows the tech, at most 3 (Q-RS-5 (a): the count at each pledge); no
 * headcount factor (Q-RS-4 (a)); the world's era steps when a nation knows 3 techs of it; V1 opens era 1 only (Q-RS-6
 * (a)); only science made after the start counts (Q-RS-3 (b)); 1 point per 10 science (Q-RS-10 (d)). Effects in bps:
 * agriculture food +10 %, masonry build time −10 %, bronze training ore −10 %, roads travel −5 % (NOT WIRED YET:
 * `roadsEffectLive` false — Q-RI-1).
 */
export const RESEARCH_V1 = Object.freeze({
  eraCost: Object.freeze([300, 800, 2000]),
  discountBpsPerNation: 2000,
  discountMaxNations: 3,
  techsToAdvance: 3,
  openEras: 1,
  pledgeAfterStartOnly: true,
  agricultureFoodBps: 1000,
  masonryBuildBps: 1000,
  bronzeOreBps: 1000,
  roadsTravelBps: 500,
  roadsEffectLive: false,
  sciencePerPoint: 10,
});

/** The cost of tech `t` when `others` other nations know it (rounded up), or null. */
export function costV1(t, others) {
  const tc = TECHS[t];
  if (!tc) return null;
  const base = RESEARCH_V1.eraCost[tc.era - 1];
  const k = Math.min(Math.max(0, others | 0), RESEARCH_V1.discountMaxNations);
  const keep = Math.max(0, 10_000 - RESEARCH_V1.discountBpsPerNation * k);
  return Math.ceil((base * keep) / 10_000);
}

/** Why tech `t` cannot be pledged by a nation knowing `known` in world era `era` (the program's order), or null. */
export function refusalOf(t, era, known) {
  const tc = TECHS[t];
  if (!tc) return 'UnknownTech';
  if (tc.era > era || tc.era > RESEARCH_V1.openEras) return 'EraClosed';
  if ((known & tc.prereq) !== tc.prereq) return 'Prereq';
  if (known & b(t)) return 'Known';
  return null;
}

/** The world's era after a nation that knows `known` learned (the kernel's era_after). */
export function eraAfter(era, known) {
  if (era >= 3) return era;
  const n = TECHS.filter(t => t.era === era && (known & b(t.id))).length;
  return n >= RESEARCH_V1.techsToAdvance ? era + 1 : era;
}

/** Village mask (Holding RSV_1258): techs bits 0–11, nation + 1 bits 12–14, the banked-science cut bit 15. */
export const HOLDING_RESEARCH_OFFSET = 1258;
export function villageMaskOf(holdingBytes) {
  if (!(holdingBytes instanceof Uint8Array) || holdingBytes.length < HOLDING_RESEARCH_OFFSET + 2) return null;
  const m = holdingBytes[HOLDING_RESEARCH_OFFSET] | (holdingBytes[HOLDING_RESEARCH_OFFSET + 1] << 8);
  const f = (m >> 12) & 7;
  return { techs: m & 0x0fff, nation: f === 0 || f > 6 ? null : f - 1, rebased: (m & 0x8000) !== 0 };
}
/** The techs in effect for a village of `faction` (gated by the stored nation: a captured village plays without them). */
export const effectiveTechs = (mask, faction) => (mask && mask.nation === faction ? mask.techs : 0);

/** Masonry: a build's seconds (rounded down); bronze: a training cost's ore (milli, rounded down); agriculture: food. */
export const buildSecsWith = (techs, secs) => (techs & b(1) ? Math.floor((secs * (10_000 - RESEARCH_V1.masonryBuildBps)) / 10_000) : secs);
export const trainOreWith = (techs, ore) => (techs & b(2) ? Math.floor((ore * (10_000 - RESEARCH_V1.bronzeOreBps)) / 10_000) : ore);
export const foodRateWith = (techs, prod) => (techs & b(0) ? prod + Math.floor((prod * RESEARCH_V1.agricultureFoodBps) / 10_000) : prod);

// ---------------------------------------------------------------- addresses

export const researchWorldSeed = () => 'we' + toHex(sha256(utf8('PSF-RESEARCH-WORLD-v1')).slice(0, 15));
export const nationResearchSeed = f => 'wk' + toHex(sha256(utf8('PSF-RESEARCH-NATION-v1'), Uint8Array.of(f)).slice(0, 15));
export const researchWorldAddress = (seasonAddress, programId) => withSeed(seasonAddress, researchWorldSeed(), programId);
export const nationResearchAddress = (seasonAddress, programId, f) => withSeed(seasonAddress, nationResearchSeed(f), programId);

// ---------------------------------------------------------------- intents and instructions

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const wideText = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(v);

/** A village of the subject: `{holding: {p, q, site}}` (the first home, a legacy village) or `{wide: {p, q, site}}` (decimal strings). */
function villageOf(subject, code) {
  if (Object.hasOwn(subject ?? {}, 'wide')) {
    const w = subject.wide;
    check(exactKeys(w, ['p', 'q', 'site']) && wideText(w.p) && wideText(w.q) && int(w.site, 0, 11), code);
    let r; try { r = ringPosition(BigInt(w.p), BigInt(w.q)).ring; } catch { fail(code); }
    check(r > 128n, code);
    return { wide: Object.freeze({ p: w.p, q: w.q, site: w.site }) };
  }
  const h = subject?.holding;
  check(exactKeys(h, ['p', 'q', 'site']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), code);
  let r; try { r = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail(code); }
  check(r <= 128n, 'LocalActWideHolding');
  return { holding: Object.freeze({ p: h.p, q: h.q, site: h.site }) };
}

/** The checked pledge intent `{name: 'ResearchPledge', subject: {holding | wide}, fields: {tech, amount}}`. Throws a code. */
export function researchPledgeIntent(subject, fields, code = 'LocalActShape') {
  check(subject !== null && typeof subject === 'object' && Object.keys(subject).length === 1, code);
  const v = villageOf(subject, code);
  check(exactKeys(fields, ['tech', 'amount']) && int(fields.tech, 0, TECH_COUNT - 1) && int(fields.amount, 1, 0xffffffff), code);
  return Object.freeze({ name: RESEARCH_PLEDGE, subject: Object.freeze(v), fields: Object.freeze({ tech: fields.tech, amount: fields.amount }) });
}

/** The checked apply intent `{name: 'ResearchApply', subject: {holding | wide}, fields: {}}` (the wallet's own village). */
export function researchApplyIntent(subject, fields, code = 'LocalActShape') {
  check(subject !== null && typeof subject === 'object' && Object.keys(subject).length === 1 && exactKeys(fields ?? {}, []), code);
  return Object.freeze({ name: RESEARCH_APPLY, subject: Object.freeze(villageOf(subject, code)), fields: Object.freeze({}) });
}

const villageAddress = (A, programId, s) => (s.wide ? wideHoldingAddress(A.season, programId, BigInt(s.wide.p), BigInt(s.wide.q), s.wide.site) : A.of('Holding', s.holding));

/** The 0xDA op 8 instruction of a pledge intent for `wallet` (actor and payer) of nation `faction`. */
export function researchPledgeInstruction(intent, { programId, seasonId, wallet, faction }) {
  check(int(faction, 0, NATIONS - 1), 'LocalActShape');
  const A = seasonAddresses(programId, String(seasonId));
  const keys = [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: A.of('Citizen', { wallet }), isSigner: false, isWritable: true },
    { pubkey: villageAddress(A, programId, intent.subject), isSigner: false, isWritable: true },
    { pubkey: researchWorldAddress(A.season, programId), isSigner: false, isWritable: true },
    { pubkey: nationResearchAddress(A.season, programId, faction), isSigner: false, isWritable: true },
  ];
  const data = new Uint8Array(9), dv = new DataView(data.buffer);
  data.set([0xda, 0xff, 0x01, 0x08]); data[4] = intent.fields.tech; dv.setUint32(5, intent.fields.amount, true);
  return { programId, keys, data };
}

/** The 0xDC op 16 instruction (anyone pays; the village's owner Citizen is `ownerWallet`'s). */
export function researchApplyInstruction(intent, { programId, seasonId, wallet, ownerWallet = wallet, faction }) {
  check(int(faction, 0, NATIONS - 1), 'LocalActShape');
  const A = seasonAddresses(programId, String(seasonId));
  const keys = [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: researchWorldAddress(A.season, programId), isSigner: false, isWritable: false },
    { pubkey: nationResearchAddress(A.season, programId, faction), isSigner: false, isWritable: false },
    { pubkey: villageAddress(A, programId, intent.subject), isSigner: false, isWritable: true },
    { pubkey: A.of('Citizen', { wallet: ownerWallet }), isSigner: false, isWritable: true },
  ];
  return { programId, keys, data: Uint8Array.of(0xdc, 0xff, 0x01, 0x10) };
}

/** The 0xDC op 15 instruction (anyone). */
export function researchSettleInstruction({ programId, seasonId, wallet, faction, tech }) {
  const A = seasonAddresses(programId, String(seasonId));
  return { programId, data: Uint8Array.of(0xdc, 0xff, 0x01, 0x0f, tech), keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: researchWorldAddress(A.season, programId), isSigner: false, isWritable: true },
    { pubkey: nationResearchAddress(A.season, programId, faction), isSigner: false, isWritable: true },
  ] };
}

/** The 0xDB op 1 instruction (the Season authority). */
export function startResearchInstruction({ programId, seasonId, authority, rule = 1, startBell }) {
  const A = seasonAddresses(programId, String(seasonId));
  const data = new Uint8Array(9), dv = new DataView(data.buffer);
  data.set([0xdb, 0xff, 0x01, 0x01]); data[4] = rule; dv.setUint32(5, startBell, true);
  return { programId, data, keys: [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: researchWorldAddress(A.season, programId), isSigner: false, isWritable: true },
    ...Array.from({ length: NATIONS }, (_, f) => ({ pubkey: nationResearchAddress(A.season, programId, f), isSigner: false, isWritable: true })),
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ] };
}

/** The whole message of a pledge or an apply intent (the wallet as fee payer). */
export function researchMessage(intent, { programId, seasonId, wallet, faction, blockhash, loadedLimit }) {
  const ix = intent.name === RESEARCH_PLEDGE ? researchPledgeInstruction(intent, { programId, seasonId, wallet, faction })
    : intent.name === RESEARCH_APPLY ? researchApplyInstruction(intent, { programId, seasonId, wallet, faction }) : fail('LocalActNotAllowed');
  const prefix = [setComputeUnitLimit(RESEARCH_CU), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit)];
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, ix] }));
}

// ---------------------------------------------------------------- records (read-only views)

const u32 = (x, o) => new DataView(x.buffer, x.byteOffset).getUint32(o, true);
const u16 = (x, o) => new DataView(x.buffer, x.byteOffset).getUint16(o, true);
const u64 = (x, o) => new DataView(x.buffer, x.byteOffset).getBigUint64(o, true);
const i64 = (x, o) => new DataView(x.buffer, x.byteOffset).getBigInt64(o, true);
const magic = (x, m) => [...m].every((c, i) => x[i] === c.charCodeAt(0));
const bell = v => (v === NO_BELL ? null : v);
const nationsOf = mask => Array.from({ length: NATIONS }, (_, n) => n).filter(n => mask & (1 << n));

/** The world's research record (256 B, 'PSFXWRW1') → its view, or null. */
export function decodeResearchWorld(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== RESEARCH_WORLD_BYTES || !magic(bytes, 'PSFXWRW1')) return null;
  const techs = [];
  for (let t = 0; t < TECH_COUNT; t++) techs.push({ id: t, firstBell: bell(u32(bytes, 80 + 4 * t)), firstNations: nationsOf(bytes[144 + t]), knownBy: nationsOf(bytes[160 + t]) });
  return {
    rule: bytes[18], paused: bytes[19] === 1, startBell: u32(bytes, 52), era: bytes[56], startTs: Number(i64(bytes, 60)),
    eraBell: [0, 1, 2].map(i => bell(u32(bytes, 68 + 4 * i))), learned: u32(bytes, 208), techs,
  };
}

/** A nation's research record (384 B, 'PSFXWRN1') → its view, or null. */
export function decodeNationResearch(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== NATION_RESEARCH_BYTES || !magic(bytes, 'PSFXWRN1')) return null;
  const known = u16(bytes, 52), techs = [];
  for (let t = 0; t < TECH_COUNT; t++) techs.push({ id: t, known: (known & b(t)) !== 0, pledged: u32(bytes, 56 + 4 * t), firstPledgeBell: bell(u32(bytes, 120 + 4 * t)), learnedBell: bell(u32(bytes, 184 + 4 * t)) });
  return { rule: bytes[18], nation: bytes[19], known, techs, total: Number(u64(bytes, 248)), pledges: u32(bytes, 256) };
}

/** A research receipt (`Program data:` base64 of 'PSR1' ‖ 57 bytes) → its fields, or null. */
export const RECEIPT_KINDS = Object.freeze({ 1: 'pledge', 2: 'learn', 3: 'era', 4: 'start', 5: 'pause' });
export function decodeResearchReceipt(parts) {
  // `parts`: the sol_log_data fields as Uint8Arrays (the log line is 'Program data: <b64 PSR1> <b64 body>')
  if (!Array.isArray(parts) || parts.length !== 2 || !magic(parts[0], 'PSR1') || parts[0].length !== 4 || parts[1].length !== 57) return null;
  const x = parts[1];
  if (x.subarray(53).some(v => v !== 0) || !RECEIPT_KINDS[x[0]]) return null;
  return { kind: RECEIPT_KINDS[x[0]], tech: x[1], nation: x[2], first: (x[3] & 1) === 1, flags: x[3], bell: u32(x, 4), citizen: x.slice(8, 40), amount: u32(x, 40), total: u32(x, 44), cost: u32(x, 48), era: x[52] };
}
