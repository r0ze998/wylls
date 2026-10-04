// AC6 test kit (not a test file): SYNTHETIC province files in the shape watcher/feed.mjs hands over (`shapeProvince`), a feed double with the
// methods the watcher uses, a roster double and a records helper. Everything here is labelled synthetic in the tests that use it: the
// captured herald files (ai-herald-*) hold no council situation (no three-nation neighbourhood with camps, stacks and villages), so the
// option vectors are built by hand; one test also reads the REAL captured province and clash shapes through the real feed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_ROSTER } from '../../citizens/watcher/feed.mjs';

export const MILLI = 1000;
export const GENESIS = 1_800_000_000;
export const BELL_SECS = 600;

export const tmpDir = (prefix = 'ai-watcher-') => mkdtempSync(join(tmpdir(), prefix));

/** site tiles of a synthetic province: 12 sites at tiles 2, 7, 12, ... */
export const siteTile = i => 2 + 5 * i;

let hostSeq = 1;
/** a resident host entry as feed.shapeProvince gives it (troops in milli-troops) */
export function host({ id = null, owner = null, faction, unit = 1, tile, state = STATE_ROSTER, troops }) {
  return { id: String(id ?? 1_000_000 + hostSeq++), host: null, owner, faction, unit, tile, state, troops: troops * MILLI, stamina: 120, stamina_bell: 0, ready_bell: 0, from_bell: 0 };
}

/**
 * A shaped province: `villages` = [{site, faction, garrison (whole troops), shield_until_bell}] (state HOLDING), `hosts` = host(...) entries,
 * `camp` = {tile, troops} (a live camp) or null.
 */
export function province({ p, q, bell = 0, villages = [], hosts = [], camp = null }) {
  const sites = Array.from({ length: 12 }, (_, i) => {
    const v = villages.find(x => x.site === i);
    return { site: i, tile: siteTile(i), state: v ? 1 : 0, faction: v?.faction ?? 0, order: 0, tier: 0, gen: 0, garrison: (v?.garrison ?? 0) * MILLI, walls_committed: 0, shield_until_bell: v?.shield_until_bell ?? 0, owner: v?.owner ?? null };
  });
  return { v: 1, p, q, bell, slot: 0, seq: '0', head: '', resolved_next: bell + 1, site_count: 12, sites, hosts, camp: camp ? { tile: camp.tile, state: 1, troops: camp.troops, gen: 0 } : { tile: 0, state: 0, troops: 0, gen: 0 }, summary: {}, inputs: null, slots: [] };
}

/**
 * A feed double: `files` is a Map "p,q,bell" -> shaped province; `events` a Map bell -> [normalised events]; `reveals` a Map "host/arrive" -> REVEAL event.
 * `state` is mutable: {through, head}. `calls` records every provinceAt request.
 */
export function fakeFeed({ files = new Map(), events = new Map(), reveals = new Map(), clash = new Map(), owners = null, through = 100, head = 100 } = {}) {
  const calls = [];
  const subs = new Set();
  const feed = {
    state: { through, head },
    calls, files, events, reveals, clash,
    completeThrough() { return feed.state.through; },
    headBell() { return feed.state.head; },
    cursor: () => '0',
    async provinceAt(p, q, b) { calls.push(`${p},${q},${b}`); return files.get(`${p},${q},${b}`) ?? null; },
    async provinceBefore(p, q, b, back = 4) { for (let x = b; x >= Math.max(0, b - back); x--) { const v = files.get(`${p},${q},${x}`); if (v) return v; } return null; },
    events: b => events.get(b)?.slice() ?? [],
    revealOf: (h, a) => reveals.get(`${h}/${a}`) ?? null,
    async clashAt(p, q, b) { return clash.get(`${p},${q},${b}`) ?? null; },
    async clashDetail(p, q, b) { return clash.get(`${p},${q},${b}`) ?? null; },
    batchSince: () => ({ events: [...events.values()].flat(), cursor: '0' }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(evs) { for (const fn of subs) fn({ events: evs, through_bell: feed.state.through, cursor: '0' }); },
    wakeEvents: () => [],
    kindOfTag: tag => owners?.kinds?.get(tag) ?? null,
    owners,
    addEvent(ev) { const l = events.get(ev.bell) ?? []; l.push(ev); events.set(ev.bell, l); },
  };
  return feed;
}

/** an owners double: holdings per tag, faction per tag, wallet per tag, host owners */
export function fakeOwners({ citizens = [], hostOwner = {} } = {}) {
  const byTag = new Map(citizens.map(c => [c.tag, c]));
  return {
    kinds: new Map(citizens.filter(c => c.kind).map(c => [c.tag, c.kind])),
    factionOfTag: t => byTag.get(t)?.faction ?? null,
    holdingsOf: t => byTag.get(t)?.holdings ?? [],
    homeOf: t => byTag.get(t)?.holdings?.[0] ?? null,
    walletOf: t => byTag.get(t)?.wallet ?? null,
    citizenOfHost: id => hostOwner[String(id)] ?? null,
    factionOfHost: id => byTag.get(hostOwner[String(id)])?.faction ?? null,
  };
}

/** a roster double in the shape server.mjs hands the watcher */
export function fakeRoster({ ai = [], seat = null, script = [] } = {}) {
  const byTag = new Map(ai.map(a => [a.tag, a]));
  const byWallet = new Map(ai.map(a => [a.wallet, a]));
  return {
    ai, seat,
    byTag: t => byTag.get(t) ?? null,
    byWallet: w => byWallet.get(w) ?? null,
    isAi: t => byTag.has(t),
    isScript: w => script.includes(w),
  };
}

export const nameOfDouble = tag => ({ en: `Name${String(tag).slice(0, 4)}`, ja: `名${String(tag).slice(0, 4)}` });
export const nationNameDouble = f => ({ en: `Nation${f}`, ja: `国${f}` });
