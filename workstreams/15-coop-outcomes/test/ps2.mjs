// Test helper: PS2 record bodies laid out from the ABI's generated log tables (as adapter-s1.test.mjs does), served as
// the herald's `/h/events` rows and decoded by the page's own decoder. No chain is run; no key.
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { KINDS as M1_KINDS, decodePage } from '../../../permutation-server/web/frontier/flog.mjs';

const spec = Object.fromEntries([
  ...LOGS.kinds.map(k => [k.name, { kind: k.kind, fields: [...k.key, ...k.payload].map(f => [f.name, f.len]) }]),
  ...Object.entries(M1_KINDS).map(([kind, k]) => [k.name, { kind: Number(kind), fields: [...k.key, ...k.payload] }]),
]);

export function le(v, n) {
  let x = BigInt(v);
  if (x < 0n) x += 1n << BigInt(8 * n);
  return Array.from({ length: n }, () => { const b = Number(x & 0xffn); x >>= 8n; return b; });
}
/** One PS2 body (`version ‖ kind ‖ bell u32 ‖ key ‖ payload`, no tail) as base64. */
export function body(name, bell, fields = {}) {
  const k = spec[name];
  if (!k) throw new Error(`no log kind ${name}`);
  const parts = [1, k.kind, ...le(bell, 4)];
  for (const [f, len] of k.fields) {
    const v = fields[f] ?? 0;
    parts.push(...(v instanceof Uint8Array ? [...v] : le(v, len)));
  }
  return Buffer.from(parts).toString('base64');
}
/** 8 u32 LE amounts (food, wood, stone, ore, arms(horses), gold, …). */
export const cargo = a => { const b = new Uint8Array(32); const dv = new DataView(b.buffer); a.forEach((q, i) => dv.setUint32(4 * i, q, true)); return b; };
/** A logged place as its u64 value: `kind u8 ‖ p i16 ‖ q i16 ‖ site u8 ‖ gen u8 ‖ tile u8`. */
export const place = (kind, p, q, site = 0, gen = 0) => BigInt.asUintN(64, BigInt(kind) | (BigInt(p & 0xffff) << 8n) | (BigInt(q & 0xffff) << 24n) | (BigInt(site) << 40n) | (BigInt(gen) << 48n));

/** `[[name, bell, fields]…]` → herald `/h/events` rows numbered from `from` (`{seq, slot, sig, kind, bell, body_b64}`). */
export const heraldRows = (list, from = 1) => list.map(([name, bell, fields], i) => ({ seq: String(from + i), slot: 100 + i, sig: `sig${from + i}`, kind: spec[name].kind, bell, body_b64: body(name, bell, fields) }));

/** Herald rows → the rows live.mjs reads (`{seq, bell, sig, record}`; `bad` when a body does not decode). */
export function decodeRows(rows) {
  return rows.map(r => {
    const d = decodePage([r]);
    return d.bad ? { seq: String(r.seq), bad: true } : { seq: String(r.seq), bell: r.bell, sig: r.sig, record: d.records[0]?.record ?? null };
  });
}

/**
 * A small live world: nation 1's lord (tag 11) sends wood and stone to a village; nation 2's lord (tag 21) raids it and
 * takes 120 wood and 30 stone; a domestic raid by tag 12 (nation 1) of tag 11's second caravan; a record the page does
 * not read (HARVEST) in between; nation 5's lord (tag 52, known from its storehouse) takes 110 stone from nation 3's.
 * Tag 21's nation comes from its JOIN (wallet SAMPLE_WALLET → tag 21 through `sampleTagOf`).
 */
export const SAMPLE_WALLET = new Uint8Array(32).fill(0x21);
export const sampleTagOf = w => (w instanceof Uint8Array && w.length === 32 && w.every(b => b === 0x21) ? '21' : null);
export function sampleWorld() {
  const V = place(1, 4, -2, 3, 1);
  return [
    ['JOIN', 1, { wallet: SAMPLE_WALLET, faction: 2 }],
    ['CARAVAN_SENT', 10, { owner_tag: 11, seq: 0, faction: 1, dst: V, cargo: cargo([0, 150, 60]) }],
    ['HARVEST', 11, { p: 4, q: -2, site: 3 }],
    ['CARAVAN_RAIDED', 14, { bell: 14, owner_tag: 11, seq: 0, raider_tag: 21, choice: 0, taken: cargo([0, 120, 30]), dst: V, domestic: 0 }],
    ['CARAVAN_SENT', 20, { owner_tag: 11, seq: 1, faction: 1, dst: V, cargo: cargo([0, 200]) }],
    ['CARAVAN_RAIDED', 25, { bell: 25, owner_tag: 11, seq: 1, raider_tag: 12, choice: 0, taken: cargo([0, 200]), dst: V, domestic: 1 }],
    ['CARAVAN_SENT', 30, { owner_tag: 31, seq: 0, faction: 3, dst: V, cargo: cargo([0, 40]) }],
    ['CARAVAN_SETTLED', 36, { owner_tag: 31, seq: 0, outcome: 0, dst: V, cargo: cargo([0, 40]) }],
    ['VAULT_BUILT', 38, { p: 9, q: 9, tile: 2, owner_tag: 52, faction: 5 }],
    ['CARAVAN_SENT', 40, { owner_tag: 31, seq: 1, faction: 3, dst: V, cargo: cargo([0, 0, 150]) }],
    ['CARAVAN_RAIDED', 44, { bell: 44, owner_tag: 31, seq: 1, raider_tag: 52, choice: 0, taken: cargo([0, 0, 110]), dst: V, domestic: 0 }],
  ];
}
