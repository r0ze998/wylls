// The deal (contract §2.3): which persona, creed variant and temperament jitter each AI slot gets,
// from the 32-byte seed of the public GENESIS_SEED record. Pure, deterministic, no I/O besides the pinned files.
//
//   deal(seed32, deck, slots) -> [{index, faction, persona, creed_variant, temperament}]  (sorted by index)
//
// For nation f: its AI slots sorted by index; D = the deck (persona ids); Fisher-Yates from the last
// position: for i = |D|-1 down to 1, j = u64_le(sha256("wylls-ai-deal/v1" ‖ seed ‖ u8 f ‖ u8 i)[0..8]) mod (i+1),
// swap D[i], D[j]; slot k of the nation gets D[k]. Per AI (index u32 LE): creed variant
// = sha256("wylls-ai-creed/v1" ‖ seed ‖ index)[0] mod 6; jitter of trait t (u8 0..6) =
// (sha256("wylls-ai-jitter/v1" ‖ seed ‖ index ‖ u8 t)[0] mod 21) - 10, applied with clamp 0..100.
// Every nation receives the same multiset (W5, R8): a nation whose AI slots do not number |D| is an error.
//
//   node permutation-gateway/citizens/persona/deal.mjs --vectors [--write]
// prints (or writes to test/fixtures/ai-deal-v1.json) the test vectors; citizens-persona.test.mjs checks freshness.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const u8 = n => Buffer.from([n & 0xff]);
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const text = s => Buffer.from(s, 'utf8');

export const LIBRARY_URL = new URL('library.json', HERE);
export const LIBRARY = JSON.parse(readFileSync(LIBRARY_URL, 'utf8'));
export const TRAITS = LIBRARY.temperament_order;
export const CREED_VARIANTS = 6;
export const personaById = id => LIBRARY.personas.find(p => p.id === id) ?? null;
export const loadDeck = id => JSON.parse(readFileSync(new URL(`decks/${id}.json`, HERE), 'utf8'));
export const fileSha256 = url => createHash('sha256').update(readFileSync(url)).digest('hex');
/** sha256 of library.json: the hash the commitments pin (§2.2). */
export const libraryHash = () => fileSha256(LIBRARY_URL);

const seedBytes = s => {
  const b = typeof s === 'string' ? Buffer.from(s, 'hex') : Buffer.from(s);
  if (b.length !== 32) throw new TypeError('deal: the genesis seed must be 32 bytes');
  return b;
};

export class DealError extends Error {}

export function deal(seed32, deck, slots) {
  const seed = seedBytes(seed32);
  const ids = Array.isArray(deck) ? deck : deck.personas;
  for (const id of ids) if (!personaById(id)) throw new DealError(`unknown persona ${id}`);
  const all = (Array.isArray(slots) ? slots : slots.slots).filter(s => s.kind === 'ai');
  const byNation = new Map();
  for (const s of all) (byNation.get(s.faction) ?? byNation.set(s.faction, []).get(s.faction)).push(s);
  const out = [];
  for (const [f, list] of [...byNation].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.index - b.index);
    if (list.length !== ids.length) throw new DealError(`nation ${f} has ${list.length} AI slots, the deck has ${ids.length}`);
    const d = [...ids];
    for (let i = d.length - 1; i >= 1; i--) {
      const j = Number(sha(text('wylls-ai-deal/v1'), seed, u8(f), u8(i)).readBigUInt64LE(0) % BigInt(i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    list.forEach((slot, k) => {
      const base = personaById(d[k]).temperament;
      const temperament = {};
      TRAITS.forEach((t, ti) => {
        const jitter = (sha(text('wylls-ai-jitter/v1'), seed, u32le(slot.index), u8(ti))[0] % 21) - 10;
        temperament[t] = Math.min(100, Math.max(0, base[t] + jitter));
      });
      out.push({ index: slot.index, faction: f, persona: d[k], creed_variant: sha(text('wylls-ai-creed/v1'), seed, u32le(slot.index))[0] % CREED_VARIANTS, temperament });
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The full persona of a dealt entry: the library entry with its creed variant, jittered temperament and goals. */
export function personaOf(entry) {
  const base = personaById(entry.persona);
  if (!base) throw new DealError(`unknown persona ${entry.persona}`);
  return {
    id: base.id, ambition: base.ambition, temperament: { ...entry.temperament },
    creed: base.creeds[entry.creed_variant], creed_variant: entry.creed_variant,
    goals: base.goals.map(g => ({ ...g, text: { ...g.text } })),
  };
}

/** The ai-slots.json `slots` of the run script (§2.3): n AI slots from index 1000, faction (index - 1000) mod 6, plus the seat. */
export function makeSlots(n, { seat = true } = {}) {
  const slots = Array.from({ length: n }, (_, k) => ({ index: 1000 + k, faction: k % 6, join_bell: k, kind: 'ai' }));
  if (seat) slots.push({ index: 1000 + n, faction: 0, join_bell: n, kind: 'seat' });
  return slots;
}

export function buildVectors() {
  const seeds = ['00'.repeat(32), '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', createHash('sha256').update('wylls-ai-deal-vector-3').digest('hex')];
  const cases = [];
  for (const seed of seeds) {
    for (const [deckId, n] of [['deck-1', 6], ['deck-2', 12], ['deck-3', 18]]) {
      const deck = loadDeck(deckId);
      cases.push({ seed, deck: deckId, personas: deck.personas, n, deal: deal(seed, deck, makeSlots(n)) });
    }
  }
  return { v: 1, library_sha256: libraryHash(), decks: Object.fromEntries(['deck-1', 'deck-2', 'deck-3'].map(d => [d, fileSha256(new URL(`decks/${d}.json`, HERE))])), cases };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--vectors')) {
  const body = `${JSON.stringify(buildVectors(), null, 1)}\n`;
  if (process.argv.includes('--write')) {
    const target = fileURLToPath(new URL('../../test/fixtures/ai-deal-v1.json', HERE));
    writeFileSync(target, body);
    console.log(`wrote ${target}`);
  } else process.stdout.write(body);
}
