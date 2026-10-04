// AC6a: who owns what, from public records only (AI-CITIZENS-CONTRACT §0.2, §1.3 C5, §3.2, §11.6).
//
//   const owners = createOwners({ seasonAddress, programId });
//   owners.ingest(event)                 // a normalised feed event: JOIN, SETTLE, RELEASE, HOLDING_FINAL
//   owners.citizenOfHost(hostId)         // → tag (16 hex digits) | null   (host-id layout + SETTLE history)
//   owners.factionOfTag(tag) / factionOfHost(hostId)
//   owners.holdingsOf(tag)               // → [{p, q, site, gen, founded_bell, final, tier}]
//   owners.homeOf(tag)                   // → the first held site, or null
//   owners.useRoster(decoded)            // fill sites the history lacks from /h/roster/<ring>/latest.bin
//
// Everything comes from the herald's public event log, so a replay can redo it:
//  - the host id carries (province, site, gen, seq) (M1-CONTRACT §4.1, `faddr.mjs hostParts`);
//  - SETTLE (outcome fresh/displace) names the holder `citizen_tag` of (p, q, site) and its `gen`;
//    RELEASE and a later displacing SETTLE end it; so a host id (site, gen) names exactly one
//    holder at a time, which is what the roster file (latest only) cannot give;
//  - JOIN gives (citizen_tag15, wallet, faction); the Citizen address is
//    sha256(season_address ‖ "ct" ‖ hex(tag15) ‖ program_id) (create_with_seed, `faddr.mjs`), and
//    the citizen tag is its first 8 bytes, little-endian. Checked against every SETTLE of the
//    paused m1-exit capture (1000 of 1000 holders resolve to a JOIN).
// `/h/roster` is only a fallback and a cross-check (the paused herald does not serve it).
import crypto from 'node:crypto';
import * as b58 from '../../../permutation-server/web/sdk/base58.mjs';
import { provinceFromIndex, SITES_PER_PROVINCE } from '../../../permutation-server/web/frontier/fgeo.mjs';

export const SETTLE_FRESH = 0;
export const SETTLE_DISPLACE = 1;
export const SETTLE_TAKEN = 2;
export const SETTLE_EXPIRED = 3;

/** A u64 (BigInt or integer number) as the 16-digit lowercase hex tag the AI files use. Strings are refused: a 16-digit decimal and a 16-digit hex tag look alike, so a decimal string goes through `tagFromDecimal`. */
export function tagHex(x) {
  if (typeof x !== 'bigint' && !Number.isInteger(x)) throw new TypeError('tagHex: a BigInt or an integer (use tagFromDecimal for a decimal string)');
  return BigInt.asUintN(64, BigInt(x)).toString(16).padStart(16, '0');
}
/** A tag as the herald's decoded rows write it (a decimal string of a u64) → tag hex. */
export const tagFromDecimal = s => tagHex(BigInt(String(s)));
export const isTagHex = s => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);

/** The parts of a host id (§4.1: index(P,Q) << 44 | site << 40 | gen << 32 | seq), or null for an id no holding can issue. */
export function parseHostId(id) {
  let x;
  try { x = BigInt(id); } catch { return null; }
  if (x < 0n || x >= 0xffffffffffffffffn) return null;
  const idx = Number(x >> 44n);
  const site = Number((x >> 40n) & 0xfn);
  if (site >= SITES_PER_PROVINCE) return null;
  const c = provinceFromIndex(idx);
  if (!c) return null;
  return { p: c.p, q: c.q, site, gen: Number((x >> 32n) & 0xffn), seq: Number(x & 0xffffffffn) };
}

/** The citizen tag (16 hex) of a JOIN's `citizen_tag15` (30 hex digits) in this season. */
export function citizenTagOfTag15(tag15Hex, { seasonAddress, programId }) {
  const base = Buffer.from(b58.decode(seasonAddress));
  const prog = Buffer.from(b58.decode(programId));
  const d = crypto.createHash('sha256').update(Buffer.concat([base, Buffer.from(`ct${String(tag15Hex).toLowerCase()}`), prog])).digest();
  return tagHex(d.readBigUInt64LE(0));
}

const siteKey = (p, q, site) => `${p},${q},${site}`;

export function createOwners({ seasonAddress, programId } = {}) {
  if (!seasonAddress || !programId) throw new Error('owners: seasonAddress and programId are needed (GET /h/season)');
  /** tag → {faction, wallet_hex, tag15, join_bell} */
  const citizens = new Map();
  /** "p,q,site" → [{gen, tag, bell, final, tier, open}] oldest first; `open` false once released or displaced */
  const sites = new Map();
  /** tag → Set of site keys currently held */
  const held = new Map();
  const stats = { joins: 0, settles: 0, releases: 0, finals: 0, unknown_holder: 0, roster_filled: 0 };

  function hold(tag, key, on) {
    let s = held.get(tag);
    if (!s) held.set(tag, (s = new Set()));
    if (on) s.add(key); else s.delete(key);
  }

  function ingest(ev) {
    if (!ev || typeof ev.kind !== 'string') return;
    switch (ev.kind) {
      case 'JOIN': {
        const tag = citizenTagOfTag15(ev.citizen15, { seasonAddress, programId });
        if (!citizens.has(tag)) {
          citizens.set(tag, { tag, faction: ev.faction, wallet_hex: ev.wallet, tag15: ev.citizen15, join_bell: ev.bell });
          stats.joins++;
        }
        break;
      }
      case 'SETTLE': {
        stats.settles++;
        if (ev.outcome !== SETTLE_FRESH && ev.outcome !== SETTLE_DISPLACE) break; // taken / expired: no holding changes
        const key = siteKey(ev.p, ev.q, ev.site);
        const list = sites.get(key) ?? [];
        for (const h of list) if (h.open) { h.open = false; hold(h.tag, key, false); }
        list.push({ gen: ev.gen, tag: ev.citizen, bell: ev.bell, final: false, tier: null, open: true });
        sites.set(key, list);
        hold(ev.citizen, key, true);
        break;
      }
      case 'RELEASE': {
        stats.releases++;
        const key = siteKey(ev.p, ev.q, ev.site);
        const cur = (sites.get(key) ?? []).findLast(h => h.open);
        if (cur) { cur.open = false; hold(cur.tag, key, false); }
        break;
      }
      case 'HOLDING_FINAL': {
        stats.finals++;
        const cur = (sites.get(siteKey(ev.p, ev.q, ev.site)) ?? []).findLast(h => h.open);
        if (cur) cur.final = true;
        break;
      }
      default:
    }
  }

  /** The holder entry of a site generation, or the current one when `gen` is omitted. */
  function entryOf(p, q, site, gen) {
    const list = sites.get(siteKey(p, q, site)) ?? [];
    if (gen === undefined || gen === null) return list.findLast(h => h.open) ?? null;
    return list.findLast(h => h.gen === gen) ?? null;
  }

  const api = {
    ingest,
    stats,
    /** Replace nothing the history knows; fill holders it lacks from a decoded roster file (`decodeRoster`). Returns sites added. */
    useRoster(decoded) {
      let n = 0;
      for (const [k, list] of decoded.provinces) {
        const [p, q] = k.split(',').map(Number);
        list.forEach((o, site) => {
          if (!o || entryOf(p, q, site)) return;
          const key = siteKey(p, q, site);
          const tag = tagHex(o.tag);
          // the roster does not carry gen: -1 means "any generation" (never matches a host id of a known gen)
          const arr = sites.get(key) ?? [];
          arr.push({ gen: null, tag, bell: o.bell, final: false, tier: o.tier ?? null, open: true, from_roster: true });
          sites.set(key, arr);
          hold(tag, key, true);
          n++;
        });
      }
      stats.roster_filled += n;
      return n;
    },
    /** The holder (tag, 16 hex) of the village that issued a host id, by generation; null if unknown. */
    citizenOfHost(hostId) {
      const h = parseHostId(hostId);
      if (!h) return null;
      const list = sites.get(siteKey(h.p, h.q, h.site)) ?? [];
      const e = list.findLast(x => x.gen === h.gen) ?? list.findLast(x => x.gen === null && x.open);
      if (!e) { stats.unknown_holder++; return null; }
      return e.tag;
    },
    /** The holder of a site now (or of a generation), as {tag, gen, bell, final, tier} | null. */
    holderOfSite(p, q, site, gen) {
      const e = entryOf(p, q, site, gen);
      return e ? { tag: e.tag, gen: e.gen, bell: e.bell, final: e.final, tier: e.tier } : null;
    },
    /** The nation of a citizen tag from its JOIN, or null (not joined, or the JOIN is not in the log yet). */
    factionOfTag(tag) { return citizens.get(tag)?.faction ?? null; },
    factionOfHost(hostId) { const t = api.citizenOfHost(hostId); return t === null ? null : api.factionOfTag(t); },
    /** The wallet (base58) of a citizen from its JOIN row, or null. */
    walletOf(tag) {
      const c = citizens.get(tag);
      return c ? b58.encode(Uint8Array.from(Buffer.from(c.wallet_hex, 'hex'))) : null;
    },
    /** The villages a citizen holds now: [{p, q, site, gen, founded_bell, final, tier}] in the order they were won. */
    holdingsOf(tag) {
      const out = [];
      for (const key of held.get(tag) ?? []) {
        const [p, q, site] = key.split(',').map(Number);
        const e = entryOf(p, q, site);
        if (e && e.tag === tag) out.push({ p, q, site, gen: e.gen, founded_bell: e.bell, final: e.final, tier: e.tier });
      }
      return out.sort((a, b) => a.founded_bell - b.founded_bell || a.p - b.p || a.q - b.q || a.site - b.site);
    },
    /** The citizen's first village (the AI's home), or null. */
    homeOf(tag) {
      const h = api.holdingsOf(tag)[0];
      return h ? { p: h.p, q: h.q, site: h.site } : null;
    },
    /** Citizens with a village in province (p, q): [{tag, site, gen}]. */
    holdersIn(p, q) {
      const out = [];
      for (let site = 0; site < SITES_PER_PROVINCE; site++) {
        const e = entryOf(p, q, site);
        if (e) out.push({ tag: e.tag, site, gen: e.gen });
      }
      return out;
    },
    knownCitizens: () => citizens.size,
  };
  return api;
}
