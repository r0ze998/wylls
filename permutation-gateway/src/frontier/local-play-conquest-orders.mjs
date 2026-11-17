// Local play only, READ-ONLY: this wallet's siege reservations in the province its host stands in, for the card.
//
//   POST /f/local-play/conquest/orders   {schema, source_request}  →  {schema, context_slot, program, season, wallet,
//                                                                      standing, table_address, table, orders: [{seq, facts}], siege}
//
// `siege` (v2) is the PRESENT state of this start's city, from the same context plus the wide Holding position of the
// city's site (`cityState` below): a siege of this wallet under way with its own progress, a capture due, a slot
// owed, another player's, or a Holding this wallet's Citizen holds NOW. It is never history: "owned" is not "a
// capture took place", and nothing says a siege succeeded or a return completed.
//
// It is served only as part of the conquest routes (local-play-conquest.mjs), which cannot be built while an opening
// condition is not established: CLOSED with them. It signs nothing, sends nothing, spawns nothing; ONE read of the
// relay's own runner (getMultipleAccounts: the three accounts — four with a city — at one context slot) and nothing else.
//
// WHAT IT SAYS, AND ON WHAT EVIDENCE (docs/integration/CLAUDE-CONQUEST-RESERVATION-READ-CONTRACT-20261112.md):
//   a PENDING record                 → "ordered"
//   a NOT_APPLIED record + done bits → "not_applied", with which of resources / slot-and-rent is still owed
// and NOTHING ELSE. A record that is gone is not reported at all: it applied, or its return completed, and a table
// read cannot tell which. How a NOT_APPLIED one ended (`lapsed`), whether its source Holding is there (`source`), the
// day's count, "started", "returned" and "captured" are never produced here: all null / absent.
//
// WHAT IS CHECKED before a record is believed (conquest-table-read.mjs mirrors the ABI's own readers):
//   scope      the request is this relay's own wallet, payer, cluster, program, Season, version, ruleset; and, with a
//              world capability, the province is the capability's (as for prepare)
//   addresses  the table, the Province and the Citizen are DERIVED here from the request and the relay's wallet
//              (fconquest-identity.mjs, the same derivation the signed message uses); none is the caller's word
//   accounts   each present account is a non-executable data account owned by the program
//   Province   the WIDE family in full (`wideProvinceIdentity`): size, magic, layout 3, trailer, this Season, and the
//              world and full signed coordinate of the request's 50-byte province key
//   table      absent → no orders now (no table is observed in this context; nothing is said of the past). Present → `conquestTable`: its header names this
//              Season and THIS province; every site entry in full; the reservation region; every record's host
//              reference and actor tag; no (Citizen, slot) clash; and the Province's conquest record of every site
//              agrees with the table (entry prefix, or the idle record whose only flag is PENDING)
//   Citizen    `citizenIdentity`: size, magic, layout 2, this Season, the wallet written in it is this relay's, its
//              tag is its own address's. Only this Citizen's records are kept, and each that still holds its slot
//              must be borne out by the Citizen's own reservation mark for that slot
// Any check that fails refuses the WHOLE read (nothing partial is shown): the page then says the state is not known.
// The seq is a name inside ONE table of ONE Season: the answer carries the table address and the Season with it.
// NOT established: agreement with accounts read from a real chain (RESERVATION_LAYOUT_CHECKED.chainTable is false).
import { LocalPlayError, LOCAL_PLAY_CLUSTER, LOCAL_PLAY_SEASON_ID } from './local-play-relay.mjs';
import { ConquestPrepareError } from './conquest-prepare.mjs';
import { DEPART_PREPARE_PROGRAM_VERSION } from './expedition-depart-prepare.mjs';
import { reservationFacts } from './conquest-reservations.mjs';
import { wideProvinceIdentity, citizenIdentity, conquestTable, wideHoldingAt, citizenInventory, provinceSiteMirror,
  HOLDING_STATE_PROVISIONAL, HOLDING_STATE_FINAL, SITE_STATE_HOLDING } from './conquest-table-read.mjs';
import { canonicalDeclareSiegeRoles } from '../../../permutation-server/web/frontier/fconquest-identity.mjs';
import { canonicalExpeditionAccounts } from '../../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { decode } from '../../../permutation-server/web/sdk/base58.mjs';

export const CONQUEST_ORDERS_ROUTE = 'POST /f/local-play/conquest/orders';
export const CONQUEST_ORDERS_REQUEST_SCHEMA = 'frontier-local-play-conquest-orders-request-v1';
/** v2: the answer also carries `siege` — the present state of this start's city (null when nothing stands there, or with no city). */
export const CONQUEST_ORDERS_SCHEMA = 'frontier-local-play-conquest-orders-v2';
const slotMark = slot => (1 << (slot + 2)) | (1 << slot);   // (slot 2: bits 4 and 2; slot 3: bits 5 and 3 — conquest.rs wide_reserved_bit / wide_reservations)
/** The slot byte's low two bits: the slot a pending ticket names (frontier-abi v2/layout/player.rs `SLOTS_TICKET_MASK`). */
const TICKET_MASK = 0b11;
/**
 * Whether the Citizen (`{slots, bindings}`) bears out a slot that a record or an entry still HOLDS, as the program's
 * own invariant has it (conquest.rs validate_inventory): both reservation bits of that slot set, the slot itself
 * still empty, and no pending ticket naming it.
 */
const reserves = (me, slot) => (me.slots & slotMark(slot)) === slotMark(slot) && me.bindings[slot - 1] === 'empty' && (me.slots & TICKET_MASK) !== slot;

const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
/** A refusal of the read: what was found does not bear a reservation out. Nothing of it is shown. */
const mismatch = () => new ConquestPrepareError('ConquestPrepareScopeMismatch');
/** A program-owned, non-executable data account's bytes; null when absent; anything else is refused. */
const account = (value, program) => {
  if (value === null) return null;
  if (value === undefined || typeof value !== 'object' || value.owner !== program || value.executable !== false || !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string') throw mismatch();
  return new Uint8Array(Buffer.from(value.data[0], 'base64'));
};

/**
 * What stands at the city's site NOW, from accounts of one context. Every state is a positive, present fact; none is
 * history. In particular `owned` says "this wallet's Citizen holds a Holding there now" — NOT that a capture took
 * place (that is a past event, and needs its receipt), and nothing here says a siege "succeeded" or a return
 * "completed". No entry and no held Holding → null: nothing is said.
 *
 *   owned        a held Holding stands at the site's position (state PROVISIONAL or FINAL; a RELEASED one is not
 *                held and is not reported), it is this place's (`wideHoldingAt`), NO entry stands at the site, its
 *                owner is this wallet's Citizen, AND everything the program itself ties together agrees
 *                (wide_conquest_settle_exec.rs, the mirror SettleCapture requires): the Province's site mirror is
 *                STATE_HOLDING with the Holding's generation, its ORDER is the Holding's inventory slot, its FACTION
 *                is the Holding's and the Citizen's; the Citizen's slot of that number is bound `wide` and no longer
 *                carries the reservation mark. One of these missing for a Holding of this Citizen → refused whole
 *   siege        an entry of this Citizen at the site, kind SIEGE: its own `progress` of its own `required`, and
 *                the turn it was declared at (the entry and its pairing with the Province were verified by `conquestTable`)
 *   capture_due  the same, kind CAPTURE_DUE: the turn it is due from, and the declaration's (it has no progress)
 *   slot_owed    the same, kind NONE with the slot-owed flag: its slot
 *   other        an entry of ANOTHER Citizen (said by its kind, neutrally), or a held Holding of another Citizen
 */
function cityState({ site, entry, holding, province, key, citizenAt, mineIs }) {
  // (a Holding ACCOUNT at the position, in whatever state, and an entry at the site cannot both stand: DeclareSiege
  //  refuses a present position, and SettleCapture removes the entry in the transaction that creates the Holding)
  const present = holding === null ? null : wideHoldingAt(holding, { seasonId: LOCAL_PLAY_SEASON_ID, key, site });
  if (present !== null && entry !== null) throw mismatch();
  // (a RELEASED Holding is not held: nothing is said of it — not "owned", not "lost")
  const held = present !== null && (present.state === HOLDING_STATE_PROVISIONAL || present.state === HOLDING_STATE_FINAL) ? present : null;
  if (held !== null) {
    const mirror = provinceSiteMirror(province, site);
    if (mirror.state !== SITE_STATE_HOLDING || mirror.generation !== held.generation || mirror.order !== held.slot || mirror.faction !== held.faction) throw mismatch();
    if (held.owner !== citizenAt) return { state: 'other', site, what: 'holding' };
    const me = mineIs();
    // (the slot is the Holding's now: bound wide, with NEITHER reservation bit of that slot left — the wide mark and its
    //  base bit — and no pending ticket naming that slot. holding.rs 247–276, conquest.rs 1143–1160)
    if (me.faction !== held.faction || me.bindings[held.slot - 1] !== 'wide' || (me.slots & slotMark(held.slot)) !== 0 || (me.slots & TICKET_MASK) === held.slot) throw mismatch();
    return { state: 'owned', site, slot: held.slot, generation: held.generation };
  }
  if (entry === null) return null;
  if (entry.citizen !== citizenAt) return { state: 'other', site, what: entry.kind };
  // (the program's own invariant for a slot an entry holds — conquest.rs validate_inventory: the Citizen carries the
  //  wide reservation mark of that slot, and the slot itself is still EMPTY. An entry of this Citizen that its own
  //  account does not bear out is not shown)
  const me = mineIs();
  if (!reserves(me, entry.slot)) throw mismatch();
  if (entry.kind === 'siege') return { state: 'siege', site, progress: entry.progress, required: entry.required, declared_bell: String(entry.declarationBell) };
  if (entry.kind === 'capture_due') return { state: 'capture_due', site, due_bell: String(entry.bell), declared_bell: String(entry.declarationBell) };
  return { state: 'slot_owed', site, slot: entry.slot };
}

/**
 * The read over `cfg` (the relay's closed configuration), `city` (this start's Free City `{p, q, site, tile}`, or
 * null in a test build) and `rpc`. → `{read(body)}`.
 *
 * The table read is the current one only: 2,688 bytes, layout version 2 (`conquestTable`). `historicalTableV1: true`
 * exists for the tests that check the SAVED bytes of the earlier artefact (2,688 bytes, version 1) through this same
 * code; the relay never passes it (`conquestFromArgs` has no such argument and no command-line flag sets it), and with
 * it a version-2 table is refused. It is not a way to serve an older world.
 */
export function createConquestOrdersRead({ cfg, city = null, rpc, historicalTableV1 = false }) {
  if (historicalTableV1 !== false && historicalTableV1 !== true) throw new TypeError('bad historicalTableV1');
  return Object.freeze({
    async read(body) {
      if (!exact(body, ['schema', 'source_request']) || body.schema !== CONQUEST_ORDERS_REQUEST_SCHEMA) throw new LocalPlayError('LocalPlayInvalidRequest');
      const source = body.source_request;
      if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new LocalPlayError('LocalPlayInvalidRequest');
      // (the relay's own scope first, exactly as prepare asks it: nothing is read for another wallet, program, Season, version or ruleset)
      if (source.cluster !== LOCAL_PLAY_CLUSTER || source.program !== cfg.program || source.season !== cfg.season || source.wallet !== cfg.wallet || source.payer !== cfg.wallet
          || source.deployment?.program_version !== DEPART_PREPARE_PROGRAM_VERSION || source.deployment?.ruleset_hash !== cfg.rulesetHash) throw new LocalPlayError('LocalPlayScopeMismatch');
      if (city !== null && (source.standing?.p !== city.p || source.standing?.q !== city.q)) throw mismatch();
      // every address is derived HERE: the Citizen from the relay's wallet, the Province and the table from the province key
      let roles, key;
      try { roles = canonicalDeclareSiegeRoles(source, city?.site ?? 0); key = canonicalExpeditionAccounts(source).standing_key; } catch { throw new ConquestPrepareError('ConquestPrepareInvalidRequest'); }
      const at = name => roles.find(r => r.name === name).address;
      const citizenAt = at('citizen'), provinceAt = at('target_province'), tableAt = at('conquest');
      if (typeof key !== 'string' || !/^[0-9a-f]{100}$/.test(key)) throw new ConquestPrepareError('ConquestPrepareInvalidRequest');
      // ONE read, one context slot: the accounts are seen together, never mixed from different slots. With a city
      // (this start's capability) the fourth is the wide Holding position of the city's site, for the city's state.
      const holdingAt = city === null ? null : at('target_holding_position'), asked = holdingAt === null ? [tableAt, provinceAt, citizenAt] : [tableAt, provinceAt, citizenAt, holdingAt];
      let got; try { got = await rpc('getMultipleAccounts', [asked, { encoding: 'base64', commitment: 'confirmed' }]); } catch { throw new LocalPlayError('LocalPlayRpcUnavailable'); }
      const slot = got?.result?.context?.slot, values = got?.result?.value;
      if (got?.error !== undefined || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(values) || values.length !== asked.length) throw new LocalPlayError('LocalPlayRpcUnavailable');
      const table = account(values[0], cfg.program), province = account(values[1], cfg.program), citizen = account(values[2], cfg.program), holding = holdingAt === null ? null : account(values[3], cfg.program);
      const answer = (state, orders, siege) => ({ schema: CONQUEST_ORDERS_SCHEMA, context_slot: String(slot), program: cfg.program, season: cfg.season, wallet: cfg.wallet,
        standing: { p: source.standing.p, q: source.standing.q }, table_address: tableAt, table: state, orders, siege });
      try {
        // the wide Province of this request, by its own bytes
        if (province === null) throw mismatch();
        wideProvinceIdentity(province, { seasonId: LOCAL_PLAY_SEASON_ID, key });
        // this wallet's own Citizen, verified once when it is needed (a record or an entry or a Holding of its own)
        let me = null;
        const mineIs = () => { if (me === null) { if (citizen === null) throw mismatch();
          me = { ...citizenIdentity(citizen, { seasonId: LOCAL_PLAY_SEASON_ID, wallet: decode(cfg.wallet), address: decode(citizenAt) }), ...citizenInventory(citizen) }; } return me; };
        const read = table === null ? null : conquestTable(table, province, { seasonId: LOCAL_PLAY_SEASON_ID, key, historicalV1: historicalTableV1 });
        // ---- the reservations (records) of this wallet: only what a record says
        const mine = read === null ? [] : read.records.filter(r => r.citizen === citizenAt);
        // (a record that still holds its slot: the Citizen carries that slot's reservation mark and the slot is still empty)
        for (const r of mine) if ((r.status === 'pending' || !r.slotRentReleased) && !reserves(mineIs(), r.slot)) throw mismatch();
        const orders = [...mine].sort((a, b) => a.seq - b.seq).map(r => ({ seq: r.seq, facts: reservationFacts(r, source.standing) }));
        // ---- the CITY's present state: positive facts of this one context only (see `cityState`)
        const siege = city === null ? null : cityState({ site: city.site, entry: read === null ? null : read.entries[city.site], holding, province, key, citizenAt, mineIs });
        // (no table is observed in this context: that is "no orders now", and says nothing of what was or was not declared before)
        return answer(table === null ? 'absent' : 'present', orders, siege);
      } catch (e) {
        // (whatever failed, the whole read is refused with one code: no detail of the accounts, nothing partial)
        if (e instanceof ConquestPrepareError || e instanceof LocalPlayError) throw e;
        throw mismatch();
      }
    },
  });
}
