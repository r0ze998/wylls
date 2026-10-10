// Achievements of a season, recomputed from the chain (permutation-prize's
// contribution ledger; PROVISIONAL weights live in prize-params.json, the
// records here do not depend on them):
//
//   capture        the owner of the donor host that became a keep's garrison at its LAST capture, for
//                  every keep whose holder at the end is the capturing nation. Source: the CONQUEST log
//                  record of the capture's transaction (event KEEP_TAKEN, `donor_host_id`).
//   reinforcement  troops of a member's hosts standing on the keep tile of a keep its nation holds at the
//                  end. Source: the final Province account (its entries), and the host's last
//                  TRANSIT_SETTLED "Stays" transaction.
//   defence        NOT DERIVABLE today (see KINDS.defence).
//
// Every line names the player (wallet and Citizen), the target province,
// a quantity, the bell and the transaction signature(s) it rests on, and
// `verifyLine` re-derives it from those transactions and accounts alone.
// Anti-inflation: only end-state quantities are counted (the last capture
// of a keep still held; each host once, with the troops it has at the end).
import { encode as base58 } from '../../client/src/base58.mjs';
import { fromBase64 } from '../../client/src/bytes.mjs';
import { hostParts } from '../../client/src/frontier/addresses.mjs';
import { decodeAccount } from '../../client/src/frontier/codec.mjs';
import { decodeRecord } from '../../../permutation-server/web/frontier/flog.mjs';

/** CONQUEST event code of a keep changing holder; the keep's pseudo-site. */
export const KEEP_TAKEN = 9;
export const KEEP_SITE = 0xfe;
/** Province entry state of a host standing in the roster. */
export const ENTRY_ROSTER = 1;
/** A Province entry's troops are thousandths of a troop. */
export const MILLI = 1000;
/** The occupied entries of a decoded Province (its 56 slots are not packed). */
export const entriesOf = province => province.ENTRIES.filter(e => BigInt(e.ID) !== 0n);
/** TRANSIT_SETTLED outcome "Stays" (frontier-abi log.rs `transit_outcome::STAYS`). */
export const OUTCOME_STAYS = 1;

/** What each kind rests on, and what is missing where a kind cannot be derived. */
export const KINDS = Object.freeze({
  capture: { derivable: true, unit: 'province',
    rule: 'the owner of the donor host that became the garrison at the keep\'s last capture, when the capturing nation still holds the keep at the end',
    antiInflation: 'end state: one line per province (the last capture); earlier captures of the same keep earn nothing',
    source: 'CONQUEST log record (kind 82) of the capture transaction: event KEEP_TAKEN and donor_host_id; Holding.owner_citizen; Citizen.wallet',
    partial: 'other hosts that stood on the keep through the contest are not derivable: the CONQUEST record names the donor host only (missing record: the host ids on the keep tile at the capture bell)' },
  reinforcement: { derivable: true, unit: 'troops',
    rule: 'troops of a member\'s hosts standing on the keep tile of a keep its nation holds when the season has ended; the supplier (the host\'s owner) gets the credit',
    antiInflation: 'net end state: each host is read once from the final Province account; splitting a host or moving troops in and out cannot raise the total; a keep\'s own garrison (keep.troops) is not counted, it is the capture\'s',
    source: 'the Province account after the last bell (entries on the keep tile); the host\'s last TRANSIT_SETTLED "Stays" transaction; Holding.owner_citizen; Citizen.wallet' },
  defence: { derivable: false,
    reason: 'the chain\'s record of a repelled contest (CONQUEST event KEEP_BROKEN) names the contending nation and its progress only; which hosts stood on the keep at that bell is in no log record',
    missingRecord: 'the defending host ids (or holdings) in the CONQUEST record of the bell a contest breaks' },
  resourceSupply: { derivable: false, reason: 'no resource transfer instruction exists in the game', missingRecord: 'a transfer instruction and its log record' },
});

/** The PS2 records in a transaction's log messages (`Program data: UFMy <body>`), decoded; unknown kinds dropped. */
export function recordsOf(logs = []) {
  const out = [];
  for (const l of logs) {
    const m = /^Program data: UFMy (\S+)$/.exec(l);
    if (!m) continue;
    try { const r = decodeRecord(fromBase64(m[1])); if (r) out.push(r); } catch { /* not a record this code reads */ }
  }
  return out;
}

/** A CONQUEST record's events: `[{site, code, faction, progress}]`. */
export const conquestEvents = r => Array.from({ length: Math.min(r.n, 14) }, (_, i) => ({ site: r.events[4 * i], code: r.events[4 * i + 1], faction: r.events[4 * i + 2], progress: r.events[4 * i + 3] }));

/**
 * The reader the derivation uses: `io.account(address) → bytes|null`,
 * `io.transaction(signature) → {err, slot, logs}|null`,
 * `io.signatures(address, limit) → [signature…]` (newest first),
 * `io.keep(p, q) → the herald's keep file` (an index of capture
 * transactions; every fact taken from it is re-read from the chain).
 */
export class Deriver {
  constructor({ io, addresses, profile = 2 }) {
    Object.assign(this, { io, addresses, profile, owners: new Map(), txs: new Map() });
  }

  async transaction(sig) {
    if (!this.txs.has(sig)) this.txs.set(sig, await this.io.transaction(sig));
    return this.txs.get(sig);
  }

  /** The owner of a host: `{wallet, citizen, nation, holding}` from the Holding and Citizen accounts, or null (released, re-settled or unreadable). */
  async ownerOfHost(hostId) {
    const id = BigInt(hostId);
    if (this.owners.has(id)) return this.owners.get(id);
    let out = null;
    const h = hostParts(id);
    if (h) {
      const holding = this.addresses.holding(h.p, h.q, h.site);
      const hd = await this.io.account(holding);
      try {
        const H = decodeAccount('Holding', hd, { seasonId: this.addresses.seasonId, profile: this.profile });
        if (Number(H.GEN) === h.gen) {
          const citizen = base58(H.OWNER_CITIZEN);
          const C = decodeAccount('Citizen', await this.io.account(citizen), { seasonId: this.addresses.seasonId, profile: this.profile });
          const wallet = base58(C.WALLET);
          if (this.addresses.citizen(wallet) === citizen) out = { wallet, citizen, nation: Number(C.FACTION), holding };
        }
      } catch { out = null; }
    }
    this.owners.set(id, out);
    return out;
  }

  /** The capture of `(p, q)` by `nation` in transaction `sig`: `{bell, to, from, donor, troops}` read from its CONQUEST record, or null. */
  async captureIn(sig, p, q) {
    const tx = await this.transaction(sig);
    if (!tx || tx.err) return null;
    for (const r of recordsOf(tx.logs)) {
      if (r.name !== 'CONQUEST' || r.p !== p || r.q !== q) continue;
      const ev = conquestEvents(r).find(e => e.site === KEEP_SITE && e.code === KEEP_TAKEN);
      if (ev) return { bell: r.bell, to: ev.faction, from: ev.progress, donor: BigInt(r.donor_host_id), troops: r.keep_troops, holderAfter: r.keep_holder };
    }
    return null;
  }

  /** The transaction that left `hostId` standing at its destination: its last TRANSIT_SETTLED "Stays" (searched in its Holding's history), or null. */
  async arrivalOf(hostId, limit = 200) {
    const h = hostParts(BigInt(hostId));
    if (!h) return null;
    for (const sig of await this.io.signatures(this.addresses.holding(h.p, h.q, h.site), limit)) {
      const tx = await this.transaction(sig);
      if (!tx || tx.err) continue;
      const r = recordsOf(tx.logs).find(x => x.name === 'TRANSIT_SETTLED' && BigInt(x.host_id) === BigInt(hostId));
      if (r) return r.outcome === OUTCOME_STAYS ? { signature: sig, bell: r.bell, troops: r.troops } : null;
    }
    return null;
  }

  /** Capture lines of one keep province (`province`: the decoded final Province account). */
  async captureLines(province) {
    const [p, q] = [Number(province.P), Number(province.Q)];
    const keep = province.KEEP[0];
    const file = await this.io.keep(p, q);
    const last = (file?.captures ?? []).at(-1);
    if (!last) return [];
    const c = await this.captureIn(last.sig, p, q);
    // Only a capture the chain's own record confirms, by the nation that still holds the keep.
    if (!c || c.to !== Number(keep.HOLDER) || c.donor === 0n) return [];
    const owner = await this.ownerOfHost(c.donor);
    return [{ kind: 'capture', wallet: owner?.wallet ?? null, citizen: owner?.citizen ?? null, nation: c.to, province: { p, q }, quantity: 1, unit: 'province', bell: c.bell,
      host: String(c.donor), detail: { takenFrom: c.from, garrison: c.troops, ownerNation: owner?.nation ?? null }, signatures: [last.sig] }];
  }

  /** Reinforcement lines of one keep province: hosts of the holder nation standing on the keep tile at the end. */
  async reinforcementLines(province, provinceAddress) {
    const [p, q] = [Number(province.P), Number(province.Q)];
    const keep = province.KEEP[0];
    const out = [];
    for (const e of entriesOf(province)) {
      const troops = Math.floor(Number(e.TROOPS) / MILLI);
      if (Number(e.STATE) !== ENTRY_ROSTER || Number(e.TILE) !== Number(keep.TILE) || Number(e.FACTION) !== Number(keep.HOLDER) || troops === 0 || Number(e.PEND_OP) !== 0) continue;
      const owner = await this.ownerOfHost(e.ID);
      if (!owner) continue; // not a member's host (the nation's own guard)
      const arrival = await this.arrivalOf(e.ID);
      out.push({ kind: 'reinforcement', wallet: owner.wallet, citizen: owner.citizen, nation: Number(keep.HOLDER), province: { p, q }, quantity: troops, unit: 'troops',
        bell: arrival?.bell ?? Number(e.FROM_BELL), host: String(e.ID), detail: { keepHolder: Number(keep.HOLDER), supplierNation: owner.nation, milliTroops: Number(e.TROOPS), account: provinceAddress },
        signatures: arrival ? [arrival.signature] : [] });
    }
    return out;
  }

  /** Every line of the season: `provinces` = `[{address, province (decoded)}]` of the keeps, read after the end. */
  async lines(provinces) {
    const out = [];
    for (const { address, province } of provinces) {
      out.push(...await this.captureLines(province), ...await this.reinforcementLines(province, address));
    }
    return out;
  }

  /**
   * Re-derive one ledger line from the transactions and accounts it cites:
   * `{ok, problems: [...]}`. A capture: its transaction carries the
   * CONQUEST record with KEEP_TAKEN for that province and nation and the
   * donor host, the keep is still that nation's, and the host's owner is
   * the wallet. A reinforcement: the host stands on the keep tile in the
   * Province account with that many troops, the keep is its nation's, the
   * owner is the wallet, and the cited transaction settled it there.
   */
  async verifyLine(line) {
    const problems = [];
    const { p, q } = line.province;
    let province;
    try { province = decodeAccount('Province', await this.io.account(this.addresses.province(p, q)), { seasonId: this.addresses.seasonId, profile: this.profile }); } catch { return { ok: false, problems: ['the Province account is not readable'] }; }
    const keep = province.KEEP[0];
    if (Number(keep.HOLDER) !== line.nation) problems.push(`the keep is held by nation ${keep.HOLDER}, not ${line.nation}`);
    const owner = await this.ownerOfHost(line.host);
    if ((owner?.wallet ?? null) !== line.wallet || (owner?.citizen ?? null) !== line.citizen) problems.push('the host\'s owner (Holding.owner_citizen → Citizen.wallet) is not the line\'s player');
    if (line.kind === 'capture') {
      const c = line.signatures[0] ? await this.captureIn(line.signatures[0], p, q) : null;
      if (!c) problems.push('the cited transaction has no CONQUEST record with KEEP_TAKEN for this province');
      else {
        if (c.to !== line.nation) problems.push(`the record's capturing nation is ${c.to}`);
        if (String(c.donor) !== line.host) problems.push(`the record's donor host is ${c.donor}`);
        if (c.bell !== line.bell) problems.push(`the record's bell is ${c.bell}`);
        if (Number(keep.SINCE_BELL) > c.bell + 1) problems.push('the keep changed holder after the cited capture');
      }
    } else if (line.kind === 'reinforcement') {
      const e = entriesOf(province).find(x => String(x.ID) === line.host);
      if (!e || Number(e.STATE) !== ENTRY_ROSTER || Number(e.TILE) !== Number(keep.TILE)) problems.push('the host does not stand on the keep tile in the Province account');
      else if (Math.floor(Number(e.TROOPS) / MILLI) !== line.quantity) problems.push(`the host has ${Math.floor(Number(e.TROOPS) / MILLI)} troops, not ${line.quantity}`);
      if (owner && Number(keep.HOLDER) !== line.nation) problems.push('the keep is not the nation\'s');
      for (const sig of line.signatures) {
        const tx = await this.transaction(sig);
        const r = tx && !tx.err ? recordsOf(tx.logs).find(x => x.name === 'TRANSIT_SETTLED' && String(x.host_id) === line.host) : null;
        if (!r || r.outcome !== OUTCOME_STAYS) problems.push(`transaction ${sig} did not settle the host at its destination`);
      }
    } else problems.push(`unknown kind ${line.kind}`);
    return { ok: problems.length === 0, problems };
  }
}

/**
 * PROVISIONAL scoring of `lines` under `params` (prize-params.json) for the
 * `winners` (nations): points per eligible wallet (`paid`: wallets with an
 * Entry), per line, with the fallbacks. Returns `{points: Map(wallet →
 * {nation, points}), lines (each with `points`, `eligible`), mode: 'shares'
 * | 'equal' | 'refund'}`.
 */
export function scoreLines(lines, { params, winners, paid, members }) {
  const c = params.contribution;
  const scored = lines.map(l => {
    const eligible = !!l.wallet && paid.has(l.wallet) && winners.includes(l.nation) && (l.kind !== 'reinforcement' || l.detail.supplierNation === l.nation);
    let points = 0;
    if (l.kind === 'capture' && c.capture.enabled) points = c.capture.points;
    if (l.kind === 'reinforcement' && c.reinforcement.enabled) points = Math.floor(l.quantity * c.reinforcement.pointsPer100Troops / 100);
    return { ...l, eligible, points: eligible ? points : 0, pointsIfEligible: points };
  });
  // The per-province cap of reinforcement, per wallet.
  const used = new Map();
  for (const l of scored) {
    if (l.kind !== 'reinforcement' || !l.points) continue;
    const k = `${l.wallet}:${l.province.p},${l.province.q}`;
    const left = Math.max(0, c.reinforcement.maxPerProvince - (used.get(k) ?? 0));
    l.points = Math.min(l.points, left);
    used.set(k, (used.get(k) ?? 0) + l.points);
  }
  const points = new Map();
  for (const l of scored) if (l.points) points.set(l.wallet, { nation: l.nation, points: (points.get(l.wallet)?.points ?? 0) + l.points });
  let mode = 'shares';
  if (points.size === 0) {
    // PROVISIONAL fallbacks: equal split among the winners' paid members, else a refund.
    const eligible = members.filter(m => winners.includes(m.nation) && paid.has(m.wallet));
    for (const m of eligible) points.set(m.wallet, { nation: m.nation, points: 1 });
    mode = eligible.length ? 'equal' : 'refund';
  }
  return { points, lines: scored, mode };
}
